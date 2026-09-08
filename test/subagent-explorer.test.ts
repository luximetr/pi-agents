import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentObserver, isActiveRun, newRunId } from "../subagent-observer.ts";
import { buildRunTree, showSubagentInspector } from "../subagent-explorer.ts";
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

test("resumable queues are observable, controllable, retained, and transition under one run id", async () => {
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
		const base = { executable, lifecycle: "resumable" as const, rootSessionId: "root", participantIdentity: "worker", participantSessionDir: path.join(directory, "sessions") };
		const startHolder = (task: string) => {
			const promise = runSubagent("worker", task, directory, new AbortController().signal, base);
			running.push(promise);
			return promise;
		};
		const waitForStarts = (count: number) => until(() => {
			try { return readFileSync(starts, "utf8").trim().split("\n").length >= count; } catch { return false; }
		});
		const observe = (id: string, task: string, extra: Record<string, unknown> = {}, owner = observer) => runSubagent("worker", task, directory, new AbortController().signal, {
			...base, ...extra, id,
			onHandle: handle => { if (handle) owner.attach(handle); },
			onSnapshot: value => owner.publish(value),
		});

		const holder1 = startHolder("holder user");
		await waitForStarts(1);
		const userRun = observe("queued-user", "queued user");
		await until(() => observer.handles().some(value => value.id === "queued-user" && value.snapshot().phase.includes("queued")));
		const queuedUser = observer.handles().find(value => value.id === "queued-user")!;
		assert.equal(queuedUser.steer("not yet"), false);
		queuedUser.stop("user");
		await assert.rejects(userRun, (error: unknown) => error instanceof SubagentStoppedError && error.reason === "user");
		assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 1, "individual cancellation does not launch the waiter");
		assert.equal(await holder1, "done:holder user", "individual cancellation does not stop the holder");

		const holder2 = startHolder("holder timeout");
		await waitForStarts(2);
		await assert.rejects(observe("queued-timeout", "queued timeout", { timeoutSeconds: 0.05 }), (error: unknown) => error instanceof SubagentStoppedError && error.reason === "timeout");
		const timedOut = observer.handles().find(value => value.id === "queued-timeout")!.snapshot();
		assert.equal(timedOut.stopReason, "timeout");
		assert.ok(timedOut.recentEvents.some(event => event.includes("deadline reached while queued")));
		await holder2;

		const holder3 = startHolder("holder transition");
		await waitForStarts(3);
		const transitionedRun = observe("stable-transition-id", "spawn after queue");
		await until(() => observer.handles().some(value => value.id === "stable-transition-id" && value.snapshot().phase.includes("queued")));
		const transitioning = observer.handles().find(value => value.id === "stable-transition-id")!;
		assert.equal(transitioning.steer("not while queued"), false);
		await waitForStarts(4);
		assert.equal(transitioning.steer("after spawn"), true);
		assert.equal(await transitionedRun, "done:spawn after queue;steer:after spawn");
		const transitioned = observer.handles().find(value => value.id === "stable-transition-id")!.snapshot();
		assert.equal(transitioned.status, "finished");
		assert.equal(transitioned.id, "stable-transition-id");
		await holder3;

		const holder4 = startHolder("holder shutdown");
		await waitForStarts(5);
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
		await until(() => observer.handles().some(handle => handle.snapshot().partialText === "grandchild ready"), 15000);
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
