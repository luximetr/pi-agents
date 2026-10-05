import { displaySubagentModel, runSubagent, SubagentStoppedError, validateRecoverableParticipantSession, type RunSubagentOptions, type SubagentSnapshot, type SubagentWorkspaceInfo, type SubagentWorkspace } from "./subagents.ts";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { TaskHistoryStore, captureHistoryWorkspace, taskHistoryKey, type HistoryScope, type TaskHistoryRecord } from "./task-history.ts";
import { prepareSubagentWorkspace } from "./subagent-workspace.ts";

export interface BackgroundRunState extends Partial<SubagentWorkspaceInfo> {
	agent: string;
	task: string;
	status: string;
	model?: string;
	startedAt: number;
	deadlineAt?: number;
	endedAt?: number;
}

/** Compact, read-only progress metadata; never expose transcripts or consume results. */
export function backgroundRunStatus(runId: string, run: BackgroundRunState, snapshot?: SubagentSnapshot, now = Date.now()) {
	const active = run.status === "running";
	const startedAt = snapshot?.startedAt ?? run.startedAt;
	const endedAt = run.endedAt ?? snapshot?.endedAt;
	const deadlineAt = snapshot?.deadlineAt ?? run.deadlineAt;
	const lastActivityAt = snapshot?.lastActivityAt ?? startedAt;
	const observedModel = snapshot?.usage?.model
		? [snapshot.usage.provider, snapshot.usage.model].filter(Boolean).join("/") : undefined;
	return {
		runId,
		agent: run.agent,
		workspace: snapshot?.workspace ?? run.workspace ?? "shared",
		workspaceCwd: snapshot?.workspaceCwd ?? run.workspaceCwd,
		worktreePath: snapshot?.worktreePath ?? run.worktreePath,
		workspaceBaseCommit: snapshot?.workspaceBaseCommit ?? run.workspaceBaseCommit,
		workspaceBranch: snapshot?.workspaceBranch !== undefined ? snapshot.workspaceBranch : run.workspaceBranch,
		task: run.task,
		status: active && snapshot?.status === "stopping" ? "stopping" : run.status,
		phase: active ? snapshot?.phase ?? "starting" : run.status,
		model: displaySubagentModel(run.model, observedModel),
		currentTool: active ? snapshot?.currentTool : undefined,
		startedAt,
		lastActivityAt,
		deadlineAt,
		endedAt,
		elapsedMs: Math.max(0, (endedAt ?? now) - startedAt),
		idleMs: Math.max(0, (endedAt ?? now) - lastActivityAt),
		remainingMs: active && deadlineAt !== undefined ? Math.max(0, deadlineAt - now) : undefined,
	};
}

export interface TaskAuthorization {
	owner: string;
	agent: string;
	model?: string;
	projectCwd: string;
	workspace: SubagentWorkspace;
	workspaceCwd?: string;
	recovery: boolean;
}
export interface PersistentBackendOptions {
	scope: HistoryScope;
	/** Current permissions, not saved configuration. Called again immediately before launch. */
	authorize: (request: TaskAuthorization) => boolean | Promise<boolean>;
	directory?: string;
	checkpointIntervalMs?: number;
}
export interface PersistentTaskInput {
	threadId: string;
	runId: string;
	owner: string;
	agent: string;
	instruction: string;
	workspace?: SubagentWorkspace;
}
export interface PersistentRecoveryInput extends Omit<PersistentTaskInput, "workspace"> {
	latestRunId: string;
}
export type PersistentRunOptions = Omit<RunSubagentOptions, "id" | "threadId" | "rootSessionId" | "workspace" | "resume" | "participantSessionDir" | "beforeLaunch" | "onHistoryBoundary">;
export interface PersistentTaskResult {
	text: string;
	/** Present if the latest child output could not be sealed; never claim full recovery. */
	historyWarning?: string;
	recovery?: { savedAt: number; interrupted: boolean };
}

/**
 * Durable backend boundary. Task history is always retained. No discovery method launches work.
 * Execution locks span preparation, child close, checkpoint/finalization and shutdown.
 */
export class PersistentSubagentBackend {
	private active = new Map<string, { controller: AbortController; promise: Promise<PersistentTaskResult> }>();
	private closed = false;
	private constructor(private store: TaskHistoryStore, private options: PersistentBackendOptions) {}

	static async open(options: PersistentBackendOptions): Promise<PersistentSubagentBackend> {
		if (typeof options.authorize !== "function") throw new Error("Persistent tasks require a current authorization callback.");
		const interval = options.checkpointIntervalMs ?? 1000;
		if (!Number.isFinite(interval) || interval < 10) throw new Error("Checkpoint interval must be at least 10ms.");
		const scope = { ...options.scope, projectCwd: await realpath(options.scope.projectCwd) };
		const store = await TaskHistoryStore.open({ directory: options.directory ?? path.join(getAgentDir(), "pi-agents-task-history"), scope, validateSession: validateRecoverableParticipantSession });
		return new PersistentSubagentBackend(store, { ...options, scope, checkpointIntervalMs: interval });
	}

	/** Persisted metadata only; caller overlays live runs instead of treating disk state as live. */
	async list() {
		const rows = await this.store.list();
		return Promise.all(rows.map(async row => {
			if (!row.record) return { ...row, recoverable: false };
			if (this.active.has(row.threadId)) return { ...row, record: { ...row.record, status: "running" as const }, recoverable: false };
			try {
				await this.store.assertAvailable(row.threadId);
				const plan = await this.store.recover(row.threadId, { ...row.record, latestRunId: row.record.latestRunId });
				const workspaceInfo = await this.checkWorkspaceSidecar(plan.record);
				return { ...row, recoverable: true, savedAt: plan.savedAt, workspaceInfo };
			} catch (error) { return { ...row, recoverable: false, error: errorText(error) }; }
		}));
	}

	run(input: PersistentTaskInput, signal: AbortSignal, options: PersistentRunOptions = {}): Promise<PersistentTaskResult> {
		return this.track(input, signal, async signal => this.store.withExecutionLock(input.threadId, async () => {
			await this.authorize(input.owner, input.agent, options.model, input.workspace ?? "shared", undefined, false);
			signal.throwIfAborted();
			const key = taskHistoryKey(this.options.scope.rootSessionId, input.threadId);
			const created = await this.store.create({ ...input, model: options.model, workspace: async directory => {
				const info = await prepareSubagentWorkspace(this.options.scope.projectCwd, path.join(directory, `${key}.workspace.json`), input.workspace, false, signal);
				return captureHistoryWorkspace(this.options.scope.projectCwd, info.workspaceCwd, info.workspace);
			} });
			try {
				await this.store.initializeSession(input.threadId, Buffer.from(JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd: created.record.workspace.cwd.path }) + "\n"));
			} catch (error) {
				await this.store.finish(input.threadId, input.runId, "failed");
				throw error;
			}
			return this.execute(created.record, input.instruction, signal, options, false);
		}));
	}

	/** Explicit new instruction only. Permission, ownership, workspace and checkpoint checks precede mutation. */
	recover(input: PersistentRecoveryInput, signal: AbortSignal, options: PersistentRunOptions = {}): Promise<PersistentTaskResult> {
		return this.track(input, signal, async signal => this.store.withExecutionLock(input.threadId, async () => {
			const expected = { owner: input.owner, agent: input.agent, latestRunId: input.latestRunId };
			const plan = await this.store.recover(input.threadId, expected);
			await this.authorize(input.owner, input.agent, plan.record.model, plan.record.workspace.mode, plan.record.workspace.cwd.path, true);
			await this.checkWorkspaceSidecar(plan.record);
			signal.throwIfAborted();
			const resumed = await this.store.beginRecovery(input.threadId, expected, input.runId);
			const notice = `Recovery from saved conversation at ${new Date(plan.savedAt).toISOString()}. The previous execution ${plan.interrupted ? "was interrupted" : "has ended"}. Work after this checkpoint may already have changed files or external systems. Inspect current state; do not blindly repeat earlier tool calls.\n\nNew instruction:\n${input.instruction}`;
			const result = await this.execute(resumed.record, notice, signal, { ...options, model: plan.record.model }, true);
			return { ...result, recovery: { savedAt: plan.savedAt, interrupted: plan.interrupted } };
		}));
	}

	/** Workspace contents/worktrees are never deleted. Busy/crash-left ownership blocks deletion. */
	delete(threadId: string) { return this.store.delete(threadId); }
	prune(before: number) { return this.store.prune(before); }

	async shutdown(): Promise<void> {
		this.closed = true;
		for (const run of this.active.values()) run.controller.abort();
		await Promise.allSettled([...this.active.values()].map(run => run.promise));
	}

	private track(input: PersistentTaskInput | PersistentRecoveryInput, signal: AbortSignal, action: (signal: AbortSignal) => Promise<PersistentTaskResult>) {
		if (this.closed) return Promise.reject(new Error("Task backend is closed; reopen it for the current session."));
		if (!input.instruction?.trim()) return Promise.reject(new Error("A fresh, non-empty instruction is required; saved tasks are never re-executed automatically."));
		if (!input.threadId || !input.runId || !input.owner || !input.agent) return Promise.reject(new Error("Stable thread/run IDs and parent/agent identities are required."));
		if (this.active.has(input.threadId)) return Promise.reject(new Error("Thread is busy; steer its active run or wait for it to stop."));
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const promise = Promise.resolve().then(() => { combined.throwIfAborted(); return action(combined); })
			.finally(() => { this.active.delete(input.threadId); });
		this.active.set(input.threadId, { controller, promise });
		return promise;
	}

	private async authorize(owner: string, agent: string, model: string | undefined, workspace: SubagentWorkspace, workspaceCwd: string | undefined, recovery: boolean) {
		if (!await this.options.authorize({ owner, agent, model, workspace, workspaceCwd, projectCwd: this.options.scope.projectCwd, recovery })) {
			throw new Error(`Task ${recovery ? "recovery" : "delegation"} denied by current permissions for ${owner} → ${agent}. Saved configuration is never restored.`);
		}
	}

	private async checkWorkspaceSidecar(record: TaskHistoryRecord): Promise<SubagentWorkspaceInfo> {
		const key = taskHistoryKey(record.rootSessionId, record.threadId);
		const file = path.join(this.store.paths(record.threadId).directory, `${key}.workspace.json`);
		const stat = await lstat(file); // Missing metadata must not trigger the workspace helper's legacy fallback.
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error("Unsafe workspace sidecar; recovery refused.");
		const info = JSON.parse(await readFile(file, "utf8"));
		if (info.workspace !== record.workspace.mode || await realpath(info.workspaceCwd) !== record.workspace.cwd.path) throw new Error("Saved workspace metadata disagrees with durable history; recovery refused.");
		if (info.workspace === "worktree" && (typeof info.worktreePath !== "string" || !path.isAbsolute(info.worktreePath) || typeof info.workspaceBaseCommit !== "string")) throw new Error("Worktree metadata is incomplete; recovery refused.");
		return { workspace: info.workspace, workspaceCwd: record.workspace.cwd.path,
			...(info.workspace === "worktree" ? { worktreePath: info.worktreePath, workspaceBaseCommit: info.workspaceBaseCommit } : {}),
			...(typeof info.workspaceBranch === "string" || info.workspaceBranch === null ? { workspaceBranch: info.workspaceBranch } : {}) };
	}

	private async execute(record: TaskHistoryRecord, instruction: string, signal: AbortSignal, options: PersistentRunOptions, recovery: boolean): Promise<PersistentTaskResult> {
		let checkpointWork: Promise<void> | undefined;
		let historyWarning: string | undefined;
		const checkpoint = async () => {
			try { await this.store.checkpoint(record.threadId, record.latestRunId); historyWarning = undefined; }
			catch (error) { historyWarning = `Latest history was not saved: ${errorText(error)} Recovery uses only the last safe checkpoint, if one exists.`; }
		};
		const requestCheckpoint = () => {
			if (!checkpointWork) checkpointWork = checkpoint().finally(() => { checkpointWork = undefined; });
		};
		const timer = setInterval(requestCheckpoint, this.options.checkpointIntervalMs);
		timer.unref();
		let failed = false;
		let failure: unknown;
		let text = "";
		try {
			text = await runSubagent(record.agent, instruction, this.options.scope.projectCwd, signal, {
				...options, id: record.latestRunId, threadId: record.threadId, rootSessionId: record.rootSessionId,
				workspace: record.workspace.mode, model: record.model, resume: true,
				participantSessionDir: this.store.paths(record.threadId).directory,
				onHistoryBoundary: requestCheckpoint,
				beforeLaunch: async info => {
					await this.checkWorkspaceSidecar(record);
					const actual = await captureHistoryWorkspace(this.options.scope.projectCwd, info.workspaceCwd, info.workspace);
					if (JSON.stringify(actual) !== JSON.stringify(record.workspace)) throw new Error("Original workspace association changed; no child was launched.");
					await this.authorize(record.owner, record.agent, record.model, info.workspace, info.workspaceCwd, recovery);
				},
			});
		} catch (error) { failed = true; failure = error; }
		finally { clearInterval(timer); }
		// runSubagent resolves/rejects only after child close and participant lock release.
		await checkpointWork;
		await checkpoint();
		const status = failure instanceof SubagentStoppedError ? (failure.reason === "timeout" ? "timed_out" : "interrupted")
			: failed ? (signal.aborted ? "interrupted" : "failed") : "completed";
		try { await this.store.finish(record.threadId, record.latestRunId, status); }
		catch (error) { throw new Error(`Child exited, but durable task finalization failed: ${errorText(error)}. History remains interrupted until inspected.`, { cause: failure ?? error }); }
		if (failed) throw failure;
		return { text, ...(historyWarning ? { historyWarning } : {}) };
	}
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

/**
 * Session-owned notification transport. Never inject results into an active
 * agent loop. Durable reports and handling acknowledgements live separately in
 * SessionCoordination; draining this transport never means a result was handled.
 */
export class CompletionInbox<T> {
	private pending: T[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private busy = false;
	private paused = false;
	private closed = false;

	constructor(private canWake: () => boolean, private deliver: (results: T[]) => void) {}

	push(result: T) {
		if (this.closed) return;
		this.pending.push(result);
		this.schedule();
	}

	private assistantFailed = false;

	start() { this.busy = true; }
	pause() { this.paused = true; }
	resume() { this.paused = false; this.assistantFailed = false; }
	assistantMessageEnded(stopReason: string) {
		// A message error may precede an automatic retry or overflow recovery.
		// Only settlement proves it terminal. Aborts remain latched even if a
		// racing successful message follows; only user input resumes delivery.
		this.assistantFailed = stopReason === "error";
		if (stopReason === "aborted") this.pause();
	}
	settle() {
		if (this.assistantFailed) this.pause();
		this.busy = false;
		this.schedule();
	}

	/** Explicit retrieval is allowed even when automatic wake-ups are paused. */
	take(): T[] { return this.pending.splice(0); }

	close() {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = [];
	}

	private schedule() {
		if (this.closed || this.busy || this.paused || !this.pending.length || this.timer) return;
		// Batch simultaneous completions and leave notification-only lifecycle handlers first.
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed || this.busy || this.paused || !this.canWake()) return;
			this.deliver(this.take());
		}, 25);
	}
}
