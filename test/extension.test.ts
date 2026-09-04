import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../index.ts";
import { discoverAgents, saveAgentOverride, saveDeclarativeAgent } from "../agents.ts";

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
		registerFlag: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getFlag: () => options?.flag,
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
			editor: async () => options?.editorAnswers?.shift(),
			input: async () => options?.inputAnswers?.shift(),
			custom: async (factory: any) => {
				let finish!: (value: any) => void;
				const completion = new Promise<any>((resolve) => { finish = resolve; });
				customComponent = factory({ requestRender: () => {} }, theme, {}, finish);
				const action = options?.customActions?.shift();
				if (!action) return null;
				action(customComponent, finish);
				return completion;
			},
		},
	};
	return { handlers, commands, activeToolsets, notifications, entries, tools, statuses, getCustomComponent: () => customComponent, ctx };
}

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
		await makeAgent(root, "lead", 'default: true, subagents: [{ name: "worker", model: "test/worker", timeoutSeconds: 90 }]');
		await makeAgent(root, "worker");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const result = await runtime.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, runtime.ctx);
		assert.match(result.systemPrompt, /allowed subagents/);
		assert.match(result.systemPrompt, /worker: worker \(model test\/worker, 90s deadline\)/);
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
			selectAnswers: ["Project (commit with this repository)", "Back without applying"],
			inputAnswers: ["new-agent", "Experiments with project tools"],
			editorAnswers: ["Use the available tools carefully."],
			customActions: [
				(component, _done) => component.handleInput("n"),
				(component, _done) => component.handleInput("\u001b"),
			],
		});
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("", runtime.ctx);
		const created = JSON.parse(await readFile(path.join(root, ".pi-agents", "new-agent", "agent.json"), "utf8"));
		assert.equal(created.description, "Experiments with project tools");
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
			selectAnswers: ["Choose tools (1)", "Choose MCP servers (0)", "Back without applying"],
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
