import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isActiveRun } from "./subagent-observer.ts";
import type { SubagentSnapshot } from "./subagents.ts";

export const MAIN_ENTRY = "main";

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

/** Running runs first (oldest first), then finished ones (newest first). */
export function barRuns(runs: readonly SubagentSnapshot[]): SubagentSnapshot[] {
	const active = runs.filter(isActiveRun).sort((a, b) => a.startedAt - b.startedAt);
	const done = runs.filter(run => !isActiveRun(run)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	return [...active, ...done];
}

/** Next entry id after `current`, cycling main → runs → main. */
export function nextBarEntry(runs: readonly SubagentSnapshot[], current: string): string {
	const ids = [MAIN_ENTRY, ...barRuns(runs).map(run => run.id)];
	return ids[(Math.max(0, ids.indexOf(current)) + 1) % ids.length]!;
}

/** Move the selection by `delta` within main + runs, clamped (no wrap). */
export function stepBarEntry(runs: readonly SubagentSnapshot[], current: string, delta: number): string {
	const ids = [MAIN_ENTRY, ...barRuns(runs).map(run => run.id)];
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
		const mark = run.status === "failed" ? "✗" : run.status === "finished" ? "✓" : "◌";
		const model = shortModel(run.model);
		rows.push({
			id: run.id,
			text: [`${mark} ${run.agent}`, model, elapsed(run, now)].filter(Boolean).join(" · "),
			color: run.status === "failed" ? style.fail : run.status === "finished" ? style.ok : style.busy,
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
	const hint = hintText ?? (focused ? "↑↓ move · enter open · esc back" : "↓ agents · F10 next");
	lines.push(truncateToWidth(style.dim(`  ${hint}${more > 0 ? ` · +${more} more` : ""}`), width));
	return lines;
}
