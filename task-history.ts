import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Local POSIX persistence. No Pi session loader, agent config, credentials,
 * prompts or results are serialized into metadata. JSONL itself IS sensitive.
 * SHA-256 detects corruption, not a malicious same-user writer who can reseal it.
 * Filesystem identities are fail-closed associations, not a security sandbox.
 *
 * Caller must hold the backend participant lock and stop/reap the child before
 * finish(), recovery-file installation, or deletion. checkpoint() is allowed at
 * a stable JSONL boundary while running. No method starts a process or replays a
 * prompt. A recovery plan uses the last sealed checkpoint, never an unsealed tail.
 */
export type HistoryStatus = "running" | "completed" | "failed" | "timed_out" | "interrupted";
type Identity = { path: string; dev: string; ino: string };
export type HistoryWorkspace = {
	mode: "shared" | "worktree";
	project: Identity;
	cwd: Identity;
	git?: { common: Identity; directory: Identity };
};
export interface TaskHistoryRecord {
	version: 1;
	threadId: string;
	rootSessionId: string;
	owner: string;
	agent: string;
	model?: string;
	workspace: HistoryWorkspace;
	latestRunId: string;
	status: HistoryStatus;
	createdAt: number;
	updatedAt: number;
	/** Last successfully sealed history, not necessarily the last child write. */
	checkpoint?: { sha256: string; bytes: number; at: number };
}
export interface HistoryScope { rootSessionId: string; projectCwd: string }
export interface HistoryOptions {
	directory: string;
	scope: HistoryScope;
	/** Required backend semantic validator. Must reject invalid/unsupported Pi entries. */
	validateSession: (bytes: Buffer) => void | Promise<void>;
	maxSessionBytes?: number;
}
export interface RecoveryPlan {
	record: TaskHistoryRecord;
	/** Immutable, verified JSONL checkpoint. Do not pass this file to a writing child. */
	checkpointFile: string;
	participantSessionDir: string;
	sessionFile: string;
	resume: true;
	/** Running on disk means interrupted on discovery, never an attachable live run. */
	interrupted: boolean;
	/** Work after this time may have happened but was not saved; inspect workspace. */
	savedAt: number;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const statuses = new Set<HistoryStatus>(["running", "completed", "failed", "timed_out", "interrupted"]);
const exec = promisify(execFile);
function requireValue(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Task history: ${message}`);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validIdentity(value: any): value is Identity {
	return value && text(value.path) && path.isAbsolute(value.path) && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
}
function validWorkspace(value: any): value is HistoryWorkspace {
	return value && ["shared", "worktree"].includes(value.mode) && validIdentity(value.project) && validIdentity(value.cwd)
		&& (value.mode !== "shared" || JSON.stringify(value.project) === JSON.stringify(value.cwd))
		&& (value.git === undefined ? value.mode === "shared" : validIdentity(value.git.common) && validIdentity(value.git.directory));
}
async function identity(directory: string): Promise<Identity> {
	const canonical = await realpath(directory);
	const stat = await lstat(canonical, { bigint: true });
	requireValue(stat.isDirectory(), "workspace is not a directory");
	return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
}
async function gitPath(cwd: string, flag: string): Promise<string> {
	const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag], {
		env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
		maxBuffer: 64 * 1024,
	});
	return stdout.trim();
}
/** Capture only paths and filesystem identities; never create/remove a worktree. */
export async function captureHistoryWorkspace(projectCwd: string, cwd = projectCwd, mode: "shared" | "worktree" = "shared"): Promise<HistoryWorkspace> {
	const workspace: HistoryWorkspace = { mode, project: await identity(projectCwd), cwd: await identity(cwd) };
	if (mode === "worktree") {
		const common = await identity(await gitPath(cwd, "--git-common-dir"));
		const projectCommon = await identity(await gitPath(projectCwd, "--git-common-dir"));
		requireValue(JSON.stringify(common) === JSON.stringify(projectCommon), "worktree belongs to another repository");
		workspace.git = { common, directory: await identity(await gitPath(cwd, "--absolute-git-dir")) };
	}
	requireValue(validWorkspace(workspace), "invalid workspace association");
	return workspace;
}

/** Compatible with subagents.ts participantKey(rootSessionId, threadId). */
export function taskHistoryKey(rootSessionId: string, threadId: string): string {
	return hash(`${rootSessionId}\0${threadId}`);
}

/** Expected lock contention, including crash-left ownership; never authorizes lock stealing. */
export class TaskHistoryBusyError extends Error {
	readonly code = "EEXIST";
	constructor(message: string) { super(message); this.name = "TaskHistoryBusyError"; }
}

export class TaskHistoryStore {
	private constructor(private options: HistoryOptions, private project: Identity, readonly directory: string) {}

	static async open(options: HistoryOptions): Promise<TaskHistoryStore> {
		requireValue(process.platform !== "win32" && typeof process.getuid === "function", "owner-only POSIX permissions required");
		requireValue(text(options.scope.rootSessionId), "stable root session ID required");
		requireValue(typeof options.validateSession === "function", "session validator required");
		requireValue(options.maxSessionBytes === undefined || (time(options.maxSessionBytes) && options.maxSessionBytes > 0), "invalid size limit");
		const project = await identity(options.scope.projectCwd);
		const root = path.resolve(options.directory);
		await mkdir(root, { recursive: true, mode: 0o700 });
		await privatePath(root, true);
		requireValue(await realpath(root) === root, "storage path must be canonical and not symlinked");
		// Key by path, not inode: replacement must expose an ownership error, not an empty store.
		const directory = path.join(root, hash(JSON.stringify([project.path, options.scope.rootSessionId])));
		await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
		await privatePath(directory, true);
		await syncDirectory(root);
		return new TaskHistoryStore({ ...options, scope: { ...options.scope } }, project, directory);
	}

	/** Paths only; never creates a missing thread or treats it as fresh. */
	paths(threadId: string) {
		requireValue(text(threadId), "thread ID required");
		const key = taskHistoryKey(this.options.scope.rootSessionId, threadId);
		const directory = path.join(this.directory, key);
		return { directory, metadata: path.join(directory, "metadata.json"), sessionFile: path.join(directory, `${key}.jsonl`) };
	}

	/**
	 * Register BEFORE launching. Unknown properties (including config) are not persisted.
	 * A workspace factory can prepare the backend's .workspace.json sidecar inside the
	 * newly reserved directory. Failure leaves the reservation, never silently retries.
	 */
	async create(input: { threadId: string; owner: string; agent: string; model?: string; workspace: HistoryWorkspace | ((participantSessionDir: string) => Promise<HistoryWorkspace>); runId: string }): Promise<{ record: TaskHistoryRecord; participantSessionDir: string; sessionFile: string }> {
		await privatePath(this.directory, true);
		const p = this.paths(input.threadId);
		await mkdir(p.directory, { mode: 0o700 }); // Never reuse an existing thread, even without metadata.
		await syncDirectory(this.directory);
		const w = typeof input.workspace === "function" ? await input.workspace(p.directory) : input.workspace;
		const now = Date.now();
		const copyIdentity = (i: Identity): Identity => ({ path: i.path, dev: i.dev, ino: i.ino });
		requireValue(validWorkspace(w), "invalid workspace association");
		const workspace: HistoryWorkspace = { mode: w.mode, project: copyIdentity(w.project), cwd: copyIdentity(w.cwd),
			...(w.git ? { git: { common: copyIdentity(w.git.common), directory: copyIdentity(w.git.directory) } } : {}) };
		const record: TaskHistoryRecord = { version: 1, threadId: input.threadId, rootSessionId: this.options.scope.rootSessionId,
			owner: input.owner, agent: input.agent, ...(input.model !== undefined ? { model: input.model } : {}), workspace,
			latestRunId: input.runId, status: "running", createdAt: now, updatedAt: now };
		this.validateRecord(record);
		await this.verifyWorkspace(workspace);
		await this.save(record);
		return { record, participantSessionDir: p.directory, sessionFile: p.sessionFile };
	}

	private validateRecord(record: TaskHistoryRecord) {
		requireValue(record?.version === 1 && text(record.threadId) && text(record.owner) && text(record.agent)
			&& text(record.latestRunId) && (record.model === undefined || text(record.model)) && statuses.has(record.status)
			&& time(record.createdAt) && time(record.updatedAt) && record.updatedAt >= record.createdAt && validWorkspace(record.workspace), "invalid metadata");
		requireValue(record.rootSessionId === this.options.scope.rootSessionId
			&& JSON.stringify(record.workspace.project) === JSON.stringify(this.project), "session/project ownership mismatch");
		const c = record.checkpoint;
		requireValue(c === undefined || (hex.test(c.sha256) && time(c.bytes) && c.bytes > 0 && time(c.at) && c.at <= record.updatedAt), "invalid checkpoint metadata");
	}

	private async verifyWorkspace(workspace: HistoryWorkspace) {
		const current = await captureHistoryWorkspace(workspace.project.path, workspace.cwd.path, workspace.mode);
		requireValue(JSON.stringify(current) === JSON.stringify(workspace), "workspace identity changed or worktree unavailable");
	}

	private async load(threadId: string): Promise<TaskHistoryRecord> {
		await privatePath(this.directory, true);
		const p = this.paths(threadId);
		await privatePath(p.directory, true);
		const envelope = JSON.parse((await readPrivate(p.metadata, 1024 * 1024)).toString("utf8"));
		requireValue(typeof envelope.payload === "string" && envelope.sha256 === hash(envelope.payload), "metadata integrity check failed");
		const record = JSON.parse(envelope.payload) as TaskHistoryRecord;
		this.validateRecord(record);
		requireValue(record.threadId === threadId, "thread ownership mismatch");
		return record;
	}
	private async save(record: TaskHistoryRecord) {
		this.validateRecord(record);
		const payload = JSON.stringify(record);
		await atomicWrite(this.paths(record.threadId).metadata, Buffer.from(JSON.stringify({ payload, sha256: hash(payload) }) + "\n"));
	}

	/** Short metadata transaction lock. Crash-left locks fail closed; never auto-steal. */
	private async transaction<T>(threadId: string, action: (record: TaskHistoryRecord) => Promise<T>): Promise<T> {
		const p = this.paths(threadId);
		await privatePath(this.directory, true);
		await privatePath(p.directory, true);
		const lock = path.join(p.directory, ".metadata-lock");
		try { await mkdir(lock, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await privatePath(lock, true);
			throw new TaskHistoryBusyError(`Task history: metadata transaction is busy at ${lock}.`);
		}
		try { return await action(await this.load(threadId)); }
		finally { await rmdir(lock); }
	}

	/** Read-only availability check for discovery; execution must still acquire its lock. */
	async assertAvailable(threadId: string): Promise<void> {
		const key = taskHistoryKey(this.options.scope.rootSessionId, threadId);
		for (const lock of [path.join(this.directory, ".executions", key), path.join(this.paths(threadId).directory, ".locks", key), path.join(this.paths(threadId).directory, ".metadata-lock")]) {
			try { await lstat(lock); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
			await privatePath(lock, true);
			throw new TaskHistoryBusyError(`Task history ownership is unresolved at ${lock}. Stop the owning runtime; after a crash, verify child exit before manual lock cleanup. No automatic lock stealing.`);
		}
	}

	/**
	 * Cross-process execution ownership. No PID probes or stale-lock stealing: absence
	 * of a PID is not proof that its orphaned child has stopped writing history.
	 * Locks survive parent crashes and intentionally block recovery/deletion.
	 */
	async withExecutionLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
		await privatePath(this.directory, true);
		const locks = path.join(this.directory, ".executions");
		await mkdir(locks, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
		await privatePath(locks, true);
		const lock = path.join(locks, taskHistoryKey(this.options.scope.rootSessionId, threadId));
		try { await mkdir(lock, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await privatePath(lock, true);
			throw new TaskHistoryBusyError(`Task history: execution ownership is still reserved at ${lock}. Stop the owning runtime and verify its child has exited. Crash-left locks require manual inspection; recovery never steals them.`);
		}
		const token = randomUUID();
		const ownerFile = path.join(lock, "owner.json");
		// If durable lock creation fails, leave uncertain ownership reserved.
		await atomicWrite(ownerFile, Buffer.from(JSON.stringify({ pid: process.pid, token })));
		await syncDirectory(locks);
		await syncDirectory(this.directory);
		try {
			const participantLock = path.join(this.paths(threadId).directory, ".locks", taskHistoryKey(this.options.scope.rootSessionId, threadId));
			try {
				await privatePath(participantLock, true);
				throw new TaskHistoryBusyError(`Task history: participant lock remains at ${participantLock}; verify the old child has exited before manual cleanup. No history was restored.`);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const metadataLock = path.join(this.paths(threadId).directory, ".metadata-lock");
			try {
				await privatePath(metadataLock, true);
				throw new TaskHistoryBusyError(`Task history: interrupted metadata transaction at ${metadataLock}; inspect it before manual cleanup.`);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			return await action();
		} finally {
			const owner = JSON.parse((await readPrivate(ownerFile, 4096)).toString("utf8"));
			requireValue(owner.token === token, "execution lock ownership changed; lock retained");
			await unlink(ownerFile);
			await rmdir(lock);
			await syncDirectory(locks);
		}
	}

	/** Create a private header before Pi opens the file; later writes preserve mode 0600. */
	async initializeSession(threadId: string, header: Buffer): Promise<void> {
		const record = await this.load(threadId);
		const parsed = JSON.parse(header.toString("utf8").trim());
		requireValue(parsed.type === "session" && parsed.cwd === record.workspace.cwd.path, "invalid initial session header");
		const file = await open(this.paths(threadId).sessionFile, "wx", 0o600);
		try { await file.writeFile(header); await file.sync(); } finally { await file.close(); }
		await syncDirectory(this.paths(threadId).directory);
	}

	/** Seal a stable, fully validated JSONL snapshot. Failure preserves the previous checkpoint. */
	async checkpoint(threadId: string, runId: string): Promise<TaskHistoryRecord> {
		return this.transaction(threadId, async record => {
			requireValue(record.status === "running" && record.latestRunId === runId, "stale or inactive run");
			await this.verifyWorkspace(record.workspace);
			const bytes = await readPrivate(this.paths(threadId).sessionFile, this.options.maxSessionBytes ?? 64 * 1024 * 1024);
			await this.validateBytes(bytes, record);
			const digest = hash(bytes);
			await atomicWrite(path.join(this.paths(threadId).directory, `${digest}.checkpoint.jsonl`), bytes);
			const previous = record.checkpoint;
			record.updatedAt = Date.now();
			record.checkpoint = { sha256: digest, bytes: bytes.length, at: record.updatedAt };
			await this.save(record);
			if (previous && previous.sha256 !== digest) await unlink(path.join(this.paths(threadId).directory, `${previous.sha256}.checkpoint.jsonl`));
			return record;
		});
	}

	private async validateBytes(bytes: Buffer, record: TaskHistoryRecord) {
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		requireValue(content.endsWith("\n") && content.length > 1, "incomplete JSONL checkpoint");
		const lines = content.slice(0, -1).split("\n");
		const entries = lines.map(line => JSON.parse(line)); // No skipping/truncating malformed lines.
		const header = entries[0];
		requireValue(header?.type === "session" && text(header.id) && header.cwd === record.workspace.cwd.path, "session workspace/header mismatch");
		await this.options.validateSession(bytes);
	}

	/** Call after the child exits, including during shutdown; checkpoint separately first. */
	async finish(threadId: string, runId: string, status: Exclude<HistoryStatus, "running">): Promise<void> {
		requireValue(statuses.has(status) && status !== ("running" as string), "terminal status required");
		await this.transaction(threadId, async record => {
			requireValue(record.latestRunId === runId && record.status === "running", "stale or inactive run");
			record.status = status;
			record.updatedAt = Date.now();
			await this.save(record);
		});
	}

	/** Discovery is read-only and never marks a recovered record as live. Invalid rows remain visible. */
	async list(): Promise<Array<{ threadId: string; record?: TaskHistoryRecord; error?: string }>> {
		await privatePath(this.directory, true);
		const rows: Array<{ threadId: string; record?: TaskHistoryRecord; error?: string }> = [];
		for (const name of (await readdir(this.directory)).sort()) {
			if (!hex.test(name)) continue;
			let threadId = name;
			try {
				await privatePath(path.join(this.directory, name), true);
				const envelope = JSON.parse((await readPrivate(path.join(this.directory, name, "metadata.json"), 1024 * 1024)).toString("utf8"));
				requireValue(typeof envelope.payload === "string" && envelope.sha256 === hash(envelope.payload), "metadata integrity check failed");
				const candidate = JSON.parse(envelope.payload);
				this.validateRecord(candidate);
				requireValue(taskHistoryKey(candidate.rootSessionId, candidate.threadId) === name, "directory identity mismatch");
				threadId = candidate.threadId;
				const record = await this.load(threadId);
				rows.push({ threadId, record: { ...record, status: record.status === "running" ? "interrupted" : record.status } });
			} catch (error) { rows.push({ threadId, error: error instanceof Error ? error.message : String(error) }); }
		}
		return rows;
	}

	/** Explicit recovery/reply preflight; no mutation, execution, or fallback to fresh context. */
	async recover(threadId: string, expected: { owner: string; agent: string; latestRunId: string }): Promise<RecoveryPlan> {
		const record = await this.load(threadId);
		requireValue(record.owner === expected.owner && record.agent === expected.agent && record.latestRunId === expected.latestRunId, "owner/agent/latest run mismatch");
		await this.verifyWorkspace(record.workspace);
		requireValue(record.checkpoint, "no sealed conversation available");
		const p = this.paths(threadId);
		const checkpointFile = path.join(p.directory, `${record.checkpoint.sha256}.checkpoint.jsonl`);
		const bytes = await readPrivate(checkpointFile, this.options.maxSessionBytes ?? 64 * 1024 * 1024);
		requireValue(bytes.length === record.checkpoint.bytes && hash(bytes) === record.checkpoint.sha256, "conversation integrity check failed");
		await this.validateBytes(bytes, record);
		return { record: { ...record, status: record.status === "running" ? "interrupted" : record.status }, checkpointFile,
			participantSessionDir: p.directory, sessionFile: p.sessionFile, resume: true,
			interrupted: record.status === "running" || record.status === "interrupted", savedAt: record.checkpoint.at };
	}

	/**
	 * Explicit continuation only, under the backend participant lock after proving no
	 * old child is alive. Restores the verified checkpoint (discarding unsealed tail).
	 * Re-check authorization against CURRENT agent config before calling this method.
	 */
	async beginRecovery(threadId: string, expected: { owner: string; agent: string; latestRunId: string }, newRunId: string): Promise<RecoveryPlan> {
		requireValue(text(newRunId) && newRunId !== expected.latestRunId, "new run ID required");
		return this.transaction(threadId, async record => {
			const plan = await this.recover(threadId, expected);
			const bytes = await readPrivate(plan.checkpointFile, this.options.maxSessionBytes ?? 64 * 1024 * 1024);
			requireValue(hash(bytes) === record.checkpoint?.sha256, "checkpoint changed during recovery");
			await atomicWrite(plan.sessionFile, bytes);
			record.latestRunId = newRunId;
			record.status = "running";
			record.updatedAt = Date.now();
			await this.save(record);
			return { ...plan, record };
		});
	}

	/** Delete only history, never workspace/worktree. Caller must exclude live writers. */
	async delete(threadId: string): Promise<void> {
		await this.withExecutionLock(threadId, async () => {
			await this.load(threadId); // Ownership/integrity failure must not authorize deletion.
			await rm(this.paths(threadId).directory, { recursive: true, force: false });
			await syncDirectory(this.directory);
		});
	}

	/** Explicit retention sweep. Skips live/busy records; invalid records and I/O failures remain errors. */
	async prune(before: number): Promise<string[]> {
		requireValue(time(before), "invalid retention cutoff");
		const deleted: string[] = [];
		const rows = await this.list();
		// Report known invalid records before deleting anything. A later I/O failure
		// can still interrupt this non-atomic sweep and must not be hidden as busy.
		for (const row of rows) requireValue(row.record, `cannot prune invalid history ${row.threadId}: ${row.error}`);
		for (const row of rows) {
			if (row.record!.updatedAt >= before) continue;
			try {
				await this.withExecutionLock(row.threadId, async () => {
					const record = await this.load(row.threadId);
					if (record.status === "running" || record.updatedAt >= before) return;
					await rm(this.paths(row.threadId).directory, { recursive: true, force: false });
					await syncDirectory(this.directory);
					deleted.push(row.threadId);
				});
			} catch (error) {
				if (!(error instanceof TaskHistoryBusyError)) throw error;
			}
		}
		return deleted;
	}
}

async function privatePath(file: string, directory: boolean) {
	const stat = await lstat(file);
	requireValue(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid!()
		&& (stat.mode & 0o077) === 0 && (directory || stat.nlink === 1), `unsafe permissions/type/owner: ${file}`);
	return stat;
}
async function readPrivate(file: string, limit: number): Promise<Buffer> {
	await privatePath(file, false);
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		requireValue(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0 && stat.nlink === 1 && stat.size <= limit, "unsafe or oversized file");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		const current = await lstat(file);
		requireValue(stat.ino === current.ino && stat.dev === current.dev && stat.size === bytes.length
			&& stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs,
			"file changed while reading; retry at the next stable history boundary");
		requireValue(bytes.length <= limit, "oversized file");
		return bytes;
	} finally { await handle.close(); }
}
async function syncDirectory(directory: string) {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(file: string, bytes: Buffer) {
	await privatePath(path.dirname(file), true);
	const temporary = `${file}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	try { await rename(temporary, file); await syncDirectory(path.dirname(file)); }
	finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
