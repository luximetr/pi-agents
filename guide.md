# pi-agents guide

This extension defines "agents" in code — each agent is a tool allowlist + system prompt + optional MCP servers. Read this when asked to create agents, add tools, wire up MCP, or explain how the extension works.

## Using the extension (quick start)

- Commands added by this extension are namespaced `/pi-agents:<action>` (`agent`, `subagents`, `models`, `task-history`, `help`); typing `/models` still finds `/pi-agents:models` through fuzzy search.
- Switch agents: `f7` (Agent Studio/dashboard), `f8` (rotate), or `/pi-agents:agent <name>` (`/pi-agents:agent none` clears). In `f7`, type to filter, use `↑↓` to choose an agent, `Tab`/`←→` to inspect it, `F4` to edit it, or `F5` to create one. Open Tasks, Runs, and Inbox with `f9` or `/pi-agents:subagents`; `1`, `2`, and `3` select the views. Function-key shortcuts work through iTerm2 and herdr without terminal setting changes; configured aliases remain available too.
- Start with an agent from the CLI: `pi --agent dev`.
- The active agent's system prompt is appended every turn; its work tools follow its allowlist, custom tools, MCP assignments, and delegation permissions. The `session_plan` bookkeeping tool remains enabled even with `tools: []`.
- No agent selected = plain Pi's work tools and prompt, with session coordination still available.
- `/pi-agents:help <question>` answers a question from this guide (e.g. `/pi-agents:help how do I add an MCP server?`).
- `/pi-agents:models` manages the global **model aliases** used by subagent delegations (e.g. `@fast` → `openai-codex/gpt-6-luna:minimal`), so one edit switches that model everywhere.

## Agent Studio

Open `f7`, select an agent, and press `F4`. Studio can edit the effective system prompt, direct tool allowlist, MCP assignments and HTTP endpoint URLs, and subagents. Tool and MCP selectors show the highlighted item's description and connection details in a right-side pane. In **Manage MCP servers**, open a server's settings and choose **Edit endpoint URL**; **Save agent.ts** persists it as an agent-local definition. In **Manage subagents**, **Set model** picks from your global model aliases or accepts a custom model ID; **Manage model aliases** (also `/pi-agents:models`) maintains that table.

- **Apply as session draft**: activates immediately, persists in session history, follows session-tree navigation, and is inherited by delegated children. The dashboard marks it `◆ draft`.
- **Save agent.ts**: writes edits directly to the agent definition, copies selected MCP definitions into its local `mcpServers`, removes stale unselected local MCP definitions, and removes saved overlays folded into it. Static TypeScript object exports retain imports, comments, custom tools, and unrelated fields; direct Studio saves keep the system prompt in `prompt.md` via `systemPromptFile`. A discovered legacy `agent.json` is migrated to canonical `agent.ts` + `prompt.md` files when saved.
- **Save project override (.pi-agents/config.json)**: for dynamic factory/computed definitions that cannot be patched safely, writes an `agentOverrides` entry to the project config and applies it immediately.
- **Save global override (~/.pi/agent/pi-agents/config.json)**: writes the same dynamic-agent overlay to the global config.
- **Revert session draft**: restores the saved source/global/project composition. The dashboard identifies active saved overlays and their scope.

Press `F5` in the dashboard to create a project or global agent interactively. It captures the current direct toolset as a starting point, then opens Studio. Studio creates the canonical folder layout with configuration in `agent.ts` and the prompt in `prompt.md`; it does not create `agent.json`. TypeScript definitions support imports, factories, and executable custom tools; Studio patches static object exports directly and offers explicit config overlays for dynamic definitions.

The MCP selector always offers recipes shipped with the extension. They are opt-in and disconnected until assigned. A project/global server definition with the same name overrides its bundled recipe:

- `playwright`: pinned `@playwright/mcp@0.0.80`, headless by default.
- `ios-simulator`: pinned `ios-simulator-mcp@2.1.0`; requires Xcode/iOS Simulator.
- `pen.dev`: uses the Apple-silicon MCP server bundled in `/Applications/Pen.app`; keep Pen running.
- `dochub`: Streamable HTTP at `https://dochub.phoenixchumphon.com/mcp`; set `DOCHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `designhub`: Streamable HTTP at `https://designhub.phoenixchumphon.com/mcp` by default; edit the endpoint in Studio if needed and set `DESIGNHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `taskhub`: Streamable HTTP at `https://taskhub.phoenixchumphon.com/mcp` by default; edit the endpoint in Studio if needed and set `TASKHUB_TOKEN` in the shell or `.pi-agents/.env`.

## Where agents live

- Project: `<git-root>/.pi-agents/` (searched upward from cwd)
- Global: `~/.pi/agent/pi-agents/` (same layout; project wins on name collision)

Commit the project's `.pi-agents/` to the repo — it is the per-project configuration and follows every checkout and worktree. In a git worktree, agents come from the worktree's own checkout (exactly the commit it was created from), and the gitignored `.env` secrets fall back to the main checkout's `.pi-agents/.env` / `.pi-agents/<name>/.env`; a `.env` present in the worktree wins per key. Project agents and configs load only in trusted projects (the extension itself is installed globally); a worktree of an already-trusted repo is trusted automatically, since it contains the same committed code.

## Create an agent

Supported layouts:

- Canonical folder: `.pi-agents/<name>/agent.ts` with `prompt.md` for Studio-saved prompts
- Single file: `.pi-agents/<name>.ts` (name defaults to the filename)
- Legacy discovery only: `.pi-agents/<name>/agent.json` (migrated to `agent.ts` + `prompt.md` on Studio save; never created by Studio)

`agent.ts` default-exports a config object:

```ts
export default {
  name: "browser",
  description: "Drives a browser via MCP.",
  whenToUse: "Testing or inspecting a web application.", // optional dashboard metadata
  capabilities: ["Browser navigation", "Screenshots"],  // optional
  limitations: ["Does not modify application code"],    // optional
  promptSummary: "Methodical browser operator.",         // optional
  tools: ["read", "bash"],            // work-tool allowlist; [] keeps session_plan bookkeeping
  subagents: ["developer"],            // optional delegation allowlist; object entries may set model/timeout, e.g. { name: "developer", model: "@fast" }
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

An agent can delegate isolated work to another agent with the built-in `delegate` tool. Add `background: true` to return a run ID immediately and keep the main agent responsive. Completion results are batched after the main flow fully settles, including retries and queued user messages, or wake it when idle; they never steer an active flow. Escape pauses automatic wake-ups without stopping children, and the next user message receives waiting results. Use `subagent_control` with `action: "list" | "status" | "result" | "reply" | "recover" | "steer" | "stop"`, `runId` for a specific run, and `message` for replies or steering. `status` reads a run's live phase (including thread preparation), current tool, model, elapsed/idle milliseconds, and any deadline/remaining time; `list` returns that metadata for all delegation runs. Neither waits nor acknowledges result handling. Terminal statuses remain queryable. Check when needed rather than repeatedly polling; completion delivery is automatic. Reload, session replacement, and exit stop live workers; durable coordination and retained reports survive when the same session is restored, without automatically restarting workers. Parallel workers share the working directory by default, so assign separate files or choose `workspace: "worktree"` on individual delegations. Without `background`, delegation still waits for the final result:


```ts
export default {
  name: "lead",
  description: "Coordinates specialists.",
  subagents: [
    "developer",
    { name: "researcher", model: "@fast", timeoutSeconds: 900 },
    { name: "reviewer", model: "anthropic/claude-sonnet-5" },
  ],
  systemPrompt: "Delegate implementation and research; keep the high-level context short.",
};
```

`subagents` is an allowlist. A string entry inherits the parent's selected model and thinking level and has no deadline. Object entries can fix `model` and `timeoutSeconds`; `model` is either a plain Pi model ID or a `@alias` from the global model-alias table (see **Model aliases**), so one edit switches that model for every delegation using it. Different parents may configure the same child differently. The parent sees a roster of child names, descriptions, models, and deadlines in its prompt.

Every `delegate` starts a fresh thread and returns `threadId` and `runId`. Same-agent tasks can run in parallel. `subagent_control({ action: "reply", runId, message: "Use option A." })` continues the latest completed run's conversation with a new background execution and run ID. Saved messages, tool results, and compaction context survive; the old process does not. Replies preserve the thread's selected model while using current agent definitions and deadlines. Busy threads require `steer`; stale IDs, failed/interrupted runs, and threads owned by another parent cannot receive replies. Missing or invalid saved history fails rather than silently discarding context. Recheck workspace files on follow-up work. Provider prompt-cache reuse is possible but not guaranteed.

Live reply handles remain runtime-only. Run/thread handles, including a nested worker's own child handles, are not restored across process restarts; continuing a saved task requires explicit recovery as described below. There is no implicit context reuse between ordinary delegations.

### Tasks, checklists, and Inbox

The compact panel above the main terminal input shows tasks, completed/total checklist counts and current item activity. Worker execution and incoming reports appear beside their linked items automatically. A reply shows “awaiting review”; the manager verifies the work and updates the checklist. There are no separate Main or Next fields. Extra tasks are summarized, narrow/short terminals adapt, and the panel collapses when all work is settled.

Open `f9` or `/pi-agents:subagents`, then choose:

- **Tasks** (`1`): full checklists (`✓` completed, `◐` in progress, `○` pending, `−` superseded), linked worker activity, dependencies, objectives and amendments. Multiple tasks remain visible, including superseded work and deferred results.
- **Runs** (`2`): the recursive run tree and live conversation inspector, retaining navigation, following, steering, and subtree stop controls described below.
- **Inbox** (`3`): results with separate execution and handling states. `Enter` reads a full report; `r` marks reviewed, `i` incorporated, `d` defers with an optional note, and `n` marks new. Eligible results expose `p` to reply or `c` to recover. Reply/recovery rechecks ownership, latest-run status, busy-thread state, and saved history through the existing control path. Observing a descendant does not grant its parent's reply/recovery permissions. Reading, replying, and closing never mark a result incorporated.

Use the always-enabled `session_plan` tool for state shared by the agent and UI:

- `create` records an accepted objective with a title, objective, optional owner, checklist `items`; `update` changes it or appends an `amendment`. Use one task per independent user objective. A new clarification or status question does not replace unfinished tasks.
- `add_item` and `update_item` maintain checklist text, owner, dependencies, and `pending` / `in_progress` / `completed` / `superseded` status. Pass `taskId` and optional `itemId` to `delegate` to retain the originating obligation.
- `list` returns a compact digest. `inspect` returns coordination metadata without full report text, or a task/input selected by `taskId`/`inputId`. `result` with `runId` returns the full retained report; `subagent_control result` also accesses it. Do not pull every full report into context just to inspect outstanding work.
- `handle_result` explicitly sets `handling` to `new`, `reviewed`, `incorporated`, or `deferred`, with an optional note. Reviewed and deferred reports remain outstanding until incorporated. `reconcile_input` records how a pending user update applies to a task, optionally appending an amendment. Incoming subagent reports/questions are source information, not automatically new user objectives.

Before continuing or giving a final response, reconcile results with current requests, update the checklist, and resume unfinished work. Completing the last checklist item automatically closes an active task once all linked reports are incorporated. Adding or reopening an item reopens a completed task. Explicit blocked/superseded tasks retain that status until updated; tasks without checklists need explicit completion. Task completion rejects unfinished checklist items, linked runs without a report, and results awaiting incorporation. Delivery or reading alone never completes an obligation. Ordinary review, incorporation, or deferral does not require manual approval.

Coordination is separate from worker execution history. Private atomic files under `~/.pi/agent/pi-agents-coordination/` (or Pi's configured agent directory) retain tasks, amendments, pending user inputs, checklists, run links, full reports, and handling states. Scope is the canonical project directory, root session, and parent participant. `/new` has its own scope. Restoring history never launches a worker. Deleting worker execution history does not delete parent coordination records.

Compact context is restored before agent turns and refreshed before model requests, including after compaction within a running loop. That refresh includes only previously delivered result summaries; newly arriving reports still wait for settlement or the next explicit safe boundary, preserving queued-user-message and abort protections. Normal completion delivery uses bounded digests with report references instead of injecting every full report. Stored text remains source data. This durable state and its lifecycle checks support continuity but do not guarantee model attention.

### Persistent task history

Task history is always enabled. Task JSONL and minimal metadata persist across reload/restart under `~/.pi/agent/pi-agents-task-history/` (or Pi's configured agent directory), with POSIX owner-only permissions (`0700` directories, `0600` files). Conversations may contain sensitive prompts/tool output/secrets, retained by default until you manually delete or prune history; there is no automatic retention or cleanup policy. No secret configuration or callbacks are copied into metadata; normal Pi transcripts can still contain secrets.

Resume the same root Pi session in its original canonical working directory. `/pi-agents:task-history list` and `subagent_control` list/status discover saved latest-task records; nothing restarts automatically. Unowned previously running tasks are interrupted, not live handles. Runs-view transcripts remain runtime-only; restored execution cards use durable status and disclose when execution history lacks a result preview. Reports retained separately in coordination remain available in Inbox and through `session_plan result`. Older unknown runs show unavailable.

Use `/pi-agents:task-history recover <runId> <fresh instruction>` or `subagent_control({ action: "recover", runId, message: "Inspect existing work before continuing." })`. Recovery checks current parent/child permission, session/project ownership, latest run, JSONL integrity and original workspace/worktree identity. It restores only the last validated checkpoint, excluding incomplete writes/unresolved tool calls. Later work may already have changed files or external services. Never blindly repeat the original task. Missing/tampered/unavailable state rejects recovery rather than starting fresh.

`/pi-agents:task-history delete <runId>` (select the owning parent first) and `/pi-agents:task-history prune <days>` confirm explicit deletion; `subagent_control` also offers `delete`. No automatic retention timer. Worktrees, workspace files, parent-session messages and backups are never removed. Normal shutdown stops/reaps children and preserves finalized histories. Hard-crash locks deliberately block recovery/deletion: an operator must verify old children/writers have exited before inspecting/removing reported stale locks. There is no automatic lock stealing or guaranteed automatic crash recovery. Checksums are corruption checks, not protection against a malicious same-user writer. Nested tasks retain their own originating working-directory scope; only latest-thread metadata is indexed.

### Per-call workspace choice and manual review

The main agent chooses `delegate({ agent: "developer", task: "…", workspace: "shared" | "worktree" })`, with optional `background: true`. This is not a Studio setting. Omitted `workspace` means `shared`: the parent's cwd and local edits remain visible, so parallel writers can conflict. A fresh conversation alone does not isolate files.

`worktree` gives the task thread a separate Git checkout from the parent's HEAD, **without staged, unstaged, or untracked parent edits**. Commit required inputs first or describe them explicitly in the task. A repository with a HEAD commit is required; creation/reuse errors must not silently fall back to shared execution. Replies keep the thread's workspace/cwd. Worktrees are not security sandboxes: absolute paths, tools, credentials, and external services remain accessible. Unreviewed worktrees are preserved after completion, failure, stop, or runtime cleanup; live reply handles remain runtime-only, while conversation histories persist by default as described above.

Explorer displays `[shared]` or `[worktree]` only when metadata is reported; `[workspace ?]` means unknown. Open the conversation and press `g` for the reported cwd, branch (or detached HEAD), and optional original base commit. Long values wrap and scroll. This is recorded metadata, not live Git status or an assertion that changes were reviewed. Save the path and base before reload/exit clears observation history.

There are no automatic apply/discard actions. Wait until the thread and any other writers stop, then review manually:

```sh
WORKTREE='/absolute/path/to/delegate-worktree'
BASE='<original-base-commit>'
git -C "$WORKTREE" status --short
git -C "$WORKTREE" log --oneline "$BASE"..HEAD
git -C "$WORKTREE" diff --stat "$BASE"
git -C "$WORKTREE" diff "$BASE" --
```

Use the original base, not a parent HEAD that has since moved. The diff includes committed and uncommitted tracked changes; untracked files require separate inspection. Review secrets, generated files, and tests. Preserve parent edits and preferably use a clean review checkout. Manually cherry-pick specific reviewed commits, **or** export an aggregate tracked-change patch (`git -C "$WORKTREE" diff --binary "$BASE" -- > /safe/new/review.patch`, a new file outside both checkouts), inspect it, and run `git -C "$PARENT" apply --check /safe/new/review.patch` before `git -C "$PARENT" apply /safe/new/review.patch`, where `PARENT` is the target checkout's absolute path. Do not apply both commits and their aggregate patch. Transfer only approved untracked files separately, resolve conflicts deliberately, and rerun tests. Keep the worktree until application is verified; stopping a run is not discarding or merging its changes.

Nested delegation remains limited to four levels. Use self-contained tasks with paths, constraints, and the desired result.

The agent cannot choose its deadline at call time. Configure `timeoutSeconds` on the parent's subagent entry, or omit it to run without a deadline. While the parent waits, the delegation card shows the configured model (including a thinking-level suffix) and the footer counts active runs across the hierarchy with an `f9` hint. Open `f9` or `/pi-agents:subagents`, then select **Runs** (`2`) for the full-terminal recursive run tree and live conversation pane, including grandchildren and completed/failed runs. Use `↑↓` or `j k` to select, `←→` to collapse/expand or navigate parent/child, `Enter` for a full-width conversation, and `Tab` to switch focus. Inside a focused conversation, `→` dives into the first child and `←`/`Esc` goes back, preserving each run's scroll position. Narrow terminals show one pane at a time. `Control-U`/`Control-D` scroll by a page, `g` shows the beginning, `Shift-G` resumes live following, `p` expands/collapses the full task prompt, and `e` expands tool arguments/results. The equivalent MacBook `Fn-↑`/`Fn-↓` and `Fn-←`/`Fn-→` keys also work. `s` queues steering for the selected active run; `x` confirms stopping that run and its descendants (not siblings). `f9` closes directly. Viewing/closing does not stop agents or switch sessions. Models, own usage, task, deadline and activity are shown; parents with active children are not incorrectly marked stale. Private local sockets carry display-only snapshots on macOS/Linux, without adding model context or requiring Orca integration. This live observation history clears on reload, session replacement, or exit; durable coordination and saved reports have their own lifecycle described above. Transcripts are bounded to 400 entries/100,000 characters per run, with 16,000-character entry previews and at most 100 completed-run transcripts; omitted history is marked. Images appear as placeholders. Manual interruption and timeout return diagnostic context to the parent so it can change approach. Delegate results are compact by default; expand the tool row to read the complete Markdown output. Results over Pi's 2,000-line/50 KB tool limit are truncated for the parent context and saved in full to a private temporary file linked from the result.

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
- Active toolset includes the allowlist, custom tools, MCP tools, permitted delegation tools, and always-enabled `session_plan` bookkeeping. A custom tool overrides an existing tool with the same name (warning). Same-named tools across agents: last applied wins.
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
  "models": [
    { "id": "m_a1b2c3d4e5f6", "name": "fast", "model": "openai-codex/gpt-6-luna:minimal" },
    { "id": "m_9f8e7d6c5b4a", "name": "strong", "model": "openai-codex/gpt-6.1-sol:high" }
  ],
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

## Model aliases (global only)

Give frequently used subagent models short names, then pick them from a menu instead of retyping model IDs:

```ts
// .pi-agents/lead/agent.ts
subagents: [{ name: "dev-worker", model: "@fast" }]
```

- Store the table in the **global** `~/.pi/agent/pi-agents/config.json` only; project configs never define it. Agent files in any project may reference it. A `models` entry in a project `.pi-agents/config.json` is ignored and reported on startup — move it to the global file.
- These aliases are pi-agents' own and unrelated to Pi's `models.json`, `enabledModels`, or virtual models; they are never registered as Pi models and do not appear in `/model`.
- `name` is what you type and see: letters, numbers, dot, underscore, hyphen (kebab, snake, and camel all work; spaces are rejected). Names are unique, case-insensitively.
- `model` is used exactly as written, so a thinking-level suffix like `:high` is part of the stored value. Write the suffix on the alias target, not on the reference: `@fast` resolves, `@fast:high` does not.
- Edit aliases in Studio (**Manage model aliases**) or with `/pi-agents:models`. Studio stores the stable `id` in agent files (`@id:m_a1b2c3d4e5f6`), so renaming `fast` → `quick` updates every screen without touching any agent file. Hand-typed `@fast` keeps working; the next Studio save swaps it to the id form.
- Deleting an alias that is still referenced is allowed after a confirmation: those delegations show `@name (missing)` and warn, then use the parent's model instead. A delegation never fails because of an alias.
- Bare model IDs (`openai-codex/gpt-6.1-sol:high`) are untouched by aliases and keep working as before. An alias always stores a plain model ID, never another alias.

## MCP servers

Two kinds, defined in `config.json` `mcpServers`:

- **stdio** (default): spawn a local process — `command`, `args`, `env`, `cwd` (Claude Desktop-style).
- **streamable HTTP**: reach a remote/local URL — `url`, `headers`, `insecure`. `headers` values may reference env vars as `${VAR}` (e.g. `"Bearer ${DOC_MCP_TOKEN}"`) so secrets never land in a committed config file; if the var is unset you get a warning at activation. `insecure: true` skips TLS certificate verification (self-signed certs, e.g. on Tailscale IPs).

Secrets per project: put the actual values in a gitignored `.env` file — project `.pi-agents/.env` (and/or global `~/.pi/pi-agents/.env`; project wins, shell env wins over both). Template: `.pi-agents/.env.example`. No keying in per launch — the file is loaded automatically at session start.

Per agent: a server can also be defined **inside the agent** (`mcpServers` in `agent.ts`, same shape) — then only that agent can ever use it, and it overrides project/global servers with the same name. Its key goes in a gitignored `<agent-dir>/.env`, e.g. `.pi-agents/agent-doc/.env`. Resolution order: shell env → agent `.env` → project `.env` → global `.env`.

- **Nothing connects unless an agent opts in** via its `mcp` field. MCP connections are closed when switching agents, so credentials are never reused across agents.
- Server tools register as `<server>__<tool>`, e.g. `playwright__browser_navigate` — no collisions, server always identifiable.
- MCP tools join the agent's work-tool allowlist and custom/delegation tools; `session_plan` remains enabled for bookkeeping.
- Best practice: shared servers globally (`~/.pi/agent/pi-agents/config.json`), project-specific ones in the project config. Agents and servers can live in different places — any agent can use any merged server.

## Add a tool

- Built-ins: list in `tools` — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (typed: `Tools.read`).
- Extension/MCP tools: list their registered names (`server__tool` for MCP). Unknown names are filtered with a warning at apply time.

## After editing .pi-agents/

External source edits are discovered at session start — run `/reload` (or start a new session). Agent Studio applies its own direct source/prompt saves, session drafts, and saved dynamic-agent overlays immediately without reload.
