import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSubagentWorkspace } from "../subagent-workspace.ts";
import { runSubagent, SubagentStoppedError, type SubagentSnapshot, type RunningSubagentHandle } from "../subagents.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-test-"));
	const repo = path.join(root, "repo");
	await mkdir(path.join(repo, "src"), { recursive: true });
	git(repo, "init");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	await writeFile(path.join(repo, "src", "tracked"), "committed");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "initial");
	return { root, repo };
}

test("workspaces isolate HEAD, preserve subdirectory cwd, reuse dirty state, and nest from parent HEAD", async () => {
	const { root, repo } = await fixture();
	try {
		await writeFile(path.join(repo, "src", "tracked"), "parent dirty");
		await writeFile(path.join(repo, "src", "untracked"), "not inherited");
		const meta = path.join(root, "one.json");
		const one = await prepareSubagentWorkspace(path.join(repo, "src"), meta, "worktree");
		assert.equal(await readFile(path.join(one.workspaceCwd, "tracked"), "utf8"), "committed");
		assert.equal(existsSync(path.join(one.workspaceCwd, "untracked")), false);
		assert.equal(one.workspaceBaseCommit, git(repo, "rev-parse", "HEAD"));
		assert.equal(one.workspaceBranch, null);
		await writeFile(path.join(one.workspaceCwd, "tracked"), "child commit");
		git(one.workspaceCwd, "add", ".");
		git(one.workspaceCwd, "commit", "-m", "child");
		await writeFile(path.join(one.workspaceCwd, "tracked"), "child dirty");
		assert.deepEqual(await prepareSubagentWorkspace(repo, meta), one);
		assert.equal(await readFile(path.join(one.workspaceCwd, "tracked"), "utf8"), "child dirty");
		await assert.rejects(prepareSubagentWorkspace(repo, meta, "shared"), /Cannot change/);
		const nested = await prepareSubagentWorkspace(one.workspaceCwd, path.join(root, "nested.json"), "worktree");
		assert.equal(await readFile(path.join(nested.workspaceCwd, "tracked"), "utf8"), "child commit");
		const shared = await prepareSubagentWorkspace(one.workspaceCwd, path.join(root, "shared.json"));
		assert.equal(shared.workspaceCwd, one.workspaceCwd);
		await assert.rejects(prepareSubagentWorkspace(repo, path.join(root, "lost.json"), undefined, one.workspaceCwd), /metadata is missing/);
		const two = await prepareSubagentWorkspace(repo, path.join(root, "two.json"), "worktree");
		assert.notEqual(two.worktreePath, one.worktreePath);
		await rm(one.worktreePath!, { recursive: true });
		await assert.rejects(prepareSubagentWorkspace(repo, meta), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace failures are explicit: non-repo, unborn HEAD, old history, invalid mode and metadata", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-fail-"));
	try {
		const meta = path.join(root, "meta.json");
		await assert.rejects(prepareSubagentWorkspace(root, meta, "worktree"), /Cannot create subagent worktree/);
		assert.equal(existsSync(meta), false);
		git(root, "init");
		await assert.rejects(prepareSubagentWorkspace(root, meta, "worktree"), /Cannot create subagent worktree/);
		await assert.rejects(prepareSubagentWorkspace(root, meta, "worktree", root), /metadata is missing/);
		await assert.rejects(prepareSubagentWorkspace(root, meta, "invalid" as any), /workspace must be/);
		await writeFile(meta, "{}");
		await assert.rejects(prepareSubagentWorkspace(root, meta), /Invalid thread workspace/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("child launch and replies use saved workspace; shutdown and cancellation preserve changes", async () => {
	const { root, repo } = await fixture();
	try {
		const executable = path.join(root, "fake.mjs");
		await writeFile(executable, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
const session = process.argv[process.argv.indexOf('--session') + 1];
if (!existsSync(session)) writeFileSync(session, JSON.stringify({type:'session', version:3, id:'test', cwd:process.cwd(), timestamp:new Date().toISOString()}) + '\\n');
process.stdin.once('data', () => {
 writeFileSync('change', 'keep me');
 console.log(JSON.stringify({type:'message_end', message:{content:[{type:'text', text:process.cwd()}]}}));
 console.log(JSON.stringify({type:'agent_settled'}));
});
`);
		await chmod(executable, 0o755);
		const sessionDir = path.join(root, "sessions");
		let snapshot: SubagentSnapshot | undefined;
		const options = { executable, participantSessionDir: sessionDir, rootSessionId: "root", threadId: "thread", onSnapshot: (value: SubagentSnapshot) => { snapshot = value; } };
		const first = await runSubagent("worker", "first", repo, new AbortController().signal, { ...options, workspace: "worktree" });
		assert.equal(first, snapshot?.workspaceCwd);
		assert.equal(snapshot?.workspace, "worktree");
		assert.equal(readFileSync(path.join(first, "change"), "utf8"), "keep me");
		assert.equal(await runSubagent("worker", "reply", repo, new AbortController().signal, { ...options, resume: true }), first);
		await assert.rejects(runSubagent("worker", "reply", repo, new AbortController().signal, { ...options, resume: true, workspace: "shared" }), /Cannot change/);
		let cancelledHandle: RunningSubagentHandle | undefined;
		let cancelledPath: string | undefined;
		await assert.rejects(runSubagent("worker", "stop", repo, new AbortController().signal, {
			...options, threadId: "cancelled", workspace: "worktree",
			onHandle: handle => { cancelledHandle = handle; },
			onSnapshot: value => {
				if (value.workspaceCwd && !cancelledPath) {
					cancelledPath = value.workspaceCwd;
					cancelledHandle?.stop("user");
				}
			},
		}), SubagentStoppedError);
		assert.ok(cancelledPath && existsSync(cancelledPath), "cancelled worktrees are retained");
		await rm(sessionDir, { recursive: true });
		assert.equal(readFileSync(path.join(first, "change"), "utf8"), "keep me", "session cleanup never deletes worktrees");
	} finally { await rm(root, { recursive: true, force: true }); }
});
