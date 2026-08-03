import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { DiscoveredAgent } from "./agents.ts";

/** Short description line for the picker. */
export function agentLabel(agent: DiscoveredAgent): string {
	const parts: string[] = [];
	if (agent.tools && agent.tools.length > 0) parts.push(`tools:${agent.tools.join(",")}`);
	if (agent.systemPrompt) {
		const firstLine = agent.systemPrompt.split("\n")[0];
		const truncated = firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
		parts.push(`"${truncated}"`);
	}
	parts.push(agent.source);
	return parts.join(" | ");
}

/** Footer status line, e.g. "agent:dev". Cleared when no agent is active. */
export function updateStatus(ctx: ExtensionContext, name: string | undefined) {
	if (name) {
		ctx.ui.setStatus("pi-agents", ctx.ui.theme.fg("accent", `agent:${name}`));
	} else {
		ctx.ui.setStatus("pi-agents", undefined);
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

		const selectList = new SelectList(items, Math.min(items.length, 10), {
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
