import { Tools, type AgentConfig } from "../../agents";

/**
 * Example agent: repository inspection via per-agent custom tools.
 * No MCP server, no separate extension — the tools are defined right here,
 * registered when the agent is applied and active only while it is.
 */
const cfg: AgentConfig = {
	name: "git",
	description: "Git agent: inspect repository state and history via custom git tools.",
	color: "#ff9f0a",
	tools: [Tools.read, Tools.grep, Tools.find, Tools.ls],
	customTools: {
		git_status: {
			description: "Show the git working tree status (optionally short)",
			parameters: {
				type: "object",
				properties: { short: { type: "boolean", description: "Use --short format" } },
			},
			execute: async (args, _ctx, exec) => {
				const r = await exec("git", ["status", ...(args.short ? ["--short"] : [])]);
				return r.stdout.trim() || r.stderr.trim();
			},
		},
		git_log: {
			description: "Show the last N commits with one-line summary",
			parameters: {
				type: "object",
				properties: { n: { type: "integer", description: "Number of commits (default 10)" } },
			},
			execute: async (args, _ctx, exec) => {
				const r = await exec("git", ["log", `-${args.n ?? 10}`, "--oneline", "--decorate"]);
				return r.stdout.trim() || r.stderr.trim();
			},
		},
		git_diff: {
			description: "Show uncommitted changes (or staged changes with staged=true)",
			parameters: {
				type: "object",
				properties: { staged: { type: "boolean", description: "Diff the staged (cached) changes" } },
			},
			execute: async (args, _ctx, exec) => {
				const r = await exec("git", ["diff", ...(args.staged ? ["--cached"] : [])]);
				return r.stdout.trim() || r.stderr.trim();
			},
		},
		git_show: {
			description: "Show a commit: stats, message, and diff",
			parameters: {
				type: "object",
				properties: { commit: { type: "string", description: "Commit hash, ref, or range" } },
				required: ["commit"],
			},
			execute: async (args, _ctx, exec) => {
				const r = await exec("git", ["show", "--stat", String(args.commit)]);
				return r.stdout.trim() || r.stderr.trim();
			},
		},
		git_branches: {
			description: "List local and remote branches with their last commit",
			execute: async (_args, _ctx, exec) => {
				const r = await exec("git", ["branch", "-a", "-vv"]);
				return r.stdout.trim() || r.stderr.trim();
			},
		},
	},
	systemPrompt: `You are the GIT agent. You inspect repository state and history with the custom git_* tools — use them instead of bash.`,
};

export default cfg;
