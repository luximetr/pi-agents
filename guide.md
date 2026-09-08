# pi-agents guide

This extension defines "agents" in code — each agent is a tool allowlist + system prompt + optional MCP servers. Read this when asked to create agents, add tools, wire up MCP, or explain how the extension works.

## Using the extension (quick start)

- Switch agents: `f7` (Agent Studio/dashboard), `f8` (rotate), or `/agent <name>` (`/agent none` clears). In `f7`, type to filter, use `↑↓` to choose an agent, `Tab`/`←→` to inspect it, `e` to edit it, or `n` to create one. Explore delegated runs and their descendants, including completed runs, with `f9` or `/subagents`. Function-key shortcuts work through iTerm2 and herdr without terminal setting changes; configured aliases remain available too.
- Start with an agent from the CLI: `pi --agent dev`.
- The active agent's system prompt is appended every turn; its tools are restricted to its allowlist (+ its MCP tools).
- No agent selected = plain pi, unchanged.
- `/agent:help <question>` answers a question from this guide (e.g. `/agent:help how do I add an MCP server?`).

## Agent Studio

Open `f7`, select an agent, and press `e`. Studio can edit the effective system prompt, direct tool allowlist, MCP assignments, and subagents. Tool and MCP selectors show the highlighted item's description and connection details in a right-side pane.

- **Apply as session draft**: activates immediately, persists in session history, follows session-tree navigation, and is inherited by delegated children. The dashboard marks it `◆ draft`.
- **Save agent.ts** / **Save agent.json**: writes edits directly to the current agent source and removes saved overlays folded into it. Static TypeScript object exports retain imports, comments, custom tools, and unrelated fields; referenced prompt files are updated directly.
- **Save project override (.pi-agents/config.json)**: for dynamic factory/computed definitions that cannot be patched safely, writes an `agentOverrides` entry to the project config and applies it immediately.
- **Save global override (~/.pi/agent/pi-agents/config.json)**: writes the same dynamic-agent overlay to the global config.
- **Revert session draft**: restores the saved source/global/project composition. The dashboard identifies active saved overlays and their scope.

Press `n` in the dashboard to create a project or global JSON-backed agent interactively. It captures the current direct toolset as a starting point, then opens Studio. Studio saves later edits directly to `agent.json`. TypeScript definitions support imports, factories, and executable custom tools; Studio patches static object exports directly and offers explicit config overlays for dynamic definitions.

The MCP selector always offers recipes shipped with the extension. They are opt-in and disconnected until assigned. A project/global server definition with the same name overrides its bundled recipe:

- `playwright`: pinned `@playwright/mcp@0.0.80`.
- `ios-simulator`: pinned `ios-simulator-mcp@2.1.0`; requires Xcode/iOS Simulator.
- `pen.dev`: uses the Apple-silicon MCP server bundled in `/Applications/Pen.app`; keep Pen running.
- `dochub`: local Streamable HTTP at `http://localhost:3001/mcp`; set `DOCHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `designhub`: local Streamable HTTP through the editor proxy at `http://localhost:5101/mcp`; set `DESIGNHUB_TOKEN` in the shell or `.pi-agents/.env`.

## Where agents live

- Project: `<git-root>/.pi-agents/` (searched upward from cwd)
- Global: `~/.pi/agent/pi-agents/` (same layout; project wins on name collision)

Commit the project's `.pi-agents/` to the repo — it is the per-project configuration and follows every checkout and worktree. In a git worktree, agents come from the worktree's own checkout (exactly the commit it was created from), and the gitignored `.env` secrets fall back to the main checkout's `.pi-agents/.env` / `.pi-agents/<name>/.env`; a `.env` present in the worktree wins per key. Project agents and configs load only in trusted projects (the extension itself is installed globally); a worktree of an already-trusted repo is trusted automatically, since it contains the same committed code.

## Create an agent

Supported layouts:

- Folder: `.pi-agents/<name>/agent.ts` (optionally with a `prompt.md`)
- Studio/declarative: `.pi-agents/<name>/agent.json`
- Single file: `.pi-agents/<name>.ts` (name defaults to the filename)

`agent.ts` default-exports a config object:

```ts
export default {
  name: "browser",
  description: "Drives a browser via MCP.",
  whenToUse: "Testing or inspecting a web application.", // optional dashboard metadata
  capabilities: ["Browser navigation", "Screenshots"],  // optional
  limitations: ["Does not modify application code"],    // optional
  promptSummary: "Methodical browser operator.",         // optional
  tools: ["read", "bash"],            // allowlist; omit = keep current, [] = no tools
  lifecycle: "resumable",              // delegated context; omit/default = "disposable"
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

`subagents` is an allowlist. A string entry uses Pi's normal default model selection and has no deadline. An object entry can fix the model and/or `timeoutSeconds` for that parent-to-child delegation; different parents may configure the same child differently. The parent automatically sees a roster of allowed child names, descriptions, models, and deadlines in its prompt.

The target agent's `lifecycle` controls context. Omitted or `"disposable"` preserves the fresh ephemeral `pi --mode rpc --no-session` behavior. A `"resumable"` agent instead owns a private disk-backed Pi session keyed by the root main-session identity and effective agent identity. It resumes across later delegations, `/reload`, nested delegation, and process restart; a new main session gets a separate participant. Top-level requests for one participant are serialized (different agents can still run in parallel). Nested delegation to an already-busy resumable participant fails visibly rather than queues; this conservative rule prevents both direct recursion and concurrent A→B/B→A cycles from deadlocking. A relationship's `timeoutSeconds` covers queue wait plus execution. Persistence errors, malformed or structurally broken session JSONL, and stale locks fail visibly and never fall back to a fresh session. Stale locks are not recovered automatically because the owning parent's child may still be alive; verify no child is running before manually removing the lock path reported by the error. Only each invocation's final answer is returned to its caller.

Nested delegation remains limited to four levels. Use self-contained tasks with paths, constraints, and the desired result.

The agent cannot choose its deadline at call time. Configure `timeoutSeconds` on the parent's subagent entry, or omit it to run without a deadline. While the parent waits, the delegation card shows the configured model (including a thinking-level suffix) and the footer counts active runs across the hierarchy with an `f9` hint. `f9` or `/subagents` opens Agent Explorer: a full-terminal recursive run tree and live conversation pane, including grandchildren and completed/failed runs. Use `↑↓` or `j k` to select, `←→` to collapse/expand or navigate parent/child, `Enter` for a full-width conversation, and `Tab` to switch focus. Inside a focused conversation, `→` dives into the first child and `←`/`Esc` goes back, preserving each run's scroll position. Narrow terminals show one pane at a time. `Control-U`/`Control-D` scroll by a page, `g` shows the beginning, `Shift-G` resumes live following, `p` expands/collapses the full task prompt, and `e` expands tool arguments/results. The equivalent MacBook `Fn-↑`/`Fn-↓` and `Fn-←`/`Fn-→` keys also work. `s` queues steering for the selected active run; `x` confirms stopping that run and its descendants (not siblings). `f9` closes directly. Viewing/closing does not stop agents or switch sessions. Models, own usage, task, deadline and activity are shown; parents with active children are not incorrectly marked stale. Private local sockets carry display-only snapshots on macOS/Linux, without adding model context or requiring Orca integration. History is memory-only and clears on reload, session replacement, or exit. Transcripts are bounded to 400 entries/100,000 characters per run, with 16,000-character entry previews and at most 100 completed-run transcripts; omitted history is marked. Images appear as placeholders. Manual interruption and timeout return diagnostic context to the parent so it can change approach. Delegate results are compact by default; expand the tool row to read the complete Markdown output. Results over Pi's 2,000-line/50 KB tool limit are truncated for the parent context and saved in full to a private temporary file linked from the result.

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
    "gracefulStopSeconds": 5
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

External source edits are discovered at session start — run `/reload` (or start a new session). Agent Studio applies its own direct source/prompt saves, session drafts, and saved dynamic-agent overlays immediately without reload.
