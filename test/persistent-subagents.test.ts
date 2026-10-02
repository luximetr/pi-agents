import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PersistentSubagentBackend, type PersistentBackendOptions } from "../background-subagents.ts";
import { TaskHistoryStore } from "../task-history.ts";
import { SubagentStoppedError, validateRecoverableParticipantSession } from "../subagents.ts";

const signal = () => new AbortController().signal;
const input = { threadId: "thread", runId: "run-1", owner: "lead", agent: "worker", instruction: "original instruction" };
const waitFor = async (predicate: () => Promise<boolean>) => {
	const end = Date.now() + 15000;
	while (!await predicate()) { assert.ok(Date.now() < end, "condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-persistent-backend-")));
	const project = path.join(base, "project");
	await mkdir(project);
	const log = path.join(base, "launches.jsonl");
	const executable = path.join(base, "fake-pi.mjs");
	await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const file = process.argv[process.argv.indexOf('--session') + 1];
const entries = readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
if ((statSync(file).mode & 0o077) !== 0) process.exit(12);
let parentId = entries.at(-1).type === 'session' ? null : entries.at(-1).id;
const append = message => {
 const id = randomUUID(); appendFileSync(file, JSON.stringify({type:'message', id, parentId, timestamp:new Date().toISOString(), message:{...message, timestamp:Date.now()}})+'\\n'); parentId=id;
};
const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
let buffer = '', busy, noRun = false;
process.stdin.on('data', chunk => {
 buffer += chunk;
 let n;
 while ((n = buffer.indexOf('\\n')) >= 0) {
  const command = JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1);
  if (command.type === 'abort') { clearInterval(busy); emit({type:'agent_settled'}); continue; }
  if (command.type !== 'prompt') continue;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid, task:command.message, cwd:process.cwd(), file, prior:entries})+'\\n');
  emit({type:'response', id:'unrelated', command:'prompt', success:false, error:'unrelated rejection'});
  if (command.message.includes('RPC_REJECT') || command.message.includes('RPC_HANDLED')) {
   noRun = true;
   emit({type:'response', id:command.id, command:'prompt', success:!command.message.includes('RPC_REJECT'), error:'initial prompt denied', data:{disposition:'handled'}});
   continue;
  }
  emit({type:'agent_start'});
  if (command.message.startsWith('ACTIVE_HANDLED')) emit({type:'response', id:command.id, command:'prompt', success:true, data:{disposition:'handled'}});
  append({role:'user', content:command.message});
  append({role:'assistant', content:[{type:'text',text:'saved answer'}], stopReason:'stop'});
  emit({type:'message_end', message:{role:'assistant', content:[{type:'text',text:'saved answer'}], stopReason:'stop'}});
  if (command.message.includes('EARLY_EXIT')) {
   process.stdout.end();
   writeFileSync(${JSON.stringify(path.join(base, "closing"))}, 'ready');
   busy=setInterval(()=>{
    if (!existsSync(${JSON.stringify(path.join(base, "allow-close"))})) return;
    append({role:'assistant', content:[{type:'text',text:'shutdown flushed'}], stopReason:'stop'});
    process.exit(0);
   },10);
  } else if (command.message.includes('HOLD')) {
   busy=setInterval(()=>{},1000);
   if (command.message.includes('PENDING')) setTimeout(()=>{
    append({role:'assistant', content:[{type:'toolCall',id:'unfinished',name:'bash',arguments:{command:'external effect'}}], stopReason:'toolUse'});
    writeFileSync(${JSON.stringify(path.join(base, "pending"))}, 'ready');
    emit({type:'message_end', message:{role:'assistant', content:[], stopReason:'toolUse'}});
   },500);
  } else emit({type:'agent_settled'});
 }
});
process.stdin.on('end',()=>{
 if (noRun) {
  writeFileSync(${JSON.stringify(path.join(base, "closing"))}, 'ready');
  setInterval(()=>{
   if (!existsSync(${JSON.stringify(path.join(base, "allow-close"))})) return;
   append({role:'assistant', content:[{type:'text',text:'shutdown flushed'}], stopReason:'stop'});
   process.exit(0);
  },10);
 } else if (!busy || busy._destroyed) process.exit(0);
});
`);
	await chmod(executable, 0o755);
	const options: PersistentBackendOptions = { scope: { rootSessionId: "stable-root", projectCwd: project }, directory: path.join(base, "history"),
		env: { PI_AGENTS_TASK_HISTORY: "1" }, authorize: () => true, checkpointIntervalMs: 20 };
	const backend = (await PersistentSubagentBackend.open(options))!;
	t.after(async () => { await backend.shutdown(); await rm(base, { recursive: true, force: true }); });
	const launches = async () => { try { return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } };
	return { base, project, options, backend, executable, launches };
}

for (const disposition of ["RPC_REJECT", "RPC_HANDLED", "EARLY_EXIT"]) {
	test(`initial prompt ${disposition} closes the child before releasing history and preserves recovery`, async t => {
		const f = await fixture(t);
		await f.backend.run(input, signal(), { executable: f.executable });
		const other = (await PersistentSubagentBackend.open(f.options))!;
		let completed = false;
		const outcome = f.backend.recover({ ...input, latestRunId: "run-1", runId: "run-2", instruction: disposition }, AbortSignal.timeout(5000), { executable: f.executable, gracefulStopSeconds: 2 })
			.then(value => { completed = true; return value; }, error => { completed = true; return error as Error; });
		try {
			await waitFor(async () => { try { await lstat(path.join(f.base, "closing")); return true; } catch { return false; } });
			assert.equal(completed, false, "EOF alone must not release execution ownership");
			await assert.rejects(other.delete(input.threadId), /ownership is still reserved/);
			await writeFile(path.join(f.base, "allow-close"), "close");
			const result = await outcome;
			if (disposition === "RPC_REJECT") assert.equal((result as Error).message, "initial prompt denied");
			else if (disposition === "EARLY_EXIT") assert.match((result as Error).message, /before agent_settled/);
			else { assert.ok(!(result instanceof Error)); assert.match(result.text, /handled without starting an agent run/); }
			const pid = (await f.launches())[1].pid;
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			const [saved] = await other.list();
			assert.equal(saved.record?.status, disposition === "RPC_HANDLED" ? "completed" : "failed");
			assert.equal(saved.recoverable, true, saved.error);
			await other.recover({ ...input, latestRunId: "run-2", runId: "run-3", instruction: "Continue explicitly" }, signal(), { executable: f.executable });
			assert.match(JSON.stringify((await f.launches())[2].prior), /shutdown flushed/);
		} finally {
			await writeFile(path.join(f.base, "allow-close"), "close");
			await other.shutdown();
			await outcome;
		}
	});
}

test("handled prompt with an already active run still waits for its result", async t => {
	const f = await fixture(t);
	assert.equal((await f.backend.run({ ...input, instruction: "ACTIVE_HANDLED" }, signal(), { executable: f.executable })).text, "saved answer");
});

test("opt-in is exact and default off performs no storage or authorization work", async () => {
	for (const flag of [undefined, "0", "true", ""]) {
		assert.equal(await PersistentSubagentBackend.open({ scope: { rootSessionId: "", projectCwd: "/unavailable" }, env: { PI_AGENTS_TASK_HISTORY: flag }, authorize: () => { throw new Error("must not authorize"); } }), undefined);
	}
});

test("real child lifecycle persists completed tasks, reloads safely, and recovers only on a fresh instruction", async t => {
	const f = await fixture(t);
	assert.equal((await f.backend.run(input, signal(), { executable: f.executable })).text, "saved answer");
	await f.backend.shutdown();
	const reopened = (await PersistentSubagentBackend.open(f.options))!;
	try {
		const [saved] = await reopened.list();
		assert.equal(saved.record?.status, "completed");
		assert.equal(saved.recoverable, true);
		assert.equal((await f.launches()).length, 1, "discovery never launches a child");
		await assert.rejects(reopened.recover({ ...input, runId: "run-2", latestRunId: "run-1", instruction: " " }, signal(), { executable: f.executable }), /fresh/);
		const continued = await reopened.recover({ ...input, runId: "run-2", latestRunId: "run-1", instruction: "inspect changes, then continue" }, signal(), { executable: f.executable });
		assert.ok(continued.recovery?.savedAt);
		const launches = await f.launches();
		assert.equal(launches.length, 2);
		assert.match(launches[1].task, /New instruction:\ninspect changes, then continue/);
		assert.doesNotMatch(launches[1].task, /original instruction/);
		assert.ok(launches[1].prior.some((entry: any) => entry.message?.content === "original instruction"));
		assert.equal((await reopened.list())[0].record?.latestRunId, "run-2");
		await assert.rejects(reopened.recover({ ...input, runId: "run-3", latestRunId: "run-1" }, signal(), { executable: f.executable }), /latest run mismatch/);
	} finally { await reopened.shutdown(); }
});

test("current permissions are checked before recovery mutation and again before any child launch", async t => {
	const f = await fixture(t);
	await f.backend.run(input, signal(), { executable: f.executable });
	let checks = 0;
	const denied = (await PersistentSubagentBackend.open({ ...f.options, authorize: () => { checks++; return false; } }))!;
	await assert.rejects(denied.recover({ ...input, latestRunId: "run-1", runId: "run-2" }, signal(), { executable: f.executable }), /current permissions/);
	assert.equal(checks, 1);
	assert.equal((await denied.list())[0].record?.latestRunId, "run-1");
	assert.equal((await f.launches()).length, 1);
	await denied.shutdown();
	checks = 0;
	const changed = (await PersistentSubagentBackend.open({ ...f.options, authorize: () => ++checks === 1 }))!;
	await assert.rejects(changed.run({ ...input, threadId: "denied-before-spawn" }, signal(), { executable: f.executable }), /current permissions/);
	assert.equal(checks, 2);
	assert.equal((await f.launches()).length, 1);
	await changed.shutdown();
});

test("shutdown waits for child exit and seals interruption; unresolved tool calls never replace a safe checkpoint", async t => {
	const f = await fixture(t);
	const running = f.backend.run({ ...input, instruction: "HOLD PENDING" }, signal(), { executable: f.executable, gracefulStopSeconds: 0.05 });
	const outcome = running.catch(error => error);
	await waitFor(async () => (await f.backend.list())[0]?.record?.checkpoint !== undefined);
	await waitFor(async () => { try { await lstat(path.join(f.base, "pending")); return true; } catch { return false; } });
	await f.backend.shutdown();
	assert.ok(await outcome instanceof SubagentStoppedError);
	const reopened = (await PersistentSubagentBackend.open(f.options))!;
	try {
		const row = (await reopened.list())[0];
		assert.equal(row.record?.status, "interrupted");
		assert.equal(row.recoverable, true);
		await reopened.recover({ ...input, instruction: "check external effects before proceeding", latestRunId: "run-1", runId: "run-2" }, signal(), { executable: f.executable });
		const launches = await f.launches();
		assert.doesNotMatch(JSON.stringify(launches[1].prior), /unfinished|external effect/);
		assert.match(launches[1].task, /was interrupted/);
	} finally { await reopened.shutdown(); }
});

test("cross-runtime ownership blocks recovery and deletion while a child is still alive", async t => {
	const f = await fixture(t);
	const running = f.backend.run({ ...input, instruction: "HOLD" }, signal(), { executable: f.executable, gracefulStopSeconds: 0.05 });
	const outcome = running.catch(error => error);
	await waitFor(async () => (await f.backend.list())[0]?.record?.checkpoint !== undefined);
	const other = (await PersistentSubagentBackend.open(f.options))!;
	try {
		const row = (await other.list())[0];
		assert.equal(row.record?.status, "interrupted", "another runtime cannot claim ownership of the old live run");
		assert.equal(row.recoverable, false);
		assert.match(row.error!, /ownership is unresolved/);
		await assert.rejects(other.recover({ ...input, latestRunId: "run-1", runId: "run-2" }, signal(), { executable: f.executable }), /ownership is still reserved/);
		await assert.rejects(other.delete(input.threadId), /ownership is still reserved/);
		assert.equal((await f.launches()).length, 1);
	} finally { await other.shutdown(); await f.backend.shutdown(); await outcome; }
});

test("unavailable/corrupt saved state fails before launch, never a fresh session", async t => {
	const f = await fixture(t);
	await f.backend.run(input, signal(), { executable: f.executable });
	const store = await TaskHistoryStore.open({ enabled: true, scope: f.options.scope, directory: f.options.directory!, validateSession: validateRecoverableParticipantSession });
	const plan = await store.recover(input.threadId, { ...input, latestRunId: "run-1" });
	await writeFile(plan.checkpointFile, "tampered\n");
	await assert.rejects(f.backend.recover({ ...input, latestRunId: "run-1", runId: "run-2" }, signal(), { executable: f.executable }), /integrity/);
	assert.equal((await f.launches()).length, 1);
	assert.equal((await f.backend.list())[0].recoverable, false);
});

test("session/project scoping and explicit worktree history deletion retain the worktree", async t => {
	const f = await fixture(t);
	const git = (...args: string[]) => execFileSync("git", ["-C", f.project, ...args], { stdio: "pipe" });
	git("init"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
	await f.backend.run({ ...input, workspace: "worktree" }, signal(), { executable: f.executable });
	const workspace = (await f.backend.list())[0].record!.workspace.cwd.path;
	const other = (await PersistentSubagentBackend.open({ ...f.options, scope: { ...f.options.scope, rootSessionId: "other" } }))!;
	assert.deepEqual(await other.list(), []);
	await other.shutdown();
	await f.backend.delete(input.threadId);
	assert.deepEqual(await f.backend.list(), []);
	assert.ok((await lstat(workspace)).isDirectory());
	assert.ok((await lstat(f.project)).isDirectory());
});

test("abrupt parent death leaves an interrupted record but never permits stealing an orphan child's history", async t => {
	const f = await fixture(t);
	const parentScript = path.join(f.base, "parent.ts");
	await writeFile(parentScript, `import { PersistentSubagentBackend } from ${JSON.stringify(path.resolve("background-subagents.ts"))};
void (async () => { const backend = await PersistentSubagentBackend.open({ ...${JSON.stringify(f.options)}, authorize: () => true });
await backend!.run(${JSON.stringify({ ...input, instruction: "HOLD" })}, new AbortController().signal, { executable: ${JSON.stringify(f.executable)} }); })();`);
	const parent = spawn(process.execPath, [path.resolve("node_modules/jiti/lib/jiti-cli.mjs"), parentScript], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	parent.stderr.on("data", data => { stderr += data; });
	let childPid: number | undefined;
	try {
		await waitFor(async () => {
			if (parent.exitCode !== null) throw new Error(`parent failed: ${stderr}`);
			childPid = (await f.launches())[0]?.pid;
			return !!childPid && !!(await f.backend.list())[0]?.record?.checkpoint;
		});
		const closed = once(parent, "exit");
		parent.kill("SIGKILL");
		await closed;
		process.kill(childPid!, 0); // The orphan is genuinely still alive, not a fabricated lock.
		const row = (await f.backend.list())[0];
		assert.equal(row.record?.status, "interrupted");
		assert.equal(row.recoverable, false);
		await assert.rejects(f.backend.recover({ ...input, latestRunId: "run-1", runId: "run-2" }, signal(), { executable: f.executable }), /ownership is still reserved/);
		await assert.rejects(f.backend.delete(input.threadId), /ownership is still reserved/);
	} finally {
		parent.kill("SIGKILL");
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
	}
});
