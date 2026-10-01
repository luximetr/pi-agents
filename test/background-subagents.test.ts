import assert from "node:assert/strict";
import test from "node:test";
import { CompletionInbox, backgroundRunStatus, type BackgroundRunState } from "../background-subagents.ts";
import type { SubagentSnapshot } from "../subagents.ts";

const run: BackgroundRunState = { agent: "worker", task: "inspect files", status: "running", model: "test/model:high", startedAt: 1000, deadlineAt: 6000 };
const snapshot: SubagentSnapshot = {
	id: "run-1", agent: "worker", task: run.task, status: "running", phase: "tool execution", currentTool: "read",
	startedAt: 1200, lastActivityAt: 2000, deadlineAt: 6200, partialText: "private response", recentEvents: ["private event"],
	currentToolArgs: { path: "private.txt" }, transcript: [{ id: "entry-1", kind: "assistant", text: "private transcript" }],
	usage: { provider: "test", model: "model", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
};

test("background status is available before observation and omits absent deadlines", () => {
	const status = backgroundRunStatus("run-1", { ...run, deadlineAt: undefined }, undefined, 3000);
	assert.equal(status.status, "running");
	assert.equal(status.phase, "starting");
	assert.equal(status.model, "test/model:high");
	assert.equal(status.elapsedMs, 2000);
	assert.equal(status.idleMs, 2000);
	assert.equal(status.remainingMs, undefined);
});

test("background status exposes compact live timing and operation without transcript data", () => {
	const status = backgroundRunStatus("run-1", run, snapshot, 3000);
	assert.equal(status.phase, "tool execution");
	assert.equal(status.currentTool, "read");
	assert.equal(status.elapsedMs, 1800);
	assert.equal(status.idleMs, 1000);
	assert.equal(status.remainingMs, 3200);
	assert.equal(status.model, "test/model:high");
	assert.doesNotMatch(JSON.stringify(status), /private|transcript|recentEvents|currentToolArgs/);
	assert.equal(snapshot.partialText, "private response", "reading status does not mutate observation");
});

test("background status distinguishes queue waits and stopping, and clamps overdue deadlines", () => {
	assert.equal(backgroundRunStatus("run-1", run, { ...snapshot, phase: "queued for resumable participant" }, 7000).phase, "queued for resumable participant");
	const status = backgroundRunStatus("run-1", run, { ...snapshot, status: "stopping", phase: "stopping" }, 7000);
	assert.equal(status.status, "stopping");
	assert.equal(status.remainingMs, 0);
});

test("terminal background statuses override observations and freeze timing", () => {
	for (const status of ["completed", "failed", "timed_out", "interrupted"]) {
		const terminal = { ...run, status, endedAt: 4000 };
		const result = backgroundRunStatus("run-1", terminal, snapshot, 9000);
		assert.equal(result.status, status);
		assert.equal(result.phase, status);
		assert.equal(result.elapsedMs, 2800);
		assert.equal(result.idleMs, 2000);
		assert.equal(result.currentTool, undefined);
		assert.equal(result.remainingMs, undefined);
		assert.deepEqual(result, backgroundRunStatus("run-1", terminal, snapshot, 12000));
	}
});

const tick = () => new Promise(resolve => setTimeout(resolve, 60));

test("busy runs accumulate completions and deliver one batch after settling", async () => {
	const batches: string[][] = [];
	const inbox = new CompletionInbox<string>(() => true, results => batches.push(results));
	inbox.start();
	inbox.push("A");
	inbox.push("B");
	await tick();
	assert.deepEqual(batches, []);
	inbox.settle();
	await tick();
	assert.deepEqual(batches, [["A", "B"]]);
	inbox.close();
});

test("idle completions wake the agent, but never if it starts working before delivery", async () => {
	const batches: string[][] = [];
	const inbox = new CompletionInbox<string>(() => true, results => batches.push(results));
	inbox.push("A");
	inbox.start();
	await tick();
	assert.deepEqual(batches, []);
	inbox.settle();
	await tick();
	assert.deepEqual(batches, [["A"]]);
	inbox.push("B");
	await tick();
	assert.deepEqual(batches, [["A"], ["B"]]);
	inbox.close();
});

test("abort pauses wake-ups until user input; results remain retrievable", async () => {
	const batches: string[][] = [];
	const inbox = new CompletionInbox<string>(() => true, results => batches.push(results));
	inbox.start();
	inbox.pause();
	inbox.push("A");
	inbox.settle();
	await tick();
	assert.deepEqual(batches, []);
	assert.deepEqual(inbox.take(), ["A"]);
	inbox.push("B");
	inbox.resume();
	inbox.start();
	inbox.settle();
	await tick();
	assert.deepEqual(batches, [["B"]]);
	inbox.close();
});

test("queued user messages take priority and shutdown discards pending deliveries", async () => {
	let pendingUser = true;
	const batches: string[][] = [];
	const inbox = new CompletionInbox<string>(() => !pendingUser, results => batches.push(results));
	inbox.push("A");
	await tick();
	assert.deepEqual(batches, []);
	pendingUser = false;
	inbox.start();
	inbox.settle();
	await tick();
	assert.deepEqual(batches, [["A"]]);
	inbox.push("B");
	inbox.close();
	inbox.push("C");
	await tick();
	assert.deepEqual(batches, [["A"]]);
});
