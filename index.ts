import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { applyAgentOverride, discoverAgents, findMainCheckoutRoot, findProjectAgentsDir, findProjectRoot, getGlobalAgentsDir, loadConfig, normalizeSubagents, parseAgentColor, parseEnvFile, readTrustDecision, removeAgentOverride, saveAgentOrder, saveAgentOverride, saveAgentSource, saveDefaultAgent, saveDeclarativeAgent, type AgentOverride, type DeclarativeAgentInput, type DiscoveredAgent, type PiAgentsConfig } from "./agents.ts";
import { McpManager, jsonSchemaToTypeBox } from "./mcp.ts";
import { storeSessionHandoff, takeSessionHandoff } from "./session-handoff.ts";
import { assistAgentDraft } from "./studio-assistance.ts";
import { editAgentField } from "./studio-field-editor.ts";
import { AgentField, AgentScope, AuthoringMethod, CREATE_MENU, SCOPE_MENU, selectMenu } from "./studio-menu.ts";
import {
	renderDelegateCall,
	renderDelegateResult,
	showAgentSelector,
	showAgentStudio,
	chooseAgentColor,
	showSubagentInspector,
	showWorktreeManager,
	updateStatus,
	type DelegateViewDetails,
	type WorktreeViewItem,
} from "./ui.ts";
import {
	DEFAULT_WORKTREE_RETENTION_DAYS,
	deleteRetainedWorktree,
	formatArgs,
	listRetainedWorktrees,
	pruneRetainedWorktrees,
	SubagentStoppedError,
	runSubagent,
	type RemoveWorktreeResult,
	type RunningSubagentHandle,
	type SubagentUsage,
	type SubagentWorktreeInfo,
} from "./subagents.ts";

const STATE_ENTRY = "pi-agents-state";
const STUDIO_STATE_ENTRY = "pi-agents-studio-state";
// Function keys are encoded as escape sequences by iTerm2 and are passed
// through herdr/tmux without requiring modifyOtherKeys or Option-as-Meta.
const DEFAULT_SELECT_SHORTCUT = "f7";
const DEFAULT_ROTATE_SHORTCUT = "f8";
const DEFAULT_INSPECT_SHORTCUT = "f9";
const DEFAULT_STALE_WARNING_MINUTES = 5;
const DEFAULT_GRACEFUL_STOP_SECONDS = 5;
const DELEGATE_TOOL = "delegate";

type DelegateStatsDetails = DelegateViewDetails & {
	agent: string;
	error?: boolean;
};

type SubagentStats = {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	models: Set<string>;
};

/** Match a denied path glob against both the cwd-relative path and basename. */
export function matchesDeniedPath(target: string, cwd: string, patterns: string[]): boolean {
	const normalize = (value: string) => value.replaceAll(path.sep, "/").replace(/^\.\//, "");
	const absolute = path.resolve(cwd, target);
	const candidates = [normalize(path.relative(cwd, absolute)), normalize(absolute), path.basename(absolute)];
	const globRegex = (raw: string): RegExp => {
		const pattern = normalize(raw.trim());
		let source = "";
		for (let i = 0; i < pattern.length; i++) {
			const ch = pattern[i];
			if (ch === "*" && pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else source += ".*";
			} else if (ch === "*") source += "[^/]*";
			else if (ch === "?") source += "[^/]";
			else source += /[\\^$+.|()[\]{}]/.test(ch) ? `\\${ch}` : ch;
		}
		return new RegExp(`^${source}$`);
	};
	return patterns.some((pattern) => {
		const regex = globRegex(pattern);
		return pattern.includes("/") ? candidates.slice(0, 2).some((candidate) => regex.test(candidate)) : regex.test(candidates[2]);
	});
}

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
	/** Definitions after code-backed files and saved global/project overlays, before session drafts. */
	let sourceAgents: DiscoveredAgent[] = [];
	const studioDrafts = new Map<string, AgentOverride>();
	let config: PiAgentsConfig = {};
	let activeName: string | undefined;
	let activeAgent: DiscoveredAgent | undefined;
	let sessionCwd = process.cwd();
	/** Set by /agent:help; injects the bundled guide into the next turn only (one-shot). */
	let helpPending = false;
	/** Toolset before the first agent was applied; used to restore plain pi. */
	let originalTools: string[] | undefined;
	let persistedName: string | undefined;
	let turnSubagentStats: SubagentStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
	let sessionSubagentStats: SubagentStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
	const runningSubagents = new Map<string, RunningSubagentHandle>();

	function formatSubagentUsage(stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }): string {
		const formatTokens = (count: number) => {
			if (count < 1000) return count.toString();
			if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
			if (count < 1000000) return `${Math.round(count / 1000)}k`;
			if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
			return `${Math.round(count / 1000000)}M`;
		};
		const parts: string[] = [];
		if (stats.input) parts.push(`↑${formatTokens(stats.input)}`);
		if (stats.output) parts.push(`↓${formatTokens(stats.output)}`);
		if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
		if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
		const promptTokens = stats.input + stats.cacheRead + stats.cacheWrite;
		if ((stats.cacheRead || stats.cacheWrite) && promptTokens > 0) {
			parts.push(`CH${((stats.cacheRead / promptTokens) * 100).toFixed(1)}%`);
		}
		if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
		return parts.join(" ");
	}

	function sessionSubagentStatsLine(): string | undefined {
		const parts: string[] = [];
		if (runningSubagents.size > 0) parts.push(`${runningSubagents.size} subagent${runningSubagents.size === 1 ? "" : "s"} running · f9 inspect`);
		if (sessionSubagentStats.calls > 0) {
			const usage = formatSubagentUsage(sessionSubagentStats);
			parts.push(`${sessionSubagentStats.calls} call${sessionSubagentStats.calls === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	function refreshStatus(ctx: ExtensionContext) {
		const assigned = activeAgent?.mcp ?? [];
		const statuses = mcpManager.getStatuses(assigned);
		const connectedMcp = assigned.filter((name) => statuses[name]?.state === "connected");
		updateStatus(ctx, activeAgent, sessionSubagentStatsLine(), activeAgent ? {
			toolCount: pi.getActiveTools().length,
			mcpNames: connectedMcp,
		} : undefined);
	}

	function recordSubagentUsage(usage: SubagentUsage, callStats?: SubagentStats) {
		turnSubagentStats.input += usage.input;
		turnSubagentStats.output += usage.output;
		turnSubagentStats.cacheRead += usage.cacheRead;
		turnSubagentStats.cacheWrite += usage.cacheWrite;
		turnSubagentStats.cost += usage.cost;
		sessionSubagentStats.input += usage.input;
		sessionSubagentStats.output += usage.output;
		sessionSubagentStats.cacheRead += usage.cacheRead;
		sessionSubagentStats.cacheWrite += usage.cacheWrite;
		sessionSubagentStats.cost += usage.cost;
		const model = [usage.provider, usage.model].filter(Boolean).join("/");
		if (model) {
			turnSubagentStats.models.add(model);
			sessionSubagentStats.models.add(model);
		}
		if (callStats) {
			callStats.input += usage.input;
			callStats.output += usage.output;
			callStats.cacheRead += usage.cacheRead;
			callStats.cacheWrite += usage.cacheWrite;
			callStats.cost += usage.cost;
			if (model) callStats.models.add(model);
		}
	}

	function formatElapsed(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		const minutes = Math.floor(ms / 60000);
		return `${minutes}m ${Math.floor((ms % 60000) / 1000)}s`;
	}

	/** Retention window for clean retained subagent worktrees (days); 0 disables auto-prune. */
	function worktreeRetentionDays(): number {
		return config.subagents?.worktree?.retentionDays ?? DEFAULT_WORKTREE_RETENTION_DAYS;
	}

	function worktreeOptions(): { baseDir?: string } {
		return { baseDir: config.subagents?.worktree?.baseDir };
	}

	function formatAge(ms: number): string {
		const value = Math.max(0, ms);
		const minutes = Math.floor(value / 60_000);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return `${hours}h`;
		return `${Math.floor(hours / 24)}d`;
	}

	function describeWorktreeOutcome(branch: string, outcome: RemoveWorktreeResult): string {
		if (!outcome.worktreeRemoved && !outcome.branchRemoved) return `Could not delete ${branch}: ${outcome.reason ?? "unknown error"}`;
		const parts: string[] = [];
		if (outcome.worktreeRemoved) parts.push("worktree removed");
		parts.push(outcome.branchRemoved ? "branch deleted" : "branch kept (unmerged commits)");
		return `${branch}: ${parts.join(", ")}`;
	}

	/** Browse and garbage-collect retained delegation worktrees. */
	async function manageWorktrees(ctx: ExtensionContext) {
		await showWorktreeManager(
			ctx,
			() => {
				const listing = listRetainedWorktrees(ctx.cwd, worktreeOptions());
				const now = Date.now();
				return {
					baseDir: listing.baseDir,
					items: listing.items.map<WorktreeViewItem>((item) => ({
						branch: item.branch,
						path: item.path,
						agent: item.agent,
						ageLabel: formatAge(now - (item.finishedAt ?? item.startedAt)),
						dirty: item.dirty,
						unmerged: item.merged === false,
						stale: !item.dirExists,
						status: item.status,
					})),
				};
			},
			{
				remove: (item) => describeWorktreeOutcome(item.branch, deleteRetainedWorktree(ctx.cwd, item.branch, worktreeOptions())),
				prune: () => {
					const outcome = pruneRetainedWorktrees(ctx.cwd, { ...worktreeOptions(), maxAgeDays: worktreeRetentionDays() });
					const parts = [`Pruned ${outcome.removed.length} worktree${outcome.removed.length === 1 ? "" : "s"}`];
					if (outcome.keptBranches.length > 0) parts.push(`kept ${outcome.keptBranches.length} unmerged branch${outcome.keptBranches.length === 1 ? "" : "es"}`);
					if (outcome.skipped.length > 0) parts.push(`skipped ${outcome.skipped.length}`);
					return parts.join(" · ");
				},
			},
		);
	}

	function subagentStatsLine(stats: SubagentStats = turnSubagentStats, elapsedMs?: number): string | undefined {
		if (stats.calls === 0) return undefined;
		const usage = formatSubagentUsage(stats);
		const duration = elapsedMs === undefined ? "" : ` · took ${formatElapsed(elapsedMs)}`;
		return `stats: ${stats.calls} call${stats.calls === 1 ? "" : "s"}${duration} · ${usage}`;
	}

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

	function normalizeStudioOverride(value: unknown): AgentOverride | undefined {
		if (!value || typeof value !== "object") return undefined;
		const raw = value as Record<string, unknown>;
		const result: AgentOverride = {};
		if (typeof raw.description === "string" && raw.description.trim()) result.description = raw.description.trim();
		if (raw.color === null) result.color = null;
		else if (parseAgentColor(raw.color)) result.color = parseAgentColor(raw.color);
		if (Array.isArray(raw.tools)) result.tools = raw.tools.map(String);
		if (Array.isArray(raw.mcp)) result.mcp = raw.mcp.map(String);
		if (Array.isArray(raw.subagents)) result.subagents = normalizeSubagents(raw.subagents, "session draft") ?? [];
		if (raw.systemPrompt === null || typeof raw.systemPrompt === "string") result.systemPrompt = raw.systemPrompt;
		return Object.keys(result).length > 0 ? result : undefined;
	}

	function restoreStudioDrafts(ctx: ExtensionContext) {
		studioDrafts.clear();
		// Delegated RPC children inherit the parent's unsaved Studio experiments.
		// The payload contains agent fields only; MCP secrets stay in the existing
		// .env hierarchy and are never serialized here.
		try {
			const inherited = JSON.parse(process.env.PI_AGENTS_STUDIO_OVERRIDES ?? "{}") as Record<string, unknown>;
			for (const [name, value] of Object.entries(inherited)) {
				const override = normalizeStudioOverride(value);
				if (override) studioDrafts.set(name, override);
			}
		} catch { /* malformed inherited state is ignored */ }
		// Lightweight SDK/test hosts may expose only part of SessionManager; a
		// missing branch simply means there are no resumable Studio drafts.
		const manager = ctx.sessionManager as typeof ctx.sessionManager & { getBranch?: () => ReturnType<typeof ctx.sessionManager.getBranch> };
		const branch = typeof manager.getBranch === "function" ? manager.getBranch() : [];
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== STUDIO_STATE_ENTRY) continue;
			const data = entry.data as { name?: unknown; override?: unknown } | undefined;
			const name = typeof data?.name === "string" ? data.name : undefined;
			if (!name) continue;
			const override = normalizeStudioOverride(data?.override);
			if (override) studioDrafts.set(name, override);
			else studioDrafts.delete(name);
		}
	}

	function rebuildEffectiveAgents() {
		agents = sourceAgents.map((agent) => applyAgentOverride(agent, studioDrafts.get(agent.name), studioDrafts.has(agent.name)));
	}

	function persistStudioDraft(name: string, override: AgentOverride | undefined) {
		if (override) studioDrafts.set(name, override);
		else studioDrafts.delete(name);
		pi.appendEntry(STUDIO_STATE_ENTRY, { name, override: override ?? null });
		rebuildEffectiveAgents();
	}

	const mcpManager = new McpManager(pi);
	/** Custom tool name -> agent name that registered it (for collision warnings). */
	const customToolOwners = new Map<string, string>();

	// This is registered once, but is added to the active toolset only for
	// agents that explicitly declare the target agent(s) in `subagents`.
	pi.registerTool({
		name: DELEGATE_TOOL,
		label: "Delegate",
		description: `Delegate a focused task to one of the current agent's allowed subagents. Independent delegate calls can run in parallel; useWorktree isolates file changes on a retained Git branch. Results are capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full oversized output is saved to a temporary file.`,
		promptSnippet: "delegate: ask an allowed specialist to complete an isolated task",
		promptGuidelines: [
			"Use delegate only for focused tasks that benefit from a fresh specialist context; include relevant paths, constraints, and expected output in the task.",
			"When several delegate tasks are independent, issue their delegate calls together so they can run in parallel.",
			"Set delegate useWorktree to true for concurrent or experimental file changes; the result reports the retained branch and checkout.",
		],
		parameters: jsonSchemaToTypeBox({
			type: "object",
			properties: {
				agent: { type: "string", description: "Name of an allowed subagent" },
				task: { type: "string", description: "Self-contained task; include relevant paths and expected output" },
				useWorktree: {
					type: "boolean",
					description: "Optional, default false: run the subagent in an isolated worktree on an automatically named branch. The parent checkout stays unchanged.",
				},
			},
			required: ["agent", "task"],
			additionalProperties: false,
		}),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const parent = activeAgent;
			const input = params as { agent?: unknown; task?: unknown; useWorktree?: unknown };
			const agentName = String(input.agent ?? "").trim();
			const task = String(input.task ?? "").trim();
			const useWorktree = input.useWorktree === true;
			const subagent = parent?.subagents?.find((candidate) => candidate.name === agentName);
			if (!subagent) {
				return { content: [{ type: "text", text: `Delegation denied: ${agentName} is not an allowed subagent of ${parent?.name ?? "the current agent"}.` }], details: {} };
			}
			if (!agents.some((a) => a.name === agentName)) {
				return { content: [{ type: "text", text: `Unknown subagent: ${agentName}.` }], details: {} };
			}
			if (!task) return { content: [{ type: "text", text: "Delegation requires a non-empty task." }], details: {} };
			const timeoutSeconds = subagent.timeoutSeconds;
			let worktreeInfo: SubagentWorktreeInfo | undefined;
			try {
				const startedAt = Date.now();
				turnSubagentStats.calls++;
				sessionSubagentStats.calls++;
				const callSubagentStats: SubagentStats = { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
				refreshStatus(ctx);
				// Tool updates replace the previous snapshot in pi's UI. Keep a bounded
				// local buffer so token-sized deltas update one visible block instead of
				// growing an unbounded transcript of progress messages.
				const MAX_PROGRESS_LINES = 15;
				const MAX_PROGRESS_LINE_LENGTH = 160;
				const progressLines: string[] = [];
				let streamedText = "";
				let progressPhase = "starting";
				const boundProgressLines = (lines: string[]) => {
					const bounded: string[] = [];
					for (const line of lines) {
						if (line.length <= MAX_PROGRESS_LINE_LENGTH) bounded.push(line);
						else {
							for (let i = 0; i < line.length; i += MAX_PROGRESS_LINE_LENGTH) {
								bounded.push(line.slice(i, i + MAX_PROGRESS_LINE_LENGTH));
							}
						}
					}
					return bounded.slice(-MAX_PROGRESS_LINES);
				};
				const publish = () => {
					const allLines = [...progressLines, ...streamedText.split("\n")].filter(Boolean);
					const bounded = boundProgressLines(allLines);
					const summary = subagentStatsLine(callSubagentStats, Date.now() - startedAt);
					const progressText = bounded.slice(-MAX_PROGRESS_LINES).join("\n") || "Starting child session…";
					onUpdate?.({
						content: [{ type: "text", text: progressText }],
						details: {
							agent: agentName,
							task,
							model: [...callSubagentStats.models][0] ?? subagent.model,
							status: "running",
							progress: true,
							phase: progressPhase,
							statsLine: summary,
							branch: worktreeInfo?.branch,
							worktreePath: worktreeInfo?.path,
							useWorktree,
						} satisfies DelegateStatsDetails,
					});
				};
				const update = (line: string, phase = line) => {
					progressPhase = phase;
					if (streamedText) {
						progressLines.push(...streamedText.split("\n"));
						streamedText = "";
					}
					progressLines.push(...line.split("\n"));
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
					useWorktree,
					model: subagent.model,
					id: String(toolCallId),
					timeoutSeconds,
					gracefulStopSeconds: config.subagents?.gracefulStopSeconds ?? DEFAULT_GRACEFUL_STOP_SECONDS,
					worktree: config.subagents?.worktree,
					runtimeAgentOverrides: Object.fromEntries(studioDrafts),
					onWorktreeCreated: (worktree) => { worktreeInfo = worktree; },
					onHandle: (handle) => {
						if (handle) runningSubagents.set(handle.id, handle);
						else runningSubagents.delete(String(toolCallId));
						refreshStatus(ctx);
					},
					onProgress: (event) => {
						switch (event.type) {
							case "started": update(`▶ ${event.agent}: running`, "running"); break;
							case "text": progressPhase = "responding"; stream(event.delta); break;
							case "stats": recordSubagentUsage(event.usage, callSubagentStats); refreshStatus(ctx); publish(); break;
							case "tool-start": update(`→ ${event.tool}${formatArgs(event.args)}`, `using ${event.tool}`); break;
							case "tool-update": update(`  ${event.text}`, "tool running"); break;
							case "tool-end": update(`${event.error ? "✗" : "✓"} ${event.tool}`, event.error ? `${event.tool} failed` : "running"); break;
							case "finished": update(`✓ ${agentName}: finished`, "finished"); break;
							case "error": update(`✗ ${event.message}`, "error"); break;
						}
					},
				});
				const truncation = truncateHead(result, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				let visibleResult = truncation.content;
				let fullOutputPath: string | undefined;
				if (truncation.truncated) {
					const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agents-output-"));
					fullOutputPath = path.join(outputDir, `${agentName.replace(/[^a-zA-Z0-9._-]+/g, "-") || "subagent"}.md`);
					await fs.promises.writeFile(fullOutputPath, result, { encoding: "utf8", mode: 0o600 });
					visibleResult += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
				}
				const location = worktreeInfo ? `\n\nBranch: ${worktreeInfo.branch}\nWorktree: ${worktreeInfo.path}` : "";
				return {
					content: [{ type: "text", text: `Result from ${agentName}:\n\n${visibleResult}${location}` }],
					details: {
						agent: agentName,
						task,
						model: [...callSubagentStats.models][0] ?? subagent.model,
						status: "completed",
						statsLine: subagentStatsLine(callSubagentStats, Date.now() - startedAt),
						branch: worktreeInfo?.branch,
						worktreePath: worktreeInfo?.path,
						useWorktree,
						outputTruncated: truncation.truncated,
						fullOutputPath,
					} satisfies DelegateStatsDetails,
				};
			} catch (err) {
				if (err instanceof SubagentStoppedError) {
					const snapshot = err.snapshot;
					const status = err.reason === "timeout" ? "timed_out" : "interrupted";
					const operation = snapshot.currentTool
						? `\nCurrent operation: ${snapshot.currentTool}${formatArgs(snapshot.currentToolArgs)}`
						: `\nPhase: ${snapshot.phase}`;
					const partial = snapshot.partialText.trim() ? `\n\nPartial response:\n${snapshot.partialText.trim()}` : "";
					const reason = err.reason === "timeout"
						? `timed out after ${formatElapsed(Date.now() - snapshot.startedAt)}`
						: err.reason === "user" ? "was interrupted by the user" : "was cancelled";
					const location = worktreeInfo ? `\nWorktree preserved at: ${worktreeInfo.path}` : "";
					return {
						content: [{ type: "text", text: `Subagent ${agentName} ${reason}.${operation}\nLast activity: ${formatElapsed(Date.now() - snapshot.lastActivityAt)} ago.${partial}${location}\n\nChoose a different approach rather than blindly repeating the same delegation.` }],
						details: { agent: agentName, task, model: snapshot.usage?.model ? [snapshot.usage.provider, snapshot.usage.model].filter(Boolean).join("/") : subagent.model, status, error: true, branch: worktreeInfo?.branch, worktreePath: worktreeInfo?.path, useWorktree } satisfies DelegateStatsDetails,
					};
				}
				const location = worktreeInfo ? `\nWorktree preserved at: ${worktreeInfo.path}` : "";
				return {
					content: [{ type: "text", text: `Subagent ${agentName} failed: ${err instanceof Error ? err.message : String(err)}${location}` }],
					details: { agent: agentName, task, model: subagent.model, status: "failed", error: true, branch: worktreeInfo?.branch, worktreePath: worktreeInfo?.path, useWorktree } satisfies DelegateStatsDetails,
				};
			}
		},
		renderCall(args, theme) {
			const call = args as { agent?: unknown; task?: unknown; useWorktree?: unknown };
			const name = typeof call.agent === "string" ? call.agent.trim() : "";
			const model = activeAgent?.subagents?.find(candidate => candidate.name === name)?.model;
			return renderDelegateCall({ ...call, model }, theme);
		},
		renderResult(result, options, theme) {
			return renderDelegateResult(result, options, theme);
		},
	});

	// Keybindings come from config.json (global + project, project wins). The
	// global config is safe to read at load time; project keybindings are added
	// at session_start once the project trust decision is known.
	config = loadConfig(process.cwd(), { includeProject: false });

	// Deny direct file access for the active agent. Bash is intentionally not
	// intercepted here; shell sandboxing is a separate, stronger concern.
	pi.on("tool_call", (event) => {
		const denied = activeAgent?.deniedPaths;
		if (!denied?.length || event.toolName === "bash") return;
		const input = event.input as Record<string, unknown>;
		const target = typeof input.path === "string" ? input.path : undefined;
		if (!target) return;
		if (matchesDeniedPath(target, sessionCwd, denied)) {
			return {
				block: true,
				reason: `Access denied by agent policy: ${target}`,
			};
		}
	});

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
			base = pi.getActiveTools().filter(tool => tool !== DELEGATE_TOOL);
		}
		const allowedSubagents = (agent.subagents ?? []).filter((subagent) => agents.some((candidate) => candidate.name === subagent.name));
		const unknownSubagents = (agent.subagents ?? []).filter((subagent) => !agents.some((candidate) => candidate.name === subagent.name));
		if (unknownSubagents.length > 0 && !opts?.silent) {
			ctx.ui.notify(`Agent "${name}": unknown subagents: ${unknownSubagents.map((subagent) => subagent.name).join(", ")}`, "warning");
		}
		const delegationTools = allowedSubagents.length > 0 ? [DELEGATE_TOOL] : [];
		const active = [...new Set([...base, ...customToolNames, ...mcpToolNames, ...delegationTools])];
		// Apply even when empty: an explicit [] allowlist means "no tools".
		pi.setActiveTools(active);

		activeName = agent.name;
		activeAgent = agent;
		refreshStatus(ctx);
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
		refreshStatus(ctx);
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

	function selectorOptions(ctx: ExtensionContext) {
		const projectAgentsDir = findProjectAgentsDir(ctx.cwd) ?? undefined;
		const projectRoot = findProjectRoot(ctx.cwd);
		const serverNames = [...new Set([
			...Object.keys(config.mcpServers ?? {}),
			...agents.flatMap((agent) => [...(agent.mcp ?? []), ...Object.keys(agent.mcpServers ?? {})]),
		])];
		return {
			projectName: path.basename(projectRoot) || projectRoot,
			projectRoot,
			projectAgentsDir,
			trusted: ctx.isProjectTrusted ? ctx.isProjectTrusted() : true,
			allTools: pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
			activeTools: pi.getActiveTools(),
			mcpServers: config.mcpServers ?? {},
			mcpServerSources: config.mcpServerSources ?? {},
			mcpStatuses: mcpManager.getStatuses(serverNames),
		};
	}

	async function reapplyAgent(name: string, ctx: ExtensionContext, opts?: { silent?: boolean }) {
		if (activeName === name) {
			const oldMcpTools = new Set(Object.values(mcpManager.getStatuses()).flatMap(status => status.toolNames));
			await mcpManager.disconnectAll();
			// Inherited toolsets must not keep stale MCP tools after a failed reconnect.
			pi.setActiveTools(pi.getActiveTools().filter(tool => !oldMcpTools.has(tool)));
		}
		await applyAgent(name, ctx, opts);
	}

	async function editAgent(name: string, ctx: ExtensionContext): Promise<void> {
		const agent = agents.find((candidate) => candidate.name === name);
		if (!agent) return;
		const result = await showAgentStudio(ctx, agent, {
			...selectorOptions(ctx),
			hasSessionDraft: studioDrafts.has(name),
			agents,
			onSetDefault: async () => {
				const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : true;
				const scope = await selectMenu(ctx, `Default agent · ${name}`, SCOPE_MENU.filter(item => trusted || item.id === AgentScope.Global));
				if (!scope) return;
				try {
					const configPath = saveDefaultAgent(ctx.cwd, scope, name);
					config = loadConfig(ctx.cwd, { includeProject: trusted });
					ctx.ui.notify(`Default agent "${name}" saved to ${configPath}.${config.defaultAgent !== name ? ` Project default "${config.defaultAgent}" takes precedence here.` : ""}`, "info");
				} catch (err) {
					ctx.ui.notify(`Could not save default agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
			onTestMcp: async (serverName) => {
				const current = agents.find(candidate => candidate.name === name);
				const server = current?.mcpServers?.[serverName] ?? config.mcpServers?.[serverName];
				if (!current || !server) {
					ctx.ui.notify(`MCP "${serverName}" has no server definition.`, "error");
					return;
				}
				ctx.ui.notify(`Testing MCP "${serverName}" (10s timeout)...`, "info");
				const result = await mcpManager.testConnection(serverName, server, { ...config.env, ...current.env });
				const message = result.ok
					? `MCP "${serverName}": connection successful; ${result.toolCount} tools discovered.`
					: `MCP "${serverName}": ${result.reason}`;
				ctx.ui.notify(message, result.ok ? "info" : "error");
				return message;
			},
			onCredentialsSaved: async () => {
				// Refresh only this agent's secrets, preserving worktree fallbacks and drafts.
				const source = sourceAgents.find(candidate => candidate.name === name);
				if (!source) throw new Error("Edited agent no longer exists");
				source.env = { ...source.env, ...parseEnvFile(fs.readFileSync(path.join(source.dir, ".env"), "utf8")) };
				rebuildEffectiveAgents();
				if (activeName === name) await reapplyAgent(name, ctx);
			},
		});
		if (!result) return;
		if (result.action === "revert") {
			persistStudioDraft(name, undefined);
			if (activeName === name) await reapplyAgent(name, ctx);
			ctx.ui.notify(`Agent "${name}": session draft reverted`, "info");
			return;
		}
		if (result.action === "apply") {
			persistStudioDraft(name, result.override);
			await reapplyAgent(name, ctx);
			ctx.ui.notify(`Agent "${name}": session draft applied`, "info");
			return;
		}

		let savedPath: string;
		if (result.action === "save-source") {
			savedPath = saveAgentSource(agent, result.override);
			for (const scope of agent.savedOverrideSources ?? []) removeAgentOverride(ctx.cwd, scope, name);
		} else {
			const scope = result.action === "save-global" ? "global" : "project";
			savedPath = saveAgentOverride(ctx.cwd, scope, name, result.override);
		}
		persistStudioDraft(name, undefined);
		const discovered = await discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted ? ctx.isProjectTrusted() : true });
		sourceAgents = discovered.agents;
		config = discovered.config;
		rebuildEffectiveAgents();
		await reapplyAgent(name, ctx);
		ctx.ui.notify(`Agent "${name}" saved to ${savedPath}`, "info");
	}

	async function createAgent(ctx: ExtensionContext): Promise<void> {
		const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : true;
		const scope = await selectMenu(ctx, "Create agent · save location", SCOPE_MENU.filter(item => trusted || item.id === AgentScope.Global));
		if (!scope) return;
		const method = await selectMenu(ctx, "Create agent", CREATE_MENU);
		if (!method) return;
		const available = {
			tools: pi.getAllTools().map(tool => tool.name).filter(name => name !== DELEGATE_TOOL && name !== "powershell" && !name.includes("__")),
			mcp: Object.keys(config.mcpServers ?? {}),
		};
		let draft: DeclarativeAgentInput;
		if (method === AuthoringMethod.AI) {
			const generated = await assistAgentDraft(ctx, { name: "", description: "", tools: [], mcp: [], systemPrompt: "" }, available);
			if (!generated) return;
			draft = generated;
		} else {
			const name = (await ctx.ui.input("Agent name", "e.g. developer, browser-verifier"))?.trim();
			if (!name) return;
			const tools = pi.getActiveTools().filter(tool => available.tools.includes(tool));
			draft = { name, description: "", tools, mcp: [], systemPrompt: "" };
			const description = (await editAgentField(ctx, AgentField.Description, draft, available))?.trim();
			if (!description) return;
			draft.description = description;
			const prompt = await editAgentField(ctx, AgentField.SystemPrompt, draft, available);
			if (prompt === undefined) return;
			draft.systemPrompt = prompt;
		}
		const name = draft.name;
		if (agents.some(agent => agent.name === name)) {
			ctx.ui.notify(`Agent "${name}" already exists; select it and press e to edit`, "warning");
			return;
		}
		const color = await chooseAgentColor(ctx, draft.color);
		if (color === undefined) return;
		draft.color = color ?? undefined;
		if (!await ctx.ui.confirm(`Create agent "${name}"?`, `Save the reviewed ${scope} agent, then open Studio. This does not activate it.`)) return;
		try {
			const filePath = saveDeclarativeAgent(ctx.cwd, scope, draft);
			const discovered = await discoverAgents(ctx.cwd, { includeProject: trusted });
			sourceAgents = discovered.agents;
			config = discovered.config;
			rebuildEffectiveAgents();
			ctx.ui.notify(`Created agent "${name}" at ${filePath}`, "info");
			await editAgent(name, ctx);
		} catch (err) {
			ctx.ui.notify(`Could not create agent: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	async function manageAgent(action: "reorder" | "delete", name: string, ctx: ExtensionContext): Promise<void> {
		const agent = agents.find(candidate => candidate.name === name);
		if (!agent) return;
		const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : true;
		try {
			if (action === "reorder") {
				const position = await selectMenu(ctx, `Move "${name}" to position`, agents.map((candidate, index) => ({
					id: String(index), label: `${index + 1} · ${candidate.name}${candidate.name === name ? " (current)" : ""}`,
				})));
				if (position === undefined || Number(position) === agents.indexOf(agent)) return;
				const scope = await selectMenu(ctx, "Save agent order", SCOPE_MENU.filter(item => trusted || item.id === AgentScope.Global));
				if (!scope) return;
				const names = agents.filter(candidate => candidate.name !== name).map(candidate => candidate.name);
				names.splice(Number(position), 0, name);
				const saved = saveAgentOrder(ctx.cwd, scope, names);
				ctx.ui.notify(`Agent order saved to ${saved}${scope === AgentScope.Global && trusted ? " (project order takes precedence)" : ""}`, "info");
			} else {
				if (agent.source === "project" && !trusted) throw new Error("Project is not trusted");
				const dependents = agents.filter(candidate => candidate.subagents?.some(child => child.name === name)).map(candidate => candidate.name);
				const root = agent.source === "global" ? getGlobalAgentsDir() : findProjectAgentsDir(ctx.cwd);
				const folderBased = root !== null
					&& path.resolve(path.dirname(agent.dir)) === path.resolve(root)
					&& ["agent.ts", "index.ts", "agent.json"].includes(path.basename(agent.filePath));
				const target = folderBased ? agent.dir : agent.filePath;
				const message = `Permanently remove ${agent.source} ${folderBased ? "agent folder and ALL its contents (including prompts and credentials)" : "source file"}:\n${target}\nConfig overrides are kept.`
					+ (agent.overrides ? `\nThe overridden ${agent.overrides.source} definition may become visible again.` : "")
					+ (dependents.length ? `\nReferenced by: ${dependents.join(", ")}. These references are not changed.` : "")
					+ (activeName === name ? "\nThe active agent will be cleared." : "");
				if (!await ctx.ui.confirm(`Delete agent "${name}"?`, message)) return;
				if (folderBased) fs.rmSync(target, { recursive: true });
				else fs.unlinkSync(target);
				if (activeName === name) await clearAgent(ctx, { silent: true });
				persistStudioDraft(name, undefined);
				ctx.ui.notify(`Deleted ${target}`, "info");
			}
			const discovered = await discoverAgents(ctx.cwd, { includeProject: trusted });
			sourceAgents = discovered.agents;
			config = discovered.config;
			rebuildEffectiveAgents();
			refreshStatus(ctx);
		} catch (err) {
			ctx.ui.notify(`Could not ${action} agent: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	/** Show the dashboard; Studio actions return to it after closing. */
	async function showPicker(ctx: ExtensionContext) {
		while (true) {
			const result = await showAgentSelector(ctx, agents, activeName, selectorOptions(ctx));
			if (result === null) return;
			if (typeof result === "object") {
				if (result.action === "create") await createAgent(ctx);
				else if (result.action === "edit") await editAgent(result.agent, ctx);
				else await manageAgent(result.action, result.agent, ctx);
				continue;
			}
			if (result === "(none)") await clearAgent(ctx);
			else await applyAgent(result, ctx);
			return;
		}
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

	// --- Trust: worktrees inherit the main checkout's decision ---
	// The extension is installed globally, but project `.pi-agents/` agents and
	// configs are project code (agents are jiti-imported, configs can spawn MCP
	// processes), so they must respect pi's project trust like project-local
	// extensions do. A linked worktree contains the same committed code as its
	// main checkout — when the main checkout is already trusted, trust the
	// worktree without prompting (and remember the decision for next time).
	// Everything else stays undecided and pi's normal trust flow applies.
	pi.on("project_trust", (event) => {
		const cwd = event.cwd;
		// An explicit denial of this folder always stands.
		if (readTrustDecision(cwd) === false) return { trusted: "no" as const };
		if (readTrustDecision(cwd) === true) return { trusted: "undecided" as const }; // already trusted — let pi proceed
		const mainRoot = findMainCheckoutRoot(cwd);
		if (mainRoot && readTrustDecision(mainRoot) === true) {
			return { trusted: "yes" as const, remember: true };
		}
		return { trusted: "undecided" as const };
	});

	// --- UI registration (bindings configurable via config.json, one key or several) ---

	// Keys already registered for this extension instance (defaults + global
	// config at load time); project config may add more at session_start.
	const registeredShortcutKeys = new Set<string>();
	function registerConfiguredShortcuts(
		keys: string[],
		description: string,
		handler: (ctx: ExtensionContext) => Promise<void>,
	) {
		for (const key of keys) {
			if (registeredShortcutKeys.has(key)) continue;
			registeredShortcutKeys.add(key);
			pi.registerShortcut(key as KeyId, { description, handler });
		}
	}

	registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.select, DEFAULT_SELECT_SHORTCUT), "Select agent", async (ctx) => {
		await showPicker(ctx);
	});

	registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.rotate, DEFAULT_ROTATE_SHORTCUT), "Rotate agent", async (ctx) => {
		await rotateAgent(ctx);
	});

	async function inspectSubagents(ctx: ExtensionContext) {
		await showSubagentInspector(
			ctx,
			() => [...runningSubagents.values()],
			config.subagents?.staleWarningMinutes ?? DEFAULT_STALE_WARNING_MINUTES,
		);
	}

	registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.inspect, DEFAULT_INSPECT_SHORTCUT), "Inspect running subagents", inspectSubagents);

	pi.registerCommand("subagents", {
		description: "Inspect running delegated subagents; `/subagents worktrees` manages retained worktrees",
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase();
			if (sub === "worktrees" || sub === "wt") await manageWorktrees(ctx);
			else await inspectSubagents(ctx);
		},
	});

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

	function delegationPrompt(agent: DiscoveredAgent): string | undefined {
		if (!agent.subagents?.length) return undefined;
		const lines = agent.subagents.map((childConfig) => {
			const child = agents.find((candidate) => candidate.name === childConfig.name);
			const runtime = [childConfig.model ? `model ${childConfig.model}` : "default model", childConfig.timeoutSeconds ? `${childConfig.timeoutSeconds}s deadline` : "no deadline"].join(", ");
			return `- ${childConfig.name}: ${child?.description ?? "specialist agent"} (${runtime})`;
		});
		return [
			"You may delegate focused work to these allowed subagents:",
			...lines,
			"Use a self-contained task with relevant paths and expected output. Issue independent delegate calls together to run them in parallel. Use useWorktree:true for isolated file-changing work; its branch and checkout are retained for review.",
		].join("\n");
	}

	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];
		if (activeAgent?.systemPrompt) parts.push(activeAgent.systemPrompt);
		const delegateGuide = activeAgent ? delegationPrompt(activeAgent) : undefined;
		if (delegateGuide) parts.push(delegateGuide);
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
		sessionCwd = ctx.cwd;
		const handoff = event.reason === "new" ? takeSessionHandoff(ctx.cwd, event.previousSessionFile) : undefined;
		sessionSubagentStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
		// Project agents/config are project code: only load them when pi trusts
		// this project (the extension itself is installed globally).
		const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : true;
		if (!trusted && findProjectAgentsDir(ctx.cwd)) {
			ctx.ui.notify("Project .pi-agents/ not loaded — this project folder is not trusted by pi (run /trust)", "warning");
		}
		const result = await discoverAgents(ctx.cwd, { includeProject: trusted });
		sourceAgents = result.agents;
		restoreStudioDrafts(ctx);
		if (handoff) {
			for (const [name, override] of Object.entries(handoff.drafts)) {
				studioDrafts.set(name, override);
				pi.appendEntry(STUDIO_STATE_ENTRY, { name, override });
			}
			if (handoff.model) {
				const model = ctx.modelRegistry.find(handoff.model.provider, handoff.model.id);
				if (!model || !await pi.setModel(model)) ctx.ui.notify(`Could not inherit model ${handoff.model.provider}/${handoff.model.id}; keeping Pi's selected model.`, "warning");
			}
			if (handoff.thinkingLevel !== undefined) pi.setThinkingLevel(handoff.thinkingLevel);
		}
		rebuildEffectiveAgents();
		config = result.config;
		activeName = undefined;
		activeAgent = undefined;

		// Project keybindings (trusted projects) add aliases on top of the
		// defaults + global config registered at load time.
		registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.select, DEFAULT_SELECT_SHORTCUT), "Select agent", async (sc) => { await showPicker(sc); });
		registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.rotate, DEFAULT_ROTATE_SHORTCUT), "Rotate agent", async (sc) => { await rotateAgent(sc); });
		registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.inspect, DEFAULT_INSPECT_SHORTCUT), "Inspect running subagents", inspectSubagents);

		// Restore this session first. A newly-created session has no entries, so
		// inherit the selection from the session it replaced (the OpenCode-style
		// behavior expected from /new and /clone).
		let restored = handoff ? handoff.name : readPersistedName(ctx.sessionManager.getSessionFile());
		if (restored === undefined && (event.reason === "new" || event.reason === "fork")) {
			restored = readPersistedName(event.previousSessionFile);
		}

		// /new keeps the live selection; otherwise --agent > persisted > configured default > source default > first.

		const flag = pi.getFlag("agent");
		let selected: string | undefined;
		if (!handoff && typeof flag === "string" && flag.trim()) {
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
		else refreshStatus(ctx);
		persistedName = activeName;

		if (event.reason === "startup" && ctx.mode === "tui") {
			const projectAgents = agents.filter((agent) => agent.source === "project").length;
			const globalAgents = agents.length - projectAgents;
			const projectRoot = findProjectRoot(ctx.cwd);
			const selectedAgent = activeName ? agents.find((agent) => agent.name === activeName) : undefined;
			const statuses = mcpManager.getStatuses(selectedAgent?.mcp ?? []);
			const connected = Object.values(statuses).filter((status) => status.state === "connected").length;
			ctx.ui.notify(
				`pi-agents: ${path.basename(projectRoot) || projectRoot} · ${projectAgents} project + ${globalAgents} global agents · ${activeName ? `${activeName} active` : "plain pi"}${connected ? ` · ${connected} MCP connected` : ""}`,
				"info",
			);
		}

		// Best-effort retention: remove clean delegated worktrees past the
		// configured age. Dirty worktrees and unmerged branches are never touched.
		const retentionDays = worktreeRetentionDays();
		if (trusted && retentionDays > 0) {
			try {
				const pruned = pruneRetainedWorktrees(ctx.cwd, { ...worktreeOptions(), maxAgeDays: retentionDays });
				if (pruned.removed.length > 0) {
					const kept = pruned.keptBranches.length;
					ctx.ui.notify(
						`pi-agents: pruned ${pruned.removed.length} retained subagent worktree${pruned.removed.length === 1 ? "" : "s"}${kept > 0 ? ` (${kept} unmerged branch${kept === 1 ? "" : "es"} kept)` : ""}`,
						"info",
					);
				}
			} catch { /* not a git repository — nothing to prune */ }
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const selected = activeName;
		restoreStudioDrafts(ctx);
		rebuildEffectiveAgents();
		if (selected && agents.some((agent) => agent.name === selected)) await reapplyAgent(selected, ctx, { silent: true });
	});

	// Close MCP server processes when the session ends.
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "new") {
			storeSessionHandoff(ctx.cwd, ctx.sessionManager.getSessionFile(), {
				name: activeName ?? null,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinkingLevel: pi.getThinkingLevel?.(),
				drafts: Object.fromEntries(studioDrafts),
			});
		}
		for (const handle of runningSubagents.values()) handle.stop("session");
		runningSubagents.clear();
		await mcpManager.disconnectAll();
	});

	pi.on("turn_start", async () => {
		turnSubagentStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
		persistSelection(activeName);
	});
}
