import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, findMainCheckoutRoot } from "../agents.ts";
import extension, { matchesDeniedPath, resolveSubagentTimeoutSeconds } from "../index.ts";
import { MAX_SUBAGENT_DEPTH, SubagentStoppedError, runSubagent, type RunningSubagentHandle } from "../subagents.ts";
import { showSubagentInspector } from "../ui.ts";

const noAbort = new AbortController().signal;

test("delegate timeout parameter is optional and defaults to 30 minutes", () => {
	assert.equal(resolveSubagentTimeoutSeconds(undefined, undefined), 1800);
	assert.equal(resolveSubagentTimeoutSeconds(undefined, 1800), 1800);
	assert.equal(resolveSubagentTimeoutSeconds(900, 1800), 900);
});

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
		const ctx: any = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined }, ui: { theme, setStatus: () => {}, notify: () => {} } };
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
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			subagents: { worktree: { copyEnvFiles: false, copyFiles: ["dev.pem"], setupCommand: "bun install --frozen-lockfile", retentionDays: 3 } },
		}));
		const result = await discoverAgents(root);
		const lead = result.agents.find((agent) => agent.name === "lead");
		assert.deepEqual(lead?.subagents, ["worker"]);
		assert.deepEqual(result.config.subagents?.worktree, {
			baseDir: undefined,
			copyEnvFiles: false,
			copyFiles: ["dev.pem"],
			setupCommand: "bun install --frozen-lockfile",
			retentionDays: 3,
		});
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

test("execution timeout stops a stalled subagent and preserves diagnostic state", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-timeout-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdin.on("data", chunk => {
				const command = JSON.parse(String(chunk).trim());
				if (command.type === "prompt") {
					process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
					process.stdout.write(JSON.stringify({type:"tool_execution_start", toolName:"bash", args:{command:"sleep forever"}}) + "\\n");
				}
			});
		`);
		await chmod(fakePi, 0o755);
		await assert.rejects(
			runSubagent("worker", "stall", root, noAbort, { executable: fakePi, timeoutSeconds: 2, gracefulStopSeconds: 0.01 }),
			(error: unknown) => {
				assert.ok(error instanceof SubagentStoppedError);
				assert.equal(error.reason, "timeout");
				assert.equal(error.snapshot.currentTool, "bash");
				assert.equal(error.snapshot.stopReason, "timeout");
				return true;
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("running handle can steer and manually stop a subagent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-control-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	let handle: RunningSubagentHandle | undefined;
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			let buffer = "";
			process.stdin.on("data", chunk => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\\n")) !== -1) {
					const command = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					if (command.type === "prompt") process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
					if (command.type === "steer") process.stdout.write(JSON.stringify({type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"steered"}}) + "\\n");
					if (command.type === "abort") {
						process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
					}
				}
			});
		`);
		await chmod(fakePi, 0o755);
		const running = runSubagent("worker", "wait", root, noAbort, {
			executable: fakePi,
			gracefulStopSeconds: 0.1,
			onHandle: (value) => { if (value) handle = value; },
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(handle);
		assert.equal(handle.steer("try another way"), true);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(handle.snapshot().recentEvents.some((event) => event.includes("user steering")));
		handle.stop("user");
		await assert.rejects(running, (error: unknown) => error instanceof SubagentStoppedError && error.reason === "user");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("subagent inspector renders live state and confirms a manual stop", async () => {
	let stopped = false;
	const now = Date.now();
	const handle: RunningSubagentHandle = {
		id: "call-inspect",
		snapshot: () => ({
			id: "call-inspect", agent: "worker", task: "run tests", startedAt: now - 10_000,
			lastActivityAt: now - 1_000, deadlineAt: now + 20_000, status: "running", phase: "tool execution",
			currentTool: "bash", currentToolArgs: { command: "npm test" }, partialText: "testing...", recentEvents: ["→ bash"],
		}),
		stop: (reason) => { stopped = reason === "user"; },
		steer: () => true,
	};
	let component: any;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = {
		ui: {
			theme,
			notify: () => {},
			custom: (factory: any) => new Promise<void>((resolve) => {
				component = factory({ requestRender: () => {} }, theme, {}, resolve);
			}),
		},
	};
	const inspector = showSubagentInspector(ctx, () => [handle], 5);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(component.render(100).join("\n").includes("Tool: bash"));
	component.handleInput("x");
	component.handleInput("y");
	await inspector;
	assert.equal(stopped, true);
});

test("useWorktree runs the subagent on an automatically named branch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-worktree-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	let worktreePath = "";
	let worktreeBranch = "";
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await writeFile(path.join(root, "file.txt"), "hello\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
		const initialBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
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
		const result = await runSubagent("worker", "task", root, noAbort, {
			executable: fakePi,
			useWorktree: true,
			onWorktreeCreated: (worktree) => { worktreePath = worktree.path; worktreeBranch = worktree.branch; },
		});
		assert.match(worktreeBranch, /^pi-agents\/worker\/[a-z0-9]+-[a-f0-9]{8}$/);
		assert.equal(result, `subagent branch: ${worktreeBranch}`);
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), initialBranch);
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath, encoding: "utf8" }).trim(), worktreeBranch);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree provisioning copies env files and runs a setup command", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-worktree-setup-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	let worktreePath = "";
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		await mkdir(path.join(root, "apps", "api"), { recursive: true });
		await writeFile(path.join(root, ".gitignore"), ".env*\nsecret.json\n");
		await writeFile(path.join(root, "apps", "api", "index.ts"), "export {};\n");
		await writeFile(path.join(root, "setup.mjs"), `
			const { existsSync, writeFileSync } = await import("node:fs");
			if (!existsSync(".env") || !existsSync("apps/api/.env.local") || !existsSync("secret.json")) process.exit(9);
			writeFileSync("setup.ok", "ready\\n");
		`);
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
		await writeFile(path.join(root, ".env"), "ROOT_SECRET=yes\n");
		await writeFile(path.join(root, "apps", "api", ".env.local"), "API_SECRET=yes\n");
		await writeFile(path.join(root, "secret.json"), "{\"secret\":true}\n");
		await writeFile(fakePi, `#!/usr/bin/env node
			const { existsSync } = await import("node:fs");
			const text = existsSync("setup.ok") ? "worktree ready" : "worktree missing setup";
			process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
			process.exit(0);
		`);
		await chmod(fakePi, 0o755);
		const result = await runSubagent("worker", "task", root, noAbort, {
			executable: fakePi,
			useWorktree: true,
			worktree: {
				copyFiles: ["secret.json"],
				setupCommand: `"${process.execPath}" setup.mjs`,
			},
			onWorktreeCreated: (worktree) => { worktreePath = worktree.path; },
		});
		assert.equal(result, "worktree ready");
		assert.ok(existsSync(path.join(worktreePath, ".env")));
		assert.ok(existsSync(path.join(worktreePath, "apps", "api", ".env.local")));
		assert.ok(existsSync(path.join(worktreePath, "secret.json")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("useWorktree fails cleanly outside a git repository", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-worktree-nogit-"));
	try {
		await assert.rejects(
			runSubagent("worker", "task", root, noAbort, { executable: process.execPath, useWorktree: true }),
			/cannot create worktree for branch "pi-agents\/worker\/[^"]+": .*not a git repository/,
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
	const ctx: any = { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined }, ui: { theme, setStatus: () => {}, notify: () => {} } };
	return { handlers, registered, ctx };
}

test("end to end: configured default timeout returns control to the parent delegate", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-timeout-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			subagents: { defaultTimeoutSeconds: 1.5, gracefulStopSeconds: 0.01 },
		}));
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", default: true, subagents: ["worker"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Worker" };
		`);
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdin.on("data", chunk => {
				const command = JSON.parse(String(chunk).trim());
				if (command.type === "prompt") {
					process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
					process.stdout.write(JSON.stringify({type:"tool_execution_start", toolName:"bash", args:{command:"hang"}}) + "\\n");
				}
			});
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;
		const { handlers, registered, ctx } = bootExtension(root);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const delegate = registered.find((tool) => tool.name === "delegate")!;
		const result = await delegate.execute("timeout-call", { agent: "worker", task: "hang" }, undefined, undefined, ctx);
		assert.equal(result.details.status, "timed_out");
		assert.match(String(result.content[0].text), /timed out/);
		assert.match(String(result.content[0].text), /Current operation: bash/);
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

test("end to end: delegate with useWorktree isolates the subagent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-worktree-"));
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

		// Fake child pi: verifies it runs on the generated branch, then commits work there.
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
		const result = await delegate.execute("call-1", { agent: "dev", task: "add work", useWorktree: true }, undefined, undefined, ctx);
		const text = String(result.content[0].text);
		const generatedBranch = String(result.details.branch);
		assert.match(generatedBranch, /^pi-agents\/dev\//);
		assert.ok(text.includes(`done on ${generatedBranch}`), text);
		const worktreePath = String(result.details.worktreePath);
		// The parent checkout never moves; the child worktree keeps the generated branch and files.
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), initialBranch);
		assert.ok(!existsSync(path.join(root, "work.txt")));
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath, encoding: "utf8" }).trim(), generatedBranch);
		assert.ok(existsSync(path.join(worktreePath, "work.txt")));
		const mainLog = execFileSync("git", ["log", "--oneline", "-1", initialBranch], { cwd: root, encoding: "utf8" });
		assert.ok(!mainLog.includes("subagent commit on"), mainLog);
		const branchLog = execFileSync("git", ["log", "--oneline", "-1", generatedBranch], { cwd: root, encoding: "utf8" });
		assert.ok(branchLog.includes(`subagent commit on ${generatedBranch}`), branchLog);
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree discovery falls back to the main checkout's gitignored .env files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-worktree-env-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
		// Committed: agents + config. Not committed: .env secrets (gitignored).
		await writeFile(path.join(root, ".gitignore"), ".env\n");
		await mkdir(path.join(root, ".pi-agents", "dev"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "dev", "agent.ts"), `
			export default { name: "dev", description: "Dev", mcp: ["gh"] };
		`);
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["x"] } } }));
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

		// Secrets exist only in the main checkout.
		await writeFile(path.join(root, ".pi-agents", ".env"), "PROJECT_SECRET=main\n");
		await writeFile(path.join(root, ".pi-agents", "dev", ".env"), "GH_TOKEN=main-token\n");

		const worktree = path.join(root, "wt");
		execFileSync("git", ["worktree", "add", "-q", "-b", "wt-branch", worktree], { cwd: root });
		// git reports canonical (realpath) paths; /tmp is a symlink on macOS.
		assert.equal(findMainCheckoutRoot(worktree), realpathSync(root));
		assert.equal(findMainCheckoutRoot(root), null);

		const result = await discoverAgents(worktree);
		const dev = result.agents.find((agent) => agent.name === "dev");
		assert.ok(dev, "worktree discovers committed project agents");
		assert.equal(dev?.env?.GH_TOKEN, "main-token");
		assert.equal(result.config.env?.PROJECT_SECRET, "main");
		assert.equal(result.config.mcpServers?.gh?.command, "npx");

		// A .env created in the worktree itself wins per key over the main checkout.
		await writeFile(path.join(worktree, ".pi-agents", ".env"), "PROJECT_SECRET=worktree\n");
		const result2 = await discoverAgents(worktree);
		assert.equal(result2.config.env?.PROJECT_SECRET, "worktree");
		assert.equal(result2.config.env?.GH_TOKEN, undefined); // agent-level, not project-level
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("discoverAgents includeProject:false skips project agents and config", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-untrusted-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Coordinator", default: true };
		`);
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "lead" }));
		const result = await discoverAgents(root, { includeProject: false });
		assert.equal(result.agents.find((agent) => agent.name === "lead"), undefined);
		assert.equal(result.config.defaultAgent, undefined);
		const trusted = await discoverAgents(root);
		assert.equal(trusted.agents.find((agent) => agent.name === "lead")?.description, "Coordinator");
		assert.equal(trusted.config.defaultAgent, "lead");
	} finally {
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
