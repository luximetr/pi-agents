import assert from "node:assert/strict";
import test from "node:test";
import { CompletionInbox } from "../background-subagents.ts";

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
