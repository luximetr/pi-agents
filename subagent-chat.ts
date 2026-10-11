import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MAIN_ENTRY, barRuns, renderAgentBar, shortModel, stepBarEntry, threadKey, threadRuns } from "./agent-bar.ts";
import { isActiveRun } from "./subagent-observer.ts";
import type { RunningSubagentHandle, SubagentSnapshot } from "./subagents.ts";
import type { TranscriptEntry } from "./subagent-transcript.ts";

export interface SubagentChatOptions {
	getHandles: () => RunningSubagentHandle[];
	/** Conversation (thread key) to show first. */
	initialId: string;
	/** Steers the conversation's running run or replies to its latest finished run. A reply continues the same conversation. */
	send: (latestRunId: string, text: string) => Promise<{ notice: string }>;
	/** Stops the conversation's active run (history stays). Returns a notice. */
	stop: (key: string) => string;
	/** Removes a stopped/finished conversation from the list. Returns a notice. */
	remove: (key: string) => string;
	/** Called whenever the viewed entry changes so the bar can mirror it. */
	onSelect?: (id: string) => void;
}

const safe = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function elapsed(run: SubagentSnapshot, now: number): string {
	const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Chat-style, full-screen view of one subagent. Tab / Shift+Tab move between `main` and the
 * subagents, like switching chats. Viewing never replaces the Pi session or owns execution.
 */
export function showSubagentChat(ctx: ExtensionContext, options: SubagentChatOptions): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedId = options.initialId;
		let notice = "";
		let expandTools = false;
		let top = 0;
		let follow = true;
		let maxTop = 0;
		let pageSize = 10;
		let disposed = false;
		let busy = false;
		/** Bar focus: ↑/↓ move through agents and switch the view live. */
		let barFocused = false;
		let barSelected = options.initialId;
		/** Pending destructive action awaiting y/n. */
		let confirm: { action: "stop" | "remove"; key: string } | undefined;
		const input = new Input();
		input.focused = true;
		const timer = setInterval(() => tui.requestRender(), 250);
		timer.unref();
		const close = () => { disposed = true; clearInterval(timer); done(undefined); };
		const snapshots = () => options.getHandles().map(handle => handle.snapshot());
		const select = (id: string) => {
			barSelected = id;
			if (id === MAIN_ENTRY) return;
			selectedId = id; notice = ""; top = 0; follow = true; input.setValue("");
			options.onSelect?.(id);
		};
		const markdown = new Map<string, { text: string; width: number; lines: string[] }>();
		const renderMarkdown = (id: string, text: string, width: number) => {
			const cached = markdown.get(id);
			if (cached && cached.text === text && cached.width === width) return cached.lines;
			const lines = new Markdown(safe(text).trim() || " ", 0, 0, getMarkdownTheme()).render(width);
			markdown.set(id, { text, width, lines });
			return lines;
		};

		return {
			invalidate() {},
			dispose() { disposed = true; clearInterval(timer); },
			render(width: number): string[] {
				const rows = Math.max(8, tui.terminal.rows ?? 24);
				const now = Date.now();
				const runs = options.getHandles().map(handle => handle.snapshot());
				const all = threadRuns(runs, selectedId);
				const latest = all[all.length - 1];
				const run = latest && { ...latest, startedAt: all[0]!.startedAt };
				const transcript: TranscriptEntry[] = all.flatMap(item => (item.transcript ?? []).map(entry => ({ ...entry, id: `${item.id}:${entry.id}` })));

				const status = notice || (follow ? (run && isActiveRun(run) ? "LIVE" : "END") : "scroll paused");
				const header = [truncateToWidth(run
					? `${theme.fg(run.status === "failed" ? "error" : isActiveRun(run) ? "warning" : "success", run.status === "failed" ? "✗" : isActiveRun(run) ? "◌" : "✓")} ${theme.bold(theme.fg("accent", safe(run.agent)))} ${notice ? theme.fg("warning", `· ${notice}`) : `${theme.fg("muted", `· ${shortModel(run.model) || "default model"} · ${elapsed(run, now)} · ${isActiveRun(run) ? safe(run.phase || "running") : run.status}${run.currentTool ? ` · ${safe(run.currentTool)}` : ""}`)} ${theme.fg("dim", `· ${status}`)}`}`
					: theme.fg("warning", "This run is no longer available."), width), theme.fg("border", "─".repeat(width))];

				const body: string[] = [];
				if (all.some(item => item.transcriptTruncated)) body.push(theme.fg("warning", "[Older history omitted by retention limit]"), "");
				for (const entry of transcript) {
					if (entry.kind === "user") {
						body.push(...wrapTextWithAnsi(theme.fg("accent", `> ${safe(entry.text).trim()}`), width), "");
					} else if (entry.kind === "assistant") {
						body.push(...renderMarkdown(entry.id, entry.text, Math.max(10, width - 2)).map(line => `  ${line}`), "");
					} else if (entry.kind === "tool") {
						const mark = entry.status === "running" ? theme.fg("warning", "◌") : entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const args = safe(entry.text).replace(/\s+/g, " ").trim();
						body.push(truncateToWidth(`${mark} ${theme.fg("toolTitle", safe(entry.title ?? "tool"))} ${theme.fg("dim", args)}`, width));
						if (expandTools && entry.output) body.push(...wrapTextWithAnsi(theme.fg("toolOutput", safe(entry.output)), width - 4).map(line => `    ${line}`));
					} else body.push(theme.fg("dim", safe(entry.text)));
				}
				if (run && !transcript.length) body.push(theme.fg("dim", safe(run.partialText || run.recentEvents.join("\n") || "Waiting for activity…")));

				const bar = renderAgentBar(runs, barSelected, width, now, {
					selected: t => theme.bold(theme.fg("accent", t)), dim: t => theme.fg("dim", t), ok: t => theme.fg("success", t),
					fail: t => theme.fg("error", t), busy: t => theme.fg("warning", t),
				}, barFocused, 5, confirm ? `${confirm.action === "stop" ? "Stop" : "Remove"} ${safe(runs.find(item => threadRuns([item], confirm!.key).length)?.agent ?? "agent")}? y confirm · n/esc cancel` : barFocused ? "↑↓ choose · enter switch (main: leave) · x stop · d remove · esc cancel" : "↓ agents · ⇥ next · ↑↓/PgUp/PgDn scroll · ⌃O tools · esc main");
				pageSize = Math.max(1, rows - header.length - 2 - bar.length);
				maxTop = Math.max(0, body.length - pageSize);
				top = follow ? maxTop : Math.min(top, maxTop);
				const view = body.slice(top, top + pageSize);
				while (view.length < pageSize) view.push("");

				const prompt = run && isActiveRun(run) ? "steer" : "reply";
				const inputLine = `${theme.fg(barFocused ? "dim" : "accent", `${prompt} ›`)} ${input.render(Math.max(1, width - prompt.length - 3))[0] ?? ""}`;
				return [...header, ...view, theme.fg("border", "─".repeat(width)), inputLine, ...bar].map(line => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (disposed) return;
				if (isKeyRelease(data)) return;
				const runs = snapshots();
				if (confirm) {
					const pending = confirm;
					confirm = undefined;
					if (data.toLowerCase() === "y") {
						notice = pending.action === "stop" ? options.stop(pending.key) : options.remove(pending.key);
						if (pending.action === "remove") {
							const rest = barRuns(snapshots());
							if (!rest.length) { close(); return; }
							if (!rest.some(item => threadKey(item) === selectedId)) select(threadKey(rest[0]!));
							barSelected = selectedId;
						}
					}
					tui.requestRender();
					return;
				}
				const ask = (action: "stop" | "remove", key: string) => {
					const all = threadRuns(runs, key);
					const latestRun = all[all.length - 1];
					if (!latestRun) return;
					if (action === "stop" && !isActiveRun(latestRun)) { notice = "Already finished — nothing to stop."; return; }
					if (action === "remove" && isActiveRun(latestRun)) { notice = "Stop the agent before removing it."; return; }
					confirm = { action, key };
				};
				if (barFocused) {
					if (data === "x" || data === "d") { if (barSelected !== MAIN_ENTRY) ask(data === "x" ? "stop" : "remove", barSelected); tui.requestRender(); return; }
					// Arrows only move the highlight; Enter confirms the switch.
					if (matchesKey(data, Key.down)) barSelected = stepBarEntry(runs, barSelected, 1);
					else if (matchesKey(data, Key.up)) barSelected = stepBarEntry(runs, barSelected, -1);
					else if (matchesKey(data, Key.enter)) {
						if (barSelected === MAIN_ENTRY) { close(); return; }
						barFocused = false;
						if (barSelected !== selectedId) select(barSelected);
					}
					else if (matchesKey(data, Key.escape)) { barFocused = false; barSelected = selectedId; }
					else { barFocused = false; barSelected = selectedId; }
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) { close(); return; }
				if (matchesKey(data, Key.ctrl("x"))) { ask("stop", selectedId); tui.requestRender(); return; }
				const go = (delta: number) => {
					const next = stepBarEntry(runs, selectedId, delta);
					if (next === selectedId || next === MAIN_ENTRY) { close(); return; }
					select(next);
				};
				if (matchesKey(data, "f10") || matchesKey(data, Key.tab)) go(1);
				else if (matchesKey(data, Key.shift("tab"))) go(-1);
				else if (matchesKey(data, Key.ctrl("o"))) expandTools = !expandTools;
				else if (matchesKey(data, Key.pageUp)) { follow = false; top = Math.max(0, top - pageSize); }
				else if (matchesKey(data, Key.pageDown)) { top = Math.min(maxTop, top + pageSize); follow = top >= maxTop; }
				else if (matchesKey(data, Key.up)) { follow = false; top = Math.max(0, top - 1); }
				else if (matchesKey(data, Key.down)) {
					if (follow && input.getValue().length === 0) { barFocused = true; barSelected = selectedId; }
					else { top = Math.min(maxTop, top + 1); follow = top >= maxTop; }
				}
				else if (matchesKey(data, Key.enter)) {
					const text = input.getValue().trim();
					if (text && !busy) {
						busy = true;
						input.setValue("");
						const latestRun = threadRuns(snapshots(), selectedId).at(-1);
						if (!latestRun) { notice = "This conversation is no longer available."; busy = false; return; }
						options.send(latestRun.id, text).then(result => {
							notice = result.notice;
						}, error => { notice = error instanceof Error ? error.message : String(error); }).finally(() => { busy = false; tui.requestRender(); });
					}
				} else input.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } });
}
