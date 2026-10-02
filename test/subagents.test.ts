import "./subagent-workspace.test.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, findMainCheckoutRoot } from "../agents.ts";
import { saveCredential } from "../credentials.ts";
import extension, { matchesDeniedPath } from "../index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MAX_SUBAGENT_DEPTH, SubagentStoppedError, displaySubagentModel, runSubagent, type RunningSubagentHandle } from "../subagents.ts";
import { renderDelegateCall, renderDelegateResult, showSubagentInspector } from "../ui.ts";
import { SubagentObserver } from "../subagent-observer.ts";

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
			registerEntryRenderer: () => {},
			registerMessageRenderer: () => {},
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
			if (args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--session" || args[4] !== "--agent" || args[5] !== "worker") process.exit(2);
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

test("clean child exit requires a protocol completion boundary, not assistant text or agent_end", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-protocol-close-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const answer = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] } };
	const accepted = { type: "response", id: "prompt", command: "prompt", success: true, data: { disposition: "started" } };
	const cases = [
		{ name: "no events", events: [], error: /before agent_settled/ },
		{ name: "accepted only", events: [accepted], error: /before agent_settled/ },
		{ name: "partial answer", events: [accepted, { type: "agent_start" }, answer], error: /before agent_settled/ },
		{ name: "agent_end is not settlement", events: [answer, { type: "agent_end", messages: [answer.message], willRetry: false }], error: /before agent_settled/ },
		{ name: "pending retry", events: [{ type: "agent_start" }, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "retryable provider error" } }, { type: "agent_end", willRetry: true }, { type: "auto_retry_start", attempt: 1 }], error: /retryable provider error/ },
		{ name: "settled", events: [accepted, { type: "agent_start" }, answer, { type: "agent_end", willRetry: false }, { type: "agent_settled" }], result: "answer" },
		{ name: "handled no run", events: [{ ...accepted, data: { disposition: "handled" } }], result: "Subagent prompt was handled without starting an agent run." },
	];
	try {
		for (const scenario of cases) {
			// Deliberately omit the final LF: EOF must flush the final protocol record.
			await writeFile(fakePi, `#!/usr/bin/env node
process.stdin.once("data", () => process.stdout.write(${JSON.stringify(scenario.events.map(event => JSON.stringify(event)).join("\n"))}, () => process.exit(0)));
`);
			await chmod(fakePi, 0o755);
			let handle: RunningSubagentHandle | undefined;
			const progress: string[] = [];
			const run = runSubagent("worker", scenario.name, root, noAbort, {
				executable: fakePi, participantSessionDir: path.join(root, "sessions"),
				onHandle: value => { if (value) handle = value; },
				onProgress: event => progress.push(event.type),
			});
			if (scenario.error) {
				await assert.rejects(run, scenario.error);
				assert.equal(handle?.snapshot().status, "failed", scenario.name);
				assert.ok(!progress.includes("finished"), scenario.name);
			} else {
				assert.equal(await run, scenario.result, scenario.name);
				assert.equal(handle?.snapshot().status, "finished", scenario.name);
			}
		}
		await writeFile(fakePi, `#!/usr/bin/env node
process.stdin.on("data", chunk => {
 const command = JSON.parse(String(chunk));
 if (command.type === "abort") process.exit(0);
 else process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
});
`);
		await chmod(fakePi, 0o755);
		let handle: RunningSubagentHandle | undefined;
		await assert.rejects(runSubagent("worker", "cancel", root, noAbort, {
			executable: fakePi, participantSessionDir: path.join(root, "sessions"),
			onHandle: value => { if (value) handle = value; },
			onProgress: event => { if (event.type === "started") handle!.stop("user"); },
		}), error => error instanceof SubagentStoppedError && error.reason === "user");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("task threads run in parallel and explicit continuations reuse only their thread history", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-resumable-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const log = path.join(root, "runs.log");
	const sessionDir = path.join(root, "participants");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			import { appendFileSync } from "node:fs";
			const args = process.argv.slice(2);
			const sessionIndex = args.indexOf("--session");
			if (sessionIndex < 0 || args.includes("--no-session")) process.exit(2);
			let input = "";
			process.stdin.on("data", chunk => {
				input += chunk;
				if (!input.includes("\\n")) return;
				const task = JSON.parse(input.split("\\n")[0]).message;
				appendFileSync(${JSON.stringify(log)}, "start " + task + " " + args[sessionIndex + 1] + "\\n");
				setTimeout(() => {
					appendFileSync(${JSON.stringify(log)}, "end " + task + "\\n");
					process.stdout.write(JSON.stringify({type:"message_end", message:{content:[{type:"text", text:"reply:" + task}]}}) + "\\n");
					process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				}, 100);
			});
		`);
		await chmod(fakePi, 0o755);
		await mkdir(sessionDir, { mode: 0o755 });
		const shared = { executable: fakePi, rootSessionId: "root-one", threadId: "task-one", participantSessionDir: sessionDir };
		const replies = await Promise.all([
			runSubagent("worker", "one", root, noAbort, shared),
			runSubagent("worker", "two", root, noAbort, { ...shared, threadId: "task-two" }),
		]);
		assert.deepEqual(replies.sort(), ["reply:one", "reply:two"]);
		await runSubagent("worker", "followup", root, noAbort, shared);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		assert.match(lines[0], /^start (one|two) /);
		assert.match(lines[1], /^start (one|two) /);
		assert.match(lines[2], /^end (one|two)$/);
		assert.match(lines[3], /^end (one|two)$/);
		const firstSession = lines.find(line => line.startsWith("start one "))!.split(" ").at(-1);
		const secondSession = lines.find(line => line.startsWith("start two "))!.split(" ").at(-1);
		const replySession = lines[4].split(" ").at(-1);
		assert.notEqual(firstSession, secondSession);
		assert.equal(firstSession, replySession);
		assert.equal(statSync(sessionDir).mode & 0o777, 0o700, "existing participant storage is made private");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("nested delegation fails visibly when a task thread is already busy", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-nested-busy-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const started = path.join(root, "started");
	const previousDepth = process.env.PI_AGENTS_SUBAGENT_DEPTH;
	let topLevel: Promise<string> | undefined;
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			import { writeFileSync } from "node:fs";
			process.stdin.once("data", () => {
				writeFileSync(${JSON.stringify(started)}, "yes");
				setTimeout(() => {
					process.stdout.write(JSON.stringify({type:"message_end", message:{content:[{type:"text", text:"done"}]}}) + "\\n");
					process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				}, 200);
			});
		`);
		await chmod(fakePi, 0o755);
		delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		const options = { executable: fakePi, rootSessionId: "root", threadId: "busy-B", participantSessionDir: path.join(root, "sessions") };
		topLevel = runSubagent("B", "top-level B", root, noAbort, options);
		for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(existsSync(started));
		process.env.PI_AGENTS_SUBAGENT_DEPTH = "1";
		const nested = runSubagent("B", "nested A to B", root, noAbort, options);
		// runSubagent captures inherited depth synchronously; restore the process
		// environment before awaiting so concurrent node:test cases cannot inherit it.
		delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		await assert.rejects(nested, /already busy; use steer/);
		assert.equal(await topLevel, "done");
	} finally {
		if (previousDepth === undefined) delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		else process.env.PI_AGENTS_SUBAGENT_DEPTH = previousDepth;
		await topLevel?.catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent turns in one thread reject immediately rather than queue", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-queued-stop-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const log = path.join(root, "starts.log");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			import { appendFileSync } from "node:fs";
			process.stdin.once("data", () => {
				appendFileSync(${JSON.stringify(log)}, "start\\n");
				setTimeout(() => {
					process.stdout.write(JSON.stringify({type:"message_end", message:{content:[{type:"text", text:"done"}]}}) + "\\n");
					process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				}, 220);
			});
		`);
		await chmod(fakePi, 0o755);
		const options = { executable: fakePi, rootSessionId: "root", threadId: "worker", participantSessionDir: path.join(root, "sessions") };
		const holder = runSubagent("worker", "holder", root, noAbort, options);
		for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise(resolve => setTimeout(resolve, 10));
		await assert.rejects(runSubagent("worker", "concurrent reply", root, noAbort, options), /already busy; use steer/);
		assert.equal(await holder, "done");
		assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stale resumable locks fail without unsafe automatic recovery", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-stale-lock-"));
	const sessionDir = path.join(root, "sessions");
	const rootSessionId = "root";
	const participantIdentity = "worker";
	const key = createHash("sha256").update(`${rootSessionId}\0${participantIdentity}`).digest("hex");
	const lockPath = path.join(sessionDir, ".locks", key);
	try {
		await mkdir(lockPath, { recursive: true });
		await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 2147483647, token: "stale" }));
		await assert.rejects(runSubagent("worker", "task", root, noAbort, {
			rootSessionId, threadId: participantIdentity, participantSessionDir: sessionDir,
		}), /already busy; use steer/);
		assert.ok(existsSync(path.join(lockPath, "owner.json")), "stale ownership is preserved for manual recovery");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resumable sessions reject malformed, truncated, and broken JSONL before launch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-session-validation-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const log = path.join(root, "runs.log");
	const sessionDir = path.join(root, "sessions");
	const rootSessionId = "root";
	const participantIdentity = "worker";
	const key = createHash("sha256").update(`${rootSessionId}\0${participantIdentity}`).digest("hex");
	const sessionFile = path.join(sessionDir, `${key}.jsonl`);
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			import { appendFileSync } from "node:fs";
			appendFileSync(${JSON.stringify(log)}, "launched\\n");
			process.stdin.once("data", () => {
				process.stdout.write(JSON.stringify({type:"message_end", message:{content:[{type:"text", text:"ok"}]}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
			});
		`);
		await chmod(fakePi, 0o755);
		await mkdir(sessionDir, { recursive: true });
		const options = { executable: fakePi, rootSessionId, threadId: participantIdentity, participantSessionDir: sessionDir };
		const header = JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: new Date().toISOString(), cwd: root });
		const first = JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: Date.now() } });
		const sdkDir = path.join(root, "sdk-session");
		const sdkSession = SessionManager.create(root, sdkDir);
		sdkSession.appendMessage({ role: "assistant", content: "normal SDK record", timestamp: Date.now() } as any);
		sdkSession.appendCustomEntry("normal-sdk-record", { accepted: true });
		const sdkContent = readFileSync(sdkSession.getSessionFile()!, "utf8");
		assert.ok(sdkContent.endsWith("\n"), "installed SDK writes LF-framed records");
		await writeFile(sessionFile, sdkContent);
		assert.equal(await runSubagent("worker", "valid", root, noAbort, options), "ok");
		assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);

		for (const [name, content, pattern] of [
			["malformed", `${header}\n{not-json}\n`, /malformed JSONL at line 2/],
			["truncated", `${header}\n{\"type\":\"message\"\n`, /malformed JSONL at line 2/],
			["missing final LF", `${header}\n${first}`, /missing its final JSONL newline \(LF\)/],
			["broken", `${header}\n${JSON.stringify({ type: "message", id: "deadbeef", parentId: "missing", timestamp: new Date().toISOString(), message: { role: "user", content: "lost" } })}\n`, /broken tree history at line 2/],
			["missing context", `${header}\n${JSON.stringify({ type: "message", id: "deadbeef", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: null } })}\n`, /invalid message at line 2/],
		] as const) {
			await writeFile(sessionFile, content);
			await assert.rejects(runSubagent("worker", name, root, noAbort, options), pattern);
			assert.equal(readFileSync(sessionFile, "utf8"), content, "validation never mutates participant history");
		}
		assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "invalid history never reaches Pi's permissive loader");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("removed lifecycle metadata is not part of normalized agent assignments", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-lifecycle-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "keep"), { recursive: true });
		await mkdir(path.join(root, ".pi-agents", "parent"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "keep", "agent.json"), JSON.stringify({ name: "keep", description: "Keep", lifecycle: "resumable" }));
		await writeFile(path.join(root, ".pi-agents", "parent", "agent.json"), JSON.stringify({ name: "parent", description: "Parent", subagents: [{ name: "keep", lifecycle: "session" }] }));
		const agents = (await discoverAgents(root)).agents;
		assert.equal("lifecycle" in agents.find(agent => agent.name === "keep")!, false);
		assert.deepEqual(agents.find(agent => agent.name === "parent")?.subagents, [{ name: "keep" }]);
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
		let started!: () => void;
		const ready = new Promise<void>(resolve => { started = resolve; });
		const running = runSubagent("worker", "wait", root, noAbort, {
			executable: fakePi,
			gracefulStopSeconds: 0.1,
			onHandle: (value) => { if (value) handle = value; },
			onProgress: event => { if (event.type === "started") started(); },
		});
		await Promise.race([ready, running]);
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

test("stop clears acknowledged steering before abort and bounds rejection, missing responses, startup and descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-stop-queue-test-"));
	const executable = path.join(root, "fake-pi.mjs");
	const log = path.join(root, "commands.jsonl");
	const observer = new SubagentObserver();
	try {
		await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
let buffer='', mode='', queued=false;
process.on('SIGTERM', () => { if (mode !== 'unresponsive') process.exit(0); });
process.stdin.on('data', chunk => {
 buffer += chunk;
 let end;
 while ((end=buffer.indexOf('\\n')) >= 0) {
  const command=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid, type:command.type, mode})+'\\n');
  if (command.type==='prompt') { mode=command.message; send({type:'agent_start'}); send({type:'tool_execution_start',toolName:'bash',args:{command:'sleep'}}); }
  if (command.type==='steer') {
   setTimeout(() => { queued=mode!=='steer-rejected'; send({type:'response',id:command.id,command:'steer',success:!queued ? false : true}); },40);
  }
  if (command.type==='clear_queue') {
   send({type:'response',id:'unrelated',command:'clear_queue',success:true});
   if (mode==='missing' || mode==='unresponsive') continue;
   if (mode==='clear-rejected') { send({type:'response',id:command.id,command:'clear_queue',success:false,error:'test rejection'}); continue; }
   queued=false;
   send({type:'response',id:command.id,command:'clear_queue',success:true,data:{steering:[],followUp:[]}});
  }
  if (command.type==='abort') {
   if (queued) appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,type:'EXECUTED_QUEUED'})+'\\n');
   send({type:'response',id:command.id,command:'abort',success:mode!=='abort-rejected',error:'test rejection'});
  }
 }
});
process.stdin.on('end', () => process.exit(0));
`);
		await chmod(executable, 0o755);
		const rows = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
		for (const mode of ["normal", "steer-rejected", "clear-rejected", "abort-rejected", "missing", "unresponsive", "startup"]) {
			let handle: RunningSubagentHandle | undefined;
			const start = Date.now();
			const run = runSubagent("worker", mode, root, noAbort, {
				executable, participantSessionDir: path.join(root, "sessions"), gracefulStopSeconds: 0.3,
				onHandle: value => { if (value) handle = value; },
				onSnapshot: snapshot => { if (mode === "startup" && snapshot.phase === "starting") handle!.stop("user"); },
				onProgress: event => {
					if (event.type === "tool-start") {
						assert.equal(handle!.steer("queued action"), true);
						handle!.stop("user");
						assert.equal(handle!.steer("late race"), false);
					}
				},
			});
			await assert.rejects(run, error => error instanceof SubagentStoppedError && error.reason === "user");
			assert.ok(Date.now() - start < 3000, "cancellation remains bounded");
			const commands = rows().filter(row => row.pid === rows().at(-1).pid).map(row => row.type);
			assert.ok(!commands.includes("EXECUTED_QUEUED"));
			assert.ok(commands.includes("clear_queue"));
			if (["clear-rejected", "missing", "unresponsive"].includes(mode)) assert.ok(!commands.includes("abort"));
			else assert.ok(commands.indexOf("clear_queue") < commands.indexOf("abort"));
			if (mode === "startup") assert.ok(!commands.includes("prompt"));
			handle!.stop("user"); // Already reaped: no callbacks/commands or restart.
		}
		const handles: RunningSubagentHandle[] = [];
		let ready = 0;
		const runs = ["parent", "child"].map(id => runSubagent(id, "normal", root, noAbort, {
			executable, id, parentRunId: id === "child" ? "parent" : undefined,
			participantSessionDir: path.join(root, "sessions"), gracefulStopSeconds: 0.3,
			onHandle: handle => { if (handle) { handles.push(handle); observer.attach(handle); } },
			onSnapshot: snapshot => observer.publish(snapshot),
			onProgress: event => {
				if (event.type === "tool-start" && ++ready === 2) {
					for (const handle of handles) assert.equal(handle.steer("queued descendant action"), true);
					observer.stopTree("parent", "user");
				}
			},
		}).catch(error => error));
		const outcomes = await Promise.all(runs);
		assert.ok(outcomes.every(error => error instanceof SubagentStoppedError));
		assert.equal(outcomes[0].reason, "user");
		assert.equal(outcomes[1].reason, "parent");
		assert.ok(!rows().some(row => row.type === "EXECUTED_QUEUED"));
	} finally { await observer.shutdown(0.1); await rm(root, { recursive: true, force: true }); }
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
			usage: { provider: "openai-codex", model: "gpt-5.3-codex-spark", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
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
	const messages: any[] = [];
	const pi: any = {
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => registered.push(tool),
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerFlag: () => {}, registerShortcut: () => {}, registerCommand: () => {},
		getFlag: () => undefined, appendEntry: () => {},
		getThinkingLevel: () => "max",
		getAllTools: () => [{ name: "read" }, { name: "bash" }, ...registered],
		getActiveTools: () => ["read", "bash"], setActiveTools: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	extension(pi);
	const theme = { fg: (role: string, text: string) => text, bold: (text: string) => text, getColorMode: () => "truecolor" };
	const ctx: any = { cwd: root, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "root-test-session" }, ui: { theme, setStatus: () => {}, notify: () => {} } };
	return { handlers, registered, ctx, messages };
}

test("background delegation returns immediately, survives parent abort, and batches completion after settlement", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-background-"));
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	let runtime: ReturnType<typeof bootExtension> | undefined;
	try {
		for (const name of ["lead", "worker"]) {
			await mkdir(path.join(root, ".pi-agents", name), { recursive: true });
			await writeFile(path.join(root, ".pi-agents", name, "agent.ts"), `export default { name: "${name}", description: "${name}", ${name === "lead" ? 'default: true, subagents: ["worker"]' : ""} };`);
		}
		const fakePi = path.join(root, "fake-pi.mjs");
		await writeFile(fakePi, `#!/usr/bin/env node
			let buffer = "";
			process.stdin.on("data", chunk => {
				buffer += chunk;
				let end;
				while ((end = buffer.indexOf("\\n")) >= 0) {
					const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
					if (command.type === "prompt") setTimeout(() => {
						process.stdout.write(JSON.stringify({type:"message_end",message:{content:[{type:"text",text:"done " + command.message}]}}) + "\\n");
						process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
					}, 150);
				}
			});
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;
		runtime = bootExtension(root);
		const { handlers, registered, ctx, messages } = runtime;
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		const delegate = registered.find(tool => tool.name === "delegate");
		const control = registered.find(tool => tool.name === "subagent_control");
		const parent = new AbortController();
		const a = await delegate.execute("a", { agent: "worker", task: "A", background: true }, parent.signal, () => assert.fail("background runs must not update finished tool calls"), ctx);
		const b = await delegate.execute("b", { agent: "worker", task: "B", background: true }, parent.signal, undefined, ctx);
		assert.equal(a.details.status, "running");
		assert.notEqual(a.details.runId, b.details.runId);
		parent.abort();
		for (let i = 0; i < 100; i++) {
			const result = await control.execute("list", { action: "list" });
			if (JSON.parse(result.content[0].text).every((run: any) => run.status === "completed")) break;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert.match((await control.execute("result", { action: "result", runId: a.details.runId })).content[0].text, /done A/);
		assert.equal(messages.length, 0, "active main flow is never interrupted");
		await handlers.get("agent_settled")?.({}, ctx);
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0].message.details.runs.sort(), [a.details.runId, b.details.runId].sort());
		assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
		const abort = new AbortController();
		ctx.signal = abort.signal;
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("turn_start")?.({}, ctx);
		const c = await delegate.execute("c", { agent: "worker", task: "C", background: true }, abort.signal, undefined, ctx);
		abort.abort();
		await handlers.get("agent_settled")?.({}, ctx);
		for (let i = 0; i < 100; i++) {
			const result = await control.execute("result", { action: "result", runId: c.details.runId });
			if (result.content[0].text.includes("done C")) break;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(messages.length, 1, "Escape must not wake the main agent");
		await handlers.get("input")?.({ source: "interactive" }, ctx);
		const next = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
		assert.match(next.message.content, /done C/);
	} finally {
		await runtime?.handlers.get("session_shutdown")?.({ reason: "quit" }, runtime.ctx);
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

test("usage model display retains configured reasoning levels", () => {
	assert.equal(displaySubagentModel("openai-codex/gpt-6-luna:max", "openai-codex/gpt-6-luna"), "openai-codex/gpt-6-luna:max");
	assert.equal(displaySubagentModel("test/old:high", "test/new"), "test/new (configured: test/old:high)");
	assert.equal(displaySubagentModel(undefined, "test/new"), "test/new");
});

test("delegation inherits the currently selected parent model unless configured otherwise", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegate-model-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	const previousBin = process.env.PI_CODING_AGENT_BIN;
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Lead", default: true, subagents: ["worker", { name: "fixed", model: "test/fixed-model:high" }] };
		`);
		for (const name of ["worker", "fixed"]) {
			await mkdir(path.join(root, ".pi-agents", name), { recursive: true });
			await writeFile(path.join(root, ".pi-agents", name, "agent.ts"), `export default { name: "${name}", description: "${name}" };`);
		}
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdin.on("data", chunk => {
				const command = JSON.parse(String(chunk).trim());
				if (command.type === "prompt") {
					const selected = process.argv[process.argv.indexOf("--model") + 1];
					const [provider, model] = selected ? selected.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "").split("/") : ["test", "default"];
					process.stdout.write(JSON.stringify({ type: "message_end", message: { provider, model, content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], usage: { input: 1, output: 1 } } }) + "\\n");
					process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
				}
			});
		`);
		await chmod(fakePi, 0o755);
		process.env.PI_CODING_AGENT_BIN = fakePi;
		const { handlers, registered, ctx } = bootExtension(root);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const delegate = registered.find(tool => tool.name === "delegate")!;
		async function argsFor(agent: string, expectedModel?: string): Promise<string[]> {
			const updates: any[] = [];
			const result = await delegate.execute(`model-${agent}`, { agent, task: "report args" }, undefined, (update: any) => updates.push(update), ctx);
			assert.equal(result.details.status, "completed");
			if (expectedModel) {
				assert.equal(result.details.model, expectedModel);
				assert.ok(updates.some(update => update.details.model === expectedModel && update.details.status === "running"));
				assert.match(delegate.renderCall({ agent, task: "report args" }, ctx.ui.theme).render(120).join("\n"), new RegExp(expectedModel));
			}
			const args = JSON.parse(String(result.content[0].text).split("\n\n")[1]);
			assert.equal(args[2], "--session");
			assert.match(args[3], /\.jsonl$/);
			args.splice(2, 2, "<thread-session>");
			return args;
		}
		ctx.model = { provider: "test", id: "selected-one" };
		assert.deepEqual(await argsFor("worker", "test/selected-one:max"), ["--mode", "rpc", "<thread-session>", "--agent", "worker", "--model", "test/selected-one:max"]);
		ctx.model = { provider: "other", id: "selected-two" };
		assert.deepEqual(await argsFor("worker", "other/selected-two:max"), ["--mode", "rpc", "<thread-session>", "--agent", "worker", "--model", "other/selected-two:max"]);
		assert.deepEqual(await argsFor("fixed", "test/fixed-model:high"), ["--mode", "rpc", "<thread-session>", "--agent", "fixed", "--model", "test/fixed-model:high"]);
		ctx.model = undefined;
		assert.deepEqual(await argsFor("worker"), ["--mode", "rpc", "<thread-session>", "--agent", "worker"]);
	} finally {
		if (previousBin === undefined) delete process.env.PI_CODING_AGENT_BIN;
		else process.env.PI_CODING_AGENT_BIN = previousBin;
		await rm(root, { recursive: true, force: true });
	}
});

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
			const expected = ["--mode", "rpc", "--session", args[3], "--agent", "worker", "--model", "test/worker-model"];
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
		await writeFile(path.join(root, ".pi-agents", "flat.ts"), 'export default { name: "flat", description: "Flat" };');
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["x"] } } }));
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

		// Secrets exist only in the main checkout.
		await writeFile(path.join(root, ".pi-agents", ".env"), "PROJECT_SECRET=main\nPROJECT_FALLBACK=main-only\n");
		await writeFile(path.join(root, ".pi-agents", "dev", ".env"), "GH_TOKEN=main-token\nAGENT_FALLBACK=main-only\nEMPTY_OVERRIDE=main\n");

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
		const localAgentDir = path.join(worktree, ".pi-agents", "dev");
		await writeFile(path.join(localAgentDir, ".env"), "GH_TOKEN=local-token\nLOCAL_ONLY=local-only\nEMPTY_OVERRIDE=\n");
		const result2 = await discoverAgents(worktree);
		assert.equal(result2.config.env?.PROJECT_SECRET, "worktree");
		assert.equal(result2.config.env?.PROJECT_FALLBACK, "main-only");
		assert.equal(result2.config.env?.GH_TOKEN, undefined); // agent-level, not project-level
		assert.deepEqual(result2.agents.find(agent => agent.name === "dev")?.env, {
			GH_TOKEN: "local-token", AGENT_FALLBACK: "main-only", LOCAL_ONLY: "local-only", EMPTY_OVERRIDE: "",
		});
		assert.equal(result2.agents.find(agent => agent.name === "flat")?.env?.PROJECT_SECRET, "worktree");
		assert.equal(result2.agents.find(agent => agent.name === "flat")?.env?.PROJECT_FALLBACK, "main-only");

		// Studio's immediate save must survive a subsequent full discovery/reload.
		saveCredential(localAgentDir, "GH_TOKEN", "refreshed-local-token");
		const refreshed = (await discoverAgents(worktree)).agents.find(agent => agent.name === "dev");
		assert.equal(refreshed?.env?.GH_TOKEN, "refreshed-local-token");
		assert.equal(refreshed?.env?.AGENT_FALLBACK, "main-only");
		assert.equal((await discoverAgents(root)).agents.find(agent => agent.name === "dev")?.env?.GH_TOKEN, "main-token");
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
