import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isActiveRun } from "./subagent-observer.ts";
import type { RunningSubagentHandle, SubagentSnapshot } from "./subagents.ts";

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
function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function model(run: SubagentSnapshot): string {
	const actual = run.usage?.model ? [run.usage.provider, run.usage.model].filter(Boolean).join("/") : undefined;
	return actual && run.model && actual !== run.model ? `${actual} (configured: ${run.model})` : run.model ?? actual ?? "default model";
}

/** A full-terminal overlay: viewing never replaces a session or owns its execution. */
export function showSubagentInspector(
	ctx: ExtensionContext,
	getHandles: () => RunningSubagentHandle[],
	staleWarningMinutes: number,
	rootLabel = "Main session",
): Promise<void> {
	if (ctx.mode && ctx.mode !== "tui") {
		ctx.ui.notify("Agent Explorer requires Pi's terminal UI.", "info");
		return Promise.resolve();
	}
	const initial = getHandles();
	if (!initial.length) {
		ctx.ui.notify("No delegated runs in this session yet.", "info");
		return Promise.resolve();
	}
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedId = (initial.find(handle => isActiveRun(handle.snapshot())) ?? initial[0]).id;
		let full = false;
		let detailFocus = false;
		let expandTools = false;
		let mode: "normal" | "steer" | "stop" = "normal";
		let notice = "";
		let target: RunningSubagentHandle | undefined;
		let bodyHeight = 20;
		let transcriptHeight = 12;
		let maxScroll = 0;
		const history: string[] = [];
		const collapsed = new Set<string>();
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
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value && mode === "steer"; },
			dispose,
			invalidate() { input.invalidate(); },
			render(width: number): string[] {
				const height = Math.max(1, tui.terminal?.rows ?? 28);
				if (height < 7) return ["Agent Explorer · terminal too short", "Resize to 7+ rows · Esc/F9 close"].slice(0, height).map(line => truncateToWidth(line, width));
				bodyHeight = Math.max(1, height - 4);
				const runs = snapshots();
				const selected = runs.find(run => run.id === selectedId);
				if (!selected) return ["Agent Explorer · No runs available", "Esc close"];
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
				const header = [theme.fg("accent", theme.bold(`Agent Explorer · ${active} active · ${runs.length - active} completed/failed`)),
					theme.fg("muted", breadcrumb)];
				const treeLines = rows.map(({ run, depth, hasChildren }) => {
					const marker = run.id === selectedId ? "›" : " ";
					const branch = hasChildren ? collapsed.has(run.id) ? "▸" : "▾" : "·";
					const name = `${safe(run.agent)} #${run.id.slice(0, 6)}`;
					return `${marker}${"  ".repeat(depth)}${branch} ${badge(run)} ${theme.fg(run.id === selectedId ? "accent" : "text", name)} · ${safe(phase(run, runs))}`;
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
				const detailHeader = [
					`${badge(selected)} ${safe(phase(selected, runs))} · ${elapsedTime}${deadline}`,
					`Model: ${safe(model(selected))}`,
					`Task: ${safe(selected.task).replace(/\n/g, " ")}`,
					selected.currentTool ? `Tool: ${safe(selected.currentTool)}` : `Status: ${selected.status}`,
					stale ? theme.fg("warning", `No agent activity for ${elapsed(now - selected.lastActivityAt)} — possibly stalled`)
						: usage ? `Own usage: ↑${usage.input} ↓${usage.output} R${usage.cacheRead} W${usage.cacheWrite} · $${usage.cost.toFixed(3)}` : "Usage: pending",
				];
				const lines: string[] = [];
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
				const keys = width < 80 ? "s steer · x stop · e tools · F9 close" : "PgUp/PgDn scroll · Home start · End follow · e tools · s steer · x stop subtree · F9 close";
				return [...header, ...body, theme.fg("muted", footer), theme.fg("dim", mode === "steer" ? "Enter queue steering · Esc cancel" : mode === "stop" ? "y confirm subtree stop · n/Esc cancel" : keys)].map(line => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (disposed) return;
				if (matchesKey(data, "f9")) { close(); return; }
				if (mode === "stop") {
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
					else if (matchesKey(data, Key.pageUp)) scrollBy(-transcriptHeight);
					else if (matchesKey(data, Key.pageDown)) scrollBy(transcriptHeight);
					else if (matchesKey(data, Key.home)) { position().top = 0; position().follow = false; }
					else if (matchesKey(data, Key.end)) position().follow = true;
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
