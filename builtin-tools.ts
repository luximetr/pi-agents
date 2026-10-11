import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { compactToolRenderers } from "./tool-render.ts";

const short = (value: unknown) => {
	const text = typeof value === "string" ? value : "";
	const home = homedir();
	return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
};
const first = (value: unknown, max = 100) => {
	const line = typeof value === "string" ? value.trim().split("\n")[0]!.replace(/\s+/g, " ") : "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type Args = Record<string, unknown>;
const BUILTINS: Array<[string, (cwd: string) => ToolDefinition<any, any>, (args: Args) => string]> = [
	["read", createReadToolDefinition, a => `${short(a.path)}${a.offset || a.limit ? `:${a.offset ?? 1}${a.limit ? `-${Number(a.offset ?? 1) + Number(a.limit) - 1}` : ""}` : ""}`],
	["bash", createBashToolDefinition, a => `$ ${first(a.command)}`],
	["edit", createEditToolDefinition, a => short(a.path)],
	["write", createWriteToolDefinition, a => `${short(a.path)}${typeof a.content === "string" ? ` (${a.content.split("\n").length} lines)` : ""}`],
	["grep", createGrepToolDefinition, a => `/${first(a.pattern, 60)}/ in ${short(a.path) || "."}${a.glob ? ` (${a.glob})` : ""}`],
	["find", createFindToolDefinition, a => `${first(a.pattern, 60)} in ${short(a.path) || "."}`],
	["ls", createLsToolDefinition, a => short(a.path) || "."],
];

/**
 * Re-register Pi's built-in tools with compact renderers: one call line, no
 * output unless it failed, full output on expand (Ctrl+O). Everything else
 * (schema, prompt text, execution) comes from Pi's own definitions.
 */
export function registerCompactBuiltins(pi: ExtensionAPI): void {
	for (const [name, create, summarize] of BUILTINS) {
		const base = create(process.cwd());
		const perCwd = new Map<string, ToolDefinition<any, any>>();
		const forCwd = (cwd: string) => perCwd.get(cwd) ?? (perCwd.set(cwd, create(cwd)), perCwd.get(cwd)!);
		pi.registerTool({
			...base,
			execute: (id, params, signal, onUpdate, ctx) => forCwd(ctx.cwd).execute(id, params, signal, onUpdate, ctx),
			...compactToolRenderers(name, args => summarize((args ?? {}) as Args)),
		} as ToolDefinition<any, any>);
	}
}
