import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TaskHistoryStore, TaskHistoryBusyError, captureHistoryWorkspace, taskHistoryKey, type HistoryOptions } from "../task-history.ts";

const expected = { owner: "parent", agent: "worker", latestRunId: "run-1" };
const validateSession = (bytes: Buffer) => {
	const entries = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
	assert.equal(entries[0].version, 3);
	const ids = new Set<string>();
	for (const entry of entries.slice(1)) {
		assert.ok(entry.id && !ids.has(entry.id));
		assert.ok(entry.parentId === null || ids.has(entry.parentId));
		assert.equal(entry.type, "message");
		assert.ok(["user", "assistant", "toolResult"].includes(entry.message.role));
		ids.add(entry.id);
	}
};
function session(cwd: string, message = "sensitive prompt") {
	return Buffer.from([
		{ type: "session", version: 3, id: "pi-child", cwd, timestamp: new Date().toISOString() },
		{ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: message, timestamp: Date.now() } },
	].map(value => JSON.stringify(value)).join("\n") + "\n");
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-task-history-test-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	const project = path.join(base, "project");
	await mkdir(project);
	const directory = path.join(base, "history");
	const options: HistoryOptions = { directory, scope: { rootSessionId: "root-session", projectCwd: project }, validateSession };
	const store = await TaskHistoryStore.open(options);
	const workspace = await captureHistoryWorkspace(project);
	const input = { threadId: "thread-1", ...expected, workspace, runId: "run-1" };
	const created = await store.create(input);
	const bytes = session(project);
	await writeFile(created.sessionFile, bytes, { mode: 0o600 });
	return { base, project, directory, options, store, workspace, input, created, bytes };
}

test("history requires a semantic validator and stable scope before touching disk", async t => {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-history-validation-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	const directory = path.join(base, "absent");
	await assert.rejects(TaskHistoryStore.open({ directory, scope: { rootSessionId: "", projectCwd: base }, validateSession }), /stable root/);
	await assert.rejects(lstat(directory), { code: "ENOENT" });
	await assert.rejects(TaskHistoryStore.open({ directory, scope: { rootSessionId: "id", projectCwd: base } } as HistoryOptions), /validator/);
	await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("checkpoint survives reopen; completed threads recover without execution or duplicated prompt metadata", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await f.store.finish("thread-1", "run-1", "completed");
	const reopened = await TaskHistoryStore.open(f.options);
	const [row] = await reopened.list();
	assert.equal(row.record?.status, "completed");
	const plan = await reopened.recover("thread-1", expected);
	assert.equal(plan.record.workspace.cwd.path, f.project);
	assert.equal(plan.resume, true);
	assert.equal(plan.interrupted, false);
	assert.deepEqual(await readFile(plan.checkpointFile), f.bytes);
	assert.equal(path.basename(plan.sessionFile), `${taskHistoryKey("root-session", "thread-1")}.jsonl`);
	const metadata = await readFile(path.join(plan.participantSessionDir, "metadata.json"), "utf8");
	assert.doesNotMatch(metadata, /sensitive prompt|apiKey|runtimeAgentOverrides/);
	for (const name of await readdir(plan.participantSessionDir)) {
		assert.equal((await lstat(path.join(plan.participantSessionDir, name))).mode & 0o077, 0);
		assert.ok(!name.endsWith(".tmp"));
	}
	assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
});

test("running records discover as interrupted; explicit recovery restores ONLY the sealed checkpoint", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await writeFile(f.created.sessionFile, Buffer.concat([f.bytes, Buffer.from('{"partial":')]));
	const reopened = await TaskHistoryStore.open(f.options);
	assert.equal((await reopened.list())[0].record?.status, "interrupted");
	const before = await readFile(f.created.sessionFile);
	const plan = await reopened.recover("thread-1", expected);
	assert.equal(plan.interrupted, true);
	assert.deepEqual(await readFile(f.created.sessionFile), before, "preflight never mutates working history");
	const resumed = await reopened.beginRecovery("thread-1", expected, "run-2");
	assert.equal(resumed.record.latestRunId, "run-2");
	assert.equal(resumed.record.status, "running");
	assert.deepEqual(await readFile(resumed.sessionFile), f.bytes);
	await assert.rejects(reopened.finish("thread-1", "run-1", "completed"), /stale/);
	await assert.rejects(reopened.beginRecovery("thread-1", expected, "run-3"), /mismatch/);
});

test("missing checkpoint/session, malformed JSONL and semantic corruption never become fresh history", async t => {
	const f = await fixture(t);
	await assert.rejects(f.store.recover("thread-1", expected), /no sealed/);
	await rm(f.created.sessionFile);
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"), { code: "ENOENT" });
	for (const invalid of [Buffer.from("{}"), Buffer.from("{}\n\n"), Buffer.from([0xff, 0x0a]), session(f.project).subarray(0, -1), session("/wrong/workspace")]) {
		await writeFile(f.created.sessionFile, invalid, { mode: 0o600 });
		await assert.rejects(f.store.checkpoint("thread-1", "run-1"));
	}
	const invalidTree = Buffer.from(f.bytes.toString().replace('"parentId":null', '"parentId":"missing"'));
	await writeFile(f.created.sessionFile, invalidTree);
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"));
	await assert.rejects(f.store.recover("thread-1", expected), /no sealed/);
});

test("failed checkpoints preserve last good snapshot; sealed history tampering and deletion reject", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await writeFile(f.created.sessionFile, "broken\n");
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"));
	const plan = await f.store.recover("thread-1", expected);
	assert.deepEqual(await readFile(plan.checkpointFile), f.bytes);
	await writeFile(plan.checkpointFile, session(f.project, "tampered"));
	await assert.rejects(f.store.recover("thread-1", expected), /integrity/);
	await rm(plan.checkpointFile);
	await assert.rejects(f.store.recover("thread-1", expected), { code: "ENOENT" });
});

test("new checkpoints retire superseded sensitive snapshots and leave no atomic-write debris", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	const first = await f.store.recover("thread-1", expected);
	const next = session(f.project, "new conversation");
	await writeFile(f.created.sessionFile, next);
	await f.store.checkpoint("thread-1", "run-1");
	const second = await f.store.recover("thread-1", expected);
	assert.notEqual(first.checkpointFile, second.checkpointFile);
	await assert.rejects(lstat(first.checkpointFile), { code: "ENOENT" });
	assert.deepEqual(await readFile(second.checkpointFile), next);
	assert.equal((await readdir(f.created.participantSessionDir)).filter(name => name.endsWith(".checkpoint.jsonl")).length, 1);
	assert.ok((await readdir(f.created.participantSessionDir)).every(name => !name.endsWith(".tmp") && name !== ".metadata-lock"));
});

test("metadata integrity failures are visible and cannot authorize recovery/deletion", async t => {
	const f = await fixture(t);
	const metadata = path.join(f.created.participantSessionDir, "metadata.json");
	await writeFile(metadata, (await readFile(metadata, "utf8")).replace("worker", "attacker"));
	assert.match((await f.store.list())[0].error!, /integrity/);
	await assert.rejects(f.store.recover("thread-1", expected), /integrity/);
	await assert.rejects(f.store.delete("thread-1"), /integrity/);
});

test("session/project/parent/agent/latest-run ownership is enforced", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	for (const wrong of [{ ...expected, owner: "other" }, { ...expected, agent: "other" }, { ...expected, latestRunId: "old" }]) {
		await assert.rejects(f.store.recover("thread-1", wrong), /mismatch/);
	}
	const otherSession = await TaskHistoryStore.open({ ...f.options, scope: { ...f.options.scope, rootSessionId: "other-root" } });
	assert.deepEqual(await otherSession.list(), []);
	await assert.rejects(otherSession.recover("thread-1", expected), { code: "ENOENT" });
	const metadata = path.join(f.created.participantSessionDir, "metadata.json");
	const envelope = JSON.parse(await readFile(metadata, "utf8"));
	const record = JSON.parse(envelope.payload);
	record.rootSessionId = "other-root";
	envelope.payload = JSON.stringify(record);
	envelope.sha256 = createHash("sha256").update(envelope.payload).digest("hex");
	await writeFile(metadata, JSON.stringify(envelope));
	await assert.rejects(f.store.recover("thread-1", expected), /ownership/);
});

test("workspace removal/replacement and symlink redirection reject recovery", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await rename(f.project, `${f.project}-old`);
	await assert.rejects(f.store.recover("thread-1", expected), { code: "ENOENT" });
	await mkdir(f.project);
	await assert.rejects(f.store.recover("thread-1", expected), /identity changed/);
	const reopened = await TaskHistoryStore.open(f.options);
	assert.match((await reopened.list())[0].error!, /ownership/, "replacement cannot silently become a fresh namespace");
	await rm(f.project, { recursive: true });
	await symlink(`${f.project}-old`, f.project);
	await assert.rejects(f.store.recover("thread-1", expected), /identity changed/);
});

test("world-readable files, symlinked histories and oversized sessions reject", async t => {
	const f = await fixture(t);
	await chmod(f.created.sessionFile, 0o644);
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"), /unsafe/);
	await chmod(f.created.sessionFile, 0o600);
	const restricted = await TaskHistoryStore.open({ ...f.options, maxSessionBytes: 10 });
	await assert.rejects(restricted.checkpoint("thread-1", "run-1"), /oversized/);
	const target = path.join(f.base, "elsewhere");
	await rename(f.created.sessionFile, target);
	await symlink(target, f.created.sessionFile);
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"), /unsafe/);
	await chmod(f.directory, 0o755);
	await assert.rejects(TaskHistoryStore.open(f.options), /unsafe/);
});

test("allowlist excludes extra config properties; duplicate threads and transaction locks fail closed", async t => {
	const f = await fixture(t);
	const created = await f.store.create({ ...f.input, threadId: "thread-2", apiKey: "secret", runtimeAgentOverrides: { token: "secret" } } as typeof f.input);
	assert.doesNotMatch(await readFile(path.join(created.participantSessionDir, "metadata.json"), "utf8"), /secret|apiKey|runtimeAgent/);
	await assert.rejects(f.store.create(f.input), { code: "EEXIST" });
	await mkdir(path.join(f.created.participantSessionDir, ".metadata-lock"), { mode: 0o700 });
	await assert.rejects(f.store.checkpoint("thread-1", "run-1"), { code: "EEXIST" });
	assert.equal((await f.store.list()).length, 2, "stale transaction lock does not hide history");
});

test("explicit retention deletes terminal histories only, leaves running data and workspaces", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await f.store.create({ ...f.input, threadId: "running" });
	await f.store.finish("thread-1", "run-1", "completed");
	assert.deepEqual(await f.store.prune(Date.now() + 1), ["thread-1"]);
	assert.ok((await lstat(f.project)).isDirectory());
	assert.deepEqual((await f.store.list()).map(row => row.threadId), ["running"]);
	await f.store.delete("running");
	assert.deepEqual(await f.store.list(), []);
});

test("retention skips typed busy locks and rechecks running state under ownership", async t => {
	const f = await fixture(t);
	await f.store.checkpoint("thread-1", "run-1");
	await f.store.finish("thread-1", "run-1", "completed");
	for (const id of ["execution", "participant", "metadata", "running", "recent"]) {
		await f.store.create({ ...f.input, threadId: id });
		if (id !== "running") await f.store.finish(id, "run-1", "completed");
	}
	const cutoff = (await f.store.list()).find(row => row.threadId === "recent")!.record!.updatedAt;
	// Exact-cutoff records must be retained. All older terminal records can go.
	assert.deepEqual(await f.store.prune(0), []);
	const lockPaths = [
		path.join(f.store.directory, ".executions", taskHistoryKey("root-session", "execution")),
		path.join(f.store.paths("participant").directory, ".locks", taskHistoryKey("root-session", "participant")),
		path.join(f.store.paths("metadata").directory, ".metadata-lock"),
	];
	for (const lock of lockPaths) await mkdir(lock, { recursive: true, mode: 0o700 });
	for (const id of ["execution", "participant", "metadata"]) await assert.rejects(f.store.delete(id), TaskHistoryBusyError);
	const removed = await f.store.prune(cutoff);
	assert.deepEqual(removed, ["thread-1"]);
	for (const lock of lockPaths) assert.ok((await lstat(lock)).isDirectory(), "never remove or steal pre-existing locks");
	assert.deepEqual((await f.store.list()).map(row => row.threadId).sort(), ["execution", "metadata", "participant", "recent", "running"]);
	// Simulate a recovery starting between discovery and the under-lock state read.
	await writeFile(f.store.paths("recent").sessionFile, session(f.project), { mode: 0o600 });
	const original = f.store.withExecutionLock.bind(f.store);
	f.store.withExecutionLock = (id, action) => original(id, async () => {
		if (id === "recent") {
			// A new run may have changed both state and timestamp since list().
			const metadata = f.store.paths(id).metadata;
			const envelope = JSON.parse(await readFile(metadata, "utf8"));
			const record = JSON.parse(envelope.payload);
			record.status = "running";
			envelope.payload = JSON.stringify(record);
			envelope.sha256 = createHash("sha256").update(envelope.payload).digest("hex");
			await writeFile(metadata, JSON.stringify(envelope));
		}
		return action();
	});
	assert.deepEqual(await f.store.prune(Date.now() + 1), []);
	assert.ok((await lstat(f.store.paths("recent").directory)).isDirectory());
});

test("prune reports corruption and unsafe permissions rather than treating them as busy", async t => {
	const f = await fixture(t);
	await f.store.finish("thread-1", "run-1", "completed");
	const other = await f.store.create({ ...f.input, threadId: "corrupt" });
	const metadata = path.join(other.participantSessionDir, "metadata.json");
	await writeFile(metadata, "broken");
	await assert.rejects(f.store.prune(Date.now() + 1), /cannot prune invalid history/);
	assert.ok((await lstat(f.created.participantSessionDir)).isDirectory(), "known corruption is reported before deleting eligible histories");
	await rm(other.participantSessionDir, { recursive: true });
	const lock = path.join(f.store.directory, ".executions", taskHistoryKey("root-session", "thread-1"));
	await mkdir(lock, { recursive: true, mode: 0o700 });
	await chmod(lock, 0o755);
	await assert.rejects(f.store.prune(Date.now() + 1), /unsafe permissions/);
	await chmod(lock, 0o700);
	await rm(lock, { recursive: true });
	await chmod(f.created.participantSessionDir, 0o755);
	await assert.rejects(f.store.prune(Date.now() + 1), /unsafe permissions/);
});

test("worktree identity persists, rejects unrelated repositories and removed worktrees", async t => {
	const f = await fixture(t);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git(f.project, "init");
	git(f.project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
	const worktree = path.join(f.base, "worktree");
	git(f.project, "worktree", "add", "--detach", worktree);
	const workspace = await captureHistoryWorkspace(f.project, worktree, "worktree");
	const created = await f.store.create({ ...f.input, threadId: "worktree-thread", workspace: async directory => {
		await writeFile(path.join(directory, "backend.workspace.json"), JSON.stringify({ workspaceCwd: worktree }), { mode: 0o600 });
		return workspace;
	} });
	await writeFile(created.sessionFile, session(worktree), { mode: 0o600 });
	await f.store.checkpoint("worktree-thread", "run-1");
	const plan = await f.store.recover("worktree-thread", expected);
	assert.equal(plan.record.workspace.mode, "worktree");
	assert.equal(plan.record.workspace.cwd.path, worktree);
	const unrelated = path.join(f.base, "other-repo");
	await mkdir(unrelated);
	git(unrelated, "init");
	await assert.rejects(captureHistoryWorkspace(unrelated, worktree, "worktree"), /another repository/);
	git(f.project, "worktree", "remove", worktree);
	await assert.rejects(f.store.recover("worktree-thread", expected));
});
