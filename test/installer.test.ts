import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installer = path.join(repoRoot, "bin", "install.mjs");

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-installer-"));
	const target = path.join(root, "project");
	const binDir = path.join(root, "bin");
	const agentDir = path.join(root, "agent-home");
	const callsFile = path.join(root, "pi-calls.jsonl");
	await mkdir(target, { recursive: true });
	await mkdir(binDir, { recursive: true });
	const fakePi = path.join(binDir, "pi");
	await writeFile(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_PI_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`);
	await chmod(fakePi, 0o755);
	const env = {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		PI_AGENT_DIR: agentDir,
		PI_AGENTS_REPO: repoRoot,
		FAKE_PI_CALLS: callsFile,
	};
	return { root, target, agentDir, callsFile, env };
}

async function readCalls(file: string): Promise<string[][]> {
	const content = await readFile(file, "utf8");
	return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("installer performs a global package install and records project trust", async () => {
	const f = await fixture();
	try {
		const result = await execFileAsync(process.execPath, [installer, "install", f.target], { env: f.env });
		assert.match(result.stdout, /ALL projects/);
		const calls = await readCalls(f.callsFile);
		assert.deepEqual(calls, [["--version"], ["install", repoRoot]]);
		const trust = JSON.parse(await readFile(path.join(f.agentDir, "trust.json"), "utf8"));
		assert.equal(trust[await realpath(f.target)], true);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("local installer passes -l and bundled samples rewrite repository imports", async () => {
	const f = await fixture();
	try {
		await execFileAsync(process.execPath, [installer, "install", f.target, "--local", "--agents"], { env: f.env });
		const calls = await readCalls(f.callsFile);
		assert.deepEqual(calls, [["--version"], ["install", repoRoot, "-l"]]);
		const lead = await readFile(path.join(f.target, ".pi-agents", "lead", "agent.ts"), "utf8");
		assert.ok(lead.includes(`from ${JSON.stringify(path.join(repoRoot, "agents"))}`));
		assert.equal(lead.includes('from "../../agents"'), false);
		await assert.rejects(readFile(path.join(f.target, ".pi-agents", "doc", ".env"), "utf8"), /ENOENT/);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("legacy installer includes Agent Explorer modules", async () => {
	const f = await fixture();
	try {
		await execFileAsync(process.execPath, [installer, "install", f.target, "--legacy"], { env: f.env });
		for (const file of ["subagent-observer.ts", "subagent-transcript.ts", "subagent-explorer.ts"]) {
			assert.equal(await realpath(path.join(f.target, ".pi", "extensions", "pi-agents", file)), path.join(await realpath(repoRoot), file));
		}
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("installer help does not invoke pi or require a target repository", async () => {
	const f = await fixture();
	try {
		const result = await execFileAsync(process.execPath, [installer, "--help"], { env: f.env });
		assert.match(result.stdout, /one-line installer/);
		await assert.rejects(readFile(f.callsFile, "utf8"), /ENOENT/);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
