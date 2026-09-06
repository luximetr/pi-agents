import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Markdown, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { BUILTIN_MCP_SERVER_DESCRIPTIONS, canSaveAgentSource, parseAgentColor, type AgentOverride, type DiscoveredAgent, type McpServerConfig } from "./agents.ts";
import { editAgentField } from "./studio-field-editor.ts";
import { editSubagents } from "./studio-subagents.ts";
import { AgentField, COLOR_MENU, ColorAction, STUDIO_LABELS, StudioAction, selectMenu, type MenuItem } from "./studio-menu.ts";
import type { McpRuntimeStatus } from "./mcp.ts";
import { configureCredentials } from "./credentials.ts";
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
	if (agent.studioDraft) parts.push("Studio draft");
	if (agent.savedOverrideSources?.length) parts.push(`${agent.savedOverrideSources.join("+")} override`);
	parts.push(agent.source);
	return parts.join(" · ");
}

/** Footer status line showing the active agent and optional session subagent stats. */
export function updateStatus(
	ctx: ExtensionContext,
	agent: DiscoveredAgent | undefined,
	subagentStats?: string,
	capabilities?: { toolCount: number; mcpNames: string[] },
) {
	const agentStatus = agent
		? colorize(ctx.ui.theme, agent, `agent:${agent.name}`)
		: ctx.ui.theme.fg("muted", "agent:none · default pi");
	const capabilityParts = agent && capabilities
		? [
			`${capabilities.toolCount} tool${capabilities.toolCount === 1 ? "" : "s"}`,
			capabilities.mcpNames.length > 0 ? `MCP:${capabilities.mcpNames.join(",")}` : undefined,
		].filter(Boolean)
		: [];
	const capabilityStatus = capabilityParts.length > 0 ? ctx.ui.theme.fg("muted", ` · ${capabilityParts.join(" · ")}`) : "";
	const statsStatus = subagentStats ? ctx.ui.theme.fg("muted", ` · ${subagentStats}`) : "";
	ctx.ui.setStatus("pi-agents", `${agentStatus}${capabilityStatus}${statsStatus}`);
}

export interface DelegateViewDetails {
	agent?: string;
	task?: string;
	model?: string;
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
export function renderDelegateCall(args: { agent?: unknown; task?: unknown; useWorktree?: unknown; model?: unknown }, theme: Theme): Text {
	const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : "…";
	const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : "Waiting for task";
	const mode = args.useWorktree === true ? "isolated worktree" : "current checkout";
	const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : "default model";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", "→")} ${theme.fg("accent", agent)}`
		+ ` ${theme.fg("dim", `· ${model} · ${mode}`)}`
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
		+ theme.fg("muted", ` · ${details.model ?? "default model"}`)
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

function snapshotModel(snapshot: SubagentSnapshot): string {
	const actual = snapshot.usage?.model;
	return actual ? [snapshot.usage?.provider, actual].filter(Boolean).join("/") : snapshot.model ?? "default model";
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
					lines.push(`${marker} ${icon(itemSnapshot.status)} ${theme.fg("accent", itemSnapshot.agent)}${theme.fg("dim", ` · ${snapshotModel(itemSnapshot)} · ${elapsedLabel(now - itemSnapshot.startedAt)}${activity}`)}`);
				}

				const remaining = snapshot.deadlineAt === undefined
					? "no deadline"
					: snapshot.deadlineAt <= now ? "deadline reached" : `${elapsedLabel(snapshot.deadlineAt - now)} left`;
				lines.push(
					"",
					`${icon(snapshot.status)} ${theme.fg("accent", theme.bold(snapshot.agent))} ${theme.fg("muted", `· ${snapshotModel(snapshot)} · ${snapshot.id}`)}`,
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

export interface AgentSelectorOptions {
	projectName: string;
	projectRoot: string;
	projectAgentsDir?: string;
	trusted: boolean;
	allTools: Array<{ name: string; description?: string }>;
	activeTools: string[];
	mcpServers: Record<string, McpServerConfig>;
	mcpServerSources: Record<string, "builtin" | "global" | "project">;
	mcpStatuses: Record<string, McpRuntimeStatus>;
}

type AgentDetailTab = "overview" | "tools" | "mcp" | "prompt";
const AGENT_DETAIL_TABS: AgentDetailTab[] = ["overview", "tools", "mcp", "prompt"];
const AGENT_DASHBOARD_HEIGHT = 18;

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function pushWrapped(lines: string[], width: number, value: string, indent = 2): void {
	const available = Math.max(1, width - indent);
	for (const line of wrapTextWithAnsi(value, available)) lines.push(`${" ".repeat(indent)}${line}`);
}

function configuredServer(agent: DiscoveredAgent, name: string, options: AgentSelectorOptions): McpServerConfig | undefined {
	return agent.mcpServers?.[name] ?? options.mcpServers[name];
}

function projectedTools(agent: DiscoveredAgent, agents: DiscoveredAgent[], options: AgentSelectorOptions): { names?: string[]; unknown: string[] } {
	if (agent.tools === undefined) return { names: undefined, unknown: [] };
	const known = new Set([...options.allTools.map((tool) => tool.name), ...Object.keys(agent.customTools ?? {})]);
	const unknown = agent.tools.filter((name) => !known.has(name));
	const base = agent.tools.filter((name) => known.has(name));
	const custom = Object.keys(agent.customTools ?? {});
	const delegates = agent.subagents?.some((child) => agents.some((candidate) => candidate.name === child.name)) ? ["delegate"] : [];
	const mcp = (agent.mcp ?? []).flatMap((name) => options.mcpStatuses[name]?.toolNames ?? []);
	return { names: [...new Set([...base, ...custom, ...delegates, ...mcp])], unknown };
}

function renderAgentDetails(
	agent: DiscoveredAgent | undefined,
	tab: AgentDetailTab,
	width: number,
	theme: Theme,
	agents: DiscoveredAgent[],
	activeName: string | undefined,
	options: AgentSelectorOptions,
): string[] {
	const lines: string[] = [];
	const tabs = AGENT_DETAIL_TABS.map((name) => name === tab ? theme.fg("accent", theme.bold(`[${name}]`)) : theme.fg("dim", name)).join("  ");
	lines.push(` ${tabs}`);
	if (!agent) {
		lines.push(theme.fg("accent", theme.bold(" plain pi")));
		pushWrapped(lines, width, "Default Pi system prompt and the toolset that was active before an agent was selected.");
		return lines;
	}

	lines.push(` ${colorize(theme, agent, theme.bold(agent.name))}${agent.name === activeName ? theme.fg("success", "  ● active") : ""}${agent.studioDraft ? theme.fg("warning", "  ◆ draft") : ""}`);
	if (tab === "overview") {
		pushWrapped(lines, width, agent.description);
		if (agent.whenToUse) pushWrapped(lines, width, `${theme.fg("muted", "Use when: ")}${agent.whenToUse}`);
		if (agent.capabilities?.length) pushWrapped(lines, width, `${theme.fg("muted", "Capabilities: ")}${agent.capabilities.join(" · ")}`);
		if (agent.limitations?.length) pushWrapped(lines, width, `${theme.fg("muted", "Limitations: ")}${agent.limitations.join(" · ")}`);
		if (agent.examples?.length) pushWrapped(lines, width, `${theme.fg("muted", "Examples: ")}${agent.examples.join(" · ")}`);
		if (agent.subagents?.length) pushWrapped(lines, width, `${theme.fg("muted", "Delegates: ")}${agent.subagents.map((child) => child.name).join(", ")}`);
		if (agent.deniedPaths?.length) pushWrapped(lines, width, `${theme.fg("muted", "Denied paths: ")}${agent.deniedPaths.join(", ")}`);
		pushWrapped(lines, width, `${theme.fg("muted", "Source: ")}${agent.filePath} (${agent.source})`);
		if (agent.savedOverrideSources?.length) pushWrapped(lines, width, `${theme.fg("warning", "Saved settings override: ")}${agent.savedOverrideSources.join(" + ")} config.json`);
		if (agent.overrides) pushWrapped(lines, width, `${theme.fg("warning", "Shadows source: ")}${agent.overrides.filePath} (${agent.overrides.source})`);
	} else if (tab === "tools") {
		const projected = projectedTools(agent, agents, options);
		const effective = agent.name === activeName ? options.activeTools : projected.names;
		pushWrapped(lines, width, `${theme.fg("muted", "Declared: ")}${agent.tools === undefined ? "inherit current toolset" : agent.tools.length ? agent.tools.join(", ") : "no built-ins"}`);
		pushWrapped(lines, width, `${theme.fg("muted", agent.name === activeName ? "Effective: " : "On activation: ")}${effective === undefined ? "current toolset + agent capabilities" : effective.length ? effective.join(", ") : "none"}`);
		if (projected.unknown.length) pushWrapped(lines, width, theme.fg("warning", `Unknown: ${projected.unknown.join(", ")}`));
		for (const [name, tool] of Object.entries(agent.customTools ?? {})) {
			pushWrapped(lines, width, `${theme.fg("accent", `custom:${name}`)} — ${tool.description}`);
		}
		if (agent.mcp?.length) pushWrapped(lines, width, theme.fg("dim", "MCP tools are discovered when their server connects; cached names are included above."));
	} else if (tab === "mcp") {
		if (!agent.mcp?.length) {
			pushWrapped(lines, width, "No MCP servers assigned to this agent.");
		} else {
			for (const name of agent.mcp) {
				const server = configuredServer(agent, name, options);
				const status = options.mcpStatuses[name] ?? { state: "disconnected", toolNames: [] };
				const source = agent.mcpServers?.[name] ? "agent-local" : options.mcpServerSources[name] ?? "undefined";
				const transport = server?.url ? "HTTP" : server?.command ? "stdio" : "missing definition";
				const displayState = server ? status.state : "missing";
				const stateColor = status.state === "connected" ? "success" : status.state === "failed" || !server ? "error" : "muted";
				pushWrapped(lines, width, `${theme.fg("accent", name)} · ${transport} · ${source} · ${theme.fg(stateColor, displayState)}`);
				if (status.toolNames.length) pushWrapped(lines, width, `Tools: ${status.toolNames.join(", ")}`, 4);
				if (status.error) pushWrapped(lines, width, theme.fg("error", status.error), 4);
			}
		}
	} else {
		const source = agent.systemPromptPath ?? (agent.systemPrompt ? "inline in agent definition" : "no agent system prompt");
		pushWrapped(lines, width, `${theme.fg("muted", "Source: ")}${source}`);
		if (agent.promptSummary) pushWrapped(lines, width, `${theme.fg("muted", "Summary: ")}${agent.promptSummary}`);
		const promptLines = (agent.systemPrompt ?? "This agent does not append a system prompt.")
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width - 4)));
		for (const line of promptLines) lines.push(`    ${theme.fg("text", line)}`);
	}
	return lines;
}

export type AgentSelectorResult = string | { action: "edit" | "reorder" | "delete"; agent: string } | { action: "create" } | null;

export type AgentStudioResult =
	| { action: "apply" | "save-source" | "save-project" | "save-global"; override: AgentOverride }
	| { action: "revert" }
	| null;

const TOGGLE_EDITOR_HEIGHT = 16;

/** Checkbox selector with a stable details pane for the currently highlighted tool/server. */
async function showToggleEditor(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ id: string; label: string; description?: string }>,
	initial: string[],
	serverSettings?: { credentials: (name: string) => Promise<void>; test: (name: string) => Promise<string | void> },
): Promise<string[]> {
	const enabled = new Set(initial);
	const searchInput = new Input();
	searchInput.focused = true;
	let selectedId = items.find((item) => enabled.has(item.id))?.id ?? items[0]?.id;
	let settingsFocused = false;
	let settingIndex = 0;
	const testResults = new Map<string, string>();
	const show = () => ctx.ui.custom<"credentials" | "test" | undefined>((tui, theme, _kb, done) => {

		const filteredItems = () => {
			const query = searchInput.getValue().trim().toLowerCase();
			return query
				? items.filter((item) => `${item.label}\n${item.description ?? ""}`.toLowerCase().includes(query))
				: items;
		};
		const ensureSelection = () => {
			const filtered = filteredItems();
			if (!filtered.some((item) => item.id === selectedId)) selectedId = filtered[0]?.id;
			return filtered;
		};

		return {
			get focused() { return searchInput.focused; },
			set focused(value: boolean) { searchInput.focused = value; },
			render(width: number) {
				const filtered = ensureSelection();
				const selectedIndex = Math.max(0, filtered.findIndex((item) => item.id === selectedId));
				const selected = filtered[selectedIndex];
				const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
				const [input = ""] = searchInput.render(Math.max(1, width - 11));
				const lines = [border, truncateToWidth(theme.fg("accent", theme.bold(title)), width), `${theme.fg("muted", " Filter  ")}${input}`];
				const usableWidth = Math.max(2, width - 3);
				const desiredLeftWidth = Math.max(12, Math.min(32, Math.floor(usableWidth * 0.38)));
				const leftWidth = Math.min(Math.max(1, usableWidth - 1), desiredLeftWidth);
				const rightWidth = Math.max(1, usableWidth - leftWidth);
				const listCapacity = TOGGLE_EDITOR_HEIGHT - 2;
				const listStart = Math.min(
					Math.max(0, selectedIndex - Math.floor(listCapacity / 2)),
					Math.max(0, filtered.length - listCapacity),
				);
				const leftPane = [
					theme.fg("accent", theme.bold(` Choices (${enabled.size}/${items.length})`)),
					theme.fg("dim", ` ${filtered.length} shown`),
					...(filtered.length > 0
						? filtered.slice(listStart, listStart + listCapacity).map((item) => {
							const marker = item.id === selectedId ? theme.fg("accent", "›") : " ";
							const check = enabled.has(item.id) ? theme.fg("success", "✓") : theme.fg("muted", "○");
							const label = item.id === selectedId ? theme.fg("accent", item.label) : item.label;
							return ` ${marker} ${check} ${label}`;
						})
						: [theme.fg("warning", " No matching choices")]),
				];
				const rightPane: string[] = [];
				if (selected) {
					rightPane.push(
						theme.fg("accent", theme.bold(` ${selected.label}`)),
						theme.fg(enabled.has(selected.id) ? "success" : "muted", ` ${enabled.has(selected.id) ? "✓ enabled" : "○ disabled"}`),
						"",
					);
					if (serverSettings) {
						const settings = [enabled.has(selected.id) ? "Disable server" : "Enable server", "Manage credentials", "Test connection"];
						settings.forEach((label, index) => rightPane.push(
							settingsFocused && settingIndex === index ? theme.fg("accent", ` › ${label}`) : `   ${label}`,
						));
						rightPane.push(theme.fg("dim", " Enable changes apply with the Studio draft."), "");
						const result = testResults.get(selected.id);
						if (result) pushWrapped(rightPane, rightWidth, result, 1);
					}
					for (const paragraph of (selected.description ?? "No description is registered for this item.").split("\n")) {
						pushWrapped(rightPane, rightWidth, paragraph, 1);
					}
				} else {
					rightPane.push(theme.fg("muted", " No item selected."));
				}
				const divider = theme.fg("borderMuted", " │ ");
				for (let row = 0; row < TOGGLE_EDITOR_HEIGHT; row++) {
					lines.push(`${padToWidth(leftPane[row] ?? "", leftWidth)}${divider}${padToWidth(rightPane[row] ?? "", rightWidth)}`);
				}
				lines.push(theme.fg("dim", serverSettings
					? settingsFocused ? " ↑↓ settings · enter select · tab/esc server list" : " type to filter · ↑↓ server · enter/tab settings · space toggle · esc done"
					: " type to filter · ↑↓ select · space/enter toggle · esc done"), border);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() { searchInput.invalidate(); },
			handleInput(data: string) {
				const filtered = ensureSelection();
				const index = Math.max(0, filtered.findIndex((item) => item.id === selectedId));
				if (matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
				} else if (matchesKey(data, Key.escape)) {
					if (settingsFocused) settingsFocused = false;
					else done(undefined);
				} else if (serverSettings && matchesKey(data, Key.tab)) {
					if (selectedId) settingsFocused = !settingsFocused;
				} else if (settingsFocused) {
					if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						settingIndex = (settingIndex + (matchesKey(data, Key.up) ? 2 : 1)) % 3;
					} else if (matchesKey(data, Key.enter) && selectedId) {
						if (settingIndex === 0) {
							if (enabled.has(selectedId)) enabled.delete(selectedId);
							else enabled.add(selectedId);
						} else done(settingIndex === 1 ? "credentials" : "test");
					}
				} else if (serverSettings && matchesKey(data, Key.enter)) {
					if (selectedId) settingsFocused = true;
				} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
					if (filtered.length > 0) {
						const offset = matchesKey(data, Key.up) ? -1 : 1;
						selectedId = filtered[(index + offset + filtered.length) % filtered.length].id;
					}
				} else if (data === " " || matchesKey(data, Key.enter)) {
					if (selectedId) {
						if (enabled.has(selectedId)) enabled.delete(selectedId);
						else enabled.add(selectedId);
					}
				} else {
					searchInput.handleInput(data);
					ensureSelection();
				}
				tui.requestRender();
			},
		};
	});
	while (true) {
		const action = await show();
		if (!action || !selectedId || !serverSettings) break;
		const result = await serverSettings[action](selectedId);
		if (action === "credentials") testResults.delete(selectedId);
		else if (result) testResults.set(selectedId, result);
	}
	return items.map((item) => item.id).filter((id) => enabled.has(id));
}

export async function chooseAgentColor(ctx: ExtensionContext, current?: string): Promise<string | null | undefined> {
	const choice = await selectMenu(ctx, `Agent color · ${current ?? "automatic"}`, COLOR_MENU);
	if (!choice) return undefined;
	if (choice === ColorAction.Automatic) return null;
	if (choice !== ColorAction.Custom) return COLOR_MENU.find(item => item.id === choice)?.color;
	while (true) {
		const value = await ctx.ui.input("Color: #rrggbb or theme role", current ?? "#4cc2ff, accent, success, warning");
		if (value === undefined) return undefined;
		const color = parseAgentColor(value);
		if (color) return color;
		ctx.ui.notify("Use a six-digit hex color or valid theme role.", "warning");
	}
}

/** Interactive editor: static definitions save to source; dynamic definitions use explicit overlays. */
export async function showAgentStudio(
	ctx: ExtensionContext,
	agent: DiscoveredAgent,
	options: AgentSelectorOptions & { agents?: readonly DiscoveredAgent[]; hasSessionDraft: boolean; onSetDefault?: () => Promise<void>; onCredentialsSaved?: () => Promise<void>; onTestMcp?: (name: string) => Promise<string | void> },
): Promise<AgentStudioResult> {
	let tools = agent.tools === undefined ? [...options.activeTools] : [...agent.tools];
	let inheritsTools = agent.tools === undefined;
	let mcp = [...(agent.mcp ?? [])];
	let subagents = agent.subagents?.map(entry => ({ ...entry }));
	let systemPrompt = agent.systemPrompt ?? "";
	let description = agent.description;
	let color = agent.color;
	const sourceIsEditable = canSaveAgentSource(agent);
	const sourceFileName = agent.filePath.split(/[\\/]/).at(-1) ?? "agent source";
	const available = {
		tools: [...new Set([...options.allTools.map(tool => tool.name).filter(name => name !== "delegate" && name !== "powershell" && !name.includes("__")), ...Object.keys(agent.customTools ?? {})])],
		mcp: [...new Set([...Object.keys(options.mcpServers), ...Object.keys(agent.mcpServers ?? {})])],
	};
	const currentDraft = () => ({ name: agent.name, description, color, tools: inheritsTools ? undefined : tools, mcp, systemPrompt });

	while (true) {
		const item = (id: StudioAction, suffix?: string): MenuItem<StudioAction> => ({
			id, label: STUDIO_LABELS[id] + (suffix === undefined ? "" : ` (${suffix})`),
		});
		const actions = [
			item(StudioAction.Description),
			item(StudioAction.Color, color ?? "automatic"),
			item(StudioAction.Prompt, systemPrompt ? `${systemPrompt.split("\n").length} lines` : "empty"),
			item(StudioAction.Tools, inheritsTools ? "inherited" : String(tools.length)),
			item(StudioAction.Mcp, String(mcp.length)),
			item(StudioAction.Subagents, String(subagents?.length ?? 0)),
			...(options.onSetDefault ? [item(StudioAction.Default)] : []),
			item(StudioAction.Apply),
			...(sourceIsEditable
				? [{ id: StudioAction.SaveSource, label: `Save ${sourceFileName} (${agent.source})` }]
				: [
					...(options.trusted ? [item(StudioAction.SaveProject)] : []),
					item(StudioAction.SaveGlobal),
				]),
			...(options.hasSessionDraft ? [item(StudioAction.Revert)] : []),
			item(StudioAction.Back),
		];
		const choice = await selectMenu(ctx, `Agent Studio · ${agent.name}`, actions);
		if (!choice || choice === StudioAction.Back) return null;
		if (choice === StudioAction.Default) {
			await options.onSetDefault?.();
			continue;
		}
		if (choice === StudioAction.Description) {
			const edited = await editAgentField(ctx, AgentField.Description, currentDraft(), available);
			if (edited?.trim()) description = edited.trim();
			continue;
		}
		if (choice === StudioAction.Color) {
			const edited = await chooseAgentColor(ctx, color);
			if (edited !== undefined) color = edited ?? undefined;
			continue;
		}
		if (choice === StudioAction.Prompt) {
			const edited = await editAgentField(ctx, AgentField.SystemPrompt, currentDraft(), available);
			if (edited !== undefined) systemPrompt = edited;
			continue;
		}
		if (choice === StudioAction.Tools) {
			const ownCustom = new Set(Object.keys(agent.customTools ?? {}));
			const choices = options.allTools
				.filter((tool) => tool.name !== "delegate" && tool.name !== "powershell" && !tool.name.includes("__") && !ownCustom.has(tool.name))
				.map((tool) => ({ id: tool.name, label: tool.name, description: tool.description }));
			tools = await showToggleEditor(ctx, `Tools · ${agent.name}`, choices, tools);
			inheritsTools = false;
			continue;
		}
		if (choice === StudioAction.Subagents) {
			const edited = await editSubagents(ctx, agent.name, options.agents ?? [], subagents ?? []);
			if (edited !== undefined) subagents = edited;
			continue;
		}
		if (choice === StudioAction.Mcp) {
			const names = [...new Set([...Object.keys(options.mcpServers), ...Object.keys(agent.mcpServers ?? {}), ...mcp])].sort();
			const choices = names.map((name) => {
				const source = agent.mcpServers?.[name] ? "agent-local" : options.mcpServerSources[name] ?? "unknown";
				const cfg = agent.mcpServers?.[name] ?? options.mcpServers[name];
				const transport = cfg?.url
					? `HTTP · ${cfg.url}`
					: cfg?.command
						? `stdio · ${[cfg.command, ...(cfg.args ?? [])].join(" ")}`
						: "missing definition";
				const recipeHelp = source === "builtin" ? BUILTIN_MCP_SERVER_DESCRIPTIONS[name] : undefined;
				return {
					id: name,
					label: name,
					description: [recipeHelp, `${transport} · ${source}`].filter(Boolean).join("\n"),
				};
			});
			if (choices.length === 0) ctx.ui.notify("No MCP servers or built-in recipes are available.", "warning");
			else mcp = await showToggleEditor(ctx, `MCP servers · ${agent.name}`, choices, mcp, {
				credentials: async (name) => {
					if (await configureCredentials(ctx, { ...options.mcpServers, ...agent.mcpServers }, agent, options.trusted, name)) {
						try { await options.onCredentialsSaved?.(); }
						catch { ctx.ui.notify("Credential saved, but runtime refresh failed. Run /reload to retry.", "error"); }
					}
				},
				test: async (name) => {
					try {
						if (options.onTestMcp) return await options.onTestMcp(name);
						else ctx.ui.notify("Connection testing is unavailable in this context.", "warning");
					} catch { ctx.ui.notify("MCP connection test failed.", "error"); }
				},
			});
			continue;
		}
		if (choice === StudioAction.Revert) return { action: "revert" };
		const override: AgentOverride = {
			description,
			color: color ?? null,
			...(inheritsTools ? {} : { tools }),
			...(subagents === undefined ? {} : { subagents }),
			mcp,
			systemPrompt: systemPrompt.trim() ? systemPrompt : null,
		};
		if (choice === StudioAction.Apply) return { action: "apply", override };
		if (choice === StudioAction.SaveSource) return { action: "save-source", override };
		if (choice === StudioAction.SaveProject) return { action: "save-project", override };
		if (choice === StudioAction.SaveGlobal) return { action: "save-global", override };
	}
}

/** Agent dashboard and picker. Enter activates; e opens Agent Studio. */
export function showAgentSelector(
	ctx: ExtensionContext,
	agents: DiscoveredAgent[],
	activeName: string | undefined,
	options: AgentSelectorOptions,
): Promise<AgentSelectorResult> {
	const items: SelectItem[] = [
		...agents.map((agent) => ({
			value: agent.name,
			label: agent.name === activeName ? `● ${agent.name}` : `  ${agent.name}`,
			description: `${agent.description} · ${agentLabel(agent)}`,
		})),
		{ value: "(none)", label: activeName === undefined ? "● plain pi" : "  plain pi", description: "Default prompt and tools · no active agent" },
	];

	return ctx.ui.custom<AgentSelectorResult>((tui, theme, _kb, done) => {
		const coloredItems = items.map((item) => {
			const agent = agents.find((candidate) => candidate.name === item.value);
			return agent ? { ...item, label: colorize(theme, agent, item.label) } : item;
		});
		const searchInput = new Input();
		searchInput.focused = true;
		const selectList = new SelectList(coloredItems, Math.min(items.length, 7), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 28 });
		const activeIndex = items.findIndex((item) => item.value === (activeName ?? "(none)"));
		if (activeIndex >= 0) selectList.setSelectedIndex(activeIndex);
		let tabIndex = 0;
		let detailOffset = 0;
		let maxDetailOffset = 0;
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		selectList.onSelectionChange = () => { detailOffset = 0; };

		return {
			get focused() { return searchInput.focused; },
			set focused(value: boolean) { searchInput.focused = value; },
			render(width: number) {
				const selectedValue = selectList.getSelectedItem()?.value;
				const selectedAgent = agents.find((agent) => agent.name === selectedValue);
				const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
				const scope = `${agents.filter((agent) => agent.source === "project").length} project + ${agents.filter((agent) => agent.source === "global").length} global`;
				const lines = [
					border,
					truncateToWidth(`${theme.fg("accent", theme.bold(`Agents · ${options.projectName}`))}${theme.fg("dim", ` · ${scope} · ${options.trusted ? "trusted" : "untrusted"}`)}`, width),
					truncateToWidth(theme.fg("dim", `${options.projectRoot}${options.projectAgentsDir ? ` · config ${options.projectAgentsDir}` : " · global agents only"}`), width),
				];
				const [input = ""] = searchInput.render(Math.max(1, width - 11));
				lines.push(`${theme.fg("muted", " Filter  ")}${input}`);

				// Keep the selector and inspector side by side at a fixed height so
				// moving between differently-sized agent definitions never shifts the UI.
				const usableWidth = Math.max(2, width - 3);
				const desiredLeftWidth = Math.max(8, Math.min(30, Math.floor(usableWidth * 0.32)));
				const leftWidth = Math.min(Math.max(1, usableWidth - 1), desiredLeftWidth);
				const rightWidth = Math.max(1, usableWidth - leftWidth);
				const leftPane = [
					theme.fg("accent", theme.bold(" Agents")),
					theme.fg("dim", " ↑↓ select"),
					...selectList.render(leftWidth),
				];
				const details = renderAgentDetails(selectedAgent, AGENT_DETAIL_TABS[tabIndex], rightWidth, theme, agents, activeName, options);
				const fixedDetailLines = details.slice(0, 2);
				const detailBody = details.slice(2);
				const bodyCapacity = Math.max(0, AGENT_DASHBOARD_HEIGHT - fixedDetailLines.length);
				const needsScroll = detailBody.length > bodyCapacity;
				const visibleBodyRows = Math.max(0, bodyCapacity - (needsScroll ? 1 : 0));
				maxDetailOffset = Math.max(0, detailBody.length - visibleBodyRows);
				detailOffset = Math.min(detailOffset, maxDetailOffset);
				const rightPane = [...fixedDetailLines, ...detailBody.slice(detailOffset, detailOffset + visibleBodyRows)];
				if (needsScroll) {
					rightPane.push(theme.fg("dim", ` … ${detailOffset + 1}–${Math.min(detailOffset + visibleBodyRows, detailBody.length)} of ${detailBody.length} · PgUp/PgDn`));
				}
				const divider = theme.fg("borderMuted", " │ ");
				for (let row = 0; row < AGENT_DASHBOARD_HEIGHT; row++) {
					lines.push(`${padToWidth(leftPane[row] ?? "", leftWidth)}${divider}${padToWidth(rightPane[row] ?? "", rightWidth)}`);
				}
				lines.push(
					theme.fg("dim", " type to filter · ↑↓ agent · tab/←→ details · enter activate · esc cancel"),
					theme.fg("dim", " e edit · n new · r reorder · ctrl+d delete"),
					border,
				);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() { searchInput.invalidate(); selectList.invalidate(); },
			handleInput(data: string) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					tabIndex = (tabIndex + 1) % AGENT_DETAIL_TABS.length;
					detailOffset = 0;
				} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					tabIndex = (tabIndex - 1 + AGENT_DETAIL_TABS.length) % AGENT_DETAIL_TABS.length;
					detailOffset = 0;
				} else if (matchesKey(data, Key.pageDown)) {
					detailOffset = Math.min(maxDetailOffset, detailOffset + 10);
				} else if (matchesKey(data, Key.pageUp)) {
					detailOffset = Math.max(0, detailOffset - 10);
				} else if (data.toLowerCase() === "e") {
					const selected = selectList.getSelectedItem()?.value;
					if (selected && selected !== "(none)") done({ action: "edit", agent: selected });
				} else if (data.toLowerCase() === "n") {
					done({ action: "create" });
				} else if (data.toLowerCase() === "r" || matchesKey(data, Key.delete) || matchesKey(data, Key.ctrl("d"))) {
					const selected = selectList.getSelectedItem()?.value;
					if (selected && selected !== "(none)") done({ action: data.toLowerCase() === "r" ? "reorder" : "delete", agent: selected });
				} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					selectList.handleInput(data);
				} else {
					searchInput.handleInput(data);
					selectList.setFilter(searchInput.getValue());
					detailOffset = 0;
				}
				tui.requestRender();
			},
		};
	});
}
