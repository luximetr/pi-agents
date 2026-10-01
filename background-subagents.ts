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
