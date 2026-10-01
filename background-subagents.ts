import { displaySubagentModel, type SubagentSnapshot } from "./subagents.ts";

export interface BackgroundRunState {
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

/** Session-owned completion inbox. Never inject results into an active agent loop. */
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

	start() { this.busy = true; }
	pause() { this.paused = true; }
	resume() { this.paused = false; }
	settle() { this.busy = false; this.schedule(); }

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
