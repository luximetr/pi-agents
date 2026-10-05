#!/usr/bin/env node
// Opt-in live-provider test. Uses your existing Pi credentials and consumes tokens.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-live-e2e-"));
const auditPath = path.join(root, "audit.jsonl");
const mainModel = process.env.E2E_MAIN_MODEL ?? "openai-codex/gpt-6.1-sol:medium";
const childModel = process.env.E2E_CHILD_MODEL ?? "openai-codex/gpt-6-luna";
/** Split `provider/vendor/model:thinking` without assuming the model ID has no slashes. */
const splitModel = value => {
  const colon = value.lastIndexOf(":");
  const hasThinking = colon > value.indexOf("/");
  const base = hasThinking ? value.slice(0, colon) : value;
  const slash = base.indexOf("/");
  const ref = slash === -1 ? { provider: undefined, model: base } : { provider: base.slice(0, slash), model: base.slice(slash + 1) };
  return hasThinking ? { ...ref, thinking: value.slice(colon + 1) } : ref;
};
const mainRef = splitModel(mainModel);
const childRef = splitModel(childModel);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`Artifacts: ${root}\nMain: ${mainModel}\nChild: ${childModel}`);

const auditExtension = path.join(root, "audit.ts");
await writeFile(auditExtension, `import { appendFileSync } from "node:fs";
export default function(pi) {
  for (const type of ["agent_start", "agent_settled", "message_end", "tool_execution_start", "tool_execution_end"]) {
    pi.on(type, event => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ at: Date.now(), run: process.env.PI_AGENTS_RUN_ID ?? "main", event }) + "\\n"));
  }
}`);
const wrapper = path.join(root, "pi-under-test.sh");
await writeFile(wrapper, `#!/bin/sh\nexec pi --no-extensions --extension ${quote(path.join(repo, "index.ts"))} --extension ${quote(auditExtension)} --no-skills --no-prompt-templates --no-context-files --approve "$@"\n`);
await chmod(wrapper, 0o700);
for (const name of ["lead", "worker"]) {
  const directory = path.join(root, ".pi-agents", name);
  await mkdir(directory, { recursive: true });
  const definition = name === "lead"
    ? { name, description: "Live E2E coordinator", default: true, tools: ["bash", "session_plan"], subagents: [{ name: "worker", model: childModel, timeoutSeconds: 120 }], systemPrompt: "Follow the user's exact test recipe. Only use the requested tools. Never poll subagents or invent extra tasks. After background completions, follow the requested recipe: report tokens concisely unless the recipe explicitly requests session_plan inspection. Do not invent extra tool calls." }
    : { name, description: "Live E2E worker", tools: ["bash"], systemPrompt: "Follow the task recipe exactly. For command tasks, execute the specified bash command once and respond only with the specified token. For memory/question tasks, do not use tools: remember the secret and ask the requested question. On a follow-up, use the saved conversation and return exactly what was requested." };
  await writeFile(path.join(directory, "agent.ts"), `export default ${JSON.stringify(definition)};\n`);
}

const text = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const audit = () => { try { return readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };

class Client {
  events = [];
  pending = new Map();
  counter = 0;
  constructor(name, sessionFile) {
    this.name = name;
    this.child = spawn(wrapper, ["--mode", "rpc", ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]), "--agent", "lead", "--model", mainModel], { cwd: root, env: { ...process.env, PI_CODING_AGENT_BIN: wrapper }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", error => { this.failure = error; });
    this.child.on("exit", (code, signal) => { this.exit = { code, signal }; });
    this.child.stderr.on("data", chunk => appendFileSync(path.join(root, `${name}.stderr.log`), chunk));
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "message_update") appendFileSync(path.join(root, `${name}.rpc.jsonl`), JSON.stringify({ at: Date.now(), event }) + "\n");
        this.events.push({ at: Date.now(), event });
        if (event.type === "response" && this.pending.has(event.id)) {
          const { resolve, reject, timer } = this.pending.get(event.id);
          clearTimeout(timer); this.pending.delete(event.id);
          event.success ? resolve(event.data) : reject(new Error(event.error));
        }
      }
    });
  }
  command(type, fields = {}) {
    const id = `${this.name}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
  }
  async until(predicate, label, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      if (this.failure || this.exit) throw this.failure ?? new Error(`Pi exited: ${JSON.stringify(this.exit)}`);
      const error = this.events.find(({ event }) => event.type === "message_end" && event.message?.stopReason === "error" && !(this.expectAbort && /aborted/i.test(event.message.errorMessage ?? "")));
      if (error) throw new Error(error.event.message.errorMessage ?? text(error.event.message));
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async close() {
    await this.command("abort").catch(() => {});
    this.child.stdin.end();
    for (let i = 0; i < 100 && !this.exit; i++) await sleep(100);
    if (!this.exit) this.child.kill("SIGTERM");
  }
}
const completion = client => client.events.filter(({ event }) => event.type === "message_end" && event.message?.customType === "pi-agents-completions");
const assistant = (client, token) => client.events.find(({ event }) => event.type === "message_end" && event.message?.role === "assistant" && text(event.message).includes(token));

async function parallelAndUserPriority() {
  const client = new Client("parallel");
  const since = Date.now();
  try {
    const state = await client.command("get_state");
    assert.equal(state.model.id, mainRef.model);
    if (mainRef.thinking) assert.equal(state.thinkingLevel, mainRef.thinking);
    await client.command("prompt", { message: 'Execute this test recipe: call delegate twice with agent "worker" and background true. Task A: execute bash command `sleep 18; printf CHILD_A` then reply only CHILD_A. Task B: execute bash command `sleep 18; printf CHILD_B` then reply only CHILD_B. Launch both before doing anything else. Then execute bash `sleep 8; printf MAIN_READY` and reply only MAIN_READY. Do not wait for child results or poll.' });
    const mainWork = await client.until(() => client.events.find(({ event }) => event.type === "tool_execution_start" && event.toolName === "bash" && event.args?.command?.includes("MAIN_READY")), "main working after spawn");
    const spawned = client.events.filter(({ event }) => event.type === "tool_execution_end" && event.toolName === "delegate");
    assert.equal(spawned.length, 2, "both delegate calls must return before main work");
    for (const { event } of spawned) assert.equal(event.result.details.status, "running");
    const start = Date.now();
    const response = await client.command("prompt", { message: "New user instruction: execute bash `sleep 22; printf USER_ACK` exactly once, then reply only USER_ACK. Do not retrieve or poll background results.", streamingBehavior: "followUp" });
    if (response?.disposition) assert.equal(response.disposition, "queued");
    else assert.ok((await client.command("get_state")).pendingMessageCount > 0, "older Pi must queue the user message");
    console.log(`PASS: user message accepted during main work in ${Date.now() - start}ms`);
    const ack = await client.until(() => assistant(client, "USER_ACK"), "queued user response");
    const delivered = await client.until(() => completion(client).find(({ event }) => text(event.message).includes("CHILD_A") && text(event.message).includes("CHILD_B")), "batched child completion");
    assert.ok(delivered.at >= ack.at, "completion must not interrupt queued user work");
    const childStarts = audit().filter(row => row.at >= since && row.run !== "main" && row.event.type === "tool_execution_start" && row.event.toolName === "bash");
    assert.equal(childStarts.length, 2);
    const childEnds = audit().filter(row => row.at >= since && row.run !== "main" && row.event.type === "tool_execution_end" && row.event.toolName === "bash");
    assert.equal(childEnds.length, 2);
    const childMessages = audit().filter(row => row.at >= since && row.run !== "main" && row.event.type === "message_end" && row.event.message?.role === "assistant");
    assert.ok(childMessages.length >= 2);
    for (const row of childMessages) {
      assert.equal(row.event.message.provider, childRef.provider);
      assert.equal(row.event.message.model, childRef.model);
    }
    assert.ok(Math.max(...childStarts.map(row => row.at)) < Math.min(...childEnds.map(row => row.at)), "child bash execution must overlap");
    assert.ok(mainWork.at < Math.min(...childEnds.map(row => row.at)), "main must work before children finish");
    assert.ok(Math.max(...childEnds.map(row => row.at)) < ack.at, "children must finish while user flow is still active");
    await client.until(() => assistant(client, "CHILD_A") && assistant(client, "CHILD_B"), "automatic result processing");
    console.log("PASS: two real child runs overlap; main continues; batched completions wait for queued user flow");
  } finally { await client.close(); }
}

async function abortAndResume() {
  const client = new Client("abort");
  const since = Date.now();
  try {
    await client.command("prompt", { message: 'Call delegate once with agent "worker", background true, task "Execute bash `sleep 10; printf CHILD_ESCAPE` exactly once, then reply only CHILD_ESCAPE". Then execute bash `sleep 60; printf MAIN_LONG` and reply only MAIN_LONG. Do not poll or wait for the child.' });
    await client.until(() => client.events.find(({ event }) => event.type === "tool_execution_start" && event.toolName === "bash" && event.args?.command?.includes("MAIN_LONG")), "main long-running operation");
    await client.until(() => audit().find(row => row.at >= since && row.run !== "main" && row.event.type === "tool_execution_start" && row.event.toolName === "bash"), "child started before abort");
    await client.command("clear_queue");
    client.expectAbort = true;
    await client.command("abort");
    const starts = client.events.filter(({ event }) => event.type === "agent_start").length;
    await client.until(() => audit().find(row => row.at >= since && row.run !== "main" && row.event.type === "agent_settled"), "child survives parent abort");
    await sleep(3000);
    assert.equal(completion(client).length, 0, "abort must suppress automatic completion delivery");
    assert.equal(client.events.filter(({ event }) => event.type === "agent_start").length, starts, "abort must suppress automatic wake-up");
    await client.command("prompt", { message: "Resume now. Report the waiting background result token. Do not call any tools." });
    await client.until(() => completion(client).find(({ event }) => text(event.message).includes("CHILD_ESCAPE")), "waiting result delivered on next user message");
    await client.until(() => assistant(client, "CHILD_ESCAPE"), "main processes waiting result");
    console.log("PASS: parent abort leaves child alive, suppresses wake-up, and preserves result for next user message");
  } finally { await client.close(); }
}

async function replyPreservesContext() {
  const client = new Client("reply");
  const secret = `THREAD_SECRET_${Date.now()}`;
  try {
    await client.command("prompt", { message: `Call delegate once with agent worker and background true. Its task must be: "Remember this secret: ${secret}. Do not print the secret yet. Ask exactly WHICH_COLOR? and stop. Do not use tools." Then reply only QUESTION_STARTED. Do not poll or call any other tools.` });
    const started = await client.until(() => client.events.find(({ event }) => event.type === "tool_execution_end" && event.toolName === "delegate"), "question delegation");
    const { runId, threadId } = started.event.result.details;
    assert.ok(runId && threadId);
    await client.until(() => completion(client).find(({ event }) => text(event.message).includes("WHICH_COLOR?")), "worker question");
    await client.until(() => client.events.at(-1)?.event.type === "agent_settled", "main settles after question");
    const reply = "Use blue. Reply with the remembered secret followed by :blue. Do not use tools.";
    await client.command("prompt", { message: `Call subagent_control exactly once with action reply, runId ${JSON.stringify(runId)}, and message ${JSON.stringify(reply)}. Do not repeat the secret in the tool arguments. Then reply only ANSWER_SENT. Do not poll or use other tools.` });
    const replied = await client.until(() => client.events.find(({ event }) => event.type === "tool_execution_end" && event.toolName === "subagent_control"), "reply starts new run");
    const replyCall = client.events.find(({ event }) => event.type === "tool_execution_start" && event.toolName === "subagent_control");
    assert.equal(replyCall.event.args.action, "reply");
    assert.equal(replyCall.event.args.message, reply);
    assert.ok(!JSON.stringify(replyCall.event.args).includes(secret));
    const next = replied.event.result.details;
    assert.equal(next.threadId, threadId);
    assert.notEqual(next.runId, runId);
    assert.equal(next.status, "running");
    await client.until(() => completion(client).find(({ event }) => event.message.details?.runs?.includes(next.runId) && text(event.message).includes(`${secret}:blue`)), "reply recalls saved context");
    const childAnswer = audit().find(row => row.run === next.runId && row.event.type === "message_end" && row.event.message?.role === "assistant" && text(row.event.message).includes(`${secret}:blue`));
    assert.ok(childAnswer, "a new child process must recall the secret absent from its reply prompt");
    console.log("PASS: reply starts a new run in the same thread and recalls saved context without repeating it");
  } finally { await client.close(); }
}

function planCalls(client, action, since = 0) {
  const starts = new Set(client.events.filter(row => row.at >= since && row.event.type === "tool_execution_start" && row.event.toolName === "session_plan" && row.event.args?.action === action).map(row => row.event.toolCallId));
  return client.events.filter(row => row.event.type === "tool_execution_end" && starts.has(row.event.toolCallId));
}
function inspectedState(client, since = 0) {
  for (const row of planCalls(client, "inspect", since).toReversed()) {
    try {
      const value = JSON.parse(text(row.event.result));
      if (Array.isArray(value.tasks) && Array.isArray(value.results)) return value;
    } catch {}
  }
}

async function durableCoordination() {
  const sessionFile = path.join(root, "coordination-parent.jsonl");
  let client = new Client("coordination", sessionFile);
  try {
    await client.command("prompt", { message: 'Execute this task-list test recipe using session_plan, delegate and bash only. First create one task with title COORDINATION_LOGIN, objective "Verify login coordination", and items [{"id":"implement","text":"Implement fix","status":"in_progress"},{"id":"review","text":"Review and verify","dependsOn":["implement"]}]. Save its returned task ID. Delegate worker in background with that taskId and itemId "implement"; its exact task is "Execute bash `sleep 8; printf COORDINATION_RESULT` once, then reply only COORDINATION_RESULT". Then reply only COORDINATION_STARTED. When the result arrives, leave its handling new and the task active, call session_plan inspect with no IDs once, then reply only WAITING_REVIEW. Do not handle the result or complete any items until I ask.' });
    await client.until(() => completion(client).some(row => text(row.event.message).includes("COORDINATION_RESULT")), "coordination result delivery");
    await client.until(() => assistant(client, "WAITING_REVIEW") && inspectedState(client)?.results?.length, "inspection without acknowledgement");
    let state = inspectedState(client);
    const task = state.tasks.find(task => task.title === "COORDINATION_LOGIN");
    assert.ok(task);
    const result = state.results.find(result => result.taskId === task.id);
    assert.ok(result, "delegation result must remain linked to its accepted task");
    assert.equal(result.itemId, "implement");
    assert.equal(result.handling, "new", "delivery and inspection must not handle the result");
    assert.equal(task.status, "active");
    assert.equal(state.focus, undefined, "no focus bookkeeping required");
    assert.equal(task.items.find(item => item.id === "implement").status, "in_progress");

    let since = Date.now();
    await client.command("prompt", { message: `Rename the existing task ${task.id} to "COORDINATION_LOGIN_UPDATED" using session_plan update; do not create another task. Inspect the full report for run ${result.runId} with session_plan result, then mark it handled with note "Read report" using handle_result. Keep unfinished items. Finally call session_plan inspect with no IDs and reply only COORDINATION_HANDLED.` });
    await client.until(() => assistant(client, "COORDINATION_HANDLED") && inspectedState(client, since), "explicit handled state");
    state = inspectedState(client, since);
    assert.equal(state.results.find(value => value.runId === result.runId).handling, "handled");
    assert.equal(state.tasks.length, 1, "update must change existing work");
    assert.equal(state.tasks[0].title, "COORDINATION_LOGIN_UPDATED");
    assert.equal(state.tasks[0].status, "active");

    since = Date.now();
    await client.command("prompt", { message: `Set run ${result.runId} handling to deferred with note "Waiting for login verification" using session_plan handle_result. Keep the existing task and checklist incomplete. Call session_plan inspect with no IDs, then reply only COORDINATION_DEFERRED.` });
    await client.until(() => assistant(client, "COORDINATION_DEFERRED") && inspectedState(client, since), "explicit deferred state");
    state = inspectedState(client, since);
    assert.equal(state.results.find(value => value.runId === result.runId).handling, "deferred");
    assert.equal(state.focus, undefined);
    await client.close();

    const restartedAt = Date.now();
    client = new Client("coordination-restored", sessionFile);
    await client.command("get_state");
    await client.command("prompt", { message: "Inspect the saved coordination state with session_plan inspect and no IDs, then reply only COORDINATION_RESTORED. Do not change any tasks, handling, or checklists; do not launch any workers." });
    await client.until(() => assistant(client, "COORDINATION_RESTORED") && inspectedState(client), "coordination restoration after restart");
    state = inspectedState(client);
    assert.equal(state.tasks.find(value => value.id === task.id).status, "active");
    assert.equal(state.tasks.find(value => value.id === task.id).title, "COORDINATION_LOGIN_UPDATED");
    assert.equal(state.focus, undefined);
    assert.equal(state.results.find(value => value.runId === result.runId).handling, "deferred");
    assert.equal(audit().filter(row => row.at >= restartedAt && row.run !== "main" && row.event.type === "agent_start").length, 0, "restoration must not restart workers");

    since = Date.now();
    await client.command("prompt", { message: `Finish this controlled task test. Read run ${result.runId} with session_plan result and verify that its report contains COORDINATION_RESULT. Mark that report handled with note "Verified the expected fixture token". Mark the existing task ${task.id} item implement completed, then item review completed, using session_plan update_item. Do not update the task status explicitly: the last item should close it automatically. Finally call session_plan inspect with no IDs and reply only COORDINATION_COMPLETED. Do not delegate or run bash.` });
    await client.until(() => assistant(client, "COORDINATION_COMPLETED") && inspectedState(client, since), "verified items complete the task automatically");
    state = inspectedState(client, since);
    assert.equal(state.tasks.find(value => value.id === task.id).status, "completed");
    assert.ok(state.tasks.find(value => value.id === task.id).items.every(item => item.status === "completed"));
    assert.equal(state.results.find(value => value.runId === result.runId).handling, "handled");
    assert.equal(planCalls(client, "update", since).length, 0, "item closure must not need an explicit task-status update");
    assert.equal(audit().filter(row => row.at >= restartedAt && row.run !== "main" && row.event.type === "agent_start").length, 0, "handling and completion must not restart workers");
    await writeFile(path.join(root, "coordination-completed.json"), JSON.stringify(state, null, 2) + "\n");
    console.log("PASS: live session_plan links reports, preserves item progress and unfinished work, restores without restarting workers, and automatically closes the verified task");
  } finally { await client.close(); }
}

if (!process.argv.includes("--coordination-only")) {
  await parallelAndUserPriority();
  await abortAndResume();
  await replyPreservesContext();
}
await durableCoordination();
console.log("Live background delegation, reply and durable coordination E2E passed.");
