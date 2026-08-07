import { spawn } from "node:child_process";

export const MAX_SUBAGENT_DEPTH = 4;

/** Run a child pi session and return only its final answer to the parent. */
export function runSubagent(agentName: string, task: string, cwd: string, signal: AbortSignal, executable = process.env.PI_CODING_AGENT_BIN ?? process.argv[1] ?? "pi"): Promise<string> {
	return new Promise((resolve, reject) => {
		const depth = Number(process.env.PI_AGENTS_SUBAGENT_DEPTH ?? "0");
		if (depth >= MAX_SUBAGENT_DEPTH) {
			reject(new Error(`maximum subagent depth (${MAX_SUBAGENT_DEPTH}) reached`));
			return;
		}
		const child = spawn(executable, ["--print", "--no-session", "--agent", agentName, task], {
			cwd,
			env: { ...process.env, PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		const abort = () => child.kill("SIGTERM");
		if (signal.aborted) abort();
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", (err) => { signal.removeEventListener("abort", abort); reject(err); });
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (signal.aborted) reject(new Error("subagent cancelled"));
			else if (code !== 0) reject(new Error(stderr.trim() || `subagent exited with code ${code}`));
			else resolve(stdout.trim() || "Subagent completed without a textual result.");
		});
	});
}
