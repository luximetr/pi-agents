import assert from "node:assert/strict";
import test from "node:test";
import {
	formatModelReference,
	newModelAliasId,
	normalizeModelAliases,
	parseModelReference,
	resolveExecutionModel,
	resolveModelAlias,
	validateModelAliasName,
} from "../model-aliases.ts";

test("alias names accept kebab, snake, and camel case but reject spaces", () => {
	assert.equal(validateModelAliasName("fast"), "fast");
	assert.equal(validateModelAliasName("code-heavy"), "code-heavy");
	assert.equal(validateModelAliasName("code_heavy"), "code_heavy");
	assert.equal(validateModelAliasName("codeHeavy"), "codeHeavy");
	assert.equal(validateModelAliasName("  fast  "), "fast");
	assert.throws(() => validateModelAliasName("fast model"), /no spaces/);
	assert.throws(() => validateModelAliasName(""), /only letters/);
	assert.throws(() => validateModelAliasName("@fast"), /only letters/);
});

test("references parse @id: and @name forms", () => {
	assert.deepEqual(parseModelReference("@id:m_abc123"), { id: "m_abc123" });
	assert.deepEqual(parseModelReference("@fast"), { name: "fast" });
	assert.deepEqual(parseModelReference("@code-heavy"), { name: "code-heavy" });
	assert.equal(parseModelReference("openai-codex/gpt-6-luna"), undefined);
	assert.equal(parseModelReference("@"), undefined);
	assert.equal(parseModelReference("@id:"), undefined);
	assert.equal(parseModelReference("@has space"), undefined);
});

test("table normalization keeps valid entries, assigns derived ids, and skips bad ones", () => {
	const aliases = normalizeModelAliases([
		{ id: "m_one", name: "fast", model: "test/fast:max" },
		{ name: "strong", model: "  test/strong:high  " },
		{ name: "bad name", model: "test/x" },
		{ name: "empty", model: "  " },
		{ name: "nested", model: "@fast" },
		"not-an-object",
	])!;
	assert.equal(aliases.length, 2);
	assert.deepEqual(aliases[0], { id: "m_one", name: "fast", model: "test/fast:max" });
	assert.deepEqual(aliases[1], { id: "name:strong", name: "strong", model: "test/strong:high" });
	assert.equal(normalizeModelAliases(undefined), undefined);
	assert.equal(normalizeModelAliases({ fast: "test/x" }), undefined);
});

test("duplicate names and ids are dropped, first entry wins", () => {
	const aliases = normalizeModelAliases([
		{ id: "m_one", name: "fast", model: "test/one" },
		{ id: "m_two", name: "Fast", model: "test/two" },
		{ id: "m_one", name: "other", model: "test/three" },
		{ id: "m_three", name: "other", model: "test/four" },
	])!;
	assert.deepEqual(aliases.map(alias => alias.name), ["fast", "other"]);
	assert.equal(aliases[1].model, "test/four");
});

test("generated ids are unique", () => {
	const ids = new Set(Array.from({ length: 50 }, () => newModelAliasId()));
	assert.equal(ids.size, 50);
});

test("resolution passes bare models through and resolves both reference forms", () => {
	const aliases = [
		{ id: "m_one", name: "fast", model: "test/fast:max" },
		{ id: "name:strong", name: "strong", model: "test/strong" },
	];
	assert.deepEqual(resolveModelAlias(undefined, aliases), {});
	assert.deepEqual(resolveModelAlias("test/raw:high", aliases), { value: "test/raw:high" });
	assert.deepEqual(resolveModelAlias("@fast", aliases), { value: "test/fast:max", alias: aliases[0] });
	assert.deepEqual(resolveModelAlias("@id:m_one", aliases), { value: "test/fast:max", alias: aliases[0] });
	// Id references survive renames: the name changed, the id still resolves.
	const renamed = [{ ...aliases[0], name: "quick" }, aliases[1]];
	assert.deepEqual(resolveModelAlias("@id:m_one", renamed), { value: "test/fast:max", alias: renamed[0] });
	assert.deepEqual(resolveModelAlias("@fast", renamed), { missing: "@fast" });
});

test("missing aliases report the raw reference without a value", () => {
	assert.deepEqual(resolveModelAlias("@ghost", []), { missing: "@ghost" });
	assert.deepEqual(resolveModelAlias("@id:nope", undefined), { missing: "@id:nope" });
	assert.deepEqual(resolveModelAlias("@", []), { missing: "@" });
});

test("execution resolution warns on missing aliases and inherits", () => {
	const warnings: string[] = [];
	const aliases = [{ id: "m_one", name: "fast", model: "test/fast:max" }];
	assert.equal(resolveExecutionModel("@fast", aliases, message => warnings.push(message)), "test/fast:max");
	assert.equal(resolveExecutionModel("test/raw", aliases, message => warnings.push(message)), "test/raw");
	assert.equal(resolveExecutionModel(undefined, aliases, message => warnings.push(message)), undefined);
	assert.equal(resolveExecutionModel("@ghost", aliases, message => warnings.push(message)), undefined);
	assert.deepEqual(warnings, ["Unknown model alias @ghost; using the parent model instead."]);
});

test("display labels show the alias target, bare models, and missing markers", () => {
	const aliases = [{ id: "m_one", name: "fast", model: "test/fast:max" }];
	assert.equal(formatModelReference(undefined, aliases), "default model");
	assert.equal(formatModelReference("@fast", aliases), "@fast → test/fast:max");
	assert.equal(formatModelReference("@id:m_one", aliases), "@fast → test/fast:max");
	assert.equal(formatModelReference("test/raw", aliases), "test/raw");
	assert.equal(formatModelReference("@ghost", aliases), "@ghost (missing)");
});
