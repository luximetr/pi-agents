import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type SubagentWorkspace = "shared" | "worktree";

/** Persisted per thread; never remove worktrees as part of session cleanup. */
export interface SubagentWorkspaceInfo {
	workspace: SubagentWorkspace;
	workspaceCwd: string;
	worktreePath?: string;
	workspaceBaseCommit?: string;
	/** Branch observed before launch; null denotes detached HEAD. */
	workspaceBranch?: string | null;
}

const exec = promisify(execFile);
/** Caller holds the participant lock. Sidecar lives with history; worktree does not. */
export async function prepareSubagentWorkspace(
	cwd: string, metadataFile: string, requested?: SubagentWorkspace, existingHistory: false | string = false, signal?: AbortSignal,
): Promise<SubagentWorkspaceInfo> {
	async function git(cwd: string, ...args: string[]): Promise<string> {
		const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", signal });
		return stdout.trim();
	}
	if (requested !== undefined && requested !== "shared" && requested !== "worktree") throw new Error("workspace must be 'shared' or 'worktree'");
	let saved: SubagentWorkspaceInfo | undefined;
	try {
		saved = JSON.parse(await readFile(metadataFile, "utf8"));
		if (!saved || !["shared", "worktree"].includes(saved.workspace) || typeof saved.workspaceCwd !== "string" || !path.isAbsolute(saved.workspaceCwd)
			|| (saved.workspace === "worktree" && (typeof saved.worktreePath !== "string" || !path.isAbsolute(saved.worktreePath) || typeof saved.workspaceBaseCommit !== "string"))) {
			throw new Error(`Invalid thread workspace metadata: ${metadataFile}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (saved) {
		if (requested !== undefined && requested !== saved.workspace) throw new Error("Cannot change workspace mode for an existing thread.");
		if (!(await stat(saved.workspaceCwd)).isDirectory()) throw new Error(`Thread workspace is not a directory: ${saved.workspaceCwd}`);
		if (saved.workspace === "worktree") {
			const root = await git(saved.workspaceCwd, "rev-parse", "--show-toplevel");
			if (await realpath(root) !== await realpath(saved.worktreePath!)) throw new Error("Thread worktree is missing or was replaced.");
		}
		try {
			const branch = await git(saved.workspaceCwd, "rev-parse", "--abbrev-ref", "HEAD");
			saved.workspaceBranch = branch === "HEAD" ? null : branch;
		} catch (error) { if (saved.workspace === "worktree") throw error; }
		return saved;
	}
	// Legacy shared sessions are safe only if their recorded cwd still matches.
	// Missing metadata must never turn a worktree conversation into shared execution.
	if (existingHistory && (requested === "worktree" || await realpath(existingHistory) !== await realpath(cwd))) {
		throw new Error("Thread workspace metadata is missing; cannot safely reuse existing history.");
	}
	const info: SubagentWorkspaceInfo = { workspace: requested ?? "shared", workspaceCwd: path.resolve(cwd) };
	if (info.workspace === "worktree") {
		try {
			const parentCwd = await realpath(cwd);
			const root = await realpath(await git(cwd, "rev-parse", "--show-toplevel"));
			const relative = path.relative(root, parentCwd);
			if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Parent cwd is outside the repository");
			info.workspaceBaseCommit = await git(cwd, "rev-parse", "--verify", "HEAD^{commit}");
			const commonDir = await realpath(path.resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir")));
			const storage = path.join(commonDir, "pi-agents-workspaces");
			await mkdir(storage, { recursive: true });
			info.worktreePath = path.join(storage, randomUUID());
			info.workspaceCwd = path.join(info.worktreePath, relative);
			await git(cwd, "worktree", "add", "--detach", info.worktreePath, info.workspaceBaseCommit);
			info.workspaceBranch = null;
			if (!(await stat(info.workspaceCwd)).isDirectory()) throw new Error("Parent subdirectory is absent from HEAD");
		} catch (error) {
			throw new Error(`Cannot create subagent worktree${info.worktreePath ? ` at ${info.worktreePath} (retained if created)` : ""}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (info.workspace === "shared") {
		try {
			const branch = await git(info.workspaceCwd, "rev-parse", "--abbrev-ref", "HEAD");
			info.workspaceBranch = branch === "HEAD" ? null : branch;
		} catch { /* Shared delegation also supports non-Git directories. */ }
	}
	// Never clean up a created worktree, even if persisting its metadata fails.
	await writeFile(metadataFile, JSON.stringify(info) + "\n", { flag: "wx", mode: 0o600 });
	return info;
}
