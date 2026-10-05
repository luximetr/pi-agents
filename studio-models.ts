import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newModelAliasId, validateModelAliasName, type ModelAlias } from "./model-aliases.ts";
import type { DiscoveredAgent } from "./agents.ts";
import { selectMenu, type MenuItem } from "./studio-menu.ts";

/** How many subagent entries point at this alias (by stable id or current name). */
export function countAliasReferences(agents: readonly DiscoveredAgent[], alias: ModelAlias): number {
	return agents.flatMap(agent => agent.subagents ?? []).filter(entry => {
		const model = entry.model?.trim();
		return model === `@id:${alias.id}` || model === `@${alias.name}`;
	}).length;
}

/** Ask for an alias name; returns undefined when cancelled. Retries on invalid or duplicate names. */
async function promptAliasName(ctx: ExtensionContext, title: string, prefill?: string, ignore?: ModelAlias, siblings: readonly ModelAlias[] = []): Promise<string | undefined> {
	while (true) {
		const raw = prefill !== undefined
			? await ctx.ui.editor(title, prefill)
			: await ctx.ui.input(title);
		if (raw === undefined) return undefined;
		let name: string;
		try {
			name = validateModelAliasName(raw);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			continue;
		}
		if (siblings.some(candidate => candidate !== ignore && candidate.name.toLowerCase() === name.toLowerCase())) {
			ctx.ui.notify(`A model alias named "${name}" already exists. Names must be unique.`, "warning");
			continue;
		}
		return name;
	}
}

/** Ask for the model value an alias stores; returns undefined when cancelled. */
async function promptAliasModel(ctx: ExtensionContext, title: string, prefill?: string): Promise<string | undefined> {
	while (true) {
		const raw = prefill !== undefined
			? await ctx.ui.editor(title, prefill)
			: await ctx.ui.input(title);
		if (raw === undefined) return undefined;
		const model = raw.trim();
		if (!model) {
			ctx.ui.notify("Model value must not be empty.", "warning");
			continue;
		}
		if (model.startsWith("@")) {
			ctx.ui.notify("An alias stores a plain model ID — it cannot point at another alias.", "warning");
			continue;
		}
		return model;
	}
}

/**
 * Manage the global model alias table. Works on a detached copy: Escape
 * discards this menu's changes, Done keeps them for the caller to save.
 */
export async function editModelAliases(
	ctx: ExtensionContext,
	current: readonly ModelAlias[],
	agents: readonly DiscoveredAgent[] = [],
): Promise<ModelAlias[] | undefined> {
	const aliases = current.map(alias => ({ ...alias }));
	while (true) {
		const items: MenuItem<string>[] = [
			{ id: "add", label: "Add alias" },
			...aliases.map((alias) => ({
				id: `alias:${alias.id}`,
				label: `@${alias.name} → ${alias.model}`,
			})),
			{ id: "done", label: "Done" },
		];
		const choice = await selectMenu(ctx, "Model aliases", items);
		if (choice === undefined) return undefined;
		if (choice === "done") return aliases;
		if (choice === "add") {
			const name = await promptAliasName(ctx, "Alias name (letters, numbers, dot, underscore, hyphen — no spaces)", undefined, undefined, aliases);
			if (name === undefined) continue;
			const model = await promptAliasModel(ctx, `Model for @${name} (provider/model ID, thinking suffix allowed)`);
			if (model === undefined) continue;
			aliases.push({ id: newModelAliasId(), name, model });
			continue;
		}
		const alias = aliases.find(candidate => `alias:${candidate.id}` === choice);
		if (!alias) continue;
		const references = countAliasReferences(agents, alias);
		const action = await selectMenu(ctx, `Alias · @${alias.name}`, [
			{ id: "rename", label: `Rename (used by ${references} subagent ${references === 1 ? "entry" : "entries"})` },
			{ id: "model", label: `Set model (${alias.model})` },
			{ id: "delete", label: "Delete alias" },
			{ id: "back", label: "Back" },
		]);
		if (action === undefined || action === "back") continue;
		if (action === "rename") {
			const name = await promptAliasName(ctx, "Alias name (letters, numbers, dot, underscore, hyphen — no spaces)", alias.name, alias, aliases);
			if (name !== undefined) alias.name = name;
			continue;
		}
		if (action === "model") {
			const model = await promptAliasModel(ctx, `Model for @${alias.name} (provider/model ID, thinking suffix allowed)`, alias.model);
			if (model !== undefined) alias.model = model;
			continue;
		}
		if (action === "delete") {
			const warning = references > 0
				? `@${alias.name} is used by ${references} subagent ${references === 1 ? "entry" : "entries"}. Those delegations will warn and use the parent model until they pick another model.`
				: `@${alias.name} is not used by any subagent.`;
			if (!await ctx.ui.confirm(`Delete alias "@${alias.name}"?`, warning)) continue;
			aliases.splice(aliases.indexOf(alias), 1);
		}
	}
}
