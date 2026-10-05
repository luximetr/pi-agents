import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentObserver, getSubagentWorkspace, isActiveRun, newRunId } from "../subagent-observer.ts";
import { buildRunTree, sessionDetailLines, showSubagentInspector, workspaceDetails, type SessionInspectorOptions } from "../subagent-explorer.ts";
import { renderSessionOverview } from "../session-overview.ts";
import type { CoordinationSnapshot } from "../session-coordination.ts";
import { MAX_TRANSCRIPT_CHARS, SubagentTranscript } from "../subagent-transcript.ts";
import { SubagentStoppedError, runSubagent, type RunningSubagentHandle, type SubagentSnapshot } from "../subagents.ts";

const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail("Timed out waiting for observation");
		await pause();
	}
}
function snapshot(id: string, parentRunId?: string): SubagentSnapshot {
	return { id, parentRunId, agent: "worker", task: `Task ${id}`, startedAt: 1, lastActivityAt: Date.now(), status: "running", phase: "running", partialText: "", recentEvents: [], transcript: [] };
}
function handleFor(state: SubagentSnapshot, publish: (state: SubagentSnapshot) => void = () => {}): RunningSubagentHandle {
	return {
		id: state.id, snapshot: () => ({ ...state }),
		stop(reason) { state.status = "failed"; state.stopReason = reason; state.endedAt = Date.now(); publish({ ...state }); },
		steer(message) { state.partialText = message; publish({ ...state }); return true; },
	};
}

function coordinationFixture(): CoordinationSnapshot {
	return {
		version: 1, scope: { projectCwd: "/tmp/test-project", rootSessionId: "session", participantId: "main" }, createdAt: 1, updatedAt: 2,
		focus: { taskId: "login", text: "Reviewing the login fix", nextAction: "Review results → finish login task", updatedAt: 2 },
		tasks: [{ id: "login", title: "Fix login", objective: "Fix login and verify the API", status: "active", owner: "main", nextAction: "Review API tests", createdAt: 1, updatedAt: 2,
			items: [{ id: "implement", text: "Implement login", status: "completed", owner: "dev-worker", dependsOn: [], createdAt: 1, updatedAt: 2 },
				{ id: "review", text: "Review API tests", status: "in_progress", owner: "main", dependsOn: ["implement"], createdAt: 1, updatedAt: 2 }] },
			{ id: "docs", title: "Update docs", objective: "Document authentication", status: "blocked", owner: "researcher", items: [{ id: "draft", text: "Draft auth guide", status: "pending", dependsOn: ["login/review"], createdAt: 1, updatedAt: 2 }], createdAt: 1, updatedAt: 2 }],
		runs: [{ runId: "login-result", taskId: "login", itemId: "review", agent: "dev-worker", task: "API tests", createdAt: 1 }],
		results: [{ runId: "login-result", taskId: "login", itemId: "review", agent: "dev-worker", task: "API tests", title: "Login implementation", summary: "All API tests passed; review the token change.", text: "Detailed login report\nThe existing token format is unchanged.", executionStatus: "completed", handling: "new", delivered: false, createdAt: 1, updatedAt: 2 }],
	};
}

function inspectorHarness(handles: RunningSubagentHandle[], options: SessionInspectorOptions, height = 28) {
	let component: any;
	let rows = height;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const promise = showSubagentInspector({ mode: "tui", ui: { theme, custom: (factory: any) => new Promise<void>(resolve => {
		component = factory({ terminal: { get rows() { return rows; } }, requestRender() {} }, theme, {}, resolve);
	}) } } as any, () => handles, 5, "Login session", options);
	return { component, promise, setHeight: (value: number) => { rows = value; }, close: () => component.handleInput("\u001b[20~") };
}

test("task overview derives progress from items only and never shows report state", () => {
	const state = coordinationFixture();
	const runs = [{ ...snapshot("docs-run"), agent: "researcher" }];
	state.runs.push({ runId: "docs-run", taskId: "docs", itemId: "draft", agent: "researcher", task: "Draft auth guide", createdAt: 1 });
	const original = structuredClone(state);
	const lines = renderSessionOverview(state, runs, 120);
	assert.equal(lines.length, 5);
	assert.match(lines[0], /Tasks · 2 active · 1 running\s+F9 tasks/);
	assert.match(lines[1], /Fix login · 1\/2 done · In progress/);
	assert.match(lines[2], /Review API tests · main · in progress/);
	assert.match(lines[3], /Update docs · 0\/1 done · Blocked/);
	assert.match(lines[4], /Draft auth guide · pending/);
	const narrow = renderSessionOverview(state, runs, 40).join("\n");
	assert.match(narrow, /Review API tests · in progress/);
	assert.match(narrow, /Draft auth guide · pending/);
	assert.doesNotMatch(lines.join("\n"), /Main|Next|No focus|deferred/);
	assert.deepEqual(state, original, "rendering never edits checklist items");
	const baseline = renderSessionOverview(state, runs, 120);
	for (const handling of ["handled", "deferred", "new"] as const) {
		state.results[0].handling = handling;
		assert.deepEqual(renderSessionOverview(state, runs, 120), baseline, "report handling is not shown in the panel");
	}
});

test("task overview fits small terminals and summarizes extra tasks", () => {
	const state = coordinationFixture();
	state.tasks[0].title = "中文 🐳\n\x1b[31mReview login\x1b[0m";
	for (const width of [0, 1, 8, 20, 40, 80, 120]) for (const height of [0, 1, 2, 3, 4, 5, 20]) {
		const lines = renderSessionOverview(state, [snapshot("active")], width, height);
		assert.ok(lines.length <= height);
		assert.ok(lines.every(line => visibleWidth(line) <= width && !/[\n\r]/.test(line) && !line.includes("\x1b[31m")));
	}
	state.tasks.push(...Array.from({ length: 5 }, (_, index) => ({ ...state.tasks[1], id: `extra-${index}` })));
	assert.match(renderSessionOverview(state, [], 100).join("\n"), /\+5 more tasks/);
	state.tasks.forEach(task => { task.status = "completed"; });
	state.results[0].handling = "deferred";
	assert.doesNotMatch(renderSessionOverview(state, [], 100).join("\n"), /deferred/, "reports are not shown in the panel");
	assert.match(renderSessionOverview(state, [], 100)[0], /no active work/);
	assert.equal(renderSessionOverview(state, [], 100).length, 1);
});

test("Tasks view shows every item, dependencies and dropped work", () => {
	const state = coordinationFixture();
	state.tasks[1].status = "dropped";
	state.results[0].handling = "deferred";
	state.tasks[0].items.push({ id: "extra", text: "Verify browser flow", status: "pending", dependsOn: [], createdAt: 1, updatedAt: 2 });
	const text = sessionDetailLines(state, [snapshot("browser")]).join("\n");
	assert.match(text, /Fix login · 1\/3 done · In progress/);
	assert.match(text, /✓ Implement login/);
	assert.match(text, /◐ Review API tests/);
	assert.match(text, /○ Verify browser flow/);
	assert.match(text, /after: Implement login/);
	assert.match(text, /Update docs · 0\/1 done · Dropped/);
	assert.match(text, /Details: Fix login and verify the API/);
	assert.doesNotMatch(text, /Main:|Next:|#login|deferred|running/);
});

test("coordination tabs work without live runs; result inspection and delivery do not acknowledge or change focus", async () => {
	const state = coordinationFixture();
	const handled: string[] = [];
	const harness = inspectorHarness([], { getCoordination: () => state, onHandleResult: (_runId, handling) => { handled.push(handling); } });
	try {
		const { component } = harness;
		assert.match(component.render(120).join("\n"), /\[1 Tasks\]/);
		assert.match(component.render(120).join("\n"), /Details: Fix login and verify the API/);
		component.handleInput("2");
		assert.match(component.render(120).join("\n"), /No delegated runs/);
		component.handleInput("3");
		assert.match(component.render(120).join("\n"), /\[3 Inbox \(1\)\]/);
		component.handleInput("\r");
		state.results[0].delivered = true;
		assert.match(component.render(120).join("\n"), /Detailed login report/);
		assert.match(component.render(120).join("\n"), /Handling: new · Execution: completed/);
		assert.deepEqual(handled, []);
		assert.equal(state.focus?.text, "Reviewing the login fix");
		for (const width of [120, 80, 40, 12]) for (const height of [28, 8, 2]) {
			harness.setHeight(height);
			const lines = component.render(width);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		}
	} finally { harness.close(); }
	await harness.promise;
});

test("Inbox requires explicit handling, keeps deferred results, and retains selection during concurrent arrivals", async () => {
	const state = coordinationFixture();
	const focus = JSON.stringify(state.focus);
	const harness = inspectorHarness([], { getCoordination: () => state,
		onHandleResult(runId, handling, note) { Object.assign(state.results.find(result => result.runId === runId)!, { handling, note }); } });
	try {
		const { component } = harness;
		component.handleInput("3");
		component.handleInput("\r");
		state.results.unshift({ ...state.results[0], runId: "concurrent", title: "Research result", text: "Different report", createdAt: 0 });
		assert.match(component.render(120).join("\n"), /Detailed login report/);
		component.handleInput("h");
		await pause(0);
		assert.equal(state.results[1].handling, "handled");
		assert.equal(state.results[0].handling, "new");
		component.handleInput("n");
		await pause(0);
		assert.equal(state.results[1].handling, "new");
		component.handleInput("d");
		component.handleInput("Wait for API changes");
		component.handleInput("\r");
		await pause(0);
		assert.equal(state.results[1].handling, "deferred");
		assert.equal(state.results[1].note, "Wait for API changes");
		assert.match(component.render(120).join("\n"), /Handling: deferred/);
		assert.match(component.render(120).join("\n"), /3 Inbox \(2\)/);
		component.handleInput("h");
		await pause(0);
		assert.equal(state.results[1].handling, "handled");
		assert.equal(state.tasks[0].items[1].status, "in_progress");
		assert.equal(JSON.stringify(state.focus), focus);
		assert.match(component.render(120).join("\n"), /3 Inbox \(1\)/);
	} finally { harness.close(); }
	await harness.promise;
});

test("Inbox checks reply/recovery eligibility again at submit and reports callback failures", async () => {
	const state = coordinationFixture();
	let actions = ["reply", "recover"];
	const requests: unknown[][] = [];
	let reject = false;
	const harness = inspectorHarness([], { getCoordination: () => state, getResultActions: () => actions,
		onResultAction: async (...args) => { if (reject) throw new Error("Latest-run ownership changed"); requests.push(args); } });
	try {
		const { component } = harness;
		component.handleInput("3");
		assert.match(component.render(120).join("\n"), /p reply · c recover/);
		component.handleInput("p");
		component.handleInput("Please check 123");
		actions = [];
		component.handleInput("\r");
		await pause(0);
		assert.deepEqual(requests, []);
		assert.match(component.render(120).join("\n"), /no longer available/);
		actions = ["recover"];
		component.handleInput("c");
		component.handleInput("Continue after checking current files");
		component.handleInput("\r");
		await pause(0);
		assert.deepEqual(requests, [["recover", "login-result", "Continue after checking current files"]]);
		assert.equal(state.results[0].handling, "new");
		reject = true;
		component.handleInput("c");
		component.handleInput("Try again");
		component.handleInput("\r");
		await pause(0);
		assert.match(component.render(120).join("\n"), /Latest-run ownership changed/);
	} finally { harness.close(); }
	await harness.promise;
});

test("live Inbox refresh reads one snapshot and cached report layout still reflects handling, notes and resizing", async () => {
	const state = coordinationFixture();
	state.results[0].text = Array.from({ length: 100 }, (_, i) => `Large report line ${i}: ${"evidence ".repeat(20)}`).join("\n");
	let reads = 0;
	const harness = inspectorHarness([], { getCoordination: () => { reads++; return structuredClone(state); } });
	try {
		const { component } = harness;
		component.handleInput("3");
		component.handleInput("\r");
		for (let i = 0; i < 3; i++) {
			reads = 0;
			component.render(120);
			assert.equal(reads, 1, "one internally consistent snapshot per render");
		}
		state.results[0].handling = "deferred";
		state.results[0].note = "Waiting for API changes";
		assert.match(component.render(120).join("\n"), /Handling: deferred/);
		assert.match(component.render(120).join("\n"), /Note: Waiting for API changes/);
		const narrow = component.render(40);
		assert.ok(narrow.every((line: string) => visibleWidth(line) <= 40));
		component.handleInput("G");
		assert.match(component.render(40).join("\n"), /Large report line 99/);
	} finally { harness.close(); }
	await harness.promise;
});

test("switching coordination tabs preserves Runs scroll position, steering, tree navigation and stop controls", async () => {
	const parent = snapshot("parent");
	const child = snapshot("child", "parent");
	parent.transcript = [{ id: "text", kind: "assistant", text: Array.from({ length: 100 }, (_, i) => `preserved-${i}`).join("\n") }];
	const harness = inspectorHarness([handleFor(parent), handleFor(child)], { getCoordination: coordinationFixture });
	try {
		const { component } = harness;
		component.handleInput("2");
		component.render(120);
		component.handleInput("\r");
		component.handleInput("g");
		assert.match(component.render(120).join("\n"), /preserved-0\n/);
		component.handleInput("1");
		component.render(120);
		component.handleInput("2");
		assert.match(component.render(120).join("\n"), /preserved-0\n/);
		component.handleInput("s");
		component.handleInput("Check 123 more cases");
		component.handleInput("\r");
		assert.equal(parent.partialText, "Check 123 more cases");
		component.handleInput("\u001b[C");
		assert.match(component.render(120).join("\n"), /Main session|child/);
		component.handleInput("x");
		component.handleInput("y");
		assert.equal(child.status, "failed");
		assert.equal(parent.status, "running");
	} finally { harness.close(); }
	await harness.promise;
});

test("optional workspace metadata distinguishes unknown, shared and detached worktrees safely", () => {
	const run = snapshot("workspace");
	assert.equal(getSubagentWorkspace(run), undefined);
	assert.deepEqual(workspaceDetails(run), ["Workspace: not reported"]);
	for (const workspace of [null, "invalid", { mode: "worktree" }]) {
		assert.equal(getSubagentWorkspace(Object.assign(run, { workspace })), undefined);
	}
	Object.assign(run, { workspace: "shared", workspaceCwd: 123, workspaceBranch: {} });
	assert.deepEqual(workspaceDetails(run), ["Workspace: shared", "Cwd: not reported", "Branch: not reported"]);
	Object.assign(run, { workspace: "worktree", workspaceCwd: "/tmp/中文\n\x1b[31mworker\x1b[0m", workspaceBranch: null, workspaceBaseCommit: "abc123" });
	assert.deepEqual(workspaceDetails(run), ["Workspace: worktree", "Cwd: /tmp/中文\\nworker", "Branch: detached HEAD", "Base commit: abc123", "Review/apply manually; completion does not merge changes."]);
});

test("workspace metadata survives remote observation, completion and transcript eviction", async () => {
	const root = new SubagentObserver();
	const remote = new SubagentObserver(await root.start());
	try {
		await remote.start();
		const workspace = { workspace: "worktree", workspaceCwd: "/tmp/task/src", worktreePath: "/tmp/task", workspaceBranch: "task/worker", workspaceBaseCommit: "abc123" };
		remote.publish(Object.assign(snapshot("isolated"), { ...workspace, status: "finished" as const, endedAt: 1,
			transcript: [{ id: "answer", kind: "assistant" as const, text: "done" }] }));
		await until(() => root.handles().length === 1);
		for (let i = 0; i < 100; i++) root.publish({ ...snapshot(`completed-${i}`), status: "finished", endedAt: i + 2,
			transcript: [{ id: "answer", kind: "assistant", text: "done" }] });
		const retained = root.handles().find(handle => handle.id === "isolated")!.snapshot();
		assert.equal(retained.transcriptTruncated, true);
		assert.deepEqual(getSubagentWorkspace(retained), { mode: "worktree", cwd: "/tmp/task/src", worktreePath: "/tmp/task", branch: "task/worker", baseCommit: "abc123" });
		assert.ok(workspaceDetails(retained).includes("Worktree: /tmp/task"));
	} finally { await remote.shutdown(0); await root.shutdown(0); }
});

test("transcript assembles streaming messages, correlates parallel tools and replaces cumulative output", () => {
	const transcript = new SubagentTranscript("task");
	transcript.consume({ type: "message_end", message: { role: "user", content: "task" } });
	transcript.consume({ type: "message_start", message: { role: "assistant" } });
	transcript.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi " } });
	transcript.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "there" } });
	transcript.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] } });
	for (const id of ["one", "two"]) transcript.consume({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
	transcript.consume({ type: "tool_execution_update", toolCallId: "one", partialResult: { content: [{ type: "text", text: "old" }] } });
	transcript.consume({ type: "tool_execution_update", toolCallId: "one", partialResult: { content: [{ type: "text", text: "new" }] } });
	transcript.consume({ type: "tool_execution_end", toolCallId: "two", result: { content: [{ type: "text", text: "error" }] }, isError: true });
	const entries = transcript.snapshot();
	assert.equal(entries.filter(entry => entry.kind === "user").length, 1);
	assert.deepEqual(entries.filter(entry => entry.kind === "assistant").map(entry => entry.text), ["Hi there!"]);
	assert.equal(entries.find(entry => entry.id === "tool:one")?.output, "new");
	assert.equal(entries.find(entry => entry.id === "tool:two")?.status, "failed");
	assert.equal(entries.find(entry => entry.id === "tool:one")?.status, "running");
	entries[0].text = "mutated";
	assert.equal(transcript.snapshot()[0].text, "task");
});

test("transcript retention is bounded and explicit", () => {
	const transcript = new SubagentTranscript("task");
	for (let i = 0; i < 500; i++) transcript.add("assistant", "x".repeat(20_000));
	assert.equal(transcript.truncated, true);
	assert.ok(transcript.snapshot().reduce((sum, entry) => sum + entry.text.length, 0) <= MAX_TRANSCRIPT_CHARS);
	assert.match(transcript.snapshot().at(-1)!.text, /Earlier content omitted/);
});

test("failed launch publishes a final inspectable snapshot without an unhandled process error", async () => {
	let final: SubagentSnapshot | undefined;
	await assert.rejects(runSubagent("worker", "task", process.cwd(), new AbortController().signal, {
		executable: path.join(os.tmpdir(), `missing-pi-${newRunId()}`), onSnapshot: value => { final = value; },
	}), /ENOENT/);
	assert.equal(final?.status, "failed");
	assert.ok(final?.endedAt);
	assert.ok(final?.transcript?.some(entry => entry.text.includes("ENOENT")));
});

test("runner keeps the assistant answer and own usage separate from tool results", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-explorer-rpc-"));
	try {
		const executable = path.join(directory, "fake-pi.mjs");
		await writeFile(executable, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
process.stdin.once("data", () => {
 const content = text => [{type:"text",text}];
 emit({type:"message_end",message:{role:"assistant",content:content("actual answer"),usage:{input:2,output:3}}});
 emit({type:"message_end",message:{role:"toolResult",content:content("NOT the answer"),usage:{input:100,output:100}}});
 emit({type:"agent_settled"});
});`);
		await chmod(executable, 0o755);
		let final: SubagentSnapshot | undefined;
		assert.equal(await runSubagent("worker", "task", directory, new AbortController().signal, { executable, onSnapshot: value => { final = value; } }), "actual answer");
		assert.equal(final?.usage?.input, 2);
		assert.equal(final?.usage?.output, 3);
		assert.equal(final?.status, "finished");
		assert.ok(final?.endedAt);
		await writeFile(executable, `#!/usr/bin/env node
process.stdin.once("data", () => {
 process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"provider unavailable",content:[]}}) + "\\n");
 process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
});`);
		await assert.rejects(runSubagent("worker", "task", directory, new AbortController().signal, { executable, onSnapshot: value => { final = value; } }), /provider unavailable/);
		assert.equal(final?.status, "failed");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("run tree supports grandchildren, repeated agent names, collapse and out-of-order registration", () => {
	const runs = [snapshot("grandchild", "child"), snapshot("child"), snapshot("sibling")];
	assert.deepEqual(buildRunTree(runs).map(row => [row.run.id, row.depth]), [["child", 0], ["grandchild", 1], ["sibling", 0]]);
	assert.deepEqual(buildRunTree(runs, new Set(["child"])).map(row => row.run.id), ["child", "sibling"]);
	assert.deepEqual(buildRunTree([runs[0]]).map(row => row.run.id), ["grandchild"]);
	const cycle = [snapshot("a", "b"), snapshot("b", "a")];
	assert.deepEqual(new Set(buildRunTree(cycle).map(row => row.run.id)), new Set(["a", "b"]));
});

test("private broker retains nested history and routes controls only to the selected subtree", async () => {
	const root = new SubagentObserver();
	let nested: SubagentObserver | undefined;
	let siblingOwner: SubagentObserver | undefined;
	try {
		const endpoint = await root.start();
		assert.equal((await stat(path.dirname(endpoint))).mode & 0o777, 0o700);
		nested = new SubagentObserver(endpoint);
		siblingOwner = new SubagentObserver(endpoint);
		await Promise.all([nested.start(), siblingOwner.start()]);
		const parent = snapshot("parent");
		root.attach(handleFor(parent, value => root.publish(value)));
		root.publish({ ...parent });
		const child = snapshot("child", "parent");
		nested.attach(handleFor(child, value => nested!.publish(value)));
		nested.publish({ ...child });
		const sibling = snapshot("sibling");
		siblingOwner.attach(handleFor(sibling, value => siblingOwner!.publish(value)));
		siblingOwner.publish({ ...sibling });
		await until(() => root.handles().length === 3);
		assert.equal(root.handles().find(handle => handle.id === "child")!.steer("targeted instruction"), true);
		await until(() => child.partialText === "targeted instruction");
		assert.equal(sibling.partialText, "");
		root.handles().find(handle => handle.id === "parent")!.stop("user");
		await until(() => child.status === "failed");
		assert.equal(parent.status, "failed");
		assert.equal(sibling.status, "running");
		await until(() => root.handles().find(handle => handle.id === "child")?.snapshot().status === "failed");
		assert.equal(root.handles().length, 3, "completed runs stay in the tree");
		const late = snapshot("late", "parent");
		nested.attach(handleFor(late, value => nested!.publish(value)));
		nested.publish({ ...late });
		await until(() => late.status === "failed");
	} finally {
		await nested?.shutdown(0);
		await siblingOwner?.shutdown(0);
		await root.shutdown(0);
	}
});

test("runner-initiated deadlines cascade to descendants without stopping siblings", async () => {
	const root = new SubagentObserver();
	const endpoint = await root.start();
	const remote = new SubagentObserver(endpoint);
	try {
		await remote.start();
		const parent = snapshot("parent");
		root.publish(parent);
		const nested = snapshot("nested", "parent");
		remote.attach(handleFor(nested, value => remote.publish(value)));
		remote.publish({ ...nested });
		await until(() => root.handles().length === 2);
		root.publish({ ...parent, status: "failed", stopReason: "timeout", endedAt: Date.now() });
		await until(() => nested.status === "failed");
		assert.equal(nested.stopReason, "parent");
	} finally { await remote.shutdown(0); await root.shutdown(0); }
});

test("owner disconnect marks incomplete remote runs unavailable, not successfully completed", async () => {
	const root = new SubagentObserver();
	const endpoint = await root.start();
	const remote = new SubagentObserver(endpoint);
	try {
		await remote.start();
		remote.publish(snapshot("orphan"));
		await until(() => root.handles().length === 1);
		await remote.shutdown(0);
		await until(() => root.handles()[0].snapshot().status === "failed");
		assert.match(root.handles()[0].snapshot().phase, /disconnected/);
	} finally { await remote.shutdown(0); await root.shutdown(0); }
	await assert.rejects(stat(endpoint), { code: "ENOENT" });
});

test("explorer supports bounded wide/narrow layouts, drill-down/back, scrolling and completed history", async () => {
	const parent = snapshot("parent");
	const child = snapshot("child", "parent");
	parent.task = "First prompt line\nSecond prompt line";
	Object.assign(parent, { workspace: "worktree", workspaceCwd: "/tmp/中文/task", workspaceBranch: "task/worker", workspaceBaseCommit: "abc123" });
	parent.transcript = [{ id: "text", kind: "assistant", text: Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") }];
	child.transcript = [{ id: "text", kind: "assistant", text: "nested conversation 中文 🐳" }];
	const handles = [handleFor(parent), handleFor(child)];
	let component: any;
	let height = 24;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const promise = showSubagentInspector({ mode: "tui", ui: { theme, custom: (factory: any) => new Promise<void>(resolve => {
		component = factory({ terminal: { get rows() { return height; } }, requestRender() {} }, theme, {}, resolve);
	}) } } as any, () => handles, 5);
	try {
		for (const width of [120, 80, 40, 12]) {
			const lines = component.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		}
		assert.match(component.render(120).join("\n"), /⌃U\/⌃D page · g\/G start\/follow · p prompt/);
		assert.match(component.render(120).join("\n"), /\[worktree\]/);
		assert.match(component.render(120).join("\n"), /\[workspace \?\]/);
		component.handleInput("\r");
		let text = component.render(120).join("\n");
		assert.match(text, /line-99/);
		component.handleInput("p");
		text = component.render(120).join("\n");
		assert.match(text, /Task: First prompt line\nSecond prompt line/);
		component.handleInput("p");
		component.handleInput("g");
		text = component.render(120).join("\n");
		assert.match(text, /line-0\n/);
		assert.match(text, /scroll paused/);
		assert.match(text, /Cwd: \/tmp\/中文\/task/);
		assert.match(text, /Branch: task\/worker/);
		assert.match(text, /Base commit: abc123/);
		const longPath = `/tmp/${"segment/".repeat(8)}尾`;
		Object.assign(parent, { workspaceCwd: longPath });
		const narrow = component.render(40);
		assert.ok(narrow.every((line: string) => visibleWidth(line) <= 40));
		assert.ok(narrow.join("").includes(longPath), "long paths wrap without losing their tail");
		Object.assign(parent, { workspaceCwd: "/tmp/中文/task" });
		component.render(120);
		component.handleInput("\x04");
		assert.doesNotMatch(component.render(120).join("\n"), /line-0\n/);
		component.handleInput("g");
		parent.transcript[0].text += "\nnew streamed line";
		assert.match(component.render(120).join("\n"), /line-0\n/);
		component.handleInput("G");
		assert.match(component.render(120).join("\n"), /new streamed line/);
		component.handleInput("g");
		component.handleInput("\u001b[C");
		assert.match(component.render(120).join("\n"), /nested conversation/);
		component.handleInput("\u001b");
		assert.match(component.render(120).join("\n"), /line-0\n/);
		parent.status = "finished";
		assert.match(component.render(120).join("\n"), /completed\/failed/);
		assert.match(component.render(120).join("\n"), /line-0\n/);
		component.handleInput("s");
		assert.match(component.render(120).join("\n"), /history is read-only/);
		height = 8;
		assert.equal(component.render(40).length, height);
		height = 2;
		assert.ok(component.render(12).length <= height);
	} finally { component.handleInput("\u001b[20~"); }
	await promise;
});

test("parallel task threads remain individually observable, stoppable, steerable, and retained", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-explorer-queue-"));
	const executable = path.join(directory, "fake-pi.mjs");
	const starts = path.join(directory, "starts.log");
	const observer = new SubagentObserver();
	const running: Promise<string>[] = [];
	try {
		await observer.start();
		await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buffer = "";
let task = "";
let finished = false;
const finish = text => {
 if (finished) return;
 finished = true;
 process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}]}}) + "\\n");
 process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
};
process.stdin.on("data", chunk => {
 buffer += String(chunk);
 let newline;
 while ((newline = buffer.indexOf("\\n")) !== -1) {
  const line = buffer.slice(0, newline);
  buffer = buffer.slice(newline + 1);
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  if (command.type === "prompt") {
   task = command.message;
   appendFileSync(${JSON.stringify(starts)}, task + "\\n");
   setTimeout(() => finish("done:" + task), task.startsWith("holder") ? 180 : 500);
  } else if (command.type === "steer") {
   finish("done:" + task + ";steer:" + command.message);
  }
 }
});`);
		await chmod(executable, 0o755);
		const base = { executable, rootSessionId: "root", threadId: "worker", participantSessionDir: path.join(directory, "sessions") };
		const startHolder = (task: string) => {
			const promise = runSubagent("worker", task, directory, new AbortController().signal, base);
			running.push(promise);
			return promise;
		};
		const waitForStarts = (count: number) => until(() => {
			try { return readFileSync(starts, "utf8").trim().split("\n").length >= count; } catch { return false; }
		});
		const observe = (id: string, task: string, extra: Record<string, unknown> = {}, owner = observer) => runSubagent("worker", task, directory, new AbortController().signal, {
			...base, threadId: id, ...extra, id,
			onHandle: handle => { if (handle) owner.attach(handle); },
			onSnapshot: value => owner.publish(value),
		});

		const holder1 = startHolder("holder user");
		await waitForStarts(1);
		const userRun = observe("queued-user", "queued user");
		await waitForStarts(2);
		const queuedUser = observer.handles().find(value => value.id === "queued-user")!;
		queuedUser.stop("user");
		await assert.rejects(userRun, (error: unknown) => error instanceof SubagentStoppedError && error.reason === "user");
		assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 2, "separate threads run concurrently");
		assert.equal(await holder1, "done:holder user", "individual cancellation does not stop the holder");

		const holder2 = startHolder("holder timeout");
		await waitForStarts(3);
		await assert.rejects(observe("queued-timeout", "queued timeout", { timeoutSeconds: 0.05 }), (error: unknown) => error instanceof SubagentStoppedError && error.reason === "timeout");
		const timedOut = observer.handles().find(value => value.id === "queued-timeout")!.snapshot();
		assert.equal(timedOut.stopReason, "timeout");
		assert.match(timedOut.phase, /deadline exceeded/);
		await holder2;

		const holder3 = startHolder("holder transition");
		const transitionedRun = observe("stable-transition-id", "spawn after queue");
		await until(() => observer.handles().some(value => value.id === "stable-transition-id" && value.snapshot().phase === "starting"));
		const transitioning = observer.handles().find(value => value.id === "stable-transition-id")!;
		assert.equal(transitioning.steer("after spawn"), true);
		assert.equal(await transitionedRun, "done:spawn after queue;steer:after spawn");
		const transitioned = observer.handles().find(value => value.id === "stable-transition-id")!.snapshot();
		assert.equal(transitioned.status, "finished");
		assert.equal(transitioned.id, "stable-transition-id");
		await holder3;

		const holder4 = startHolder("holder shutdown");
		const shutdownObserver = new SubagentObserver();
		await shutdownObserver.start();
		const shutdownRun = observe("queued-shutdown", "queued shutdown", {}, shutdownObserver);
		await until(() => shutdownObserver.handles().some(value => value.id === "queued-shutdown"));
		const shutdownRejected = assert.rejects(shutdownRun, (error: unknown) => error instanceof SubagentStoppedError && error.reason === "session");
		await shutdownObserver.shutdown(0.05);
		await shutdownRejected;
		assert.equal(shutdownObserver.handles().find(value => value.id === "queued-shutdown")!.snapshot().stopReason, "session");
		await holder4;
	} finally {
		await observer.shutdown(0.1);
		await Promise.allSettled(running);
		await rm(directory, { recursive: true, force: true });
	}
});

test("real nested processes publish grandchildren, accept steering and retain final transcripts", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-explorer-e2e-"));
	const executable = path.join(directory, "fake-pi.mjs");
	const observer = new SubagentObserver();
	let running: Promise<unknown> | undefined;
	try {
		const endpoint = await observer.start();
		await writeFile(executable, `#!/usr/bin/env node
import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
const jiti = createJiti(import.meta.url);
const { SubagentObserver, newRunId } = await jiti.import(${JSON.stringify(fileURLToPath(new URL("../subagent-observer.ts", import.meta.url)))});
const { runSubagent } = await jiti.import(${JSON.stringify(fileURLToPath(new URL("../subagents.ts", import.meta.url)))});
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const controller = new AbortController();
const owner = new SubagentObserver(process.env.PI_AGENTS_OBSERVER_SOCKET);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
 buffer += chunk;
 let newline;
 while ((newline = buffer.indexOf("\\n")) !== -1) {
  const command = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
  if (command.type === "prompt") void work();
  if (command.type === "steer") {
   emit({ type: "response", command: "steer", success: true });
   emit({ type: "message_end", message: { role: "assistant", content: [{type:"text", text: "received: " + command.message}] } });
  }
  if (command.type === "abort") { controller.abort(); emit({type:"agent_settled"}); }
 }
});
async function work() {
 emit({type:"agent_start"});
 if (Number(process.env.PI_AGENTS_SUBAGENT_DEPTH) === 1) {
  await owner.start();
  emit({type:"tool_execution_start",toolCallId:"delegate-child",toolName:"delegate",args:{agent:"worker"}});
  try {
   await runSubagent("worker", "nested task", process.cwd(), controller.signal, {
    executable: ${JSON.stringify(executable)}, id: newRunId(), parentRunId: process.env.PI_AGENTS_RUN_ID,
    observerEndpoint: process.env.PI_AGENTS_OBSERVER_SOCKET, gracefulStopSeconds: 0.2,
    onHandle: handle => { if(handle) owner.attach(handle); }, onSnapshot: value => owner.publish(value)
   });
  } catch {}
  await owner.shutdown(0.2);
  emit({type:"agent_settled"});
 } else {
  emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"grandchild ready"}]}});
 }
}
process.on("SIGTERM", async () => { controller.abort(); await owner.shutdown(0.2); process.exit(0); });
`);
		await chmod(executable, 0o755);
		const parentId = newRunId();
		running = runSubagent("worker", "parent task", directory, new AbortController().signal, {
			executable, id: parentId, observerEndpoint: endpoint, gracefulStopSeconds: 0.5,
			onHandle: handle => { if (handle) observer.attach(handle); }, onSnapshot: value => observer.publish(value),
		}).catch(error => error);
		await until(() => observer.handles().some(handle => handle.id !== parentId && handle.snapshot().partialText === "grandchild ready"), 15000);
		const nested = observer.handles().find(handle => handle.id !== parentId)!;
		assert.equal(nested.snapshot().parentRunId, parentId);
		assert.equal(nested.steer("inspect deeper"), true);
		await until(() => nested.snapshot().partialText.includes("received: inspect deeper"));
		observer.handles().find(handle => handle.id === parentId)!.stop("user");
		await running;
		await until(() => observer.handles().every(handle => !isActiveRun(handle.snapshot())));
		assert.equal(observer.handles().length, 2);
		assert.ok(nested.snapshot().transcript?.some(entry => entry.text.includes("grandchild ready")));
	} finally {
		await observer.shutdown(0.2);
		await running;
		await rm(directory, { recursive: true, force: true });
	}
});
