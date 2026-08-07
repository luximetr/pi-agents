import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../agents.ts";
import { MAX_SUBAGENT_DEPTH, runSubagent } from "../subagents.ts";

const noAbort = new AbortController().signal;

test("smoke: discovers an agent hierarchy", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-smoke-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "lead"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "lead", "agent.ts"), `
			export default { name: "lead", description: "Coordinator", subagents: ["worker"] };
		`);
		await mkdir(path.join(root, ".pi-agents", "worker"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "worker", "agent.ts"), `
			export default { name: "worker", description: "Specialist" };
		`);
		const result = await discoverAgents(root);
		const lead = result.agents.find((agent) => agent.name === "lead");
		assert.deepEqual(lead?.subagents, ["worker"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("end to end: delegate launches an isolated child with the target agent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-e2e-"));
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			const args = process.argv.slice(2);
			if (args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--no-session" || args[3] !== "--agent" || args[4] !== "worker") process.exit(2);
			let input = "";
			process.stdin.on("data", chunk => {
				input += chunk;
				if (!input.includes("\\n")) return;
				const prompt = JSON.parse(input.split("\\n")[0]).message;
				process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");
				process.stdout.write(JSON.stringify({type:"tool_execution_start", toolName:"read", args:{}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"worker-result:" + prompt}}) + "\\n");
				process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
				process.exit(0);
			});
		`);
		await chmod(fakePi, 0o755);
		const progress: string[] = [];
		const result = await runSubagent("worker", "inspect files", root, noAbort, {
			executable: fakePi,
			onProgress: (event) => progress.push(event.type),
		});
		assert.ok(progress.includes("tool-start"));
		assert.ok(progress.includes("text"));
		assert.equal(result, "worker-result:inspect files");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("depth guard rejects recursive delegation beyond the limit", async () => {
	const previous = process.env.PI_AGENTS_SUBAGENT_DEPTH;
	process.env.PI_AGENTS_SUBAGENT_DEPTH = String(MAX_SUBAGENT_DEPTH);
	try {
		await assert.rejects(runSubagent("worker", "task", process.cwd(), noAbort, process.execPath), /maximum subagent depth/);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENTS_SUBAGENT_DEPTH;
		else process.env.PI_AGENTS_SUBAGENT_DEPTH = previous;
	}
});
