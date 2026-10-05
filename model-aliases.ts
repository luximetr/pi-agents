import { randomUUID } from "node:crypto";

/**
 * A named model preset for subagent delegations. The `id` is the stable
 * identity stored in agent files (`model: "@id:<id>"`); the `name` is what
 * people see and type (`@fast`). Renaming an alias never touches agent files
 * because references point at the id, which never changes. The `model` value
 * is used verbatim as today's `--model` argument, thinking-level suffix
 * included.
 */
export interface ModelAlias {
	/** Stable identity: a generated id, or `name:<name>` for hand-written entries. Never changes once created. */
	id: string;
	/** Unique display name: letters, numbers, dot, underscore, hyphen (no spaces). */
	name: string;
	/** Pi model pattern or provider/model ID, used exactly as written. */
	model: string;
}

/** Alias names follow the same rule as agent names (kebab, snake, and camel all fit). */
export function validateModelAliasName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("model alias name may contain only letters, numbers, dot, underscore, and hyphen (no spaces)");
	return name;
}

/** A stable identity for a new alias created in Studio. */
export function newModelAliasId(): string {
	return `m_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Reference forms accepted in a subagent `model` field: `@id:<id>` (written by Studio) or `@<name>` (hand-typed). */
export function parseModelReference(raw: string): { id?: string; name?: string } | undefined {
	if (!raw.startsWith("@")) return undefined;
	const body = raw.slice(1).trim();
	if (!body) return undefined;
	if (body.startsWith("id:")) {
		const id = body.slice(3).trim();
		return id ? { id } : undefined;
	}
	try {
		return { name: validateModelAliasName(body) };
	} catch {
		return undefined;
	}
}

/**
 * Validate + normalize the global `models` table. Entries without an id get a
 * derived `name:<name>` id; both ids and names must be unique. Malformed and
 * duplicate entries are skipped with an error.
 */
export function normalizeModelAliases(raw: unknown): ModelAlias[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		console.error(`pi-agents: "models" must be an array of { id?, name, model }`);
		return undefined;
	}
	const aliases: ModelAlias[] = [];
	const seenNames = new Set<string>();
	const seenIds = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			console.error(`pi-agents: invalid model alias entry — use { id?, name, model }`);
			continue;
		}
		const candidate = entry as { id?: unknown; name?: unknown; model?: unknown };
		let name: string;
		try {
			name = validateModelAliasName(candidate.name);
		} catch {
			console.error(`pi-agents: model alias has an invalid "name" — use letters, numbers, dot, underscore, or hyphen (no spaces)`);
			continue;
		}
		if (seenNames.has(name.toLowerCase())) {
			console.error(`pi-agents: duplicate model alias "${name}" — names must be unique`);
			continue;
		}
		if (typeof candidate.model !== "string" || !candidate.model.trim()) {
			console.error(`pi-agents: model alias "${name}" has an invalid "model"`);
			continue;
		}
		if (candidate.model.trim().startsWith("@")) {
			console.error(`pi-agents: model alias "${name}" must store a plain model ID, not another alias reference`);
			continue;
		}
		const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `name:${name}`;
		if (seenIds.has(id)) {
			console.error(`pi-agents: duplicate model alias id "${id}" — ids must be unique`);
			continue;
		}
		seenNames.add(name.toLowerCase());
		seenIds.add(id);
		aliases.push({ id, name, model: candidate.model.trim() });
	}
	return aliases.length > 0 ? aliases : undefined;
}

export interface ResolvedModel {
	/** The model string to use. Undefined means inherit the parent's model. */
	value?: string;
	/** The raw reference when it names an alias that does not exist. */
	missing?: string;
	/** The alias the reference resolved to, if any. */
	alias?: ModelAlias;
}

/**
 * Resolve a subagent `model` value against the alias table. Bare strings pass
 * through untouched; `@id:` references resolve by stable id, `@name`
 * references by current name. Unknown aliases report `missing` so the caller
 * can warn and inherit the parent model.
 */
export function resolveModelAlias(raw: string | undefined, aliases: readonly ModelAlias[] | undefined): ResolvedModel {
	if (raw === undefined) return {};
	const trimmed = raw.trim();
	if (!trimmed) return {};
	if (!trimmed.startsWith("@")) return { value: trimmed };
	const reference = parseModelReference(trimmed);
	const alias = reference?.id
		? aliases?.find(candidate => candidate.id === reference.id)
		: reference?.name
			? aliases?.find(candidate => candidate.name === reference.name)
			: undefined;
	if (alias) return { value: alias.model, alias };
	return { missing: trimmed };
}

/** Short label for a subagent entry: `@fast → provider/model:level`, a bare model ID, or a missing marker. */
export function formatModelReference(raw: string | undefined, aliases: readonly ModelAlias[] | undefined): string {
	if (raw === undefined || !raw.trim()) return "default model";
	const resolved = resolveModelAlias(raw, aliases);
	if (resolved.alias) return `@${resolved.alias.name} → ${resolved.alias.model}`;
	if (resolved.missing) return `${resolved.missing} (missing)`;
	return resolved.value ?? "default model";
}

/** Thinking-level suffixes Pi accepts on a model selection. */
const THINKING_SUFFIX_SOURCE = "(off|minimal|low|medium|high|xhigh|max)";

/** Resolve for execution: the alias target, a bare model string, or undefined to inherit. Warns once on missing aliases. */
export function resolveExecutionModel(raw: string | undefined, aliases: readonly ModelAlias[] | undefined, warn: (message: string) => void): string | undefined {
	const resolved = resolveModelAlias(raw, aliases);
	if (resolved.missing) {
		// `@fast:high` looks like an alias with a thinking override. Aliases are
		// opaque strings, so the suffix belongs on the stored model instead.
		const base = resolved.missing.match(new RegExp(`^(@[^\\s:]+):${THINKING_SUFFIX_SOURCE}$`));
		const baseAlias = base ? aliases?.find(candidate => candidate.name === base[1].slice(1)) : undefined;
		warn(baseAlias
			? `Model alias ${baseAlias.name} takes its thinking level from its target (${baseAlias.model}); remove the suffix from ${resolved.missing}. Using the parent model instead.`
			: `Unknown model alias ${resolved.missing}; using the parent model instead.`);
	}
	return resolved.value;
}
