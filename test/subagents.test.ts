import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../agents.ts";
import extension, { matchesDeniedPath } from "../index.ts";
import { MAX_SUBAGENT_DEPTH, runSubagent } from "../subagents.ts";

const noAbort = new AbortController().signal;

test("denied paths: matches extensions, root files, and absolute paths", () => {
	const cwd = "/tmp/project";
	assert.equal(matchesDeniedPath(".env", cwd, ["**/.env"]), true);
	assert.equal(matchesDeniedPath("nested/.env", cwd, ["**/.env"]), true);
	assert.equal(matchesDeniedPath("docs/README.md", cwd, ["**/*.md"]), true);
	assert.equal(matchesDeniedPath("README.md", cwd, ["**/*.md"]), true);
	assert.equal(matchesDeniedPath("src/index.ts", cwd, ["**/*.md"]), false);
	assert.equal(matchesDeniedPath("/tmp/project/private.txt", cwd, ["/tmp/project/private.txt"]), true);
	assert.equal(matchesDeniedPath("private.txt", cwd, ["/tmp/project/private.txt"]), true);
});

test("end to end: active agent blocks denied file-tool calls", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-policy-e2e-"));
	try {
		await mkdir(path.join(root, ".pi-agents"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "safe.ts"), `
			export default { name: "safe", description: "test", tools: ["read", "bash"], deniedPaths: ["**/.env", "**/*.md"] };
		`);
		const handlers = new Map<string, (event: any, ctx?: any) => any>();
		const registered: any[] = [];
		const pi: any = {
			on: (name: string, handler: any) => handlers.set(name, handler),
			registerTool: (tool: any) => registered.push(tool),
			registerFlag: () => {}, registerShortcut: () => {}, registerCommand: () => {},
			getFlag: () => undefined, appendEntry: () => {},
			getAllTools: () => [{ name: "read" }, { name: "bash" }, ...registered],
			getActiveTools: () => ["read", "bash"], setActiveTools: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		};
		extension(pi);
		const theme = { fg: (role: string, text: string) => text, getColorMode: () => "truecolor" };
		const ctx: any = { cwd: root, sessionManager: { getSessionFile: () => undefined }, ui: { theme, setStatus: () => {}, notify: () => {} } };
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const call = handlers.get("tool_call")!;
		assert.equal(call({ toolName: "read", input: { path: ".env" } })?.block, true);
		assert.equal(call({ toolName: "read", input: { path: "docs/readme.md" } })?.block, true);
		assert.equal(call({ toolName: "read", input: { path: "src/index.ts" } }), undefined);
		assert.equal(call({ toolName: "bash", input: { command: "cat .env" } }), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("smoke: discovers an agent hierarchy", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-smoke-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Coordinator", subagents: ["worker"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Specialist" };
		`);
		const result = await discoverAgents(root);
		const lead = result.agents.find((agent) => agent.name === "lead");
		assert.deepEqual(lead?.subagents, ["worker"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("end to end: delegate launches an isolated child with the target agent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-e2e-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			const args = process.argv.slice(2);
			if (args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--no-session" || args[3] !== "--agent" || args[4] !== "worker") process.exit(2);
			let input = "";
			process.stdin.on("data", chunk => {
				input += chunk;
				if (!input.includes("\\n")) return;
				const prompt = JSON.parse(input.split("\\n")[0]).message;
				process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
				process.stdout.write(JSON.stringify({type:"tool_execution_start", toolName:"read", args:{}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"worker-result:" + prompt}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"message_end", message:{provider:"test", model:"test-model", content:[{type:"text", text:"worker-result:" + prompt}], usage:{input:10, output:5, cacheRead:2, cacheWrite:1, cost:{total:0.01}}}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				process.exit(0);
			});
		`);
		await chmod(fakePi, 0o755);
		const progress: string[] = [];
		const result = await runSubagent("worker", "inspect files", root, noAbort, {
			executable: fakePi,
			onProgress: (event) => progress.push(event.type),
		});
		assert.ok(progress.includes("tool-start"));
		assert.ok(progress.includes("text"));
		assert.ok(progress.includes("stats"));
		assert.equal(result, "worker-result:inspect files");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("branch option: subagent runs on a freshly created git branch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-branch-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await writeFile(path.join(root, "file.txt"), "hello\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
		await writeFile(fakePi, `#!/usr/bin/env node
			const { execFileSync } = await import("node:child_process");
			const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
			const text = "subagent branch: " + branch;
			process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
			process.exit(0);
		`);
		await chmod(fakePi, 0o755);
		const result = await runSubagent("worker", "task", root, noAbort, { executable: fakePi, branch: "feature/iso" });
		assert.equal(result, "subagent branch: feature/iso");
		// The branch (and its checkout) persists after the subagent finished.
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "feature/iso");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("branch option: rejects when the branch already exists", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-branch-exists-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await writeFile(path.join(root, "file.txt"), "hello\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
		execFileSync("git", ["checkout", "-q", "-b", "feature/exists"], { cwd: root });
		await assert.rejects(
			runSubagent("worker", "task", root, noAbort, { executable: process.execPath, branch: "feature/exists" }),
			/already exists/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("branch option: fails cleanly outside a git repository", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-branch-nogit-"));
	try {
		await assert.rejects(
			runSubagent("worker", "task", root, noAbort, { executable: process.execPath, branch: "feature/x" }),
			/cannot create branch "feature\/x" for subagent: .*not a git repository/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Boot the extension with a mock pi API rooted at `root`; returns the delegate tool registration. */
function bootExtension(root: string) {
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	const registered: any[] = [];
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => registered.push(tool),
		registerFlag: () => {}, registerShortcut: () => {}, registerCommand: () => {},
		getFlag: () => undefined, appendEntry: () => {},
		getAllTools: () => [{ name: "read" }, { name: "bash" }, ...registered],
		getActiveTools: () => ["read", "bash"], setActiveTools: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	extension(pi);
	const theme = { fg: (role: string, text: string) => text, getColorMode: () => "truecolor" };
	const ctx: any = { cwd: root, sessionManager: { getSessionFile: () => undefined }, ui: { theme, setStatus: () => {}, notify: () => {} } };
	return { handlers, registered, ctx };
}

test("end to end: delegate with branch runs the subagent on a new git branch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-branch-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	try {
		// Git repo with an initial commit; lead is the default agent.
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await writeFile(path.join(root, "base.txt"), "base\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
		const initialBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", tools: ["read", "bash"], default: true, subagents: ["dev"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "dev"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "dev", "agent.ts"), `
			export default { name: "dev", description: "Dev", tools: ["read", "bash"] };
		`);

		// Fake child pi: verifies it runs on the requested branch, then commits work there.
		await writeFile(fakePi, `#!/usr/bin/env node
			const { execFileSync } = await import("node:child_process");
			const { writeFileSync } = await import("node:fs");
			const args = process.argv.slice(2);
			if (args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--no-session" || args[3] !== "--agent" || args[4] !== "dev") process.exit(2);
			const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
			writeFileSync("work.txt", "subagent work on " + branch + "\\n");
			execFileSync("git", ["add", "work.txt"]);
			execFileSync("git", ["commit", "-q", "-m", "subagent commit on " + branch]);
			const text = "done on " + branch;
			process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: { provider: "test", model: "test-model", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
			process.exit(0);
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;

		const { handlers, registered, ctx } = bootExtension(root);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		const delegate = registered.find((t) => t.name === "delegate")!;
		const result = await delegate.execute("call-1", { agent: "dev", task: "add work", branch: "feature/e2e" }, undefined, undefined, ctx);
		const text = String(result.content[0].text);
		assert.ok(text.includes("done on feature/e2e"), text);
		// The subagent's branch is created, checked out, and still current after the delegation.
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "feature/e2e");
		// Its work is committed on the branch — and isolated from the original branch.
		assert.ok(existsSync(path.join(root, "work.txt")));
		execFileSync("git", ["checkout", "-q", initialBranch], { cwd: root });
		assert.ok(!existsSync(path.join(root, "work.txt")));
		const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: root, encoding: "utf8" });
		assert.ok(!log.includes("subagent commit on feature/e2e"), log);
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

test("end to end: delegate with an existing branch name fails with a readable tool result", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-branch-taken-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	try {
		// Repo where "feature/taken" already exists before the delegation.
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await writeFile(path.join(root, "base.txt"), "base\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
		execFileSync("git", ["checkout", "-q", "-b", "feature/taken"], { cwd: root });

		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", tools: ["read", "bash"], default: true, subagents: ["dev"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "dev"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "dev", "agent.ts"), `
			export default { name: "dev", description: "Dev", tools: ["read", "bash"] };
		`);

		// Fake child pi that drops a marker file if it is ever spawned.
		await writeFile(fakePi, `#!/usr/bin/env node
			const { writeFileSync } = await import("node:fs");
			writeFileSync("spawned.flag", "spawned\\n");
			process.exit(0);
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;

		const { handlers, registered, ctx } = bootExtension(root);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		const delegate = registered.find((t) => t.name === "delegate")!;
		const result = await delegate.execute("call-1", { agent: "dev", task: "task", branch: "feature/taken" }, undefined, undefined, ctx);
		// Resolves with an error result (does not throw) so the caller agent can react.
		const text = String(result.content[0].text);
		assert.ok(text.includes("Subagent dev failed"), text);
		assert.ok(text.includes('cannot create branch "feature/taken"'), text);
		assert.ok(text.includes("already exists"), text);
		assert.equal(result.details?.error, true);
		// The child subagent was never spawned.
		assert.ok(!existsSync(path.join(root, "spawned.flag")));
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

test("depth guard rejects recursive delegation beyond the limit", async () => {
	const previous = process.env.PI_AGENTS_SUBAGENT_DEPTH;
	process.env.PI_AGENTS_SUBAGENT_DEPTH = String(MAX_SUBAGENT_DEPTH);
	try {
		await assert.rejects(runSubagent("worker", "task", process.cwd(), noAbort, process.execPath), /maximum subagent depth/);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		else process.env.PI_AGENTS_SUBAGENT_DEPTH = previous;
	}
});
