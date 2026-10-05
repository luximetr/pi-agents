import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import test, { after } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-extension-home-")));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(testAgentDir, { recursive: true, force: true });
});
import * as ts from "typescript";
import extension from "../index.ts";
import { startAuthenticatedMcp } from "./http-mcp-fixture.ts";
import { mcpToolName } from "../mcp.ts";
import { STUDIO_LABELS, StudioAction } from "../studio-menu.ts";
import { showAgentSelector } from "../ui.ts";
import { editSubagents } from "../studio-subagents.ts";
import { editModelAliases } from "../studio-models.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { discoverAgents, loadConfig, saveAgentOverride, saveAgentSource, saveDeclarativeAgent, saveModelAliases } from "../agents.ts";

// Fake RPC children must save the same settled messages they emit.
const persistedMessages = `
import { appendFileSync as appendSession, readFileSync as readSession } from 'node:fs';
import { randomUUID as sessionEntryId } from 'node:crypto';
const sessionFile = process.argv[process.argv.indexOf('--session') + 1];
const saveMessage = message => {
 const entries = readSession(sessionFile, 'utf8').trim().split('\\n').map(JSON.parse);
 appendSession(sessionFile, JSON.stringify({type:'message', id:sessionEntryId(), parentId:entries.length > 1 ? entries.at(-1).id : null, timestamp:new Date().toISOString(), message:{role:'assistant', stopReason:'stop', ...message, timestamp:Date.now()}})+'\\n');
};
let sessionInput = '';
process.stdin.on('data', chunk => {
 sessionInput += chunk;
 let newline;
 while ((newline = sessionInput.indexOf('\\n')) >= 0) {
  const command = JSON.parse(sessionInput.slice(0, newline)); sessionInput = sessionInput.slice(newline + 1);
  if (command.type === 'prompt') saveMessage({role:'user', content:command.message});
 }
});
`;

async function makeAgent(root: string, name: string, extra = "") {
	await mkdir(path.join(root, ".pi-agents", name), { recursive: true });
	await writeFile(
		path.join(root, ".pi-agents", name, "agent.ts"),
		`export default { name: ${JSON.stringify(name)}, description: ${JSON.stringify(name)}, tools: ["read"], ${extra} };\n`,
	);
}

function boot(root: string, options?: {
	flag?: string;
	sessionFile?: string;
	sessionId?: string;
	trusted?: boolean;
	mode?: string;
	branchEntries?: any[];
	selectAnswers?: Array<string | undefined>;
	editorAnswers?: Array<string | undefined>;
	inputAnswers?: Array<string | undefined>;
	customActions?: Array<(component: any, done: (value: any) => void) => void>;
}) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	const activeToolsets: string[][] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses: string[] = [];
	const lifecycleEvents: Array<{ channel: string; data: any }> = [];
	let customComponent: any;
	const tools = new Map<string, any>([
		["read", { name: "read", description: "Read file contents from disk." }],
		["bash", { name: "bash", description: "Execute a shell command." }],
		["powershell", { name: "powershell", description: "Execute PowerShell commands." }],
		["delegate", { name: "delegate", description: "Delegate work to a child agent." }],
	]);
	const pi: any = {
		events: { emit: (channel: string, data: any) => lifecycleEvents.push({ channel, data }) },
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerEntryRenderer: () => {},
		registerMessageRenderer: (type: string, renderer: any) => messageRenderers.set(type, renderer),
		registerFlag: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getFlag: () => options?.flag,
		getThinkingLevel: () => "high",
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...(activeToolsets.at(-1) ?? ["read", "bash"])],
		setActiveTools: (names: string[]) => activeToolsets.push([...names]),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	extension(pi);
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text, getColorMode: () => "truecolor" };
	const ctx: any = {
		cwd: root,
		mode: options?.mode,
		isProjectTrusted: () => options?.trusted ?? true,
		sessionManager: {
			getSessionFile: () => options?.sessionFile,
			getSessionId: () => options && Object.hasOwn(options, "sessionId") ? options.sessionId : `test-session:${root}`,
			getBranch: () => options?.branchEntries ?? [],
			getEntries: () => options?.branchEntries ?? [],
		},
		ui: {
			theme,
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: (message: string, level: string) => notifications.push({ message, level }),
			select: async () => options?.selectAnswers?.shift(),
			confirm: async () => true,
			editor: async () => options?.editorAnswers?.shift(),
			input: async () => options?.inputAnswers?.shift(),
			custom: async (factory: any) => {
				let finish!: (value: any) => void;
				const completion = new Promise<any>((resolve) => { finish = resolve; });
				customComponent = factory({ requestRender: () => {}, terminal: { rows: 40, columns: 120 } }, theme, {}, finish);
				if (customComponent.signal) {
					const loader = customComponent;
					return completion.finally(() => loader.dispose());
				}
				const action = options?.customActions?.shift();
				if (!action) return null;
				action(customComponent, finish);
				return completion;
			},
		},
	};
	return { pi, handlers, commands, messageRenderers, activeToolsets, notifications, entries, tools, statuses, lifecycleEvents, getCustomComponent: () => customComponent, ctx };
}

test("default-on task history is wired through delegation, shutdown, reload, explicit user/agent recovery and deletion", async () => {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-history-extension-")));
	const root = path.join(base, "project");
	const executable = path.join(base, "fake-pi.mjs");
	const log = path.join(base, "launches.jsonl");
	const environment = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_BIN", "PI_AGENTS_ROOT_SESSION_ID"];
	const previous = Object.fromEntries(environment.map(key => [key, process.env[key]]));
	let runtime: ReturnType<typeof boot> | undefined;
	const start = async (sessionId?: string) => {
		const value = boot(root, { sessionId });
		value.pi.sendMessage = () => {};
		value.ctx.isIdle = () => true;
		value.ctx.hasPendingMessages = () => false;
		await value.handlers.get("session_start")?.({ reason: "startup" }, value.ctx);
		return value;
	};
	const control = (action: string, runId?: string, message?: string) => runtime!.tools.get("subagent_control").execute("control", { action, runId, message }, undefined, undefined, runtime!.ctx);
	const list = async () => JSON.parse((await control("list")).content[0].text);
	const waitFor = async (predicate: () => Promise<boolean>) => {
		const end = Date.now() + 10000;
		while (!await predicate()) { assert.ok(Date.now() < end, "history integration timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
	};
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(base, "pi-home");
		process.env.PI_CODING_AGENT_BIN = executable;
		delete process.env.PI_AGENTS_ROOT_SESSION_ID;
		await makeAgent(root, "lead", 'default: true, subagents: ["worker"]');
		await makeAgent(root, "other", 'subagents: ["worker"]');
		await makeAgent(root, "worker");
		execFileSync("git", ["-C", root, "init"], { stdio: "pipe" });
		execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { stdio: "pipe" });
		await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const file = process.argv[process.argv.indexOf('--session')+1];
const prior = readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse);
let parentId = prior.length > 1 ? prior.at(-1).id : null;
let timer, buffer='';
const emit = event => console.log(JSON.stringify(event));
process.stdin.on('data',chunk=>{
 buffer+=chunk; let n;
 while((n=buffer.indexOf('\\n'))>=0){
  const command=JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1);
  if(command.type==='abort'){clearInterval(timer); emit({type:'agent_settled'}); continue;}
  if(command.type!=='prompt')continue;
  appendFileSync(${JSON.stringify(log)},JSON.stringify({task:command.message,file,cwd:process.cwd(),prior})+'\\n');
  for(const message of [{role:'user',content:command.message},{role:'assistant',content:[{type:'text',text:'saved result'}],stopReason:'stop'}]){
   const id=randomUUID(); appendFileSync(file,JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message:{...message,timestamp:Date.now()}})+'\\n'); parentId=id;
  }
  writeFileSync('retained-work','keep');
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'saved result'}],stopReason:'stop'}});
  if(command.message==='HOLD')timer=setInterval(()=>{},1000);else emit({type:'agent_settled'});
 }
});
process.stdin.on('end',()=>process.exit(0));
`);
		await chmod(executable, 0o755);
		runtime = await start("stable-session");
		const first = await runtime.tools.get("delegate").execute("delegate", { agent: "worker", task: "original", workspace: "worktree" }, undefined, undefined, runtime.ctx);
		assert.equal(first.details.status, "completed");
		const worktree = first.details.workspaceCwd;
		const held = await runtime.tools.get("delegate").execute("hold", { agent: "worker", task: "HOLD", background: true }, undefined, undefined, runtime.ctx);
		await waitFor(async () => (await list()).some((row: any) => row.runId === held.details.runId && row.savedAt));
		await runtime.handlers.get("session_shutdown")?.({ reason: "reload" }, runtime.ctx);
		runtime = await start("stable-session");
		let rows = await list();
		assert.equal(rows.find((row: any) => row.runId === first.details.runId).status, "completed");
		assert.equal(rows.find((row: any) => row.runId === held.details.runId).status, "interrupted");
		assert.equal(rows.find((row: any) => row.runId === held.details.runId).recoverable, true);
		const restoredCard = runtime.tools.get("delegate").renderResult(held, { expanded: false }, runtime.ctx.ui.theme).render(100).join("\n");
		assert.match(restoredCard, /worker interrupted/);
		assert.match(restoredCard, /Result preview was not retained/);
		assert.doesNotMatch(restoredCard, /worker running|Started background subagent/);
		const completedCard = runtime.tools.get("delegate").renderResult({ ...first, details: { ...first.details, status: "running" } }, { expanded: false }, runtime.ctx.ui.theme).render(100).join("\n");
		assert.match(completedCard, /worker completed/);
		assert.match(completedCard, /Result preview was not retained/);
		const unknownCard = runtime.tools.get("delegate").renderResult({ ...held, details: { ...held.details, runId: "not-retained" } }, { expanded: false }, runtime.ctx.ui.theme).render(100).join("\n");
		assert.match(unknownCard, /worker unavailable/);
		assert.doesNotMatch(unknownCard, /worker running/);
		assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, "startup never re-executes tasks");
		await assert.rejects(control("recover", held.details.runId, " "), /fresh/);
		await runtime.commands.get("agent").handler("other", runtime.ctx);
		await assert.rejects(control("recover", held.details.runId, "continue"), /another parent/);
		await runtime.commands.get("agent").handler("lead", runtime.ctx);
		await runtime.commands.get("task-history").handler(`recover ${held.details.runId} inspect current effects before continuing`, runtime.ctx);
		await waitFor(async () => (await list()).some((row: any) => row.threadId === held.details.threadId && row.runId !== held.details.runId && row.status === "completed"));
		const launches = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		assert.match(launches[2].task, /was interrupted/);
		assert.match(launches[2].task, /inspect current effects before continuing/);
		assert.ok(launches[2].prior.some((entry: any) => entry.message?.content === "HOLD"));
		await runtime.commands.get("task-history").handler(`delete ${first.details.runId}`, runtime.ctx);
		assert.equal(await readFile(path.join(worktree, "retained-work"), "utf8"), "keep");
		rows = await list();
		assert.ok(!rows.some((row: any) => row.runId === first.details.runId));
		await runtime.commands.get("task-history").handler("prune 0", runtime.ctx);
		assert.deepEqual(await list(), []);
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		runtime = await start("other-session");
		assert.deepEqual(await list(), []);
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		runtime = await start();
		assert.ok(runtime.notifications.some(item => /stable root session ID/.test(item.message)));
		await assert.rejects(runtime.tools.get("delegate").execute("invalid-scope", { agent: "worker", task: "do not silently run" }, undefined, undefined, runtime.ctx), /no temporary fallback/);
	} finally {
		await runtime?.handlers.get("session_shutdown")?.({}, runtime.ctx);
		for (const key of environment) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
		await rm(base, { recursive: true, force: true });
	}
});

test("delegate workspace schema, execution, results, completions and replies preserve per-call isolation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-workspace-tool-"));
	const repo = path.join(root, "repo");
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	const runtime = boot(repo);
	const completions: any[] = [];
	runtime.pi.sendMessage = (message: any) => completions.push(message);
	runtime.ctx.isIdle = () => true;
	runtime.ctx.hasPendingMessages = () => false;
	const control = (action: string, runId: string, message?: string) => runtime.tools.get("subagent_control").execute("control", { action, runId, message }, undefined, undefined, runtime.ctx);
	const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
		const deadline = Date.now() + 10000;
		while (!await predicate()) {
			assert.ok(Date.now() < deadline, "workspace task did not complete");
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	let retainedPath: string | undefined;
	try {
		await makeAgent(repo, "lead", 'default: true, subagents: ["worker"],');
		await makeAgent(repo, "worker");
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
		git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
		await writeFile(path.join(repo, "source"), "committed");
		git("add", "."); git("commit", "-m", "initial");
		const base = git("rev-parse", "HEAD");
		await writeFile(path.join(repo, "source"), "parent dirty");
		await writeFile(executable, `#!/usr/bin/env node
${persistedMessages}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const session = process.argv[process.argv.indexOf('--session') + 1];
if (!existsSync(session)) writeFileSync(session, JSON.stringify({type:'session', version:3, id:'test', cwd:process.cwd(), timestamp:new Date().toISOString()}) + '\\n');
process.stdin.once('data', () => {
 const previous = existsSync('change') ? readFileSync('change', 'utf8') : 'none';
 writeFileSync('change', 'retained');
 console.log(JSON.stringify({type:'agent_start'}));
 const message = {content:[{type:'text', text:JSON.stringify({cwd:process.cwd(), source:readFileSync('source', 'utf8'), previous})}]};
 saveMessage(message);
 console.log(JSON.stringify({type:'message_end', message}));
 console.log(JSON.stringify({type:'agent_settled'}));
});
`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const tool = runtime.tools.get("delegate");
		assert.deepEqual(tool.parameters.properties.workspace.anyOf.map((item: any) => item.const), ["shared", "worktree"]);
		assert.ok(!tool.parameters.required.includes("workspace"));
		assert.match(tool.description, /shared \(default\)/);
		const delegate = (workspace?: string, background = false) => tool.execute("delegate", { agent: "worker", task: "inspect", workspace, background }, undefined, undefined, runtime.ctx);
		await assert.rejects(delegate("invalid"), /workspace must be/);
		const shared = await delegate();
		assert.equal(shared.details.workspace, "shared");
		assert.match(shared.content[0].text, /parent dirty/);
		assert.ok(shared.details.workspaceCwd);
		const foreground = await delegate("worktree");
		assert.equal(foreground.details.workspace, "worktree");
		assert.equal(foreground.details.workspaceBranch, null);
		assert.equal(foreground.details.workspaceBaseCommit, base);
		assert.match(foreground.content[0].text, /committed/);
		assert.doesNotMatch(foreground.content[0].text, /parent dirty/);
		retainedPath = foreground.details.worktreePath;
		assert.ok(retainedPath);
		const foregroundReply = await control("reply", foreground.details.runId, "continue");
		assert.equal(foregroundReply.details.workspaceCwd, foreground.details.workspaceCwd);
		const background = await delegate("worktree", true);
		assert.equal(background.details.workspace, "worktree");
		assert.equal(background.details.workspaceCwd, undefined, "creation is asynchronous, not falsely reported as shared cwd");
		await waitFor(async () => JSON.parse((await control("status", background.details.runId)).content[0].text).status === "completed");
		const result = await control("result", background.details.runId);
		assert.equal(result.details.workspace, "worktree");
		assert.notEqual(result.details.worktreePath, retainedPath);
		const reply = await control("reply", background.details.runId, "continue");
		assert.equal(reply.details.workspaceCwd, result.details.workspaceCwd);
		await waitFor(async () => JSON.parse((await control("status", reply.details.runId)).content[0].text).status === "completed");
		const replied = await control("result", reply.details.runId);
		assert.equal(replied.details.worktreePath, result.details.worktreePath);
		assert.match(replied.content[0].text, /retained/);
		await waitFor(() => completions.some(message => message.details.results.some((value: any) => value.runId === reply.details.runId)));
		const completion = completions.flatMap(message => message.details.results).find(value => value.runId === reply.details.runId);
		assert.equal(completion.workspaceCwd, result.details.workspaceCwd);
		assert.equal(completion.workspaceBaseCommit, base);
		runtime.ctx.cwd = root;
		await assert.rejects(delegate("worktree"), /Task project changed since session startup/);
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		try { if (retainedPath) assert.equal(await readFile(path.join(retainedPath, "change"), "utf8"), "retained"); }
		finally { await rm(root, { recursive: true, force: true }); }
	}
});

test("truncated foreground/background worktree cards preserve expanded management metadata", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-truncated-cards-"));
	const repo = path.join(root, "repo");
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	const runtime = boot(repo);
	const completions: any[] = [];
	const outputDirs = new Set<string>();
	runtime.pi.sendMessage = (message: any) => completions.push(message);
	runtime.ctx.isIdle = () => true;
	runtime.ctx.hasPendingMessages = () => false;
	try {
		await makeAgent(repo, "lead", 'default: true, subagents: ["worker"]');
		await makeAgent(repo, "worker");
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		git("init"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
		await writeFile(executable, `#!/usr/bin/env node
${persistedMessages}
process.stdin.once("data", () => {
 const text = Array.from({length:3000}, (_, i) => "report-line-" + i + "-" + "x".repeat(30)).join("\\n") + "\\nUNRENDERED_PRIVATE_TAIL";
 console.log(JSON.stringify({type:"agent_start"}));
 const message = {role:"assistant", stopReason:"stop", content:[{type:"text", text}]};
 saveMessage(message);
 console.log(JSON.stringify({type:"message_end", message}));
 console.log(JSON.stringify({type:"agent_settled"}));
});
`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const tool = runtime.tools.get("delegate");
		for (const background of [false, true]) {
			const ack = await tool.execute("delegate", { agent: "worker", task: "report", workspace: "worktree", background }, undefined, undefined, runtime.ctx);
			let result = ack;
			let completion: any;
			if (background) {
				const deadline = Date.now() + 10000;
				while (!(completion = completions.find(message => message.details.runs.includes(ack.details.runId)))) {
					assert.ok(Date.now() < deadline, "background completion must arrive");
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				result = completion.details.results.find((entry: any) => entry.runId === ack.details.runId);
			}
			assert.equal(result.details.outputTruncated, true);
			assert.equal(result.details.workspace, "worktree");
			outputDirs.add(path.dirname(result.details.fullOutputPath));
			assert.match(await readFile(result.details.fullOutputPath, "utf8"), /UNRENDERED_PRIVATE_TAIL/);
			const renderers = [(expanded: boolean) => tool.renderResult(ack, { expanded }, runtime.ctx.ui.theme)];
			if (completion) renderers.push(expanded => runtime.messageRenderers.get("pi-agents-completions")(completion, { expanded }, runtime.ctx.ui.theme));
			for (const render of renderers) {
				for (const expanded of [false, true, false]) {
					const text = stripVTControlCharacters(render(expanded).render(300).join("\n"));
					assert.doesNotMatch(text, /\[Output truncated:|UNRENDERED_PRIVATE_TAIL|report-line-2999/);
					assert.equal(text.split(result.details.fullOutputPath).length - 1, 1, "one full-output link, without loading its contents");
					assert.equal(text.split("report-line-0-").length - 1, 1);
					if (expanded) {
						for (const value of [`Thread ID: ${result.details.threadId}`, `Run ID: ${result.details.runId}`, "Workspace: worktree", `Cwd: ${result.details.workspaceCwd}`, `Worktree: ${result.details.worktreePath}`, `Base commit: ${result.details.workspaceBaseCommit}`, "Changes are retained; review/apply manually (not merged)."])
							assert.ok(text.includes(value), `expanded result must include ${value}`);
					} else {
						assert.ok(text.split("\n").length < 20, "collapsed preview remains bounded");
						assert.doesNotMatch(text, /report-line-20-/);
					}
				}
			}
		}
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		for (const directory of outputDirs) await rm(directory, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("task threads: parallel isolation, replies, stale/busy guards, ownership, and cleanup", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-thread-e2e-"));
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	const runtime = boot(root);
	runtime.pi.sendMessage = () => {};
	runtime.ctx.isIdle = () => true;
	runtime.ctx.hasPendingMessages = () => false;
	const control = (action: string, runId?: string, message?: string) => runtime.tools.get("subagent_control").execute("control", { action, runId, message }, undefined, undefined, runtime.ctx);
	const status = async (id: string) => JSON.parse((await control("status", id)).content[0].text);
	const wait = async (check: () => Promise<boolean>) => {
		const deadline = Date.now() + 5000;
		while (!await check()) {
			assert.ok(Date.now() < deadline, "thread did not reach expected state");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	try {
		await makeAgent(root, "lead", 'default: true, subagents: ["worker"]');
		await makeAgent(root, "other", 'subagents: ["worker"]');
		await makeAgent(root, "worker");
		await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const file = args[args.indexOf("--session") + 1];
const send = event => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.once("data", chunk => {
 const task = JSON.parse(String(chunk).split("\\n")[0]).message;
 const entries = existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").map(JSON.parse) : [];
 if (!entries.length) {
  const header = {type:"session", version:3, id:randomUUID(), timestamp:new Date().toISOString(), cwd:process.cwd()};
  writeFileSync(file, JSON.stringify(header) + "\\n");
  entries.push(header);
 }
 const prior = entries.filter(e => e.type === "message" && e.message.role === "user").map(e => e.message.content);
 const entry = {type:"message", id:randomUUID(), parentId:entries.length > 1 ? entries.at(-1).id : null, timestamp:new Date().toISOString(), message:{role:"user", content:task, timestamp:Date.now()}};
 appendFileSync(file, JSON.stringify(entry) + "\\n");
 appendFileSync(${JSON.stringify(path.join(root, "starts.jsonl"))}, JSON.stringify({task, file, at:Date.now()}) + "\\n");
 send({type:"agent_start"});
 setTimeout(() => {
  const message = {role:"assistant", stopReason:"stop", content:[{type:"text", text:JSON.stringify({prior, task, file, model:args[args.indexOf("--model") + 1]})}], timestamp:Date.now()};
  appendFileSync(file, JSON.stringify({type:"message", id:randomUUID(), parentId:entry.id, timestamp:new Date().toISOString(), message}) + "\\n");
  send({type:"message_end", message});
  send({type:"agent_settled"});
 }, task === "question" ? 150 : 300);
});`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		runtime.ctx.model = { provider: "test", id: "original" };
		const delegate = (task: string, background = true) => runtime.tools.get("delegate").execute("delegate", { agent: "worker", task, background }, undefined, undefined, runtime.ctx);
		const a = await delegate("question");
		const b = await delegate("independent");
		assert.notEqual(a.details.threadId, b.details.threadId);
		await assert.rejects(control("reply", a.details.runId, "too soon"), /busy.*steer/);
		await wait(async () => (await status(a.details.runId)).status === "completed" && (await status(b.details.runId)).status === "completed");
		const starts = readFileSync(path.join(root, "starts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(starts.length, 2);
		assert.notEqual(starts[0].file, starts[1].file);
		assert.ok(Math.max(...starts.map(row => row.at)) < Math.min((await status(a.details.runId)).endedAt, (await status(b.details.runId)).endedAt), "same-agent threads overlap");
		await assert.rejects(control("reply", a.details.runId, " "), /non-empty/);
		await runtime.commands.get("agent").handler("other", runtime.ctx);
		await assert.rejects(control("reply", a.details.runId, "wrong owner"), /Reply denied/);
		await runtime.commands.get("agent").handler("lead", runtime.ctx);
		runtime.ctx.model = { provider: "test", id: "changed" };
		const attempts = await Promise.allSettled([
			control("reply", a.details.runId, "answer"),
			control("reply", a.details.runId, "duplicate"),
		]);
		assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
		const continued = (attempts.find(item => item.status === "fulfilled") as PromiseFulfilledResult<any>).value;
		assert.equal(continued.details.threadId, a.details.threadId);
		assert.notEqual(continued.details.runId, a.details.runId);
		await assert.rejects(control("reply", a.details.runId, "stale"), /latest run/);
		await wait(async () => (await status(continued.details.runId)).status === "completed");
		const result = (await control("result", continued.details.runId)).content[0].text;
		assert.match(result, /"prior":\["question"\]/);
		assert.match(result, /New instruction:\\nanswer/);
		assert.match(result, /test\/original/);
		assert.doesNotMatch(result, /independent/);
		const foreground = await delegate("foreground", false);
		assert.ok(foreground.details.runId && foreground.details.threadId);
		const foregroundReply = await control("reply", foreground.details.runId, "followup");
		await wait(async () => (await status(foregroundReply.details.runId)).status === "completed");
		const foregroundResult = (await control("result", foregroundReply.details.runId)).content[0].text;
		assert.match(foregroundResult, /"prior":\["foreground"\]/);
		const savedFile = JSON.parse(foregroundResult.split("\n\n")[1]).file;
		await rm(savedFile);
		const restoredHistory = await control("reply", foregroundReply.details.runId, "restore the sealed conversation");
		await wait(async () => (await status(restoredHistory.details.runId)).status === "completed");
		assert.match((await control("result", restoredHistory.details.runId)).content[0].text, /foreground/);
		assert.ok(existsSync(savedFile), "a missing working session is restored from its sealed checkpoint");
		const stopped = await delegate("stop me");
		await control("stop", stopped.details.runId);
		await wait(async () => ["failed", "interrupted", "timed_out"].includes((await status(stopped.details.runId)).status));
		await assert.rejects(control("reply", stopped.details.runId, "retry"), /Only completed/);
		const storage = path.dirname(starts[0].file);
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		assert.equal(existsSync(storage), true, "shutdown retains durable task histories");
		assert.deepEqual(JSON.parse((await control("list")).content[0].text), []);
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		await rm(root, { recursive: true, force: true });
	}
});

test("durable checklists preserve amendments and handling across concurrent arrivals, compaction and reload", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-coordination-integration-"));
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	let runtime = boot(root, { sessionId: "coordination-integration" });
	const deliveries: any[] = [];
	let queuedUser = false;
	const prepare = async () => {
		runtime.pi.sendMessage = (message: any) => deliveries.push(message);
		runtime.ctx.isIdle = () => true;
		runtime.ctx.hasPendingMessages = () => queuedUser;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
	};
	const plan = async (params: any) => {
		const result = await runtime.tools.get("session_plan").execute("plan", params, undefined, undefined, runtime.ctx);
		return params.action === "list" ? result.content[0].text : JSON.parse(result.content[0].text);
	};
	const waitForResults = async (count: number) => {
		const deadline = Date.now() + 10000;
		while ((await plan({ action: "inspect" })).results.length < count) {
			assert.ok(Date.now() < deadline, "both child reports must be persisted");
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	try {
		await makeAgent(root, "lead", 'default: true, subagents: ["worker"]');
		await makeAgent(root, "worker");
		await writeFile(executable, `#!/usr/bin/env node
${persistedMessages}
const send = event => {
 if (event.type === 'message_end') saveMessage(event.message);
 process.stdout.write(JSON.stringify(event) + "\\n");
};
process.stdin.once("data", () => {
 send({type:"agent_start"});
 setTimeout(() => {
  send({type:"message_end", message:{role:"assistant", stopReason:"stop", content:[{type:"text", text:"FULL_REPORT_" + "detail ".repeat(10000) + "_END_REPORT"}]}});
  send({type:"agent_settled"});
 }, 60);
});
`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await prepare();
		await runtime.handlers.get("input")?.({ text: "Finish login and investigate authentication options", source: "interactive" }, runtime.ctx);
		const login = await plan({ action: "create", title: "Finish login", objective: "Fix and validate login", items: [{ id: "implementation", text: "Implement fix" }, { id: "review", text: "Review fix", dependsOn: ["implementation"] }] });
		const research = await plan({ action: "create", title: "Auth research", objective: "Compare auth options", items: [{ id: "research", text: "Evaluate alternatives" }] });
		const input = (await plan({ action: "inspect" })).userUpdates[0];
		await plan({ action: "reconcile_input", inputId: input.id, taskId: login.id, note: "Accepted two objectives; authentication options tracked in the second task" });
		await runtime.handlers.get("agent_start")?.({}, runtime.ctx);
		const delegate = (taskId: string, itemId: string) => runtime.tools.get("delegate").execute("delegate", { agent: "worker", task: "Produce implementation evidence", taskId, itemId, background: true }, undefined, undefined, runtime.ctx);
		const [first, second] = await Promise.all([delegate(login.id, "implementation"), delegate(research.id, "research")]);
		await waitForResults(2);
		assert.deepEqual(deliveries, [], "busy loop retains reports without injecting them");
		queuedUser = true;
		await runtime.handlers.get("input")?.({ text: "Keep the public login API unchanged", source: "rpc", streamingBehavior: "followUp" }, runtime.ctx);
		await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
		await new Promise(resolve => setTimeout(resolve, 70));
		assert.deepEqual(deliveries, [], "queued user amendment wins over an automatic completion wake");
		let state = await plan({ action: "inspect" });
		assert.equal(state.focus, undefined, "checklists do not require focus bookkeeping");
		assert.equal(state.tasks.length, 2, "arrival and user amendments do not replace objectives");
		assert.ok(state.results.every((result: any) => result.handling === "new" && !result.delivered));
		const busyContext = await runtime.handlers.get("context")?.({ messages: [{ role: "user", content: "original request", timestamp: Date.now() }] }, runtime.ctx);
		assert.doesNotMatch(busyContext.messages.at(-1).content, /FULL_REPORT_/);
		assert.doesNotMatch(busyContext.messages.at(-1).content, /Keep the public login API unchanged/);
		assert.match(busyContext.messages.at(-1).content, /safe delivery boundary/);
		queuedUser = false;
		const boundary = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.equal(boundary.message.details.runs.length, 2);
		assert.doesNotMatch(boundary.message.content, /_END_REPORT/);
		const safeContext = await runtime.handlers.get("context")?.({ messages: [] }, runtime.ctx);
		assert.match(safeContext.messages[0].content, /Keep the public login API unchanged/);
		assert.match(safeContext.messages[0].content, /Implement fix/);
		assert.match((await plan({ action: "result", runId: first.details.runId })).text, /_END_REPORT/);
		assert.equal((await plan({ action: "result", runId: first.details.runId })).handling, "new", "inspection is not acknowledgement");
		state = await plan({ action: "inspect" });
		const amendment = state.userUpdates.find((entry: any) => entry.status === "pending");
		await plan({ action: "reconcile_input", inputId: amendment.id, taskId: login.id, amendment: amendment.text });
		const acknowledged = await plan({ action: "handle_result", runId: first.details.runId, handling: "reviewed", note: "Read implementation; validation still needed" });
		assert.doesNotMatch(JSON.stringify(acknowledged), /FULL_REPORT_/);
		await plan({ action: "handle_result", runId: second.details.runId, handling: "deferred", note: "Resume research after login validation" });
		await assert.rejects(plan({ action: "update", taskId: login.id, status: "completed" }), /unfinished|pending|result|item/i);
		await runtime.handlers.get("session_shutdown")?.({ reason: "reload" }, runtime.ctx);
		runtime = boot(root, { sessionId: "coordination-integration" });
		await prepare();
		await new Promise(resolve => setTimeout(resolve, 70));
		assert.deepEqual(deliveries, [], "restoration never automatically wakes or launches a worker");
		state = await plan({ action: "inspect" });
		assert.equal(state.focus, undefined, "checklists do not require focus bookkeeping");
		assert.equal(state.results.find((result: any) => result.runId === second.details.runId).handling, "deferred");
		assert.deepEqual(state.tasks.find((task: any) => task.id === login.id).amendments, ["Keep the public login API unchanged"]);
		const restored = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "compacted base" }, runtime.ctx);
		assert.match(restored.systemPrompt, /session_plan/);
		const compactedContext = await runtime.handlers.get("context")?.({ messages: [] }, runtime.ctx);
		assert.match(compactedContext.messages[0].content, /Keep the public login API unchanged/);
		assert.match(compactedContext.messages[0].content, /deferred/);
		assert.match(compactedContext.messages[0].content, /Review fix/);
		assert.doesNotMatch(compactedContext.messages[0].content, /Main:|Next:/);
		const repeatedContext = await runtime.handlers.get("context")?.({ messages: compactedContext.messages }, runtime.ctx);
		assert.equal(repeatedContext.messages.length, 1, "ephemeral continuity context never accumulates");
		const full = await runtime.tools.get("subagent_control").execute("result", { action: "result", runId: first.details.runId }, undefined, undefined, runtime.ctx);
		assert.match(full.content[0].text, /_END_REPORT/);
		await plan({ action: "handle_result", runId: first.details.runId, handling: "incorporated", note: "Validated and applied the result" });
		await plan({ action: "update_item", taskId: login.id, itemId: "implementation", status: "completed" });
		await plan({ action: "update_item", taskId: login.id, itemId: "review", status: "completed" });
		assert.equal((await plan({ action: "inspect", taskId: login.id })).status, "completed", "checklist completion closes the task");
		assert.equal((await plan({ action: "inspect", taskId: research.id })).status, "active", "finishing one task preserves the other");
		await runtime.handlers.get("agent_start")?.({}, runtime.ctx);
		const continued = await runtime.tools.get("subagent_control").execute("reply", { action: "reply", runId: first.details.runId, message: "Verify the completed fix against the amendment" }, undefined, undefined, runtime.ctx);
		await waitForResults(3);
		state = await plan({ action: "inspect" });
		const resumedTask = state.tasks.find((task: any) => task.id === login.id);
		assert.equal(resumedTask.status, "active");
		assert.equal(resumedTask.items.length, 3, "explicit follow-up adds an obligation after a finished item");
		assert.equal(state.runs.find((run: any) => run.runId === continued.details.runId).taskId, login.id);
		assert.equal(state.focus, undefined, "checklists do not require focus bookkeeping");
		assert.equal(state.results.find((result: any) => result.runId === first.details.runId).handling, "incorporated");
		const stale = await runtime.tools.get("subagent_control").execute("stale", { action: "reply", runId: first.details.runId, message: "stale instruction" }, undefined, undefined, runtime.ctx)
			.catch((error: Error) => ({ content: [{ text: error.message }] }));
		assert.match(stale.content[0].text, /latest run|Unknown run ID/);
		const previousReport = await runtime.tools.get("subagent_control").execute("old-result", { action: "result", runId: first.details.runId }, undefined, undefined, runtime.ctx);
		assert.match(previousReport.content[0].text, /_END_REPORT/);
		assert.equal(state.results.find((result: any) => result.runId === continued.details.runId).delivered, false);
		await runtime.handlers.get("session_shutdown")?.({ reason: "reload" }, runtime.ctx);
		runtime = boot(root, { sessionId: "coordination-integration" });
		await prepare();
		const restoredBoundary = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.ok(restoredBoundary.message.details.runs.includes(continued.details.runId));
		state = await plan({ action: "inspect" });
		assert.equal(state.results.find((result: any) => result.runId === continued.details.runId).delivered, true, "restored notifications wait until the next safe boundary");
		assert.equal(state.results.find((result: any) => result.runId === continued.details.runId).handling, "new");
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		await rm(root, { recursive: true, force: true });
	}
});

test("completion event wiring survives retry errors without undoing terminal or Escape pauses", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-retry-inbox-"));
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	const runtime = boot(root);
	const deliveries: any[] = [];
	runtime.pi.sendMessage = (message: any) => deliveries.push(message);
	runtime.ctx.isIdle = () => true;
	runtime.ctx.hasPendingMessages = () => false;
	try {
		await makeAgent(root, "lead", 'default: true, subagents: ["worker"]');
		await makeAgent(root, "worker");
		await writeFile(executable, `#!/usr/bin/env node
${persistedMessages}
const send = event => {
 if (event.type === 'message_end') saveMessage(event.message);
 process.stdout.write(JSON.stringify(event) + "\\n");
};
process.stdin.once("data", () => {
 send({type:"agent_start"});
 send({type:"message_end", message:{role:"assistant", stopReason:"stop", content:[{type:"text", text:"worker-result"}]}});
 send({type:"agent_settled"});
});
`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		for (const outcome of ["retry-success", "terminal-error", "aborted-message", "Escape-signal"]) {
			deliveries.length = 0;
			const controller = new AbortController();
			runtime.ctx.signal = controller.signal;
			await runtime.handlers.get("input")?.({}, runtime.ctx);
			await runtime.handlers.get("agent_start")?.({}, runtime.ctx);
			await runtime.handlers.get("turn_start")?.({}, runtime.ctx);
			const emit = (role: string, stopReason: string) => runtime.handlers.get("message_end")?.({ message: { role, stopReason } }, runtime.ctx);
			await emit("assistant", "error");
			const run = await runtime.tools.get("delegate").execute("delegate", { agent: "worker", task: outcome, background: true }, undefined, undefined, runtime.ctx);
			const deadline = Date.now() + 5000;
			while (true) {
				const result = await runtime.tools.get("subagent_control").execute("control", { action: "status", runId: run.details.runId });
				if (JSON.parse(result.content[0].text).status === "completed") break;
				assert.ok(Date.now() < deadline, "child must complete");
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			assert.deepEqual(deliveries, [], "intermediate errors do not end the busy flow");
			if (outcome === "aborted-message") await emit("assistant", "aborted");
			if (outcome === "Escape-signal") controller.abort();
			await runtime.handlers.get("agent_start")?.({}, runtime.ctx); // retry starts
			if (outcome !== "terminal-error") await emit("assistant", "stop");
			else await emit("toolResult", "stop"); // unrelated messages cannot clear failure
			await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
			await new Promise(resolve => setTimeout(resolve, 70));
			assert.equal(deliveries.length, outcome === "retry-success" ? 1 : 0);
			if (outcome !== "retry-success") {
				await runtime.handlers.get("input")?.({}, runtime.ctx);
				const next = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
				assert.match(JSON.stringify(next.message), /worker-result/);
			}
		}
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		await rm(root, { recursive: true, force: true });
	}
});

test("background control exposes live and terminal status without consuming completion delivery", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-background-status-"));
	const executable = path.join(root, "fake-pi.mjs");
	const previousExecutable = process.env.PI_CODING_AGENT_BIN;
	const runtime = boot(root);
	const deliveries: any[] = [];
	runtime.pi.sendMessage = (message: any) => deliveries.push(message);
	runtime.ctx.isIdle = () => true;
	runtime.ctx.hasPendingMessages = () => false;
	const control = (action: string, runId?: string) => runtime.tools.get("subagent_control").execute("control", { action, runId });
	const readStatus = async (runId: string) => JSON.parse((await control("status", runId)).content[0].text);
	async function waitFor(check: () => Promise<boolean>) {
		const deadline = Date.now() + 5000;
		while (!await check()) {
			assert.ok(Date.now() < deadline, "background status did not reach expected state");
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}
	try {
		await makeAgent(root, "lead", 'default: true, subagents: [{ name: "worker", model: "test/model:high", timeoutSeconds: 30 }]');
		await makeAgent(root, "worker");
		await writeFile(executable, `#!/usr/bin/env node
			${persistedMessages}
			import { existsSync } from "node:fs";
			const send = event => {
				if (event.type === 'message_end') saveMessage(event.message);
				process.stdout.write(JSON.stringify(event) + "\\n");
			};
			let buffer = "";
			process.stdin.on("data", chunk => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\\n")) !== -1) {
					const command = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					if (command.type === "clear_queue") send({ type: "response", id: command.id, command: "clear_queue", success: true, data: { steering: [], followUp: [] } });
					if (command.type === "abort") process.exit(0);
					if (command.type !== "prompt") continue;
					send({ type: "agent_start" });
					send({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "private.txt" } });
					const timer = setInterval(() => {
						if (!existsSync(command.message + ".finish")) return;
						clearInterval(timer);
						if (command.message === "fail") process.exit(1);
						send({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
						send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "worker-result" }] } });
						send({ type: "agent_settled" });
					}, 20);
				}
			});
		`);
		await chmod(executable, 0o755);
		process.env.PI_CODING_AGENT_BIN = executable;
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.ok(runtime.activeToolsets.at(-1)?.includes("subagent_control"));
		await runtime.handlers.get("agent_start")?.({}, runtime.ctx);
		assert.deepEqual(JSON.parse((await control("list")).content[0].text), []);
		assert.match((await control("status")).content[0].text, /Unknown run ID/);
		assert.match((await control("status", "unknown")).content[0].text, /Unknown run ID/);

		for (const [task, terminalStatus] of [["complete", "completed"], ["fail", "failed"], ["stop", "interrupted"]]) {
			const result = await runtime.tools.get("delegate").execute("delegate", { agent: "worker", task, background: true }, undefined, undefined, runtime.ctx);
			const runId = result.details.runId;
			const original = JSON.stringify(result);
			let redraws = 0;
			let card = "";
			const renderCard = () => {
				card = runtime.tools.get("delegate").renderResult(result, { expanded: false }, runtime.ctx.ui.theme, {
					invalidate: () => { redraws++; renderCard(); },
				}).render(100).join("\n");
			};
			renderCard();
			assert.match(card, /worker running/);
			assert.deepEqual(runtime.lifecycleEvents.at(-1), {
				channel: "task:subagent:lifecycle", data: { runId, agent: "worker", status: "started" },
			});
			const initial = await readStatus(runId);
			assert.equal(initial.status, "running");
			assert.equal(initial.model, "test/model:high");
			assert.ok(initial.deadlineAt > initial.startedAt);
			await waitFor(async () => (await readStatus(runId)).currentTool === "read");
			const live = await readStatus(runId);
			assert.equal(live.phase, "tool execution");
			assert.ok(live.elapsedMs >= 0);
			assert.ok(live.remainingMs > 0);
			assert.doesNotMatch(JSON.stringify(live), /private.txt|transcript/);
			const listed = JSON.parse((await control("list")).content[0].text).find((run: any) => run.runId === runId);
			assert.equal(listed.currentTool, "read");
			if (task === "stop") await control("stop", runId);
			else await writeFile(path.join(root, `${task}.finish`), "");
			await waitFor(async () => (await readStatus(runId)).status === terminalStatus);
			const terminal = await readStatus(runId);
			assert.equal(redraws, 1, "completion invalidates the original row even while main flow is busy");
			assert.match(card, new RegExp(`worker ${terminalStatus === "interrupted" ? "stopped" : terminalStatus}`));
			assert.doesNotMatch(card, /worker running|Started background subagent/);
			assert.equal(JSON.stringify(result), original, "UI updates do not mutate the model's tool acknowledgement");
			renderCard();
			assert.equal(redraws, 1);
			assert.deepEqual(runtime.lifecycleEvents.filter(event => event.data.runId === runId), [
				{ channel: "task:subagent:lifecycle", data: { runId, agent: "worker", status: "started" } },
				{ channel: "task:subagent:lifecycle", data: { runId, agent: "worker", status: terminalStatus === "interrupted" ? "aborted" : terminalStatus } },
			]);
			assert.ok(terminal.endedAt >= terminal.startedAt);
			assert.equal(terminal.currentTool, undefined);
			assert.equal(terminal.remainingMs, undefined);
			await control("status", runId);
			if (task === "complete") assert.match((await control("result", runId)).content[0].text, /worker-result/);
		}
		assert.equal(deliveries.length, 0, "status checks do not deliver completions during the main flow");
		await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
		await waitFor(async () => deliveries.length === 1);
		assert.equal(deliveries[0].details.runs.length, 3, "status checks leave every completion in the inbox");
		assert.match(deliveries[0].content, /worker-result/);
		assert.match(deliveries[0].content, /worker · failed/);
		assert.equal(deliveries[0].display, true);
		const renderCompletion = runtime.messageRenderers.get("pi-agents-completions");
		for (const expanded of [false, true]) {
			const rendered = renderCompletion(deliveries[0], { expanded }, runtime.ctx.ui.theme).render(100).join("\n");
			assert.match(rendered, /Background task results/);
			for (const status of ["completed", "failed", "stopped"]) assert.match(rendered, new RegExp(`worker ${status}`));
			assert.match(rendered, /worker-result/);
			assert.doesNotMatch(rendered, /\[pi-agents-completions\]/);
		}
		for (const details of [{ runs: ["old"] }, { results: [{ runId: "old", workspaceCwd: "/project" }] }]) {
			const legacy = renderCompletion({ content: "Legacy completion", details }, { expanded: false }, runtime.ctx.ui.theme);
			assert.match(legacy.render(40).join("\n"), /Legacy completion/);
		}
		const pending = await runtime.tools.get("delegate").execute("delegate", { agent: "worker", task: "shutdown", background: true }, undefined, undefined, runtime.ctx);
		await waitFor(async () => (await readStatus(pending.details.runId)).currentTool === "read");
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		assert.deepEqual(runtime.lifecycleEvents.filter(event => event.data.runId === pending.details.runId), [
			{ channel: "task:subagent:lifecycle", data: { runId: pending.details.runId, agent: "worker", status: "started" } },
			{ channel: "task:subagent:lifecycle", data: { runId: pending.details.runId, agent: "worker", status: "aborted" } },
		]);
		assert.equal(runtime.lifecycleEvents.length, 8, "each run emits exactly one start and terminal event");
		assert.deepEqual(JSON.parse((await control("list")).content[0].text), []);
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		if (previousExecutable === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousExecutable;
		await rm(root, { recursive: true, force: true });
	}
});

test("picker letters filter while F4/F5/F6 perform actions with terminal key sequences", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-picker-keys-"));
	try {
		for (const name of ["designer", "engineer", "runner"]) await makeAgent(root, name);
		const { agents } = await discoverAgents(root);
		const runtime = boot(root);
		const options = { projectName: "test", projectRoot: root, trusted: true, allTools: [], activeTools: [], mcpServers: {}, mcpServerSources: {}, mcpStatuses: {} };
		for (const query of ["designer", "engineer", "runner", "DESIGNER"]) {
			runtime.ctx.ui.custom = async (factory: any) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, (value: unknown) => { result = value; });
				assert.match(component.render(120).join("\n"), /F4 edit · F5 new · F6 reorder/);
				for (const character of query) {
					component.handleInput(character);
					assert.equal(result, undefined, `typing ${character} must not trigger an action`);
				}
				component.handleInput("\r");
				assert.equal(result, query.toLowerCase());
				return result;
			};
			await showAgentSelector(runtime.ctx, agents, "runner", options);
		}
		for (const [sequence, action] of [["\x1bOS", "edit"], ["\x1b[14~", "edit"], ["\x1b[15~", "create"], ["\x1b[17~", "reorder"]]) {
			runtime.ctx.ui.custom = async (factory: any) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, (value: unknown) => { result = value; });
				component.handleInput(sequence);
				assert.deepEqual(result, action === "create" ? { action } : { action, agent: "runner" });
				return result;
			};
			await showAgentSelector(runtime.ctx, agents, "runner", options);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("dashboard reorder and whole-folder deletion take effect without reload", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-manage-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "alpha", ".env"), "SECRET=keep\n");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ custom: "preserved" }));
		const runtime = boot(root, {
			selectAnswers: ["2 · beta", "Project (commit with this repository)"],
			customActions: [(component) => component.handleInput("\x1b[17~")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const saved = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.deepEqual(saved.agentOrder, ["beta", "alpha"]);
		assert.equal(saved.custom, "preserved");
		assert.deepEqual((await discoverAgents(root)).agents.filter(a => ["alpha", "beta"].includes(a.name)).map(a => a.name), ["beta", "alpha"]);

		const originalCustom = runtime.ctx.ui.custom;
		runtime.ctx.ui.custom = async (factory: any) => {
			let selected: unknown;
			const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, (value: unknown) => { selected = value; });
			component.handleInput("\x1b[A");
			component.handleInput("\r");
			assert.equal(selected, "beta", "reordered list is live without restarting the session");
			return null;
		};
		await runtime.commands.get("agent").handler("", runtime.ctx);
		let confirmed = false;
		runtime.ctx.ui.confirm = async (_title: string, message: string) => {
			assert.match(message, /ALL its contents/);
			assert.match(message, /credentials/);
			return confirmed;
		};
		let sendDelete = true;
		runtime.ctx.ui.custom = async (factory: any) => {
			if (!sendDelete) return null;
			sendDelete = false;
			return new Promise(resolve => {
				const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, resolve);
				component.handleInput("\x1b[3~");
			});
		};
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"));
		confirmed = true;
		sendDelete = true;
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await assert.rejects(readFile(path.join(root, ".pi-agents", "alpha", "agent.ts")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(root, ".pi-agents", "alpha", ".env")), { code: "ENOENT" });
		await readFile(path.join(root, ".pi-agents", "beta", "agent.ts"));
		await runtime.commands.get("agent").handler("alpha", runtime.ctx);
		assert.ok(runtime.notifications.some(item => /Unknown agent/.test(item.message)), "deleted agent is unavailable immediately");
		assert.deepEqual(runtime.activeToolsets.at(-1), ["read", "bash", "session_plan"]);
		runtime.ctx.ui.custom = originalCustom;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deleting a standalone agent preserves the shared agents directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delete-file-"));
	try {
		await makeAgent(root, "beta");
		const file = path.join(root, ".pi-agents", "agent.ts");
		await writeFile(file, 'export default { name: "standalone", description: "Standalone", default: true };');
		const runtime = boot(root, { customActions: [component => component.handleInput("\x04")] });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await assert.rejects(readFile(file), { code: "ENOENT" });
		await readFile(path.join(root, ".pi-agents", "beta", "agent.ts"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Studio credential saves reconnect a real authenticated HTTP MCP without reload", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-auth-e2e-"));
	const server = await startAuthenticatedMcp();
	const selectAnswers: Array<string | undefined> = [];
	const customActions: Array<(component: any, done: (value: any) => void) => void> = [];
	const runtime = boot(root, {
		mode: "tui", selectAnswers, customActions,
		branchEntries: [{ type: "custom", customType: "pi-agents-studio-state", data: {
			name: "alpha", override: { systemPrompt: "Keep this session draft" },
		} }],
	});
	const toolName = mcpToolName("authenticated", "echo");
	try {
		await makeAgent(root, "alpha", 'default: true, tools: undefined, mcp: ["authenticated"]');
		await makeAgent(root, "beta", 'mcp: ["authenticated"]');
		const configFile = path.join(root, ".pi-agents", "config.json");
		await writeFile(configFile, JSON.stringify({ mcpServers: { authenticated: {
			url: server.url, headers: { Authorization: "Bearer ${PI_AGENTS_E2E_SECRET}" },
		} } }));
		const originalConfig = await readFile(configFile, "utf8");
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		async function save(value: string, cancel = false) {
			selectAnswers.push("Manage MCP servers (1)", "Back without applying");
			customActions.push(
				component => component.handleInput("\x1bOS"),
				component => {
					const details = component.render(120).join("\n");
					assert.match(details, /authenticated/);
					assert.match(details, /Disable server/);
					assert.match(details, /Manage credentials/);
					assert.match(details, /Test connection/);
					component.handleInput("\r"); // selected server settings
					component.handleInput("\r"); // disable
					assert.match(component.render(120).join("\n"), /Enable server/);
					component.handleInput("\r"); // restore draft assignment
					component.handleInput("\x1b[B"); // credentials
					component.handleInput("\r");
				},
				component => {
					component.handleInput(`\x1b[200~${value}\x1b[201~`);
					assert.ok(!component.render(80).join("\n").includes(value));
					component.handleInput(cancel ? "\x1b" : "\r");
				},
				component => {
					assert.match(component.render(120).join("\n"), /› Manage credentials/);
					component.handleInput("\x1b");
					component.handleInput("\x1b");
				},
				component => component.handleInput("\x1b"),
			);
			await runtime.commands.get("agent").handler("", runtime.ctx);
		}
		async function testConnection(expected: RegExp) {
			const toolsBefore = [...runtime.tools.keys()];
			const activeBefore = [...runtime.activeToolsets.at(-1)!];
			const entriesBefore = runtime.entries.length;
			const notificationsBefore = runtime.notifications.length;
			selectAnswers.push("Manage MCP servers (1)", "Back without applying");
			customActions.push(
				component => component.handleInput("\x1bOS"),
				component => {
					component.handleInput("\r");
					component.handleInput("\x1b[B");
					component.handleInput("\x1b[B");
					component.handleInput("\r");
				},
				component => {
					const details = component.render(160).join(" ").replace(/\s+/g, " ");
					assert.match(details, expected);
					assert.match(details, /› Test connection/);
					component.handleInput("\x1b");
					component.handleInput("\x1b");
				},
				component => component.handleInput("\x1b"),
			);
			await runtime.commands.get("agent").handler("", runtime.ctx);
			assert.ok(runtime.notifications.slice(notificationsBefore).some(entry => expected.test(entry.message)));
			assert.deepEqual([...runtime.tools.keys()], toolsBefore);
			assert.deepEqual(runtime.activeToolsets.at(-1), activeBefore);
			assert.equal(runtime.entries.length, entriesBefore);
		}
		await testConnection(/Missing credentials/);
		async function call() {
			const result = await runtime.tools.get(toolName).execute("test-call", {}, new AbortController().signal, undefined, runtime.ctx);
			assert.equal(result.content[0].text, "authenticated");
		}
		await save("first-token");
		await testConnection(/connection successful; 1 tools discovered/);
		assert.ok(runtime.activeToolsets.at(-1)?.includes(toolName));
		await call();
		assert.ok(server.requests.some(request => request.method === "tools/call" && request.authorization === "Bearer first-token"));
		const beforeCancel = server.requests.length;
		await save("cancelled-token", true);
		assert.equal(server.requests.length, beforeCancel);
		assert.ok(!(await readFile(path.join(root, ".pi-agents", "alpha", ".env"), "utf8")).includes("cancelled-token"));
		server.setToken("rotated-token");
		await save("rotated-token");
		await call();
		assert.ok(server.requests.some(request => request.method === "tools/call" && request.authorization === "Bearer rotated-token"));
		await save("wrong-token");
		await testConnection(/Connection or tool discovery failed/);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		assert.ok(runtime.notifications.some(entry => entry.level === "error" && /failed to start/.test(entry.message)));
		await save("rotated-token");
		await call();
		assert.equal(await readFile(configFile, "utf8"), originalConfig);
		await assert.rejects(readFile(path.join(root, ".pi-agents", ".env")), { code: "ENOENT" });
		const beforeSwitch = server.requests.length;
		await runtime.commands.get("agent").handler("beta", runtime.ctx);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		const betaRequests = server.requests.slice(beforeSwitch).filter(request => request.method === "initialize");
		assert.ok(betaRequests.length > 0);
		assert.ok(betaRequests.every(request => request.authorization !== "Bearer rotated-token"));
		await assert.rejects(readFile(path.join(root, ".pi-agents", "beta", ".env")), { code: "ENOENT" });
		await runtime.commands.get("agent").handler("alpha", runtime.ctx);
		await call();
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Keep this session draft/);
		const history = JSON.stringify({ entries: runtime.entries, notifications: runtime.notifications });
		for (const secret of ["first-token", "rotated-token", "wrong-token", "cancelled-token"]) assert.ok(!history.includes(secret));
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("/models manages global aliases and Studio delegates the same table", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-models-command-"));
	const globalDir = path.join(testAgentDir, "pi-agents");
	const globalConfig = path.join(globalDir, "config.json");
	const hadGlobal = existsSync(globalConfig);
	const previousGlobal = hadGlobal ? readFileSync(globalConfig, "utf8") : undefined;
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		await mkdir(globalDir, { recursive: true });
		await writeFile(globalConfig, JSON.stringify({ models: [{ id: "m_old", name: "old", model: "test/old-model" }] }));
		const runtime = boot(root, {
			selectAnswers: ["Add alias", "@fresh → test/fresh-model:max", "Rename (used by 0 subagent entries)", "Done"],
			inputAnswers: ["fresh", "test/fresh-model:max"],
			editorAnswers: ["renamed"],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("models").handler("", runtime.ctx);
		const saved = JSON.parse(readFileSync(globalConfig, "utf8"));
		assert.equal(saved.models.length, 2);
		assert.equal(saved.models[0].name, "old", "existing aliases are retained");
		assert.equal(saved.models[1].name, "renamed");
		assert.equal(saved.models[1].model, "test/fresh-model:max");
		assert.ok(saved.models[1].id.startsWith("m_"), "new aliases get a stable generated id");
		assert.ok(runtime.notifications.some(entry => entry.message.includes(globalConfig)));
		// Escaping the manager changes nothing on disk.
		const cancelling = boot(root, { selectAnswers: [undefined] });
		await cancelling.handlers.get("session_start")?.({ reason: "startup" }, cancelling.ctx);
		await cancelling.commands.get("models").handler("", cancelling.ctx);
		assert.deepEqual(JSON.parse(readFileSync(globalConfig, "utf8")).models, saved.models);
	} finally {
		if (previousGlobal === undefined) await rm(globalConfig, { force: true });
		else await writeFile(globalConfig, previousGlobal);
		await rm(root, { recursive: true, force: true });
	}
});

test("Studio sets a startup default without activating or discarding edits", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-default-ui-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		const runtime = boot(root, {
			selectAnswers: ["Set as default agent", "Project (commit with this repository)", "Back without applying"],
			customActions: [(_component, done) => done({ action: "edit", agent: "beta" })],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.equal((await discoverAgents(root)).config.defaultAgent, "beta");
		assert.equal((runtime.entries.at(-1)?.data as any).name, "alpha");
		const fresh = boot(root);
		await fresh.handlers.get("session_start")?.({ reason: "startup" }, fresh.ctx);
		assert.equal((fresh.entries.at(-1)?.data as any).name, "beta");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("/new inherits agent, model, reasoning and drafts across extension replacement only once", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-new-settings-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		const old = boot(root, { branchEntries: [{ type: "custom", customType: "pi-agents-studio-state", data: { name: "beta", override: { systemPrompt: "Unsaved prompt" } } }] });
		old.ctx.model = { provider: "test", id: "chosen" };
		await old.handlers.get("session_start")?.({ reason: "startup" }, old.ctx);
		await old.commands.get("agent").handler("beta", old.ctx);
		await old.handlers.get("session_shutdown")?.({ reason: "new" }, old.ctx);
		const next = boot(root, { flag: "alpha" });
		const changes: unknown[] = [];
		next.ctx.modelRegistry = { find: (provider: string, id: string) => ({ provider, id }) };
		next.pi.setModel = async (model: unknown) => { changes.push(model); return true; };
		next.pi.setThinkingLevel = (level: string) => changes.push(level);
		await next.handlers.get("session_start")?.({ reason: "new" }, next.ctx);
		assert.deepEqual(changes, [{ provider: "test", id: "chosen" }, "high"]);
		assert.equal((next.entries.find(entry => entry.customType === "pi-agents-state")?.data as any).name, "beta");
		assert.equal((next.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any).override.systemPrompt, "Unsaved prompt");
		const fresh = boot(root);
		await fresh.handlers.get("session_start")?.({ reason: "startup" }, fresh.ctx);
		assert.equal((fresh.entries.at(-1)?.data as any).name, "alpha");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("model aliases live in the global config only and round-trip through save and load", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-alias-config-"));
	const globalDir = path.join(testAgentDir, "pi-agents");
	const globalConfig = path.join(globalDir, "config.json");
	const projectConfig = path.join(root, ".pi-agents", "config.json");
	const hadGlobal = existsSync(globalConfig);
	const previousGlobal = hadGlobal ? readFileSync(globalConfig, "utf8") : undefined;
	try {
		await mkdir(path.join(root, ".pi-agents"), { recursive: true });
		// A project-level table is never used: aliases are one global list.
		await writeFile(projectConfig, JSON.stringify({ models: [{ name: "project-only", model: "test/project" }], defaultAgent: "alpha" }));
		assert.equal(loadConfig(root).models, undefined, "project config must not define model aliases");

		await mkdir(globalDir, { recursive: true });
		await writeFile(globalConfig, JSON.stringify({ defaultAgent: "keep-me", models: [{ id: "m_old", name: "old", model: "test/old" }] }));
		const savedPath = saveModelAliases(root, [{ id: "m_fast", name: "fast", model: "test/fast:max" }]);
		assert.equal(savedPath, globalConfig);
		const raw = JSON.parse(readFileSync(globalConfig, "utf8"));
		assert.equal(raw.defaultAgent, "keep-me", "unrelated global fields are preserved");
		assert.deepEqual(raw.models, [{ id: "m_fast", name: "fast", model: "test/fast:max" }]);
		const loaded = loadConfig(root);
		assert.deepEqual(loaded.models, [{ id: "m_fast", name: "fast", model: "test/fast:max" }]);
		assert.equal(loaded.defaultAgent, "alpha", "project config still wins for project-scoped fields");

		saveModelAliases(root, []);
		assert.equal(JSON.parse(readFileSync(globalConfig, "utf8")).models, undefined);
		assert.equal(loadConfig(root).models, undefined);
	} finally {
		if (previousGlobal === undefined) await rm(globalConfig, { force: true });
		else await writeFile(globalConfig, previousGlobal);
		await rm(root, { recursive: true, force: true });
	}
});

test("subagent editor validates timeouts and cancels without mutating existing settings", async () => {
	const current = [{ name: "missing", model: "old/model", timeoutSeconds: 20 }];
	const runtime = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s (missing agent)", "Set timeout (20s)", "Done"],
		editorAnswers: ["-1"],
	});
	runtime.ctx.ui.editor = async (_title: string, prefill: string) => {
		assert.equal(prefill, "20");
		return "-1";
	};
	assert.deepEqual(await editSubagents(runtime.ctx, "parent", [], current), current);
	assert.ok(runtime.notifications.some(item => item.message.includes("positive number")));
	const cancelled = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s (missing agent)", "Remove subagent", undefined],
	});
	assert.equal(await editSubagents(cancelled.ctx, "parent", [], current), undefined);
	assert.equal(current.length, 1);

	const populated = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s (missing agent)", "Set model (old/model)", "Custom… (type a model ID)", "1 · missing · updated/model:max · 20s (missing agent)", "Set timeout (20s)", "Done"],
	});
	const seen: string[] = [];
	populated.ctx.ui.editor = async (_title: string, prefill: string) => {
		seen.push(prefill);
		return seen.length === 1 ? "updated/model:max" : "45";
	};
	assert.deepEqual(await editSubagents(populated.ctx, "parent", [], current), [{ name: "missing", model: "updated/model:max", timeoutSeconds: 45 }]);
	assert.deepEqual(seen, ["old/model", "20"]);
	assert.deepEqual(current, [{ name: "missing", model: "old/model", timeoutSeconds: 20 }]);

	const dismissed = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s (missing agent)", "Set model (old/model)", undefined, "Done"],
	});
	assert.deepEqual(await editSubagents(dismissed.ctx, "parent", [], current), current);

});

test("subagent model picker stores aliases by id and canonicalizes hand-typed names", async () => {
	const aliases = [
		{ id: "m_fast", name: "fast", model: "test/fast:max" },
		{ id: "m_strong", name: "strong", model: "test/strong:high" },
	];
	const available = [{ name: "worker" }, { name: "researcher" }] as never;
	const current = [{ name: "worker" }, { name: "researcher", model: "test/raw" }];
	const runtime = boot("/tmp", {
		selectAnswers: [
			"1 · worker · default model · no timeout", "Set model (default model)", "@fast → test/fast:max",
			"2 · researcher · test/raw · no timeout", "Set model (test/raw)", "Custom… (type a model ID)",
			"Done",
		],
		editorAnswers: ["@strong"],
	});
	assert.deepEqual(await editSubagents(runtime.ctx, "parent", available, current, aliases), [
		{ name: "worker", model: "@id:m_fast" },
		{ name: "researcher", model: "@id:m_strong" },
	]);
	assert.deepEqual(current, [{ name: "worker" }, { name: "researcher", model: "test/raw" }]);

	const missing = boot("/tmp", {
		selectAnswers: ["1 · worker · @ghost (missing) · no timeout", "Set model (@ghost (missing))", "Default (inherit parent's model)", "Done"],
	});
	assert.deepEqual(await editSubagents(missing.ctx, "parent", available, [{ name: "worker", model: "@ghost" }], aliases), [{ name: "worker" }]);
});

test("Models manager adds, renames, and deletes aliases with usage warnings", async () => {
	const agents = [{ name: "worker", subagents: [{ name: "dev", model: "@id:m_fast" }] }];
	const runtime = boot("/tmp", {
		selectAnswers: [
			"Add alias", "@strong → test/strong:high", "Rename (used by 0 subagent entries)",
			"@heavy → test/strong:high", "Set model (test/strong:high)", "Done",
		],
		inputAnswers: ["strong", "test/strong:high"],
		editorAnswers: ["heavy", "test/heavy-model:low"],
	});
	runtime.ctx.ui.confirm = async () => true;
	const edited = await editModelAliases(runtime.ctx, [{ id: "m_fast", name: "fast", model: "test/fast:max" }], agents as never);
	assert.deepEqual(edited, [
		{ id: "m_fast", name: "fast", model: "test/fast:max" },
		{ name: "heavy", model: "test/heavy-model:low", id: edited![1].id },
	]);
	assert.ok(edited![1].id.startsWith("m_"), "Studio-created aliases get a stable generated id");

	const deleter = boot("/tmp", { selectAnswers: ["@fast → test/fast:max", "Delete alias", "Done"] });
	deleter.ctx.ui.confirm = async (title: string, message: string) => {
		assert.match(title, /Delete alias "@fast"/);
		assert.match(message, /used by 1 subagent entry/);
		return true;
	};
	assert.deepEqual(await editModelAliases(deleter.ctx, [{ id: "m_fast", name: "fast", model: "test/fast:max" }], agents as never), []);

	const cancelled = boot("/tmp", { selectAnswers: [undefined] });
	const before = [{ id: "m_fast", name: "fast", model: "test/fast:max" }];
	assert.equal(await editModelAliases(cancelled.ctx, before, agents as never), undefined);
	assert.deepEqual(before, [{ id: "m_fast", name: "fast", model: "test/fast:max" }]);
});

test("Studio adds configured subagents, restores drafts, and saves an empty delegation list", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-subagents-"));
	try {
		await makeAgent(root, "alpha", "default: true, tools: undefined");
		await makeAgent(root, "beta");
		const runtime = boot(root, {
			selectAnswers: ["Manage subagents (0)", "Add subagent", "beta · beta", "1 · beta · default model · no timeout", "Set model (default model)", "Custom… (type a model ID)", "1 · beta · test/model · no timeout", "Set timeout (none)", "Done", "Apply as session draft"],
			inputAnswers: ["test/model", "30"],
			customActions: [component => component.handleInput("\x1bOS")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.ok(runtime.activeToolsets.at(-1)?.includes("delegate"));
		const draft = runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")!;
		assert.deepEqual((draft.data as any).override.subagents, [{ name: "beta", model: "test/model", timeoutSeconds: 30 }]);
		saveAgentOverride(root, "project", "alpha", (draft.data as any).override);
		assert.deepEqual((await discoverAgents(root)).agents.find(agent => agent.name === "alpha")?.subagents, (draft.data as any).override.subagents);
		const restored = boot(root, {
			branchEntries: [{ type: "custom", ...draft }],
			selectAnswers: ["Manage subagents (1)", "1 · beta · test/model · 30s", "Remove subagent", "Done", "Save agent.ts (project)"],
			customActions: [component => component.handleInput("\x1bOS")],
		});
		await restored.handlers.get("session_start")?.({ reason: "startup" }, restored.ctx);
		assert.ok(restored.activeToolsets.at(-1)?.includes("delegate"));
		await restored.commands.get("agent").handler("", restored.ctx);
		assert.ok(!restored.activeToolsets.at(-1)?.includes("delegate"));
		assert.match(await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8"), /subagents: \[\]/);
		const savedConfig = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(savedConfig.agentOverrides, undefined);
		assert.deepEqual((await discoverAgents(root)).agents.find(agent => agent.name === "alpha")?.subagents ?? [], []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio routes renamed labels by ID and persists description and color overrides", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ids-"));
	const oldLabel = STUDIO_LABELS[StudioAction.Description];
	STUDIO_LABELS[StudioAction.Description] = "Change agent summary";
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, {
			selectAnswers: ["Change agent summary", "Color (automatic)", "Custom hex/theme role", "Save agent.ts (project)"],
			inputAnswers: ["invalid-color", "#ABCDEF"], editorAnswers: ["Refined responsibility"],
			customActions: [component => component.handleInput("\x1bOS"), component => component.handleInput("\x1b")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const discovered = await discoverAgents(root);
		assert.equal(discovered.agents.find(agent => agent.name === "alpha")?.description, "Refined responsibility");
		assert.equal(discovered.agents.find(agent => agent.name === "alpha")?.color, "#abcdef");
		assert.ok(runtime.notifications.some(entry => /six-digit hex/.test(entry.message)));
	} finally {
		STUDIO_LABELS[StudioAction.Description] = oldLabel;
		await rm(root, { recursive: true, force: true });
	}
});

function enableStudioAI(runtime: ReturnType<typeof boot>, response: string) {
	const requests: any[] = [];
	runtime.ctx.model = { provider: "studio-test", id: "selected-model" };
	runtime.ctx.thinkingLevel = "high";
	runtime.ctx.modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "provider-secret" }),
		getProvider: () => ({ streamSimple: (model: any, context: any, options: any) => {
			requests.push({ model, context, options });
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: response }] }) };
		} }),
	};
	return requests;
}

test("Studio creates a reviewed AI draft with color using the selected model and reasoning", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ai-create-"));
	const generated = { name: "planner", description: "Plan outcomes", color: "#ff9f0a", tools: ["read"], mcp: [], systemPrompt: "Clarify scope and acceptance criteria." };
	try {
		const runtime = boot(root, {
			mode: "tui",
			selectAnswers: ["Project (commit with this repository)", "Describe with AI", "Orange (#ff9f0a)", "Back without applying"],
			inputAnswers: ["Create a PM who clarifies product scope"],
			editorAnswers: [JSON.stringify({ ...generated, description: "Reviewed product planner" })],
			customActions: [component => component.handleInput("\x1b[15~"), component => component.handleInput("\x1b")],
		});
		const requests = enableStudioAI(runtime, JSON.stringify(generated));
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const dir = path.join(root, ".pi-agents", "planner");
		const saved = (await discoverAgents(root)).agents.find(agent => agent.name === "planner");
		assert.equal(saved?.description, "Reviewed product planner");
		assert.equal(saved?.color, generated.color);
		assert.equal(await readFile(path.join(dir, "prompt.md"), "utf8"), generated.systemPrompt);
		await assert.rejects(readFile(path.join(dir, "agent.json")), { code: "ENOENT" });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].model.id, "selected-model");
		assert.equal(requests[0].options.reasoning, "high");
		assert.match(requests[0].context.systemPrompt, /PM: clarify outcomes/);
		assert.ok(!JSON.stringify(runtime.entries).includes("planner")); // no activation
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio AI prompt help reviews a draft without exposing credentials or changing other fields", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ai-edit-"));
	try {
		await makeAgent(root, "alpha", 'default: true, color: "#4cc2ff", systemPrompt: "Original prompt"');
		await writeFile(path.join(root, ".pi-agents", "alpha", ".env"), "DOCHUB_TOKEN=private-agent-secret\n");
		const source = await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8");
		const runtime = boot(root, {
			mode: "tui", selectAnswers: ["Edit prompt (1 lines)", "Apply as session draft"],
			inputAnswers: ["Make the prompt test-driven"],
			customActions: [
				component => component.handleInput("\x1bOS"),
				component => {
					assert.match(component.render(120).join("\n"), /F2 AI assistance/);
					component.handleInput(" plus manual changes");
					component.handleInput("\x1bOQ"); // F2: assist this field
				},
				component => {
					assert.match(component.render(120).join("\n"), /Proposed: test first/);
					component.handleInput("\x15"); // Ctrl+U: edit the suggestion before accepting
					component.handleInput("Reviewed: write tests first.");
					component.handleInput("\r");
				},
				component => component.handleInput("\x1b"),
			],
		});
		const requests = enableStudioAI(runtime, "Proposed: test first.");
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Reviewed: write tests first/);
		assert.ok(!JSON.stringify(requests[0].context).includes("private-agent-secret"));
		assert.match(requests[0].context.messages[0].content[0].text, /Original prompt plus manual changes/);
		assert.equal(await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8"), source);
		const savedDraft = runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any;
		assert.equal(savedDraft.override.color, "#4cc2ff");
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ["save", "undo", "cancel", "cancel-request", "failure"] as const) {
	test(`description editor keeps AI assistance field-local (${outcome})`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-description-assist-"));
		try {
			await makeAgent(root, "alpha", 'default: true, systemPrompt: "Do not change this prompt"');
			const runtime = boot(root, {
				mode: "tui", selectAnswers: ["Edit description", "Apply as session draft"],
				inputAnswers: [outcome === "cancel-request" ? undefined : "Make the description concise"],
				customActions: [
					component => component.handleInput("\x1bOS"),
					component => {
						assert.match(component.render(120).join("\n"), /Description · alpha/);
						component.handleInput(" manual edit");
						component.handleInput("\x1bOQ");
					},
					component => {
						assert.match(component.render(120).join("\n"), outcome === "cancel-request" || outcome === "failure" ? /alpha manual edit/ : /Suggested responsibility/);
						if (outcome === "undo") {
							component.handleInput("\x1bOR"); // F3: restore the pre-AI manual draft
							assert.match(component.render(120).join("\n"), /alpha manual edit/);
						}
						component.handleInput(outcome === "cancel" ? "\x1b" : "\r");
					},
					component => component.handleInput("\x1b"),
				],
			});
			const requests = enableStudioAI(runtime, "Suggested responsibility");
			if (outcome === "failure") runtime.ctx.modelRegistry.getProvider = () => ({ streamSimple: () => ({ result: async () => { throw new Error("private provider error"); } }) });
			await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
			await runtime.commands.get("agent").handler("", runtime.ctx);
			const override = (runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any).override;
			assert.equal(override.description, outcome === "save" ? "Suggested responsibility" : outcome === "cancel" ? "alpha" : "alpha manual edit");
			assert.equal(override.systemPrompt, "Do not change this prompt");
			if (requests.length) {
				assert.match(requests[0].context.systemPrompt, /revised description/);
				assert.match(requests[0].context.messages[0].content[0].text, /alpha manual edit/);
			}
			if (outcome === "cancel-request") assert.equal(requests.length, 0);
			assert.ok(!JSON.stringify(runtime.notifications).includes("private provider error"));
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

test("cancelling AI draft review does not create an agent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-ai-cancel-"));
	try {
		const runtime = boot(root, {
			mode: "tui", selectAnswers: ["Project (commit with this repository)", "Describe with AI"],
			inputAnswers: ["Create a developer"], editorAnswers: [undefined],
			customActions: [component => component.handleInput("\x1b[15~"), component => component.handleInput("\x1b")],
		});
		enableStudioAI(runtime, JSON.stringify({ name: "dev", description: "Developer", systemPrompt: "Test changes" }));
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const dir = path.join(root, ".pi-agents", "dev");
		await assert.rejects(readFile(path.join(dir, "agent.ts")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(dir, "prompt.md")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(dir, "agent.json")), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("session startup activates config.defaultAgent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-default-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["read", "session_plan"]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "beta" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("--agent takes precedence over the configured default", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-flag-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root, { flag: "alpha" });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "alpha" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a persisted plain-pi selection suppresses configured defaults", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-persisted-none-"));
	try {
		await makeAgent(root, "alpha");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "alpha" }));
		const sessionFile = path.join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: "pi-agents-state", data: { name: null } })}\n`);
		const runtime = boot(root, { sessionFile });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, [["read", "bash", "session_plan"]]);
		assert.deepEqual(runtime.entries, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("untrusted projects do not load or activate project agents", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-untrusted-runtime-"));
	try {
		await makeAgent(root, "project-agent", "default: true");
		const runtime = boot(root, { trusted: false });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, [["read", "bash", "session_plan"]]);
		assert.ok(runtime.notifications.some((entry) => entry.level === "warning" && /not trusted/.test(entry.message)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent custom tools are registered, activated, and wrap string results", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-custom-tool-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "custom"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "custom", "agent.ts"), `
			export default {
				name: "custom", description: "custom", default: true, tools: [],
				customTools: {
					ping: { description: "Return a pong", execute: async (args) => "pong:" + args.value }
				}
			};
		`);
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["ping", "session_plan"]);
		const result = await runtime.tools.get("ping").execute("ping-1", { value: "ok" }, undefined, undefined, runtime.ctx);
		assert.deepEqual(result, { content: [{ type: "text", text: "pong:ok" }], details: {} });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parent prompts name allowed subagents and their runtime settings", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegation-prompt-"));
	try {
		await makeAgent(root, "lead", 'default: true, subagents: [{ name: "worker", model: "test/worker", timeoutSeconds: 90 }]');
		await makeAgent(root, "worker");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const result = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(result.systemPrompt, /allowed subagents/);
		assert.match(result.systemPrompt, /worker: worker \(model test\/worker, 90s deadline, fresh replyable task threads\)/);
		assert.match(result.systemPrompt, /independent delegate calls together/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/agent none restores the toolset captured before activation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-clear-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("none", runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, [["read", "session_plan"], ["read", "bash", "session_plan"]]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: null } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("startup shows a concise project summary and capability-rich footer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-orientation-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, { mode: "tui" });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.ok(runtime.notifications.some((entry) => entry.message.includes("1 project + 0 global agents · alpha active")));
		assert.match(runtime.statuses.at(-1) ?? "", /agent:alpha/);
		assert.match(runtime.statuses.at(-1) ?? "", /· 2 tools/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio applies a live session prompt draft without rewriting agent.ts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-live-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const sourcePath = path.join(root, ".pi-agents", "alpha", "agent.ts");
		const sourceBefore = await readFile(sourcePath, "utf8");
		const runtime = boot(root, {
			selectAnswers: ["Edit prompt (empty)", "Apply as session draft"],
			editorAnswers: ["You are an experimental browser verifier."],
			customActions: [
				(component, _done) => component.handleInput("\x1bOS"),
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /experimental browser verifier/);
		assert.ok(runtime.entries.some((entry) => entry.customType === "pi-agents-studio-state"));
		assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("session startup restores Agent Studio tool and prompt drafts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-restore-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, {
			branchEntries: [{
				type: "custom",
				customType: "pi-agents-studio-state",
				data: { name: "alpha", override: { tools: ["bash"], mcp: [], systemPrompt: "Restored draft prompt" } },
			}],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["bash", "session_plan"]);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Restored draft prompt/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio creates an agent from the empty dashboard", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-empty-create-"));
	try {
		const runtime = boot(root, {
			selectAnswers: ["Project (commit with this repository)", "Create manually", "Purple (#bf5af2)", "Back without applying"],
			inputAnswers: ["new-agent"],
			editorAnswers: ["Experiments with project tools", "Use the available tools carefully."],
			customActions: [
				(component, _done) => component.handleInput("\x1b[15~"),
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const dir = path.join(root, ".pi-agents", "new-agent");
		const created = (await discoverAgents(root)).agents.find(agent => agent.name === "new-agent");
		assert.equal(created?.description, "Experiments with project tools");
		assert.equal(created?.color, "#bf5af2");
		assert.equal(await readFile(path.join(dir, "prompt.md"), "utf8"), "Use the available tools carefully.");
		await assert.rejects(readFile(path.join(dir, "agent.json")), { code: "ENOENT" });
		assert.ok(runtime.notifications.some((entry) => /Created agent "new-agent"/.test(entry.message)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creation rejects undiscoverable names before writes in both scopes and discovers permitted names", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-create-names-"));
	const previousHome = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
		const project = path.join(root, "project");
		await mkdir(project);
		for (const scope of ["global", "project"] as const) {
			for (const name of [".hidden", "node_modules", ".", "..", "../bad", "bad/name", "", "  "]) {
				assert.throws(() => saveDeclarativeAgent(project, scope, { name, description: "Invalid" }), /agent name/);
				assert.equal(existsSync(path.join(project, ".pi-agents")), false);
				assert.equal(existsSync(process.env.PI_CODING_AGENT_DIR), false);
			}
		}
		const names = ["developer", "browser-verifier", "agent.v2", "_helper", "123", "node_modules-helper"];
		for (const scope of ["global", "project"] as const) {
			for (const name of names) saveDeclarativeAgent(project, scope, { name: ` ${name} `, description: scope });
			const found = (await discoverAgents(project)).agents;
			assert.deepEqual(found.map(agent => agent.name).sort(), [...names].sort());
			assert.ok(found.every(agent => agent.source === scope && agent.description === scope));
		}
		assert.ok((await discoverAgents(project, { includeProject: false })).agents.every(agent => agent.source === "global"));
	} finally {
		if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousHome;
		await rm(root, { recursive: true, force: true });
	}
});

test("manual and reviewed AI creation reject hidden/reserved names early without stray directories", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-create-invalid-ui-"));
	const previousHome = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
		for (const scope of ["Project (commit with this repository)", "Global (all projects)"]) {
			for (const method of ["Create manually", "Describe with AI"]) {
				for (const name of [".hidden", "node_modules"]) {
					const generated = JSON.stringify({ name, description: "Invalid", systemPrompt: "Do not save" });
					const runtime = boot(root, {
						mode: "tui", selectAnswers: [scope, method],
						inputAnswers: [method === "Create manually" ? name : "Create an agent"],
						editorAnswers: [generated, undefined],
						customActions: [component => component.handleInput("\x1b[15~")],
					});
					if (method === "Create manually") runtime.ctx.ui.editor = async () => { assert.fail("invalid name must be rejected before description/prompt editing"); };
					else enableStudioAI(runtime, generated);
					await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
					await runtime.commands.get("agent").handler("", runtime.ctx);
					assert.ok(runtime.notifications.some(entry => entry.level === "warning" && /excluded from discovery/.test(entry.message)));
					assert.ok(!runtime.notifications.some(entry => /Created agent/.test(entry.message)));
					assert.equal(existsSync(path.join(root, ".pi-agents")), false);
					assert.equal(existsSync(path.join(root, "home", "pi-agents")), false);
				}
			}
		}
	} finally {
		if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousHome;
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio creates and discovers warning-free agent.ts and prompt.md files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-create-"));
	try {
		const description = 'Checks `browser` behavior: "quoted" and Unicode ✓\nwithout generating TypeScript errors';
		const prompt = "Verify ${the running application} with `care` and \\\\ paths.";
		const filePath = saveDeclarativeAgent(root, "project", {
			name: "browser-verifier",
			description,
			tools: ["read"],
			mcp: ["playwright"],
			systemPrompt: prompt,
		});
		assert.match(filePath, /browser-verifier\/agent\.ts$/);
		assert.equal(await readFile(path.join(path.dirname(filePath), "prompt.md"), "utf8"), prompt);
		await assert.rejects(readFile(path.join(path.dirname(filePath), "agent.json")), { code: "ENOENT" });
		const program = ts.createProgram([filePath], {
			target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noEmit: true, skipLibCheck: true,
		});
		assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
		const discovered = await discoverAgents(root);
		const agent = discovered.agents.find((candidate) => candidate.name === "browser-verifier");
		assert.equal(agent?.description, description);
		assert.deepEqual(agent?.tools, ["read"]);
		assert.deepEqual(agent?.mcp, ["playwright"]);
		assert.equal(agent?.systemPrompt, prompt);
		await assert.rejects(async () => saveDeclarativeAgent(root, "project", {
			name: "browser-verifier", description: "duplicate",
		}), /already exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source saves isolate flat TS/JS/MJS prompts and preserve folder and overlaid source paths", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-prompt-isolation-"));
	try {
		const dir = path.join(root, ".pi-agents");
		await mkdir(dir);
		await writeFile(path.join(dir, "prompt.md"), "Unrelated prompt");
		for (const ext of ["ts", "js", "mjs"]) {
			for (const name of [`a-${ext}`, `b-${ext}`]) {
				await writeFile(path.join(dir, `${name}.${ext}`), `export default { name: "${name}", description: "flat", systemPrompt: "old" };`);
			}
		}
		await makeAgent(root, "folder", 'systemPromptFile: "./custom.md",');
		await writeFile(path.join(dir, "folder", "custom.md"), "Source prompt");
		saveAgentOverride(root, "project", "folder", { systemPrompt: "Overlay prompt" });
		const before = (await discoverAgents(root)).agents.filter(agent => agent.source === "project");
		for (const agent of before) saveAgentSource(agent, { systemPrompt: `Saved ${agent.name}` });
		// Repeat from rediscovery: existing paths must not allocate new files.
		const after = (await discoverAgents(root)).agents.filter(agent => agent.source === "project");
		for (const agent of after) {
			assert.ok(agent.sourceSystemPromptPath, `missing prompt path for ${agent.name}`);
			assert.equal(await readFile(agent.sourceSystemPromptPath!, "utf8"), `Saved ${agent.name}`);
			saveAgentSource(agent, { systemPrompt: `Again ${agent.name}` });
			assert.equal(await readFile(agent.sourceSystemPromptPath!, "utf8"), `Again ${agent.name}`);
			if (agent.name !== "folder") assert.equal(agent.systemPrompt, `Saved ${agent.name}`);
		}
		assert.equal(new Set(after.map(agent => agent.sourceSystemPromptPath)).size, 7);
		assert.equal(after.find(agent => agent.name === "folder")?.sourceSystemPromptPath, path.join(dir, "folder", "custom.md"));
		assert.equal(await readFile(path.join(dir, "prompt.md"), "utf8"), "Unrelated prompt");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("MJS rediscovery and application observe successive saves with relative imports and async factories", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mjs-reload-"));
	try {
		const dir = path.join(root, ".pi-agents");
		await mkdir(path.join(dir, "lib"), { recursive: true });
		await writeFile(path.join(dir, "lib", "values.mjs"), 'export const description = "imported description"; export const tools = ["read"];');
		const filePath = path.join(dir, "editable.mjs");
		await writeFile(filePath, `import { description, tools } from "./lib/values.mjs";
import { fileURLToPath } from "node:url";
export default { name: "editable", description, tools, systemPrompt: fileURLToPath(import.meta.url) };
`);
		const find = async (name: string) => (await discoverAgents(root)).agents.find(agent => agent.name === name)!;
		let agent = await find("editable");
		assert.equal(agent.description, "imported description");
		assert.equal(agent.systemPrompt, filePath);
		for (const revision of ["one", "two", "one"]) {
			saveAgentSource(agent, { description: revision, systemPrompt: `${revision} prompt` });
			agent = await find("editable");
			assert.equal(agent.description, revision);
			assert.equal(agent.systemPrompt, `${revision} prompt`);
			assert.deepEqual(agent.tools, ["read"]);
			assert.match(await readFile(filePath, "utf8"), /import.*\.\/lib\/values\.mjs/);
			const runtime = boot(root, { flag: "editable" });
			await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
			const applied = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
			assert.ok(applied.systemPrompt.startsWith("base\n\n"));
			assert.ok(applied.systemPrompt.endsWith(`\n\n${revision} prompt`));
		}
		const factoryPath = path.join(dir, "factory.mjs");
		for (const revision of ["one", "two"]) {
			await writeFile(factoryPath, `import { description, tools } from "./lib/values.mjs";
const suffix = await Promise.resolve(${JSON.stringify(revision)});
export default async () => ({ name: "factory", description: description + suffix, tools });
`);
			const factory = await find("factory");
			assert.equal(factory.description, `imported description${revision}`);
			assert.deepEqual(factory.tools, ["read"]);
			const before = await readFile(factoryPath, "utf8");
			assert.throws(() => saveAgentSource(factory, { description: "unsafe rewrite" }), /not a static object/);
			assert.equal(await readFile(factoryPath, "utf8"), before);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("source save failures leave existing prompts and definitions intact", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-prompt-failure-"));
	try {
		await makeAgent(root, "alpha", 'systemPromptFile: "./custom.md",');
		const dir = path.join(root, ".pi-agents", "alpha");
		const promptPath = path.join(dir, "custom.md");
		await writeFile(promptPath, "Original");
		const agent = (await discoverAgents(root)).agents.find(agent => agent.name === "alpha")!;
		const original = await readFile(agent.filePath, "utf8");
		// A directory at the source staging path forces a write failure after the prompt write.
		await mkdir(`${agent.filePath}.tmp-${process.pid}`);
		assert.throws(() => saveAgentSource(agent, { systemPrompt: "Replacement" }));
		assert.equal(await readFile(promptPath, "utf8"), "Original");
		assert.equal(await readFile(agent.filePath, "utf8"), original);
		await writeFile(agent.filePath, 'export default (() => ({ name: "alpha", description: "dynamic" }))();');
		assert.throws(() => saveAgentSource(agent, { systemPrompt: "Replacement" }), /not a static object/);
		assert.equal(await readFile(promptPath, "utf8"), "Original");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("project source saves preserve global overlays and other projects while applying the saved draft", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-source-scopes-"));
	const previousHome = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
		const globalDir = path.join(process.env.PI_CODING_AGENT_DIR, "pi-agents");
		await mkdir(path.join(globalDir, "alpha"), { recursive: true });
		const globalSource = path.join(globalDir, "alpha", "agent.ts");
		await writeFile(globalSource, 'export default { name: "alpha", description: "global source", tools: ["read"], systemPrompt: "global source prompt" };');
		const a = path.join(root, "a"), b = path.join(root, "b");
		await makeAgent(a, "alpha", 'systemPrompt: "project source prompt",');
		await mkdir(b);
		saveAgentOverride(a, "global", "alpha", { description: "global overlay", systemPrompt: "global overlay prompt", color: "warning" });
		saveAgentOverride(a, "project", "alpha", { description: "old project overlay" });
		saveAgentOverride(b, "project", "alpha", { color: "success" });
		const globalConfig = path.join(globalDir, "config.json");
		const globalBefore = await readFile(globalConfig, "utf8");
		const sourceBefore = await readFile(globalSource, "utf8");
		const bBefore = await readFile(path.join(b, ".pi-agents", "config.json"), "utf8");
		for (const revision of ["first", "second"]) {
			const runtime = boot(a, {
				flag: "alpha",
				selectAnswers: ["Edit description", "Edit prompt (1 lines)", "Save agent.ts (project)"],
				editorAnswers: [`${revision} draft`, `${revision} prompt`],
				customActions: [component => component.handleInput("\x1bOS")],
			});
			await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
			await runtime.commands.get("agent").handler("", runtime.ctx);
			const saved = (await discoverAgents(a)).agents.find(agent => agent.name === "alpha")!;
			assert.equal(saved.description, `${revision} draft`);
			assert.equal(saved.systemPrompt, `${revision} prompt`);
			assert.equal(saved.source, "project");
			assert.match(await readFile(saved.filePath, "utf8"), new RegExp(`${revision} draft`));
			assert.equal(await readFile(saved.sourceSystemPromptPath!, "utf8"), `${revision} prompt`);
			const applied = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
			assert.ok(applied.systemPrompt.startsWith("base\n\n"));
			assert.ok(applied.systemPrompt.endsWith(`\n\n${revision} prompt`));
			assert.ok(runtime.notifications.some(entry => entry.level === "info" && /saved to.*preserve global overrides/.test(entry.message)));
			assert.equal(await readFile(globalConfig, "utf8"), globalBefore);
			assert.equal(await readFile(globalSource, "utf8"), sourceBefore);
			assert.equal(await readFile(path.join(b, ".pi-agents", "config.json"), "utf8"), bBefore);
			const other = (await discoverAgents(b)).agents.find(agent => agent.name === "alpha")!;
			assert.equal(other.source, "global");
			assert.equal(other.description, "global overlay");
			assert.equal(other.systemPrompt, "global overlay prompt");
			assert.equal(other.color, "success");
		}
	} finally {
		if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousHome;
		await rm(root, { recursive: true, force: true });
	}
});

test("direct legacy JSON saves migrate metadata and prompt to TypeScript", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-json-prompt-"));
	try {
		const dir = path.join(root, ".pi-agents", "alpha");
		await mkdir(dir, { recursive: true });
		const jsonPath = path.join(dir, "agent.json");
		const promptPath = path.join(dir, "prompt.md");
		await writeFile(promptPath, "Source prompt\n");
		await writeFile(jsonPath, JSON.stringify({
			name: "alpha", description: "source", lifecycle: "legacy-value", whenToUse: "Keep this metadata", systemPromptFile: "./prompt.md",
		}, null, "\t"));
		const agent = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		const filePath = saveAgentSource(agent, { description: "updated", color: null, mcp: [], systemPrompt: "Updated prompt\n" });
		assert.match(filePath, /agent\.ts$/);
		const source = await readFile(filePath, "utf8");
		assert.match(source, /"description": "updated"/);
		assert.match(source, /"lifecycle": "legacy-value"/);
		assert.match(source, /"whenToUse": "Keep this metadata"/);
		assert.match(source, /"systemPromptFile": "\.\/prompt\.md"/);
		assert.doesNotMatch(source, /"systemPrompt":/);
		assert.equal(await readFile(promptPath, "utf8"), "Updated prompt\n");
		await assert.rejects(readFile(jsonPath), { code: "ENOENT" });
		assert.equal((await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")?.description, "updated");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct TypeScript saves update the static agent object and its prompt file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ts-source-"));
	try {
		const dir = path.join(root, ".pi-agents", "alpha");
		await mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "agent.ts");
		const promptPath = path.join(dir, "prompt.md");
		await writeFile(promptPath, "Source prompt\n");
		await writeFile(filePath, `const cfg = {
	name: "alpha",
	// This executable field and comment must survive Studio saves.
	description: "source",
	lifecycle: "legacy-value",
	color: "#ffffff",
	tools: ["read"],
	mcp: ["pen.dev"],
	mcpServers: { "pen.dev": { command: "stale-pen-server" } },
	customTools: { ping: { description: "Ping", execute: () => "pong" } },
	systemPromptFile: "./prompt.md",
};
export default cfg;
`);
		const agent = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		saveAgentSource(agent, {
			description: "updated", color: null, tools: ["read", "grep"], mcp: ["designhub"],
			subagents: [{ name: "beta", model: "openai-codex/gpt-5.3-codex-spark:high" }], systemPrompt: "Updated prompt\n",
		}, { designhub: { url: "http://localhost:5101/mcp", headers: { Authorization: "Bearer ${DESIGNHUB_TOKEN}" } } });
		const source = await readFile(filePath, "utf8");
		assert.match(source, /description: "updated"/);
		assert.match(source, /lifecycle: "legacy-value"/);
		assert.doesNotMatch(source, /color:/);
		assert.match(source, /tools: \["read","grep"\]/);
		assert.match(source, /mcp: \["designhub"\]/);
		assert.match(source, /mcpServers: \{"designhub":\{"url":"http:\/\/localhost:5101\/mcp"/);
		assert.doesNotMatch(source, /stale-pen-server/);
		assert.match(source, /subagents: \[\{ name: "beta", model: "openai-codex\/gpt-5.3-codex-spark:high" \}\]/);
		assert.match(source, /customTools: \{ ping:/);
		assert.match(source, /This executable field and comment must survive/);
		assert.match(source, /systemPromptFile: "\.\/prompt\.md"/);
		assert.equal(await readFile(promptPath, "utf8"), "Updated prompt\n");
		const updated = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		assert.equal(updated.description, "updated");
		assert.equal("lifecycle" in updated, false);
		assert.deepEqual(updated.tools, ["read", "grep"]);
		assert.deepEqual(updated.mcp, ["designhub"]);
		assert.equal(updated.mcpServers?.designhub.url, "http://localhost:5101/mcp");
		assert.equal(updated.mcpServers?.["pen.dev"], undefined);
		assert.equal(updated.subagents?.[0]?.model, "openai-codex/gpt-5.3-codex-spark:high");
		assert.equal("lifecycle" in updated.subagents![0], false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio migrates JSON-backed agent edits to agent.ts and removes saved overlays", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-json-save-"));
	try {
		const dir = path.join(root, ".pi-agents", "alpha");
		await mkdir(dir, { recursive: true });
		const jsonPath = path.join(dir, "agent.json");
		await writeFile(jsonPath, JSON.stringify({
			name: "alpha", description: "source description", tools: ["read"], mcp: [], systemPrompt: "Source prompt",
		}));
		saveDeclarativeAgent(root, "project", { name: "beta", description: "beta", tools: ["read"] });
		saveAgentOverride(root, "project", "alpha", { description: "saved description" });
		const runtime = boot(root, {
			flag: "alpha",
			selectAnswers: [
				"Manage subagents (0)", "Add subagent", "beta · beta",
				"1 · beta · default model · no timeout", "Set model (default model)", "Custom… (type a model ID)", "Done",
				"Save agent.ts (project)",
			],
			inputAnswers: ["openai-codex/gpt-5.3-codex-spark:high"],
			customActions: [component => component.handleInput("\x1bOS")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);

		const filePath = path.join(dir, "agent.ts");
		const source = await readFile(filePath, "utf8");
		assert.match(source, /"description": "saved description"/);
		assert.match(source, /"subagents": \[/);
		assert.equal(await readFile(path.join(dir, "prompt.md"), "utf8"), "Source prompt");
		await assert.rejects(readFile(jsonPath), { code: "ENOENT" });
		const config = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(config.agentOverrides, undefined);
		const alpha = (await discoverAgents(root)).agents.find(agent => agent.name === "alpha");
		assert.equal(alpha?.subagents?.[0]?.name, "beta");
		assert.equal(alpha?.subagents?.[0]?.model, "openai-codex/gpt-5.3-codex-spark:high");
		assert.equal(alpha?.savedOverrideSources, undefined);
		assert.ok(runtime.notifications.some(entry => entry.message.includes(filePath)));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("dynamic TypeScript definitions keep explicit config override saves", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-dynamic-ts-"));
	try {
		const dir = path.join(root, ".pi-agents", "dynamic");
		await mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "agent.ts");
		await writeFile(filePath, `export default () => ({ name: "dynamic", description: "source", tools: ["read"] });\n`);
		const runtime = boot(root, {
			flag: "dynamic",
			selectAnswers: ["Edit description", "Save project override (.pi-agents/config.json)"],
			editorAnswers: ["overridden"],
			customActions: [component => component.handleInput("\x1bOS")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.match(await readFile(filePath, "utf8"), /description: "source"/);
		const config = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(config.agentOverrides.dynamic.description, "overridden");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("project Studio overrides preserve config and expose curated MCP recipes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-save-"));
	try {
		await makeAgent(root, "alpha", "default: true, systemPrompt: \"source prompt\"");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			defaultAgent: "alpha",
			mcpServers: { custom: { command: "custom-mcp" } },
		}));
		const configPath = saveAgentOverride(root, "project", "alpha", {
			tools: ["read", "grep"],
			mcp: ["playwright"],
			systemPrompt: "saved Studio prompt",
		});
		const raw = JSON.parse(await readFile(configPath, "utf8"));
		assert.equal(raw.defaultAgent, "alpha");
		assert.equal(raw.mcpServers.custom.command, "custom-mcp");
		assert.deepEqual(raw.agentOverrides.alpha.mcp, ["playwright"]);

		const discovered = await discoverAgents(root);
		const alpha = discovered.agents.find((agent) => agent.name === "alpha");
		assert.deepEqual(alpha?.tools, ["read", "grep"]);
		assert.deepEqual(alpha?.mcp, ["playwright"]);
		assert.equal(alpha?.systemPrompt, "saved Studio prompt");
		assert.equal(alpha?.systemPromptPath, undefined);
		assert.deepEqual(alpha?.savedOverrideSources, ["project"]);
		assert.equal(discovered.config.mcpServerSources?.playwright, "builtin");
		assert.deepEqual(discovered.config.mcpServers?.playwright.args, ["-y", "@playwright/mcp@0.0.80", "--headless"]);
		assert.equal(discovered.config.mcpServers?.["pen.dev"].command, "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64");
		assert.deepEqual(discovered.config.mcpServers?.dochub, {
			url: "https://dochub.phoenixchumphon.com/mcp",
			headers: { Authorization: "Bearer ${DOCHUB_TOKEN}" },
		});
		assert.deepEqual(discovered.config.mcpServers?.designhub, {
			url: "https://designhub.phoenixchumphon.com/mcp",
			headers: { Authorization: "Bearer ${DESIGNHUB_TOKEN}" },
		});
		assert.deepEqual(discovered.config.mcpServers?.taskhub, {
			url: "https://taskhub.phoenixchumphon.com/mcp",
			headers: { Authorization: "Bearer ${TASKHUB_TOKEN}" },
		});
		assert.equal(discovered.config.mcpServerSources?.["pen.dev"], "builtin");
		assert.equal(discovered.config.mcpServerSources?.dochub, "builtin");
		assert.equal(discovered.config.mcpServerSources?.designhub, "builtin");
		assert.equal(discovered.config.mcpServerSources?.taskhub, "builtin");
		assert.equal(discovered.config.mcpServerSources?.custom, "project");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio selectors show highlighted tool and MCP details in a right pane", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-tool-details-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		let toolDetails = "";
		let mcpDetails = "";
		const runtime = boot(root, {
			selectAnswers: ["Choose tools (1)", "Manage MCP servers (0)", "Back without applying"],
			customActions: [
				(component, _done) => component.handleInput("\x1bOS"),
				(component, _done) => {
					toolDetails = component.render(100).join("\n");
					component.handleInput("\u001b[B");
					toolDetails += `\n${component.render(100).join("\n")}`;
					component.handleInput("\u001b");
				},
				(component, _done) => {
					mcpDetails = component.render(110).join("\n");
					component.handleInput("\u001b");
				},
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.match(toolDetails, /Read file contents from disk\./);
		assert.match(toolDetails, /Execute a shell command\./);
		assert.match(toolDetails, /Choices \(1\/2\)/);
		assert.doesNotMatch(toolDetails, /powershell/i);
		assert.match(mcpDetails, /designhub/);
		assert.match(mcpDetails, /taskhub/);
		assert.match(mcpDetails, /project design context through DesignHub/);
		assert.match(mcpDetails, /endpoint URL can be/);
		assert.match(mcpDetails, /changed in Studio/);
		assert.match(mcpDetails, /https:\/\/designhub\.phoenixchumphon\.com\/mcp/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio edits and persists an HTTP MCP endpoint URL", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-mcp-url-"));
	try {
		await makeAgent(root, "alpha", 'default: true, mcp: ["designhub"]');
		let editedDetails = "";
		const endpoint = "https://designhub.example.com/custom-mcp";
		const runtime = boot(root, {
			selectAnswers: ["Manage MCP servers (1)", "Save agent.ts (project)"],
			inputAnswers: [endpoint],
			customActions: [
				component => component.handleInput("\x1bOS"),
				component => {
					component.handleInput("\r");
					component.handleInput("\x1b[B");
					component.handleInput("\x1b[B");
					component.handleInput("\x1b[B");
					assert.match(component.render(140).join("\n"), /Edit endpoint URL/);
					component.handleInput("\r");
				},
				component => {
					editedDetails = component.render(140).join("\n");
					component.handleInput("\x1b");
					component.handleInput("\x1b");
				},
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.match(editedDetails, /https:\/\/designhub\.example\.com\/custom-mcp/);
		assert.match(editedDetails, /agent-local draft/);
		const saved = (await discoverAgents(root)).agents.find(agent => agent.name === "alpha");
		assert.equal(saved?.mcpServers?.designhub.url, endpoint);
		assert.equal(saved?.mcpServers?.designhub.headers?.Authorization, "Bearer ${DESIGNHUB_TOKEN}");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent picker renders an inspectable dashboard with metadata, MCP, tools, and prompt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-dashboard-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await mkdir(path.join(root, ".pi-agents", "beta"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "beta", "prompt.md"), "You are the exact beta prompt.\nSecond line.");
		await writeFile(path.join(root, ".pi-agents", "beta", "agent.ts"), `export default {
			name: "beta", description: "Browser specialist", whenToUse: "web checks",
			capabilities: ["navigation", "screenshots"], limitations: ["read-only"],
			tools: ["read", "missing_tool"], mcp: ["browser"], systemPromptFile: "./prompt.md"
		};`);
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			mcpServers: { browser: { command: "fake-browser-mcp" } },
		}));
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const dashboard = runtime.getCustomComponent();
		assert.ok(dashboard);
		const initialHeight = dashboard.render(120).length;
		dashboard.handleInput("\u001b[B"); // beta
		const overviewLines = dashboard.render(120);
		assert.equal(overviewLines.length, initialHeight);
		assert.match(overviewLines.join("\n"), /Use when: web checks/);
		dashboard.handleInput("\t"); // tools
		const toolsView = dashboard.render(120).join("\n");
		assert.match(toolsView, /Declared: read, missing_tool/);
		assert.match(toolsView, /Unknown: missing_tool/);
		dashboard.handleInput("\t"); // MCP
		assert.match(dashboard.render(120).join("\n"), /browser · stdio · project · disconnected/);
		dashboard.handleInput("\t"); // prompt
		const promptView = dashboard.render(120).join("\n");
		assert.match(promptView, /prompt\.md/);
		assert.match(promptView, /You are the exact beta prompt/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
