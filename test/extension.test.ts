import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../index.ts";
import { startAuthenticatedMcp } from "./http-mcp-fixture.ts";
import { mcpToolName } from "../mcp.ts";
import { STUDIO_LABELS, StudioAction } from "../studio-menu.ts";
import { editSubagents } from "../studio-subagents.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { discoverAgents, saveAgentOverride, saveAgentSource, saveDeclarativeAgent } from "../agents.ts";

async function makeAgent(root: string, name: string, extra = "") {
	await mkdir(path.join(root, ".pi-agents", name), { recursive: true });
	await writeFile(
		path.join(root, ".pi-agents", name, "agent.ts"),
		`export default { name: ${JSON.stringify(name)}, description: ${JSON.stringify(name)}, tools: ["read"], ${extra} };\n`,
	);
}

function boot(root: string, options?: {
	flag?: string;
	sessionFile?: string;
	trusted?: boolean;
	mode?: string;
	branchEntries?: any[];
	selectAnswers?: Array<string | undefined>;
	editorAnswers?: Array<string | undefined>;
	inputAnswers?: Array<string | undefined>;
	customActions?: Array<(component: any, done: (value: any) => void) => void>;
}) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const activeToolsets: string[][] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses: string[] = [];
	let customComponent: any;
	const tools = new Map<string, any>([
		["read", { name: "read", description: "Read file contents from disk." }],
		["bash", { name: "bash", description: "Execute a shell command." }],
		["powershell", { name: "powershell", description: "Execute PowerShell commands." }],
		["delegate", { name: "delegate", description: "Delegate work to a child agent." }],
	]);
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerEntryRenderer: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getFlag: () => options?.flag,
		getThinkingLevel: () => "high",
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...(activeToolsets.at(-1) ?? ["read", "bash"])],
		setActiveTools: (names: string[]) => activeToolsets.push([...names]),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	extension(pi);
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text, getColorMode: () => "truecolor" };
	const ctx: any = {
		cwd: root,
		mode: options?.mode,
		isProjectTrusted: () => options?.trusted ?? true,
		sessionManager: {
			getSessionFile: () => options?.sessionFile,
			getBranch: () => options?.branchEntries ?? [],
			getEntries: () => options?.branchEntries ?? [],
		},
		ui: {
			theme,
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: (message: string, level: string) => notifications.push({ message, level }),
			select: async () => options?.selectAnswers?.shift(),
			confirm: async () => true,
			editor: async () => options?.editorAnswers?.shift(),
			input: async () => options?.inputAnswers?.shift(),
			custom: async (factory: any) => {
				let finish!: (value: any) => void;
				const completion = new Promise<any>((resolve) => { finish = resolve; });
				customComponent = factory({ requestRender: () => {}, terminal: { rows: 40, columns: 120 } }, theme, {}, finish);
				if (customComponent.signal) {
					const loader = customComponent;
					return completion.finally(() => loader.dispose());
				}
				const action = options?.customActions?.shift();
				if (!action) return null;
				action(customComponent, finish);
				return completion;
			},
		},
	};
	return { pi, handlers, commands, activeToolsets, notifications, entries, tools, statuses, getCustomComponent: () => customComponent, ctx };
}

test("dashboard reorder and whole-folder deletion take effect without reload", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-manage-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "alpha", ".env"), "SECRET=keep\n");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ custom: "preserved" }));
		const runtime = boot(root, {
			selectAnswers: ["2 · beta", "Project (commit with this repository)"],
			customActions: [(component) => component.handleInput("r")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const saved = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.deepEqual(saved.agentOrder, ["beta", "alpha"]);
		assert.equal(saved.custom, "preserved");
		assert.deepEqual((await discoverAgents(root)).agents.filter(a => ["alpha", "beta"].includes(a.name)).map(a => a.name), ["beta", "alpha"]);

		const originalCustom = runtime.ctx.ui.custom;
		runtime.ctx.ui.custom = async (factory: any) => {
			let selected: unknown;
			const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, (value: unknown) => { selected = value; });
			component.handleInput("\x1b[A");
			component.handleInput("\r");
			assert.equal(selected, "beta", "reordered list is live without restarting the session");
			return null;
		};
		await runtime.commands.get("agent").handler("", runtime.ctx);
		let confirmed = false;
		runtime.ctx.ui.confirm = async (_title: string, message: string) => {
			assert.match(message, /ALL its contents/);
			assert.match(message, /credentials/);
			return confirmed;
		};
		let sendDelete = true;
		runtime.ctx.ui.custom = async (factory: any) => {
			if (!sendDelete) return null;
			sendDelete = false;
			return new Promise(resolve => {
				const component = factory({ requestRender() {} }, runtime.ctx.ui.theme, {}, resolve);
				component.handleInput("\x1b[3~");
			});
		};
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"));
		confirmed = true;
		sendDelete = true;
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await assert.rejects(readFile(path.join(root, ".pi-agents", "alpha", "agent.ts")), { code: "ENOENT" });
		await assert.rejects(readFile(path.join(root, ".pi-agents", "alpha", ".env")), { code: "ENOENT" });
		await readFile(path.join(root, ".pi-agents", "beta", "agent.ts"));
		await runtime.commands.get("agent").handler("alpha", runtime.ctx);
		assert.ok(runtime.notifications.some(item => /Unknown agent/.test(item.message)), "deleted agent is unavailable immediately");
		assert.deepEqual(runtime.activeToolsets.at(-1), ["read", "bash"]);
		runtime.ctx.ui.custom = originalCustom;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deleting a standalone agent preserves the shared agents directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delete-file-"));
	try {
		await makeAgent(root, "beta");
		const file = path.join(root, ".pi-agents", "agent.ts");
		await writeFile(file, 'export default { name: "standalone", description: "Standalone", default: true };');
		const runtime = boot(root, { customActions: [component => component.handleInput("\x04")] });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await assert.rejects(readFile(file), { code: "ENOENT" });
		await readFile(path.join(root, ".pi-agents", "beta", "agent.ts"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Studio credential saves reconnect a real authenticated HTTP MCP without reload", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-auth-e2e-"));
	const server = await startAuthenticatedMcp();
	const selectAnswers: Array<string | undefined> = [];
	const customActions: Array<(component: any, done: (value: any) => void) => void> = [];
	const runtime = boot(root, {
		mode: "tui", selectAnswers, customActions,
		branchEntries: [{ type: "custom", customType: "pi-agents-studio-state", data: {
			name: "alpha", override: { systemPrompt: "Keep this session draft" },
		} }],
	});
	const toolName = mcpToolName("authenticated", "echo");
	try {
		await makeAgent(root, "alpha", 'default: true, tools: undefined, mcp: ["authenticated"]');
		await makeAgent(root, "beta", 'mcp: ["authenticated"]');
		const configFile = path.join(root, ".pi-agents", "config.json");
		await writeFile(configFile, JSON.stringify({ mcpServers: { authenticated: {
			url: server.url, headers: { Authorization: "Bearer ${PI_AGENTS_E2E_SECRET}" },
		} } }));
		const originalConfig = await readFile(configFile, "utf8");
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		async function save(value: string, cancel = false) {
			selectAnswers.push("Manage MCP servers (1)", "Back without applying");
			customActions.push(
				component => component.handleInput("e"),
				component => {
					const details = component.render(120).join("\n");
					assert.match(details, /authenticated/);
					assert.match(details, /Disable server/);
					assert.match(details, /Manage credentials/);
					assert.match(details, /Test connection/);
					component.handleInput("\r"); // selected server settings
					component.handleInput("\r"); // disable
					assert.match(component.render(120).join("\n"), /Enable server/);
					component.handleInput("\r"); // restore draft assignment
					component.handleInput("\x1b[B"); // credentials
					component.handleInput("\r");
				},
				component => {
					component.handleInput(`\x1b[200~${value}\x1b[201~`);
					assert.ok(!component.render(80).join("\n").includes(value));
					component.handleInput(cancel ? "\x1b" : "\r");
				},
				component => {
					assert.match(component.render(120).join("\n"), /› Manage credentials/);
					component.handleInput("\x1b");
					component.handleInput("\x1b");
				},
				component => component.handleInput("\x1b"),
			);
			await runtime.commands.get("agent").handler("", runtime.ctx);
		}
		async function testConnection(expected: RegExp) {
			const toolsBefore = [...runtime.tools.keys()];
			const activeBefore = [...runtime.activeToolsets.at(-1)!];
			const entriesBefore = runtime.entries.length;
			const notificationsBefore = runtime.notifications.length;
			selectAnswers.push("Manage MCP servers (1)", "Back without applying");
			customActions.push(
				component => component.handleInput("e"),
				component => {
					component.handleInput("\r");
					component.handleInput("\x1b[B");
					component.handleInput("\x1b[B");
					component.handleInput("\r");
				},
				component => {
					const details = component.render(160).join(" ").replace(/\s+/g, " ");
					assert.match(details, expected);
					assert.match(details, /› Test connection/);
					component.handleInput("\x1b");
					component.handleInput("\x1b");
				},
				component => component.handleInput("\x1b"),
			);
			await runtime.commands.get("agent").handler("", runtime.ctx);
			assert.ok(runtime.notifications.slice(notificationsBefore).some(entry => expected.test(entry.message)));
			assert.deepEqual([...runtime.tools.keys()], toolsBefore);
			assert.deepEqual(runtime.activeToolsets.at(-1), activeBefore);
			assert.equal(runtime.entries.length, entriesBefore);
		}
		await testConnection(/Missing credentials/);
		async function call() {
			const result = await runtime.tools.get(toolName).execute("test-call", {}, new AbortController().signal, undefined, runtime.ctx);
			assert.equal(result.content[0].text, "authenticated");
		}
		await save("first-token");
		await testConnection(/connection successful; 1 tools discovered/);
		assert.ok(runtime.activeToolsets.at(-1)?.includes(toolName));
		await call();
		assert.ok(server.requests.some(request => request.method === "tools/call" && request.authorization === "Bearer first-token"));
		const beforeCancel = server.requests.length;
		await save("cancelled-token", true);
		assert.equal(server.requests.length, beforeCancel);
		assert.ok(!(await readFile(path.join(root, ".pi-agents", "alpha", ".env"), "utf8")).includes("cancelled-token"));
		server.setToken("rotated-token");
		await save("rotated-token");
		await call();
		assert.ok(server.requests.some(request => request.method === "tools/call" && request.authorization === "Bearer rotated-token"));
		await save("wrong-token");
		await testConnection(/Connection or tool discovery failed/);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		assert.ok(runtime.notifications.some(entry => entry.level === "error" && /failed to start/.test(entry.message)));
		await save("rotated-token");
		await call();
		assert.equal(await readFile(configFile, "utf8"), originalConfig);
		await assert.rejects(readFile(path.join(root, ".pi-agents", ".env")), { code: "ENOENT" });
		const beforeSwitch = server.requests.length;
		await runtime.commands.get("agent").handler("beta", runtime.ctx);
		assert.ok(!runtime.activeToolsets.at(-1)?.includes(toolName));
		const betaRequests = server.requests.slice(beforeSwitch).filter(request => request.method === "initialize");
		assert.ok(betaRequests.length > 0);
		assert.ok(betaRequests.every(request => request.authorization !== "Bearer rotated-token"));
		await assert.rejects(readFile(path.join(root, ".pi-agents", "beta", ".env")), { code: "ENOENT" });
		await runtime.commands.get("agent").handler("alpha", runtime.ctx);
		await call();
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Keep this session draft/);
		const history = JSON.stringify({ entries: runtime.entries, notifications: runtime.notifications });
		for (const secret of ["first-token", "rotated-token", "wrong-token", "cancelled-token"]) assert.ok(!history.includes(secret));
	} finally {
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Studio sets a startup default without activating or discarding edits", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-default-ui-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		const runtime = boot(root, {
			selectAnswers: ["Set as default agent", "Project (commit with this repository)", "Back without applying"],
			customActions: [(_component, done) => done({ action: "edit", agent: "beta" })],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.equal((await discoverAgents(root)).config.defaultAgent, "beta");
		assert.equal((runtime.entries.at(-1)?.data as any).name, "alpha");
		const fresh = boot(root);
		await fresh.handlers.get("session_start")?.({ reason: "startup" }, fresh.ctx);
		assert.equal((fresh.entries.at(-1)?.data as any).name, "beta");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("/new inherits agent, model, reasoning and drafts across extension replacement only once", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-new-settings-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await makeAgent(root, "beta");
		const old = boot(root, { branchEntries: [{ type: "custom", customType: "pi-agents-studio-state", data: { name: "beta", override: { systemPrompt: "Unsaved prompt" } } }] });
		old.ctx.model = { provider: "test", id: "chosen" };
		await old.handlers.get("session_start")?.({ reason: "startup" }, old.ctx);
		await old.commands.get("agent").handler("beta", old.ctx);
		await old.handlers.get("session_shutdown")?.({ reason: "new" }, old.ctx);
		const next = boot(root, { flag: "alpha" });
		const changes: unknown[] = [];
		next.ctx.modelRegistry = { find: (provider: string, id: string) => ({ provider, id }) };
		next.pi.setModel = async (model: unknown) => { changes.push(model); return true; };
		next.pi.setThinkingLevel = (level: string) => changes.push(level);
		await next.handlers.get("session_start")?.({ reason: "new" }, next.ctx);
		assert.deepEqual(changes, [{ provider: "test", id: "chosen" }, "high"]);
		assert.equal((next.entries.find(entry => entry.customType === "pi-agents-state")?.data as any).name, "beta");
		assert.equal((next.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any).override.systemPrompt, "Unsaved prompt");
		const fresh = boot(root);
		await fresh.handlers.get("session_start")?.({ reason: "startup" }, fresh.ctx);
		assert.equal((fresh.entries.at(-1)?.data as any).name, "alpha");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("subagent editor validates timeouts and cancels without mutating existing settings", async () => {
	const current = [{ name: "missing", model: "old/model", timeoutSeconds: 20 }];
	const runtime = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s · disposable (missing agent)", "Set timeout (20s)", "Done"],
		inputAnswers: ["-1"],
	});
	assert.deepEqual(await editSubagents(runtime.ctx, "parent", [], current), current);
	assert.ok(runtime.notifications.some(item => item.message.includes("positive number")));
	const cancelled = boot("/tmp", {
		selectAnswers: ["1 · missing · old/model · 20s · disposable (missing agent)", "Remove subagent", undefined],
	});
	assert.equal(await editSubagents(cancelled.ctx, "parent", [], current), undefined);
	assert.equal(current.length, 1);

	const lifecycle = boot("/tmp", {
		selectAnswers: ["1 · child · default model · no timeout · disposable (missing agent)", "Set lifecycle (disposable)", "Resumable (retain context for this assignment)", "Done"],
	});
	assert.deepEqual(await editSubagents(lifecycle.ctx, "parent", [], [{ name: "child" }]), [{ name: "child", lifecycle: "resumable" }]);
});

test("Studio adds configured subagents, restores drafts, and saves an empty delegation list", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-subagents-"));
	try {
		await makeAgent(root, "alpha", "default: true, tools: undefined");
		await makeAgent(root, "beta");
		const runtime = boot(root, {
			selectAnswers: ["Manage subagents (0)", "Add subagent", "beta · beta", "1 · beta · default model · no timeout · disposable", "Set model (default)", "1 · beta · test/model · no timeout · disposable", "Set timeout (none)", "1 · beta · test/model · 30s · disposable", "Set lifecycle (disposable)", "Resumable (retain context for this assignment)", "Done", "Apply as session draft"],
			inputAnswers: ["test/model", "30"],
			customActions: [component => component.handleInput("e")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.ok(runtime.activeToolsets.at(-1)?.includes("delegate"));
		const draft = runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")!;
		assert.deepEqual((draft.data as any).override.subagents, [{ name: "beta", model: "test/model", timeoutSeconds: 30, lifecycle: "resumable" }]);
		saveAgentOverride(root, "project", "alpha", (draft.data as any).override);
		assert.deepEqual((await discoverAgents(root)).agents.find(agent => agent.name === "alpha")?.subagents, (draft.data as any).override.subagents);
		const restored = boot(root, {
			branchEntries: [{ type: "custom", ...draft }],
			selectAnswers: ["Manage subagents (1)", "1 · beta · test/model · 30s · resumable", "Remove subagent", "Done", "Save agent.ts (project)"],
			customActions: [component => component.handleInput("e")],
		});
		await restored.handlers.get("session_start")?.({ reason: "startup" }, restored.ctx);
		assert.ok(restored.activeToolsets.at(-1)?.includes("delegate"));
		await restored.commands.get("agent").handler("", restored.ctx);
		assert.ok(!restored.activeToolsets.at(-1)?.includes("delegate"));
		assert.match(await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8"), /subagents: \[\]/);
		const savedConfig = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(savedConfig.agentOverrides, undefined);
		assert.deepEqual((await discoverAgents(root)).agents.find(agent => agent.name === "alpha")?.subagents ?? [], []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio routes renamed labels by ID and persists description and color overrides", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ids-"));
	const oldLabel = STUDIO_LABELS[StudioAction.Description];
	STUDIO_LABELS[StudioAction.Description] = "Change agent summary";
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, {
			selectAnswers: ["Change agent summary", "Color (automatic)", "Custom hex/theme role", "Save agent.ts (project)"],
			inputAnswers: ["invalid-color", "#ABCDEF"], editorAnswers: ["Refined responsibility"],
			customActions: [component => component.handleInput("e"), component => component.handleInput("\x1b")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const discovered = await discoverAgents(root);
		assert.equal(discovered.agents.find(agent => agent.name === "alpha")?.description, "Refined responsibility");
		assert.equal(discovered.agents.find(agent => agent.name === "alpha")?.color, "#abcdef");
		assert.ok(runtime.notifications.some(entry => /six-digit hex/.test(entry.message)));
	} finally {
		STUDIO_LABELS[StudioAction.Description] = oldLabel;
		await rm(root, { recursive: true, force: true });
	}
});

function enableStudioAI(runtime: ReturnType<typeof boot>, response: string) {
	const requests: any[] = [];
	runtime.ctx.model = { provider: "studio-test", id: "selected-model" };
	runtime.ctx.thinkingLevel = "high";
	runtime.ctx.modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "provider-secret" }),
		getProvider: () => ({ streamSimple: (model: any, context: any, options: any) => {
			requests.push({ model, context, options });
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: response }] }) };
		} }),
	};
	return requests;
}

test("Studio creates a reviewed AI draft with color using the selected model and reasoning", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ai-create-"));
	const generated = { name: "planner", description: "Plan outcomes", color: "#ff9f0a", tools: ["read"], mcp: [], systemPrompt: "Clarify scope and acceptance criteria." };
	try {
		const runtime = boot(root, {
			mode: "tui",
			selectAnswers: ["Project (commit with this repository)", "Describe with AI", "Orange (#ff9f0a)", "Back without applying"],
			inputAnswers: ["Create a PM who clarifies product scope"],
			editorAnswers: [JSON.stringify({ ...generated, description: "Reviewed product planner" })],
			customActions: [component => component.handleInput("n"), component => component.handleInput("\x1b")],
		});
		const requests = enableStudioAI(runtime, JSON.stringify(generated));
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const saved = JSON.parse(await readFile(path.join(root, ".pi-agents", "planner", "agent.json"), "utf8"));
		assert.equal(saved.description, "Reviewed product planner");
		assert.equal(saved.color, generated.color);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].model.id, "selected-model");
		assert.equal(requests[0].options.reasoning, "high");
		assert.match(requests[0].context.systemPrompt, /PM: clarify outcomes/);
		assert.ok(!JSON.stringify(runtime.entries).includes("planner")); // no activation
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio AI prompt help reviews a draft without exposing credentials or changing other fields", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ai-edit-"));
	try {
		await makeAgent(root, "alpha", 'default: true, color: "#4cc2ff", systemPrompt: "Original prompt"');
		await writeFile(path.join(root, ".pi-agents", "alpha", ".env"), "DOCHUB_TOKEN=private-agent-secret\n");
		const source = await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8");
		const runtime = boot(root, {
			mode: "tui", selectAnswers: ["Edit prompt (1 lines)", "Apply as session draft"],
			inputAnswers: ["Make the prompt test-driven"],
			customActions: [
				component => component.handleInput("e"),
				component => {
					assert.match(component.render(120).join("\n"), /F2 AI assistance/);
					component.handleInput(" plus manual changes");
					component.handleInput("\x1bOQ"); // F2: assist this field
				},
				component => {
					assert.match(component.render(120).join("\n"), /Proposed: test first/);
					component.handleInput("\x15"); // Ctrl+U: edit the suggestion before accepting
					component.handleInput("Reviewed: write tests first.");
					component.handleInput("\r");
				},
				component => component.handleInput("\x1b"),
			],
		});
		const requests = enableStudioAI(runtime, "Proposed: test first.");
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Reviewed: write tests first/);
		assert.ok(!JSON.stringify(requests[0].context).includes("private-agent-secret"));
		assert.match(requests[0].context.messages[0].content[0].text, /Original prompt plus manual changes/);
		assert.equal(await readFile(path.join(root, ".pi-agents", "alpha", "agent.ts"), "utf8"), source);
		const savedDraft = runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any;
		assert.equal(savedDraft.override.color, "#4cc2ff");
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ["save", "undo", "cancel", "cancel-request", "failure"] as const) {
	test(`description editor keeps AI assistance field-local (${outcome})`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-description-assist-"));
		try {
			await makeAgent(root, "alpha", 'default: true, systemPrompt: "Do not change this prompt"');
			const runtime = boot(root, {
				mode: "tui", selectAnswers: ["Edit description", "Apply as session draft"],
				inputAnswers: [outcome === "cancel-request" ? undefined : "Make the description concise"],
				customActions: [
					component => component.handleInput("e"),
					component => {
						assert.match(component.render(120).join("\n"), /Description · alpha/);
						component.handleInput(" manual edit");
						component.handleInput("\x1bOQ");
					},
					component => {
						assert.match(component.render(120).join("\n"), outcome === "cancel-request" || outcome === "failure" ? /alpha manual edit/ : /Suggested responsibility/);
						if (outcome === "undo") {
							component.handleInput("\x1bOR"); // F3: restore the pre-AI manual draft
							assert.match(component.render(120).join("\n"), /alpha manual edit/);
						}
						component.handleInput(outcome === "cancel" ? "\x1b" : "\r");
					},
					component => component.handleInput("\x1b"),
				],
			});
			const requests = enableStudioAI(runtime, "Suggested responsibility");
			if (outcome === "failure") runtime.ctx.modelRegistry.getProvider = () => ({ streamSimple: () => ({ result: async () => { throw new Error("private provider error"); } }) });
			await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
			await runtime.commands.get("agent").handler("", runtime.ctx);
			const override = (runtime.entries.find(entry => entry.customType === "pi-agents-studio-state")?.data as any).override;
			assert.equal(override.description, outcome === "save" ? "Suggested responsibility" : outcome === "cancel" ? "alpha" : "alpha manual edit");
			assert.equal(override.systemPrompt, "Do not change this prompt");
			if (requests.length) {
				assert.match(requests[0].context.systemPrompt, /revised description/);
				assert.match(requests[0].context.messages[0].content[0].text, /alpha manual edit/);
			}
			if (outcome === "cancel-request") assert.equal(requests.length, 0);
			assert.ok(!JSON.stringify(runtime.notifications).includes("private provider error"));
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

test("cancelling AI draft review does not create an agent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-ai-cancel-"));
	try {
		const runtime = boot(root, {
			mode: "tui", selectAnswers: ["Project (commit with this repository)", "Describe with AI"],
			inputAnswers: ["Create a developer"], editorAnswers: [undefined],
			customActions: [component => component.handleInput("n"), component => component.handleInput("\x1b")],
		});
		enableStudioAI(runtime, JSON.stringify({ name: "dev", description: "Developer", systemPrompt: "Test changes" }));
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		await assert.rejects(readFile(path.join(root, ".pi-agents", "dev", "agent.json")), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("session startup activates config.defaultAgent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-default-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["read"]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "beta" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("--agent takes precedence over the configured default", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-flag-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root, { flag: "alpha" });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "alpha" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a persisted plain-pi selection suppresses configured defaults", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-persisted-none-"));
	try {
		await makeAgent(root, "alpha");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "alpha" }));
		const sessionFile = path.join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: "pi-agents-state", data: { name: null } })}\n`);
		const runtime = boot(root, { sessionFile });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, []);
		assert.deepEqual(runtime.entries, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("untrusted projects do not load or activate project agents", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-untrusted-runtime-"));
	try {
		await makeAgent(root, "project-agent", "default: true");
		const runtime = boot(root, { trusted: false });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, []);
		assert.ok(runtime.notifications.some((entry) => entry.level === "warning" && /not trusted/.test(entry.message)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent custom tools are registered, activated, and wrap string results", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-custom-tool-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "custom"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "custom", "agent.ts"), `
			export default {
				name: "custom", description: "custom", default: true, tools: [],
				customTools: {
					ping: { description: "Return a pong", execute: async (args) => "pong:" + args.value }
				}
			};
		`);
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["ping"]);
		const result = await runtime.tools.get("ping").execute("ping-1", { value: "ok" }, undefined, undefined, runtime.ctx);
		assert.deepEqual(result, { content: [{ type: "text", text: "pong:ok" }], details: {} });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parent prompts name allowed subagents and their runtime settings", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-delegation-prompt-"));
	try {
		await makeAgent(root, "lead", 'default: true, subagents: [{ name: "worker", model: "test/worker", timeoutSeconds: 90, lifecycle: "resumable" }]');
		await makeAgent(root, "worker");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const result = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(result.systemPrompt, /allowed subagents/);
		assert.match(result.systemPrompt, /worker: worker \(model test\/worker, 90s deadline, resumable lifecycle\)/);
		assert.match(result.systemPrompt, /independent delegate calls together/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/agent none restores the toolset captured before activation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-clear-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("none", runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, [["read"], ["read", "bash"]]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: null } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("startup shows a concise project summary and capability-rich footer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-orientation-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, { mode: "tui" });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.ok(runtime.notifications.some((entry) => entry.message.includes("1 project + 0 global agents · alpha active")));
		assert.match(runtime.statuses.at(-1) ?? "", /agent:alpha/);
		assert.match(runtime.statuses.at(-1) ?? "", /· 1 tool/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio applies a live session prompt draft without rewriting agent.ts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-live-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const sourcePath = path.join(root, ".pi-agents", "alpha", "agent.ts");
		const sourceBefore = await readFile(sourcePath, "utf8");
		const runtime = boot(root, {
			selectAnswers: ["Edit prompt (empty)", "Apply as session draft"],
			editorAnswers: ["You are an experimental browser verifier."],
			customActions: [
				(component, _done) => component.handleInput("e"),
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /experimental browser verifier/);
		assert.ok(runtime.entries.some((entry) => entry.customType === "pi-agents-studio-state"));
		assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("session startup restores Agent Studio tool and prompt drafts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-restore-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root, {
			branchEntries: [{
				type: "custom",
				customType: "pi-agents-studio-state",
				data: { name: "alpha", override: { tools: ["bash"], mcp: [], systemPrompt: "Restored draft prompt" } },
			}],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["bash"]);
		const prompt = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(prompt.systemPrompt, /Restored draft prompt/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio creates an agent from the empty dashboard", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-empty-create-"));
	try {
		const runtime = boot(root, {
			selectAnswers: ["Project (commit with this repository)", "Create manually", "Purple (#bf5af2)", "Back without applying"],
			inputAnswers: ["new-agent"],
			editorAnswers: ["Experiments with project tools", "Use the available tools carefully."],
			customActions: [
				(component, _done) => component.handleInput("n"),
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const created = JSON.parse(await readFile(path.join(root, ".pi-agents", "new-agent", "agent.json"), "utf8"));
		assert.equal(created.description, "Experiments with project tools");
		assert.equal(created.color, "#bf5af2");
		assert.equal(created.systemPrompt, "Use the available tools carefully.");
		assert.ok(runtime.notifications.some((entry) => /Created agent "new-agent"/.test(entry.message)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio can create and discover a declarative JSON agent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-create-"));
	try {
		const filePath = saveDeclarativeAgent(root, "project", {
			name: "browser-verifier",
			description: "Checks browser behavior",
			tools: ["read"],
			mcp: ["playwright"],
			systemPrompt: "Verify the running application.",
		});
		assert.match(filePath, /browser-verifier\/agent\.json$/);
		const discovered = await discoverAgents(root);
		const agent = discovered.agents.find((candidate) => candidate.name === "browser-verifier");
		assert.equal(agent?.description, "Checks browser behavior");
		assert.deepEqual(agent?.tools, ["read"]);
		assert.deepEqual(agent?.mcp, ["playwright"]);
		assert.equal(agent?.systemPrompt, "Verify the running application.");
		await assert.rejects(async () => saveDeclarativeAgent(root, "project", {
			name: "browser-verifier", description: "duplicate",
		}), /already exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("direct JSON saves preserve metadata and update a referenced prompt file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-json-prompt-"));
	try {
		const filePath = saveDeclarativeAgent(root, "project", { name: "alpha", description: "source" });
		const promptPath = path.join(path.dirname(filePath), "prompt.md");
		await writeFile(promptPath, "Source prompt\n");
		await writeFile(filePath, JSON.stringify({
			name: "alpha", description: "source", lifecycle: "legacy-value", whenToUse: "Keep this metadata", systemPromptFile: "./prompt.md",
		}, null, "\t"));
		const agent = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		saveAgentSource(agent, { description: "updated", color: null, mcp: [], systemPrompt: "Updated prompt\n" });
		const source = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(source.description, "updated");
		assert.equal(source.lifecycle, "legacy-value");
		assert.equal(source.whenToUse, "Keep this metadata");
		assert.equal(source.systemPromptFile, "./prompt.md");
		assert.equal(source.systemPrompt, undefined);
		assert.equal(await readFile(promptPath, "utf8"), "Updated prompt\n");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct TypeScript saves update the static agent object and its prompt file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-ts-source-"));
	try {
		const dir = path.join(root, ".pi-agents", "alpha");
		await mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "agent.ts");
		const promptPath = path.join(dir, "prompt.md");
		await writeFile(promptPath, "Source prompt\n");
		await writeFile(filePath, `const cfg = {
	name: "alpha",
	// This executable field and comment must survive Studio saves.
	description: "source",
	lifecycle: "legacy-value",
	color: "#ffffff",
	tools: ["read"],
	customTools: { ping: { description: "Ping", execute: () => "pong" } },
	systemPromptFile: "./prompt.md",
};
export default cfg;
`);
		const agent = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		saveAgentSource(agent, {
			description: "updated", color: null, tools: ["read", "grep"], mcp: ["playwright"],
			subagents: [{ name: "beta", model: "openai-codex/gpt-5.3-codex-spark:high", lifecycle: "disposable" }], systemPrompt: "Updated prompt\n",
		});
		const source = await readFile(filePath, "utf8");
		assert.match(source, /description: "updated"/);
		assert.match(source, /lifecycle: "legacy-value"/);
		assert.doesNotMatch(source, /color:/);
		assert.match(source, /tools: \["read","grep"\]/);
		assert.match(source, /subagents: \[\{ name: "beta", model: "openai-codex\/gpt-5.3-codex-spark:high", lifecycle: "disposable" \}\]/);
		assert.match(source, /customTools: \{ ping:/);
		assert.match(source, /This executable field and comment must survive/);
		assert.match(source, /systemPromptFile: "\.\/prompt\.md"/);
		assert.equal(await readFile(promptPath, "utf8"), "Updated prompt\n");
		const updated = (await discoverAgents(root)).agents.find(candidate => candidate.name === "alpha")!;
		assert.equal(updated.description, "updated");
		assert.equal("lifecycle" in updated, false);
		assert.deepEqual(updated.tools, ["read", "grep"]);
		assert.equal(updated.subagents?.[0]?.model, "openai-codex/gpt-5.3-codex-spark:high");
		assert.equal(updated.subagents?.[0]?.lifecycle, "disposable");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Studio saves JSON-backed agent edits to agent.json and removes saved overlays", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-json-save-"));
	try {
		const filePath = saveDeclarativeAgent(root, "project", {
			name: "alpha", description: "source description", tools: ["read"], mcp: [], systemPrompt: "Source prompt",
		});
		saveDeclarativeAgent(root, "project", { name: "beta", description: "beta", tools: ["read"] });
		saveAgentOverride(root, "project", "alpha", { description: "saved description" });
		const runtime = boot(root, {
			flag: "alpha",
			selectAnswers: [
				"Manage subagents (0)", "Add subagent", "beta · beta",
				"1 · beta · default model · no timeout · disposable", "Set model (default)", "Done",
				"Save agent.json (project)",
			],
			inputAnswers: ["openai-codex/gpt-5.3-codex-spark:high"],
			customActions: [component => component.handleInput("e")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);

		const source = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(source.description, "saved description");
		assert.deepEqual(source.subagents, [{ name: "beta", model: "openai-codex/gpt-5.3-codex-spark:high" }]);
		const config = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(config.agentOverrides, undefined);
		const alpha = (await discoverAgents(root)).agents.find(agent => agent.name === "alpha");
		assert.equal(alpha?.subagents?.[0]?.name, "beta");
		assert.equal(alpha?.subagents?.[0]?.model, "openai-codex/gpt-5.3-codex-spark:high");
		assert.equal(alpha?.savedOverrideSources, undefined);
		assert.ok(runtime.notifications.some(entry => entry.message.includes(filePath)));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("dynamic TypeScript definitions keep explicit config override saves", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-dynamic-ts-"));
	try {
		const dir = path.join(root, ".pi-agents", "dynamic");
		await mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "agent.ts");
		await writeFile(filePath, `export default () => ({ name: "dynamic", description: "source", tools: ["read"] });\n`);
		const runtime = boot(root, {
			flag: "dynamic",
			selectAnswers: ["Edit description", "Save project override (.pi-agents/config.json)"],
			editorAnswers: ["overridden"],
			customActions: [component => component.handleInput("e")],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.match(await readFile(filePath, "utf8"), /description: "source"/);
		const config = JSON.parse(await readFile(path.join(root, ".pi-agents", "config.json"), "utf8"));
		assert.equal(config.agentOverrides.dynamic.description, "overridden");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("project Studio overrides preserve config and expose curated MCP recipes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-save-"));
	try {
		await makeAgent(root, "alpha", "default: true, systemPrompt: \"source prompt\"");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			defaultAgent: "alpha",
			mcpServers: { custom: { command: "custom-mcp" } },
		}));
		const configPath = saveAgentOverride(root, "project", "alpha", {
			tools: ["read", "grep"],
			mcp: ["playwright"],
			systemPrompt: "saved Studio prompt",
		});
		const raw = JSON.parse(await readFile(configPath, "utf8"));
		assert.equal(raw.defaultAgent, "alpha");
		assert.equal(raw.mcpServers.custom.command, "custom-mcp");
		assert.deepEqual(raw.agentOverrides.alpha.mcp, ["playwright"]);

		const discovered = await discoverAgents(root);
		const alpha = discovered.agents.find((agent) => agent.name === "alpha");
		assert.deepEqual(alpha?.tools, ["read", "grep"]);
		assert.deepEqual(alpha?.mcp, ["playwright"]);
		assert.equal(alpha?.systemPrompt, "saved Studio prompt");
		assert.equal(alpha?.systemPromptPath, undefined);
		assert.deepEqual(alpha?.savedOverrideSources, ["project"]);
		assert.equal(discovered.config.mcpServerSources?.playwright, "builtin");
		assert.deepEqual(discovered.config.mcpServers?.playwright.args, ["-y", "@playwright/mcp@0.0.80"]);
		assert.equal(discovered.config.mcpServers?.["pen.dev"].command, "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64");
		assert.deepEqual(discovered.config.mcpServers?.dochub, {
			url: "http://localhost:3001/mcp",
			headers: { Authorization: "Bearer ${DOCHUB_TOKEN}" },
		});
		assert.deepEqual(discovered.config.mcpServers?.designhub, {
			url: "http://localhost:5101/mcp",
			headers: { Authorization: "Bearer ${DESIGNHUB_TOKEN}" },
		});
		assert.equal(discovered.config.mcpServerSources?.["pen.dev"], "builtin");
		assert.equal(discovered.config.mcpServerSources?.dochub, "builtin");
		assert.equal(discovered.config.mcpServerSources?.designhub, "builtin");
		assert.equal(discovered.config.mcpServerSources?.custom, "project");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Agent Studio selectors show highlighted tool and MCP details in a right pane", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-studio-tool-details-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		let toolDetails = "";
		let mcpDetails = "";
		const runtime = boot(root, {
			selectAnswers: ["Choose tools (1)", "Manage MCP servers (0)", "Back without applying"],
			customActions: [
				(component, _done) => component.handleInput("e"),
				(component, _done) => {
					toolDetails = component.render(100).join("\n");
					component.handleInput("\u001b[B");
					toolDetails += `\n${component.render(100).join("\n")}`;
					component.handleInput("\u001b");
				},
				(component, _done) => {
					mcpDetails = component.render(110).join("\n");
					component.handleInput("\u001b");
				},
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		assert.match(toolDetails, /Read file contents from disk\./);
		assert.match(toolDetails, /Execute a shell command\./);
		assert.match(toolDetails, /Choices \(1\/2\)/);
		assert.doesNotMatch(toolDetails, /powershell/i);
		assert.match(mcpDetails, /designhub/);
		assert.match(mcpDetails, /local DesignHub editor/);
		assert.match(mcpDetails, /proxy\. Requires DesignHub/);
		assert.match(mcpDetails, /http:\/\/localhost:5101\/mcp/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent picker renders an inspectable dashboard with metadata, MCP, tools, and prompt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-dashboard-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		await mkdir(path.join(root, ".pi-agents", "beta"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "beta", "prompt.md"), "You are the exact beta prompt.\nSecond line.");
		await writeFile(path.join(root, ".pi-agents", "beta", "agent.ts"), `export default {
			name: "beta", description: "Browser specialist", whenToUse: "web checks",
			capabilities: ["navigation", "screenshots"], limitations: ["read-only"],
			tools: ["read", "missing_tool"], mcp: ["browser"], systemPromptFile: "./prompt.md"
		};`);
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({
			mcpServers: { browser: { command: "fake-browser-mcp" } },
		}));
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const dashboard = runtime.getCustomComponent();
		assert.ok(dashboard);
		const initialHeight = dashboard.render(120).length;
		dashboard.handleInput("\u001b[B"); // beta
		const overviewLines = dashboard.render(120);
		assert.equal(overviewLines.length, initialHeight);
		assert.match(overviewLines.join("\n"), /Use when: web checks/);
		dashboard.handleInput("\t"); // tools
		const toolsView = dashboard.render(120).join("\n");
		assert.match(toolsView, /Declared: read, missing_tool/);
		assert.match(toolsView, /Unknown: missing_tool/);
		dashboard.handleInput("\t"); // MCP
		assert.match(dashboard.render(120).join("\n"), /browser · stdio · project · disconnected/);
		dashboard.handleInput("\t"); // prompt
		const promptView = dashboard.render(120).join("\n");
		assert.match(promptView, /prompt\.md/);
		assert.match(promptView, /You are the exact beta prompt/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
