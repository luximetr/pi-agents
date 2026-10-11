import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isActiveRun } from "./subagent-observer.ts";
import type { SubagentSnapshot } from "./subagents.ts";

export const MAIN_ENTRY = "main";

/** One-line task title: first non-empty line, markdown markers and control characters removed. */
export function taskTitle(task: string | undefined): string {
	const line = stripVTControlCharacters(task ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").split("\n").map(part => part.trim()).find(Boolean) ?? "";
	return line.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
}

/** `provider/model:level` → `model`; the bar only needs a recognizable short name. */
export function shortModel(model?: string): string {
	if (!model) return "";
	const bare = model.split(":")[0]!.split("/").pop()!;
	return bare.replace(/^claude-/, "");
}

function elapsed(run: SubagentSnapshot, now: number): string {
	const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Bar and chat entries are conversations: every run of one thread shares a key. */
export function threadKey(run: SubagentSnapshot): string { return run.threadId ?? run.id; }

/** All runs of one conversation, oldest first. */
export function threadRuns(runs: readonly SubagentSnapshot[], key: string): SubagentSnapshot[] {
	return runs.filter(run => threadKey(run) === key).sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * One entry per conversation: its latest run (state), starting at the conversation's first run.
 * Working conversations first (newest on top), then finished ones (most recently ended first).
 */
export function barRuns(runs: readonly SubagentSnapshot[]): SubagentSnapshot[] {
	const keys = [...new Set(runs.map(threadKey))];
	const entries = keys.map(key => {
		const all = threadRuns(runs, key);
		// A conversation keeps the title of its first task, even after replies.
		return { ...all[all.length - 1]!, startedAt: all[0]!.startedAt, task: all[0]!.task };
	});
	const active = entries.filter(isActiveRun).sort((a, b) => b.startedAt - a.startedAt);
	const done = entries.filter(run => !isActiveRun(run)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	return [...active, ...done];
}

/** Next entry key after `current`, cycling main → conversations → main. */
export function nextBarEntry(runs: readonly SubagentSnapshot[], current: string): string {
	const ids = [MAIN_ENTRY, ...barRuns(runs).map(threadKey)];
	return ids[(Math.max(0, ids.indexOf(current)) + 1) % ids.length]!;
}

/** Move the selection by `delta` within main + runs, clamped (no wrap). */
export function stepBarEntry(runs: readonly SubagentSnapshot[], current: string, delta: number): string {
	const ids = [MAIN_ENTRY, ...barRuns(runs).map(threadKey)];
	const index = Math.max(0, ids.indexOf(current));
	return ids[Math.max(0, Math.min(ids.length - 1, index + delta))]!;
}

export interface BarStyle { selected(text: string): string; dim(text: string): string; ok(text: string): string; fail(text: string): string; busy(text: string): string }

const plain: BarStyle = { selected: t => t, dim: t => t, ok: t => t, fail: t => t, busy: t => t };

/**
 * Vertical list, one row per agent, plus a hint row. Empty when nothing was delegated.
 *   ▸ ● main
 *     ◌ explorer · haiku-4-5 · 12s
 */
export function renderAgentBar(runs: readonly SubagentSnapshot[], selected: string, width: number, now = Date.now(), style: BarStyle = plain, focused = false, maxRows = 6, hintText?: string): string[] {
	width = Math.max(0, Math.floor(width));
	if (!width || !runs.length) return [];
	const rows: Array<{ id: string; text: string; color: (t: string) => string }> = [{ id: MAIN_ENTRY, text: "● main", color: style.dim }];
	for (const run of barRuns(runs)) {
		const stopped = !isActiveRun(run) && !!run.stopReason;
		const mark = stopped ? "■" : run.status === "failed" ? "✗" : run.status === "finished" ? "✓" : "◌";
		const model = shortModel(run.model);
		rows.push({
			id: threadKey(run),
			text: [`${mark} ${run.agent}`, model, stopped ? "stopped" : "", elapsed(run, now), taskTitle(run.task)].filter(Boolean).join(" · "),
			color: stopped ? style.dim : run.status === "failed" ? style.fail : run.status === "finished" ? style.ok : style.busy,
		});
	}
	// Keep the selected row visible when the list is longer than the budget.
	const selectedIndex = Math.max(0, rows.findIndex(row => row.id === selected));
	const budget = Math.max(2, maxRows);
	let start = 0;
	if (rows.length > budget) start = Math.min(rows.length - budget, Math.max(0, selectedIndex - budget + 1));
	const visible = rows.slice(start, start + budget);
	const lines = visible.map(row => {
		const on = row.id === selected;
		const text = `${on ? "▸" : " "} ${row.text}`;
		return truncateToWidth(on ? style.selected(text) : row.color(text), width);
	});
	const more = rows.length - visible.length;
	const hint = hintText ?? (focused ? "↑↓ move · enter open · x stop · d remove · esc back" : "↓ agents · F10 next");
	lines.push(truncateToWidth(style.dim(`  ${hint}${more > 0 ? ` · +${more} more` : ""}`), width));
	return lines;
}

/** Only direct subagents of this session's main agent belong in the bar; nested delegations stay in Agent Explorer. */
export function isTopLevelRun(run: Pick<SubagentSnapshot, "parentRunId">): boolean { return !run.parentRunId; }

/**
 * True only while the main prompt editor owns the keyboard: no overlay, and the
 * focused component is an editor (settings, selectors, Studio and extension
 * editors are not). Pi versions that cannot report focus count as focused.
 */
export function isMainEditorFocused(tui: { getFocusedComponent?(): unknown; hasOverlay?(): boolean } | undefined): boolean {
	if (typeof tui?.getFocusedComponent !== "function") return true;
	if (tui.hasOverlay?.()) return false;
	const focused = tui.getFocusedComponent() as { getText?: unknown; setText?: unknown } | null;
	return !!focused && typeof focused.getText === "function" && typeof focused.setText === "function";
}
