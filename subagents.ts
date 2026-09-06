import { execFileSync, execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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

export interface SubagentWorktreeOptions {
	/** Checkout parent directory. Relative paths are resolved from the repository root. Defaults inside the common git directory. */
	baseDir?: string;
	/** Copy uncommitted .env and .env.* files found beside tracked project files. Defaults to true. */
	copyEnvFiles?: boolean;
	/** Additional files or directories to copy from the source checkout, relative to the repository root. */
	copyFiles?: string[];
	/** Shell command run at the new worktree root before the child starts, e.g. `bun install --frozen-lockfile`. */
	setupCommand?: string;
}

export interface SubagentWorktreeInfo {
	branch: string;
	path: string;
	cwd: string;
	repoRoot: string;
	/** Worktree parent directory; also where the retention manifest lives. */
	baseDir: string;
}

export interface RunSubagentOptions {
	onProgress?: (event: SubagentProgress) => void;
	onHandle?: (handle: RunningSubagentHandle | undefined) => void;
	onWorktreeCreated?: (worktree: SubagentWorktreeInfo) => void;
	executable?: string;
	/** Pi model pattern or provider/model ID selected for the child process. */
	model?: string;
	/** Run the child in a separate worktree on an automatically named branch. Defaults to false. */
	useWorktree?: boolean;
	worktree?: SubagentWorktreeOptions;
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

function commandErrorDetail(err: unknown): string {
	const value = err as { stderr?: unknown; stdout?: unknown };
	for (const output of [value?.stderr, value?.stdout]) {
		if (typeof output === "string" && output.trim()) return output.trim();
		if (Buffer.isBuffer(output) && output.toString().trim()) return output.toString().trim();
	}
	return err instanceof Error ? err.message : String(err);
}

function gitOutput(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

function safeRelativePath(value: string): string {
	const normalized = path.normalize(value.trim());
	if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
		throw new Error(`worktree copy path must be relative to the repository root: ${JSON.stringify(value)}`);
	}
	return normalized;
}

function copyIntoWorktree(sourceRoot: string, worktreeRoot: string, relativePath: string): void {
	const relative = safeRelativePath(relativePath);
	const source = path.join(sourceRoot, relative);
	if (!existsSync(source)) return;
	const destination = path.join(worktreeRoot, relative);
	mkdirSync(path.dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: true });
}

/** Find env files without crawling ignored dependency/build trees: inspect directories containing tracked files. */
function copyEnvironmentFiles(sourceRoot: string, worktreeRoot: string): void {
	const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: sourceRoot, stdio: "pipe", encoding: "utf8" });
	const directories = new Set<string>([""]);
	for (const file of tracked.split("\0")) {
		if (file) directories.add(path.dirname(file) === "." ? "" : path.dirname(file));
	}
	for (const directory of directories) {
		const sourceDir = path.join(sourceRoot, directory);
		if (!existsSync(sourceDir)) continue;
		for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
			if (!(entry.name === ".env" || entry.name.startsWith(".env.")) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
			copyIntoWorktree(sourceRoot, worktreeRoot, path.join(directory, entry.name));
		}
	}
}

// --- Retained-worktree bookkeeping ---

/** Lifecycle status of a retained subagent worktree. */
export type WorktreeRecordStatus = "running" | "completed" | "failed" | "stopped" | "timeout";

/** One entry of the retained-worktree manifest (`manifest.json` in the worktree base dir). */
export interface WorktreeRecord {
	branch: string;
	path: string;
	agent: string;
	startedAt: number;
	finishedAt?: number;
	status: WorktreeRecordStatus;
}

/** Clean retained worktrees idle longer than this are pruned at session start (0 disables). */
export const DEFAULT_WORKTREE_RETENTION_DAYS = 7;

const WORKTREE_MANIFEST_FILE = "manifest.json";

function manifestPath(baseDir: string): string {
	return path.join(baseDir, WORKTREE_MANIFEST_FILE);
}

/** Read the retained-worktree manifest (empty when missing or corrupt). */
export function readWorktreeManifest(baseDir: string): WorktreeRecord[] {
	try {
		const parsed = JSON.parse(readFileSync(manifestPath(baseDir), "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is WorktreeRecord =>
			!!entry && typeof entry === "object"
			&& typeof (entry as WorktreeRecord).branch === "string"
			&& typeof (entry as WorktreeRecord).path === "string"
			&& typeof (entry as WorktreeRecord).agent === "string"
			&& typeof (entry as WorktreeRecord).startedAt === "number",
		);
	} catch {
		return [];
	}
}

function writeWorktreeManifest(baseDir: string, records: WorktreeRecord[]): void {
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(manifestPath(baseDir), `${JSON.stringify(records, null, "\t")}\n`);
}

/** Add (or replace) a manifest record for a freshly created worktree. */
export function appendWorktreeRecord(baseDir: string, record: WorktreeRecord): void {
	const records = readWorktreeManifest(baseDir).filter((existing) => existing.branch !== record.branch && existing.path !== record.path);
	records.push(record);
	writeWorktreeManifest(baseDir, records);
}

/** Mark a running record as finished; no-op when the branch was never recorded. */
export function completeWorktreeRecord(baseDir: string, branch: string, status: Exclude<WorktreeRecordStatus, "running">, finishedAt = Date.now()): void {
	const records = readWorktreeManifest(baseDir);
	const match = records.find((record) => record.branch === branch);
	if (!match) return;
	match.status = status;
	match.finishedAt = finishedAt;
	writeWorktreeManifest(baseDir, records);
}

/** Resolve the repository root and the worktree parent directory (default: inside the common git dir). */
export function resolveWorktreesBaseDir(cwd: string, options?: SubagentWorktreeOptions): { repoRoot: string; baseDir: string } {
	let repoRoot: string;
	try {
		repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
	} catch (err) {
		throw new Error(`cannot locate the git repository: ${commandErrorDetail(err)}`);
	}
	let commonGitDir: string;
	try {
		commonGitDir = path.resolve(repoRoot, gitOutput(repoRoot, ["rev-parse", "--git-common-dir"]));
	} catch (err) {
		throw new Error(`cannot locate the git repository: ${commandErrorDetail(err)}`);
	}
	const baseDir = options?.baseDir?.trim()
		? path.resolve(repoRoot, options.baseDir)
		: path.join(commonGitDir, "pi-agents-worktrees");
	return { repoRoot, baseDir };
}

interface LiveWorktree { path: string; branch?: string }

function listLiveWorktrees(repoRoot: string): LiveWorktree[] {
	let output: string;
	try {
		output = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
	} catch {
		return [];
	}
	const items: LiveWorktree[] = [];
	let current: LiveWorktree | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) items.push(current);
			current = { path: line.slice("worktree ".length).trim() };
		} else if (current && line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		}
	}
	if (current) items.push(current);
	return items;
}

function canonical(value: string): string {
	try { return realpathSync(value); } catch { return value; }
}

function branchExists(repoRoot: string, branch: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: repoRoot, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** True when the branch holds no commits beyond the main checkout's HEAD. */
function isBranchMergedIntoHead(repoRoot: string, branch: string): boolean {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function isPathDirty(worktreePath: string): boolean | undefined {
	try {
		return execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, stdio: "pipe", encoding: "utf8" }).trim().length > 0;
	} catch {
		return undefined;
	}
}

function agentNameFromBranch(branch: string): string {
	return branch.split("/")[1] ?? branch;
}

/** A retained subagent worktree as shown by the manager and considered by pruning. */
export interface RetainedWorktree {
	branch: string;
	path: string;
	agent: string;
	startedAt: number;
	finishedAt?: number;
	status?: WorktreeRecordStatus;
	/** Directory present on disk and known to git as a worktree. */
	dirExists: boolean;
	/** Tracked/untracked modifications in the worktree (undefined when unknowable). */
	dirty?: boolean;
	/** Branch fully merged into the main checkout's HEAD (undefined when the branch is gone). */
	merged?: boolean;
	/** Present in the manifest (false = orphan worktree discovered on disk). */
	recorded: boolean;
}

export interface RetainedWorktreeListing {
	repoRoot: string;
	baseDir: string;
	items: RetainedWorktree[];
}

/** Enumerate retained subagent worktrees: manifest records plus orphan checkouts under the base dir. */
export function listRetainedWorktrees(cwd: string, options?: SubagentWorktreeOptions): RetainedWorktreeListing {
	const { repoRoot, baseDir } = resolveWorktreesBaseDir(cwd, options);
	const canonicalBase = canonical(baseDir);
	const liveByPath = new Map(listLiveWorktrees(repoRoot).map((entry) => [canonical(entry.path), entry]));

	const items = new Map<string, RetainedWorktree>();
	for (const record of readWorktreeManifest(baseDir)) {
		const dirExists = liveByPath.has(canonical(record.path)) || existsSync(record.path);
		items.set(record.branch, {
			branch: record.branch,
			path: record.path,
			agent: record.agent,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			status: record.status,
			dirExists,
			dirty: dirExists ? isPathDirty(record.path) : undefined,
			merged: branchExists(repoRoot, record.branch) ? isBranchMergedIntoHead(repoRoot, record.branch) : undefined,
			recorded: true,
		});
	}
	// Orphan checkouts created before tracking existed (or with a lost manifest).
	for (const [livePath, entry] of liveByPath) {
		if (!entry.branch?.startsWith("pi-agents/")) continue;
		if (livePath !== canonicalBase && !livePath.startsWith(`${canonicalBase}${path.sep}`)) continue;
		if ([...items.values()].some((item) => canonical(item.path) === livePath)) continue;
		let startedAt = 0;
		try { startedAt = statSync(entry.path).mtimeMs; } catch { /* unreadable dir — age 0 keeps it safe from pruning */ }
		items.set(entry.branch, {
			branch: entry.branch,
			path: entry.path,
			agent: agentNameFromBranch(entry.branch),
			startedAt,
			dirExists: true,
			dirty: isPathDirty(entry.path),
			merged: isBranchMergedIntoHead(repoRoot, entry.branch),
			recorded: false,
		});
	}
	return { repoRoot, baseDir, items: [...items.values()] };
}

export interface RemoveWorktreeResult {
	removed: boolean;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	reason?: string;
}

function removeWorktreeEntry(repoRoot: string, item: RetainedWorktree): RemoveWorktreeResult {
	let worktreeRemoved = false;
	let branchRemoved = false;
	const failures: string[] = [];
	if (item.dirExists) {
		try {
			execFileSync("git", ["worktree", "remove", item.path], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
			worktreeRemoved = true;
		} catch (err) {
			failures.push(`worktree remove failed: ${commandErrorDetail(err)}`);
		}
	} else {
		// Stale registration: drop git's bookkeeping for the vanished directory.
		try { execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" }); } catch { /* best effort */ }
		worktreeRemoved = true;
	}
	// Unmerged branches are always kept: deleting one would destroy committed child work.
	if (worktreeRemoved && item.merged !== false && branchExists(repoRoot, item.branch)) {
		try {
			execFileSync("git", ["branch", "-D", item.branch], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
			branchRemoved = true;
		} catch (err) {
			failures.push(`branch delete failed: ${commandErrorDetail(err)}`);
		}
	}
	return { removed: worktreeRemoved || branchRemoved, worktreeRemoved, branchRemoved, reason: failures.length > 0 ? failures.join("; ") : undefined };
}

/** Keep a manifest record only while it still describes something: an existing dir or unmerged commits. */
function retainManifestRecord(repoRoot: string, record: WorktreeRecord): boolean {
	if (existsSync(record.path)) return true;
	return branchExists(repoRoot, record.branch) && !isBranchMergedIntoHead(repoRoot, record.branch);
}

function syncManifest(repoRoot: string, baseDir: string): void {
	const records = readWorktreeManifest(baseDir);
	const remaining = records.filter((record) => retainManifestRecord(repoRoot, record));
	if (remaining.length !== records.length) writeWorktreeManifest(baseDir, remaining);
}

/** Delete one retained worktree by branch. Refuses dirty worktrees; keeps unmerged branches. */
export function deleteRetainedWorktree(cwd: string, branch: string, options?: SubagentWorktreeOptions): RemoveWorktreeResult {
	const { repoRoot, baseDir } = resolveWorktreesBaseDir(cwd, options);
	const item = listRetainedWorktrees(cwd, options).items.find((candidate) => candidate.branch === branch);
	if (!item) return { removed: false, worktreeRemoved: false, branchRemoved: false, reason: `no retained worktree for branch "${branch}"` };
	if (item.dirExists && item.dirty) {
		return { removed: false, worktreeRemoved: false, branchRemoved: false, reason: "worktree has uncommitted changes" };
	}
	const outcome = removeWorktreeEntry(repoRoot, item);
	syncManifest(repoRoot, baseDir);
	return outcome;
}

export interface PruneWorktreesOptions extends SubagentWorktreeOptions {
	/** Remove clean worktrees idle at least this many days. 0 disables pruning. Default: DEFAULT_WORKTREE_RETENTION_DAYS. */
	maxAgeDays?: number;
	/** Current time in ms for age computations; defaults to Date.now(). */
	now?: number;
}

export interface PruneWorktreesResult {
	removed: Array<{ branch: string; path: string }>;
	keptBranches: Array<{ branch: string; reason: string }>;
	skipped: Array<{ branch: string; reason: string }>;
}

/**
 * Garbage-collect retained subagent worktrees: removes clean checkouts past the
 * retention window and their merged branches. Dirty worktrees and branches with
 * unmerged commits are never touched.
 */
export function pruneRetainedWorktrees(cwd: string, options?: PruneWorktreesOptions): PruneWorktreesResult {
	const result: PruneWorktreesResult = { removed: [], keptBranches: [], skipped: [] };
	const maxAgeDays = options?.maxAgeDays ?? DEFAULT_WORKTREE_RETENTION_DAYS;
	if (maxAgeDays <= 0) return result;
	const { repoRoot, baseDir } = resolveWorktreesBaseDir(cwd, options);
	const now = options?.now ?? Date.now();
	const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
	for (const item of listRetainedWorktrees(cwd, options).items) {
		const finishedAt = item.finishedAt ?? item.startedAt;
		const ageMs = finishedAt > 0 ? now - finishedAt : 0;
		if (item.dirExists && item.dirty) {
			result.skipped.push({ branch: item.branch, reason: "has uncommitted changes" });
			continue;
		}
		if (ageMs < cutoffMs) {
			result.skipped.push({ branch: item.branch, reason: "younger than the retention window" });
			continue;
		}
		const outcome = removeWorktreeEntry(repoRoot, item);
		if (outcome.worktreeRemoved) result.removed.push({ branch: item.branch, path: item.path });
		else result.skipped.push({ branch: item.branch, reason: outcome.reason ?? "remove failed" });
		if (!outcome.branchRemoved && branchExists(repoRoot, item.branch)) {
			result.keptBranches.push({ branch: item.branch, reason: "branch has unmerged commits" });
		}
	}
	syncManifest(repoRoot, baseDir);
	return result;
}

function generatedBranchName(agentName: string): string {
	const agent = agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
	return `pi-agents/${agent}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function rollbackWorktree(sourceRoot: string, branch: string, worktreePath: string): void {
	try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: sourceRoot, stdio: "ignore" }); } catch { /* best effort */ }
	try { execFileSync("git", ["branch", "-D", branch], { cwd: sourceRoot, stdio: "ignore" }); } catch { /* best effort */ }
	try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
}

function createSubagentWorktree(cwd: string, branch: string, options: SubagentWorktreeOptions = {}): SubagentWorktreeInfo {
	let relativeCwd: string;
	try {
		relativeCwd = gitOutput(cwd, ["rev-parse", "--show-prefix"]).replace(/[\\/]$/, "");
	} catch (err) {
		throw new Error(`cannot create worktree for branch "${branch}": ${commandErrorDetail(err)}`);
	}

	let repoRoot: string;
	let baseDir: string;
	try {
		({ repoRoot, baseDir } = resolveWorktreesBaseDir(cwd, options));
	} catch (err) {
		throw new Error(`cannot create worktree for branch "${branch}": ${err instanceof Error ? err.message : String(err)}`);
	}
	mkdirSync(baseDir, { recursive: true });
	const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "branch";
	const worktreePath = path.join(baseDir, `${slug}-${randomUUID().slice(0, 8)}`);

	try {
		execFileSync("git", ["worktree", "add", "--quiet", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
	} catch (err) {
		throw new Error(`cannot create worktree for branch "${branch}": ${commandErrorDetail(err)}`);
	}

	try {
		if (options.copyEnvFiles !== false) copyEnvironmentFiles(repoRoot, worktreePath);
		for (const file of options.copyFiles ?? []) copyIntoWorktree(repoRoot, worktreePath, file);
		const childCwd = path.join(worktreePath, relativeCwd);
		mkdirSync(childCwd, { recursive: true });
		if (options.setupCommand?.trim()) {
			execSync(options.setupCommand, {
				cwd: worktreePath,
				env: {
					...process.env,
					PI_AGENTS_SOURCE_ROOT: repoRoot,
					PI_AGENTS_WORKTREE_ROOT: worktreePath,
				},
				stdio: "pipe",
				encoding: "utf8",
			});
		}
		return { branch, path: worktreePath, cwd: childCwd, repoRoot, baseDir };
	} catch (err) {
		rollbackWorktree(repoRoot, branch, worktreePath);
		throw new Error(`cannot prepare worktree for branch "${branch}": ${commandErrorDetail(err)}`);
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

		let childCwd = cwd;
		let createdWorktree: SubagentWorktreeInfo | undefined;
		if (options.useWorktree === true) {
			try {
				createdWorktree = createSubagentWorktree(cwd, generatedBranchName(agentName), options.worktree);
				childCwd = createdWorktree.cwd;
				options.onWorktreeCreated?.(createdWorktree);
			} catch (err) {
				reject(err);
				return;
			}
		}

		const childArgs = ["--mode", "rpc", "--no-session", "--agent", agentName];
		if (options.model?.trim()) childArgs.push("--model", options.model.trim());
		const invocation = piInvocation(childArgs, options.executable);
		const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			env: {
				...process.env,
				PI_AGENTS_SUBAGENT_DEPTH: String(depth + 1),
				...(options.runtimeAgentOverrides && Object.keys(options.runtimeAgentOverrides).length > 0
					? { PI_AGENTS_STUDIO_OVERRIDES: JSON.stringify(options.runtimeAgentOverrides) }
					: {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const startedAt = Date.now();
		const state: SubagentSnapshot = {
			id: options.id ?? `subagent-${nextSubagentId++}`,
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
		// Track the retained worktree so the manager and retention pruning can see it.
		if (createdWorktree) {
			try {
				appendWorktreeRecord(createdWorktree.baseDir, {
					branch: createdWorktree.branch,
					path: createdWorktree.path,
					agent: agentName,
					startedAt,
					status: "running",
				});
			} catch { /* best effort: retention bookkeeping must never break delegation */ }
		}

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
			snapshot: () => ({ ...state, recentEvents: [...state.recentEvents], usage: state.usage ? { ...state.usage } : undefined }),
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
					// An aborted child also emits agent_settled while shutting down. Keep
					// the stop phase in that case so diagnostics do not claim that a
					// timed-out or interrupted delegation finished successfully.
					if (!state.stopReason) {
						state.phase = "finished";
						state.status = "finished";
						addEvent(`✓ ${agentName}: finished`);
						progress?.({ type: "finished" });
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
		child.stdout.on("data", (chunk: Buffer) => consume(chunk));
		child.stdout.on("end", () => consume("", true));
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		if (timeoutSeconds !== undefined) {
			deadlineTimer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
			deadlineTimer.unref?.();
		}
		if (signal.aborted) parentAbort();
		signal.addEventListener("abort", parentAbort, { once: true });
		const recordOutcome = (status: Exclude<WorktreeRecordStatus, "running">) => {
			if (!createdWorktree) return;
			try { completeWorktreeRecord(createdWorktree.baseDir, createdWorktree.branch, status); } catch { /* best effort */ }
		};
		child.on("error", () => recordOutcome("failed"));
		child.on("close", (code) => finish(() => {
			recordOutcome(
				state.stopReason === "timeout" ? "timeout"
				: state.stopReason ? "stopped"
				: code !== 0 && !gracefulExit ? "failed"
				: "completed",
			);
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
