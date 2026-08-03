import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { discoverAgents, loadConfig, type DiscoveredAgent, type PiAgentsConfig } from "./agents.ts";
import { showAgentSelector, updateStatus } from "./ui.ts";

const STATE_ENTRY = "pi-agents-state";
const DEFAULT_SELECT_SHORTCUT = "ctrl+shift+a";
const DEFAULT_ROTATE_SHORTCUT = "alt+a";

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

	// Keybindings come from config.json (global + project, project wins).
	// Load at extension load time: cwd is the directory pi started in.
	config = loadConfig(process.cwd());

	pi.registerFlag("agent", {
		description: "Agent to activate (name from .pi-agents)",
		type: "string",
	});

	function applyAgent(name: string, ctx: ExtensionContext, opts?: { silent?: boolean }): boolean {
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

		if (agent.tools && agent.tools.length > 0) {
			const all = new Set(pi.getAllTools().map((t) => t.name));
			const valid = agent.tools.filter((t) => all.has(t));
			const invalid = agent.tools.filter((t) => !all.has(t));
			if (invalid.length > 0 && !opts?.silent) {
				ctx.ui.notify(`Agent "${name}": unknown tools: ${invalid.join(", ")}`, "warning");
			}
			if (valid.length > 0) pi.setActiveTools(valid);
		}

		activeName = agent.name;
		activeAgent = agent;
		updateStatus(ctx, activeName);
		if (!opts?.silent) ctx.ui.notify(`Agent "${name}" activated`, "info");
		return true;
	}

	function clearAgent(ctx: ExtensionContext, opts?: { silent?: boolean }) {
		if (originalTools) {
			pi.setActiveTools(originalTools);
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
		else applyAgent(result, ctx);
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
		else applyAgent(nextName, ctx);
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

		if (selected) applyAgent(selected, ctx, { silent: true });
		else updateStatus(ctx, undefined);
		persistedName = activeName;
	});

	pi.on("turn_start", async () => {
		if (activeName !== persistedName) {
			pi.appendEntry(STATE_ENTRY, { name: activeName ?? null });
			persistedName = activeName;
		}
	});
}
