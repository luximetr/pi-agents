import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { applyAgentOverride, discoverAgents, findMainCheckoutRoot, findProjectAgentsDir, findProjectRoot, getGlobalAgentsDir, loadConfig, normalizeSubagents, parseAgentColor, parseEnvFile, readTrustDecision, removeAgentOverride, saveAgentOrder, saveAgentOverride, saveAgentSource, saveDefaultAgent, saveDeclarativeAgent, validateAgentName, type AgentOverride, type DeclarativeAgentInput, type DiscoveredAgent, type PiAgentsConfig } from "./agents.ts";
import { McpManager, jsonSchemaToTypeBox } from "./mcp.ts";
import { storeSessionHandoff, takeSessionHandoff } from "./session-handoff.ts";
import messageTiming from "./message-timing.ts";
import { CompletionInbox, PersistentSubagentBackend, backgroundRunStatus, type BackgroundRunState } from "./background-subagents.ts";
import { SessionCoordination, type CoordinationResult } from "./session-coordination.ts";
import { COORDINATION_GUIDE, SESSION_PLAN_TOOL, sessionPlanTool } from "./session-plan-tool.ts";
import { renderSessionOverview } from "./session-overview.ts";
import { SubagentObserver, OBSERVER_ENV, RUN_ID_ENV, isActiveRun, newRunId } from "./subagent-observer.ts";
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
	updateStatus,
	renderBackgroundCompletions,
	type DelegateViewDetails,
} from "./ui.ts";
import {
	displaySubagentModel,
	formatArgs,
	ROOT_SESSION_ENV,
	SubagentStoppedError,
	runSubagent,
	type SubagentUsage,
	type RunSubagentOptions,
	type SubagentWorkspace,
	type SubagentWorkspaceInfo,
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
const SUBAGENT_CONTROL_TOOL = "subagent_control";

type DelegateStatsDetails = DelegateViewDetails & Partial<SubagentWorkspaceInfo> & {
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
	// Kept in its own module so it can become a standalone package later, while
	// loading automatically with pi-agents today (including legacy installs).
	messageTiming(pi);

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
	let observerContext: ExtensionContext | undefined;
	let coordination: SessionCoordination | undefined;
	let coordinationError: string | undefined;
	let admittedUserUpdateIds: string[] = [];
	let renderOverview: (() => void) | undefined;
	const getCoordination = () => {
		if (!coordination) throw new Error(`Session coordination unavailable: ${coordinationError ?? "session has not started"}`);
		return coordination;
	};
	const coordinationSnapshot = () => {
		try {
			const snapshot = coordination?.snapshot();
			if (snapshot) coordinationError = undefined;
			return snapshot;
		} catch (error) { coordinationError = error instanceof Error ? error.message : String(error); return undefined; }
	};
	const coordinationContext = (deliveredOnly = false) => {
		try { return getCoordination().contextDigest({ deliveredOnly, ...(deliveredOnly ? { admittedUserUpdateIds } : {}) }); }
		catch (error) {
			coordinationError = error instanceof Error ? error.message : String(error);
			return `Session coordination unavailable: ${coordinationError}. Retain unfinished obligations in the current conversation; do not claim they have been saved.`;
		}
	};
	pi.registerTool(sessionPlanTool(getCoordination, () => renderOverview?.()));
	const createObserver = () => new SubagentObserver(process.env[OBSERVER_ENV], () => {
		if (observerContext) refreshStatus(observerContext);
	});
	let observer = createObserver();

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
		const runs = observer.handles().map(handle => handle.snapshot());
		const running = runs.filter(isActiveRun).length;
		if (runs.length) parts.push(`${running} active / ${runs.length} runs · f9 explorer`);
		if (sessionSubagentStats.calls > 0) {
			const usage = formatSubagentUsage(sessionSubagentStats);
			parts.push(`${sessionSubagentStats.calls} call${sessionSubagentStats.calls === 1 ? "" : "s"}${usage ? ` · ${usage}` : ""}`);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	function refreshStatus(ctx: ExtensionContext) {
		renderOverview?.();
		const assigned = activeAgent?.mcp ?? [];
		const statuses = mcpManager.getStatuses(assigned);
		const connectedMcp = assigned.filter((name) => statuses[name]?.state === "connected");
		updateStatus(ctx, activeAgent, sessionSubagentStatsLine(), activeAgent ? {
			toolCount: pi.getActiveTools().length,
			mcpNames: connectedMcp,
		} : undefined);
	}

	function recordSubagentUsage(usage: SubagentUsage, callStats?: SubagentStats, turnStats = turnSubagentStats) {
		turnStats.input += usage.input;
		turnStats.output += usage.output;
		turnStats.cacheRead += usage.cacheRead;
		turnStats.cacheWrite += usage.cacheWrite;
		turnStats.cost += usage.cost;
		sessionSubagentStats.input += usage.input;
		sessionSubagentStats.output += usage.output;
		sessionSubagentStats.cacheRead += usage.cacheRead;
		sessionSubagentStats.cacheWrite += usage.cacheWrite;
		sessionSubagentStats.cost += usage.cost;
		const model = [usage.provider, usage.model].filter(Boolean).join("/");
		if (model) {
			turnStats.models.add(model);
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

	type TaskThread = Partial<SubagentWorkspaceInfo> & { workspace: SubagentWorkspace; id: string; owner: string; agent: string; cwd: string; model?: string; rootSessionId: string; latestRunId: string };
	type BackgroundResult = Partial<SubagentWorkspaceInfo> & { runId: string; agent: string; task: string; text: string; details: DelegateStatsDetails };
	const workspaceMetadata = (value: Partial<SubagentWorkspaceInfo>): Partial<SubagentWorkspaceInfo> => Object.fromEntries(
		(["workspace", "workspaceCwd", "worktreePath", "workspaceBaseCommit", "workspaceBranch"] as const)
			.filter(key => value[key] !== undefined).map(key => [key, value[key]]),
	);
	// Both foreground and background runs remain replyable in this runtime.
	const backgroundRuns = new Map<string, BackgroundRunState & { controller: AbortController; thread: TaskThread; background: boolean; result?: string; viewResult?: { content: { type: "text"; text: string }[]; details: DelegateStatsDetails }; invalidate?: () => void; persisted?: boolean; recoverable?: boolean; historyError?: string; savedAt?: number }>();
	let taskBackend: PersistentSubagentBackend | undefined;
	let taskHistoryError: string | undefined;
	let taskRootSessionId: string | undefined;
	let taskProjectCwd: string | undefined;
	let historyDiagnostics: Array<{ threadId: string; error?: string }> = [];
	async function refreshPersistedTasks() {
		if (!taskBackend) return;
		const backend = taskBackend;
		const rows = await backend.list();
		if (backend !== taskBackend) return;
		for (const [id, run] of backgroundRuns) if (run.persisted) backgroundRuns.delete(id);
		historyDiagnostics = [];
		for (const row of rows) {
			const record = row.record;
			if (!record) { historyDiagnostics.push({ threadId: row.threadId, error: row.error }); continue; }
			const existing = backgroundRuns.get(record.latestRunId);
			if (existing) { Object.assign(existing, { recoverable: row.recoverable, savedAt: record.checkpoint?.at, historyError: row.error }); continue; }
			const thread: TaskThread = { id: record.threadId, owner: record.owner, agent: record.agent, cwd: record.workspace.project.path,
				model: record.model, rootSessionId: record.rootSessionId, latestRunId: record.latestRunId,
				workspace: record.workspace.mode, workspaceCwd: record.workspace.cwd.path,
				...("workspaceInfo" in row ? row.workspaceInfo : {}) };
			backgroundRuns.set(record.latestRunId, { controller: new AbortController(), thread, background: false, persisted: true,
				agent: record.agent, task: "[Saved conversation; recovery requires a new instruction]", model: record.model,
				...workspaceMetadata(thread), status: record.status, startedAt: record.createdAt, endedAt: record.updatedAt,
				recoverable: row.recoverable, savedAt: record.checkpoint?.at, historyError: row.error,
				viewResult: {
					content: [{ type: "text", text: `Saved task ${record.status}. Result preview was not retained separately. ${row.error ?? (record.checkpoint ? `Safe checkpoint: ${new Date(record.checkpoint.at).toISOString()}. Later work may already have changed the workspace.` : "No safe checkpoint exists.")} Use /task-history list or explicit recover with a new instruction.` }],
					details: { agent: record.agent, model: record.model, status: record.status, restored: true, ...workspaceMetadata(thread) },
				} });
		}
	}
	let threadSessionDir = path.join(os.tmpdir(), `pi-agents-threads-${randomUUID()}`);
	const pendingRuns = new Set<Promise<unknown>>();
	let sessionGeneration = 0;
	// Orca observes this shared lifecycle channel to keep the pane working
	// after the main agent settles. Use run IDs, not child process IDs.
	const emitBackgroundLifecycle = (runId: string, agent: string, status: "started" | "completed" | "failed" | "aborted") => {
		pi.events?.emit("task:subagent:lifecycle", { runId, agent, status });
	};
	const completionMessage = (results: BackgroundResult[]) => ({
		customType: "pi-agents-completions",
		content: ["Subagent results awaiting reconciliation. Delivery does not mark them handled or complete checklist items. Inspect full reports with session_plan result (runId); explicitly update handling and resume unfinished user work.",
			...results.slice(0, 8).map(result => {
				const saved = coordinationSnapshot()?.results.find(item => item.runId === result.runId);
				return `Run: ${result.runId} · ${result.agent} · ${result.details.status ?? "completed"}${saved?.taskId ? ` · task ${saved.taskId}${saved.itemId ? ` / ${saved.itemId}` : ""}` : ""}\n${(saved?.summary ?? result.text).slice(0, 600)}`;
			}), ...(results.length > 8 ? [`${results.length - 8} more reports retained. Use session_plan list/inspect.`] : [])].join("\n\n"),
		display: true,
		details: { runs: results.map(result => result.runId), results },
	});
	pi.registerMessageRenderer("pi-agents-completions", renderBackgroundCompletions);
	const createInbox = () => new CompletionInbox<BackgroundResult>(
		() => !!observerContext?.isIdle() && !observerContext.hasPendingMessages(),
		results => {
			const saved = coordinationSnapshot()?.results;
			const ready = results.filter(result => {
				const handling = saved?.find(item => item.runId === result.runId)?.handling;
				return handling !== "incorporated" && handling !== "deferred";
			});
			if (ready.length) {
				pi.sendMessage(completionMessage(ready), { triggerTurn: true, deliverAs: "followUp" });
				markCompletionsDelivered(ready);
			}
		},
	);
	function markCompletionsDelivered(results: BackgroundResult[]) {
		try { coordination?.markDelivered(results.map(result => result.runId)); }
		catch (error) { observerContext?.ui.notify(`Could not save result delivery: ${error instanceof Error ? error.message : error}`, "warning"); }
		renderOverview?.();
	}
	let inbox = createInbox();
	pi.on("agent_start", (_event, ctx) => {
		observerContext = ctx;
		inbox.start();
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") inbox.assistantMessageEnded(event.message.stopReason);
	});
	pi.on("agent_settled", () => inbox.settle());
	pi.on("input", (event, ctx) => {
		inbox.resume();
		if (event.text?.trim() && event.source !== "extension") {
			try {
				const id = coordination?.captureUserMessage(event.text);
				if (id && event.streamingBehavior === "steer") admittedUserUpdateIds.push(id);
			}
			catch (error) { ctx.ui.notify(`Could not retain user input: ${error instanceof Error ? error.message : error}`, "warning"); }
			renderOverview?.();
		}
	});

	const mcpManager = new McpManager(pi);
	/** Custom tool name -> agent name that registered it (for collision warnings). */
	const customToolOwners = new Map<string, string>();

	const executeDelegation: ToolDefinition["execute"] = async (toolCallId, params, signal, onUpdate, ctx) => {
			const parent = activeAgent;
			const input = params as { agent?: unknown; task?: unknown; taskId?: string; itemId?: string; background?: boolean; replyRunId?: string; recoverRunId?: string; workspace?: SubagentWorkspace };
			if (taskHistoryError) throw new Error(`Persistent task storage unavailable: ${taskHistoryError}. Fix storage and reload Pi; no temporary fallback was used.`);
			const backend = taskBackend;
			if (backend && fs.realpathSync(ctx.cwd) !== taskProjectCwd) throw new Error("Task project changed since session startup. Reopen the original project/session; durable tasks never silently change workspaces.");
			if (input.workspace !== undefined && input.workspace !== "shared" && input.workspace !== "worktree") throw new Error("workspace must be 'shared' or 'worktree'");
			const agentName = String(input.agent ?? "").trim();
			const task = String(input.task ?? "").trim();
			const subagent = parent?.subagents?.find((candidate) => candidate.name === agentName);
			if (!subagent) {
				return { content: [{ type: "text", text: `Delegation denied: ${agentName} is not an allowed subagent of ${parent?.name ?? "the current agent"}.` }], details: {} };
			}
			if (!agents.some((a) => a.name === agentName)) {
				return { content: [{ type: "text", text: `Unknown subagent: ${agentName}.` }], details: {} };
			}
			if (!task) return { content: [{ type: "text", text: "Delegation requires a non-empty task." }], details: {} };
			const timeoutSeconds = subagent.timeoutSeconds;
			const previousRunId = input.recoverRunId ?? input.replyRunId;
			const previousRun = previousRunId ? backgroundRuns.get(previousRunId) : undefined;
			if (previousRunId && !previousRun) throw new Error("Unknown run ID.");
			if (input.recoverRunId && !backend) throw new Error("Recovery requires available task storage and a saved conversation.");
			if (previousRun) {
				if (previousRun.thread.owner !== parent!.name || previousRun.thread.agent !== agentName || fs.realpathSync(previousRun.thread.cwd) !== fs.realpathSync(ctx.cwd)) throw new Error("Reply denied: this thread belongs to another parent, agent, or workspace.");
				if (previousRun.thread.latestRunId !== previousRunId) throw new Error(`Reply to the latest run instead: ${previousRun.thread.latestRunId}`);
				if (previousRun.status === "running") throw new Error("Thread is busy; use steer on the active run.");
				if (!input.recoverRunId && previousRun.status !== "completed") throw new Error("Only completed runs can receive replies. Use explicit recover with a new instruction or start a fresh delegation.");
			}
			if (previousRun && input.workspace !== undefined && input.workspace !== previousRun.thread.workspace) throw new Error("Cannot change workspace mode for an existing thread.");
			const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const thinkingLevel = pi.getThinkingLevel?.();
			const selectedModel = previousRun ? previousRun.thread.model : subagent.model ?? (inheritedModel && thinkingLevel ? `${inheritedModel}:${thinkingLevel}` : inheritedModel);
			const runId = newRunId();
			const runCoordination = getCoordination();
			const state = runCoordination.snapshot();
			const priorLink = previousRunId ? state.runs.find(run => run.runId === previousRunId) : undefined;
			let continuationItemId = priorLink?.itemId;
			if (priorLink) {
				// A fresh, explicitly requested continuation reopens its own obligation.
				// It does not acknowledge the previous report or complete checklist items.
				const parentTask = state.tasks.find(task => task.id === priorLink.taskId)!;
				if (parentTask.status === "completed" || parentTask.status === "superseded") runCoordination.updateTask(parentTask.id, { status: "active", amendment: `Follow-up instruction: ${task}` });
				const item = parentTask.items.find(item => item.id === priorLink.itemId);
				if (item?.status === "completed" || item?.status === "superseded") continuationItemId = runCoordination.addItem(parentTask.id, { text: `Follow up: ${task}`, owner: item.owner, dependsOn: [item.id] }).id;
			}
			// Unlinked calls get their own obligation instead of guessing a task from stale focus.
			const taskId = priorLink?.taskId ?? input.taskId ?? runCoordination.createTask({ title: task.split("\n")[0].slice(0, 120), objective: task, owner: parent!.name, items: [{ id: "work", text: task.split("\n")[0].slice(0, 160), status: "in_progress", owner: agentName }] }).id;
			runCoordination.linkRun(runId, { taskId, itemId: continuationItemId ?? input.itemId ?? (!priorLink && !input.taskId ? "work" : undefined), agent: agentName, task });
			const thread: TaskThread = previousRun?.thread ?? {
				id: `thread-${randomUUID()}`, owner: parent!.name, agent: agentName, cwd: ctx.cwd, model: selectedModel,
				workspace: input.workspace ?? "shared",
				workspaceCwd: (input.workspace ?? "shared") === "shared" ? ctx.cwd : undefined,
				rootSessionId: taskRootSessionId ?? process.env[ROOT_SESSION_ENV] ?? (ctx.sessionManager as typeof ctx.sessionManager & { getSessionId?: () => string }).getSessionId?.() ?? randomUUID(),
				latestRunId: runId,
			};
			const runWorkspace = workspaceMetadata(thread);
			// Reserve synchronously before any await, including concurrent reply calls.
			thread.latestRunId = runId;
			const sessionDir = threadSessionDir;
			const generation = sessionGeneration;
			const runObserver = observer;
			const runTurnStats = turnSubagentStats;
			const background = input.background === true;
			const controller = new AbortController();
			const runStartedAt = Date.now();
			let fullRunReport: string | undefined;
			backgroundRuns.set(runId, { ...runWorkspace, agent: agentName, task, controller, thread, background, status: "running", model: selectedModel, startedAt: runStartedAt,
				deadlineAt: timeoutSeconds === undefined ? undefined : runStartedAt + timeoutSeconds * 1000 });
			renderOverview?.();
			if (background) emitBackgroundLifecycle(runId, agentName, "started");
			const executeRun = async (): Promise<{ content: { type: "text"; text: string }[]; details: DelegateStatsDetails }> => {
			try {
				observerContext = ctx;
				let observerEndpoint: string | undefined;
				try { observerEndpoint = await runObserver.start(); }
				catch (error) { ctx.ui.notify(`Agent Explorer connection unavailable: ${error instanceof Error ? error.message : String(error)}. Direct runs remain inspectable.`, "warning"); }
				if (generation !== sessionGeneration) throw new Error("Session closed before subagent started");
				const startedAt = Date.now();
				runTurnStats.calls++;
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
					if (background) return;
					onUpdate?.({
						content: [{ type: "text", text: progressText }],
						details: {
							...runWorkspace,
							agent: agentName,
							task,
							model: displaySubagentModel(selectedModel, [...callSubagentStats.models][0]),
							status: "running",
							progress: true,
							phase: progressPhase,
							statsLine: summary,
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
				const runSignal = background || !signal ? controller.signal : AbortSignal.any([signal, controller.signal]);
				const runOptions: RunSubagentOptions = {
					model: selectedModel,
					workspace: thread.workspace,
					rootSessionId: thread.rootSessionId,
					threadId: thread.id,
					resume: !!previousRun,
					participantSessionDir: sessionDir,
					id: runId,
					observerEndpoint,
					parentRunId: process.env[RUN_ID_ENV],
					onSnapshot: snapshot => {
						const metadata = workspaceMetadata(snapshot);
						Object.assign(runWorkspace, metadata);
						Object.assign(thread, metadata);
						if (generation === sessionGeneration) Object.assign(backgroundRuns.get(runId)!, metadata);
						runObserver.publish(snapshot);
					},
					timeoutSeconds,
					gracefulStopSeconds: config.subagents?.gracefulStopSeconds ?? DEFAULT_GRACEFUL_STOP_SECONDS,
					runtimeAgentOverrides: Object.fromEntries(studioDrafts),
					onHandle: (handle) => {
						if (handle) runObserver.attach(handle);
						refreshStatus(ctx);
					},
					onProgress: (event) => {
						if (generation !== sessionGeneration) return;
						switch (event.type) {
							case "started": update(`▶ ${event.agent}: running`, "running"); break;
							case "text": progressPhase = "responding"; stream(event.delta); break;
							case "stats": recordSubagentUsage(event.usage, callSubagentStats, runTurnStats); refreshStatus(ctx); publish(); break;
							case "tool-start": update(`→ ${event.tool}${formatArgs(event.args)}`, `using ${event.tool}`); break;
							case "tool-update": update(`  ${event.text}`, "tool running"); break;
							case "tool-end": update(`${event.error ? "✗" : "✓"} ${event.tool}`, event.error ? `${event.tool} failed` : "running"); break;
							case "finished": update(`✓ ${agentName}: finished`, "finished"); break;
							case "error": update(`✗ ${event.message}`, "error"); break;
						}
					},
				};
				let result: string;
				let historyWarning: string | undefined;
				if (backend) {
					const request = { threadId: thread.id, runId, owner: thread.owner, agent: agentName, instruction: task };
					const output = previousRunId
						? await backend.recover({ ...request, latestRunId: previousRunId }, runSignal, runOptions)
						: await backend.run({ ...request, workspace: thread.workspace }, runSignal, runOptions);
					result = output.text;
					historyWarning = output.historyWarning;
					if (output.recovery) historyWarning = [historyWarning, `Continued from checkpoint ${new Date(output.recovery.savedAt).toISOString()}; later work may not be in the saved conversation.`].filter(Boolean).join("\n");
				} else result = await runSubagent(agentName, task, ctx.cwd, runSignal, runOptions);
				fullRunReport = result + (historyWarning ? `\n\n${historyWarning}` : "");
				const truncation = truncateHead(result, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				let visibleResult = truncation.content;
				if (historyWarning) visibleResult += `\n\n${historyWarning}`;
				let fullOutputPath: string | undefined;
				if (truncation.truncated) {
					const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agents-output-"));
					fullOutputPath = path.join(outputDir, `${agentName.replace(/[^a-zA-Z0-9._-]+/g, "-") || "subagent"}.md`);
					await fs.promises.writeFile(fullOutputPath, result, { encoding: "utf8", mode: 0o600 });
					visibleResult += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
				}
				return {
					content: [{ type: "text", text: `Result from ${agentName}:\n\n${visibleResult}` }],
					details: {
						agent: agentName,
						task,
						model: displaySubagentModel(selectedModel, [...callSubagentStats.models][0]),
						status: "completed",
						statsLine: subagentStatsLine(callSubagentStats, Date.now() - startedAt),
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
					return {
						content: [{ type: "text", text: `Subagent ${agentName} ${reason}.${operation}\nLast activity: ${formatElapsed(Date.now() - snapshot.lastActivityAt)} ago.${partial}\n\nChoose a different approach rather than blindly repeating the same delegation.` }],
						details: { agent: agentName, task, model: displaySubagentModel(selectedModel, snapshot.usage?.model ? [snapshot.usage.provider, snapshot.usage.model].filter(Boolean).join("/") : undefined), status, error: true } satisfies DelegateStatsDetails,
					};
				}
				return {
					content: [{ type: "text", text: `Subagent ${agentName} failed: ${err instanceof Error ? err.message : String(err)}` }],
					details: { agent: agentName, task, model: selectedModel, status: "failed", error: true } satisfies DelegateStatsDetails,
				};
			}
			};
			const execution = executeRun().then(async result => {
				// A denied/preflight-failed recovery must not consume the previous latest run.
				if (backend && previousRunId && result.details.error) {
					try {
						const saved = (await backend.list()).find(row => row.record?.threadId === thread.id)?.record;
						if (saved) thread.latestRunId = saved.latestRunId;
					} catch { /* Keep the failure visible; disk remains authoritative. */ }
				}
				result.content[0].text += `\n\nThread ID: ${thread.id}\nRun ID: ${runId}`;
				Object.assign(result.details, runWorkspace, { threadId: thread.id, runId });
				result.content[0].text += `\nWorkspace: ${thread.workspace}${runWorkspace.workspaceCwd ? `\nCwd: ${runWorkspace.workspaceCwd}` : ""}`;
				if (runWorkspace.worktreePath) result.content[0].text += `\nWorktree: ${runWorkspace.worktreePath}\nBase commit: ${runWorkspace.workspaceBaseCommit}\nChanges are retained; review/apply manually (not merged).`;
				try {
					const report = fullRunReport === undefined ? result.content.map(item => item.text).join("\n")
						: `Result from ${agentName}:\n\n${fullRunReport}\n\nThread ID: ${thread.id}\nRun ID: ${runId}\nWorkspace: ${thread.workspace}${runWorkspace.workspaceCwd ? `\nCwd: ${runWorkspace.workspaceCwd}` : ""}${runWorkspace.worktreePath ? `\nWorktree: ${runWorkspace.worktreePath}\nBase commit: ${runWorkspace.workspaceBaseCommit}\nChanges retained; review/apply manually (not merged).` : ""}`;
					runCoordination.recordResult({ runId, agent: agentName, task, text: report, executionStatus: result.details.status as CoordinationResult["executionStatus"] });
					if (!background) runCoordination.markDelivered([runId]);
				} catch (error) {
					ctx.ui.notify(`Could not retain result ${runId}: ${error instanceof Error ? error.message : error}. Its report remains in this run's output.`, "warning");
				}
				if (generation !== sessionGeneration) return result;
				const run = backgroundRuns.get(runId)!;
				try { await refreshPersistedTasks(); }
				catch { run.recoverable = false; }
				if (generation !== sessionGeneration) return result;
				run.status = result.details.status ?? "completed";
				run.endedAt = Date.now();
				run.result = result.content.map(item => item.text).join("\n");
				// Runtime-only rendering state: never serialize callbacks into history.
				run.viewResult = result;
				const invalidate = run.invalidate;
				run.invalidate = undefined;
				try { invalidate?.(); } catch { /* Rendering must not suppress completion delivery. */ }
				if (background) {
					emitBackgroundLifecycle(runId, agentName, run.status === "completed" ? "completed" : run.status === "interrupted" ? "aborted" : "failed");
					inbox.push({ ...runWorkspace, runId, agent: agentName, task, text: run.result, details: result.details });
				}
				renderOverview?.();
				return result;
			});
			pendingRuns.add(execution);
			void execution.finally(() => pendingRuns.delete(execution)).catch(() => {});
			if (!background) return execution;
			return {
				content: [{ type: "text", text: `Started background subagent ${agentName}. Run ID: ${runId}. Thread ID: ${thread.id}. Workspace: ${thread.workspace}. Continue working or respond to the user; completion will be delivered after your current flow finishes.` }],
				details: { ...runWorkspace, agent: agentName, task, runId, threadId: thread.id, status: "running" },
			};
	};

	pi.registerTool({
		name: DELEGATE_TOOL,
		label: "Delegate",
		description: `Start a fresh, isolated task thread with an allowed subagent. workspace: shared (default) uses parent cwd; worktree creates a retained Git worktree from parent HEAD without uncommitted changes, with no automatic merge. Replies reuse the same workspace. Independent tasks, including tasks for the same agent, run in parallel. Use background: true to return runId and threadId immediately; completion arrives after the main agent settles. Use subagent_control reply on a completed run to continue its conversation, or steer while running. Results are capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; oversized output is saved to a file.`,
		promptSnippet: "delegate: start a fresh task with an allowed specialist",
		promptGuidelines: [
			"Each delegate call starts a fresh conversation. Include relevant paths, constraints, and expected output.",
			"Choose workspace per call: shared (default) uses current files; worktree starts from parent HEAD without uncommitted changes. Worktree changes are retained, not merged. Replies reuse the same directory.",
			"Issue independent tasks together for parallel execution. Use subagent_control reply, not another delegate, to answer a worker's question or continue its task.",
		],
		parameters: jsonSchemaToTypeBox({
			type: "object",
			properties: {
				agent: { type: "string", description: "Name of an allowed subagent" },
				task: { type: "string", description: "Self-contained task" },
				background: { type: "boolean", description: "Run in the background (default false)" },
				taskId: { type: "string", description: "Originating session_plan task ID; omitted IDs create a separate task with a checklist" },
				itemId: { type: "string", description: "Originating checklist item ID within taskId" },
				workspace: { type: "string", enum: ["shared", "worktree"], description: "Workspace for this new thread: shared (default) uses parent cwd; worktree isolates parent HEAD without uncommitted changes. Replies reuse it; changes require manual review/apply." },
			},
			required: ["agent", "task"], additionalProperties: false,
		}),
		execute: executeDelegation,
		renderCall(args, theme) {
			const call = args as { agent?: unknown; task?: unknown };
			const name = typeof call.agent === "string" ? call.agent.trim() : "";
			const configured = activeAgent?.subagents?.find(candidate => candidate.name === name)?.model;
			const inherited = observerContext?.model;
			const level = pi.getThinkingLevel?.();
			const model = configured ?? (inherited ? `${inherited.provider}/${inherited.id}${level ? `:${level}` : ""}` : undefined);
			return renderDelegateCall({ ...call, model }, theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { runId?: string; status?: string; agent?: string } | undefined;
			const run = details?.runId ? backgroundRuns.get(details.runId) : undefined;
			if (run?.background && run.status === "running") run.invalidate = context?.invalidate;
			if (!run && details?.runId && details.status === "running" && !options.isPartial) {
				// Old acknowledgement without matching durable metadata is NOT evidence
				// of a live child, nor proof it completed. Do not fabricate a result.
				return renderDelegateResult({ content: [{ type: "text", text: "No live owner or retained terminal metadata for this run. It may have completed or been interrupted. Use /task-history list; nothing was restarted." }], details: { ...details, status: "unavailable" } }, options, theme);
			}
			return renderDelegateResult(run?.viewResult ?? result, options, theme);
		},
	});

	const controlSubagent: ToolDefinition["execute"] = async (_id, params, signal, onUpdate, ctx) => {
		const { action, runId, message } = params as { action: string; runId?: string; message?: string };
		const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
		if (["list", "status", "recover", "delete"].includes(action)) await refreshPersistedTasks();
		const snapshots = new Map(observer.handles().map(handle => [handle.id, handle.snapshot()]));
		const status = (id: string, run: NonNullable<ReturnType<typeof backgroundRuns.get>>) => ({ ...backgroundRunStatus(id, run, snapshots.get(id)),
			threadId: run.thread.id, latestRunId: run.thread.latestRunId, persisted: run.persisted, recoverable: run.recoverable,
			savedAt: run.savedAt, historyError: run.historyError });
		if (action === "list") return reply(taskHistoryError ? `Task history unavailable: ${taskHistoryError}` : JSON.stringify([...Array.from(backgroundRuns, ([id, run]) => status(id, run)), ...historyDiagnostics]));
		const run = runId ? backgroundRuns.get(runId) : undefined;
		if (action === "result" && runId) {
			const saved = coordinationSnapshot()?.results.find(result => result.runId === runId);
			if (saved) return { ...reply(saved.text), details: { ...(run ? workspaceMetadata(run) : {}), runId, threadId: run?.thread.id, status: saved.executionStatus, taskId: saved.taskId, itemId: saved.itemId, handling: saved.handling } };
		}
		if (!run || !runId) return reply(taskHistoryError ? `Task history unavailable: ${taskHistoryError}` : "Unknown run ID. Use list in the original project and root session.");
		if (action === "status") return reply(JSON.stringify(status(runId, run)));
		if (action === "reply" || action === "recover") {
			if (!message?.trim()) throw new Error(`${action} requires a fresh, non-empty instruction; tasks never restart automatically.`);
			if (action === "recover" && !taskBackend) throw new Error("Recovery requires available task storage and saved history.");
			return executeDelegation(_id, { agent: run.agent, task: message.trim(), background: true, [action === "recover" ? "recoverRunId" : "replyRunId"]: runId }, signal, onUpdate, ctx);
		}
		if (action === "delete") {
			if (!taskBackend) throw new Error("Persistent task history is not enabled.");
			if (activeAgent?.name !== run.thread.owner) throw new Error(`Select the owning parent agent (${run.thread.owner}) before deleting its history.`);
			if (run.status === "running") throw new Error("Stop the active task and wait for child exit before deleting history.");
			await taskBackend.delete(run.thread.id);
			for (const [id, related] of backgroundRuns) if (related.thread.id === run.thread.id) backgroundRuns.delete(id);
			return reply("Task conversation deleted. Workspace/worktree files were not removed. Parent-session messages and external backups are unaffected.");
		}
		if (action === "result") return { ...reply(run.result ?? `Run ${runId} is ${run.status}. ${run.persisted ? "The result preview was not retained separately. Use explicit recover with a new instruction to continue its saved conversation." : ""}`), details: { ...workspaceMetadata(run), runId, threadId: run.thread.id, status: run.status } };
		if (run.status !== "running") return reply(`Run ${runId} is ${run.status}.`);
		const handle = observer.handles().find(handle => handle.id === runId);
		if (action === "stop") {
			observer.stopTree(runId, "user");
			run.controller.abort();
			return reply(`Stop requested for ${runId}.`);
		}
		if (action === "steer") {
			if (!message?.trim()) return reply("Steer requires a non-empty message.");
			return reply(handle?.steer(message) ? `Instructions sent to ${runId}.` : "Run is not ready for steering; try again later.");
		}
		return reply("Unknown action.");
	};
	pi.registerTool({
		name: SUBAGENT_CONTROL_TOOL,
		label: "Subagent control",
		description: "List session-owned live and saved tasks, inspect status/results, steer/stop active runs, or reply to completed runs. Task history is retained by default; recover explicitly continues a saved completed/interrupted/failed task using a fresh message and the last safe checkpoint; later workspace effects may already exist. Nothing restarts automatically. Delete removes saved conversation, never workspace/worktrees. Busy threads require steer; stale run IDs are rejected.",
		parameters: jsonSchemaToTypeBox({
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "status", "result", "reply", "recover", "delete", "steer", "stop"] },
				runId: { type: "string", description: "Run ID returned by delegate/list; required except for list" },
				message: { type: "string", description: "Fresh instruction for reply/recover/steer; never reuse the original task automatically" },
			},
			required: ["action"], additionalProperties: false,
		}),
		execute: controlSubagent,
	});

	pi.registerCommand("task-history", {
		description: "Saved tasks: list | status <runId> | recover <runId> <new instruction> | delete <runId> | prune <days>",
		handler: async (args, ctx) => {
			try {
				if (!taskBackend) throw new Error(taskHistoryError ?? "Task history storage is unavailable. Fix storage and reload Pi.");
				const [action = "list", runId, ...words] = args.trim().split(/\s+/).filter(Boolean);
				if (action === "prune") {
					const days = Number(runId);
					if (!Number.isFinite(days) || days < 0 || !runId || words.length) throw new Error("Usage: /task-history prune <non-negative days>");
					if (!await ctx.ui.confirm("Delete saved task conversations?", `Remove terminal histories older than ${days} days in this root session/project. Worktrees remain.`)) return;
					const deleted = await taskBackend.prune(Math.max(0, Math.floor(Date.now() - days * 86400000)));
					for (const [id, run] of backgroundRuns) if (deleted.includes(run.thread.id)) backgroundRuns.delete(id);
					ctx.ui.notify(`Deleted ${deleted.length} task histories; workspaces retained.`, "info");
					return;
				}
				if (!["list", "status", "recover", "delete"].includes(action)) throw new Error("Usage: /task-history list | status <runId> | recover <runId> <new instruction> | delete <runId> | prune <days>");
				if (action === "delete" && !await ctx.ui.confirm("Delete task conversation?", `Delete history for ${runId}? Workspace/worktree and parent-session messages remain.`)) return;
				const result = await controlSubagent(`history-${randomUUID()}`, { action, runId, message: words.join(" ") }, undefined, undefined, ctx);
				ctx.ui.notify(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
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
			base = pi.getActiveTools().filter(tool => tool !== DELEGATE_TOOL && tool !== SUBAGENT_CONTROL_TOOL);
		}
		const allowedSubagents = (agent.subagents ?? []).filter((subagent) => agents.some((candidate) => candidate.name === subagent.name));
		const unknownSubagents = (agent.subagents ?? []).filter((subagent) => !agents.some((candidate) => candidate.name === subagent.name));
		if (unknownSubagents.length > 0 && !opts?.silent) {
			ctx.ui.notify(`Agent "${name}": unknown subagents: ${unknownSubagents.map((subagent) => subagent.name).join(", ")}`, "warning");
		}
		const delegationTools = allowedSubagents.length > 0 ? [DELEGATE_TOOL, SUBAGENT_CONTROL_TOOL] : [];
		const active = [...new Set([...base, ...customToolNames, ...mcpToolNames, ...delegationTools, SESSION_PLAN_TOOL])];
		// Session bookkeeping is always available, alongside configured execution tools.
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
			pi.setActiveTools([...new Set([...originalTools, SESSION_PLAN_TOOL])]);
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
			allTools: pi.getAllTools().filter(tool => tool.name !== SESSION_PLAN_TOOL).map((tool) => ({ name: tool.name, description: tool.description })),
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
			onTestMcp: async (serverName, draftServer) => {
				const current = agents.find(candidate => candidate.name === name);
				const server = draftServer ?? current?.mcpServers?.[serverName] ?? config.mcpServers?.[serverName];
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
		let savedOverlayPath: string | undefined;
		if (result.action === "save-source") {
			savedPath = saveAgentSource(agent, result.override, result.mcpServers);
			if (agent.source === "project") {
				// Global overlays belong to every project. Keep them untouched, and
				// shadow them locally so rediscovery applies the draft we just saved.
				if (loadConfig(ctx.cwd, { includeProject: false }).agentOverrides?.[name]) {
					savedOverlayPath = saveAgentOverride(ctx.cwd, "project", name, result.override);
				} else removeAgentOverride(ctx.cwd, "project", name);
			} else {
				for (const scope of agent.savedOverrideSources ?? []) removeAgentOverride(ctx.cwd, scope, name);
			}
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
		ctx.ui.notify(`Agent "${name}" saved to ${savedPath}${savedOverlayPath ? `; project settings saved to ${savedOverlayPath} to preserve global overrides` : ""}`, "info");
	}

	async function createAgent(ctx: ExtensionContext): Promise<void> {
		const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : true;
		const scope = await selectMenu(ctx, "Create agent · save location", SCOPE_MENU.filter(item => trusted || item.id === AgentScope.Global));
		if (!scope) return;
		const method = await selectMenu(ctx, "Create agent", CREATE_MENU);
		if (!method) return;
		const available = {
			tools: pi.getAllTools().map(tool => tool.name).filter(name => name !== DELEGATE_TOOL && name !== SUBAGENT_CONTROL_TOOL && name !== SESSION_PLAN_TOOL && name !== "powershell" && !name.includes("__")),
			mcp: Object.keys(config.mcpServers ?? {}),
		};
		let draft: DeclarativeAgentInput;
		if (method === AuthoringMethod.AI) {
			const generated = await assistAgentDraft(ctx, { name: "", description: "", tools: [], mcp: [], systemPrompt: "" }, available);
			if (!generated) return;
			draft = generated;
		} else {
			const input = await ctx.ui.input("Agent name", "e.g. developer, browser-verifier");
			if (!input?.trim()) return;
			let name: string;
			try { name = validateAgentName(input); }
			catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
				return;
			}
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
			ctx.ui.notify(`Agent "${name}" already exists; select it and press F4 to edit`, "warning");
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
		await refreshPersistedTasks();
		await showSubagentInspector(
			ctx,
			() => observer.handles(),
			config.subagents?.staleWarningMinutes ?? DEFAULT_STALE_WARNING_MINUTES,
			"Main session",
			{
				getCoordination: coordinationSnapshot,
				onHandleResult: (runId, handling, note) => { getCoordination().handleResult(runId, handling, note); renderOverview?.(); },
				getResultActions: (runId) => {
					const run = backgroundRuns.get(runId);
					if (!run || run.status === "running" || run.recoverable === false || run.thread.latestRunId !== runId || activeAgent?.name !== run.thread.owner || !activeAgent.subagents?.some(child => child.name === run.agent) || !agents.some(agent => agent.name === run.agent)) return [];
					if (run.persisted) return run.recoverable ? ["recover"] : [];
					return run.status === "completed" ? ["reply"] : run.recoverable ? ["recover"] : [];
				},
				onResultAction: async (action, runId, message) => {
					const result = await controlSubagent(`inbox-${randomUUID()}`, { action, runId, message }, undefined, undefined, ctx);
					const details = result.details as { runId?: string; status?: string } | undefined;
					if (!details?.runId || details.status !== "running") throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "Continuation did not start.");
					return result;
				},
			},
		);
	}

	registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.inspect, DEFAULT_INSPECT_SHORTCUT), "Task checklist, runs and inbox", inspectSubagents);

	pi.registerCommand("subagents", {
		description: "Session tasks, live delegated runs and result inbox",
		handler: async (_args, ctx) => inspectSubagents(ctx),
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
			const runtime = [
				childConfig.model ? `model ${childConfig.model}` : "default model",
				childConfig.timeoutSeconds ? `${childConfig.timeoutSeconds}s deadline` : "no deadline",
				"fresh replyable task threads",
			].join(", ");
			return `- ${childConfig.name}: ${child?.description ?? "specialist agent"} (${runtime})`;
		});
		return [
			"You may delegate focused work to these allowed subagents:",
			...lines,
			"Use a self-contained task with relevant paths and expected output. Issue independent delegate calls together to run them in parallel.",
			"Each delegate call starts a fresh replyable task thread; same-agent tasks can run in parallel. Use background: true to keep working while subagents run. Results arrive after your current flow finishes; do not repeatedly poll. Use subagent_control reply with the latest completed runId to answer a question or continue that conversation; replies start a new background run. Use steer while running, or list, status, stop, and result to manage runs. Recheck relevant files when continuing work because the workspace may have changed. Parallel workers share the working directory: assign separate files or worktrees to avoid conflicting edits.",
		].join("\n");
	}

	pi.on("before_agent_start", async (event) => {
		const queued = inbox.take();
		const boundaryState = coordinationSnapshot();
		admittedUserUpdateIds = boundaryState?.userUpdates.map(update => update.id) ?? [];
		const savedResults = boundaryState?.results ?? [];
		// Restoration never starts work. The next explicit safe boundary exposes
		// any saved reports not yet delivered, including crash/interruption gaps.
		for (const result of savedResults) {
			if (result.delivered || result.handling === "incorporated" || queued.some(item => item.runId === result.runId)) continue;
			queued.push({ runId: result.runId, agent: result.agent, task: result.task, text: result.text,
				details: { agent: result.agent, status: result.executionStatus === "completed" ? "completed" : result.executionStatus === "failed" ? "failed" : result.executionStatus === "timed_out" ? "timed_out" : "interrupted" } });
		}
		const completions = queued.filter(result => savedResults.find(item => item.runId === result.runId)?.handling !== "incorporated");
		const parts: string[] = [];
		if (coordination) parts.push(COORDINATION_GUIDE);
		else if (coordinationError) parts.push(`Session coordination storage is unavailable: ${coordinationError}. Report this limitation; do not claim that tasks or results have been retained.`);
		if (activeAgent?.systemPrompt) parts.push(activeAgent.systemPrompt);
		const delegateGuide = activeAgent ? delegationPrompt(activeAgent) : undefined;
		if (delegateGuide) parts.push(delegateGuide);
		if (helpPending && GUIDE) {
			helpPending = false;
			parts.push(
				`The user asked a question about the pi-agents extension. Answer it using the bundled guide:\n\n${GUIDE}`,
			);
		}
		if (parts.length === 0 && completions.length === 0) return;
		if (completions.length) markCompletionsDelivered(completions);
		return {
			...(completions.length ? { message: completionMessage(completions) } : {}),
			systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}`,
		};
	});
	// Rebuild compact continuity context before each request, including automatic
	// compaction inside an existing agent loop. Undelivered background reports stay
	// in the transport until settlement; this hook must not bypass that boundary.
	pi.on("context", event => {
		if (!coordination) return;
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "pi-agents-coordination-context"));
		return { messages: [...messages, { role: "custom" as const, customType: "pi-agents-coordination-context", display: false,
			content: coordinationContext(true), timestamp: Date.now() }] };
	});

	// --- Session lifecycle: discover, restore, persist ---

	pi.on("session_start", async (event, ctx) => {
		observerContext = ctx;
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
		registerConfiguredShortcuts(normalizeShortcutKeys(config.keybindings?.inspect, DEFAULT_INSPECT_SHORTCUT), "Explore delegated agent runs", inspectSubagents);

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
		else {
			pi.setActiveTools([...new Set([...pi.getActiveTools(), SESSION_PLAN_TOOL])]);
			refreshStatus(ctx);
		}
		persistedName = activeName;
		taskRootSessionId = process.env[ROOT_SESSION_ENV] ?? (ctx.sessionManager as typeof ctx.sessionManager & { getSessionId?: () => string }).getSessionId?.();
		coordination = undefined;
		coordinationError = undefined;
		admittedUserUpdateIds = [];
		try {
			coordination = SessionCoordination.open({ projectCwd: ctx.cwd, rootSessionId: taskRootSessionId ?? "",
				participantId: process.env[RUN_ID_ENV] ? ctx.sessionManager.getSessionId() : "main" });
		} catch (error) {
			coordinationError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Session coordination unavailable: ${coordinationError}`, "warning");
		}
		if ((!ctx.mode || ctx.mode === "tui") && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("pi-agents-session", (tui, theme) => {
				renderOverview = () => tui.requestRender();
				return {
					invalidate() {},
					render: width => {
						const state = coordinationSnapshot();
						if (coordinationError) return [theme.fg("warning", "Tasks · saved state unavailable".slice(0, Math.max(0, width)))];
						return renderSessionOverview(state, observer.handles().map(handle => handle.snapshot()), width, Math.max(1, Math.min(5, (tui.terminal.rows ?? 24) - 10))).map((line, index) => theme.fg(index === 0 ? "accent" : "muted", line));
					},
					dispose() { renderOverview = undefined; },
				};
			}, { placement: "aboveEditor" });
		}
		taskHistoryError = undefined;
		try {
			taskProjectCwd = fs.realpathSync(ctx.cwd);
			taskBackend = await PersistentSubagentBackend.open({
				scope: { rootSessionId: taskRootSessionId ?? "", projectCwd: ctx.cwd },
				authorize: request => activeAgent?.name === request.owner
					&& !!activeAgent.subagents?.some(candidate => candidate.name === request.agent)
					&& agents.some(agent => agent.name === request.agent),
			});
			await refreshPersistedTasks();
			// A missing live owner is never a reason to restart. Retain an explicit
			// interruption/report gap for each unfinished durable delegation instead.
			if (coordination) {
				const saved = coordination.snapshot();
				for (const link of saved.runs) {
					if (saved.results.some(result => result.runId === link.runId)) continue;
					const run = backgroundRuns.get(link.runId);
					if (run && !run.persisted && run.status === "running") continue;
					coordination.recordResult({ ...link, executionStatus: (run?.status === "completed" ? "completed" : "interrupted"),
						text: `No retained final report for this delegation after reload. Execution history: ${run?.status ?? "unavailable"}. Nothing was restarted. Inspect saved history and current workspace before an explicit recovery with a new instruction.` });
				}
			}
			if (taskBackend && (backgroundRuns.size || historyDiagnostics.length)) ctx.ui.notify(`Saved task history available: ${backgroundRuns.size} tasks, ${historyDiagnostics.length} invalid records. Use /task-history list; nothing was restarted.`, "info");
		} catch (error) {
			taskHistoryError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Persistent task history unavailable: ${taskHistoryError}. Delegation is blocked rather than silently using temporary history.`, "warning");
		}

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
		sessionGeneration++;
		inbox.close();
		renderOverview = undefined;
		ctx.ui.setWidget?.("pi-agents-session", undefined);
		for (const [runId, run] of backgroundRuns) {
			run.controller.abort();
			if (run.background && run.status === "running") emitBackgroundLifecycle(runId, run.agent, "aborted");
		}
		backgroundRuns.clear();
		inbox = createInbox();
		observerContext = undefined;
		await observer.shutdown(config.subagents?.gracefulStopSeconds ?? DEFAULT_GRACEFUL_STOP_SECONDS);
		observer = createObserver();
		// Wait for child exits/lock release before deleting their private histories.
		await Promise.allSettled([...pendingRuns]);
		await taskBackend?.shutdown();
		coordination = undefined;
		coordinationError = undefined;
		admittedUserUpdateIds = [];
		taskBackend = undefined;
		taskHistoryError = undefined;
		taskRootSessionId = undefined;
		taskProjectCwd = undefined;
		historyDiagnostics = [];
		await fs.promises.rm(threadSessionDir, { recursive: true, force: true });
		threadSessionDir = path.join(os.tmpdir(), `pi-agents-threads-${randomUUID()}`);
		await mcpManager.disconnectAll();
	});

	pi.on("turn_start", async (_event, ctx) => {
		const currentInbox = inbox;
		ctx.signal?.addEventListener("abort", () => currentInbox.pause(), { once: true });
		turnSubagentStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set<string>() };
		persistSelection(activeName);
	});
}
