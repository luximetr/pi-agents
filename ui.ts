import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, SelectList, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
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

/** Short description line for the picker. */
export function agentLabel(agent: DiscoveredAgent): string {
	const parts: string[] = [];
	if (agent.tools && agent.tools.length > 0) parts.push(`tools:${agent.tools.join(",")}`);
	if (agent.mcp && agent.mcp.length > 0) parts.push(`mcp:${agent.mcp.join(",")}`);
	if (agent.customTools) {
		const names = Object.keys(agent.customTools);
		if (names.length > 0) parts.push(`custom:${names.join(",")}`);
	}
	if (agent.systemPrompt) {
		const firstLine = agent.systemPrompt.split("\n")[0];
		const truncated = firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
		parts.push(`"${truncated}"`);
	}
	parts.push(agent.source);
	return parts.join(" | ");
}

/** Footer status line showing the active agent and optional session subagent stats. */
export function updateStatus(ctx: ExtensionContext, agent: DiscoveredAgent | undefined, subagentStats?: string) {
	const agentStatus = agent
		? colorize(ctx.ui.theme, agent, `agent:${agent.name}`)
		: ctx.ui.theme.fg("muted", "agent:none · default pi");
	const statsStatus = subagentStats ? ctx.ui.theme.fg("muted", ` · ${subagentStats}`) : "";
	ctx.ui.setStatus("pi-agents", `${agentStatus}${statsStatus}`);
}

/** Live, controllable view over running delegated RPC children. */
export function showSubagentInspector(
	ctx: ExtensionContext,
	getHandles: () => RunningSubagentHandle[],
	staleWarningMinutes: number,
): Promise<void> {
	const initial = getHandles();
	if (initial.length === 0) {
		ctx.ui.notify("No subagents are currently running.", "info");
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
		const elapsed = (ms: number) => {
			const total = Math.max(0, Math.floor(ms / 1000));
			const minutes = Math.floor(total / 60);
			return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
		};
		const argsText = (snapshot: SubagentSnapshot) => {
			if (snapshot.currentToolArgs === undefined) return "";
			try { return JSON.stringify(snapshot.currentToolArgs); } catch { return "[unavailable]"; }
		};

		return {
			get focused() { return steerInput.focused; },
			set focused(value: boolean) { steerInput.focused = value; },
			render(width: number) {
				const handle = selected();
				const snapshot = handle.snapshot();
				const now = Date.now();
				const idleMs = now - snapshot.lastActivityAt;
				const stale = snapshot.status === "running" && idleMs >= staleWarningMinutes * 60_000;
				const remaining = snapshot.deadlineAt === undefined ? "no deadline" : `${elapsed(snapshot.deadlineAt - now)} remaining`;
				const handles = getHandles();
				const title = handles.length > 1
					? `Subagent Inspector (${handles.findIndex((item) => item.id === snapshot.id) + 1}/${handles.length})`
					: "Subagent Inspector";
				const lines: string[] = [
					theme.fg("accent", theme.bold(title)),
					`${theme.fg("accent", snapshot.agent)} ${theme.fg("muted", `· ${snapshot.id}`)}`,
					`Status: ${snapshot.status} · ${snapshot.phase} · elapsed ${elapsed(now - snapshot.startedAt)} · ${remaining}`,
					stale
						? theme.fg("warning", `Possibly stalled: no RPC activity for ${elapsed(idleMs)}`)
						: theme.fg("muted", `Last activity ${elapsed(idleMs)} ago`),
				];
				if (snapshot.currentTool) lines.push(`Tool: ${snapshot.currentTool}${argsText(snapshot) ? ` ${argsText(snapshot)}` : ""}`);
				lines.push(theme.fg("muted", `Task: ${snapshot.task}`), "", theme.fg("accent", "Recent activity"));
				for (const event of snapshot.recentEvents.slice(-12)) lines.push(...wrapTextWithAnsi(event, Math.max(1, width - 2)).map((line) => ` ${line}`));
				if (snapshot.partialText.trim()) {
					lines.push("", theme.fg("accent", "Latest response"));
					for (const line of wrapTextWithAnsi(snapshot.partialText.trim().split("\n").slice(-5).join("\n"), Math.max(1, width - 2))) lines.push(` ${line}`);
				}
				lines.push("");
				if (mode === "confirm-stop") lines.push(theme.fg("warning", "Stop this subagent? y confirm · n/esc cancel"));
				else if (mode === "steer") {
					steerInput.focused = true;
					const [inputLine = ""] = steerInput.render(Math.max(1, width - 7));
					lines.push(`${theme.fg("accent", "Steer: ")}${inputLine}`, theme.fg("dim", "enter send · esc cancel"));
				} else lines.push(theme.fg("dim", `${handles.length > 1 ? "↑↓ select · " : ""}s steer · x stop · esc close`));
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() { steerInput.invalidate(); },
			dispose() { clearInterval(timer); },
			handleInput(data: string) {
				if (mode === "confirm-stop") {
					if (data.toLowerCase() === "y") {
						selected().stop("user");
						clearInterval(timer);
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
				if (matchesKey(data, Key.escape)) {
					clearInterval(timer);
					done(undefined);
				} else if (data.toLowerCase() === "x") mode = "confirm-stop";
				else if (data.toLowerCase() === "s") mode = "steer";
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
					const handles = getHandles();
					const index = Math.max(0, handles.findIndex((handle) => handle.id === selectedId));
					const offset = matchesKey(data, Key.up) ? -1 : 1;
					if (handles.length > 0) selectedId = handles[(index + offset + handles.length) % handles.length].id;
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center", margin: 1 } });
}

/** One row of the retained-worktree manager (pre-formatted for display). */
export interface WorktreeViewItem {
	branch: string;
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
				const lines: string[] = [
					theme.fg("accent", theme.bold(`Retained Subagent Worktrees (${items.length})`)),
					theme.fg("muted", snapshot.baseDir),
					"",
				];
				for (const item of items) {
					const marker = item.stale ? "!" : item.dirty ? "●" : "○";
					const coloredMarker = item.stale || item.dirty ? theme.fg("warning", marker) : theme.fg("muted", marker);
					const meta = [item.agent, item.ageLabel, item.status, item.unmerged ? "unmerged" : undefined, item.dirty === true ? "dirty" : undefined, item.stale ? "missing dir" : undefined]
						.filter(Boolean).join(" · ");
					const prefix = selected && item.branch === selected.branch ? theme.fg("accent", "> ") : "  ";
					lines.push(`${prefix}${coloredMarker} ${item.branch}  ${theme.fg("dim", meta)}`);
				}
				lines.push("");
				if (message) lines.push(theme.fg("muted", message), "");
				switch (mode) {
					case "confirm-delete": lines.push(theme.fg("warning", "Delete this worktree? Unmerged branches are kept · y confirm · n/esc cancel")); break;
					case "confirm-prune": lines.push(theme.fg("warning", "Prune all clean worktrees past retention? y confirm · n/esc cancel")); break;
					case "busy": lines.push(theme.fg("muted", "Working...")); break;
					default: lines.push(theme.fg("dim", "↑↓ select · d delete · p prune past retention · esc close"));
				}
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
					clearInterval(timer);
					done(undefined);
				} else if (data.toLowerCase() === "d") mode = "confirm-delete";
				else if (data.toLowerCase() === "p") mode = "confirm-prune";
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
					const items = load().items;
					const index = Math.max(0, items.findIndex((item) => item.branch === selectedBranch));
					const offset = matchesKey(data, Key.up) ? -1 : 1;
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
		{
			value: "(none)",
			label: activeName === undefined ? "(none) (active)" : "(none)",
			description: "Plain pi: default tools, no agent prompt",
		},
		...agents.map((agent) => {
			const isActive = agent.name === activeName;
			return {
				value: agent.name,
				label: isActive ? `${agent.name} (active)` : agent.name,
				description: agent.description + (agentLabel(agent) ? ` — ${agentLabel(agent)}` : ""),
			};
		}),
	];

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Agent"))));

		// Colorize each agent's label with its own color; keep "(none)" plain.
		const coloredItems = items.map((item) => {
			if (item.value === "(none)") return item;
			const agent = agents.find((a) => a.name === item.value);
			return agent ? { ...item, label: colorize(theme, agent, item.label) } : item;
		});

		const selectList = new SelectList(coloredItems, Math.min(items.length, 10), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
