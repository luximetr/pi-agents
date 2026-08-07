import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { discoverAgents, loadConfig, type DiscoveredAgent, type PiAgentsConfig } from "./agents.ts";
import { McpManager, jsonSchemaToTypeBox } from "./mcp.ts";
import { showAgentSelector, updateStatus } from "./ui.ts";
import { runSubagent } from "./subagents.ts";

const STATE_ENTRY = "pi-agents-state";
// Function keys are encoded as escape sequences by iTerm2 and are passed
// through herdr/tmux without requiring modifyOtherKeys or Option-as-Meta.
const DEFAULT_SELECT_SHORTCUT = "f7";
const DEFAULT_ROTATE_SHORTCUT = "f8";
const DELEGATE_TOOL = "delegate";

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

/** Normalize a config keybinding and always retain the terminal-safe fallback. */
function normalizeShortcutKeys(value: string | string[] | undefined, fallback: string): string[] {
	const configured = value === undefined ? [] : Array.isArray(value) ? value : [value];
	return [...new Set([...configured, fallback].map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

export default function (pi: ExtensionAPI) {
	let agents: DiscoveredAgent[] = [];
	let config: PiAgentsConfig = {};
	let activeName: string | undefined;
	let activeAgent: DiscoveredAgent | undefined;
	/** Set by /agent:help; injects the bundled guide into the next turn only (one-shot). */
	let helpPending = false;
	/** Toolset before the first agent was applied; used to restore plain pi. */
	let originalTools: string[] | undefined;
	let persistedName: string | undefined;

	/** Read the last agent selection from a session file (used by /new and /clone). */
	function readPersistedName(sessionFile: string | undefined): string | null | undefined {
		if (!sessionFile) return undefined;
		try {
			const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
			for (const line of lines.reverse()) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { name?: string | null } };
					if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
						return entry.data?.name ?? null;
					}
				} catch {
					// Ignore incomplete/corrupt trailing lines in a session file.
				}
			}
		} catch {
			// Ephemeral sessions and unavailable previous files have no selection.
		}
		return undefined;
	}

	function persistSelection(name: string | undefined) {
		if (name !== persistedName) {
			pi.appendEntry(STATE_ENTRY, { name: name ?? null });
			persistedName = name;
		}
	}

	const mcpManager = new McpManager(pi);
	/** Custom tool name -> agent name that registered it (for collision warnings). */
	const customToolOwners = new Map<string, string>();

	// This is registered once, but is added to the active toolset only for
	// agents that explicitly declare the target agent(s) in `subagents`.
	pi.registerTool({
		name: DELEGATE_TOOL,
		label: "Delegate",
		description: "Delegate a focused task to an allowed subagent and receive its concise result.",
		promptSnippet: "delegate: ask a specialist agent to complete an isolated task",
		parameters: jsonSchemaToTypeBox({
			type: "object",
			properties: {
				agent: { type: "string", description: "Name of an allowed subagent" },
				task: { type: "string", description: "Self-contained task; include relevant paths and expected output" },
			},
			required: ["agent", "task"],
			additionalProperties: false,
		}),
		execute: async (_id, params, signal, onUpdate, ctx) => {
			const parent = activeAgent;
			const agentName = String((params as { agent?: unknown }).agent ?? "").trim();
			const task = String((params as { task?: unknown }).task ?? "").trim();
			if (!parent?.subagents?.includes(agentName)) {
				return { content: [{ type: "text", text: `Delegation denied: ${agentName} is not an allowed subagent of ${parent?.name ?? "the current agent"}.` }], details: {} };
			}
			if (!agents.some((a) => a.name === agentName)) {
				return { content: [{ type: "text", text: `Unknown subagent: ${agentName}.` }], details: {} };
			}
			if (!task) return { content: [{ type: "text", text: "Delegation requires a non-empty task." }], details: {} };
			try {
				// Tool updates replace the previous snapshot in pi's UI. Keep a bounded
				// local buffer so token-sized deltas update one visible block instead of
				// growing an unbounded transcript of progress messages.
				const MAX_PROGRESS_LINES = 15;
				const progressLines: string[] = [`▶ ${agentName}: started`];
				let streamedText = "";
				const publish = () => {
					const allLines = [...progressLines, ...streamedText.split("\n")].filter(Boolean);
					const progressText = allLines.slice(-MAX_PROGRESS_LINES).join("\n");
					onUpdate?.({ content: [{ type: "text", text: progressText }], details: { agent: agentName, progress: true } });
				};
				const update = (line: string) => {
					if (streamedText) {
						progressLines.push(streamedText);
						streamedText = "";
					}
					progressLines.push(line);
					if (progressLines.length > MAX_PROGRESS_LINES) progressLines.splice(0, progressLines.length - MAX_PROGRESS_LINES);
					publish();
				};
				const stream = (delta: string) => {
					streamedText += delta;
					const lines = streamedText.split("\n");
					if (lines.length > MAX_PROGRESS_LINES) streamedText = lines.slice(-MAX_PROGRESS_LINES).join("\n");
					publish();
				};
				const result = await runSubagent(agentName, task, ctx.cwd, signal ?? new AbortController().signal, {
					onProgress: (event) => {
						switch (event.type) {
							case "started": update(`▶ ${event.agent}: running`); break;
							case "text": stream(event.delta); break;
							case "tool-start": update(`→ ${event.tool}`); break;
							case "tool-update": update(event.text); break;
							case "tool-end": update(`${event.error ? "✗" : "✓"} ${event.tool}`); break;
							case "finished": update(`✓ ${agentName}: finished`); break;
							case "error": update(`✗ ${event.message}`); break;
						}
					},
				});
				return { content: [{ type: "text", text: `Result from ${agentName}:\n\n${result}` }], details: { agent: agentName } };
			} catch (err) {
				return { content: [{ type: "text", text: `Subagent ${agentName} failed: ${err instanceof Error ? err.message : String(err)}` }], details: { agent: agentName, error: true } };
			}
		},
	});

	// Keybindings come from config.json (global + project, project wins).
	// Load at extension load time: cwd is the directory pi started in.
	config = loadConfig(process.cwd());

	pi.registerFlag("agent", {
		description: "Agent to activate (name from .pi-agents)",
		type: "string",
	});

	/**
	 * Register the agent's custom tools with pi. Mid-session registration
	 * auto-activates tools, so this must run right before setActiveTools in
	 * applyAgent re-scopes the toolset. Re-applying an agent re-registers its
	 * own tools (overwrite); same-named tools from other agents override.
	 */
	function registerCustomTools(agent: DiscoveredAgent, ctx: ExtensionContext, opts?: { silent?: boolean }): string[] {
		const names: string[] = [];
		for (const [name, tool] of Object.entries(agent.customTools ?? {})) {
			const owner = customToolOwners.get(name);
			if (!opts?.silent) {
				if (owner !== undefined && owner !== agent.name) {
					ctx.ui.notify(
						`Agent "${agent.name}": custom tool "${name}" overrides the one defined by agent "${owner}"`,
						"warning",
					);
				} else if (owner === undefined && pi.getAllTools().some((t) => t.name === name)) {
					ctx.ui.notify(`Agent "${agent.name}": custom tool "${name}" shadows an existing registered tool`, "warning");
				}
			}
			pi.registerTool({
				name,
				label: tool.label ?? name,
				description: tool.description,
				promptSnippet: `${name}: ${tool.description.split("\n")[0].slice(0, 90)}`,
				...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
				...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
				parameters: jsonSchemaToTypeBox(tool.parameters ?? { type: "object", additionalProperties: false }),
				execute: async (_toolCallId, params, _signal, _onUpdate, extCtx) => {
					const result = await tool.execute(params as Record<string, unknown>, extCtx, pi.exec);
					if (typeof result === "string") return { content: [{ type: "text", text: result }], details: {} };
					return result;
				},
			});
			customToolOwners.set(name, agent.name);
			names.push(name);
		}
		return names;
	}

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

		// MCP connections may contain agent-specific credentials. Never reuse a
		// connection when changing agents, even when both agents use the same
		// server name.
		if (activeName !== undefined && activeName !== agent.name) {
			await mcpManager.disconnectAll();
		}

		// Register the agent's custom tools (per-agent tools). Auto-activated
		// by pi at registration; re-scoped by setActiveTools below.
		const customToolNames = registerCustomTools(agent, ctx, opts);

		// Connect the agent's MCP servers (only the ones it asks for) and
		// collect their prefixed tool names. Agent-level servers and secrets
		// override project/global ones with the same name.
		let mcpToolNames: string[] = [];
		if (agent.mcp && agent.mcp.length > 0) {
			if (!opts?.silent) ctx.ui.notify(`Connecting MCP: ${agent.mcp.join(", ")}...`, "info");
			const servers = { ...config.mcpServers, ...agent.mcpServers };
			const env = { ...config.env, ...agent.env };
			mcpToolNames = await mcpManager.activate(agent.mcp, servers, env, ctx, opts);
		}

		// Tool allowlist: the agent's list when given (empty [] = no tools at
		// all — only MCP tools are added on top), otherwise keep the current
		// toolset. MCP tools are always added on top.
		let base: string[];
		if (agent.tools !== undefined) {
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
		const allowedSubagents = (agent.subagents ?? []).filter((name) => agents.some((candidate) => candidate.name === name));
		const unknownSubagents = (agent.subagents ?? []).filter((name) => !agents.some((candidate) => candidate.name === name));
		if (unknownSubagents.length > 0 && !opts?.silent) {
			ctx.ui.notify(`Agent "${name}": unknown subagents: ${unknownSubagents.join(", ")}`, "warning");
		}
		const delegationTools = allowedSubagents.length > 0 ? [DELEGATE_TOOL] : [];
		const active = [...new Set([...base, ...customToolNames, ...mcpToolNames, ...delegationTools])];
		// Apply even when empty: an explicit [] allowlist means "no tools".
		pi.setActiveTools(active);

		activeName = agent.name;
		activeAgent = agent;
		updateStatus(ctx, activeAgent);
		persistSelection(activeName);
		if (!opts?.silent) {
			const mcpNote = mcpToolNames.length > 0 ? ` (${mcpToolNames.length} MCP tools)` : "";
			ctx.ui.notify(`Agent "${name}" activated${mcpNote}`, "info");
		}
		return true;
	}

	async function clearAgent(ctx: ExtensionContext, opts?: { silent?: boolean }) {
		// Clearing an agent must also drop its credentialed MCP connections.
		await mcpManager.disconnectAll();
		if (originalTools) {
			pi.setActiveTools(originalTools);
			originalTools = undefined;
		}
		activeName = undefined;
		activeAgent = undefined;
		updateStatus(ctx, undefined);
		persistSelection(undefined);
		if (!opts?.silent) ctx.ui.notify("Agent cleared, plain pi restored", "info");
	}

	/** Select an agent by name; "none"/"off" clears. */
	async function selectAgent(rawName: string | undefined, ctx: ExtensionContext, opts?: { silent?: boolean }): Promise<boolean> {
		const name = rawName?.trim();
		if (!name) return false;
		if (name === "none" || name === "off") {
			await clearAgent(ctx, opts);
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
		if (result === "(none)") await clearAgent(ctx);
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
		if (nextName === "(none)") await clearAgent(ctx);
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

	pi.registerCommand("agent:help", {
		description: "Ask a question about pi-agents, answered from the bundled guide: /agent:help <question>",
		handler: async (args, ctx) => {
			const question = args?.trim();
			if (!question) {
				ctx.ui.notify('Usage: /agent:help <question> — e.g. "/agent:help how do I add an MCP server?"', "info");
				return;
			}
			if (!GUIDE) {
				ctx.ui.notify("pi-agents: bundled guide.md is not available.", "error");
				return;
			}
			helpPending = true;
			pi.sendUserMessage(question, { deliverAs: "followUp" });
		},
	});

	// --- Agent prompt injection ---

	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];
		if (activeAgent?.systemPrompt) parts.push(activeAgent.systemPrompt);
		if (helpPending && GUIDE) {
			helpPending = false;
			parts.push(
				`The user asked a question about the pi-agents extension. Answer it using the bundled guide:\n\n${GUIDE}`,
			);
		}
		if (parts.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}`,
		};
	});

	// --- Session lifecycle: discover, restore, persist ---

	pi.on("session_start", async (event, ctx) => {
		const result = await discoverAgents(ctx.cwd);
		agents = result.agents;
		config = result.config;
		activeName = undefined;
		activeAgent = undefined;

		// Restore this session first. A newly-created session has no entries, so
		// inherit the selection from the session it replaced (the OpenCode-style
		// behavior expected from /new and /clone).
		let restored = readPersistedName(ctx.sessionManager.getSessionFile());
		if (restored === undefined && (event.reason === "new" || event.reason === "fork")) {
			restored = readPersistedName(event.previousSessionFile);
		}

		// Priority: --agent flag > persisted > config.defaultAgent > agent.default > first agent

		const flag = pi.getFlag("agent");
		let selected: string | undefined;
		if (typeof flag === "string" && flag.trim()) {
			if (agents.some((a) => a.name === flag.trim())) selected = flag.trim();
			else ctx.ui.notify(`Unknown agent "${flag}". Available: ${agents.map((a) => a.name).join(", ")}`, "warning");
		} else if (restored !== undefined) {
			// null is a deliberate persisted "plain pi" selection; do not replace
			// it with the configured/default agent on the next /new.
			if (restored && agents.some((a) => a.name === restored)) selected = restored;
		} else if (config.defaultAgent && agents.some((a) => a.name === config.defaultAgent)) {
			selected = config.defaultAgent;
		} else {
			selected = agents.find((a) => a.default)?.name ?? agents[0]?.name;
		}

		// Set this before applying so the initial selection is persisted too (and
		// selecting an agent then immediately running /new cannot lose the choice).
		persistedName = undefined;
		if (selected) await applyAgent(selected, ctx, { silent: true });
		else updateStatus(ctx, undefined);
		persistedName = activeName;
	});

	// Close MCP server processes when the session ends.
	pi.on("session_shutdown", async () => {
		await mcpManager.disconnectAll();
	});

	pi.on("turn_start", async () => {
		persistSelection(activeName);
	});
}
