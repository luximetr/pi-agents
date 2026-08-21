import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvFile } from "../agents.ts";
import { jsonSchemaToTypeBox } from "../mcp.ts";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// parseEnvFile

test("env files: parses KEY=VALUE with comments, blanks, and CRLF", () => {
	assert.deepEqual(
		parseEnvFile("# comment\r\n\r\nA=1\r\nB=two words\r\n  # indented comment\n"),
		{ A: "1", B: "two words" },
	);
});

test("env files: strips quotes and export prefixes", () => {
	assert.deepEqual(
		parseEnvFile(`export DOUBLE="quoted value"\nexport SINGLE='single quoted'\nPLAIN=raw`),
		{ DOUBLE: "quoted value", SINGLE: "single quoted", PLAIN: "raw" },
	);
});

test("env files: splits on the first = and keeps = inside values", () => {
	assert.deepEqual(parseEnvFile("CONNECTION=host=db://x?y=1"), { CONNECTION: "host=db://x?y=1" });
});

test("env files: skips malformed lines without a usable key", () => {
	assert.deepEqual(parseEnvFile("no separator\n=forgotten key\nVALID=yes"), { VALID: "yes" });
});

test("env files: empty input yields an empty map", () => {
	assert.deepEqual(parseEnvFile(""), {});
});

// ---------------------------------------------------------------------------
// jsonSchemaToTypeBox

test("schema conversion: primitives", () => {
	assert.deepEqual(jsonSchemaToTypeBox({ type: "string" }), Type.String());
	assert.deepEqual(jsonSchemaToTypeBox({ type: "number" }), Type.Number());
	assert.deepEqual(jsonSchemaToTypeBox({ type: "integer" }), Type.Integer());
	assert.deepEqual(jsonSchemaToTypeBox({ type: "boolean" }), Type.Boolean());
	assert.deepEqual(jsonSchemaToTypeBox({ type: "null" }), Type.Null());
});

test("schema conversion: enums become unions of literals", () => {
	assert.deepEqual(
		jsonSchemaToTypeBox({ type: "string", enum: ["a", "b"] }),
		Type.Union([Type.Literal("a"), Type.Literal("b")]),
	);
	assert.deepEqual(
		jsonSchemaToTypeBox({ enum: [1, 2] }),
		Type.Union([Type.Literal(1), Type.Literal(2)]),
	);
});

test("schema conversion: arrays with and without item schemas", () => {
	assert.deepEqual(jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }), Type.Array(Type.String()));
	assert.deepEqual(jsonSchemaToTypeBox({ type: "array" }), Type.Array(Type.Unknown()));
});

test("schema conversion: objects mark non-required properties optional", () => {
	const converted = jsonSchemaToTypeBox({
		type: "object",
		properties: { required: { type: "string" }, optional: { type: "integer" } },
		required: ["required"],
	});
	assert.deepEqual(
		converted,
		Type.Object({ required: Type.String(), optional: Type.Optional(Type.Integer()) }, { additionalProperties: true }),
	);
});

test("schema conversion: objects stay open unless additionalProperties is false", () => {
	const open = jsonSchemaToTypeBox({ type: "object", properties: {} }) as { additionalProperties?: unknown };
	assert.equal(open.additionalProperties, true);
	const closed = jsonSchemaToTypeBox({ type: "object", additionalProperties: false }) as { additionalProperties?: unknown };
	assert.equal(closed.additionalProperties, false);
});

test("schema conversion: anyOf/oneOf become unions", () => {
	const anyOf = jsonSchemaToTypeBox({ anyOf: [{ type: "string" }, { type: "number" }] });
	assert.deepEqual(anyOf, Type.Union([Type.String(), Type.Number()]));
	const oneOf = jsonSchemaToTypeBox({ oneOf: [{ type: "boolean" }] });
	assert.deepEqual(oneOf, Type.Union([Type.Boolean()]));
});

test("schema conversion: unknown shapes fall back to Type.Unknown", () => {
	assert.deepEqual(jsonSchemaToTypeBox({}), Type.Unknown());
	assert.deepEqual(jsonSchemaToTypeBox({ type: "weird" }), Type.Unknown());
});
