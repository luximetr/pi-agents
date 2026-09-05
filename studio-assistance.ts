import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseAgentColor, type DeclarativeAgentInput } from "./agents.ts";
import { AgentField } from "./studio-menu.ts";

export interface AssistanceContext {
	tools: string[];
	mcp: string[];
}

// Reference material for the assistant, not another set of UI presets.
const ROLE_GUIDANCE = `Adapt these role patterns only when relevant to the user's request:
- PM: clarify outcomes, users, scope, acceptance criteria, priorities and trade-offs; don't silently implement code.
- Developer: inspect existing code, implement the smallest correct change, test and report concrete results.
- Documentation: verify behavior against sources, update accurate documentation and examples; DocHub may help if available.
- Designer: clarify flows, accessibility, visual consistency and states; DesignHub may help if available.
- Dev lead: decompose work, identify dependencies, review architecture, integration and quality; don't invent delegation targets.
These are suggestions, not mandatory roles. Follow the user's intent, including custom roles.`;

/** Explicit allowlist: never serialize agent.env, MCP definitions/headers, or conversation history. */
export function draftForAssistance(input: DeclarativeAgentInput): DeclarativeAgentInput {
	return {
		name: input.name, description: input.description,
		...(input.color ? { color: input.color } : {}),
		...(input.tools === undefined ? {} : { tools: [...input.tools] }),
		mcp: [...(input.mcp ?? [])], systemPrompt: input.systemPrompt ?? "",
	};
}

export function parseAssistedDraft(text: string, available: AssistanceContext): DeclarativeAgentInput {
	const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object.");
	if (typeof raw.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw.name) || [".", ".."].includes(raw.name)) throw new Error("Use a valid agent name (letters, numbers, dot, underscore, hyphen).");
	if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error("A description is required.");
	if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt.trim()) throw new Error("A system prompt is required.");
	if (raw.color !== undefined && raw.color !== null && !parseAgentColor(raw.color)) throw new Error("Color must be a theme role or #rrggbb (or null for automatic).");
	for (const [key, known] of [["tools", available.tools], ["mcp", available.mcp]] as const) {
		if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some((name: unknown) => typeof name !== "string" || !known.includes(name)))) {
			throw new Error(`${key} must be an array of available names.`);
		}
	}
	return draftForAssistance({
		name: raw.name, description: raw.description.trim(), color: parseAgentColor(raw.color),
		tools: raw.tools === undefined ? undefined : [...new Set<string>(raw.tools)],
		mcp: [...new Set<string>(raw.mcp ?? [])], systemPrompt: raw.systemPrompt,
	});
}

/** Plain, tool-free Pi assistance: use the live provider/auth and its portable reasoning adapter. */
export async function completeAssistance(ctx: ExtensionContext, systemPrompt: string, prompt: string, signal: AbortSignal): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No model selected.");
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error("Selected provider is unavailable.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	signal.throwIfAborted();
	if (!auth.ok) throw new Error("Selected model authentication is unavailable.");
	const response = await provider.streamSimple(
		auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
		{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{
			apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal,
			reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
		},
	).result();
	signal.throwIfAborted();
	if (response.stopReason !== "stop") throw new Error("Assistant response was incomplete. Try again.");
	const text = response.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
	if (!text) throw new Error("Assistant returned no text.");
	return text;
}

async function generate(ctx: ExtensionContext, kind: "agent" | "system prompt" | "description", current: DeclarativeAgentInput, available: AssistanceContext): Promise<string | undefined> {
	if (ctx.mode !== "tui" || !ctx.model) {
		ctx.ui.notify("AI assistance requires TUI mode and a selected model.", "warning");
		return;
	}
	const instruction = await ctx.ui.input(`AI assistance · ${kind}`, kind === "agent" ? "Describe the agent or changes you want" : `What should this ${kind} do or improve?`);
	if (!instruction?.trim()) return;
	const systemPrompt = `You are Pi's neutral agent-authoring assistant, not the agent being edited.
Draft only; do not execute tasks, access files, request secrets, or claim tools have been enabled.
${ROLE_GUIDANCE}
${kind === "agent" ? 'Return only a JSON object with name, description, color (theme role, #rrggbb, or null), tools (array; omit to inherit), mcp (array), systemPrompt. Use only the provided available tool/MCP names. Do not add executable code, MCP definitions, credentials, or delegation.' : `Return only the revised ${kind} as plain text, without a code fence or commentary. Change only this field. ${kind === "description" ? "Write a concise description of the agent's responsibility, not a system prompt." : "Preserve relevant existing instructions unless the user asks to change them."}`} `;
	const prompt = JSON.stringify({ instruction, current: draftForAssistance(current), available });
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Drafting with ${ctx.model!.provider}/${ctx.model!.id} · ${ctx.thinkingLevel ?? "off"}…`);
		let settled = false;
		const finish = (value: string | undefined) => { if (!settled) { settled = true; done(value); } };
		loader.onAbort = () => finish(undefined);
		const signal = AbortSignal.any([loader.signal, AbortSignal.timeout(120_000)]);
		signal.addEventListener("abort", () => {
			if (!settled && !loader.signal.aborted) ctx.ui.notify("AI assistance timed out. Your draft is unchanged.", "error");
			finish(undefined);
		}, { once: true });
		completeAssistance(ctx, systemPrompt, prompt, signal).then(finish).catch(() => {
			if (!settled && !loader.signal.aborted) ctx.ui.notify(signal.aborted ? "AI assistance timed out. Your draft is unchanged." : "AI assistance failed. Check the selected provider/model and authentication; your draft is unchanged.", "error");
			finish(undefined);
		});
		return loader;
	});
}

export async function assistAgentDraft(ctx: ExtensionContext, current: DeclarativeAgentInput, available: AssistanceContext): Promise<DeclarativeAgentInput | undefined> {
	let text = await generate(ctx, "agent", current, available);
	if (text === undefined) return;
	// Always review before accepting. Nothing is written or activated here.
	while (true) {
		const edited = await ctx.ui.editor("Review AI agent draft · JSON (Escape discards)", text);
		if (edited === undefined) return;
		try { return parseAssistedDraft(edited, available); }
		catch (error) {
			ctx.ui.notify(error instanceof SyntaxError ? "Draft must be valid JSON." : (error as Error).message, "warning");
			text = edited;
		}
	}
}

/** Return a suggestion to the field editor, where it remains editable and unsaved. */
export async function assistAgentField(ctx: ExtensionContext, field: AgentField, current: DeclarativeAgentInput, available: AssistanceContext): Promise<string | undefined> {
	return generate(ctx, field === AgentField.Description ? "description" : "system prompt", current, available);
}
