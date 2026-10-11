import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MAIN_ENTRY, barRuns, shortModel } from "./agent-bar.ts";
import { isActiveRun } from "./subagent-observer.ts";
import type { RunningSubagentHandle, SubagentSnapshot } from "./subagents.ts";

export interface SubagentChatOptions {
	getHandles: () => RunningSubagentHandle[];
	/** Run to show first. */
	initialId: string;
	/** Steers a running child or replies to a finished one. May return a run to follow (e.g. a reply's new run). */
	send: (runId: string, text: string) => Promise<{ notice: string; selectId?: string }>;
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
		const input = new Input();
		input.focused = true;
		const timer = setInterval(() => tui.requestRender(), 250);
		timer.unref();
		const close = () => { disposed = true; clearInterval(timer); done(undefined); };
		const ids = () => [MAIN_ENTRY, ...barRuns(options.getHandles().map(handle => handle.snapshot())).map(run => run.id)];
		const select = (id: string) => {
			if (id === MAIN_ENTRY) { close(); return; }
			selectedId = id; notice = ""; top = 0; follow = true; input.setValue("");
			options.onSelect?.(id);
		};
		const cycle = (delta: number) => {
			const list = ids();
			select(list[(Math.max(0, list.indexOf(selectedId)) + delta + list.length) % list.length]!);
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
				const run = runs.find(candidate => candidate.id === selectedId);

				// Tab strip: main + every subagent, current one highlighted.
				const strip = [MAIN_ENTRY, ...barRuns(runs).map(candidate => candidate.id)].map(id => {
					const candidate = runs.find(item => item.id === id);
					const label = candidate ? `${candidate.status === "failed" ? "✗" : isActiveRun(candidate) ? "◌" : "✓"} ${candidate.agent}` : "● main";
					return id === selectedId ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("dim", ` ${label} `);
				}).join(" ");
				const header = [truncateToWidth(strip, width)];
				if (run) header.push(truncateToWidth(theme.fg("muted", `${shortModel(run.model) || "default model"} · ${elapsed(run, now)} · ${isActiveRun(run) ? safe(run.phase || "running") : run.status}${run.currentTool ? ` · ${safe(run.currentTool)}` : ""}`), width));
				else header.push(theme.fg("warning", "This run is no longer available."));
				header.push(theme.fg("border", "─".repeat(width)));

				const body: string[] = [];
				if (run?.transcriptTruncated) body.push(theme.fg("warning", "[Older history omitted by retention limit]"), "");
				for (const entry of run?.transcript ?? []) {
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
				if (run && !run.transcript?.length) body.push(theme.fg("dim", safe(run.partialText || run.recentEvents.join("\n") || "Waiting for activity…")));

				const footerRows = 3;
				pageSize = Math.max(1, rows - header.length - footerRows);
				maxTop = Math.max(0, body.length - pageSize);
				top = follow ? maxTop : Math.min(top, maxTop);
				const view = body.slice(top, top + pageSize);
				while (view.length < pageSize) view.push("");

				const prompt = run && isActiveRun(run) ? "steer" : "reply";
				const inputLine = `${theme.fg("accent", `${prompt} ›`)} ${input.render(Math.max(1, width - prompt.length - 3))[0] ?? ""}`;
				const status = notice || `${follow ? (run && isActiveRun(run) ? "LIVE" : "END") : "scroll paused"} · ${expandTools ? "tools expanded" : "tools compact"}`;
				const keys = width < 80 ? "Tab next · Esc main" : "Tab/⇧Tab switch · ↑↓/PgUp/PgDn scroll · ⌃O tools · Esc back to main";
				return [...header, ...view, theme.fg("border", "─".repeat(width)), inputLine, theme.fg("dim", `${status} · ${keys}`)].map(line => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (disposed || isKeyRelease(data)) return;
				if (matchesKey(data, Key.escape)) { close(); return; }
				if (matchesKey(data, "f10") || matchesKey(data, Key.tab)) cycle(1);
				else if (matchesKey(data, Key.shift("tab"))) cycle(-1);
				else if (matchesKey(data, Key.ctrl("o"))) expandTools = !expandTools;
				else if (matchesKey(data, Key.pageUp)) { follow = false; top = Math.max(0, top - pageSize); }
				else if (matchesKey(data, Key.pageDown)) { top = Math.min(maxTop, top + pageSize); follow = top >= maxTop; }
				else if (matchesKey(data, Key.up)) { follow = false; top = Math.max(0, top - 1); }
				else if (matchesKey(data, Key.down)) { top = Math.min(maxTop, top + 1); follow = top >= maxTop; }
				else if (matchesKey(data, Key.enter)) {
					const text = input.getValue().trim();
					if (text && !busy) {
						busy = true;
						input.setValue("");
						options.send(selectedId, text).then(result => {
							notice = result.notice;
							if (result.selectId) select(result.selectId);
						}, error => { notice = error instanceof Error ? error.message : String(error); }).finally(() => { busy = false; tui.requestRender(); });
					}
				} else input.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } });
}
