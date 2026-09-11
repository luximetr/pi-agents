import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface MenuItem<Id extends string> {
	id: Id;
	label: string;
}

class WrappingMenu<Id extends string> implements Component {
	private selected = 0;

	constructor(
		private readonly title: string,
		private readonly items: readonly MenuItem<Id>[],
		private readonly theme: Theme,
		private readonly onDone: (value: Id | undefined) => void,
		private readonly requestRender: () => void,
	) {}

	render(width: number): string[] {
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), width),
			...this.items.map((item, index) => truncateToWidth(
				index === this.selected
					? this.theme.bg("selectedBg", this.theme.fg("accent", `› ${item.label}`))
					: this.theme.fg("text", `  ${item.label}`),
				width,
			)),
			truncateToWidth(this.theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), width),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selected = (this.selected - 1 + this.items.length) % this.items.length;
			this.requestRender();
		} else if (matchesKey(data, Key.down)) {
			this.selected = (this.selected + 1) % this.items.length;
			this.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			this.onDone(this.items[this.selected]?.id);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(undefined);
		}
	}

	invalidate(): void {}
}

/** Select by stable ID, with wrapping navigation in the production TUI. */
export async function selectMenu<Id extends string>(ctx: ExtensionContext, title: string, items: readonly MenuItem<Id>[]): Promise<Id | undefined> {
	const byLabel = new Map(items.map(item => [item.label, item.id]));
	if (byLabel.size !== items.length) throw new Error("Menu labels must be unique within a menu.");
	if (items.length === 0) return undefined;

	// RPC/non-interactive adapters and lightweight extension harnesses implement label-only select.
	// A real TUI supplies the complete theme API as well as custom components.
	if (ctx.mode !== "tui" || typeof ctx.ui.theme.bg !== "function") {
		const selected = await ctx.ui.select(title, items.map(item => item.label));
		return selected === undefined ? undefined : byLabel.get(selected);
	}

	return ctx.ui.custom<Id | undefined>((tui, theme, _keybindings, done) =>
		new WrappingMenu(title, items, theme, done, () => tui.requestRender()),
	);
}

export enum StudioAction {
	Description = "description",
	Color = "color",
	Prompt = "prompt",
	Tools = "tools",
	Mcp = "mcp",
	Subagents = "subagents",
	Default = "default",
	Apply = "apply",
	SaveSource = "save-source",
	SaveProject = "save-project",
	SaveGlobal = "save-global",
	Revert = "revert",
	Back = "back",
}

export const STUDIO_LABELS: Record<StudioAction, string> = {
	[StudioAction.Description]: "Edit description",
	[StudioAction.Color]: "Color",
	[StudioAction.Prompt]: "Edit prompt",
	[StudioAction.Tools]: "Choose tools",
	[StudioAction.Mcp]: "Manage MCP servers",
	[StudioAction.Subagents]: "Manage subagents",
	[StudioAction.Default]: "Set as default agent",
	[StudioAction.Apply]: "Apply as session draft",
	[StudioAction.SaveSource]: "Save agent source",
	[StudioAction.SaveProject]: "Save project override (.pi-agents/config.json)",
	[StudioAction.SaveGlobal]: "Save global override (~/.pi/agent/pi-agents/config.json)",
	[StudioAction.Revert]: "Revert session draft",
	[StudioAction.Back]: "Back without applying",
};

export enum AgentScope { Project = "project", Global = "global" }
export const SCOPE_MENU: MenuItem<AgentScope>[] = [
	{ id: AgentScope.Project, label: "Project (commit with this repository)" },
	{ id: AgentScope.Global, label: "Global (all projects)" },
];
export enum AuthoringMethod { AI = "ai", Manual = "manual" }
export const CREATE_MENU: MenuItem<AuthoringMethod>[] = [
	{ id: AuthoringMethod.AI, label: "Describe with AI" },
	{ id: AuthoringMethod.Manual, label: "Create manually" },
];
export enum AgentField { Description = "description", SystemPrompt = "systemPrompt" }
export const AGENT_FIELD_LABELS: Record<AgentField, string> = {
	[AgentField.Description]: "Description",
	[AgentField.SystemPrompt]: "System prompt",
};
export enum FieldEditorAction { Save = "save", Assist = "assist", Cancel = "cancel" }

export enum ColorAction {
	Automatic = "automatic", Custom = "custom",
	Blue = "blue", Orange = "orange", Green = "green", Pink = "pink",
	Purple = "purple", Yellow = "yellow", Teal = "teal",
}
export const COLOR_MENU: (MenuItem<ColorAction> & { color?: string })[] = [
	{ id: ColorAction.Automatic, label: "Automatic" },
	{ id: ColorAction.Blue, label: "Blue (#4cc2ff)", color: "#4cc2ff" },
	{ id: ColorAction.Orange, label: "Orange (#ff9f0a)", color: "#ff9f0a" },
	{ id: ColorAction.Green, label: "Green (#30d158)", color: "#30d158" },
	{ id: ColorAction.Pink, label: "Pink (#ff375f)", color: "#ff375f" },
	{ id: ColorAction.Purple, label: "Purple (#bf5af2)", color: "#bf5af2" },
	{ id: ColorAction.Yellow, label: "Yellow (#ffd60a)", color: "#ffd60a" },
	{ id: ColorAction.Teal, label: "Teal (#64d2ff)", color: "#64d2ff" },
	{ id: ColorAction.Custom, label: "Custom hex/theme role" },
];
