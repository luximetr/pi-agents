import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Task state is separate from worker execution history and transcript delivery. */
export type CoordinationTaskStatus = "active" | "blocked" | "completed" | "dropped";
export type CoordinationItemStatus = "pending" | "in_progress" | "completed" | "dropped";
export type ResultHandling = "new" | "handled" | "deferred";
export interface CoordinationItem {
	id: string;
	text: string;
	status: CoordinationItemStatus;
	owner?: string;
	dependsOn: string[];
	createdAt: number;
	updatedAt: number;
}
export interface CoordinationTask {
	id: string;
	title: string;
	objective: string;
	status: CoordinationTaskStatus;
	owner: string;
	nextAction?: string;
	items: CoordinationItem[];
	createdAt: number;
	updatedAt: number;
}
export interface CoordinationFocus { taskId?: string; text: string; nextAction?: string; updatedAt: number }
export interface CoordinationRunLink { runId: string; taskId: string; itemId?: string; agent: string; task: string; createdAt: number }
export interface CoordinationResult {
	runId: string;
	taskId?: string;
	itemId?: string;
	agent: string;
	task: string;
	title: string;
	summary: string;
	text: string;
	executionStatus: string;
	handling: ResultHandling;
	delivered: boolean;
	note?: string;
	createdAt: number;
	updatedAt: number;
	deliveredAt?: number;
	handledAt?: number;
}
export interface CoordinationScope { projectCwd: string; rootSessionId: string; participantId: string }
export interface CoordinationSnapshot {
	version: 1;
	scope: CoordinationScope;
	tasks: CoordinationTask[];
	focus?: CoordinationFocus;
	runs: CoordinationRunLink[];
	results: CoordinationResult[];
	createdAt: number;
	updatedAt: number;
}
export interface CoordinationOptions { projectCwd: string; rootSessionId: string; directory?: string; participantId?: string }
export interface CoordinationItemInput { id?: string; text: string; status?: CoordinationItemStatus; owner?: string; dependsOn?: string[] }
export interface CoordinationTaskInput {
	id?: string;
	title: string;
	objective?: string;
	status?: CoordinationTaskStatus;
	owner?: string;
	nextAction?: string;
	items?: CoordinationItemInput[];
}
export interface CoordinationTaskPatch {
	title?: string;
	objective?: string;
	status?: CoordinationTaskStatus;
	owner?: string;
	nextAction?: string | null;
}
export interface CoordinationItemPatch { text?: string; status?: CoordinationItemStatus; owner?: string | null; dependsOn?: string[] }
export interface CoordinationResultInput {
	runId: string;
	agent: string;
	task: string;
	text: string;
	executionStatus: string;
	title?: string;
	summary?: string;
	taskId?: string;
	itemId?: string;
}
export interface CoordinationDigestOptions {
	maxChars?: number;
	maxTasks?: number;
	maxResults?: number;
	maxItems?: number;
	deliveredOnly?: boolean;
}

const taskStatuses = new Set(["active", "blocked", "completed", "dropped"]);
const itemStatuses = new Set(["pending", "in_progress", "completed", "dropped"]);
const handlingStatuses = new Set(["new", "handled", "deferred"]);
const executionStatuses = new Set(["completed", "failed", "timed_out", "interrupted", "stopped", "aborted", "cancelled"]);
const maxFileBytes = 64 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
function requireValue(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Session state: ${message}`);
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && !value.includes("\0"); }
function string(value: unknown): value is string { return typeof value === "string" && !value.includes("\0"); }
function id(value: unknown): value is string { return text(value) && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value); }
function optionalText(value: unknown): boolean { return value === undefined || text(value); }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function timestamps(value: { createdAt: number; updatedAt: number }): boolean { return time(value.createdAt) && time(value.updatedAt) && value.updatedAt >= value.createdAt; }
function completed(status: string): boolean { return status === "completed" || status === "dropped"; }
function oneLine(value: string, limit: number): string {
	const clean = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
	return clean.length <= limit ? clean : clean.slice(0, Math.max(0, limit - 1)) + "…";
}
function digestLimit(value: number | undefined, fallback: number, min = 1): number {
	requireValue(value === undefined || (Number.isSafeInteger(value) && value >= min), "invalid digest limit");
	return value ?? fallback;
}
function bounded(lines: string[], maxChars: number): string {
	const body = lines.join("\n");
	if (body.length <= maxChars) return body;
	const suffix = "\n… More saved state: use session_plan inspect/list; full reports: subagent_control result.";
	return body.slice(0, Math.max(0, maxChars - suffix.length)) + suffix.slice(0, maxChars);
}

function privatePath(file: string, directory: boolean) {
	const stat = lstatSync(file);
	requireValue(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), "storage path must be a regular private file/directory");
	requireValue(typeof process.getuid !== "function" || stat.uid === process.getuid(), "storage belongs to another user");
	requireValue((stat.mode & 0o077) === 0, "storage must have owner-only permissions");
	if (!directory) requireValue(stat.nlink === 1 && stat.size <= maxFileBytes, "invalid coordination file size or hard links");
	return stat;
}
function syncDirectory(directory: string) {
	const fd = openSync(directory, constants.O_RDONLY);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Old files used superseded/reviewed/incorporated and stored user updates; map them on read. */
function migrate(state: CoordinationSnapshot) {
	const legacy = state as unknown as { userUpdates?: unknown; tasks?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
	delete legacy.userUpdates;
	for (const task of legacy.tasks ?? []) {
		delete task.amendments;
		if (task.status === "superseded") task.status = "dropped";
		for (const item of (task.items as Array<Record<string, unknown>> | undefined) ?? []) if (item.status === "superseded") item.status = "dropped";
	}
	for (const result of legacy.results ?? []) {
		if (result.handling === "incorporated") result.handling = "handled";
		else if (result.handling === "reviewed") result.handling = "new";
	}
}

/**
 * Atomic, private JSON for one parent participant in a canonical project/session.
 * No method starts, resumes, stops, or attaches to a worker. Reads never acknowledge
 * results. The short exclusive lock prevents concurrent extension instances from
 * losing each other's updates; a crash-left lock fails closed instead of stealing.
 */
export class SessionCoordination {
	readonly file: string;
	private cached?: { signature: string; state: CoordinationSnapshot };
	private constructor(readonly directory: string, private readonly scope: CoordinationScope) {
		this.file = path.join(directory, "coordination.json");
	}
	static open(options: CoordinationOptions): SessionCoordination {
		requireValue(id(options.rootSessionId), "stable root session ID required");
		requireValue(options.participantId === undefined || id(options.participantId), "invalid participant ID");
		const projectCwd = realpathSync(options.projectCwd);
		requireValue(lstatSync(projectCwd).isDirectory(), "project must be a directory");
		const scope: CoordinationScope = { projectCwd, rootSessionId: options.rootSessionId, participantId: options.participantId ?? "main" };
		const requestedRoot = path.resolve(options.directory ?? path.join(getAgentDir(), "pi-agents-coordination"));
		mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
		privatePath(requestedRoot, true);
		const root = realpathSync(requestedRoot);
		const directory = path.join(root, hash(JSON.stringify(scope)));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		privatePath(directory, true);
		const store = new SessionCoordination(directory, scope);
		store.transaction(state => state, true);
		return store;
	}

	/** A detached snapshot. Reading it never changes focus, delivery, or handling. */
	snapshot(): CoordinationSnapshot { return this.load(); }

	private empty(): CoordinationSnapshot {
		const now = Date.now();
		return { version: 1, scope: clone(this.scope), tasks: [], runs: [], results: [], createdAt: now, updatedAt: now };
	}
	private load(): CoordinationSnapshot {
		privatePath(this.directory, true);
		const stat = privatePath(this.file, false);
		const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		if (this.cached?.signature === signature) return clone(this.cached.state);
		const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes: string;
		try { bytes = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
		const envelope = JSON.parse(bytes);
		requireValue(typeof envelope.payload === "string" && envelope.sha256 === hash(envelope.payload), "integrity check failed");
		const state = JSON.parse(envelope.payload) as CoordinationSnapshot;
		migrate(state);
		this.validate(state);
		this.cached = { signature, state: clone(state) };
		return state;
	}
	private save(state: CoordinationSnapshot) {
		this.validate(state);
		const payload = JSON.stringify(state);
		const bytes = JSON.stringify({ payload, sha256: hash(payload) }) + "\n";
		requireValue(Buffer.byteLength(bytes) <= maxFileBytes, "coordination state exceeds file size limit");
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temporary, this.file);
			syncDirectory(this.directory);
		} finally {
			try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	private transaction<T>(mutate: (state: CoordinationSnapshot) => T, initialize = false): T {
		privatePath(this.directory, true);
		const lock = path.join(this.directory, ".lock");
		try { mkdirSync(lock, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session state: store is busy (or a prior writer was interrupted): ${lock}`);
			throw error;
		}
		try {
			let state: CoordinationSnapshot;
			let fresh = false;
			try { state = this.load(); }
			catch (error) {
				if (!initialize || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				state = this.empty(); fresh = true;
			}
			const result = mutate(state);
			if (!initialize || fresh) { state.updatedAt = Math.max(Date.now(), state.updatedAt); this.save(state); }
			return clone(result);
		} finally { rmdirSync(lock); }
	}
	private task(state: CoordinationSnapshot, taskId: string): CoordinationTask {
		requireValue(id(taskId), "invalid task ID");
		const task = state.tasks.find(task => task.id === taskId);
		requireValue(task, `unknown task ${taskId}`);
		return task;
	}
	private item(task: CoordinationTask, itemId: string): CoordinationItem {
		requireValue(id(itemId), "invalid item ID");
		const item = task.items.find(item => item.id === itemId);
		requireValue(item, `unknown item ${itemId} in task ${task.id}`);
		return item;
	}
	private validate(state: CoordinationSnapshot) {
		requireValue(state?.version === 1 && JSON.stringify(state.scope) === JSON.stringify(this.scope), "session/project/participant scope mismatch");
		requireValue(timestamps(state) && Array.isArray(state.tasks) && Array.isArray(state.runs) && Array.isArray(state.results), "invalid state");
		const tasks = new Set<string>();
		for (const task of state.tasks) {
			requireValue(task && id(task.id) && !tasks.has(task.id) && text(task.title) && text(task.objective) && text(task.owner)
				&& taskStatuses.has(task.status) && timestamps(task) && optionalText(task.nextAction)
				&& Array.isArray(task.items), "invalid task");
			tasks.add(task.id);
			const items = new Set<string>();
			for (const item of task.items) {
				requireValue(item && id(item.id) && !items.has(item.id) && text(item.text) && itemStatuses.has(item.status)
					&& optionalText(item.owner) && timestamps(item) && Array.isArray(item.dependsOn) && item.dependsOn.every(id)
					&& new Set(item.dependsOn).size === item.dependsOn.length, "invalid checklist item");
				items.add(item.id);
			}
			const visited = new Set<string>();
			const visiting = new Set<string>();
			const visit = (item: CoordinationItem) => {
				if (visited.has(item.id)) return;
				requireValue(!visiting.has(item.id), "cyclic checklist dependency");
				visiting.add(item.id);
				for (const dependency of item.dependsOn) {
					requireValue(items.has(dependency), `unknown dependency ${dependency}`);
					const predecessor = this.item(task, dependency);
					requireValue(item.status !== "completed" || completed(predecessor.status), `unfinished dependency ${dependency}`);
					visit(predecessor);
				}
				visiting.delete(item.id); visited.add(item.id);
			};
			for (const item of task.items) visit(item);
			requireValue(task.status !== "completed" || task.items.every(item => completed(item.status)), `task ${task.id} has unfinished checklist items`);
		}
		if (state.focus !== undefined) {
			requireValue(state.focus && text(state.focus.text) && optionalText(state.focus.nextAction) && time(state.focus.updatedAt), "invalid focus");
			if (state.focus.taskId !== undefined) this.task(state, state.focus.taskId);
		}
		const runIds = new Set<string>();
		for (const run of state.runs) {
			requireValue(run && id(run.runId) && !runIds.has(run.runId) && text(run.agent) && text(run.task) && time(run.createdAt), "invalid run link");
			runIds.add(run.runId);
			const task = this.task(state, run.taskId);
			if (run.itemId !== undefined) this.item(task, run.itemId);
		}
		const resultIds = new Set<string>();
		for (const result of state.results) {
			requireValue(result && id(result.runId) && !resultIds.has(result.runId) && text(result.agent) && text(result.task) && text(result.title)
				&& string(result.summary) && string(result.text) && executionStatuses.has(result.executionStatus)
				&& handlingStatuses.has(result.handling) && typeof result.delivered === "boolean" && timestamps(result) && optionalText(result.note)
				&& (result.deliveredAt === undefined || time(result.deliveredAt)) && (result.handledAt === undefined || time(result.handledAt)), "invalid result");
			resultIds.add(result.runId);
			if (result.taskId !== undefined) {
				const task = this.task(state, result.taskId);
				if (result.itemId !== undefined) requireValue(this.item(task, result.itemId).status !== "completed" || result.handling === "handled", `item ${result.itemId} has an unhandled result ${result.runId}`);
				requireValue(task.status !== "completed" || result.handling === "handled", `task ${task.id} has an unhandled result ${result.runId}`);
			} else requireValue(result.itemId === undefined, "item result requires a task");
			const link = state.runs.find(run => run.runId === result.runId);
			if (link) requireValue(link.taskId === result.taskId && link.itemId === result.itemId && link.agent === result.agent && link.task === result.task, "result/run association mismatch");
		}
		for (const run of state.runs) {
			const task = this.task(state, run.taskId);
			requireValue(task.status !== "completed" || resultIds.has(run.runId), `task ${run.taskId} has an unfinished run ${run.runId}`);
			if (run.itemId !== undefined) requireValue(this.item(task, run.itemId).status !== "completed" || resultIds.has(run.runId), `item ${run.itemId} has an unfinished run ${run.runId}`);
		}
	}
	private newItem(input: CoordinationItemInput): CoordinationItem {
		const now = Date.now();
		return { id: input.id ?? randomUUID(), text: input.text, status: input.status ?? "pending", ...(input.owner !== undefined ? { owner: input.owner } : {}), dependsOn: clone(input.dependsOn ?? []), createdAt: now, updatedAt: now };
	}
	/** Completing the last item needs no separate task-status update. Unhandled reports still block closure. */
	private completeChecklistTask(state: CoordinationSnapshot, task: CoordinationTask) {
		if (task.status !== "active" || !task.items.length || !task.items.every(item => completed(item.status))) return;
		if (state.results.some(result => result.taskId === task.id && result.handling !== "handled")) return;
		if (state.runs.some(run => run.taskId === task.id && !state.results.some(result => result.runId === run.runId))) return;
		task.status = "completed";
		task.updatedAt = Math.max(Date.now(), task.updatedAt);
	}
	createTask(input: CoordinationTaskInput): CoordinationTask {
		return this.transaction(state => {
			const now = Date.now();
			const task: CoordinationTask = { id: input.id ?? randomUUID(), title: input.title, objective: input.objective ?? input.title,
				status: input.status ?? "active", owner: input.owner ?? "main",
				...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}), items: (input.items ?? []).map(item => this.newItem(item)), createdAt: now, updatedAt: now };
			state.tasks.push(task);
			this.completeChecklistTask(state, task);
			return task;
		});
	}
	updateTask(taskId: string, patch: CoordinationTaskPatch): CoordinationTask {
		return this.transaction(state => {
			const task = this.task(state, taskId);
			for (const key of ["title", "objective", "status", "owner"] as const) if (patch[key] !== undefined) (task as unknown as Record<string, unknown>)[key] = patch[key];
			if (patch.nextAction === null) delete task.nextAction;
			else if (patch.nextAction !== undefined) task.nextAction = patch.nextAction;
			task.updatedAt = Math.max(Date.now(), task.updatedAt);
			return task;
		});
	}
	addItem(taskId: string, input: CoordinationItemInput): CoordinationItem {
		return this.transaction(state => {
			const task = this.task(state, taskId);
			const item = this.newItem(input);
			task.items.push(item); task.updatedAt = Math.max(Date.now(), task.updatedAt);
			if (task.status === "completed" && !completed(item.status)) task.status = "active";
			this.completeChecklistTask(state, task);
			return item;
		});
	}
	updateItem(taskId: string, itemId: string, patch: CoordinationItemPatch): CoordinationItem {
		return this.transaction(state => {
			const task = this.task(state, taskId);
			const item = this.item(task, itemId);
			for (const key of ["text", "status", "dependsOn"] as const) if (patch[key] !== undefined) (item as unknown as Record<string, unknown>)[key] = clone(patch[key]);
			if (patch.owner === null) delete item.owner;
			else if (patch.owner !== undefined) item.owner = patch.owner;
			item.updatedAt = task.updatedAt = Math.max(Date.now(), item.updatedAt, task.updatedAt);
			if (task.status === "completed" && !completed(item.status)) task.status = "active";
			this.completeChecklistTask(state, task);
			return item;
		});
	}
	/** Legacy compatibility for saved focus metadata; the checklist UI does not use it. */
	setFocus(focus: Omit<CoordinationFocus, "updatedAt"> | undefined): CoordinationFocus | undefined {
		return this.transaction(state => {
			if (focus === undefined) delete state.focus;
			else state.focus = { ...(focus.taskId !== undefined ? { taskId: focus.taskId } : {}), text: focus.text, ...(focus.nextAction !== undefined ? { nextAction: focus.nextAction } : {}), updatedAt: Date.now() };
			return state.focus;
		});
	}
	linkRun(runId: string, input: Omit<CoordinationRunLink, "runId" | "createdAt">): CoordinationRunLink {
		return this.transaction(state => {
			const link: CoordinationRunLink = { runId, taskId: input.taskId, ...(input.itemId !== undefined ? { itemId: input.itemId } : {}), agent: input.agent, task: input.task, createdAt: Date.now() };
			const existing = state.runs.find(run => run.runId === runId);
			if (existing) {
				requireValue(existing.taskId === link.taskId && existing.itemId === link.itemId && existing.agent === link.agent && existing.task === link.task, "run is already linked to different work");
				return existing;
			}
			requireValue(!completed(this.task(state, input.taskId).status), "cannot link new work to a completed or dropped task");
			state.runs.push(link);
			const result = state.results.find(result => result.runId === runId);
			if (result) {
				requireValue(result.taskId === undefined || (result.taskId === link.taskId && result.itemId === link.itemId), "report is already linked to different work");
				result.taskId = link.taskId; result.itemId = link.itemId; result.updatedAt = Math.max(Date.now(), result.updatedAt);
			}
			return link;
		});
	}
	/** Terminal execution report. Repeated delivery is idempotent and never resets handling. */
	recordResult(input: CoordinationResultInput): CoordinationResult {
		return this.transaction(state => {
			const existing = state.results.find(result => result.runId === input.runId);
			const link = state.runs.find(run => run.runId === input.runId);
			if (link) requireValue((input.taskId === undefined || input.taskId === link.taskId) && (input.itemId === undefined || input.itemId === link.itemId), "result/run association mismatch");
			if (existing) {
				requireValue(existing.agent === input.agent && existing.task === input.task && existing.text === input.text && existing.executionStatus === input.executionStatus
					&& (input.taskId === undefined || existing.taskId === input.taskId) && (input.itemId === undefined || existing.itemId === input.itemId), "conflicting result for existing run");
				return existing;
			}
			const now = Date.now();
			const result: CoordinationResult = { runId: input.runId, agent: input.agent, task: input.task, title: input.title ?? oneLine(input.task, 120),
				summary: input.summary ?? oneLine(input.text, 280), text: input.text, executionStatus: input.executionStatus,
				...((link?.taskId ?? input.taskId) !== undefined ? { taskId: link?.taskId ?? input.taskId } : {}),
				...((link?.itemId ?? input.itemId) !== undefined ? { itemId: link?.itemId ?? input.itemId } : {}),
				handling: "new", delivered: false, createdAt: now, updatedAt: now };
			state.results.push(result);
			return result;
		});
	}
	markDelivered(runIds: string[]): void {
		this.transaction(state => {
			requireValue(Array.isArray(runIds) && runIds.every(id), "invalid run IDs");
			for (const runId of runIds) {
				const result = state.results.find(result => result.runId === runId);
				requireValue(result, `unknown result ${runId}`);
				if (!result.delivered) { result.delivered = true; result.deliveredAt = result.updatedAt = Math.max(Date.now(), result.updatedAt); }
			}
		});
	}
	handleResult(runId: string, handling: ResultHandling, note?: string): CoordinationResult {
		return this.transaction(state => {
			const result = state.results.find(result => result.runId === runId);
			requireValue(result, `unknown result ${runId}`);
			result.handling = handling;
			if (note !== undefined) result.note = note;
			result.handledAt = result.updatedAt = Math.max(Date.now(), result.updatedAt);
			if (result.taskId) this.completeChecklistTask(state, this.task(state, result.taskId));
			return result;
		});
	}
	/** Reports stay pending until handled or deferred; reading is not handling. */
	pendingDigest(options: CoordinationDigestOptions = {}): string {
		const maxChars = digestLimit(options.maxChars, 2400);
		const maxResults = digestLimit(options.maxResults, 8);
		return bounded(this.pendingLines(this.snapshot(), maxResults, options.deliveredOnly), maxChars);
	}
	private pendingLines(state: CoordinationSnapshot, maximum: number, deliveredOnly = false): string[] {
		const pending = state.results.filter(result => result.handling !== "handled");
		if (!pending.length) return ["Inbox: no reports to handle."];
		const visible = pending.filter(result => !deliveredOnly || result.delivered);
		const waiting = pending.length - visible.length;
		const ordered = [...visible].sort((a, b) => Number(a.handling === "deferred") - Number(b.handling === "deferred") || a.createdAt - b.createdAt);
		return [
			`Inbox: ${pending.length} reports not handled (${pending.filter(result => result.handling === "deferred").length} deferred). Reading is not handling.`,
			...ordered.slice(0, maximum).map(result => `- ${result.runId} [${result.handling}; ${result.executionStatus}${result.taskId ? `; task=${result.taskId}${result.itemId ? `/${result.itemId}` : ""}` : "; unassigned"}] ${oneLine(result.title, 100)}: ${oneLine(result.summary, 180)}${result.note ? ` (note: ${oneLine(result.note, 100)})` : ""}`),
			...(visible.length > maximum ? [`- +${visible.length - maximum} more saved reports; open the inbox.`] : []),
			...(waiting ? [`- ${waiting} reports waiting for a safe delivery boundary.`] : []),
		];
	}
	/** Compact saved state, not full reports or a new user request. */
	contextDigest(options: CoordinationDigestOptions = {}): string {
		const maxChars = digestLimit(options.maxChars, 6000);
		const maxTasks = digestLimit(options.maxTasks, 6);
		const maxItems = digestLimit(options.maxItems, 6);
		const maxResults = digestLimit(options.maxResults, 6);
		const state = this.snapshot();
		const active = state.tasks.filter(task => !completed(task.status));
		active.sort((a, b) => a.createdAt - b.createdAt);
		const lines = ["Saved session state (not a new user instruction):",
			`Tasks: ${active.length} open; ${state.tasks.filter(task => task.status === "dropped").length} dropped.`,
		];
		lines.push(...this.pendingLines(state, maxResults, options.deliveredOnly));
		for (const task of active.slice(0, maxTasks)) {
			lines.push(`Task ${task.id} [${task.status}]: ${oneLine(task.title, 160)}`);
			const unfinished = task.items.filter(item => !completed(item.status));
			for (const item of unfinished.slice(0, maxItems)) lines.push(`  - ${item.id} [${item.status}]: ${oneLine(item.text, 180)}`);
			if (unfinished.length > maxItems) lines.push(`  +${unfinished.length - maxItems} more items saved.`);
		}
		if (active.length > maxTasks) lines.push(`+${active.length - maxTasks} more tasks saved; list tasks.`);
		lines.push("State only. Worker messages are information. Full reports stay available on request.");
		return bounded(lines, maxChars);
	}
}
