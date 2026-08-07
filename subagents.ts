import { spawn } from "node:child_process";
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

export interface RunSubagentOptions {
	onProgress?: (event: SubagentProgress) => void;
	executable?: string;
}

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

/** Run an isolated child pi session, forwarding its live RPC progress. */
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

		const executable = options.executable ?? process.env.PI_CODING_AGENT_BIN ?? process.argv[1] ?? "pi";
		const child = spawn(executable, ["--mode", "rpc", "--no-session", "--agent", agentName], {
			cwd,
			env: { ...process.env, PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const progress = options.onProgress;
		let stderr = "";
		let finalText = "";
		let settled = false;
		let gracefulExit = false;
		const decoder = new StringDecoder("utf8");
		let buffer = "";

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const abort = () => child.kill("SIGTERM");
		const handleEvent = (event: Record<string, unknown>) => {
			switch (event.type) {
				case "agent_start":
					progress?.({ type: "started", agent: agentName });
					break;
				case "message_update": {
					const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						finalText += delta.delta;
						progress?.({ type: "text", delta: delta.delta });
					}
					break;
				}
				case "message_end": {
					const message = event.message as {
						provider?: unknown;
						model?: unknown;
						usage?: {
							input?: unknown;
							output?: unknown;
							cacheRead?: unknown;
							cacheWrite?: unknown;
							cost?: { total?: unknown };
						};
					} | undefined;
					const text = textFromMessage(event.message);
					if (text) finalText = text;
					const usage = message?.usage;
					if (usage) {
						progress?.({
							type: "stats",
							usage: {
								provider: typeof message?.provider === "string" ? message.provider : undefined,
								model: typeof message?.model === "string" ? message.model : undefined,
								input: Number(usage.input ?? 0),
								output: Number(usage.output ?? 0),
								cacheRead: Number(usage.cacheRead ?? 0),
								cacheWrite: Number(usage.cacheWrite ?? 0),
								cost: Number(usage.cost?.total ?? 0),
							},
						});
					}
					break;
				}
				case "tool_execution_start":
					progress?.({ type: "tool-start", tool: String(event.toolName ?? "unknown"), args: event.args });
					break;
				case "tool_execution_update": {
					const text = textFromMessage(event.partialResult);
					if (text) progress?.({ type: "tool-update", text });
					break;
				}
				case "tool_execution_end":
					progress?.({ type: "tool-end", tool: String(event.toolName ?? "unknown"), error: event.isError === true });
					break;
				case "agent_settled":
					// RPC mode stays alive waiting for more commands after the run
					// settles. This delegation is one-shot, so close it here; otherwise
					// the parent tool remains in pi's "working" state forever.
					progress?.({ type: "finished" });
					gracefulExit = true;
					child.kill("SIGTERM");
					break;
				case "extension_error":
					progress?.({ type: "error", message: String(event.error ?? "child extension error") });
					break;
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
				if (buffer.trim()) {
					try { handleEvent(JSON.parse(buffer) as Record<string, unknown>); } catch { /* Ignore incomplete output. */ }
				}
			}
		};

		progress?.({ type: "started", agent: agentName });
		child.stdout.on("data", (chunk: Buffer) => consume(chunk));
		child.stdout.on("end", () => consume("", true));
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		if (signal.aborted) abort();
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", (err) => {
			signal.removeEventListener("abort", abort);
			finish(() => reject(err));
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			finish(() => {
				if (signal.aborted) reject(new Error("subagent cancelled"));
				else if (code !== 0 && !gracefulExit) reject(new Error(stderr.trim() || `subagent exited with code ${code}`));
				else resolve(finalText.trim() || "Subagent completed without a textual result.");
			});
		});
		child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: task }) + "\n");
	});
}
