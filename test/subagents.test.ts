import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, findMainCheckoutRoot } from "../agents.ts";
import extension, { matchesDeniedPath } from "../index.ts";
import { MAX_SUBAGENT_DEPTH, SubagentStoppedError, runSubagent, type RunningSubagentHandle } from "../subagents.ts";
import { renderDelegateCall, renderDelegateResult, showSubagentInspector } from "../ui.ts";

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
			export default { name: "lead", description: "Coordinator", subagents: ["worker", { name: "researcher", model: "test/research-model", timeoutSeconds: 45 }] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Specialist" };
		`);
		const result = await discoverAgents(root);
		const lead = result.agents.find((agent) => agent.name === "lead");
		assert.deepEqual(lead?.subagents, [
			{ name: "worker" },
			{ name: "researcher", model: "test/research-model", timeoutSeconds: 45 },
		]);
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
		let deadlineAt: number | undefined;
		let runningHandle: RunningSubagentHandle | undefined;
		const result = await runSubagent("worker", "inspect files", root, noAbort, {
			executable: fakePi,
			onHandle: (handle) => { if (handle) { runningHandle = handle; deadlineAt = handle.snapshot().deadlineAt; } },
			onProgress: (event) => progress.push(event.type),
		});
		assert.equal(deadlineAt, undefined);
		assert.ok(progress.includes("tool-start"));
		assert.ok(progress.includes("text"));
		assert.ok(progress.includes("stats"));
		assert.deepEqual(runningHandle?.snapshot().usage, {
			provider: "test", model: "test-model", input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01,
		});
		assert.equal(result, "worker-result:inspect files");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("delegated children inherit serialized Agent Studio drafts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-child-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdin.once("data", () => {
				const inherited = JSON.parse(process.env.PI_AGENTS_STUDIO_OVERRIDES || "{}");
				const text = inherited.worker?.systemPrompt || "missing";
				process.stdout.write(JSON.stringify({type:"message_end", message:{content:[{type:"text", text}]}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				process.exit(0);
			});
		`);
		await chmod(fakePi, 0o755);
		const result = await runSubagent("worker", "verify draft", root, noAbort, {
			executable: fakePi,
			runtimeAgentOverrides: { worker: { tools: ["read"], systemPrompt: "experimental child prompt" } },
		});
		assert.equal(result, "experimental child prompt");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("execution timeout stops a stalled subagent and preserves diagnostic state", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-timeout-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const progress: string[] = [];
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdin.on("data", chunk => {
				const command = JSON.parse(String(chunk).trim());
				if (command.type === "prompt") {
					process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
					process.stdout.write(JSON.stringify({type:"tool_execution_start", toolName:"bash", args:{command:"sleep forever"}}) + "\\n");
				}
				if (command.type === "abort") {
					process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				}
			});
		`);
		await chmod(fakePi, 0o755);
		await assert.rejects(
			runSubagent("worker", "stall", root, noAbort, {
				executable: fakePi,
				timeoutSeconds: 2,
				gracefulStopSeconds: 0.01,
				onProgress: (event) => progress.push(event.type),
			}),
			(error: unknown) => {
				assert.ok(error instanceof SubagentStoppedError);
				assert.equal(error.reason, "timeout");
				assert.equal(error.snapshot.currentTool, "bash");
				assert.equal(error.snapshot.stopReason, "timeout");
				assert.equal(error.snapshot.phase, "deadline exceeded");
				return true;
			},
		);
		assert.equal(progress.includes("finished"), false);
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
			id: "call-inspect", agent: "worker", task: "run tests", model: "openai-codex/gpt-5.3-codex-spark:high", startedAt: now - 10_000,
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
	const inspectorText = component.render(100).join("\n");
	assert.ok(inspectorText.includes("Tool: bash"));
	assert.ok(inspectorText.includes("openai-codex/gpt-5.3-codex-spark:high"));
	component.handleInput("x");
	component.handleInput("y");
	component.handleInput("\u001b");
	await inspector;
	assert.equal(stopped, true);
});

test("delegate renderer keeps routine results compact", () => {
	const theme: any = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const call = renderDelegateCall({ agent: "worker", task: "Implement the parser", model: "openai-codex/gpt-5.3-codex-spark:high" }, theme).render(100).join("\n");
	assert.match(call, /delegate → worker/);
	assert.match(call, /openai-codex\/gpt-5.3-codex-spark:high/);
	assert.doesNotMatch(call, /worktree/);

	const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
	const component = renderDelegateResult({
		content: [{ type: "text", text: `Result from worker:\n\n${output}` }],
		details: { agent: "worker", model: "openai-codex/gpt-5.3-codex-spark:high", status: "completed", statsLine: "stats: 1 call" },
	}, { expanded: false }, theme);
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /✓ worker completed · openai-codex\/gpt-5.3-codex-spark:high/);
	assert.match(rendered, /line 6/);
	assert.doesNotMatch(rendered, /line 7/);
	assert.match(rendered, /4 more lines/);
	assert.doesNotMatch(rendered, /Worktree/);
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

test("end to end: configured subagent timeout returns control to the parent delegate", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-timeout-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			subagents: { gracefulStopSeconds: 0.01 },
		}));
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", default: true, subagents: [{ name: "worker", model: "test/worker-model", timeoutSeconds: 1.5 }] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Worker" };
		`);
		await writeFile(fakePi, `#!/usr/bin/env node
			const args = process.argv.slice(2);
			const expected = ["--mode", "rpc", "--no-session", "--agent", "worker", "--model", "test/worker-model"];
			if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(2);
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
		assert.equal("timeoutSeconds" in delegate.parameters.properties, false);
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

test("end to end: delegate truncates oversized child output and preserves the full result", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-output-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	let fullOutputPath: string | undefined;
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", default: true, subagents: ["worker"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Worker" };
		`);
		await writeFile(fakePi, `#!/usr/bin/env node
			const text = Array.from({ length: 3000 }, (_, i) => "result-line-" + i + "-" + "x".repeat(20)).join("\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;
		const { handlers, registered, ctx } = bootExtension(root);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const delegate = registered.find((tool) => tool.name === "delegate")!;
		const result = await delegate.execute("large-output", { agent: "worker", task: "produce a report" }, undefined, undefined, ctx);
		fullOutputPath = result.details.fullOutputPath;
		assert.equal(result.details.outputTruncated, true);
		assert.match(String(result.content[0].text), /Output truncated/);
		assert.ok(fullOutputPath && existsSync(fullOutputPath));
		assert.match(readFileSync(fullOutputPath, "utf8"), /result-line-2999/);
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		if (fullOutputPath) await rm(path.dirname(fullOutputPath), { recursive: true, force: true });
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
		await assert.rejects(runSubagent("worker", "task", process.cwd(), noAbort, { executable: process.execPath }), /maximum subagent depth/);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		else process.env.PI_AGENTS_SUBAGENT_DEPTH = previous;
	}
});
