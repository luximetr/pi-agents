import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import { OBSERVER_ENV, RUN_ID_ENV } from "./subagent-observer.ts";
import { SubagentTranscript, messageText, type TranscriptEntry } from "./subagent-transcript.ts";

export const MAX_SUBAGENT_DEPTH = 4;
export const ROOT_SESSION_ENV = "PI_AGENTS_ROOT_SESSION_ID";
const RESUMABLE_ANCESTRY_ENV = "PI_AGENTS_RESUMABLE_ANCESTRY";

export interface SubagentUsage {
	provider?: string;
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export type SubagentProgress =
	| { type: "started"; agent: string }
	| { type: "stats"; usage: SubagentUsage }
	| { type: "text"; delta: string }
	| { type: "tool-start"; tool: string; args: unknown }
	| { type: "tool-update"; text: string }
	| { type: "tool-end"; tool: string; error: boolean }
	| { type: "finished" }
	| { type: "error"; message: string };

export type SubagentStopReason = "user" | "timeout" | "parent" | "session";

export interface SubagentSnapshot {
	id: string;
	parentRunId?: string;
	agent: string;
	task: string;
	endedAt?: number;
	transcript?: TranscriptEntry[];
	transcriptTruncated?: boolean;
	/** Configured child model pattern, including an optional thinking-level suffix. */
	model?: string;
	startedAt: number;
	lastActivityAt: number;
	deadlineAt?: number;
	status: "running" | "stopping" | "finished" | "failed";
	phase: string;
	currentTool?: string;
	currentToolArgs?: unknown;
	partialText: string;
	recentEvents: string[];
	/** Cumulative child usage observed so far, for the live inspector. */
	usage?: SubagentUsage;
	stopReason?: SubagentStopReason;
}

export interface RunningSubagentHandle {
	readonly id: string;
	snapshot(): SubagentSnapshot;
	stop(reason?: SubagentStopReason): void;
	steer(message: string): boolean;
}

export class SubagentStoppedError extends Error {
	constructor(
		public readonly reason: SubagentStopReason,
		public readonly snapshot: SubagentSnapshot,
	) {
		super(reason === "timeout" ? "subagent timed out" : reason === "user" ? "subagent interrupted by user" : "subagent cancelled");
		this.name = "SubagentStoppedError";
	}
}

export interface RunSubagentOptions {
	onProgress?: (event: SubagentProgress) => void;
	onHandle?: (handle: RunningSubagentHandle | undefined) => void;
	/** Display-only observation, independent of model-visible delegate progress. */
	onSnapshot?: (snapshot: SubagentSnapshot) => void;
	observerEndpoint?: string;
	parentRunId?: string;
	executable?: string;
	/** Pi model pattern or provider/model ID selected for the child process. */
	model?: string;
	/** Total child lifetime. Omit to disable the deadline at this low-level API. */
	timeoutSeconds?: number;
	/** Time between RPC abort and SIGTERM, and between SIGTERM and SIGKILL. */
	gracefulStopSeconds?: number;
	/** Session-scoped Agent Studio overlays inherited by the ephemeral child. */
	runtimeAgentOverrides?: Record<string, unknown>;
	/** Stable id supplied by the caller; otherwise a process-local id is generated. */
	id?: string;
	/** Persist and resume this agent's participant session instead of creating a fresh session. */
	lifecycle?: "disposable" | "resumable";
	/** Identity of the root (user-facing) Pi session. Required for resumable participants. */
	rootSessionId?: string;
	/** Effective target identity (normally source path + effective agent name). */
	participantIdentity?: string;
	/** Override the private participant-session directory (primarily for tests). */
	participantSessionDir?: string;
}

let nextSubagentId = 1;
const MAX_RECENT_EVENTS = 100;
const MAX_PARTIAL_TEXT = 20_000;

const textFromMessage = messageText;

/** Render tool arguments as a compact single-line suffix for progress output. */
export function formatArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	try {
		const value = JSON.stringify(args);
		return value && value !== "{}" ? ` ${value}` : "";
	} catch {
		return " [args unavailable]";
	}
}

function piInvocation(childArgs: string[], executable?: string): { command: string; args: string[] } {
	const configured = executable ?? process.env.PI_CODING_AGENT_BIN;
	if (configured) return { command: configured, args: childArgs };

	// In npm installs process.execPath is usually node and argv[1] is pi's CLI
	// script. Launching it through node is more reliable than assuming that the
	// script is executable. Standalone binaries can launch themselves directly.
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...childArgs] };
	}
	const runtime = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(runtime)) return { command: "pi", args: childArgs };
	return { command: process.execPath, args: childArgs };
}

type ParticipantLock = { path: string; token: string };
type ParticipantWaitFailure = "cancelled" | "timeout";

class ParticipantWaitError extends Error {
	constructor(public readonly reason: ParticipantWaitFailure) {
		super(`subagent ${reason} while waiting for its resumable participant`);
	}
}

function participantKey(rootSessionId: string, identity: string): string {
	return createHash("sha256").update(`${rootSessionId}\0${identity}`).digest("hex");
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function acquireParticipantLock(lockPath: string, signal: AbortSignal, deadlineAt: number | undefined, failIfBusy: boolean): Promise<ParticipantLock> {
	const token = randomUUID();
	let unreadableSince: number | undefined;
	while (true) {
		if (signal.aborted) throw new ParticipantWaitError("cancelled");
		if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new ParticipantWaitError("timeout");
		try {
			await mkdir(lockPath);
			try {
				await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
				return { path: lockPath, token };
			} catch (error) {
				// Only remove an empty directory we just created. Recursive recovery can
				// delete a replacement lock and let two writers enter the same session.
				try { await rmdir(lockPath); } catch { /* Preserve uncertain ownership. */ }
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (failIfBusy) {
				throw new Error(`resumable participant is already busy; nested delegation refuses to queue: ${lockPath}`);
			}
			let owner: { pid?: unknown } | undefined;
			try { owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown }; }
			catch { /* The winning process may still be writing owner.json. */ }
			if (typeof owner?.pid === "number") {
				unreadableSince = undefined;
				if (!processIsAlive(owner.pid)) {
					// The owner's child may have survived its parent. Automatic deletion is
					// therefore unsafe; require deliberate operator recovery.
					throw new Error(`stale resumable participant lock (owner pid ${owner.pid} is not alive); verify no child is running, then remove: ${lockPath}`);
				}
			} else {
				unreadableSince ??= Date.now();
				if (Date.now() - unreadableSince >= 1000) throw new Error(`unreadable resumable participant lock; verify no child is running, then remove: ${lockPath}`);
			}
			const waitMs = Math.max(1, Math.min(50, deadlineAt === undefined ? 50 : deadlineAt - Date.now()));
			await new Promise<void>((resolve, reject) => {
				const abort = () => { clearTimeout(timer); reject(new ParticipantWaitError("cancelled")); };
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", abort);
					resolve();
				}, waitMs);
				signal.addEventListener("abort", abort, { once: true });
				timer.unref?.();
			});
		}
	}
}

async function releaseParticipantLock(lock: ParticipantLock): Promise<void> {
	const ownerFile = path.join(lock.path, "owner.json");
	const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { token?: unknown };
	if (owner.token !== lock.token) throw new Error(`resumable participant lock ownership changed: ${lock.path}`);
	await unlink(ownerFile);
	await rmdir(lock.path);
}

const SESSION_ENTRY_TYPES = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);

/** Pi's loader skips malformed JSONL lines, so validate private history before giving it to Pi. */
async function validateParticipantSession(sessionFile: string): Promise<void> {
	if (!existsSync(sessionFile)) return;
	const bytes = await readFile(sessionFile);
	let content: string;
	try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error(`resumable participant session is not valid UTF-8: ${sessionFile}`); }
	if (!content) throw new Error(`resumable participant session is empty: ${sessionFile}`);
	const physicalLines = content.split("\n");
	if (physicalLines.at(-1) === "") physicalLines.pop();
	if (!physicalLines.length || physicalLines.some(line => !line.trim())) {
		throw new Error(`resumable participant session contains an empty JSONL line: ${sessionFile}`);
	}
	const entries = physicalLines.map((line, index) => {
		try {
			const value = JSON.parse(line) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("entry is not an object");
			return value as Record<string, unknown>;
		} catch (error) {
			throw new Error(`resumable participant session has malformed JSONL at line ${index + 1}: ${sessionFile} (${error instanceof Error ? error.message : String(error)})`);
		}
	});
	const header = entries[0];
	if (header.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || typeof header.timestamp !== "string" || Number.isNaN(Date.parse(header.timestamp)) || !Number.isInteger(header.version) || Number(header.version) < 1 || Number(header.version) > CURRENT_SESSION_VERSION) {
		throw new Error(`resumable participant session has an invalid or unsupported header: ${sessionFile}`);
	}
	const version = Number(header.version);
	const ids = new Set<string>();
	for (let index = 1; index < entries.length; index++) {
		const entry = entries[index];
		if (typeof entry.type !== "string" || !SESSION_ENTRY_TYPES.has(entry.type)) {
			throw new Error(`resumable participant session has an unknown entry type at line ${index + 1}: ${sessionFile}`);
		}
		if (version >= 2) {
			if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || (entry.parentId !== null && typeof entry.parentId !== "string") || (typeof entry.parentId === "string" && !ids.has(entry.parentId))) {
				throw new Error(`resumable participant session has broken tree history at line ${index + 1}: ${sessionFile}`);
			}
		}
		if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp))) {
			throw new Error(`resumable participant session has an invalid timestamp at line ${index + 1}: ${sessionFile}`);
		}
		if (entry.type === "message") {
			const message = entry.message as Record<string, unknown> | undefined;
			const contextRole = message?.role === "user" || message?.role === "assistant" || message?.role === "toolResult" || message?.role === "custom" || message?.role === "hookMessage";
			if (!message || typeof message !== "object" || typeof message.role !== "string" || !["user", "assistant", "toolResult", "bashExecution", "custom", "hookMessage", "branchSummary", "compactionSummary"].includes(message.role) || (contextRole && (message.content == null || (typeof message.content !== "string" && !Array.isArray(message.content))))) {
				throw new Error(`resumable participant session has an invalid message at line ${index + 1}: ${sessionFile}`);
			}
		} else if ((entry.type === "model_change" && (typeof entry.provider !== "string" || typeof entry.modelId !== "string"))
			|| (entry.type === "thinking_level_change" && typeof entry.thinkingLevel !== "string")
			|| (entry.type === "compaction" && (typeof entry.summary !== "string" || typeof entry.tokensBefore !== "number"
				|| (typeof entry.firstKeptEntryId === "string" && !ids.has(entry.firstKeptEntryId))
				|| (entry.firstKeptEntryId === undefined && !Array.isArray(entry.retainedTail))))
			|| (entry.type === "branch_summary" && (typeof entry.summary !== "string" || typeof entry.fromId !== "string" || !ids.has(entry.fromId)))
			|| ((entry.type === "custom" || entry.type === "custom_message") && typeof entry.customType !== "string")
			|| (entry.type === "custom_message" && (!("content" in entry) || typeof entry.display !== "boolean"))
			|| (entry.type === "label" && (typeof entry.targetId !== "string" || !ids.has(entry.targetId)))) {
			throw new Error(`resumable participant session has invalid ${entry.type} data at line ${index + 1}: ${sessionFile}`);
		}
		if (version >= 2) ids.add(entry.id as string);
	}
}

/** Run an isolated child pi session, forwarding live RPC progress and exposing a controllable handle. */
function runSubagentProcess(
	agentName: string,
	task: string,
	cwd: string,
	signal: AbortSignal,
	options: RunSubagentOptions = {},
	timing?: { startedAt: number; deadlineAt?: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const depth = Number(process.env.PI_AGENTS_SUBAGENT_DEPTH ?? "0");
		if (depth >= MAX_SUBAGENT_DEPTH) {
			reject(new Error(`maximum subagent depth (${MAX_SUBAGENT_DEPTH}) reached`));
			return;
		}
		if (signal.aborted) {
			reject(new Error("subagent cancelled"));
			return;
		}

		const timeoutSeconds = options.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
			reject(new Error("subagent timeoutSeconds must be a positive number"));
			return;
		}
		const gracefulStopMs = Math.max(0, (options.gracefulStopSeconds ?? 5) * 1000);

		const childCwd = cwd;
		const id = options.id ?? `subagent-${nextSubagentId++}`;

		const childArgs = ["--mode", "rpc"];
		if (options.lifecycle === "resumable") {
			if (!options.rootSessionId || !options.participantIdentity) {
				reject(new Error("resumable subagent requires rootSessionId and participantIdentity"));
				return;
			}
			const key = participantKey(options.rootSessionId, options.participantIdentity);
			const sessionDir = options.participantSessionDir ?? path.join(getAgentDir(), "pi-agents-subagent-sessions");
			childArgs.push("--session", path.join(sessionDir, `${key}.jsonl`));
		} else childArgs.push("--no-session");
		childArgs.push("--agent", agentName);
		if (options.model?.trim()) childArgs.push("--model", options.model.trim());
		const invocation = piInvocation(childArgs, options.executable);
		const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			env: {
				...process.env,
				PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1),
				[RUN_ID_ENV]: id,
				...(options.rootSessionId ? { [ROOT_SESSION_ENV]: options.rootSessionId } : {}),
				...(options.lifecycle === "resumable" && options.rootSessionId && options.participantIdentity
					? { [RESUMABLE_ANCESTRY_ENV]: [...(process.env[RESUMABLE_ANCESTRY_ENV]?.split(",").filter(Boolean) ?? []), participantKey(options.rootSessionId, options.participantIdentity)].join(",") }
					: {}),
				...(options.observerEndpoint ? { [OBSERVER_ENV]: options.observerEndpoint } : {}),
				...(options.runtimeAgentOverrides && Object.keys(options.runtimeAgentOverrides).length > 0
					? { PI_AGENTS_STUDIO_OVERRIDES: JSON.stringify(options.runtimeAgentOverrides) }
					: {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const processStartedAt = Date.now();
		const startedAt = timing?.startedAt ?? processStartedAt;
		const deadlineAt = timing?.deadlineAt ?? (timeoutSeconds === undefined ? undefined : processStartedAt + timeoutSeconds * 1000);
		const state: SubagentSnapshot = {
			id,
			parentRunId: options.parentRunId,
			agent: agentName,
			task,
			model: options.model?.trim() || undefined,
			startedAt,
			lastActivityAt: processStartedAt,
			deadlineAt,
			status: "running",
			phase: "starting",
			partialText: "",
			recentEvents: [],
		};
		const transcript = new SubagentTranscript(task);
		const activeTools = new Map<string, { tool: string; args: unknown }>();
		const progress = options.onProgress;
		let observationTimer: NodeJS.Timeout | undefined;
		let observationDirty = true;
		let stderr = "";
		let finalText = "";
		let assistantError: string | undefined;
		let settled = false;
		let gracefulExit = false;
		let stopEscalationTimer: NodeJS.Timeout | undefined;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const decoder = new StringDecoder("utf8");
		let buffer = "";

		const addEvent = (text: string) => {
			state.recentEvents.push(text.slice(0, 2000));
			observationDirty = true;
			if (state.recentEvents.length > MAX_RECENT_EVENTS) state.recentEvents.splice(0, state.recentEvents.length - MAX_RECENT_EVENTS);
		};
		const send = (command: Record<string, unknown>): boolean => {
			if (!child.stdin.writable || child.killed) return false;
			try {
				child.stdin.write(`${JSON.stringify(command)}\n`);
				return true;
			} catch {
				return false;
			}
		};
		const stop = (reason: SubagentStopReason = "user") => {
			if (settled || state.stopReason) return;
			state.stopReason = reason;
			state.status = "stopping";
			state.phase = reason === "timeout" ? "deadline exceeded" : "stopping";
			const notice = reason === "timeout" ? "⏱ execution deadline reached" : reason === "user" ? "■ stop requested by user" : "■ cancellation requested";
			addEvent(notice);
			transcript.add("event", notice);
			publishSnapshot();
			send({ id: `abort-${state.id}`, type: "abort" });
			stopEscalationTimer = setTimeout(() => {
				if (settled) return;
				addEvent("■ child did not stop gracefully; sending SIGTERM");
				child.kill("SIGTERM");
				stopEscalationTimer = setTimeout(() => {
					if (!settled) {
						addEvent("■ child did not terminate; sending SIGKILL");
						child.kill("SIGKILL");
					}
				}, gracefulStopMs);
				stopEscalationTimer.unref?.();
			}, gracefulStopMs);
			stopEscalationTimer.unref?.();
		};
		const handle: RunningSubagentHandle = {
			id: state.id,
			snapshot: () => {
				const args = formatArgs(state.currentToolArgs);
				return { ...state, task: state.task.length > 16_000 ? `${state.task.slice(0, 16_000)}\n[Task preview truncated]` : state.task,
					currentToolArgs: args.length > 16_000 ? { preview: args.slice(0, 16_000), truncated: true } : state.currentToolArgs,
					transcript: transcript.snapshot(), transcriptTruncated: transcript.truncated, recentEvents: [...state.recentEvents], usage: state.usage ? { ...state.usage } : undefined };
			},
			stop,
			steer: (message: string) => {
				const text = message.trim();
				if (!text || settled || state.status !== "running") return false;
				const sent = send({ id: `steer-${state.id}-${Date.now()}`, type: "steer", message: text });
				if (sent) {
					addEvent(`↪ user steering: ${text}`);
					transcript.add("event", `Steering requested (queued, not yet delivered): ${text}`);
					publishSnapshot();
				}
				return sent;
			},
		};

		const publishSnapshot = () => {
			if (!options.onSnapshot) return;
			observationDirty = false;
			try { options.onSnapshot(handle.snapshot()); }
			catch { /* Observation must never affect delegated execution. */ }
		};
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (deadlineTimer) clearTimeout(deadlineTimer);
			if (stopEscalationTimer) clearTimeout(stopEscalationTimer);
			if (observationTimer) clearInterval(observationTimer);
			signal.removeEventListener("abort", parentAbort);
			state.endedAt = Date.now();
			fn();
			publishSnapshot();
			options.onHandle?.(undefined);
		};
		const parentAbort = () => stop("parent");
		const handleEvent = (event: Record<string, unknown>) => {
			// Footer/widget RPC notifications are not evidence of agent progress.
			if (event.type === "extension_ui_request" && !["select", "confirm", "input", "editor"].includes(String(event.method))) return;
			state.lastActivityAt = Date.now();
			observationDirty = true;
			transcript.consume(event);
			switch (event.type) {
				case "agent_start":
					state.phase = "agent running";
					addEvent(`▶ ${agentName}: running`);
					progress?.({ type: "started", agent: agentName });
					break;
				case "message_update": {
					const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						finalText += delta.delta;
						state.partialText = (state.partialText + delta.delta).slice(-MAX_PARTIAL_TEXT);
						state.phase = "responding";
						progress?.({ type: "text", delta: delta.delta });
					} else if (delta?.type === "thinking_delta") state.phase = "thinking";
					break;
				}
				case "message_end": {
					const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; provider?: unknown; model?: unknown; usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } } | undefined;
					// Tool/user messages must not overwrite the child's answer or count nested usage twice.
					if (message?.role && message.role !== "assistant") break;
					assistantError = message?.stopReason === "error" || message?.stopReason === "aborted" ? message.errorMessage ?? `Assistant ${message.stopReason}` : undefined;
					if (assistantError) transcript.add("event", assistantError);
					const text = textFromMessage(event.message);
					if (text) {
						finalText = text;
						state.partialText = text.slice(-MAX_PARTIAL_TEXT);
					}
					const usage = message?.usage;
					if (usage) {
						const turnUsage: SubagentUsage = {
							provider: typeof message?.provider === "string" ? message.provider : undefined,
							model: typeof message?.model === "string" ? message.model : undefined,
							input: Number(usage.input ?? 0), output: Number(usage.output ?? 0), cacheRead: Number(usage.cacheRead ?? 0), cacheWrite: Number(usage.cacheWrite ?? 0), cost: Number(usage.cost?.total ?? 0),
						};
						const previous = state.usage;
						state.usage = {
							provider: turnUsage.provider ?? previous?.provider,
							model: turnUsage.model ?? previous?.model,
							input: (previous?.input ?? 0) + turnUsage.input,
							output: (previous?.output ?? 0) + turnUsage.output,
							cacheRead: (previous?.cacheRead ?? 0) + turnUsage.cacheRead,
							cacheWrite: (previous?.cacheWrite ?? 0) + turnUsage.cacheWrite,
							cost: (previous?.cost ?? 0) + turnUsage.cost,
						};
						progress?.({ type: "stats", usage: turnUsage });
					}
					break;
				}
				case "tool_execution_start":
					state.phase = "tool execution";
					state.currentTool = String(event.toolName ?? "unknown");
					state.currentToolArgs = event.args;
					activeTools.set(String(event.toolCallId ?? event.toolName), { tool: state.currentTool, args: event.args });
					addEvent(`→ ${state.currentTool}${formatArgs(event.args)}`);
					progress?.({ type: "tool-start", tool: state.currentTool, args: event.args });
					break;
				case "tool_execution_update": {
					const text = textFromMessage(event.partialResult);
					if (text) {
						const lastLine = text.trimEnd().split("\n").at(-1);
						if (lastLine) addEvent(`  ${lastLine}`);
						progress?.({ type: "tool-update", text });
					}
					break;
				}
				case "tool_execution_end": {
					const tool = String(event.toolName ?? state.currentTool ?? "unknown");
					const error = event.isError === true;
					addEvent(`${error ? "✗" : "✓"} ${tool}`);
					activeTools.delete(String(event.toolCallId ?? event.toolName));
					const remainingTool = [...activeTools.values()].at(-1);
					state.currentTool = remainingTool?.tool;
					state.currentToolArgs = remainingTool?.args;
					state.phase = activeTools.size ? `tool execution (${activeTools.size} active)` : "agent running";
					progress?.({ type: "tool-end", tool, error });
					break;
				}
				case "response":
					if (event.command === "steer") transcript.add("event", event.success ? "Steering accepted by child; delivery occurs between turns." : `Steering rejected: ${String(event.error ?? "unknown error")}`);
					if (event.success === false && event.command !== "steer") transcript.add("event", `RPC ${String(event.command)} failed: ${String(event.error)}`);
					break;
				case "extension_ui_request":
					state.phase = "waiting for user input (child RPC dialog)";
					transcript.add("event", `Child requested ${String(event.method)}: ${String(event.title ?? "input")} — use stop if it cannot continue.`);
					break;
				case "auto_retry_start": state.phase = "retrying"; addEvent("↻ provider retry"); transcript.add("event", "Provider retry"); break;
				case "compaction_start": state.phase = "compacting"; addEvent("◇ compacting context"); break;
				case "agent_settled":
					// An aborted child also emits agent_settled while shutting down. Keep
					// the stop phase in that case so diagnostics do not claim that a
					// timed-out or interrupted delegation finished successfully.
					if (!state.stopReason) {
						state.phase = assistantError ? "assistant failed" : "finished";
						state.status = assistantError ? "failed" : "finished";
						addEvent(`${assistantError ? "✗" : "✓"} ${agentName}: ${state.phase}`);
						progress?.(assistantError ? { type: "error", message: assistantError } : { type: "finished" });
					}
					gracefulExit = true;
					child.kill("SIGTERM");
					break;
				case "extension_error": {
					const message = String(event.error ?? "child extension error");
					addEvent(`✗ ${message}`);
					progress?.({ type: "error", message });
					break;
				}
			}
		};
		const consume = (chunk: Buffer | string, flush = false) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				try { handleEvent(JSON.parse(line) as Record<string, unknown>); } catch { /* Ignore non-protocol output. */ }
			}
			if (flush) {
				buffer += decoder.end();
				if (buffer.trim()) try { handleEvent(JSON.parse(buffer) as Record<string, unknown>); } catch { /* Ignore incomplete output. */ }
			}
		};

		options.onHandle?.(handle);
		publishSnapshot();
		if (options.onSnapshot) {
			observationTimer = setInterval(() => { if (observationDirty) publishSnapshot(); }, 200);
			observationTimer.unref();
		}
		child.stdin.on("error", () => { /* EPIPE during shutdown; close/error owns completion. */ });
		child.stdout.on("data", (chunk: Buffer) => consume(chunk));
		child.stdout.on("end", () => consume("", true));
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
		if (deadlineAt !== undefined) {
			deadlineTimer = setTimeout(() => stop("timeout"), Math.max(0, deadlineAt - Date.now()));
			deadlineTimer.unref?.();
		}
		if (signal.aborted) parentAbort();
		signal.addEventListener("abort", parentAbort, { once: true });
		child.on("error", error => finish(() => {
			state.status = "failed";
			state.phase = "failed to launch";
			transcript.add("event", error.message);
			reject(error);
		}));
		child.on("close", (code) => finish(() => {
			if (state.stopReason) {
				state.status = "failed";
				reject(new SubagentStoppedError(state.stopReason, handle.snapshot()));
			} else if (assistantError) {
				state.status = "failed";
				state.phase = "assistant failed";
				reject(new Error(assistantError));
			} else if (code !== 0 && !gracefulExit) {
				state.status = "failed";
				state.phase = "process failed";
				const message = stderr.trim() || `subagent exited with code ${code}`;
				transcript.add("event", message);
				reject(new Error(message));
			} else {
				state.status = "finished";
				state.phase = "finished";
				resolve(finalText.trim() || "Subagent completed without a textual result.");
			}
		}));
		send({ id: "prompt", type: "prompt", message: task });
	});
}

/** Run a delegated agent, serializing and persisting only resumable participants. */
export async function runSubagent(
	agentName: string,
	task: string,
	cwd: string,
	signal: AbortSignal,
	options: RunSubagentOptions = {},
): Promise<string> {
	if (options.lifecycle !== "resumable") return runSubagentProcess(agentName, task, cwd, signal, options);
	const startedAt = Date.now();
	const timeoutSeconds = options.timeoutSeconds;
	if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
		throw new Error("subagent timeoutSeconds must be a positive number");
	}
	const deadlineAt = timeoutSeconds === undefined ? undefined : startedAt + timeoutSeconds * 1000;
	if (!options.rootSessionId || !options.participantIdentity) {
		throw new Error("resumable subagent requires rootSessionId and participantIdentity");
	}
	const stoppedWhileQueued = (reason: ParticipantWaitFailure): SubagentStoppedError => {
		const now = Date.now();
		const timedOut = reason === "timeout";
		return new SubagentStoppedError(timedOut ? "timeout" : "parent", {
			id: options.id ?? `subagent-${nextSubagentId++}`,
			parentRunId: options.parentRunId,
			agent: agentName,
			task,
			model: options.model?.trim() || undefined,
			startedAt,
			lastActivityAt: startedAt,
			deadlineAt,
			endedAt: now,
			status: "failed",
			phase: timedOut ? "deadline exceeded while queued for resumable participant" : "cancelled while queued for resumable participant",
			partialText: "",
			recentEvents: [timedOut ? "⏱ deadline reached while queued" : "■ cancellation requested while queued"],
			stopReason: timedOut ? "timeout" : "parent",
		});
	};
	const key = participantKey(options.rootSessionId, options.participantIdentity);
	const ancestry = process.env[RESUMABLE_ANCESTRY_ENV]?.split(",").filter(Boolean) ?? [];
	if (ancestry.includes(key)) {
		throw new Error(`resumable delegation cycle detected for agent "${agentName}"; refusing to wait on its own participant`);
	}
	const sessionDir = options.participantSessionDir ?? path.join(getAgentDir(), "pi-agents-subagent-sessions");
	// Creating this boundary before launch makes storage failures explicit. Never
	// fall back to --no-session, which would silently discard existing context.
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	// mkdir's mode does not repair an existing directory. Participant transcripts
	// are sensitive, so narrow both existing and newly created boundaries.
	await chmod(sessionDir, 0o700);
	const lockDir = path.join(sessionDir, ".locks");
	await mkdir(lockDir, { recursive: true, mode: 0o700 });
	await chmod(lockDir, 0o700);
	let lock: ParticipantLock;
	try {
		// A nested waiter can form A→B/B→A across concurrently started roots even
		// though neither target appears in its own ancestry. Reject nested contention;
		// independent top-level calls retain FIFO-ish polling serialization.
		lock = await acquireParticipantLock(path.join(lockDir, key), signal, deadlineAt, Number(process.env.PI_AGENTS_SUBAGENT_DEPTH ?? "0") > 0);
	} catch (error) {
		if (error instanceof ParticipantWaitError) throw stoppedWhileQueued(error.reason);
		throw error;
	}
	try {
		const sessionFile = path.join(sessionDir, `${key}.jsonl`);
		await validateParticipantSession(sessionFile);
		if (signal.aborted) throw stoppedWhileQueued("cancelled");
		if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw stoppedWhileQueued("timeout");
		return await runSubagentProcess(agentName, task, cwd, signal, options, { startedAt, deadlineAt });
	} finally {
		await releaseParticipantLock(lock);
	}
}
