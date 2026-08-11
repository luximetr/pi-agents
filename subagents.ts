import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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
	agent: string;
	task: string;
	startedAt: number;
	lastActivityAt: number;
	deadlineAt?: number;
	status: "running" | "stopping" | "finished" | "failed";
	phase: string;
	currentTool?: string;
	currentToolArgs?: unknown;
	partialText: string;
	recentEvents: string[];
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
	executable?: string;
	branch?: string;
	/** Total child lifetime. Omit to disable the deadline at this low-level API. */
	timeoutSeconds?: number;
	/** Time between RPC abort and SIGTERM, and between SIGTERM and SIGKILL. */
	gracefulStopSeconds?: number;
	/** Stable id supplied by the caller; otherwise a process-local id is generated. */
	id?: string;
}

let nextSubagentId = 1;
const MAX_RECENT_EVENTS = 100;
const MAX_PARTIAL_TEXT = 20_000;

function textFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function formatArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	try {
		const value = JSON.stringify(args);
		return value && value !== "{}" ? ` ${value}` : "";
	} catch {
		return " [args unavailable]";
	}
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

		const branch = typeof options.branch === "string" ? options.branch.trim() : "";
		if (branch) {
			try {
				execFileSync("git", ["checkout", "-b", branch], { cwd, stdio: "pipe", encoding: "utf8" });
			} catch (err) {
				const stderr = (err as { stderr?: unknown })?.stderr;
				const detail = typeof stderr === "string" && stderr.trim()
					? stderr.trim()
					: err instanceof Error ? err.message : String(err);
				reject(new Error(`cannot create branch "${branch}" for subagent: ${detail}`));
				return;
			}
		}

		const executable = options.executable ?? process.env.PI_CODING_AGENT_BIN ?? process.argv[1] ?? "pi";
		const child: ChildProcessWithoutNullStreams = spawn(executable, ["--mode", "rpc", "--no-session", "--agent", agentName], {
			cwd,
			env: { ...process.env, PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const startedAt = Date.now();
		const state: SubagentSnapshot = {
			id: options.id ?? `subagent-${nextSubagentId++}`,
			agent: agentName,
			task,
			startedAt,
			lastActivityAt: startedAt,
			deadlineAt: timeoutSeconds === undefined ? undefined : startedAt + timeoutSeconds * 1000,
			status: "running",
			phase: "starting",
			partialText: "",
			recentEvents: [],
		};
		const progress = options.onProgress;
		let stderr = "";
		let finalText = "";
		let settled = false;
		let gracefulExit = false;
		let stopEscalationTimer: NodeJS.Timeout | undefined;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const decoder = new StringDecoder("utf8");
		let buffer = "";

		const addEvent = (text: string) => {
			state.recentEvents.push(text);
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
			addEvent(reason === "timeout" ? "⏱ execution deadline reached" : reason === "user" ? "■ stop requested by user" : "■ cancellation requested");
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
			snapshot: () => ({ ...state, recentEvents: [...state.recentEvents] }),
			stop,
			steer: (message: string) => {
				const text = message.trim();
				if (!text || settled || state.status !== "running") return false;
				const sent = send({ id: `steer-${state.id}-${Date.now()}`, type: "steer", message: text });
				if (sent) addEvent(`↪ user steering: ${text}`);
				return sent;
			},
		};

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (deadlineTimer) clearTimeout(deadlineTimer);
			if (stopEscalationTimer) clearTimeout(stopEscalationTimer);
			signal.removeEventListener("abort", parentAbort);
			options.onHandle?.(undefined);
			fn();
		};
		const parentAbort = () => stop("parent");
		const handleEvent = (event: Record<string, unknown>) => {
			state.lastActivityAt = Date.now();
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
					const message = event.message as { provider?: unknown; model?: unknown; usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } } | undefined;
					const text = textFromMessage(event.message);
					if (text) {
						finalText = text;
						state.partialText = text.slice(-MAX_PARTIAL_TEXT);
					}
					const usage = message?.usage;
					if (usage) progress?.({ type: "stats", usage: {
						provider: typeof message?.provider === "string" ? message.provider : undefined,
						model: typeof message?.model === "string" ? message.model : undefined,
						input: Number(usage.input ?? 0), output: Number(usage.output ?? 0), cacheRead: Number(usage.cacheRead ?? 0), cacheWrite: Number(usage.cacheWrite ?? 0), cost: Number(usage.cost?.total ?? 0),
					} });
					break;
				}
				case "tool_execution_start":
					state.phase = "tool execution";
					state.currentTool = String(event.toolName ?? "unknown");
					state.currentToolArgs = event.args;
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
					state.currentTool = undefined;
					state.currentToolArgs = undefined;
					state.phase = "agent running";
					progress?.({ type: "tool-end", tool, error });
					break;
				}
				case "auto_retry_start": state.phase = "retrying"; addEvent("↻ provider retry"); break;
				case "compaction_start": state.phase = "compacting"; addEvent("◇ compacting context"); break;
				case "agent_settled":
					state.phase = "finished";
					state.status = state.stopReason ? "stopping" : "finished";
					addEvent(`✓ ${agentName}: finished`);
					progress?.({ type: "finished" });
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
		progress?.({ type: "started", agent: agentName });
		child.stdout.on("data", (chunk: Buffer) => consume(chunk));
		child.stdout.on("end", () => consume("", true));
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		if (timeoutSeconds !== undefined) {
			deadlineTimer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
			deadlineTimer.unref?.();
		}
		if (signal.aborted) parentAbort();
		signal.addEventListener("abort", parentAbort, { once: true });
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) => finish(() => {
			if (state.stopReason) {
				state.status = "failed";
				reject(new SubagentStoppedError(state.stopReason, handle.snapshot()));
			} else if (code !== 0 && !gracefulExit) {
				state.status = "failed";
				reject(new Error(stderr.trim() || `subagent exited with code ${code}`));
			} else {
				state.status = "finished";
				resolve(finalText.trim() || "Subagent completed without a textual result.");
			}
		}));
		send({ id: "prompt", type: "prompt", message: task });
	});
}
