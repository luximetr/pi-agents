import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiscoveredAgent, SubagentConfig } from "./agents.ts";
import { formatModelReference, resolveModelAlias, type ModelAlias } from "./model-aliases.ts";
import { selectMenu, type MenuItem } from "./studio-menu.ts";

/** Pick a model for one subagent: an alias from the table, the parent default, or a hand-typed value. */
async function chooseSubagentModel(
	ctx: ExtensionContext,
	current: string | undefined,
	aliases: readonly ModelAlias[],
): Promise<string | undefined | typeof UNCHANGED> {
	const items: MenuItem<string>[] = [
		...aliases.map(alias => ({ id: `alias:${alias.id}`, label: `@${alias.name} → ${alias.model}` })),
		{ id: "default", label: "Default (inherit parent's model)" },
		{ id: "custom", label: "Custom… (type a model ID)" },
	];
	const choice = await selectMenu(ctx, `Set model (${formatModelReference(current, aliases)})`, items);
	if (choice === undefined) return UNCHANGED;
	if (choice === "default") return undefined;
	if (choice !== "custom") {
		const alias = aliases.find(candidate => `alias:${candidate.id}` === choice);
		if (alias) return `@id:${alias.id}`;
		return UNCHANGED;
	}
	const title = "Model pattern, provider/model ID, or @alias (blank = default)";
	const raw = current ? await ctx.ui.editor(title, current) : await ctx.ui.input(title);
	if (raw === undefined) return UNCHANGED;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Canonicalize hand-typed @names to the stable id form so renames keep working.
	const resolved = resolveModelAlias(trimmed, aliases);
	if (resolved.alias) return `@id:${resolved.alias.id}`;
	return trimmed;
}

const UNCHANGED: unique symbol = Symbol("unchanged");

/** Edit a detached list; Escape discards this menu's changes, Done keeps them in Studio. */
export async function editSubagents(
	ctx: ExtensionContext,
	parent: string,
	agents: readonly DiscoveredAgent[],
	current: readonly SubagentConfig[],
	aliases: readonly ModelAlias[] = [],
): Promise<SubagentConfig[] | undefined> {
	const entries = current.map(entry => ({ ...entry }));
	while (true) {
		const items: MenuItem<string>[] = [
			{ id: "add", label: "Add subagent" },
			...entries.map((entry, index) => ({
				id: `entry:${index}`,
				label: `${index + 1} · ${entry.name} · ${formatModelReference(entry.model, aliases)} · ${entry.timeoutSeconds === undefined ? "no timeout" : `${entry.timeoutSeconds}s`}${agents.some(agent => agent.name === entry.name) ? "" : " (missing agent)"}`,
			})),
			{ id: "done", label: "Done" },
		];
		const choice = await selectMenu(ctx, `Subagents · ${parent}`, items);
		if (choice === undefined) return undefined;
		if (choice === "done") return entries;
		if (choice === "add") {
			const candidates = agents.filter(agent => agent.name !== parent && !entries.some(entry => entry.name === agent.name));
			if (!candidates.length) {
				ctx.ui.notify("No more agents available. Create an agent from the dashboard first.", "info");
				continue;
			}
			const name = await selectMenu(ctx, "Add subagent", candidates.map(agent => ({ id: agent.name, label: `${agent.name} · ${agent.description}` })));
			if (name !== undefined) entries.push({ name });
			continue;
		}
		const index = Number(choice.slice("entry:".length));
		const entry = entries[index];
		const action = await selectMenu(ctx, `Subagent · ${entry.name}`, [
			{ id: "model", label: `Set model (${formatModelReference(entry.model, aliases)})` },
			{ id: "timeout", label: `Set timeout (${entry.timeoutSeconds === undefined ? "none" : `${entry.timeoutSeconds}s`})` },
			{ id: "remove", label: "Remove subagent" },
			{ id: "back", label: "Back" },
		]);
		if (action === "remove") entries.splice(index, 1);
		if (action === "model") {
			const model = await chooseSubagentModel(ctx, entry.model, aliases);
			if (model !== UNCHANGED) {
				if (model === undefined) delete entry.model;
				else entry.model = model;
			}
		}
		if (action === "timeout") {
			const title = "Timeout in seconds (blank = no deadline)";
			const value = entry.timeoutSeconds === undefined ? await ctx.ui.input(title) : await ctx.ui.editor(title, entry.timeoutSeconds.toString());
			if (value === undefined) continue;
			const timeout = value.trim() ? Number(value) : undefined;
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				ctx.ui.notify("Timeout must be a positive number of seconds.", "warning");
			} else entry.timeoutSeconds = timeout;
		}
	}
}
