import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiscoveredAgent, SubagentConfig } from "./agents.ts";
import { selectMenu, type MenuItem } from "./studio-menu.ts";

/** Edit a detached list; Escape discards this menu's changes, Done keeps them in Studio. */
export async function editSubagents(ctx: ExtensionContext, parent: string, agents: readonly DiscoveredAgent[], current: readonly SubagentConfig[]): Promise<SubagentConfig[] | undefined> {
	const entries = current.map(entry => ({ ...entry }));
	while (true) {
		const items: MenuItem<string>[] = [
			{ id: "add", label: "Add subagent" },
			...entries.map((entry, index) => ({
				id: `entry:${index}`,
				label: `${index + 1} · ${entry.name} · ${entry.model ?? "default model"} · ${entry.timeoutSeconds === undefined ? "no timeout" : `${entry.timeoutSeconds}s`} · ${entry.lifecycle ?? "disposable"}${agents.some(agent => agent.name === entry.name) ? "" : " (missing agent)"}`,
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
			{ id: "model", label: `Set model (${entry.model ?? "default"})` },
			{ id: "timeout", label: `Set timeout (${entry.timeoutSeconds === undefined ? "none" : `${entry.timeoutSeconds}s`})` },
			{ id: "lifecycle", label: `Set lifecycle (${entry.lifecycle ?? "disposable"})` },
			{ id: "remove", label: "Remove subagent" },
			{ id: "back", label: "Back" },
		]);
		if (action === "remove") entries.splice(index, 1);
		if (action === "model") {
			const model = await ctx.ui.input("Model pattern or provider/model ID (blank = default)", entry.model);
			if (model !== undefined) entry.model = model.trim() || undefined;
		}
		if (action === "timeout") {
			const value = await ctx.ui.input("Timeout in seconds (blank = no deadline)", entry.timeoutSeconds?.toString());
			if (value === undefined) continue;
			const timeout = value.trim() ? Number(value) : undefined;
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				ctx.ui.notify("Timeout must be a positive number of seconds.", "warning");
			} else entry.timeoutSeconds = timeout;
		}
		if (action === "lifecycle") {
			const lifecycle = await selectMenu(ctx, `Lifecycle · ${parent} → ${entry.name}`, [
				{ id: "disposable", label: "Disposable (fresh context for every delegation)" },
				{ id: "resumable", label: "Resumable (retain context for this assignment)" },
			]);
			if (lifecycle) entry.lifecycle = lifecycle;
		}
	}
}
