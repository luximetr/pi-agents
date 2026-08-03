import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Agent definition. Model and thinking level are NOT part of an agent -
 * they are selected in pi itself (/model, thinking UI).
 */
export interface AgentConfig {
	/** Unique agent name, used in UI and commands */
	name: string;
	/** One-line description shown in the picker */
	description: string;
	/** Tool allowlist. Omit to keep current tools (use "default" for pi defaults). */
	tools?: string[];
	/** System prompt, inline */
	systemPrompt?: string;
	/** System prompt loaded from a markdown file (relative to agent file/dir) */
	systemPromptFile?: string;
	/** Auto-select this agent on session start (config.json defaultAgent wins over this) */
	default?: boolean;
}

export interface DiscoveredAgent extends AgentConfig {
	filePath: string;
	source: "global" | "project";
	dir: string;
}

export interface PiAgentsConfig {
	defaultAgent?: string;
	keybindings?: {
		select?: string;
		rotate?: string;
	};
}

const jiti = createJiti(import.meta.url);

/** Validate + normalize an agent config loaded from disk. */
function normalizeAgent(
	raw: unknown,
	filePath: string,
	source: "global" | "project",
	fallbackName?: string,
): DiscoveredAgent | null {
	if (!raw || typeof raw !== "object") {
		console.error(`pi-agents: ${filePath} must export an agent config object`);
		return null;
	}
	const cfg = raw as Partial<AgentConfig>;
	const name = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : fallbackName;
	if (!name) {
		console.error(`pi-agents: ${filePath} is missing a valid "name"`);
		return null;
	}
	if (typeof cfg.description !== "string" || !cfg.description.trim()) {
		console.error(`pi-agents: ${filePath} is missing a valid "description"`);
		return null;
	}
	const dir = path.dirname(filePath);

	let systemPrompt: string | undefined = cfg.systemPrompt;
	if (cfg.systemPromptFile) {
		const promptPath = path.resolve(dir, cfg.systemPromptFile);
		try {
			systemPrompt = fs.readFileSync(promptPath, "utf-8");
		} catch (err) {
			console.error(`pi-agents: ${filePath}: cannot read systemPromptFile ${promptPath}: ${err}`);
			return null;
		}
	}

	return {
		name,
		description: cfg.description.trim(),
		tools: Array.isArray(cfg.tools) ? cfg.tools.map((t) => String(t).trim()).filter(Boolean) : undefined,
		systemPrompt: systemPrompt?.trim() ? systemPrompt : undefined,
		default: cfg.default === true,
		filePath,
		source,
		dir,
	};
}

/** Load one agent definition file (TS/JS/MJS, default export = config or factory). */
async function loadAgentFile(
	filePath: string,
	source: "global" | "project",
	fallbackName?: string,
): Promise<DiscoveredAgent | null> {
	try {
		let mod: unknown;
		if (filePath.endsWith(".mjs")) {
			mod = await import(pathToFileURL(filePath).href);
		} else {
			mod = await jiti.import(filePath);
		}
		let config: unknown = (mod as { default?: unknown })?.default ?? mod;
		if (typeof config === "function") config = await (config as () => unknown)();
		if (config && typeof (config as Promise<unknown>).then === "function") config = await config;
		return normalizeAgent(config, filePath, source, fallbackName);
	} catch (err) {
		console.error(`pi-agents: failed to load ${filePath}: ${err}`);
		return null;
	}
}

function listAgentFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && /\.(ts|js|mjs)$/.test(e.name))
		.map((e) => path.join(dir, e.name));
}

function listAgentDirs(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
		.map((e) => path.join(dir, e.name));
}

function isGitRootOrFsRoot(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir;
}

/** Find nearest project .pi-agents dir walking up from cwd. */
export function findProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi-agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		if (isGitRootOrFsRoot(current)) return null;
		current = path.dirname(current);
	}
}

function loadConfigFrom(dir: string): PiAgentsConfig {
	const configPath = path.join(dir, "config.json");
	if (!fs.existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<PiAgentsConfig>;
		return {
			defaultAgent: typeof parsed.defaultAgent === "string" ? parsed.defaultAgent : undefined,
			keybindings: parsed.keybindings && typeof parsed.keybindings === "object" ? parsed.keybindings : undefined,
		};
	} catch (err) {
		console.error(`pi-agents: failed to parse ${configPath}: ${err}`);
		return {};
	}
}

/** Merged config.json from global + project dirs (project wins). */
export function loadConfig(cwd: string): PiAgentsConfig {
	const globalConfig = loadConfigFrom(getGlobalAgentsDir());
	const projectDir = findProjectAgentsDir(cwd);
	const projectConfig = projectDir ? loadConfigFrom(projectDir) : {};
	return {
		defaultAgent: projectConfig.defaultAgent ?? globalConfig.defaultAgent,
		keybindings: { ...globalConfig.keybindings, ...projectConfig.keybindings },
	};
}

/** Global agents dir: ~/.pi/pi-agents */
export function getGlobalAgentsDir(): string {
	return path.join(getAgentDir(), "pi-agents");
}

/**
 * Discover all agents from global + project dirs (project wins on name collision).
 * Also returns the merged config.json settings.
 */
export async function discoverAgents(cwd: string): Promise<{ agents: DiscoveredAgent[]; config: PiAgentsConfig }> {
	const globalDir = getGlobalAgentsDir();
	const projectDir = findProjectAgentsDir(cwd);

	const byName = new Map<string, DiscoveredAgent>();

	async function loadFrom(dir: string, source: "global" | "project") {
		// Folder per agent: <dir>/<name>/agent.ts (or index.ts)
		for (const agentDir of listAgentDirs(dir)) {
			const filePath = [path.join(agentDir, "agent.ts"), path.join(agentDir, "index.ts")].find((p) => fs.existsSync(p));
			if (filePath) {
				const agent = await loadAgentFile(filePath, source);
				if (agent) byName.set(agent.name, agent);
			}
		}
		// Single-file agents: <dir>/<name>.ts
		for (const filePath of listAgentFiles(dir)) {
			if (filePath.endsWith("config.json")) continue;
			const fallbackName = path.basename(filePath).replace(/\.(ts|js|mjs)$/, "");
			const agent = await loadAgentFile(filePath, source, fallbackName);
			if (agent) byName.set(agent.name, agent);
		}
	}

	await loadFrom(globalDir, "global");
	if (projectDir) await loadFrom(projectDir, "project");

	return {
		agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
		config: loadConfig(cwd),
	};
}
