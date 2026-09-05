import assert from "node:assert/strict";
import test from "node:test";
import { completeAssistance, draftForAssistance, parseAssistedDraft } from "../studio-assistance.ts";
import { StudioAction, selectMenu } from "../studio-menu.ts";

const draft = { name: "dev", description: "Developer", systemPrompt: "Implement and test changes", color: "#AABBCC", tools: ["read"], mcp: ["dochub"] };
const available = { tools: ["read", "bash"], mcp: ["dochub"] };

test("menu IDs remain stable across label and title changes", async () => {
	const ctx = { ui: { select: async (_title: string, labels: string[]) => labels[0] } } as any;
	for (const label of ["Edit description", "Change summary", "Beschreibung bearbeiten"]) {
		assert.equal(await selectMenu(ctx, "Any title", [{ id: StudioAction.Description, label }]), StudioAction.Description);
	}
	await assert.rejects(selectMenu(ctx, "Duplicate", [{ id: StudioAction.Description, label: "same" }, { id: StudioAction.Prompt, label: "same" }]));
	assert.equal(await selectMenu({ ui: { select: async () => undefined } } as any, "Cancel", [{ id: StudioAction.Apply, label: "Apply" }]), undefined);
});

test("assisted drafts validate names, colors and tool/MCP allowlists; strip executable fields and secrets", () => {
	const result = parseAssistedDraft(JSON.stringify({ ...draft, env: { SECRET: "hidden" }, mcpServers: { secret: {} }, customTools: {} }), available);
	assert.equal(result.color, "#aabbcc");
	assert.ok(!JSON.stringify(result).includes("SECRET"));
	assert.equal(parseAssistedDraft('```json\n' + JSON.stringify(draft) + '\n```', available).name, "dev");
	for (const patch of [{ name: ".." }, { name: "../bad" }, { color: "invalid" }, { tools: ["write"] }, { mcp: ["unknown"] }, { description: "" }, { systemPrompt: "" }]) {
		assert.throws(() => parseAssistedDraft(JSON.stringify({ ...draft, ...patch }), available));
	}
	assert.deepEqual(draftForAssistance({ ...draft, env: { secret: "hidden" }, mcpServers: { private: {} } } as any), draft);
});

test("assistance uses the current model, portable reasoning adapter and resolved auth without tools or active-agent context", async () => {
	const model = { provider: "current-provider", id: "current-model", baseUrl: "old-url" };
	let recorded: any[] = [];
	const ctx = {
		model, thinkingLevel: "high",
		modelRegistry: {
			getProvider: (id: string) => {
				assert.equal(id, model.provider);
				return { streamSimple: (...args: any[]) => {
					recorded = args;
					return { result: async () => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "not output" }, { type: "text", text: "draft" }] }) };
				} };
			},
			getApiKeyAndHeaders: async (selected: any) => {
				assert.equal(selected, model);
				return { ok: true, apiKey: "model-key", headers: { Authorization: "header-key" }, env: { PROVIDER_ENV: "value" }, baseUrl: "resolved-url" };
			},
		},
	} as any;
	const signal = new AbortController().signal;
	assert.equal(await completeAssistance(ctx, "neutral", "user request", signal), "draft");
	assert.equal(recorded[0].id, model.id);
	assert.equal(recorded[0].baseUrl, "resolved-url");
	assert.equal(recorded[1].systemPrompt, "neutral");
	assert.equal(recorded[1].tools, undefined);
	assert.equal(recorded[1].messages.length, 1);
	assert.equal(recorded[2].reasoning, "high");
	assert.equal(recorded[2].apiKey, "model-key");
	assert.equal(recorded[2].signal, signal);
	ctx.thinkingLevel = "off";
	await completeAssistance(ctx, "neutral", "request", signal);
	assert.equal(recorded[2].reasoning, undefined);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(completeAssistance(ctx, "neutral", "request", controller.signal));
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false });
	await assert.rejects(completeAssistance(ctx, "neutral", "request", signal), /authentication/);
});
