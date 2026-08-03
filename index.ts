import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { discoverAgents, loadConfig, type DiscoveredAgent, type PiAgentsConfig } from "./agents.ts";
import { McpManager } from "./mcp.ts";
import { showAgentSelector, updateStatus } from "./ui.ts";

const STATE_ENTRY = "pi-agents-state";
const DEFAULT_SELECT_SHORTCUT = "ctrl+shift+a";
const DEFAULT_ROTATE_SHORTCUT = "alt+a";
/** Tool that returns the bundled guide.md — the on-demand "--help" of this extension. */
const GUIDE_TOOL = "pi_agents_guide";

/** Load the bundled guide.md (resolve symlinks so relative lookup works for symlinked installs). */
function loadGuide(): string {
	try {
		const modulePath = fileURLToPath(import.meta.url);
		const guidePath = path.join(path.dirname(fs.realpathSync(modulePath)), "guide.md");
		return fs.readFileSync(guidePath, "utf-8");
	} catch (err) {
		console.error(`pi-agents: cannot load guide.md: ${err}`);
		return "";
	}
}

/** The bundled guide ("" when unavailable). */
const GUIDE = loadGuide();

/** Ensure the guide tool is part of a toolset — always available, in plain pi and for every agent. */
function withGuide(tools: string[]): string[] {
	return GUIDE ? [...new Set([...tools, GUIDE_TOOL])] : tools;
}

/** Normalize a config keybinding (single key or array) into a unique, lowercase key list. */
function normalizeShortcutKeys(value: string | string[] | undefined, fallback: string): string[] {
	const list = value === undefined ? [fallback] : Array.isArray(value) ? value : [value];
	return [...new Set(list.map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

export default function (pi: ExtensionAPI) {
	let agents: DiscoveredAgent[] = [];
	let config: PiAgentsConfig = {};
	let activeName: string | undefined;
	let activeAgent: DiscoveredAgent | undefined;
	/** Toolset before the first agent was applied; used to restore plain pi. */
	let originalTools: string[] | undefined;
	let persistedName: string | undefined;

	const mcpManager = new McpManager(pi);

	// Keybindings come from config.json (global + project, project wins).
	// Load at extension load time: cwd is the directory pi started in.
	config = loadConfig(process.cwd());

	// On-demand help: agents call this tool like a CLI's --help. Registered only
	// if the bundled guide.md is available.
	if (GUIDE) {
		pi.registerTool({
			name: GUIDE_TOOL,
			label: "Pi-agents guide",
			description:
				"How to use the pi-agents extension: switching agents, creating agents, adding tools, and " +
				"configuring MCP servers. Call this tool when asked anything about pi-agents or its agents.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: GUIDE }], details: {} };
			},
		});
	}

	pi.registerFlag("agent", {
		description: "Agent to activate (name from .pi-agents)",
		type: "string",
	});

	async function applyAgent(name: string, ctx: ExtensionContext, opts?: { silent?: boolean }): Promise<boolean> {
		const agent = agents.find((a) => a.name === name);
		if (!agent) {
			if (!opts?.silent) {
				const available = agents.map((a) => a.name).join(", ") || "(none defined)";
				ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
			}
			return false;
		}

		if (activeName === undefined && originalTools === undefined) {
			originalTools = pi.getActiveTools();
		}

		// Connect the agent's MCP servers (only the ones it asks for) and
		// collect their prefixed tool names.
		let mcpToolNames: string[] = [];
		if (agent.mcp && agent.mcp.length > 0) {
			if (!opts?.silent) ctx.ui.notify(`Connecting MCP: ${agent.mcp.join(", ")}...`, "info");
			mcpToolNames = await mcpManager.activate(agent.mcp, config.mcpServers ?? {}, ctx, opts);
		}

		// Tool allowlist: the agent's list when given, otherwise keep the
		// current toolset. MCP tools are always added on top.
		let base: string[];
		if (agent.tools && agent.tools.length > 0) {
			const all = new Set(pi.getAllTools().map((t) => t.name));
			const valid = agent.tools.filter((t) => all.has(t));
			const invalid = agent.tools.filter((t) => !all.has(t));
			if (invalid.length > 0 && !opts?.silent) {
				ctx.ui.notify(`Agent "${name}": unknown tools: ${invalid.join(", ")}`, "warning");
			}
			base = valid;
		} else {
			base = pi.getActiveTools();
		}
		// The guide tool is always available to every agent, regardless of allowlist.
		const active = withGuide([...base, ...mcpToolNames]);
		if (active.length > 0) pi.setActiveTools(active);

		activeName = agent.name;
		activeAgent = agent;
		updateStatus(ctx, activeName);
		if (!opts?.silent) {
			const mcpNote = mcpToolNames.length > 0 ? ` (${mcpToolNames.length} MCP tools)` : "";
			ctx.ui.notify(`Agent "${name}" activated${mcpNote}`, "info");
		}
		return true;
	}

	function clearAgent(ctx: ExtensionContext, opts?: { silent?: boolean }) {
		if (originalTools) {
			pi.setActiveTools(withGuide(originalTools));
			originalTools = undefined;
		}
		activeName = undefined;
		activeAgent = undefined;
		updateStatus(ctx, undefined);
		if (!opts?.silent) ctx.ui.notify("Agent cleared, plain pi restored", "info");
	}

	/** Select an agent by name; "none"/"off" clears. */
	async function selectAgent(rawName: string | undefined, ctx: ExtensionContext, opts?: { silent?: boolean }): Promise<boolean> {
		const name = rawName?.trim();
		if (!name) return false;
		if (name === "none" || name === "off") {
			clearAgent(ctx, opts);
			return true;
		}
		return applyAgent(name, ctx, opts);
	}

	/** Show the picker and apply the selection. */
	async function showPicker(ctx: ExtensionContext) {
		if (agents.length === 0) {
			ctx.ui.notify(
				"No agents defined. Create .pi-agents/<name>/agent.ts in this project or ~/.pi/pi-agents/<name>/agent.ts",
				"warning",
			);
			return;
		}
		const result = await showAgentSelector(ctx, agents, activeName);
		if (result === null) return; // cancelled
		if (result === "(none)") clearAgent(ctx);
		else await applyAgent(result, ctx);
	}

	/** Rotate to the next agent, wrapping through "(none)". */
	async function rotateAgent(ctx: ExtensionContext) {
		const cycle = ["(none)", ...agents.map((a) => a.name)];
		if (cycle.length === 1) {
			ctx.ui.notify("No agents defined. See .pi-agents", "warning");
			return;
		}
		const currentIndex = activeName === undefined ? 0 : cycle.indexOf(activeName);
		const nextIndex = (currentIndex === -1 ? 0 : currentIndex + 1) % cycle.length;
		const nextName = cycle[nextIndex];
		if (nextName === "(none)") clearAgent(ctx);
		else await applyAgent(nextName, ctx);
	}

	// --- UI registration (bindings configurable via config.json, one key or several) ---

	for (const key of normalizeShortcutKeys(config.keybindings?.select, DEFAULT_SELECT_SHORTCUT)) {
		pi.registerShortcut(key as KeyId, {
			description: "Select agent",
			handler: async (ctx) => {
				await showPicker(ctx);
			},
		});
	}

	for (const key of normalizeShortcutKeys(config.keybindings?.rotate, DEFAULT_ROTATE_SHORTCUT)) {
		pi.registerShortcut(key as KeyId, {
			description: "Rotate agent",
			handler: async (ctx) => {
				await rotateAgent(ctx);
			},
		});
	}

	pi.registerCommand("agent", {
		description: "Select an agent: /agent <name>, /agent for picker, /agent none to clear",
		getArgumentCompletions: (prefix: string) => {
			const items = ["(none)", ...agents.map((a) => a.name)];
			return items.filter((i) => i.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (args?.trim()) {
				await selectAgent(args.trim(), ctx);
			} else {
				await showPicker(ctx);
			}
		},
	});

	// --- Agent prompt injection ---

	pi.on("before_agent_start", async (event) => {
		if (activeAgent?.systemPrompt) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${activeAgent.systemPrompt}`,
			};
		}
	});

	// --- Session lifecycle: discover, restore, persist ---

	pi.on("session_start", async (_event, ctx) => {
		const result = await discoverAgents(ctx.cwd);
		agents = result.agents;
		config = result.config;
		activeName = undefined;
		activeAgent = undefined;

		// Make the guide tool available even with no agent selected: first-time
		// users get on-demand help in plain pi right after installing.
		pi.setActiveTools(withGuide(pi.getActiveTools()));

		// Persisted selection for this session (survives restarts).
		const entries = ctx.sessionManager.getEntries();
		let restored: string | undefined;
		for (const entry of [...entries].reverse()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				const name = (entry as { data?: { name?: string | null } }).data?.name ?? undefined;
				if (name) restored = name;
				break;
			}
		}

		// Priority: --agent flag > persisted > config.defaultAgent > agent.default > plain pi
		const flag = pi.getFlag("agent");
		let selected: string | undefined;
		if (typeof flag === "string" && flag.trim()) {
			if (agents.some((a) => a.name === flag.trim())) selected = flag.trim();
			else ctx.ui.notify(`Unknown agent "${flag}". Available: ${agents.map((a) => a.name).join(", ")}`, "warning");
		} else if (restored && agents.some((a) => a.name === restored)) {
			selected = restored;
		} else if (config.defaultAgent && agents.some((a) => a.name === config.defaultAgent)) {
			selected = config.defaultAgent;
		} else {
			selected = agents.find((a) => a.default)?.name;
		}

		if (selected) await applyAgent(selected, ctx, { silent: true });
		else updateStatus(ctx, undefined);
		persistedName = activeName;
	});

	// Close MCP server processes when the session ends.
	pi.on("session_shutdown", async () => {
		await mcpManager.disconnectAll();
	});

	pi.on("turn_start", async () => {
		if (activeName !== persistedName) {
			pi.appendEntry(STATE_ENTRY, { name: activeName ?? null });
			persistedName = activeName;
		}
	});
}
