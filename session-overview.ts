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
	const items = task.items.filter(item => item.status !== "dropped");
	return items.length ? `${items.filter(item => item.status === "completed").length}/${items.length} done` : "No items";
}

/** Items show status only; reports live in the inbox. */
export function checklistMark(item: CoordinationItem): string {
	if (item.status === "completed") return "✓";
	if (item.status === "dropped") return "−";
	return item.status === "in_progress" ? "◐" : "○";
}

export function taskDisplayStatus(task: CoordinationTask): string {
	if (task.status !== "active") return ({ blocked: "Blocked", completed: "Completed", dropped: "Dropped" })[task.status];
	const started = task.items.some(item => item.status === "in_progress" || item.status === "completed");
	return started ? "In progress" : "Pending";
}

function header(label: string, width: number): string {
	const hint = width >= 60 ? "F9 tasks" : "F9";
	if (width < 12) return truncateToWidth(`Tasks · ${hint}`, width);
	const left = truncateToWidth(label, width - hint.length - 2);
	return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - hint.length))}${hint}`;
}

function taskSummary(task: CoordinationTask, width: number): string {
	const status = taskDisplayStatus(task);
	const mark = task.status === "completed" ? "✓" : task.status === "dropped" ? "−" : task.status === "blocked" ? "!" : status === "Pending" ? "○" : "◐";
	const suffix = ` · ${checklistProgress(task)}${width >= 55 ? ` · ${status}` : ""}`;
	return width >= 30 ? `${mark} ${truncateToWidth(oneLine(task.title), Math.max(1, width - visibleWidth(suffix) - 2))}${suffix}` : `${mark} ${oneLine(task.title)} · ${checklistProgress(task)}`;
}

function taskActivity(task: CoordinationTask, width: number): string {
	const unfinished = task.items.filter(item => item.status === "pending" || item.status === "in_progress");
	const item = unfinished.find(candidate => candidate.status === "in_progress") ?? unfinished[0];
	if (!item) return task.status === "blocked" ? "Blocked" : "No open items";
	if (width < 88) {
		const suffix = truncateToWidth(` · ${item.status === "in_progress" ? "in progress" : "pending"}`, Math.max(1, width - 9));
		return `${truncateToWidth(oneLine(item.text), Math.max(1, width - visibleWidth(suffix)))}${suffix}`;
	}
	return oneLine(`${item.text} · ${item.status === "in_progress" ? `${item.owner ?? task.owner} · in progress` : "pending"}`);
}

/** The main-agent panel shows tasks and their progress; reports live in the inbox. */
export function renderSessionOverview(state: CoordinationSnapshot | undefined, runs: readonly SubagentSnapshot[], width: number, maxHeight = 5): string[] {
	width = Math.max(0, Math.floor(width));
	maxHeight = Math.max(0, Math.floor(maxHeight));
	if (!width || !maxHeight) return [];
	if (!state) return [header("Tasks · saved state unavailable", width)];
	const active = runs.filter(isActiveRun);
	const open = state.tasks.filter(task => task.status === "active" || task.status === "blocked");
	if (!active.length && !open.length) return [header("Tasks · no active work", width)];
	const counts = [`${open.length} active`, active.length ? `${active.length} running` : ""].filter(Boolean);
	const lines = [header(`Tasks · ${counts.join(" · ")}`, width)];
	const slots = maxHeight - 1;
	let count = Math.min(2, open.length, slots);
	if (open.length > count && count === slots) count = Math.max(0, count - 1);
	let details = slots - count - Number(open.length > count);
	for (const task of open.slice(0, count)) {
		lines.push(taskSummary(task, width));
		if (details-- > 0) lines.push(`  ${taskActivity(task, Math.max(1, width - 2))}`);
	}
	if (open.length > count && slots) lines.push(`+${open.length - count} more task${open.length - count === 1 ? "" : "s"} · F9 tasks`);
	if (!open.length && slots) lines.push(`${active.length} worker${active.length === 1 ? "" : "s"} running · F9 Runs`);
	return lines.slice(0, maxHeight).map(line => truncateToWidth(line, width));
}
