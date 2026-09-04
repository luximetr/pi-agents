# pi-agents guide

This extension defines "agents" in code — each agent is a tool allowlist + system prompt + optional MCP servers. Read this when asked to create agents, add tools, wire up MCP, or explain how the extension works.

## Using the extension (quick start)

- Switch agents: `f7` (picker), `f8` (rotate), or `/agent <name>` (`/agent none` clears). Inspect a running delegated subagent with `f9` or `/subagents`; `/subagents worktrees` manages retained delegation worktrees. Function-key shortcuts work through iTerm2 and herdr without terminal setting changes; configured aliases remain available too.
- Start with an agent from the CLI: `pi --agent dev`.
- The active agent's system prompt is appended every turn; its tools are restricted to its allowlist (+ its MCP tools).
- No agent selected = plain pi, unchanged.
- `/agent:help <question>` answers a question from this guide (e.g. `/agent:help how do I add an MCP server?`).

## Where agents live

- Project: `<git-root>/.pi-agents/` (searched upward from cwd)
- Global: `~/.pi/agent/pi-agents/` (same layout; project wins on name collision)

Commit the project's `.pi-agents/` to the repo — it is the per-project configuration and follows every checkout and worktree. In a git worktree, agents come from the worktree's own checkout (exactly the commit it was created from), and the gitignored `.env` secrets fall back to the main checkout's `.pi-agents/.env` / `.pi-agents/<name>/.env`; a `.env` present in the worktree wins per key. Project agents and configs load only in trusted projects (the extension itself is installed globally); a worktree of an already-trusted repo is trusted automatically, since it contains the same committed code.

## Create an agent

Two layouts:

- Folder: `.pi-agents/<name>/agent.ts` (optionally with a `prompt.md`)
- Single file: `.pi-agents/<name>.ts` (name defaults to the filename)

`agent.ts` default-exports a config object:

```ts
export default {
  name: "browser",
  description: "Drives a browser via MCP.",
  tools: ["read", "bash"],            // allowlist; omit = keep current, [] = no tools
  subagents: ["developer"],            // optional delegation allowlist; object entries may set model/timeout
  mcp: ["playwright"],                // MCP servers to connect (opt-in!)
  // color: "#ff8800",                 // theme role or hex; auto-assigned by name when omitted
  systemPrompt: "You are...",         // inline…
  // systemPromptFile: "./prompt.md", // …or loaded from a file
  // default: true,                   // auto-select on new sessions
};
```

Files are TypeScript loaded via jiti — imports, helpers, and async factories all work. For typed tools + autocomplete:

```ts
import { Tools, type AgentConfig } from "<path to extension>/agents.ts";
const cfg: AgentConfig = {
  name: "doc",
  description: "Documentation agent.",
  tools: [Tools.read, Tools.grep, Tools.write, Tools.edit, Tools.bash],
  systemPrompt: "You are the DOC agent.",
};
export default cfg;
```

## Subagents and hierarchy

An agent can delegate isolated work to another agent with the built-in `delegate` tool:

```ts
export default {
  name: "lead",
  description: "Coordinates specialists.",
  subagents: [
    "developer",
    { name: "researcher", model: "anthropic/claude-sonnet-5", timeoutSeconds: 900 },
  ],
  systemPrompt: "Delegate implementation and research; keep the high-level context short.",
};
```

`subagents` is an allowlist. A string entry uses Pi's normal default model selection and has no deadline. An object entry can fix the model and/or `timeoutSeconds` for that parent-to-child delegation; different parents may configure the same child differently. The parent automatically sees a roster of allowed child names, descriptions, models, and deadlines in its prompt. The child runs as a fresh ephemeral `pi --mode rpc --no-session --agent <name>` process and only its final answer is returned to the parent. Independent delegate calls made together run in parallel. Nested delegation is limited to four levels. Use self-contained tasks with paths, constraints, and the desired result.

`delegate` takes `agent`, `task`, and an optional `useWorktree` boolean (default `false`):

```
delegate(agent: "dev", task: "Implement the parser", useWorktree: true)
delegate(agent: "doc", task: "Document the parser API", useWorktree: true)
```

The agent cannot choose its deadline at call time. Configure `timeoutSeconds` on the parent's subagent entry, or omit it to run without a deadline. While the parent waits, the footer shows the running count and `f9` hint. `f9` or `/subagents` opens a live dashboard of all children with current tool, task, recent activity, cumulative usage, deadline, steering (`s`), and stop (`x`) controls; use `↑↓` or `j k` to select. Manual interruption and timeout return diagnostic context to the parent so it can change approach. Delegate results are compact by default; expand the tool row to read the complete Markdown output. Results over Pi's 2,000-line/50 KB tool limit are truncated for the parent context and saved in full to a private temporary file linked from the result.

When `useWorktree: true` is provided, the extension creates a linked Git worktree on an automatically named branch such as `pi-agents/dev/m4abc123-a1b2c3d4` and starts the child there. Its directory name is generated too. The parent checkout never switches, so delegations can run in parallel with separate files and indexes. Worktrees are retained after completion and their generated branches and paths are returned, preserving uncommitted as well as committed child changes. They default to `.git/pi-agents-worktrees/` in Git's common directory.

Worktrees start from committed `HEAD`; dirty parent source changes are not copied automatically. `.env` and `.env.*` files found beside tracked files are copied by default. Use `subagents.worktree.copyFiles` for other ignored assets and `subagents.worktree.setupCommand` (for example `bun install --frozen-lockfile`) to provision dependencies. Setup runs at the worktree root with `PI_AGENTS_SOURCE_ROOT` and `PI_AGENTS_WORKTREE_ROOT` set. Creation/setup failures roll back the new worktree and branch before returning an error.

Retained worktrees are tracked in a manifest under the worktree base dir. At session start, clean worktrees idle longer than `subagents.worktree.retentionDays` (default 7; `0` disables) are pruned automatically. Dirty worktrees are never removed, and branches with commits not merged into the main checkout's HEAD are always kept. Run `/subagents worktrees` to browse everything that is retained (age, status, dirty/unmerged flags), delete single entries (`d`), or prune past retention immediately (`p`).

## Custom tools (per agent)

Define small agent-specific tools right in `agent.ts` under `customTools` — no MCP server or separate extension needed. Registered when the agent is applied; active only while it is.

```ts
export default {
  name: "dev",
  description: "Developer agent with git tools.",
  tools: ["read", "bash", "edit", "write"],
  customTools: {
    git_status: {
      description: "Show the git working tree status",
      parameters: { type: "object", properties: { short: { type: "boolean" } } },
      execute: async (args, _ctx, exec) => {
        const r = await exec("git", ["status", ...(args.short ? ["--short"] : [])]);
        return r.stdout.trim() || r.stderr.trim();
      },
    },
  },
  systemPrompt: "You are the DEV agent. Use git_status for repository state.",
};
```

- `execute(args, ctx, exec)` — `exec(cmd, args)` runs a shell command in the session cwd (`{ stdout, stderr, code }`). Return a result object `{ content: [...] }` or a plain string.
- `parameters` is JSON Schema, optional (omit = no arguments). Optional `label`, `promptGuidelines`, `executionMode`.
- Active toolset = allowlist ∪ custom tools ∪ MCP tools. A custom tool overrides an existing tool with the same name (warning). Same-named tools across agents: last applied wins.
- The picker shows them as `custom:git_status`.

## config.json (project or global, merged; project wins)

```json
{
  "defaultAgent": "dev",
  "keybindings": {
    "select": ["ctrl+shift+a", "alt+a"],
    "rotate": ["ctrl+shift+q", "alt+q"],
    "inspect": "f9"
  },
  "subagents": {
    "staleWarningMinutes": 5,
    "gracefulStopSeconds": 5,
    "worktree": {
      "copyEnvFiles": true,
      "copyFiles": [],
      "setupCommand": "bun install --frozen-lockfile",
      "retentionDays": 7
    }
  },
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "local": {
      "url": "https://100.91.130.31:3001/mcp",
      "insecure": true,
      "headers": { "Authorization": "Bearer ${DOC_MCP_TOKEN}" }
    }
  }
}
```

- `defaultAgent`: auto-selected on fresh sessions (`null`/unset = plain pi). Overridden by `--agent` flag and per-session selection.
- `keybindings`: each action takes a single key or an array of fallbacks (terminal key encoding varies). The built-in `f7`, `f8`, and `f9` fallbacks are always retained.
- `subagents.staleWarningMinutes`: inactivity threshold shown by the inspector; it does not stop the child.
- `subagents.gracefulStopSeconds`: delay before escalating RPC abort to process signals.
- `subagents.worktree.baseDir`: optional checkout parent, relative to the repository root when not absolute.
- `subagents.worktree.copyEnvFiles`: copy `.env` variants into generated worktrees (default `true`).
- `subagents.worktree.copyFiles`: additional repository-relative files/directories to copy.
- `subagents.worktree.setupCommand`: shell command run before the child starts, such as `bun install --frozen-lockfile`.
- `subagents.worktree.retentionDays`: auto-prune clean retained worktrees idle longer than this many days at session start (default 7; `0` disables). Dirty worktrees and unmerged branches are never touched.

## MCP servers

Two kinds, defined in `config.json` `mcpServers`:

- **stdio** (default): spawn a local process — `command`, `args`, `env`, `cwd` (Claude Desktop-style).
- **streamable HTTP**: reach a remote/local URL — `url`, `headers`, `insecure`. `headers` values may reference env vars as `${VAR}` (e.g. `"Bearer ${DOC_MCP_TOKEN}"`) so secrets never land in a committed config file; if the var is unset you get a warning at activation. `insecure: true` skips TLS certificate verification (self-signed certs, e.g. on Tailscale IPs).

Secrets per project: put the actual values in a gitignored `.env` file — project `.pi-agents/.env` (and/or global `~/.pi/pi-agents/.env`; project wins, shell env wins over both). Template: `.pi-agents/.env.example`. No keying in per launch — the file is loaded automatically at session start.

Per agent: a server can also be defined **inside the agent** (`mcpServers` in `agent.ts`, same shape) — then only that agent can ever use it, and it overrides project/global servers with the same name. Its key goes in a gitignored `<agent-dir>/.env`, e.g. `.pi-agents/agent-doc/.env`. Resolution order: shell env → agent `.env` → project `.env` → global `.env`.

- **Nothing connects unless an agent opts in** via its `mcp` field. MCP connections are closed when switching agents, so credentials are never reused across agents.
- Server tools register as `<server>__<tool>`, e.g. `playwright__browser_navigate` — no collisions, server always identifiable.
- An agent's active toolset = its `tools` (or current toolset) ∪ its servers' tools.
- Best practice: shared servers globally (`~/.pi/agent/pi-agents/config.json`), project-specific ones in the project config. Agents and servers can live in different places — any agent can use any merged server.

## Add a tool

- Built-ins: list in `tools` — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (typed: `Tools.read`).
- Extension/MCP tools: list their registered names (`server__tool` for MCP). Unknown names are filtered with a warning at apply time.

## After editing .pi-agents/

Agents are discovered at session start — run `/reload` (or start a new session) for changes to take effect; the `/agent` picker always reads fresh definitions.
