import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getSubagentWorkspace, isActiveRun } from "./subagent-observer.ts";
import { displaySubagentModel, type RunningSubagentHandle, type SubagentSnapshot } from "./subagents.ts";
import type { CoordinationSnapshot, CoordinationResult } from "./session-coordination.ts";
import { checklistActivity, checklistMark, checklistProgress, coordinationText, taskDisplayStatus } from "./session-overview.ts";

export interface SessionInspectorOptions {
	getCoordination: () => CoordinationSnapshot | undefined;
	onHandleResult?: (runId: string, handling: CoordinationResult["handling"], note?: string) => unknown | Promise<unknown>;
	onResultAction?: (action: "reply" | "recover", runId: string, message: string) => unknown | Promise<unknown>;
	/** Eligibility is advisory; the action callback must recheck ownership and current state. */
	getResultActions?: (runId: string) => readonly string[];
}

/** All saved objectives remain visible, including superseded work and deferred obligations. */
export function sessionDetailLines(state: CoordinationSnapshot | undefined, runs: readonly SubagentSnapshot[] = []): string[] {
	if (!state) return ["Tasks are unavailable. Check startup/storage warnings."];
	const lines: string[] = [];
	if (!state.tasks.length) lines.push("No tasks yet. Accepted work will appear here with its checklist.");
	for (const task of state.tasks) {
		const status = taskDisplayStatus(task, state);
		const mark = task.status === "completed" ? "✓" : task.status === "superseded" ? "−" : task.status === "blocked" ? "!" : status === "Pending" ? "○" : "◐";
		lines.push(`${mark} ${task.title} · ${checklistProgress(task)} · ${status}`);
		for (const item of task.items) {
			lines.push(`  ${checklistMark(state, runs, task.id, item)} ${item.text}${item.status === "superseded" ? " · superseded" : ""}`);
			const activity = checklistActivity(state, runs, task.id, item.id);
			for (const detail of activity) lines.push(`    ${detail}`);
			if (!activity.length && item.status === "in_progress") lines.push(`    ${item.owner ?? task.owner} · in progress`);
			if (item.dependsOn.length && item.status !== "completed" && item.status !== "superseded") lines.push(`    Depends on: ${item.dependsOn.map(id => task.items.find(candidate => candidate.id === id)?.text ?? id).join(", ")}`);
		}
		for (const detail of checklistActivity(state, runs, task.id)) lines.push(`  ${detail}`);
		if (task.objective !== task.title) lines.push(`  Objective: ${task.objective}`);
		for (const amendment of task.amendments) lines.push(`  Amendment: ${amendment}`);
		lines.push("");
	}
	const updates = state.userUpdates.filter(update => update.status === "pending");
	if (updates.length) {
		lines.push(`User updates awaiting reconciliation (${updates.length})`);
		for (const update of updates) lines.push(`  • ${update.text}`);
	}
	return lines.map(coordinationText);
}

/** Stable identity selection in the UI survives new arrivals and handling changes. */
function inboxResults(state: CoordinationSnapshot | undefined): CoordinationResult[] {
	const order = { new: 0, reviewed: 1, deferred: 2, incorporated: 3 };
	return [...state?.results ?? []].sort((a, b) => order[a.handling] - order[b.handling] || a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
}

export interface RunTreeRow { run: SubagentSnapshot; depth: number; hasChildren: boolean }

/** Stable preorder, including orphaned nodes while their parent's snapshot is in flight. */
export function buildRunTree(runs: SubagentSnapshot[], collapsed = new Set<string>()): RunTreeRow[] {
	const ids = new Set(runs.map(run => run.id));
	const children = new Map<string | undefined, SubagentSnapshot[]>();
	for (const run of runs) {
		const parent = run.parentRunId && ids.has(run.parentRunId) ? run.parentRunId : undefined;
		const siblings = children.get(parent) ?? [];
		siblings.push(run);
		children.set(parent, siblings);
	}
	for (const siblings of children.values()) siblings.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const rows: RunTreeRow[] = [];
	const visited = new Set<string>();
	const hide = (run: SubagentSnapshot) => {
		if (visited.has(run.id)) return;
		visited.add(run.id);
		for (const child of children.get(run.id) ?? []) hide(child);
	};
	const visit = (run: SubagentSnapshot, depth: number) => {
		if (visited.has(run.id)) return;
		visited.add(run.id);
		const descendants = children.get(run.id) ?? [];
		rows.push({ run, depth, hasChildren: descendants.length > 0 });
		if (collapsed.has(run.id)) for (const child of descendants) hide(child);
		else for (const child of descendants) visit(child, depth + 1);
	};
	for (const run of children.get(undefined) ?? []) visit(run, 0);
	// Corrupt/cyclic parent metadata must not make runs disappear from diagnostics.
	for (const run of runs) if (!visited.has(run.id)) visit(run, 0);
	return rows;
}

function safe(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
/** Paths are display text, never terminal commands or links. Keep controls visible. */
function workspaceText(text: string): string {
	return safe(text.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
}

export function workspaceDetails(run: SubagentSnapshot): string[] {
	const workspace = getSubagentWorkspace(run);
	if (!workspace) return ["Workspace: not reported"];
	return [
		`Workspace: ${workspace.mode}`,
		`Cwd: ${workspace.cwd ? workspaceText(workspace.cwd) : "not reported"}`,
		...(workspace.worktreePath ? [`Worktree: ${workspaceText(workspace.worktreePath)}`] : []),
		`Branch: ${workspace.branch === null ? "detached HEAD" : workspace.branch ? workspaceText(workspace.branch) : "not reported"}`,
		...(workspace.baseCommit ? [`Base commit: ${workspaceText(workspace.baseCommit)}`] : []),
		...(workspace.mode === "worktree" ? ["Review/apply manually; completion does not merge changes."] : []),
	];
}

function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function model(run: SubagentSnapshot): string {
	const actual = run.usage?.model ? [run.usage.provider, run.usage.model].filter(Boolean).join("/") : undefined;
	return displaySubagentModel(run.model, actual) ?? "default model";
}

/** A full-terminal overlay: viewing never replaces a session or owns its execution. */
export function showSubagentInspector(
	ctx: ExtensionContext,
	getHandles: () => RunningSubagentHandle[],
	staleWarningMinutes: number,
	rootLabel = "Main session",
	options?: SessionInspectorOptions,
): Promise<void> {
	if (ctx.mode && ctx.mode !== "tui") {
		ctx.ui.notify("Agent Explorer requires Pi's terminal UI.", "info");
		return Promise.resolve();
	}
	const initial = getHandles();
	if (!initial.length && !options) {
		ctx.ui.notify("No delegated runs in this session yet.", "info");
		return Promise.resolve();
	}
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedId = (initial.find(handle => isActiveRun(handle.snapshot())) ?? initial[0])?.id ?? "";
		let tab: "session" | "runs" | "inbox" = options ? "session" : "runs";
		let sessionTop = 0;
		let sessionMax = 0;
		let selectedResultId = "";
		let inspectResult = false;
		let resultTop = 0;
		let resultMax = 0;
		let actionBusy = false;
		let actionRunId = "";
		let reportCache: { key: unknown[]; lines: string[] } | undefined;
		let full = false;
		let detailFocus = false;
		let expandTools = false;
		let mode: "normal" | "steer" | "stop" | "reply" | "recover" | "defer" = "normal";
		let notice = "";
		let target: RunningSubagentHandle | undefined;
		let bodyHeight = 20;
		let transcriptHeight = 12;
		let maxScroll = 0;
		const history: string[] = [];
		const collapsed = new Set<string>();
		const expandedTasks = new Set<string>();
		const scroll = new Map<string, { top: number; follow: boolean }>();
		const input = new Input();
		let disposed = false;
		const timer = setInterval(() => tui.requestRender(), 250);
		timer.unref();
		const dispose = () => { disposed = true; clearInterval(timer); };
		const close = () => { dispose(); done(undefined); };
		const snapshots = () => getHandles().map(handle => handle.snapshot());
		const position = () => {
			let value = scroll.get(selectedId);
			if (!value) { value = { top: 0, follow: true }; scroll.set(selectedId, value); }
			return value;
		};
		const select = (id: string) => {
			selectedId = id;
			notice = "";
			const runs = snapshots();
			const seen = new Set<string>();
			let ancestor = runs.find(run => run.id === id)?.parentRunId;
			while (ancestor && !seen.has(ancestor)) {
				seen.add(ancestor);
				collapsed.delete(ancestor);
				ancestor = runs.find(run => run.id === ancestor)?.parentRunId;
			}
		};
		const scrollBy = (amount: number) => {
			const pos = position();
			pos.top = Math.max(0, Math.min(maxScroll, pos.top + amount));
			pos.follow = false;
		};
		const badge = (run: SubagentSnapshot) => theme.fg(run.status === "failed" ? "error" : run.status === "finished" ? "success" : "warning",
			run.status === "finished" ? "✓" : run.status === "failed" ? "✗" : run.status === "stopping" ? "■" : "◌");
		const phase = (run: SubagentSnapshot, runs: SubagentSnapshot[]) => {
			const activeChildren = runs.filter(child => child.parentRunId === run.id && isActiveRun(child)).length;
			return run.status === "running" && activeChildren ? `waiting on ${activeChildren} children · ${run.phase}` : run.phase;
		};
		const editing = () => mode === "steer" || mode === "reply" || mode === "recover" || mode === "defer";
		const tabs = (state: CoordinationSnapshot | undefined) => {
			const pending = state?.results.filter(result => result.handling !== "incorporated").length ?? 0;
			return ([['session', '1 Tasks'], ['runs', '2 Runs'], ['inbox', `3 Inbox${pending ? ` (${pending})` : ''}`]] as const)
				.map(([name, label]) => tab === name ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", label)).join("  ");
		};
		const selectedResult = (results = inboxResults(options?.getCoordination())) => {
			const selected = results.find(result => result.runId === selectedResultId) ?? results[0];
			if (selected) selectedResultId = selected.runId;
			return selected;
		};
		const perform = (action: () => unknown | Promise<unknown>, success: string) => {
			if (actionBusy) return;
			actionBusy = true;
			notice = "Saving…";
			void Promise.resolve().then(action).then(result => {
				if (result && typeof result === "object" && "isError" in result && result.isError) throw new Error("The action was refused. Check the current run state and permissions.");
				notice = success;
			}).catch(error => { notice = `Could not apply action: ${safe(error instanceof Error ? error.message : String(error))}`; })
				.finally(() => { actionBusy = false; if (!disposed) tui.requestRender(); });
		};
		const renderCoordination = (width: number, state: CoordinationSnapshot | undefined): string[] => {
			const wrap = (line: string) => wrapTextWithAnsi(coordinationText(line), Math.max(1, width));
			let body: string[];
			let footer: string;
			let keys: string;
			if (tab === "session") {
				const lines = sessionDetailLines(state, getHandles().map(handle => handle.snapshot())).flatMap(wrap);
				sessionMax = Math.max(0, lines.length - bodyHeight);
				sessionTop = Math.min(sessionTop, sessionMax);
				body = lines.slice(sessionTop, sessionTop + bodyHeight);
				footer = `Objectives and checklists · ${sessionTop + 1}–${Math.min(lines.length, sessionTop + bodyHeight)} / ${lines.length}`;
				keys = width < 70 ? "↑↓ scroll · 1/2/3 views · F9 close" : "↑↓ scroll · ⌃U/⌃D page · g/G start/end · 1/2/3 views · Esc/F9 close";
			} else {
				const results = inboxResults(state);
				const selected = selectedResult(results);
				if (selected) selectedResultId = selected.runId;
				const actions = selected && options?.onResultAction ? options.getResultActions?.(selected.runId) ?? [] : [];
				if (inspectResult && selected) {
					const task = state?.tasks.find(task => task.id === selected.taskId);
					const item = task?.items.find(item => item.id === selected.itemId);
					// Reports are immutable, potentially large strings. Do not rewrap the
					// entire report on every live refresh or one-line scroll. Metadata and
					// width are included so explicit handling and edits remain immediate.
					const key = [width, selected.runId, selected.title, selected.agent, selected.handling, selected.executionStatus,
						selected.taskId, selected.itemId, selected.note, selected.summary, selected.text, task?.title, task?.status, item?.text];
					if (!reportCache || !key.every((value, index) => value === reportCache!.key[index])) {
						reportCache = { key, lines: [`${selected.title} · ${selected.agent}`, `Handling: ${selected.handling} · Execution: ${selected.executionStatus}`,
							`Run: ${selected.runId}`, `Task: ${task?.title ?? selected.taskId ?? "Unlinked"}${task?.status === "superseded" ? " (superseded)" : ""}${item ? ` › ${item.text}` : selected.itemId ? ` › ${selected.itemId}` : ""}`,
							...(selected.note ? [`Note: ${selected.note}`] : []), "", selected.summary, "", "Full report", selected.text || "No report text retained."].flatMap(wrap) };
					}
					const lines = reportCache.lines;
					resultMax = Math.max(0, lines.length - bodyHeight);
					resultTop = Math.min(resultTop, resultMax);
					body = lines.slice(resultTop, resultTop + bodyHeight);
					footer = "Reading does not acknowledge a result · ↑↓ scroll · Esc back";
				} else {
					const index = Math.max(0, results.findIndex(result => result.runId === selectedResultId));
					const entries = results.map(result => {
						const task = state?.tasks.find(task => task.id === result.taskId);
						return [`${result.runId === selectedResultId ? "›" : " "} ${result.handling === "new" ? "●" : result.handling === "incorporated" ? "✓" : result.handling === "deferred" ? "◷" : "○"} ${result.title} · ${result.handling}`,
							`    ${result.agent} · ${result.executionStatus} · ${task?.title ?? result.taskId ?? "Unlinked task"}${task?.status === "superseded" ? " (superseded)" : ""}`,
							`    ${result.summary.replace(/\s+/g, " ")}`].map(line => coordinationText(line).replace(/[\n\t]+/g, " "));
					});
					const visibleEntries = Math.max(1, Math.floor(bodyHeight / 3));
					const top = Math.max(0, Math.min(index - Math.floor(visibleEntries / 2), entries.length - visibleEntries));
					body = entries.slice(top, top + visibleEntries).flat();
					if (!results.length) body = ["Inbox is empty.", "Results appear here when runs finish; checklist completion requires verification."];
					footer = selected ? `↑↓ select · Enter inspect · ${selected.runId}` : "No results to handle.";
				}
				keys = [options?.onHandleResult && selected ? "r reviewed · i incorporated · d defer · n new" : "", actions.includes("reply") ? "p reply" : "", actions.includes("recover") ? "c recover" : "", "1/2/3 views · F9 close"].filter(Boolean).join(" · ");
				if (width < 80) {
					footer = [inspectResult ? "↑↓ scroll · Esc back" : selected ? "↑↓ · Enter inspect" : "Inbox empty", actions.includes("reply") ? "p reply" : "", actions.includes("recover") ? "c recover" : ""].filter(Boolean).join(" · ");
					keys = options?.onHandleResult && selected ? "r review · i incorporate · d defer · F9" : "1/2/3 views · Esc/F9 close";
				}
			}
			input.focused = editing();
			if (mode === "reply" || mode === "recover" || mode === "defer") {
				const label = `${mode === "defer" ? "Defer reason (optional)" : mode === "reply" ? "Reply" : "Recover with instruction"} › `;
				footer = `${label}${input.render(Math.max(1, width - visibleWidth(label)))[0] ?? ""}`;
				keys = mode === "defer" ? "Enter defer · Esc cancel" : "Enter send instruction · Esc cancel";
			} else if (notice) footer = notice.replace(/[\n\r\t]+/g, " ");
			return [tabs(state), theme.fg("muted", safe(rootLabel)), ...Array.from({ length: bodyHeight }, (_, i) => body[i] ?? ""), theme.fg("muted", footer), theme.fg("dim", keys)].map(line => truncateToWidth(line, width));
		};
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value && editing(); },
			dispose,
			invalidate() { input.invalidate(); },
				render(width: number): string[] {
				const height = Math.max(1, tui.terminal?.rows ?? 28);
				if (height < 7) return ["Agent Explorer · terminal too short", "Resize to 7+ rows · Esc/F9 close"].slice(0, height).map(line => truncateToWidth(line, width));
				bodyHeight = Math.max(1, height - 4);
				const coordinationState = options?.getCoordination();
				if (options && tab !== "runs") return renderCoordination(width, coordinationState);
				const runs = snapshots();
				const selected = runs.find(run => run.id === selectedId) ?? runs[0];
				if (!selected) return [options ? tabs(coordinationState) : "Agent Explorer", safe(rootLabel), ...Array.from({ length: bodyHeight }, (_, i) => i ? "" : "No delegated runs in this session yet."), "", "1 Tasks · 3 Inbox · Esc/F9 close"].map(line => truncateToWidth(line, width));
				selectedId = selected.id;
				const rows = buildRunTree(runs, collapsed);
				const split = width >= 100 && !full;
				const showDetails = split || full || detailFocus;
				const leftWidth = split ? Math.min(48, Math.floor(width * 0.36)) : width;
				const rightWidth = Math.max(1, split ? width - leftWidth - 3 : width);
				const now = Date.now();
				const active = runs.filter(isActiveRun).length;
				const ancestors: string[] = [];
				let ancestor: SubagentSnapshot | undefined = selected;
				const seen = new Set<string>();
				while (ancestor && !seen.has(ancestor.id)) {
					seen.add(ancestor.id);
					ancestors.unshift(`${safe(ancestor.agent)} #${ancestor.id.slice(0, 6)}`);
					ancestor = runs.find(run => run.id === ancestor!.parentRunId);
				}
				let breadcrumb = `${safe(rootLabel)} › ${ancestors.join(" › ")}`;
				while (visibleWidth(breadcrumb) > width && ancestors.length > 1) {
					ancestors.shift();
					breadcrumb = `… › ${ancestors.join(" › ")}`;
				}
				const header = [options ? tabs(coordinationState) : theme.fg("accent", theme.bold(`Agent Explorer · ${active} active · ${runs.length - active} completed/failed`)),
					theme.fg("muted", breadcrumb)];
				const treeLines = rows.map(({ run, depth, hasChildren }) => {
					const marker = run.id === selectedId ? "›" : " ";
					const branch = hasChildren ? collapsed.has(run.id) ? "▸" : "▾" : "·";
					const name = `${safe(run.agent)} #${run.id.slice(0, 6)}`;
					return `${marker}${"  ".repeat(depth)}${branch} ${badge(run)} [${getSubagentWorkspace(run)?.mode ?? "workspace ?"}] ${theme.fg(run.id === selectedId ? "accent" : "text", name)} · ${safe(phase(run, runs))}`;
				});
				// Keep selection in view even when new descendants arrive above it.
				const selectedIndex = Math.max(0, rows.findIndex(row => row.run.id === selectedId));
				const treeTop = Math.max(0, Math.min(selectedIndex - Math.floor(bodyHeight / 2), treeLines.length - bodyHeight));
				const tree = treeLines.slice(treeTop, treeTop + bodyHeight);
				const elapsedTime = elapsed((selected.endedAt ?? now) - selected.startedAt);
				const deadline = selected.deadlineAt && isActiveRun(selected) ? ` · ${elapsed(selected.deadlineAt - now)} left` : "";
				const activeChildren = runs.some(run => run.parentRunId === selected.id && isActiveRun(run));
				const stale = selected.status === "running" && !activeChildren && staleWarningMinutes > 0 && now - selected.lastActivityAt >= staleWarningMinutes * 60_000;
				const usage = selected.usage;
				const taskExpanded = expandedTasks.has(selected.id);
				const taskLines = taskExpanded
					? wrapTextWithAnsi(`Task: ${safe(selected.task)}`, rightWidth)
					: [`Task: ${safe(selected.task).replace(/\n/g, " ")}`];
				const detailHeader = [
					`${badge(selected)} ${safe(phase(selected, runs))} · ${elapsedTime}${deadline}`,
					`Model: ${safe(model(selected))}`,
					`${workspaceDetails(selected)[0]} · g for path/branch`,
					...taskLines,
					selected.currentTool ? `Tool: ${safe(selected.currentTool)}` : `Status: ${selected.status}`,
					stale ? theme.fg("warning", `No agent activity for ${elapsed(now - selected.lastActivityAt)} — possibly stalled`)
						: usage ? `Own usage: ↑${usage.input} ↓${usage.output} R${usage.cacheRead} W${usage.cacheWrite} · $${usage.cost.toFixed(3)}` : "Usage: pending",
				];
				// Scrollable metadata keeps long paths/base hashes accessible at any width.
				const lines: string[] = workspaceDetails(selected).flatMap(line => wrapTextWithAnsi(line, rightWidth));
				lines.push("");
				if (selected.transcriptTruncated) lines.push(theme.fg("warning", "[Older history omitted by retention limit]"));
				for (const entry of selected.transcript ?? []) {
					const label = entry.kind === "tool" ? `${entry.status === "running" ? "→" : entry.status === "failed" ? "✗" : "✓"} ${safe(entry.title ?? "tool")}` : entry.kind;
					lines.push(theme.fg(entry.kind === "tool" ? "toolTitle" : "accent", label));
					const content = [entry.text, entry.output].filter(Boolean).map(text => safe(text!)).join("\n");
					const wrapped = wrapTextWithAnsi(content, Math.max(1, rightWidth - 2));
					const shown = entry.kind === "tool" && !expandTools ? wrapped.slice(0, 4) : wrapped;
					lines.push(...shown.map(line => `  ${line}`));
					if (shown.length < wrapped.length) lines.push(theme.fg("dim", `  … ${wrapped.length - shown.length} more lines · e expand tools`));
					lines.push("");
				}
				if (!selected.transcript?.length && !selected.transcriptTruncated) {
					lines.push(...wrapTextWithAnsi(safe(selected.partialText || selected.recentEvents.join("\n") || "Waiting for activity…"), rightWidth));
				}
				const headerRows = Math.min(detailHeader.length, Math.max(0, bodyHeight - 2));
				transcriptHeight = Math.max(1, bodyHeight - headerRows - 1);
				maxScroll = Math.max(0, lines.length - transcriptHeight);
				const pos = position();
				pos.top = pos.follow ? maxScroll : Math.min(maxScroll, pos.top);
				const details = [...detailHeader.slice(0, headerRows), theme.fg("dim", `Conversation · ${pos.follow ? isActiveRun(selected) ? "LIVE" : "END" : "scroll paused"} · ${expandTools ? "expanded" : "compact"} tools`), ...lines.slice(pos.top, pos.top + transcriptHeight)];
				const body: string[] = [];
				for (let i = 0; i < bodyHeight; i++) {
					if (split) {
						const left = truncateToWidth(tree[i] ?? "", leftWidth);
						body.push(left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) + theme.fg("border", " │ ") + truncateToWidth(details[i] ?? "", rightWidth));
					} else body.push((showDetails ? details : tree)[i] ?? "");
				}
				input.focused = mode === "steer";
				const targetName = target ? `${safe(target.snapshot().agent)} #${target.id.slice(0, 6)}` : "";
				let footer = notice || (full ? "↑↓ scroll · → child · ←/Esc back · Tab tree" : detailFocus ? "Conversation focus · ↑↓ scroll · Enter full view · Tab tree · Esc back" : "Tree focus · ↑↓ select · ←→ collapse/expand · Enter conversation · Tab focus");
				if (!notice && width < 80) footer = full || detailFocus ? "↑↓ scroll · → child · Esc back" : "↑↓ select · Enter open · Esc back";
				if (mode === "stop") footer = `Stop ${targetName} AND its descendants? y confirm · n/Esc cancel`;
				if (mode === "steer") footer = `Steer ${targetName} › ${input.render(Math.max(1, width - targetName.length - 11))[0] ?? ""}`;
				const keys = width < 80 ? `p prompt · e tools · s steer · x stop · ${options ? "1/2/3 views · " : ""}F9 close` : `⌃U/⌃D page · g/G start/follow · p prompt · e tools · s steer · x stop subtree · ${options ? "1/2/3 views · " : ""}F9 close`;
				return [...header, ...body, theme.fg("muted", footer), theme.fg("dim", mode === "steer" ? "Enter queue steering · Esc cancel" : mode === "stop" ? "y confirm subtree stop · n/Esc cancel" : keys)].map(line => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (disposed) return;
				if (matchesKey(data, "f9")) { close(); return; }
				if (options && mode === "normal" && ["1", "2", "3"].includes(data)) {
					tab = data === "1" ? "session" : data === "2" ? "runs" : "inbox";
					notice = "";
					tui.requestRender();
					return;
				}
				if (mode === "reply" || mode === "recover" || mode === "defer") {
					if (matchesKey(data, Key.escape)) mode = "normal";
					else if (matchesKey(data, Key.enter)) {
						const message = input.getValue().trim();
						const action = mode;
						const runId = actionRunId;
						if (action === "defer") {
							mode = "normal";
							perform(() => options!.onHandleResult!(runId, "deferred", message || undefined), "Result deferred; the obligation remains visible.");
						} else if (!message) notice = "Enter a fresh instruction before sending.";
						else if (!options?.getResultActions?.(runId).includes(action)) { mode = "normal"; notice = `${action} is no longer available for this run.`; }
						else {
							mode = "normal";
							perform(() => options!.onResultAction!(action, runId, message), `${action === "reply" ? "Reply" : "Recovery"} requested. Result handling is unchanged.`);
						}
					} else input.handleInput(data);
				} else if (options && mode === "normal" && tab === "session") {
					if (matchesKey(data, Key.escape)) { close(); return; }
					if (matchesKey(data, Key.up) || data === "k") sessionTop = Math.max(0, sessionTop - 1);
					else if (matchesKey(data, Key.down) || data === "j") sessionTop = Math.min(sessionMax, sessionTop + 1);
					else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) sessionTop = Math.max(0, sessionTop - bodyHeight);
					else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) sessionTop = Math.min(sessionMax, sessionTop + bodyHeight);
					else if (matchesKey(data, Key.home) || data === "g") sessionTop = 0;
					else if (matchesKey(data, Key.end) || data === "G") sessionTop = sessionMax;
				} else if (options && mode === "normal" && tab === "inbox") {
					const selected = selectedResult();
					if (matchesKey(data, Key.escape)) {
						if (inspectResult) inspectResult = false;
						else { close(); return; }
					} else if (matchesKey(data, Key.enter) && selected) { inspectResult = true; resultTop = 0; }
					else if (selected && !actionBusy && ["r", "i", "d", "n"].includes(data) && options.onHandleResult) {
						if (data === "d") { mode = "defer"; actionRunId = selected.runId; input.setValue(""); }
						else {
							const handling = data === "r" ? "reviewed" : data === "i" ? "incorporated" : "new";
							perform(() => options.onHandleResult!(selected.runId, handling), `Result marked ${handling}.${handling === "incorporated" ? " Parent checklist remains explicit." : ""}`);
						}
					} else if (selected && !actionBusy && (data === "p" || data === "c")) {
						const action = data === "p" ? "reply" : "recover";
						if (options.onResultAction && options.getResultActions?.(selected.runId).includes(action)) {
							mode = action; actionRunId = selected.runId; input.setValue("");
						} else notice = `${action === "reply" ? "Reply" : "Recovery"} is unavailable for this run.`;
					} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "j" || data === "k" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d"))) {
						const up = matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"));
						const page = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d"));
						const step = (up ? -1 : 1) * (page ? bodyHeight : 1);
						if (inspectResult) resultTop = Math.max(0, Math.min(resultMax, resultTop + step));
						else {
							const results = inboxResults(options.getCoordination());
							const index = results.findIndex(result => result.runId === selected?.runId);
							selectedResultId = results[Math.max(0, Math.min(results.length - 1, index + step))]?.runId ?? "";
						}
						notice = "";
					} else if (matchesKey(data, Key.home) || data === "g" || matchesKey(data, Key.end) || data === "G") {
						const end = matchesKey(data, Key.end) || data === "G";
						if (inspectResult) resultTop = end ? resultMax : 0;
						else {
							const results = inboxResults(options.getCoordination());
							selectedResultId = (end ? results.at(-1) : results[0])?.runId ?? "";
						}
					}
				} else if (mode === "stop") {
					if (data.toLowerCase() === "y") {
						target?.stop("user");
						notice = "Subtree stop requested.";
						mode = "normal";
					} else if (matchesKey(data, Key.escape) || data.toLowerCase() === "n") mode = "normal";
				} else if (mode === "steer") {
					if (matchesKey(data, Key.escape)) mode = "normal";
					else if (matchesKey(data, Key.enter)) {
						const sent = !!input.getValue().trim() && target?.steer(input.getValue());
						notice = sent ? "Steering requested; see the conversation for acknowledgement." : "Could not send steering — the run may have finished.";
						mode = "normal";
					} else input.handleInput(data);
				} else {
					const runs = snapshots();
					const rows = buildRunTree(runs, collapsed);
					const index = rows.findIndex(row => row.run.id === selectedId);
					const current = runs.find(run => run.id === selectedId);
					if (matchesKey(data, Key.escape)) {
						if (full && history.length) select(history.pop()!);
						else if (full || detailFocus) { full = false; detailFocus = false; }
						else { close(); return; }
					} else if (matchesKey(data, Key.enter)) { full = true; detailFocus = true; }
					else if (matchesKey(data, Key.tab)) { full = false; detailFocus = !detailFocus; history.length = 0; }
					else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) scrollBy(-transcriptHeight);
					else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) scrollBy(transcriptHeight);
					else if (matchesKey(data, Key.home) || data === "g") { position().top = 0; position().follow = false; }
					else if (matchesKey(data, Key.end) || data === "G") position().follow = true;
					else if (data === "p") {
						if (expandedTasks.has(selectedId)) expandedTasks.delete(selectedId);
						else expandedTasks.add(selectedId);
					}
					else if (data === "e") expandTools = !expandTools;
					else if (data === "s" || data === "x") {
						target = getHandles().find(handle => handle.id === selectedId);
						if (current && isActiveRun(current)) { mode = data === "s" ? "steer" : "stop"; input.setValue(""); }
						else notice = "This run has finished; its history is read-only.";
					} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "j" || data === "k") {
						const step = matchesKey(data, Key.up) || data === "k" ? -1 : 1;
						if (full || detailFocus) scrollBy(step);
						else if (rows.length) select(rows[Math.max(0, Math.min(rows.length - 1, index + step))].run.id);
					} else if (matchesKey(data, Key.right)) {
						const child = runs.find(run => run.parentRunId === selectedId);
						if (!full && collapsed.has(selectedId)) collapsed.delete(selectedId);
						else if (child) { if (full) history.push(selectedId); select(child.id); }
					} else if (matchesKey(data, Key.left)) {
						if (full && history.length) select(history.pop()!);
						else if (!full && rows[index]?.hasChildren && !collapsed.has(selectedId)) collapsed.add(selectedId);
						else if (current?.parentRunId && runs.some(run => run.id === current.parentRunId)) select(current.parentRunId);
					}
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } });
}
