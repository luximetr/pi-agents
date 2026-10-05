#!/usr/bin/env node
// Actual Pi RPC host + extension + controlled child processes. No provider or credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-agents-session-e2e-")));
const agentDir = path.join(root, "pi-home");
const sessionFile = path.join(root, "parent.jsonl");
const launchesFile = path.join(root, "launches.jsonl");
const reportFile = path.join(root, "report.json");
const restoredFile = path.join(root, "restored.json");
const completionFile = path.join(root, "completions.jsonl");
const childExecutable = path.join(root, "controlled-child.mjs");
const fixtureExtension = path.join(root, "fixture.ts");
await mkdir(agentDir, { mode: 0o700 });
// Pi lazily writes brand-new sessions only after an assistant turn. Seed just the
// normal session header so this provider-free test can reopen a stable session.
await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root }) + "\n", { mode: 0o600 });
for (const name of ["lead", "worker"]) {
  const directory = path.join(root, ".pi-agents", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent.ts"), `export default ${JSON.stringify({ name, description: "Controlled session E2E", default: name === "lead", tools: [], ...(name === "lead" ? { subagents: [{ name: "worker", model: "@fast" }] } : {}) })};\n`);
}
// Model aliases are global-only. The controlled worker records the --model it
// actually received, so alias resolution is proven inside the real Pi host.
await mkdir(path.join(agentDir, "pi-agents"), { recursive: true });
await writeFile(path.join(agentDir, "pi-agents", "config.json"), JSON.stringify({
  models: [{ id: "m_controlled", name: "fast", model: "test/alias-model:max" }],
}, null, 2));
await writeFile(childExecutable, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const file = process.argv[process.argv.indexOf('--session') + 1];
let buffer = '', timer;
const emit = event => console.log(JSON.stringify(event));
process.stdin.on('data', chunk => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (command.type === 'abort') { clearTimeout(timer); emit({ type: 'agent_settled' }); continue; }
    if (command.type !== 'prompt') continue;
    appendFileSync(${JSON.stringify(launchesFile)}, JSON.stringify({ at: Date.now(), task: command.message, model: process.argv[process.argv.indexOf('--model') + 1] }) + '\\n');
    const entries = readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
    let parentId = entries.length > 1 ? entries.at(-1).id : null;
    const save = message => {
      const id = randomUUID();
      appendFileSync(file, JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { ...message, timestamp: Date.now() } }) + '\\n'); parentId = id;
    };
    save({ role: 'user', content: command.message });
    emit({ type: 'agent_start' });
    timer = setTimeout(() => {
      const message = { role: 'assistant', content: [{ type: 'text', text: 'CONTROLLED_RESULT:' + command.message }], stopReason: 'stop' };
      save(message); emit({ type: 'message_end', message }); emit({ type: 'agent_settled' });
    }, 500);
  }
});
process.stdin.on('end', () => process.exit(0));
`);
await chmod(childExecutable, 0o700);
await writeFile(fixtureExtension, `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import extension from ${JSON.stringify(path.join(repo, "index.ts"))};
export default function(pi) {
  const tools = new Map();
  // Use the real registration and lifecycle. Suppress only model wake-up: this is
  // a provider-free host test, while recording actual completion delivery.
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return tool => { tools.set(tool.name, tool); pi.registerTool(tool); };
    if (key === 'sendMessage') return (message, options) => {
      if (message.customType === 'pi-agents-completions') {
        appendFileSync(${JSON.stringify(completionFile)}, JSON.stringify({ message, options }) + '\\n');
        return pi.sendMessage(message, { ...options, triggerTurn: false });
      }
      return pi.sendMessage(message, options);
    };
    return target[key];
  } });
  extension(proxy);
  const invoke = (name, params, ctx) => tools.get(name).execute('controlled-' + Date.now(), params, undefined, undefined, ctx);
  const plan = async (params, ctx) => JSON.parse((await invoke('session_plan', params, ctx)).content[0].text);
  pi.registerCommand('coordination-setup', { description: 'Run isolated provider-free E2E fixture', handler: async (_args, ctx) => {
    try {
      assert.ok(pi.getActiveTools().includes('session_plan'), 'bookkeeping tool must be enabled even with tools: []');
      const task = await plan({ action: 'create', title: 'Controlled login', objective: 'Verify durable coordination in real Pi', items: [{ id: 'api', text: 'API checks', status: 'in_progress' }, { id: 'auth', text: 'Auth checks', status: 'in_progress' }] }, ctx);
      const first = await invoke('delegate', { agent: 'worker', task: 'API', taskId: task.id, itemId: 'api', background: true }, ctx);
      const second = await invoke('delegate', { agent: 'worker', task: 'AUTH', taskId: task.id, itemId: 'auth', background: true }, ctx);
      assert.equal(first.details.status, 'running'); assert.equal(second.details.status, 'running');
      let state;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        state = await plan({ action: 'inspect' }, ctx);
        if (state.results.length === 2) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(state.results.length, 2, 'both child processes must finish');
      assert.equal(state.focus, undefined, 'no focus bookkeeping required');
      const launches = readFileSync(${JSON.stringify(launchesFile)}, 'utf8').trim().split('\\n').map(JSON.parse);
      assert.ok(launches.length === 2 && launches.every(launch => launch.model === 'test/alias-model:max'), 'the @fast alias resolves before the child launch: ' + JSON.stringify(launches));
      assert.ok(state.results.every(result => result.handling === 'new' && result.taskId === task.id));
      assert.deepEqual(new Set(state.results.map(result => result.itemId)), new Set(['api', 'auth']));
      const result = await plan({ action: 'result', runId: first.details.runId }, ctx);
      assert.equal(result.handling, 'new');
      assert.match(result.text, /CONTROLLED_RESULT:API/);
      await plan({ action: 'update', taskId: task.id, amendment: 'Keep public API stable' }, ctx);
      await plan({ action: 'handle_result', runId: first.details.runId, handling: 'reviewed', note: 'Read; verification remains' }, ctx);
      await plan({ action: 'handle_result', runId: second.details.runId, handling: 'deferred', note: 'Review after API checks' }, ctx);
      await assert.rejects(plan({ action: 'update', taskId: task.id, status: 'completed' }, ctx), /unfinished|pending|complete|outstanding/i);
      state = await plan({ action: 'inspect' }, ctx);
      assert.equal(state.tasks[0].status, 'active');
      writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ ok: true, first: first.details, second: second.details, state }, null, 2));
    } catch (error) { writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ ok: false, error: String(error), stack: error.stack })); }
  } });
  pi.registerCommand('coordination-restore', { description: 'Verify isolated state after host restart', handler: async (_args, ctx) => {
    try {
      const previous = JSON.parse(readFileSync(${JSON.stringify(reportFile)}, 'utf8'));
      const state = await plan({ action: 'inspect' }, ctx);
      assert.equal(state.focus, undefined, 'no focus bookkeeping required');
      assert.equal(state.tasks[0].id, previous.state.tasks[0].id);
      assert.equal(state.tasks[0].status, 'active');
      assert.ok(state.tasks[0].amendments.includes('Keep public API stable'));
      assert.equal(state.results.find(result => result.runId === previous.first.runId).handling, 'reviewed');
      assert.equal(state.results.find(result => result.runId === previous.second.runId).handling, 'deferred');
      assert.equal(readFileSync(${JSON.stringify(launchesFile)}, 'utf8').trim().split('\\n').length, 2, 'reload never restarts workers');
      for (const result of state.results) await plan({ action: 'handle_result', runId: result.runId, handling: 'incorporated' }, ctx);
      for (const item of state.tasks[0].items) await plan({ action: 'update_item', taskId: state.tasks[0].id, itemId: item.id, status: 'completed' }, ctx);
      const completedState = await plan({ action: 'inspect' }, ctx);
      assert.equal(completedState.tasks[0].status, 'completed', 'last verified item closes its task automatically');
      writeFileSync(${JSON.stringify(restoredFile)}, JSON.stringify({ ok: true, state, completedState }, null, 2));
    } catch (error) { writeFileSync(${JSON.stringify(restoredFile)}, JSON.stringify({ ok: false, error: String(error), stack: error.stack })); }
  } });
}
`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Client {
  events = [];
  constructor(name) {
    this.child = spawn(process.env.PI_CODING_AGENT_BIN ?? "pi", ["--offline", "--mode", "rpc", "--session", sessionFile, "--no-extensions", "--extension", fixtureExtension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--approve", "--agent", "lead"], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_BIN: childExecutable }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", error => { this.failure = error; });
    this.child.on("exit", (code, signal) => { this.exit = { code, signal }; });
    this.child.stderr.on("data", data => appendFileSync(path.join(root, `${name}.stderr.log`), data));
    let buffer = "";
    this.child.stdout.on("data", data => {
      buffer += data; let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const event = JSON.parse(line); this.events.push(event); appendFileSync(path.join(root, `${name}.rpc.jsonl`), line + "\n"); } catch {}
      }
    });
  }
  async wait(predicate, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const value = predicate(); if (value) return value;
      if (this.failure || this.exit) throw this.failure ?? new Error(`Pi exited: ${JSON.stringify(this.exit)}`);
      await sleep(25);
    }
    throw new Error(`Timed out: ${label}. Inspect logs in ${root}`);
  }
  async command(type, fields = {}) {
    const id = String(Date.now());
    this.child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const response = await this.wait(() => this.events.find(event => event.type === "response" && event.id === id), type);
    assert.equal(response.success, true, response.error);
    return response.data;
  }
  async close() {
    if (this.exit) return;
    await this.command("abort").catch(() => {});
    this.child.stdin.end();
    for (let i = 0; i < 80 && !this.exit; i++) await sleep(25);
    if (!this.exit) this.child.kill("SIGTERM");
    for (let i = 0; i < 80 && !this.exit; i++) await sleep(25);
    if (!this.exit) this.child.kill("SIGKILL");
  }
}
console.log(`Artifacts: ${root}\nProvider-free actual Pi RPC host; controlled worker processes.`);
let client = new Client("initial");
try {
  await client.command("get_state");
  await client.command("prompt", { message: "/coordination-setup" });
  await client.wait(() => existsSync(reportFile), "setup result");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(report.ok, true, report.stack ?? report.error);
  await client.wait(() => existsSync(completionFile), "safe-boundary completion delivery");
  const deliveries = readFileSync(completionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(deliveries.every(row => row.options.triggerTurn === true && row.options.deliverAs === "followUp"));
  assert.equal(client.events.filter(event => event.type === "agent_start").length, 0, "controlled test must never call a model");
  await client.close();
  client = new Client("restored");
  await client.command("get_state");
  await client.command("prompt", { message: "/coordination-restore" });
  await client.wait(() => existsSync(restoredFile), "restored result");
  const restored = JSON.parse(readFileSync(restoredFile, "utf8"));
  assert.equal(restored.ok, true, restored.stack ?? restored.error);
  assert.equal(client.events.filter(event => event.type === "agent_start").length, 0);
  console.log("PASS: real Pi loads the extension, resolves a global model alias into the child --model argument, launches two controlled workers, delivers linked reports, preserves checklist progress and explicit handling, rejects unfinished completion, restores without restarting workers, and closes verified checklists automatically.");
} finally { await client.close(); }
