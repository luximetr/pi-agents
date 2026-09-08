import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { OBSERVER_ENV, RUN_ID_ENV } from "./subagent-observer.ts";
import { SubagentTranscript, messageText, type TranscriptEntry } from "./subagent-transcript.ts";

export const MAX_SUBAGENT_DEPTH = 4;

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

/** Run an isolated child pi session, forwarding live RPC progress and exposing a controllable handle. */
export function runSubagent(
	agentName: string,
	task: string,
	cwd: string,
	signal: AbortSignal,
	options: RunSubagentOptions = {},
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

		const childArgs = ["--mode", "rpc", "--no-session", "--agent", agentName];
		if (options.model?.trim()) childArgs.push("--model", options.model.trim());
		const invocation = piInvocation(childArgs, options.executable);
		const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			env: {
				...process.env,
				PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1),
				[RUN_ID_ENV]: id,
				...(options.observerEndpoint ? { [OBSERVER_ENV]: options.observerEndpoint } : {}),
				...(options.runtimeAgentOverrides && Object.keys(options.runtimeAgentOverrides).length > 0
					? { PI_AGENTS_STUDIO_OVERRIDES: JSON.stringify(options.runtimeAgentOverrides) }
					: {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const startedAt = Date.now();
		const state: SubagentSnapshot = {
			id,
			parentRunId: options.parentRunId,
			agent: agentName,
			task,
			model: options.model?.trim() || undefined,
			startedAt,
			lastActivityAt: startedAt,
			deadlineAt: timeoutSeconds === undefined ? undefined : startedAt + timeoutSeconds * 1000,
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
		if (timeoutSeconds !== undefined) {
			deadlineTimer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
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
