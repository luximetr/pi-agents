import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_WORKTREE_RETENTION_DAYS,
	appendWorktreeRecord,
	completeWorktreeRecord,
	deleteRetainedWorktree,
	listRetainedWorktrees,
	pruneRetainedWorktrees,
	readWorktreeManifest,
	resolveWorktreesBaseDir,
	runSubagent,
} from "../subagents.ts";
import { showWorktreeManager } from "../ui.ts";

const noAbort = new AbortController().signal;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Create a git repo with one commit; returns the repo root. */
async function initRepo(prefix: string): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
	await writeFile(path.join(root, "base.txt"), "base\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
	return root;
}

function branchExists(repoRoot: string, branch: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: repoRoot, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Create a retained worktree as the extension would, plus its manifest record. */
function makeRetainedWorktree(root: string, agent: string, name: string, ageDays: number): { branch: string; path: string } {
	const branch = `pi-agents/${agent}/${name}`;
	const worktreePath = path.join(root, ".git", "pi-agents-worktrees", name);
	execFileSync("git", ["worktree", "add", "--quiet", "-b", branch, worktreePath, "HEAD"], { cwd: root });
	const now = Date.now();
	appendWorktreeRecord(resolveWorktreesBaseDir(root).baseDir, {
		branch,
		path: worktreePath,
		agent,
		startedAt: now - ageDays * DAY_MS,
		status: "completed",
		finishedAt: now - ageDays * DAY_MS,
	});
	return { branch, path: worktreePath };
}

test("manifest records track the worktree lifecycle", async () => {
	const root = await initRepo("pi-agents-manifest-");
	try {
		const { baseDir } = resolveWorktreesBaseDir(root);
		assert.deepEqual(readWorktreeManifest(baseDir), []);
		const record = { branch: "pi-agents/dev/a1", path: "/tmp/wt-a1", agent: "dev", startedAt: 100, status: "running" as const };
		appendWorktreeRecord(baseDir, record);
		assert.deepEqual(readWorktreeManifest(baseDir), [record]);
		// Re-appending the same branch replaces instead of duplicating.
		appendWorktreeRecord(baseDir, { ...record, startedAt: 200 });
		completeWorktreeRecord(baseDir, record.branch, "completed", 300);
		const records = readWorktreeManifest(baseDir);
		assert.equal(records.length, 1);
		assert.equal(records[0].status, "completed");
		assert.equal(records[0].startedAt, 200);
		assert.equal(records[0].finishedAt, 300);
		// Completing an unknown branch is a no-op.
		completeWorktreeRecord(baseDir, "pi-agents/dev/unknown", "failed");
		assert.equal(readWorktreeManifest(baseDir).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prune removes old clean worktrees and their merged branches, keeps recent ones", async () => {
	const root = await initRepo("pi-agents-prune-");
	try {
		const old = makeRetainedWorktree(root, "dev", "old-clean", 10);
		const recent = makeRetainedWorktree(root, "dev", "recent-clean", 1);
		const result = pruneRetainedWorktrees(root, { maxAgeDays: DEFAULT_WORKTREE_RETENTION_DAYS });
		assert.deepEqual(result.removed.map((entry) => entry.branch), [old.branch]);
		assert.ok(result.skipped.some((entry) => entry.branch === recent.branch));
		assert.ok(!existsSync(old.path), "old worktree directory removed");
		assert.ok(existsSync(recent.path), "recent worktree kept");
		assert.equal(branchExists(root, old.branch), false, "merged branch deleted");
		assert.equal(branchExists(root, recent.branch), true);
		// Manifest keeps only the surviving record.
		const records = readWorktreeManifest(resolveWorktreesBaseDir(root).baseDir);
		assert.deepEqual(records.map((record) => record.branch), [recent.branch]);
		// maxAgeDays: 0 disables pruning entirely.
		const disabled = pruneRetainedWorktrees(root, { maxAgeDays: 0 });
		assert.equal(disabled.removed.length, 0);
		assert.ok(existsSync(recent.path));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prune never touches dirty worktrees or branches with unmerged commits", async () => {
	const root = await initRepo("pi-agents-prune-safe-");
	try {
		const dirty = makeRetainedWorktree(root, "dev", "old-dirty", 10);
		await writeFile(path.join(dirty.path, "wip.txt"), "uncommitted\n");
		const unmerged = makeRetainedWorktree(root, "dev", "old-unmerged", 10);
		await writeFile(path.join(unmerged.path, "child-work.txt"), "committed by child\n");
		execFileSync("git", ["add", "."], { cwd: unmerged.path });
		execFileSync("git", ["commit", "-q", "-m", "child commit"], { cwd: unmerged.path });

		const result = pruneRetainedWorktrees(root, { maxAgeDays: DEFAULT_WORKTREE_RETENTION_DAYS });
		assert.ok(result.skipped.some((entry) => entry.branch === dirty.branch && entry.reason.includes("uncommitted")));
		assert.ok(!existsSync(unmerged.path), "clean checkout past retention is removed…");
		assert.equal(branchExists(root, unmerged.branch), true, "…but the unmerged branch survives");
		assert.ok(result.keptBranches.some((entry) => entry.branch === unmerged.branch));
		assert.ok(existsSync(dirty.path));
		// The unmerged record is retained so the branch stays discoverable.
		const records = readWorktreeManifest(resolveWorktreesBaseDir(root).baseDir);
		assert.ok(records.some((record) => record.branch === unmerged.branch));

		// Manual deletion also refuses dirty worktrees.
		const refused = deleteRetainedWorktree(root, dirty.branch);
		assert.equal(refused.removed, false);
		assert.match(refused.reason ?? "", /uncommitted/);
		assert.ok(existsSync(dirty.path));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stale manifest records are cleaned up and merged branches deleted", async () => {
	const root = await initRepo("pi-agents-stale-");
	try {
		const { baseDir } = resolveWorktreesBaseDir(root);
		const ghostBranch = "pi-agents/dev/ghost";
		execFileSync("git", ["branch", ghostBranch], { cwd: root }); // merged (points at HEAD)
		appendWorktreeRecord(baseDir, {
			branch: ghostBranch,
			path: path.join(root, ".git", "pi-agents-worktrees", "vanished"),
			agent: "dev",
			startedAt: Date.now() - 10 * DAY_MS,
			status: "completed",
			finishedAt: Date.now() - 10 * DAY_MS,
		});
		const result = pruneRetainedWorktrees(root, {});
		assert.deepEqual(result.removed.map((entry) => entry.branch), [ghostBranch]);
		assert.equal(branchExists(root, ghostBranch), false);
		assert.deepEqual(readWorktreeManifest(baseDir), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listing includes orphan pi-agents worktrees missing from the manifest", async () => {
	const root = await initRepo("pi-agents-orphan-");
	try {
		const orphanPath = path.join(root, ".git", "pi-agents-worktrees", "orphan");
		execFileSync("git", ["worktree", "add", "--quiet", "-b", "pi-agents/doc/orphan-1", orphanPath, "HEAD"], { cwd: root });
		const listing = listRetainedWorktrees(root);
		const orphan = listing.items.find((item) => item.branch === "pi-agents/doc/orphan-1");
		assert.ok(orphan);
		assert.equal(orphan.recorded, false);
		assert.equal(orphan.agent, "doc");
		assert.equal(orphan.dirExists, true);
		assert.equal(orphan.dirty, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runSubagent records the worktree lifecycle in the manifest", async () => {
	const root = await initRepo("pi-agents-record-");
	const fakePi = path.join(root, "fake-pi.mjs");
	try {
		await writeFile(fakePi, `#!/usr/bin/env node
			process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "done" }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
			process.exit(0);
		`);
		await chmod(fakePi, 0o755);
		let branch = "";
		await runSubagent("worker", "task", root, noAbort, {
			executable: fakePi,
			useWorktree: true,
			onWorktreeCreated: (worktree) => { branch = worktree.branch; },
		});
		const { baseDir } = resolveWorktreesBaseDir(root);
		const records = readWorktreeManifest(baseDir);
		assert.equal(records.length, 1);
		assert.equal(records[0].branch, branch);
		assert.equal(records[0].agent, "worker");
		assert.equal(records[0].status, "completed");
		assert.ok(typeof records[0].finishedAt === "number");

		// A failing child marks its worktree record failed but still retains it.
		const failingPi = path.join(root, "failing-pi.mjs");
		await writeFile(failingPi, "#!/usr/bin/env node\nprocess.exit(3);\n");
		await chmod(failingPi, 0o755);
		await assert.rejects(runSubagent("worker", "task", root, noAbort, { executable: failingPi, useWorktree: true }));
		const after = readWorktreeManifest(baseDir);
		assert.equal(after.length, 2);
		assert.equal(after.find((record) => record.branch !== branch)?.status, "failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("worktree manager renders rows and deletes on confirm", async () => {
	const removed: string[] = [];
	const item = {
		branch: "pi-agents/dev/w1",
		agent: "dev",
		ageLabel: "2d",
		dirty: false,
		unmerged: false,
		stale: false,
		status: "completed",
	};
	let items = [item];
	let component: any;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = {
		ui: {
			theme,
			notify: () => {},
			custom: (factory: any) => new Promise<void>((resolve) => {
				component = factory({ requestRender: () => {} }, theme, {}, resolve);
			}),
		},
	};
	const manager = showWorktreeManager(
		ctx,
		() => ({ baseDir: "/repo/.git/pi-agents-worktrees", items }),
		{
			remove: (selected) => {
				removed.push(selected.branch);
				items = [];
				return `${selected.branch}: worktree removed`;
			},
			prune: () => "Pruned 0 worktrees",
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = component.render(120).join("\n");
	assert.ok(rendered.includes("Retained Subagent Worktrees (1)"));
	assert.ok(rendered.includes("pi-agents/dev/w1"));
	assert.ok(rendered.includes("unmerged") === false);
	component.handleInput("d");
	component.handleInput("y");
	await manager;
	assert.deepEqual(removed, ["pi-agents/dev/w1"]);
});

test("worktree manager flags dirty and unmerged rows", async () => {
	const item = { branch: "pi-agents/dev/dirty", agent: "dev", ageLabel: "5d", dirty: true, unmerged: true, stale: false, status: "stopped" };
	let component: any;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = {
		ui: {
			theme,
			notify: () => {},
			custom: (factory: any) => new Promise<void>((resolve) => {
				component = factory({ requestRender: () => {} }, theme, {}, resolve);
			}),
		},
	};
	const manager = showWorktreeManager(ctx, () => ({ baseDir: "/b", items: [item] }), { remove: () => "", prune: () => "" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = component.render(160).join("\n");
	assert.ok(rendered.includes("dirty"));
	assert.ok(rendered.includes("unmerged"));
	component.handleInput("\x1b"); // esc closes
	await manager;
});
