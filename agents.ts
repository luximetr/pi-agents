import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { getAgentDir, type AgentToolResult, type ExecOptions, type ExecResult, type ExtensionContext, type ThemeColor, type ToolExecutionMode } from "@earendil-works/pi-coding-agent";

/** Pi's built-in tools (always available). */
export const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinTool = (typeof TOOLS)[number];

/** Enum-style accessor for built-in tools, e.g. `tools: [Tools.read, Tools.grep]`. */
export const Tools: Record<BuiltinTool, BuiltinTool> = {
	read: "read",
	bash: "bash",
	edit: "edit",
	write: "write",
	grep: "grep",
	find: "find",
	ls: "ls",
};

/**
 * Any valid tool name: a built-in tool or one registered by an extension.
 * The `(string & {})` fallback keeps custom tool names valid while editors
 * still autocomplete the known built-ins.
 */
export type ToolName = BuiltinTool | (string & {});

/**
 * Shell execution available to custom tools: `exec(command, args, options?)`
 * resolves in the session cwd and returns `{ stdout, stderr, code }`.
 */
export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/**
 * A custom tool defined inside an agent (per-agent tools). Registered with pi
 * when the agent is applied; active only while that agent's allowlist is
 * applied. Any agent can list the tool name in `tools` once it is registered.
 */
export interface AgentCustomTool {
	/** One-line description for the LLM. */
	description: string;
	/** JSON Schema for the tool's parameters (object). Defaults to no parameters. */
	parameters?: Record<string, unknown>;
	/** Human-readable label shown in the UI (defaults to the tool name). */
	label?: string;
	/** Guideline bullets appended to the default system prompt while this tool is active. */
	promptGuidelines?: string[];
	/** Per-tool execution mode override (default: the session default). */
	executionMode?: ToolExecutionMode;
	/**
	 * Execute the tool. Return an AgentToolResult, or a plain string (wrapped
	 * as text content). `exec` runs a shell command in the session cwd
	 * ({ stdout, stderr, code }); `ctx` is the extension context.
	 */
	execute: (args: Record<string, unknown>, ctx: ExtensionContext, exec: ExecFn) => AgentToolResult<unknown> | string | Promise<AgentToolResult<unknown> | string>;
}

/**
 * Agent definition. Model and thinking level are NOT part of an agent -
 * they are selected in pi itself (/model, thinking UI).
 */
export interface AgentConfig {
	/** Unique agent name, used in UI and commands */
	name: string;
	/** One-line description shown in the picker */
	description: string;
	/**
	 * UI color: a theme role (e.g. "success", "warning") or a hex color
	 * ("#ff8800"). Omit for a stable color auto-assigned from the name.
	 */
	color?: string;
	/** Tool allowlist. Omit to keep current tools (use "default" for pi defaults). An empty array `[]` disables all tools — the agent is left with only its MCP tools (if any). */
	tools?: ToolName[];
	/**
	 * MCP server names (keys of config.json mcpServers) whose tools this agent
	 * activates. Only these servers are connected — not all available ones.
	 */
	mcp?: string[];
	/**
	 * Agent-local MCP servers, only visible to this agent (override
	 * project/global servers with the same name). Useful for servers that
	 * exactly one agent should use. Same shape as config.json mcpServers.
	 */
	mcpServers?: Record<string, McpServerConfig>;
	/** System prompt, inline */
	systemPrompt?: string;
	/** System prompt loaded from a markdown file (relative to agent file/dir) */
	systemPromptFile?: string;
	/**
	 * Custom tools defined inside this agent (per-agent tools), keyed by tool
	 * name. Registered when the agent is applied; active only while it is.
	 */
	customTools?: Record<string, AgentCustomTool>;
	/** Auto-select this agent on session start (config.json defaultAgent wins over this) */
	default?: boolean;
}

export interface DiscoveredAgent extends AgentConfig {
	filePath: string;
	source: "global" | "project";
	dir: string;
	/** Secrets from the agent dir's `.env` (gitignored), e.g. `.pi-agents/<name>/.env`. */
	env?: Record<string, string>;
}

export interface PiAgentsConfig {
	defaultAgent?: string;
	keybindings?: {
		/** One key or several (fallbacks for terminals that don't send alt/ctrl+shift distinctly). */
		select?: string | string[];
		rotate?: string | string[];
	};
	/**
	 * MCP servers, keyed by name. Either a stdio server (`command`+`args`,
	 * Claude Desktop-style) or a streamable HTTP server (`url`).
	 * Agents opt into servers via their `mcp` field — nothing is connected
	 * unless an agent requests it.
	 */
	mcpServers?: Record<string, McpServerConfig>;
	/**
	 * Secrets loaded from `.env` files (global `~/.pi/pi-agents/.env` and
	 * project `.pi-agents/.env`, project wins). Referenced from config as
	 * `${VAR}` — the shell environment takes precedence over both.
	 */
	env?: Record<string, string>;
}

/** MCP server definition: exactly one of `command` (stdio) or `url` (streamable HTTP). */
export interface McpServerConfig {
	/** Command to spawn, e.g. "npx" */
	command?: string;
	/** Args, e.g. ["-y", "@modelcontextprotocol/server-github"] */
	args?: string[];
	/** Extra environment variables for the server process (stdio only) */
	env?: Record<string, string>;
	/** Working directory for the server process (stdio only) */
	cwd?: string;
	/** Streamable HTTP endpoint, e.g. "https://host:port/mcp" */
	url?: string;
	/** HTTP headers (HTTP only). Values may reference env vars: "Bearer ${MY_TOKEN}". */
	headers?: Record<string, string>;
	/** Skip TLS certificate verification (HTTP only, for self-signed certs). */
	insecure?: boolean;
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
	const color = normalizeColor(cfg.color, filePath);
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

	// Agent-local MCP servers + secrets (`.env` in the agent dir) — only this
	// agent can use them; project/global servers with the same name are overridden.
	const mcpServers = normalizeMcpServers(cfg.mcpServers);
	const agentEnv = loadEnvFile(dir);

	const customTools = normalizeCustomTools(cfg.customTools);

	return {
		name,
		description: cfg.description.trim(),
		color,
		tools: Array.isArray(cfg.tools)
			? (cfg.tools.map((t) => String(t).trim()).filter(Boolean) as ToolName[])
			: undefined,
		mcp: Array.isArray(cfg.mcp) ? cfg.mcp.map((s) => String(s).trim()).filter(Boolean) : undefined,
		mcpServers,
		env: Object.keys(agentEnv).length > 0 ? agentEnv : undefined,
		systemPrompt: systemPrompt?.trim() ? systemPrompt : undefined,
		customTools,
		default: cfg.default === true,
		filePath,
		source,
		dir,
	};
}

/** Theme roles usable as an agent color (pi's ThemeColor union). */
const THEME_ROLES: ReadonlySet<string> = new Set([
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment",
	"syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType",
	"syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
	"thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
]);

/**
 * Validate + normalize an agent `color`: a ThemeColor role or "#rrggbb" hex.
 * Returns undefined when absent (ui.ts auto-assigns) or invalid.
 */
function normalizeColor(raw: unknown, filePath: string): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const value = raw.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	if (THEME_ROLES.has(value)) return value;
	console.error(`pi-agents: ${filePath}: invalid "color" ${JSON.stringify(value)} — use a theme role or #rrggbb`);
	return undefined;
}

/**
 * Validate + normalize an agent's `customTools` map. Entries need a
 * description and an execute function; the rest is normalized. Returns
 * undefined when empty.
 */
function normalizeCustomTools(raw: unknown): Record<string, AgentCustomTool> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const tools: Record<string, AgentCustomTool> = {};
	for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		const t = entry as Partial<AgentCustomTool>;
		if (typeof t.description !== "string" || !t.description.trim()) {
			console.error(`pi-agents: custom tool "${name}" is missing a valid "description"`);
			continue;
		}
		if (typeof t.execute !== "function") {
			console.error(`pi-agents: custom tool "${name}" is missing an "execute" function`);
			continue;
		}
		tools[name] = {
			description: t.description.trim(),
			parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : undefined,
			label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : undefined,
			promptGuidelines: Array.isArray(t.promptGuidelines) ? t.promptGuidelines.map(String) : undefined,
			executionMode: t.executionMode === "sequential" || t.executionMode === "parallel" ? t.executionMode : undefined,
			execute: t.execute,
		};
	}
	return Object.keys(tools).length > 0 ? tools : undefined;
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

function normalizeKeys(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = Array.isArray(value) ? value : [value];
	const keys = [...new Set(list.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
	return keys.length > 0 ? keys : undefined;
}

function loadConfigFrom(dir: string): PiAgentsConfig {
	const configPath = path.join(dir, "config.json");
	if (!fs.existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<PiAgentsConfig>;
		const keybindings = parsed.keybindings && typeof parsed.keybindings === "object" ? parsed.keybindings : undefined;
		const mcpServers = normalizeMcpServers(parsed.mcpServers);
		return {
			defaultAgent: typeof parsed.defaultAgent === "string" ? parsed.defaultAgent : undefined,
			keybindings: keybindings
				? {
						select: normalizeKeys(keybindings.select),
						rotate: normalizeKeys(keybindings.rotate),
				  }
				: undefined,
			mcpServers,
			env: loadEnvFile(dir),
		};
	} catch (err) {
		console.error(`pi-agents: failed to parse ${configPath}: ${err}`);
		return {};
	}
}

/** Parse a simple .env file: `KEY=VALUE` lines, `#` comments, optional quotes, optional `export` prefix. */
export function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const bare = line.startsWith("export ") ? line.slice(7).trimStart() : line;
		const eq = bare.indexOf("=");
		if (eq <= 0) continue;
		const key = bare.slice(0, eq).trim();
		let value = bare.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			}
		}
		if (key) env[key] = value;
	}
	return env;
}

/** Load the `.env` file from an agents dir (empty map if absent/unreadable). */
function loadEnvFile(dir: string): Record<string, string> {
	const envPath = path.join(dir, ".env");
	if (!fs.existsSync(envPath)) return {};
	try {
		return parseEnvFile(fs.readFileSync(envPath, "utf-8"));
	} catch (err) {
		console.error(`pi-agents: failed to parse ${envPath}: ${err}`);
		return {};
	}
}

/**
 * Validate + normalize an `mcpServers` map (config.json or agent-level).
 * Entries need exactly one of `command` (stdio) or `url` (HTTP); the rest is
 * normalized to strings. Returns undefined when empty.
 */
function normalizeMcpServers(raw: unknown): Record<string, McpServerConfig> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const mcpServers: Record<string, McpServerConfig> = {};
	for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		const cfg = entry as Partial<McpServerConfig>;
		const command = typeof cfg.command === "string" ? cfg.command.trim() : undefined;
		const url = typeof cfg.url === "string" ? cfg.url.trim() : undefined;
		if (!command && !url) continue;
		mcpServers[name] = {
			command,
			args: Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : undefined,
			env: cfg.env && typeof cfg.env === "object"
				? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]))
				: undefined,
			cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
			url,
			headers: cfg.headers && typeof cfg.headers === "object"
				? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, String(v)]))
				: undefined,
			insecure: cfg.insecure === true,
		};
	}
	return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
}

/** Merged config.json from global + project dirs (project wins). */
export function loadConfig(cwd: string): PiAgentsConfig {
	const globalConfig = loadConfigFrom(getGlobalAgentsDir());
	const projectDir = findProjectAgentsDir(cwd);
	const projectConfig = projectDir ? loadConfigFrom(projectDir) : {};
	return {
		defaultAgent: projectConfig.defaultAgent ?? globalConfig.defaultAgent,
		keybindings: {
			select: projectConfig.keybindings?.select ?? globalConfig.keybindings?.select,
			rotate: projectConfig.keybindings?.rotate ?? globalConfig.keybindings?.rotate,
		},
		mcpServers: { ...globalConfig.mcpServers, ...projectConfig.mcpServers },
		env: { ...globalConfig.env, ...projectConfig.env },
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
