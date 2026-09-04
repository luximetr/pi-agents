import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Markdown, SelectList, Spacer, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import type { DiscoveredAgent } from "./agents.ts";
import type { RunningSubagentHandle, SubagentSnapshot } from "./subagents.ts";

/**
 * Auto-assigned colors for agents without an explicit `color` (stable per
 * name). Mid-tone hues that stay readable on light and dark themes.
 */
const AGENT_COLOR_PALETTE = [
	"#4cc2ff", "#ff9f0a", "#30d158", "#ff375f", "#bf5af2", "#ffd60a",
	"#64d2ff", "#ff453a", "#32d74b", "#5e5ce6", "#00c7be", "#ff6482",
] as const;

/** djb2 hash so each agent name maps to a stable palette slot. */
function hashName(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

function hexToRgb(hex: string): [number, number, number] {
	const value = parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Map a hex color to the closest ANSI 256-color index (cube + grayscale ramp). */
function hexToAnsi256(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	if (r === g && g === b) {
		if (r < 8) return 16;
		return 232 + Math.min(23, Math.max(0, Math.round((r - 8) / 10)));
	}
	const ri = Math.round((r / 255) * 5);
	const gi = Math.round((g / 255) * 5);
	const bi = Math.round((b / 255) * 5);
	return 16 + 36 * ri + 6 * gi + bi;
}

/**
 * Colorize text with the agent's color: explicit `color` (theme role or hex)
 * or a stable auto-assigned palette color. Resets the foreground after, like
 * theme.fg does.
 */
export function colorize(theme: Theme, agent: DiscoveredAgent, text: string): string {
	const value = agent.color ?? AGENT_COLOR_PALETTE[hashName(agent.name) % AGENT_COLOR_PALETTE.length];
	if (value.startsWith("#")) {
		if (theme.getColorMode() === "truecolor") {
			const [r, g, b] = hexToRgb(value);
			return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
		}
		return `\x1b[38;5;${hexToAnsi256(value)}m${text}\x1b[39m`;
	}
	return theme.fg(value as ThemeColor, text);
}

/** Concise capability summary for the picker. Avoid dumping long tool lists. */
export function agentLabel(agent: DiscoveredAgent): string {
	const parts: string[] = [];
	if (agent.tools === undefined) parts.push("current tools");
	else if (agent.tools.length === 0) parts.push("no built-ins");
	else parts.push(`${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}`);
	const customCount = Object.keys(agent.customTools ?? {}).length;
	if (customCount > 0) parts.push(`${customCount} custom`);
	if (agent.mcp?.length) parts.push(`MCP: ${agent.mcp.join(", ")}`);
	if (agent.subagents?.length) parts.push(`delegates: ${agent.subagents.map((child) => child.name).join(", ")}`);
	if (agent.deniedPaths?.length) parts.push(`${agent.deniedPaths.length} path rule${agent.deniedPaths.length === 1 ? "" : "s"}`);
	parts.push(agent.source);
	return parts.join(" · ");
}

/** Footer status line showing the active agent and optional session subagent stats. */
export function updateStatus(ctx: ExtensionContext, agent: DiscoveredAgent | undefined, subagentStats?: string) {
	const agentStatus = agent
		? colorize(ctx.ui.theme, agent, `agent:${agent.name}`)
		: ctx.ui.theme.fg("muted", "agent:none · default pi");
	const statsStatus = subagentStats ? ctx.ui.theme.fg("muted", ` · ${subagentStats}`) : "";
	ctx.ui.setStatus("pi-agents", `${agentStatus}${statsStatus}`);
}

export interface DelegateViewDetails {
	agent?: string;
	task?: string;
	status?: "running" | "completed" | "interrupted" | "timed_out" | "failed";
	statsLine?: string;
	progress?: boolean;
	phase?: string;
	branch?: string;
	worktreePath?: string;
	useWorktree?: boolean;
	outputTruncated?: boolean;
	fullOutputPath?: string;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function compactLines(text: string, limit: number, fromEnd = false): { text: string; omitted: number } {
	const lines = text.trim().split("\n");
	if (lines.length <= limit) return { text: lines.join("\n"), omitted: 0 };
	return { text: (fromEnd ? lines.slice(-limit) : lines.slice(0, limit)).join("\n"), omitted: lines.length - limit };
}

function expandHint(): string {
	try { return keyHint("app.tools.expand", "expand"); }
	catch { return "Ctrl+O to expand"; }
}

/** Compact, scannable header for a delegation tool call. */
export function renderDelegateCall(args: { agent?: unknown; task?: unknown; useWorktree?: unknown }, theme: Theme): Text {
	const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : "…";
	const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : "Waiting for task";
	const mode = args.useWorktree === true ? "isolated worktree" : "current checkout";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", "→")} ${theme.fg("accent", agent)}`
		+ ` ${theme.fg("dim", `· ${mode}`)}`
		+ `\n${theme.fg("dim", task)}`,
		0,
		0,
	);
}

/** Purpose-built delegate result renderer: terse by default, detailed on expand. */
export function renderDelegateResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
): Container | Text {
	const details = (result.details ?? {}) as DelegateViewDetails;
	const raw = resultText(result);
	const agent = details.agent ?? "subagent";
	const status = options.isPartial || details.status === "running" ? "running" : details.status ?? "completed";
	const icon = status === "running"
		? theme.fg("warning", "◌")
		: status === "completed"
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");
	const statusColor = status === "completed" ? "success" : status === "running" ? "warning" : "error";
	const container = new Container();
	container.addChild(new Text(
		`${icon} ${theme.fg("toolTitle", theme.bold(agent))} ${theme.fg(statusColor, status.replace("_", " "))}`
		+ (details.phase && status === "running" ? theme.fg("muted", ` · ${details.phase}`) : ""),
		0,
		0,
	));

	let body = raw;
	if (status === "completed") {
		const prefix = `Result from ${agent}:\n\n`;
		if (body.startsWith(prefix)) body = body.slice(prefix.length);
		if (details.branch && details.worktreePath) {
			const suffix = `\n\nBranch: ${details.branch}\nWorktree: ${details.worktreePath}`;
			if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
		}
	} else if (details.worktreePath) {
		body = body.replace(`\nWorktree preserved at: ${details.worktreePath}`, "");
	}
	if (details.outputTruncated) {
		const noticeStart = body.lastIndexOf("\n\n[Output truncated:");
		if (noticeStart >= 0) body = body.slice(0, noticeStart);
	}

	if (body.trim()) {
		container.addChild(new Spacer(1));
		if (options.expanded && status !== "running") {
			container.addChild(new Markdown(body.trim(), 0, 0, getMarkdownTheme()));
		} else {
			const clipped = compactLines(body, status === "running" ? 10 : 6, status === "running");
			container.addChild(new Text(theme.fg("toolOutput", clipped.text), 0, 0));
			if (clipped.omitted > 0) {
				container.addChild(new Text(theme.fg("muted", `… ${clipped.omitted} more lines · ${expandHint()}`), 0, 0));
			}
		}
	}
	if (details.statsLine) container.addChild(new Text(theme.fg("dim", details.statsLine), 0, 0));
	if (details.fullOutputPath) {
		container.addChild(new Text(
			theme.fg("warning", "Output truncated · full result: ") + theme.fg("accent", details.fullOutputPath),
			0,
			0,
		));
	}
	if (details.worktreePath) {
		container.addChild(new Text(
			theme.fg("muted", status === "completed" ? "Worktree retained: " : "Worktree preserved: ")
			+ theme.fg("accent", details.worktreePath),
			0,
			0,
		));
		if (details.branch) container.addChild(new Text(theme.fg("dim", `Branch: ${details.branch}`), 0, 0));
	}
	return container;
}

function elapsedLabel(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

function snapshotUsage(snapshot: SubagentSnapshot): string {
	const usage = snapshot.usage;
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${usage.input.toLocaleString()}`);
	if (usage.output) parts.push(`↓${usage.output.toLocaleString()}`);
	if (usage.cacheRead) parts.push(`R${usage.cacheRead.toLocaleString()}`);
	if (usage.cacheWrite) parts.push(`W${usage.cacheWrite.toLocaleString()}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	if (usage.model) parts.push([usage.provider, usage.model].filter(Boolean).join("/"));
	return parts.join(" · ");
}

/** Live, controllable view over running delegated RPC children. */
export function showSubagentInspector(
	ctx: ExtensionContext,
	getHandles: () => RunningSubagentHandle[],
	staleWarningMinutes: number,
): Promise<void> {
	const initial = getHandles();
	if (initial.length === 0) {
		ctx.ui.notify("No subagents are running. Retained worktrees: /subagents worktrees", "info");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedId = initial[0].id;
		let lastHandle = initial[0];
		let mode: "normal" | "confirm-stop" | "steer" = "normal";
		const steerInput = new Input();
		const timer = setInterval(() => tui.requestRender(), 1000);
		timer.unref?.();

		const selected = (): RunningSubagentHandle => {
			const handles = getHandles();
			const match = handles.find((handle) => handle.id === selectedId) ?? handles[0];
			if (match) {
				selectedId = match.id;
				lastHandle = match;
			}
			return lastHandle;
		};
		const argsText = (snapshot: SubagentSnapshot) => {
			if (snapshot.currentToolArgs === undefined) return "";
			try {
				const text = JSON.stringify(snapshot.currentToolArgs);
				return text.length > 240 ? `${text.slice(0, 237)}…` : text;
			} catch { return "[unavailable]"; }
		};
		const icon = (status: SubagentSnapshot["status"]) => status === "running"
			? theme.fg("warning", "◌")
			: status === "stopping"
				? theme.fg("warning", "■")
				: status === "finished"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");

		return {
			get focused() { return steerInput.focused; },
			set focused(value: boolean) { steerInput.focused = value; },
			render(width: number) {
				const handle = selected();
				const snapshot = handle.snapshot();
				const handles = getHandles();
				const now = Date.now();
				const idleMs = now - snapshot.lastActivityAt;
				const stale = snapshot.status === "running" && staleWarningMinutes > 0 && idleMs >= staleWarningMinutes * 60_000;
				const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
				const lines: string[] = [border, theme.fg("accent", theme.bold(`Subagents · ${handles.length} running`))];

				if (handles.length === 0) {
					lines.push("", theme.fg("success", "All subagents have finished."), theme.fg("muted", `Last: ${snapshot.agent} · ${snapshot.phase}`), "", theme.fg("dim", "esc close"), border);
					return lines.map((line) => truncateToWidth(line, width));
				}

				for (const item of handles) {
					const itemSnapshot = item.snapshot();
					const marker = item.id === snapshot.id ? theme.fg("accent", "›") : " ";
					const activity = itemSnapshot.currentTool ? ` · ${itemSnapshot.currentTool}` : ` · ${itemSnapshot.phase}`;
					lines.push(`${marker} ${icon(itemSnapshot.status)} ${theme.fg("accent", itemSnapshot.agent)}${theme.fg("dim", ` · ${elapsedLabel(now - itemSnapshot.startedAt)}${activity}`)}`);
				}

				const remaining = snapshot.deadlineAt === undefined
					? "no deadline"
					: snapshot.deadlineAt <= now ? "deadline reached" : `${elapsedLabel(snapshot.deadlineAt - now)} left`;
				lines.push(
					"",
					`${icon(snapshot.status)} ${theme.fg("accent", theme.bold(snapshot.agent))} ${theme.fg("muted", `· ${snapshot.id}`)}`,
					`${theme.fg("muted", "Status")}  ${snapshot.status} · ${snapshot.phase} · ${elapsedLabel(now - snapshot.startedAt)} · ${remaining}`,
					stale
						? theme.fg("warning", `No RPC activity for ${elapsedLabel(idleMs)} — the child may be stalled`)
						: theme.fg("dim", `Activity ${elapsedLabel(idleMs)} ago${snapshotUsage(snapshot) ? ` · ${snapshotUsage(snapshot)}` : ""}`),
				);
				if (snapshot.currentTool) lines.push(`${theme.fg("muted", "Tool:")} ${theme.fg("toolTitle", snapshot.currentTool)}${argsText(snapshot) ? ` ${theme.fg("dim", argsText(snapshot))}` : ""}`);
				lines.push(theme.fg("muted", "Task"));
				lines.push(...wrapTextWithAnsi(snapshot.task, Math.max(1, width - 2)).map((line) => `  ${line}`));

				if (snapshot.recentEvents.length > 0) {
					lines.push("", theme.fg("muted", "Recent activity"));
					for (const event of snapshot.recentEvents.slice(-8)) lines.push(...wrapTextWithAnsi(event, Math.max(1, width - 2)).map((line) => `  ${line}`));
				}
				if (snapshot.partialText.trim()) {
					lines.push("", theme.fg("muted", "Latest response"));
					for (const line of wrapTextWithAnsi(snapshot.partialText.trim().split("\n").slice(-4).join("\n"), Math.max(1, width - 2))) lines.push(`  ${line}`);
				}
				lines.push("");
				if (mode === "confirm-stop") lines.push(theme.fg("warning", `Stop ${snapshot.agent}? y confirm · n/esc cancel`));
				else if (mode === "steer") {
					steerInput.focused = true;
					const [inputLine = ""] = steerInput.render(Math.max(1, width - 9));
					lines.push(`${theme.fg("accent", "Steer › ")}${inputLine}`, theme.fg("dim", "enter send · esc cancel"));
				} else lines.push(theme.fg("dim", `${handles.length > 1 ? "↑↓/jk select · " : ""}s steer · x stop · esc close`));
				lines.push(border);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() { steerInput.invalidate(); },
			dispose() { clearInterval(timer); },
			handleInput(data: string) {
				if (mode === "confirm-stop") {
					if (data.toLowerCase() === "y") {
						selected().stop("user");
						done(undefined);
					} else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) mode = "normal";
					tui.requestRender();
					return;
				}
				if (mode === "steer") {
					if (matchesKey(data, Key.escape)) {
						mode = "normal";
						steerInput.setValue("");
					} else if (matchesKey(data, Key.enter)) {
						if (selected().steer(steerInput.getValue())) {
							mode = "normal";
							steerInput.setValue("");
						}
					} else steerInput.handleInput(data);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) done(undefined);
				else if (data.toLowerCase() === "x") mode = "confirm-stop";
				else if (data.toLowerCase() === "s") mode = "steer";
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data.toLowerCase() === "k" || data.toLowerCase() === "j") {
					const handles = getHandles();
					const index = Math.max(0, handles.findIndex((item) => item.id === selectedId));
					const offset = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
					if (handles.length > 0) selectedId = handles[(index + offset + handles.length) % handles.length].id;
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "85%", minWidth: 54, maxHeight: "85%", anchor: "center", margin: 1 } });
}

/** One row of the retained-worktree manager (pre-formatted for display). */
export interface WorktreeViewItem {
	branch: string;
	/** Checkout path, when it still exists. */
	path?: string;
	agent: string;
	ageLabel: string;
	/** undefined = unknowable (directory missing). */
	dirty: boolean | undefined;
	/** Branch holds commits not merged into the main checkout's HEAD. */
	unmerged: boolean;
	/** Manifest record whose directory is gone. */
	stale: boolean;
	status?: string;
}

export interface WorktreeManagerActions {
	/** Delete one worktree; returns a human-readable outcome message. */
	remove: (item: WorktreeViewItem) => Promise<string> | string;
	/** Prune everything eligible under the retention policy; returns an outcome message. */
	prune: () => Promise<string> | string;
}

/** Browse and garbage-collect retained subagent worktrees (`/subagents worktrees`). */
export function showWorktreeManager(
	ctx: ExtensionContext,
	load: () => { baseDir: string; items: WorktreeViewItem[] },
	actions: WorktreeManagerActions,
): Promise<void> {
	if (load().items.length === 0) {
		ctx.ui.notify("No retained subagent worktrees.", "info");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const first = load().items[0];
		let selectedBranch = first.branch;
		let mode: "normal" | "confirm-delete" | "confirm-prune" | "busy" = "normal";
		let message = "";
		const timer = setInterval(() => tui.requestRender(), 1000);
		timer.unref?.();

		const run = async (action: () => Promise<string> | string) => {
			mode = "busy";
			tui.requestRender();
			try {
				message = await action();
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			const remaining = load().items;
			if (remaining.length === 0) {
				clearInterval(timer);
				done(undefined);
				return;
			}
			if (!remaining.some((item) => item.branch === selectedBranch)) selectedBranch = remaining[0].branch;
			mode = "normal";
			tui.requestRender();
		};

		return {
			get focused() { return false; },
			set focused(_value: boolean) {},
			render(width: number) {
				const snapshot = load();
				const items = snapshot.items;
				const selected = items.find((item) => item.branch === selectedBranch) ?? items[0];
				const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
				const lines: string[] = [
					border,
					theme.fg("accent", theme.bold(`Retained Subagent Worktrees (${items.length})`)),
					theme.fg("dim", snapshot.baseDir),
					"",
				];
				for (const item of items) {
					const marker = item.stale ? "!" : item.dirty ? "●" : "○";
					const coloredMarker = item.stale || item.dirty ? theme.fg("warning", marker) : theme.fg("muted", marker);
					const meta = [item.agent, item.ageLabel, item.status, item.unmerged ? "unmerged" : undefined, item.dirty === true ? "dirty" : undefined, item.stale ? "missing dir" : undefined]
						.filter(Boolean).join(" · ");
					const prefix = selected && item.branch === selected.branch ? theme.fg("accent", "› ") : "  ";
					lines.push(`${prefix}${coloredMarker} ${item.branch}  ${theme.fg("dim", meta)}`);
				}
				if (selected) {
					const safety = selected.dirty
						? theme.fg("warning", "Protected: uncommitted changes (cannot delete)")
						: selected.unmerged
							? theme.fg("warning", "Checkout can be removed; unmerged branch will be kept")
							: theme.fg("muted", "Safe to remove checkout and merged branch");
					lines.push("", theme.fg("muted", "Selected"), `  ${theme.fg("accent", selected.branch)}`);
					if (selected.path) lines.push(`  ${theme.fg("dim", selected.path)}`);
					lines.push(`  ${safety}`);
				}
				lines.push("");
				if (message) lines.push(theme.fg("muted", message), "");
				switch (mode) {
					case "confirm-delete": lines.push(theme.fg("warning", "Delete this worktree? Unmerged branches are kept · y confirm · n/esc cancel")); break;
					case "confirm-prune": lines.push(theme.fg("warning", "Prune all clean worktrees past retention? y confirm · n/esc cancel")); break;
					case "busy": lines.push(theme.fg("muted", "Working…")); break;
					default: lines.push(theme.fg("dim", "↑↓/jk select · d delete · p prune past retention · esc close"));
				}
				lines.push(border);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
			dispose() { clearInterval(timer); },
			handleInput(data: string) {
				if (mode === "busy") return;
				if (mode === "confirm-delete") {
					if (data.toLowerCase() === "y") {
						const item = load().items.find((entry) => entry.branch === selectedBranch);
						if (item) void run(() => actions.remove(item));
						else mode = "normal";
					} else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) mode = "normal";
					tui.requestRender();
					return;
				}
				if (mode === "confirm-prune") {
					if (data.toLowerCase() === "y") void run(() => actions.prune());
					else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) mode = "normal";
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(undefined);
				} else if (data.toLowerCase() === "d") {
					const item = load().items.find((entry) => entry.branch === selectedBranch);
					if (item?.dirty) message = "This worktree is protected because it has uncommitted changes.";
					else mode = "confirm-delete";
				}
				else if (data.toLowerCase() === "p") mode = "confirm-prune";
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data.toLowerCase() === "k" || data.toLowerCase() === "j") {
					const items = load().items;
					const index = Math.max(0, items.findIndex((item) => item.branch === selectedBranch));
					const offset = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
					if (items.length > 0) selectedBranch = items[(index + offset + items.length) % items.length].branch;
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center", margin: 1 } });
}

/**
 * Opencode-style agent picker. Returns selected agent name, "(none)", or null (cancelled).
 */
export function showAgentSelector(ctx: ExtensionContext, agents: DiscoveredAgent[], activeName: string | undefined): Promise<string | null> {
	const items: SelectItem[] = [
		...agents.map((agent) => {
			const isActive = agent.name === activeName;
			return {
				value: agent.name,
				label: isActive ? `● ${agent.name}` : `  ${agent.name}`,
				description: `${agent.description}\n${agentLabel(agent)}`,
			};
		}),
		{
			value: "(none)",
			label: activeName === undefined ? "● plain pi" : "  plain pi",
			description: "Default prompt and tools · no active agent",
		},
	];

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(
			theme.fg("accent", theme.bold(`Agents · ${agents.length}`))
			+ theme.fg("dim", `  ${activeName ? `active: ${activeName}` : "plain pi"}`),
			1,
			0,
		));

		// Colorize each agent's label with its own color; keep "(none)" plain.
		const coloredItems = items.map((item) => {
			if (item.value === "(none)") return item;
			const agent = agents.find((a) => a.name === item.value);
			return agent ? { ...item, label: colorize(theme, agent, item.label) } : item;
		});

		const searchInput = new Input();
		searchInput.focused = true;
		container.addChild({
			render: (width: number) => {
				const [input = ""] = searchInput.render(Math.max(1, width - 11));
				return [`${theme.fg("muted", " Filter  ")}${input}`];
			},
			invalidate: () => searchInput.invalidate(),
		});

		const selectList = new SelectList(coloredItems, Math.min(items.length, 10), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		const activeIndex = items.findIndex((item) => item.value === (activeName ?? "(none)"));
		if (activeIndex >= 0) selectList.setSelectedIndex(activeIndex);

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "type to filter · ↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			get focused() { return searchInput.focused; },
			set focused(value: boolean) { searchInput.focused = value; },
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					selectList.handleInput(data);
				} else {
					searchInput.handleInput(data);
					selectList.setFilter(searchInput.getValue());
				}
				tui.requestRender();
			},
		};
	});
}
