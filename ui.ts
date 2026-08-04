import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { DiscoveredAgent } from "./agents.ts";

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

/** Footer status line showing the active agent, or the default pi agent when none is selected. */
export function updateStatus(ctx: ExtensionContext, agent: DiscoveredAgent | undefined) {
	if (agent) {
		ctx.ui.setStatus("pi-agents", colorize(ctx.ui.theme, agent, `agent:${agent.name}`));
	} else {
		ctx.ui.setStatus("pi-agents", ctx.ui.theme.fg("muted", "agent:none · default pi"));
	}
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
