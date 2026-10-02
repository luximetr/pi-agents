#!/usr/bin/env node
// Opt-in: real Pi RPC/provider test; consumes tokens using existing credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-stop-queue-"));
const model = process.env.E2E_CHILD_MODEL ?? "openai-codex/gpt-6-luna";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
console.log(`Artifacts: ${root}\nModel: ${model}`);
const wrapper = path.join(root, "pi-under-test.sh");
await writeFile(wrapper, `#!/bin/sh\nexec pi --no-extensions --extension ${quote(path.join(repo, "index.ts"))} --no-skills --no-prompt-templates --no-context-files --approve "$@"\n`);
await chmod(wrapper, 0o700);
await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `export default ${JSON.stringify({ name: "worker", description: "Controlled stop test", tools: ["bash"], systemPrompt: "Follow the exact user test recipe. Use only requested bash calls. Do not retry interrupted commands. Follow newer instructions when supplied." })};\n`);
const recipe = "Call bash exactly once with command `sleep 60; printf ORIGINAL_DONE`, then reply ORIGINAL_DONE. Do not shorten the sleep. Do not retry if interrupted.";
const queued = marker => `New instruction: execute bash exactly once with command ${JSON.stringify(`printf QUEUED_RAN > ${quote(marker)}`)}, then reply only QUEUED_RAN. Do not run the previous sleep again.`;

async function baseline() {
  const marker = path.join(root, "unsafe-queued-ran");
  const events = [];
  const child = spawn(wrapper, ["--mode", "rpc", "--no-session", "--agent", "worker", "--model", model], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let exit, failure, buffer = "", counter = 0, expectAbort = false;
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  child.on("error", error => { failure = error; });
  child.stderr.on("data", data => appendFileSync(path.join(root, "baseline.stderr.log"), data));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line); events.push(event);
        if (event.type !== "message_update") appendFileSync(path.join(root, "baseline.rpc.jsonl"), JSON.stringify(event) + "\n");
      } catch {}
    }
  });
  async function until(predicate, label, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = predicate(); if (value) return value;
      if (failure || exit) throw failure ?? new Error(`Pi exited: ${JSON.stringify(exit)}`);
      const error = events.find(event => event.type === "message_end" && event.message?.stopReason === "error" && !(expectAbort && /aborted/i.test(event.message.errorMessage ?? "")));
      if (error) throw new Error(error.message.errorMessage);
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function command(type, fields = {}) {
    const id = `test-${++counter}`;
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const response = await until(() => events.find(event => event.type === "response" && event.id === id), type);
    assert.equal(response.success, true, response.error);
    return response.data;
  }
  try {
    await command("prompt", { message: recipe });
    await until(() => events.some(event => event.type === "tool_execution_start" && event.toolName === "bash" && event.args.command.includes("sleep 60")), "sleeping tool");
    await command("steer", { message: queued(marker) });
    assert.ok((await command("get_state")).pendingMessageCount > 0, "steering must genuinely be queued before abort");
    expectAbort = true;
    await command("abort"); // Deliberately reproduce the old, unsafe protocol.
    const delivered = events.some(event => event.type === "message_end" && event.message?.role === "user" && JSON.stringify(event.message.content).includes("unsafe-queued-ran"));
    assert.ok(delivered || existsSync(marker), "abort alone must demonstrate queued steering consumption");
    console.log(`REPRODUCED: abort alone consumed queued steering. Queued bash execution observed: ${existsSync(marker)}.`);
  } finally {
    if (!exit) {
      child.stdin.write(JSON.stringify({ type: "clear_queue" }) + "\n" + JSON.stringify({ type: "abort" }) + "\n");
      child.stdin.end();
      for (let i = 0; i < 100 && !exit; i++) await sleep(20);
      if (!exit) child.kill("SIGTERM");
      for (let i = 0; i < 100 && !exit; i++) await sleep(20);
      if (!exit) child.kill("SIGKILL");
    }
  }
}

async function fixedRunner() {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { runSubagent, SubagentStoppedError } = await jiti.import(path.join(repo, "subagents.ts"));
  const marker = path.join(root, "safe-queued-ran");
  let handle, stopSent = false, toolStarted = false;
  const sessionDir = path.join(root, "sessions");
  const running = runSubagent("worker", recipe, root, AbortSignal.timeout(120000), {
    executable: wrapper, model, participantSessionDir: sessionDir, gracefulStopSeconds: 8,
    onHandle: value => { if (value) handle = value; },
    onProgress: event => {
      if (event.type === "tool-start" && event.tool === "bash" && !toolStarted) {
        toolStarted = true;
        assert.equal(handle.steer(queued(marker)), true);
      }
    },
  });
  const poll = setInterval(() => {
    if (!stopSent && handle?.snapshot().transcript?.some(entry => entry.text.includes("Steering accepted by child"))) {
      stopSent = true;
      handle.stop("user");
    }
  }, 20);
  try {
    await assert.rejects(running, error => error instanceof SubagentStoppedError && error.reason === "user");
    assert.ok(toolStarted && stopSent, "must stop during real tool work after acknowledged steering");
    assert.equal(existsSync(marker), false, "stopped child must not execute queued steering");
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(sessionDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const session = await readFile(path.join(sessionDir, file), "utf8");
      assert.ok(!session.includes("safe-queued-ran"), "queued instruction must not become a conversation turn");
    }
    console.log("PASS: runner clears acknowledged steering before abort; no queued action or conversation turn occurs.");
  } finally {
    clearInterval(poll);
    appendFileSync(path.join(root, "runner.snapshot.json"), JSON.stringify(handle?.snapshot(), null, 2));
    handle?.stop("user");
  }
}

if (!process.argv.includes("--fixed-only")) await baseline();
if (!process.argv.includes("--baseline-only")) await fixedRunner();
