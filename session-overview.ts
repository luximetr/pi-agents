import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CoordinationItem, CoordinationSnapshot, CoordinationTask } from "./session-coordination.ts";
import { isActiveRun } from "./subagent-observer.ts";
import type { SubagentSnapshot } from "./subagents.ts";

/** Coordination text is untrusted display content, never terminal control sequences. */
export function coordinationText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function oneLine(text: string): string { return coordinationText(text).replace(/\s+/g, " ").trim(); }

export function checklistProgress(task: CoordinationTask): string {
	const items = task.items.filter(item => item.status !== "superseded");
	return items.length ? `${items.filter(item => item.status === "completed").length}/${items.length} done` : "No checklist";
}

/** Execution and report handling decorate the checklist; neither checks an item off. */
export function checklistActivity(state: CoordinationSnapshot, runs: readonly SubagentSnapshot[], taskId: string, itemId?: string): string[] {
	const links = state.runs.filter(link => link.taskId === taskId && link.itemId === itemId);
	const reports = state.results.filter(result => result.taskId === taskId && result.itemId === itemId && result.handling !== "incorporated");
	return [
		...links.flatMap(link => {
			const run = runs.find(run => run.id === link.runId);
			if (run && isActiveRun(run)) return [`${link.agent} · running`];
			if (state.results.some(result => result.runId === link.runId)) return [];
			return [`${link.agent} · ${run ? run.status : "status unavailable"}`];
		}),
		...reports.map(result => `${result.agent} · ${result.executionStatus !== "completed" ? `${result.executionStatus} · ` : ""}${result.handling === "new" ? "awaiting review" : result.handling === "reviewed" ? "awaiting incorporation" : "deferred"}`),
	];
}

export function checklistMark(state: CoordinationSnapshot, runs: readonly SubagentSnapshot[], taskId: string, item: CoordinationItem): string {
	if (item.status === "completed") return "✓";
	if (item.status === "superseded") return "−";
	const linked = state.runs.some(link => link.taskId === taskId && link.itemId === item.id && runs.some(run => run.id === link.runId && isActiveRun(run)))
		|| state.results.some(result => result.taskId === taskId && result.itemId === item.id && result.handling !== "incorporated");
	return item.status === "in_progress" || linked ? "◐" : "○";
}

export function taskDisplayStatus(task: CoordinationTask, state: CoordinationSnapshot): string {
	if (task.status !== "active") return ({ blocked: "Blocked", completed: "Completed", superseded: "Superseded" })[task.status];
	const started = task.items.some(item => item.status === "in_progress" || item.status === "completed")
		|| state.runs.some(link => link.taskId === task.id) || state.results.some(result => result.taskId === task.id);
	return started ? "In progress" : "Pending";
}

function header(label: string, width: number): string {
	const hint = width >= 60 ? "F9 checklist" : "F9";
	if (width < 12) return truncateToWidth(`Tasks · ${hint}`, width);
	const left = truncateToWidth(label, width - hint.length - 2);
	return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - hint.length))}${hint}`;
}

function taskSummary(task: CoordinationTask, state: CoordinationSnapshot, width: number): string {
	const status = taskDisplayStatus(task, state);
	const mark = task.status === "completed" ? "✓" : task.status === "superseded" ? "−" : task.status === "blocked" ? "!" : status === "Pending" ? "○" : "◐";
	const suffix = ` · ${checklistProgress(task)}${width >= 55 ? ` · ${status}` : ""}`;
	return width >= 30 ? `${mark} ${truncateToWidth(oneLine(task.title), Math.max(1, width - visibleWidth(suffix) - 2))}${suffix}` : `${mark} ${oneLine(task.title)} · ${checklistProgress(task)}`;
}

function taskActivity(task: CoordinationTask, state: CoordinationSnapshot, runs: readonly SubagentSnapshot[], width: number): string {
	const unfinished = task.items.filter(item => item.status === "pending" || item.status === "in_progress");
	const active = unfinished.filter(item => item.status === "in_progress" || checklistActivity(state, runs, task.id, item.id).length);
	const item = active[0] ?? unfinished.find(item => item.dependsOn.every(id => task.items.some(candidate => candidate.id === id && ["completed", "superseded"].includes(candidate.status)))) ?? unfinished[0];
	const activity = item ? checklistActivity(state, runs, task.id, item.id) : [];
	const taskActivity = checklistActivity(state, runs, task.id);
	const detail = activity.length ? activity.join(" · ") : item?.status === "in_progress" ? `${item.owner ?? task.owner} · in progress` : item ? "pending" : "";
	// On narrow terminals, retain the action state instead of clipping it after a long title.
	if (item && width < 88) {
		const compact = activity.length ? activity.map(entry => entry.slice(entry.indexOf(" · ") + 3)).join(" · ") : item.status === "in_progress" ? "in progress" : "pending";
		const suffix = truncateToWidth(` · ${compact}${active.length > 1 ? ` · +${active.length - 1} active` : ""}`, Math.max(1, width - 9));
		return `${truncateToWidth(oneLine(item.text), Math.max(1, width - visibleWidth(suffix)))}${suffix}`;
	}
	return oneLine([item ? `${item.text}${detail ? ` · ${detail}` : ""}${active.length > 1 ? ` · +${active.length - 1} active items` : ""}` : "", ...taskActivity].filter(Boolean).join(" · ") || (task.status === "blocked" ? "Blocked" : "Awaiting checklist"));
}

/** The main-agent panel derives all activity from tasks, checklists and linked runs. */
export function renderSessionOverview(state: CoordinationSnapshot | undefined, runs: readonly SubagentSnapshot[], width: number, maxHeight = 5): string[] {
	width = Math.max(0, Math.floor(width));
	maxHeight = Math.max(0, Math.floor(maxHeight));
	if (!width || !maxHeight) return [];
	if (!state) return [header("Tasks · saved state unavailable", width)];
	const active = runs.filter(isActiveRun);
	const pending = state.results.filter(result => result.handling !== "incorporated");
	const review = pending.filter(result => result.handling !== "deferred").length;
	const deferred = pending.length - review;
	const updates = state.userUpdates.filter(update => update.status === "pending").length;
	const open = state.tasks.filter(task => task.status === "active" || task.status === "blocked");
	const tasks = state.tasks.filter(task => open.includes(task) || pending.some(result => result.taskId === task.id));
	if (!active.length && !tasks.length && !pending.length && !updates) return [header("Tasks · no active work", width)];
	const counts = [`${open.length} active`, active.length ? `${active.length} running` : "", review ? `${review} to review` : "", deferred ? `${deferred} deferred` : "", updates ? `${updates} pending update${updates === 1 ? "" : "s"}` : ""].filter(Boolean);
	const lines = [header(`Tasks · ${counts.join(" · ")}`, width)];
	const slots = maxHeight - 1;
	let count = Math.min(2, tasks.length, slots);
	if (tasks.length > count && count === slots) count = Math.max(0, count - 1);
	let details = slots - count - Number(tasks.length > count);
	for (const task of tasks.slice(0, count)) {
		lines.push(taskSummary(task, state, width));
		if (details-- > 0) lines.push(`  ${taskActivity(task, state, runs, Math.max(1, width - 2))}`);
	}
	if (tasks.length > count && slots) lines.push(`+${tasks.length - count} more task${tasks.length - count === 1 ? "" : "s"} · F9 checklist`);
	if (!tasks.length && slots) lines.push(pending.length ? `${pending.length} report${pending.length === 1 ? "" : "s"} in Inbox` : updates ? `${updates} user update${updates === 1 ? "" : "s"} awaiting reconciliation` : `${active.length} worker${active.length === 1 ? "" : "s"} running · F9 Runs`);
	return lines.slice(0, maxHeight).map(line => truncateToWidth(line, width));
}
