import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface MenuItem<Id extends string> {
	id: Id;
	label: string;
}

/** ui.select is label-only. Resolve it here; callers deal exclusively in stable IDs. */
export async function selectMenu<Id extends string>(ctx: ExtensionContext, title: string, items: readonly MenuItem<Id>[]): Promise<Id | undefined> {
	const byLabel = new Map(items.map(item => [item.label, item.id]));
	if (byLabel.size !== items.length) throw new Error("Menu labels must be unique within a menu.");
	const selected = await ctx.ui.select(title, items.map(item => item.label));
	return selected === undefined ? undefined : byLabel.get(selected);
}

export enum StudioAction {
	Description = "description",
	Lifecycle = "lifecycle",
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
	[StudioAction.Lifecycle]: "Delegated lifecycle",
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
