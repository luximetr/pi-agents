# pi-agents

Opencode-style agents for [pi](https://github.com/earendil-dev/pi): define agents **in code** and switch between them at any time. The active agent is always applied to your session — its tools are restricted and its system prompt is appended every turn. No agent selected = plain pi.

The package also includes an independent message-timing module: every user message is followed by a dim `You · HH:MM:SS` label, every assistant turn is followed by `Assistant · HH:MM:SS`, the footer shows live elapsed time while Pi works, and a compact `took …` summary follows each completed task. These labels and summaries are TUI-only session entries and are never sent to the model. Pi does not expose native user/assistant message renderers (and its Markdown transformer provides a role but no message identity or timestamp), so the supported non-mutating layout places each label immediately after its message rather than inside the built-in bubble. The module lives in `message-timing.ts`, so it can be split into a standalone package later without coupling it to agent behavior.

## Install

### From GitHub (published) — recommended: global install

Install through pi's package manager — nothing is copied and the target project needs no node_modules of its own. **Install globally (the default):** the extension then loads in **every** project — including newly created **git worktrees**, which is exactly why global is the default (see [Worktrees](#worktrees) below):

```bash
pi install git:github.com/luximetr/pi-agents@v0.5.2        # all projects (user scope)
```

Agent definitions stay **per project**: commit `<git-root>/.pi-agents/` to the repo and every checkout — main branch, feature branch, worktree — gets the same agents. Global agents in `~/.pi/agent/pi-agents/` apply everywhere.

To track the latest commit on `main` instead of a pinned release:

```bash
pi install git:github.com/luximetr/pi-agents
```

To update an existing installation, run the same command with the desired ref (for example `@v0.5.2`). This replaces the existing checkout; it does not install a second active copy. For a `main` installation, use `pi update --extensions` or run the unpinned `pi install` command again. After updating, `/reload` in a running pi session (or restart).

Project agents and configs load only in projects pi considers **trusted** (the default unless the project carries trust-requiring resources such as `.pi/` or `.agents/skills` — then pi asks on first interactive start, or run `/trust`). Worktrees of an already-trusted repo are trusted automatically (they contain the same committed code); see [Worktrees](#worktrees). Manage with `pi list` / `pi remove`.

> **Project-local installs are not worktree-safe.** `pi install <repo> -l` records the extension in `<dir>/.pi/settings.json`, a file that git never checks out — freshly created worktrees of that repo have no extension. Prefer the global install; keep `-l` only for non-git or throwaway setups. If you already did a local install, migrate with `pi install git:github.com/luximetr/pi-agents` (global) and then `pi remove <repo> -l` in the project.

### With the `pi-agents` installer CLI

For local-checkout installs, bundled sample agents (`--agents`), and non-interactive setups. **One line per machine** — after linking the CLI once:

```bash
cd <this repo>
npm ci
npm link            # once: makes the `pi-agents` command available on your machine
```

then, in any project on your machine:

```bash
pi-agents install            # global install (default): extension in ALL projects, incl. worktrees
pi-agents install <dir>      # …or explicit project dir; extension still installed globally
pi-agents --local            # …or record the extension for this project only (not worktree-safe)
pi-agents --legacy           # classic symlink layout: <dir>/.pi/extensions/pi-agents/
pi-agents --agents           # also copy the bundled sample agents into <dir>/.pi-agents/
```

The installer delegates to pi's package manager (`pi install <repo>`): the repo path
is recorded in `~/.pi/agent/settings.json` (or `<dir>/.pi/settings.json` with
`--local`) and the extension is loaded from the repo directly — nothing is copied and
the target project needs **no node_modules of its own** (deps resolve from this repo).
It also records the project trust decision (same as accepting pi's "Trust project
folder?" prompt), so the project's `.pi-agents/` agents load immediately. Manage
with `pi-agents status`, `pi-agents remove`, or pi's own `pi list` / `pi remove`. The
pi one-liner works too: `pi install <path-to-this-repo>` (add `-l` for project-local,
`-a` to trust).

`pi-agents` CLI reference:

| Command | Effect |
|---|---|
| `pi-agents install [dir]` | global install (default) — extension for all projects |
| `pi-agents --global` | same as the default, explicit user scope |
| `pi-agents --local` | install for the current project only (`.pi/settings.json`; not worktree-safe) |
| `pi-agents --agents` | also copy the bundled sample agents into `<dir>/.pi-agents/` (imports rewritten to point at the extension) |
| `pi-agents --legacy` | classic layout: symlink into `<dir>/.pi/extensions/pi-agents/` |
| `pi-agents remove [dir]` | uninstall (use the same scope flags you installed with) |
| `pi-agents status [dir]` | show where/how it's installed and the trust state |
| `pi-agents --yes` | pre-approve the trust decision (non-interactive setups) |
| `pi-agents --force` | overwrite existing files (samples, legacy links) |
| `pi-agents --repo <path>` | extension sources (default: this checkout; baked into the compiled binary) |

Installs are idempotent; after installing, `/reload` in a running pi session (or restart).

**Standalone binary** (no npm link / no npm needed on the target machine):

```bash
./scripts/build.sh          # requires bun; bakes the repo path in
./dist/pi-agents install    # same CLI, single executable (drop it in ~/bin)
```

**Manual** (classic symlink layout — what `pi-agents install --legacy` does):

```bash
cd <this repo>
npm ci
mkdir -p .pi/extensions/pi-agents
ln -sf ../../index.ts .pi/extensions/pi-agents/index.ts
ln -sf ../../agents.ts .pi/extensions/pi-agents/agents.ts
ln -sf ../../mcp.ts .pi/extensions/pi-agents/mcp.ts
ln -sf ../../ui.ts .pi/extensions/pi-agents/ui.ts
ln -sf ../../subagents.ts .pi/extensions/pi-agents/subagents.ts
ln -sf ../../background-subagents.ts .pi/extensions/pi-agents/background-subagents.ts
ln -sf ../../task-history.ts .pi/extensions/pi-agents/task-history.ts
ln -sf ../../subagent-workspace.ts .pi/extensions/pi-agents/subagent-workspace.ts
ln -sf ../../subagent-observer.ts .pi/extensions/pi-agents/subagent-observer.ts
ln -sf ../../subagent-transcript.ts .pi/extensions/pi-agents/subagent-transcript.ts
ln -sf ../../subagent-explorer.ts .pi/extensions/pi-agents/subagent-explorer.ts
ln -sf ../../session-coordination.ts .pi/extensions/pi-agents/session-coordination.ts
ln -sf ../../session-plan-tool.ts .pi/extensions/pi-agents/session-plan-tool.ts
ln -sf ../../session-overview.ts .pi/extensions/pi-agents/session-overview.ts
```

Project-local extensions load only in **trusted** projects — pi will ask on first interactive start (or run `/trust`).

**Global** (use in all projects): symlink the repo to `~/.pi/agent/extensions/pi-agents` instead.

Either way: `/reload` in pi (or restart) to pick up the extension.

## Development dependencies and security audits

For local checkouts, use `npm ci` to install the committed lockfile, then run `npm audit`, `npm test`, and `npm run typecheck`.

The lockfile pins patched Pi development dependencies (`undici` 8.10.2 and `brace-expansion` 5.0.12), with matching overrides in `package.json`. Pi's bundled `npm-shrinkwrap.json` can cause `npm install` or `npm audit fix` to restore vulnerable upstream versions despite these overrides. If that happens, restore the committed `package-lock.json` (preserving any intentional local edits), then run `npm ci` and `npm audit` again. The install-time audit summary can still reflect the upstream shrinkwrap; check the separate `npm audit` result after installation.

These fixes cover this checkout's development dependencies, not the Pi host installed on your machine. Managed installations use host-provided Pi packages; keep Pi itself updated separately.

## Worktrees

The extension is installed globally, so it is present in every linked git worktree. What's per project is the **agent configuration**, and it follows the worktree automatically:

- **Agents** — commit `.pi-agents/` to the repo; a worktree created from commit X checks out exactly the agents from X (same as the branch it was created from). Uncommitted edits in the main checkout are not carried over (that's git's normal worktree isolation).
- **Secrets** — `.pi-agents/.env` and `.pi-agents/<name>/.env` are gitignored by design, so they do not exist in a fresh worktree. The extension detects the worktree (`git rev-parse --git-common-dir`) and falls back to reading the **main checkout's** `.env` files; a `.env` you create inside the worktree itself wins over the main checkout's per key.
- **Trust** — pi asks before loading project code in a new folder. Because a worktree contains the same committed code as its main checkout, the extension answers the `project_trust` event itself: if the main checkout is already trusted, the worktree is trusted automatically (remembered, so it won't ask again).

If the main checkout was never trusted, the normal pi trust prompt applies in the worktree too — `/trust` after accepting.

## Usage

| Action | How |
|---|---|
| Open Agent Studio / picker | `f7` (also accepts configured shortcuts) |
| Edit or create an agent | In `f7`: select an agent and press `F4`, or press `F5` to create a canonical `agent.ts` + `prompt.md` agent |
| Rotate to next agent | `f8` (cycles: plain pi → dev → doc → … → plain pi; also accepts configured shortcuts) |
| Open Tasks, Runs, and Inbox | `f9` or `/subagents`; `1` / `2` / `3` selects a view |
| Switch directly | `/agent dev`, `/agent none` |
| Ask about the extension | `/agent:help <question>` (answered from the bundled guide) |
| Dashboard / picker | `/agent` or `f7`; type to filter, use `Tab`/`←→` to inspect overview, tools, MCP, and prompt |
| Start with agent | `pi --agent dev` |
| Active agent indicator | footer status line: `agent:dev · 7 tools · MCP:playwright`, tinted with the agent's color |

The interactive agent's model and reasoning level are selected in pi itself (`/model`, thinking UI). A parent agent can select a fixed model and timeout for each delegated subagent as described below.

## Agent Studio

`f7` is both the agent dashboard and the entry point to Agent Studio:

- Press `F6` on an agent to choose its new position and save the order globally or for this project. Project order takes precedence; unlisted agents follow alphabetically. Rotation uses the same order.
- Press `Ctrl+D` (or `Delete`) on an agent to remove its entire folder, including prompts and `.env`, after confirmation. Standalone agents only have their source file removed. Config overrides are retained. Deleting the active agent restores plain pi; deleting a project override can reveal its global definition. Delegation references are not rewritten.
- Reorder and delete refresh the dashboard and available agents immediately; no reload is needed.

- Select an agent and press `F4` to edit its description, color, prompt, built-in/extension tool allowlist, and MCP assignments. Tool and MCP selectors show details for the highlighted item in a right-side pane.
- Press `F5` to create a project or global agent manually or **Describe with AI**. Review/edit the AI draft, choose its color, and confirm before anything is saved. Manual creation uses the same assisted description and prompt editors. Studio creates the canonical folder layout with configuration in `agent.ts` and the system prompt in `prompt.md`; it does not create `agent.json`.
- New agent names may use letters, numbers, dots, underscores, and hyphens, but cannot start with a dot or equal `node_modules`: discovery excludes those directories. Manual entry and reviewed AI drafts follow the same rule.
- Open **Edit description** or **Edit prompt** to edit normally or press **F2** for AI help with that field’s current text, including unsaved edits. Suggestions appear in the same editor for review and further editing. **F3** restores the pre-AI text; **Enter/Ctrl+S** accepts the field into the Studio draft; **Escape** discards the field edits. Use **Shift+Enter** for newlines. There are no separate top-level AI refinement actions.
- Assistance is a neutral, tool-free Pi model request using the current provider/model, authentication, and reasoning level—not the active agent’s persona. It receives only the editable draft and available tool/MCP names, never agent `.env` values, MCP headers, or conversation history. PM, developer, documentation, designer, and dev-lead patterns guide the assistant internally; there is no template-selection menu. Requests are cancellable and time out after two minutes; normal provider usage charges apply.
- **Color** offers automatic coloring, named palette colors, or a custom `#rrggbb`/theme role. Color and description edits also work as session drafts.
- **Apply as session draft** tests changes immediately without touching the source definition. Drafts are stored in session history, survive resume/tree navigation, are marked `◆ draft` in the dashboard, and are inherited by delegated children.
- **Save agent.ts** writes edited fields directly to the agent definition. Selected MCP server definitions are copied into its local `mcpServers`, and stale unselected local definitions are removed, so the agent's MCP setup is self-contained. Static TypeScript object exports are patched without replacing imports, comments, custom tools, or unrelated fields, while direct Studio saves keep the system prompt in `prompt.md` via `systemPromptFile`. Legacy `agent.json` definitions remain discoverable, but saving one migrates it to the canonical `agent.ts` + `prompt.md` layout instead of creating or updating JSON. Existing saved overlays that affected the agent are folded into the source and removed.
- Dynamic factory/computed definitions cannot be patched safely. Only those agents show explicit **Save project override (.pi-agents/config.json)** and **Save global override (~/.pi/agent/pi-agents/config.json)** actions, which persist editable fields under `agentOverrides`.
- **Revert session draft** returns to the saved source and any saved overlays. The dashboard marks saved overlays and shows their global/project provenance.
- **Set as default agent** saves a project/global startup default immediately, without activating the agent or applying pending edits. Project defaults take precedence over global defaults; resumed sessions keep their own agent selection.
- **`/new` preserves your current agent, model, reasoning level, and unsaved Studio drafts** across session replacement (including plain Pi mode). Model inheritance requires the model and its credentials to remain available; reasoning is clamped to the model's supported levels. This does not change Pi's model defaults for a fresh launch.

Use **Manage subagents** to add existing agents, remove assignments, or set each child's optional model and timeout. Every delegation starts an isolated, replyable task thread. Existing model/timeout settings are prefilled when edited; blank settings restore inheritance of the parent's currently selected model or no deadline. **Done** keeps changes in the Studio draft; Escape discards changes made in the subagent menu. Then apply or save the draft. Create new child agents from the dashboard first.

The MCP editor includes curated recipes for Playwright, iOS Simulator, pen.dev, DocHub, DesignHub, and TaskHub. They remain disconnected until assigned to an agent. Project/global `mcpServers` with the same name override the bundled recipe.

- `playwright`: pinned `@playwright/mcp@0.0.80`, headless by default.
- `ios-simulator`: pinned `ios-simulator-mcp@2.1.0`; requires Xcode/iOS Simulator.
- `pen.dev`: connects to the Apple-silicon MCP server inside `/Applications/Pen.app`; keep Pen running.
Use **Manage MCP servers** in Studio to browse servers on the left and inspect the selected server’s details and settings on the right. Press Enter or Tab to focus its **Enable/Disable server**, **Manage credentials**, **Test connection**, and (for HTTP servers) **Edit endpoint URL** actions; use ↑↓ and Enter to choose an action. Escape returns to the server list, then to Studio. Space toggles enablement directly from the list. For directly editable agents, endpoint edits remain pending in Studio and are persisted as an agent-local definition by **Save agent.ts**. Credential entry and testing return to the same server’s settings, with test results shown inline. **Test connection** uses the edited endpoint, initializes an isolated MCP client, and discovers tools with a 10-second timeout; it does not enable the server, register tools, or change the active agent. Tests report missing credentials, connection failures, or the discovered tool count without exposing tokens.

Use the selected server’s **Manage credentials** action to enter masked tokens for DocHub, DesignHub, TaskHub, or other HTTP servers with `${VAR}` header references. Credentials are saved immediately beside the edited agent’s definition (for example `.pi-agents/doc/.env` or `~/.pi/agent/pi-agents/doc/.env`), not in shared scope-level files, drafts, agent overrides, or session history. Files use owner-only permissions and a local Git ignore rule; tracked `.env` files are refused. Empty input or Escape leaves credentials unchanged. Saving refreshes only the edited agent’s credentials and reconnects its MCP servers immediately if it is active—no `/reload` needed. Other agents keep their own credentials. Session drafts are preserved; authentication failures are reported and can be retried by saving a corrected token. Shell values may override these settings.

- `dochub`: connects to `https://dochub.phoenixchumphon.com/mcp`; set `DOCHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `designhub`: defaults to `https://designhub.phoenixchumphon.com/mcp`; edit the endpoint in Studio if needed and set `DESIGNHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `taskhub`: defaults to `https://taskhub.phoenixchumphon.com/mcp`; edit the endpoint in Studio if needed and set `TASKHUB_TOKEN` in the shell or `.pi-agents/.env`.

Static TypeScript agents normally save directly to `agent.ts` with their prompts kept in `prompt.md`; legacy `agent.json` definitions migrate to that layout when saved. The layered model remains available for dynamic TypeScript definitions: `source definition + saved global/project override + session draft = effective agent`.

## Defining agents

Agents live in `.pi-agents/` — project root (walked up to git root) and global `~/.pi/agent/pi-agents/` (pi's agent config dir). Project agents override global ones with the same name. Commit the project's `.pi-agents/` to the repo: every checkout and worktree then gets the same agents. In a git worktree the extension loads the committed agents from the worktree itself (exactly the ones from the commit the worktree was created from) and falls back to the main checkout for the gitignored `.env` secrets (see [Worktrees](#worktrees)).

### Folder per agent (recommended)

```
.pi-agents/
├── config.json
├── dev/
│   ├── agent.ts      # required: agent definition
│   └── prompt.md     # optional, referenced via systemPromptFile
└── doc/
    └── agent.ts
```

### Single file (quick agents)

```
.pi-agents/doc.ts     # name defaults to filename
```

### Legacy `agent.json`

Existing `.pi-agents/<name>/agent.json` definitions are still discovered for compatibility. Agent Studio does not create them: the next direct save migrates the definition to the canonical `agent.ts` + `prompt.md` layout. TypeScript remains available for imports, factories, and executable custom tools. Studio patches static exported object definitions and keeps directly saved prompts in `prompt.md`; dynamic factories use clearly labeled config overrides.

### agent.ts

```ts
export default {
  name: "doc",                                    // optional for single-file agents
  description: "Documentation agent: read-only, writes docs, READMEs.",
  whenToUse: "Creating or reviewing user-facing documentation.", // optional dashboard metadata
  capabilities: ["API docs", "README maintenance"],              // optional
  limitations: ["Does not change runtime code"],                  // optional
  examples: ["Document the authentication API"],                  // optional
  promptSummary: "Precise technical writer; verifies examples.",  // optional
  color: "#bf5af2",                               // theme role or "#rrggbb"; auto-assigned by name when omitted
  tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],  // tool allowlist
  deniedPaths: ["**/.env", "**/*.fig", "**/*.pen", "**/*.md"], // file-tool denylist
  systemPrompt: `You are the DOC agent. ...`,     // inline prompt…
  // systemPromptFile: "./prompt.md",             // …or from a file (relative to agent)
  // default: true,                               // auto-select on fresh sessions
};
```

Files are TypeScript loaded with [jiti](https://github.com/unjs/jiti) — you can use imports, helpers, or an async factory (`export default async () => ({...})`). Omit `tools` to keep the current toolset; pass `tools: []` to disable all built-in tools (the agent keeps only its MCP tools, if any). `deniedPaths` blocks matching paths for the built-in `read`, `write`, `edit`, `grep`, `find`, and `ls` tools. Patterns without `/` match any basename; other patterns are relative to the session cwd unless absolute. Bash is not restricted by this setting.

The dashboard distinguishes declared tools from the effective active toolset, shows global/project provenance and overrides, reports MCP transport/connection state and discovered tools, and lets you page through the exact agent prompt. `whenToUse`, `capabilities`, `limitations`, `examples`, and `promptSummary` are optional user-facing dashboard metadata; they are not injected into the model prompt.

#### Subagents and hierarchy

An agent can delegate isolated work to another declared agent. Set `subagents` to an allowlist of agent names. Use an object entry when that parent should always spawn a child with a specific model and/or timeout:

```ts
export default {
  name: "lead",
  description: "Plans work and coordinates specialists.",
  tools: ["read", "grep", "find"],
  subagents: [
    "developer", // uses the parent's currently selected Pi model
    { name: "researcher", model: "anthropic/claude-sonnet-5", timeoutSeconds: 900 },
  ],
  systemPrompt: "Stay high-level; delegate implementation and research tasks.",
};
```

This adds `delegate` and `subagent_control` automatically. The parent sees its allowed children's names, descriptions, models, and deadlines. Every `delegate` creates a fresh conversation (`threadId`) and execution (`runId`), including foreground delegations. Independent threads run in parallel even for the same agent. To answer a worker's question or continue its task, call `subagent_control({ action: "reply", runId, message: "Use option A." })`. This starts a **new background run in the same thread**, loading saved messages, tool results, and compaction summaries. Reply to the latest completed run; stale IDs, busy threads, failed/interrupted runs, and another parent's threads are rejected. Use `steer` while running. A new `delegate` never implicitly reuses context.

Children use the configured model or inherit the parent's model and thinking level. Replies retain the thread's selected model; current agent definitions, permissions, and configured deadlines apply again. Prompt-cache hits remain provider-dependent, not guaranteed by persistence. Process memory and open connections are not retained; workers should recheck workspace files before continuing. Delegation remains allowlisted and capped at four nested levels. Set `PI_CODING_AGENT_BIN` if needed.

**Background delegation:** `delegate({ agent: "worker", task: "…", background: true })` returns a run ID immediately instead of waiting. The main agent can continue working or respond to you while multiple children run. Completion/failure results accumulate in a session-owned inbox and are delivered together only after the main agent fully settles (including retries and queued user messages), never as mid-flow steering. When idle, results automatically start a follow-up turn. Escape pauses automatic wake-ups while children continue; your next message includes waiting results. `subagent_control` supports `list`, `status`, `result`, `reply`, `recover`, `steer`, and `stop` actions; use `runId` for a specific run and `message` for replies or steering. `subagent_control({ action: "status", runId: "…" })` returns live phase, current tool, model, elapsed/idle milliseconds, and any deadline/remaining time without waiting or consuming pending results. `list` returns the same metadata for all session-owned background runs. Status includes `threadId` and `latestRunId` and remains available after completion, failure, timeout, or interruption; before observation starts it reports `starting`. Check status when needed rather than repeatedly polling; completion delivery remains automatic. Progress also remains visible in Agent Explorer. Omitting `background` preserves blocking delegation. `/reload`, session replacement, and exit stop live workers; saved coordination and reports remain available when the same session is restored. Restoration never restarts workers automatically. Children share the working directory by default: give parallel workers separate files, or select `workspace: "worktree"` per delegation as described below.

#### Tasks, checklists, and inbox

A compact task panel above the main input shows each task's checklist progress and current activity:

```text
Tasks · 2 active · 1 running · 1 to review              F9 checklist
◐ Fix login · 1/4 done · In progress
  Implement fix · dev-worker · awaiting review
◐ Compare auth options · 0/2 done · In progress
  Research options · researcher · running
```

Progress counts completed checklist items. Worker activity and report arrivals update automatically; reports remain awaiting review until the main agent handles them. The agent maintains the checklist without separate Main or Next fields. The panel adapts to narrow/short terminals, summarizes extra tasks, and collapses when all work and reports are settled.

Press `f9` or run `/subagents` to open three views:

- **Tasks** (`1`) expands all checklists, with `✓` completed, `◐` in progress, `○` pending, and `−` superseded items. It also shows worker activity, dependencies, objectives and amendments. Superseded tasks remain visible.
- **Runs** (`2`) preserves the recursive run tree, live conversations, steering, and subtree stopping described below.
- **Inbox** (`3`) shows results with separate execution and handling states. `Enter` inspects the full report; `r` marks reviewed, `i` incorporated, `d` defers with an optional note, and `n` returns a result to new. Eligible results expose `p` reply or `c` recover. Actions recheck the same ownership, latest-run, saved-history, and busy-thread rules as `subagent_control`; descendant observation alone does not grant reply/recovery rights. Inspecting, replying, or closing the view does not acknowledge incorporation.

The `session_plan` tool shares this durable state with the UI. It stays available for coordination even when an agent restricts its work tools. The agent creates a task for each independent accepted objective, records checklists and amendments, and updates item status as work progresses. Incoming user messages are retained for reconciliation; a clarification or status question does not silently replace unfinished objectives. Delegations accept `taskId` and optional `itemId` to link execution and results to the relevant obligation.

```ts
session_plan({ action: "create", title: "Fix login", objective: "Fix and verify login",
  items: [{ id: "implement", text: "Implement fix" },
          { id: "verify", text: "Verify login", dependsOn: ["implement"] }] }) // returns the task ID
delegate({ agent: "worker", task: "Implement login fix", taskId, itemId: "implement", background: true })
session_plan({ action: "result", runId }) // read without acknowledging
session_plan({ action: "handle_result", runId, handling: "reviewed", note: "Verification remains" })
```

`session_plan list` provides a compact digest; `inspect` returns saved metadata or a particular task/input; full report text requires `result`. `update` appends an amendment or marks a task blocked or superseded; `add_item` and `update_item` maintain the checklist; `reconcile_input` attaches a pending user update to its task. Handling states are `new`, `reviewed`, `incorporated`, and `deferred`. Reviewed and deferred results remain outstanding. Completing the last checklist item automatically closes an active task once all linked reports are incorporated. Adding or reopening an item reopens a completed task. An explicit blocked or superseded task stays that way until updated. Tasks without checklists can be completed explicitly. Completion is rejected while checklist items, linked runs, or result incorporation remain unresolved. Ordinary review and incorporation require no manual approval.

Safe-boundary delivery uses compact result digests and report references. Full reports remain accessible through `session_plan result` or `subagent_control result`. Delivery and reading are independent of explicit handling. Before continuing or producing a final response, the agent is instructed to reconcile results with current requests, update the checklist, and resume unfinished work. These records and checks support continuity; they do not guarantee model attention.

Coordination persists separately from worker execution history under `~/.pi/agent/pi-agents-coordination/` by default, scoped to the canonical project directory, root session, and parent participant. It stores accepted objectives, amendments, pending user inputs, checklists, links, full results, and handling states in private atomic files. Resuming the same session or compacting its transcript restores a compact relevant digest. `/new` starts a separate scope. Stored text can contain private task or report content; deleting worker history does not delete parent coordination records.

#### Per-delegate workspace isolation

The main agent chooses `workspace` on each `delegate` call; there is **no Studio setting**. Conversation isolation does not itself isolate files.

```ts
delegate({ agent: "developer", task: "Implement the fix", workspace: "worktree", background: true })
delegate({ agent: "researcher", task: "Inspect current local edits", workspace: "shared" })
```

- Omitted or `"shared"`: use the parent's working directory, including its local edits. Parallel writers can conflict.
- `"worktree"`: create a separate Git worktree for the task thread from the parent's **HEAD**, excluding staged, unstaged, and untracked parent changes. Commit needed inputs first or include relevant context explicitly in the task. This requires a Git repository with a HEAD commit; setup/reuse failures are errors, never silent fallback to shared execution.
- Replies reuse the thread's workspace/cwd rather than creating a fresh checkout. Stopping or completing a run does not merge its changes. Unreviewed worktrees are preserved, including across runtime cleanup; conversation histories persist as described below, while live reply handles remain runtime-scoped.
- This is checkout isolation, **not a security sandbox**: tools, absolute paths, credentials, and external services are not isolated.

Explorer shows `[shared]` / `[worktree]` when the runner supplies workspace metadata; older or incomplete producers show `[workspace ?]`, not an assumed default. In the conversation pane press `g` to see the reported cwd, branch (or detached HEAD), and optional base commit. Long values wrap in this scrollable section; metadata is observational, not a live Git status or proof of review. Save these details before reload/exit clears Explorer history.

**Manual review/apply only:** wait for the thread and any writers to stop. Record the worktree path and original base commit (do not substitute the parent's current HEAD after it has moved). In a shell, replace these example values:

```sh
WORKTREE='/absolute/path/to/delegate-worktree'
BASE='<original-base-commit>'
PARENT='/absolute/path/to/parent-checkout'
git -C "$WORKTREE" status --short
git -C "$WORKTREE" log --oneline "$BASE"..HEAD
git -C "$WORKTREE" diff --stat "$BASE"
git -C "$WORKTREE" diff "$BASE" --
```

The base diff includes committed plus staged/unstaged **tracked** changes, but not untracked files; inspect those separately with `status` and read their contents. Review tests, generated files, and secrets before transferring anything. Preserve the parent's local edits first; prefer applying to a clean review checkout. For reviewed commits, manually cherry-pick the specific commits in order. For tracked uncommitted changes, export a patch to a new file outside both checkouts (`git -C "$WORKTREE" diff --binary "$BASE" -- > /safe/new/review.patch`), inspect it, then run `git -C "$PARENT" apply --check /safe/new/review.patch` before `git -C "$PARENT" apply /safe/new/review.patch`. Choose commits **or** the aggregate patch, not both. Transfer approved untracked files separately; never copy secrets blindly. Resolve conflicts deliberately and rerun tests. Keep the source worktree until review/application is verified. Explorer has no automatic apply, merge, discard, or removal action.

#### Persistent task history

Task history is always enabled: private Pi JSONL conversations and minimal metadata persist across reload/restart under Pi's agent directory (`~/.pi/agent/pi-agents-task-history/` by default). Storage is scoped to the **same root session ID and original canonical working directory**. Resume that Pi session in that directory; `/new` does not adopt another session's tasks. Reload, session replacement, and normal exit stop children but retain finalized histories. Live thread/run handles remain runtime-scoped; nested workers' own child-thread handles are not reconstructed when their parent worker restarts. Missing or invalid history is rejected on reply rather than silently starting fresh.

- `/task-history list` or `subagent_control({ action: "list" })` discovers saved latest-task metadata without launching anything. Previously running, unowned executions appear interrupted; unresolved ownership is reported, not treated as a live handle.
- `/task-history recover <runId> <new instruction>` or `subagent_control({ action: "recover", runId, message: "Inspect existing effects before continuing." })` explicitly continues the last safe checkpoint. Current parent/child permissions, latest-run ownership, conversation integrity and original workspace/worktree association are checked again. The saved model is retained; credentials/configuration/callbacks are not restored from metadata. A missing or invalid checkpoint never becomes a fresh task.
- Checkpoints are validated snapshots, not every streamed token. Incomplete writes and unresolved tool calls retain the previous safe snapshot. **Later work may already have affected files or external services:** inspect state before continuing. Saved status cards disclose that result previews were not retained separately; older runs without retained metadata show unavailable, not running. Explorer's live transcript remains runtime-only.
- `/task-history delete <runId>` and `/task-history prune <days>` explicitly remove history (confirmation required). Select the owning parent before deleting a task. Pruning targets terminal records older than the cutoff; there is no automatic retention timer. `subagent_control` also exposes `delete`. These operations never remove workspaces/worktrees, parent-session messages or backups.
- Normal shutdown waits for child exit and finalization. **After a hard crash, execution/participant/metadata locks are never stolen automatically.** Recovery/deletion may remain blocked even with a valid checkpoint. An operator must verify all old children/writers have exited and inspect the reported lock before manual cleanup; PID absence alone is insufficient.

Persistence currently requires POSIX owner-only permissions (`0700` directories, `0600` files). JSONL may contain sensitive prompts, tool output and secrets, which are retained by default until you manually delete or prune history. There is no automatic retention or cleanup policy. Metadata is allowlisted, updates/checkpoints are atomic, and checksums detect corruption—not malicious same-user resealing. This is not a security sandbox. Only latest-thread metadata is indexed; nested tasks retain their own originating working-directory scope.

**Concurrency:** one execution per thread. Replies never queue or branch an older run. Use separate delegations for parallel work and explicit replies for continuity. Agent Explorer keeps each execution separately inspectable.

While the parent waits, the delegation card shows the child's selected model and thinking level (including an explicit configured suffix, even after usage reports the bare model). The footer counts active runs across the hierarchy and shows the `f9` hint. Open `f9` (or `/subagents`) and select **Runs** (`2`) for the recursive run tree and live conversation pane. It includes grandchildren at every supported depth, unique run IDs for repeated agent names, optional workspace badges and path/branch/base metadata, configured/actual models, tasks, tool arguments/results, own usage, elapsed/remaining time, and stale warnings. Parents with active children show their delegation status rather than a misleading stale warning. Completed and failed runs stay selectable.

- `↑↓` / `j k`: select runs in the tree. `←→`: collapse/expand or navigate parent/child.
- `Enter`: focus the conversation at full width. `→`: dive into its first child; `←` / `Esc`: back. `Tab`: switch tree/conversation focus. Narrow terminals show one pane at a time.
- `Control-U` / `Control-D`: scroll the conversation by a page; `g`: beginning; `Shift-G`: follow live output again. Scrolling up pauses auto-follow. Each run keeps its scroll position while navigating. The equivalent MacBook `Fn-↑` / `Fn-↓` and `Fn-←` / `Fn-→` keys also work.
- `p`: expand/collapse the full task prompt. `e`: expand/collapse tool arguments and results. `s`: queue steering for the selected active run; its transcript reports RPC acceptance/rejection (acceptance is not immediate delivery).
- `x`: confirm stopping the selected run **and its descendants**, not unrelated siblings. `Esc`: back/close; `f9`: close directly. Viewing or closing the explorer never interrupts a run or switches the main session.

Observation uses a private local socket on macOS/Linux, independent of the child RPC pipes and model context; no Orca-specific integration is required. Explorer observation history is in memory for the current runtime: `/reload`, session replacement, and exit clear it. Each transcript retains up to 400 entries / 100,000 characters, with 16,000-character entry previews; up to 100 completed-run transcripts are retained alongside active runs. Omitted history is marked explicitly. Run metadata remains in the tree. Images appear as placeholders. The observer writes no transcript files; resumable Pi conversations are persisted separately as described above. Observed tool output may contain sensitive content, so treat the viewer like the main chat.

Stopping a run clears acknowledged queued steering/follow-ups before RPC abort, including for descendants. In-flight steering acknowledgements are awaited within the existing stop grace period; failed or unresponsive cancellation escalates to process termination. This cannot undo tool effects or instructions already delivered before the stop.

A manual interruption or deadline returns diagnostic context to the parent so it can choose another approach. Delegate tool output stays compact by default; use Pi's tool-expand key to expand the Markdown preview. Delegation previews are capped at Pi's standard 2,000-line/50 KB tool limit; oversized output is also linked from a private temporary file. The full report is retained in durable coordination for explicit `session_plan result`, `subagent_control result`, or Inbox inspection after reload. Completion notifications and handling acknowledgements stay compact. The agent cannot choose its deadline at call time: configure `timeoutSeconds` on the parent's subagent entry. Omit it to run without a deadline.

**Try it interactively before publishing:** `node scripts/try-session-ui.mjs` opens Pi in a temporary demo project and starts two background workers using this checkout in both parent and children. It uses your normal Pi credentials/model and consumes tokens, without installing the checkout into your settings. Press F9 and use `1` Tasks, `2` Runs, or `3` Inbox; the demo leaves reports new for inspection. Ask the main agent to review/incorporate the reports when ready. The printed launcher resumes the same demo session later. Use `--prepare-only` to inspect generated files without starting Pi, or pass `--model provider/model` to choose a model.

**Live integration test:** `npm run test:e2e:live` uses your existing Pi credentials with `openai-codex/gpt-6.1-sol:medium` as coordinator and `openai-codex/gpt-6-luna` as worker. It consumes provider tokens and runs in a temporary project with this checkout explicitly loaded in both parent and children. It verifies overlapping child execution, user follow-up acceptance, deferred batched results, abort/resume, reply context, and durable coordination: checklist progress, linked results, amendments, reviewed/deferred handling, and restart without relaunching workers. Use `node scripts/e2e-background.mjs --coordination-only` for the coordination scenario. RPC/audit logs remain in the printed temporary directory. Override models with `E2E_MAIN_MODEL` / `E2E_CHILD_MODEL`.

**Controlled stop/queue test:** `node scripts/e2e-stop-queue.mjs` uses real Pi RPC and the worker model (same credential/token warning). It demonstrates queued steering consumption with abort alone, then verifies the runner clears steering before abort without executing or persisting the queued instruction. The unsafe baseline only requests a marker file inside its temporary directory; it reports whether that command actually ran. Use `--fixed-only` to skip the unsafe baseline, or `--baseline-only` to inspect current Pi behavior. Logs remain in the printed artifact directory.

**Provider-free host integration test:** `npm run test:e2e:controlled` launches the real Pi RPC host with this extension in a private temporary home and two controlled worker processes. It verifies tool registration, linked reports, checklist progress, automatic task completion, explicit reviewed/deferred handling, rejection of premature task completion, and same-session restoration without worker relaunch. Only the automatic model wake-up is suppressed; completion delivery is recorded. It does not load credentials or call a model. Logs and saved coordination remain in the printed artifact directory.

**Renderer previews:** `node scripts/preview-session-ui.mjs [output-directory]` captures the actual overview, Tasks, Inbox, full-report, and narrow-terminal renderers with deterministic fixture state. It verifies that inspecting a result preserves checklist progress and leaves the result unhandled. It writes text and HTML previews; set `CHROME_BIN` to a Chrome executable to also capture PNGs. These are labeled fixture previews, not live screenshots.

#### Typed tools

`tools` accepts any registered tool name (built-ins plus extension/MCP tools) and unknown names are filtered with a warning at apply time. For type checking + autocomplete, import the types from the extension's `agents.ts` and use the enum-style accessor:

```ts
import { Tools, type AgentConfig } from "<path-to-pi-agents-repo>/agents"; // absolute path to the extension's agents.ts

const cfg: AgentConfig = {
  name: "doc",
  description: "Documentation agent.",
  tools: [Tools.read, Tools.grep, Tools.find, Tools.ls, Tools.write, Tools.edit, Tools.bash],
  systemPrompt: "You are the DOC agent.",
};
export default cfg;
```

The import path depends on the install mode: with the default settings install the extension lives at the repo path (absolute path, as `pi-agents install --agents` uses when rewriting the bundled samples); with the `--legacy` symlink layout it is `../../.pi/extensions/pi-agents/agents` relative to your agent file.

Plain string literals work too — `"read"` and `Tools.read` are the same value. Any string is allowed at the type level (`ToolName`), so custom tools registered by other extensions type-check as well; the built-ins just get autocomplete in editors.

#### Custom tools (per agent)

No MCP server or separate extension needed for small agent-specific tools — define them right in `agent.ts` under `customTools`, keyed by tool name. Each tool is a description + optional JSON-Schema parameters + an `execute` function. Tools are registered when the agent is applied and active only while it is.

```ts
export default {
  name: "dev",
  description: "Developer agent with git tools.",
  tools: ["read", "bash", "edit", "write"],
  customTools: {
    git_status: {
      description: "Show the git working tree status (optionally short)",
      parameters: {
        type: "object",
        properties: { short: { type: "boolean" } },
      },
      execute: async (args, _ctx, exec) => {
        const r = await exec("git", ["status", ...(args.short ? ["--short"] : [])]);
        return r.stdout.trim() || r.stderr.trim(); // plain string = text result
      },
    },
    git_log: {
      description: "Show the last N commits",
      parameters: {
        type: "object",
        properties: { n: { type: "integer" } },
      },
      execute: async (args, _ctx, exec) => {
        const r = await exec("git", ["log", `-${args.n ?? 10}`]);
        return { content: [{ type: "text", text: r.stdout.trim() }], details: { code: r.code } };
      },
    },
  },
  systemPrompt: "You are the DEV agent. Use git_status and git_log for repository state.",
};
```

- `execute(args, ctx, exec)` — `ctx` is the extension context; `exec(command, args)` runs a shell command in the session cwd and returns `{ stdout, stderr, code }`. Return a result object `{ content: [...] }` or a plain string (wrapped as text content).
- `parameters` is JSON Schema (converted to TypeBox); omit for no-argument tools.
- Optional: `label` (UI), `promptGuidelines` (system prompt bullets), `executionMode` (`"sequential"` / `"parallel"`).
- Active toolset = allowlist ∪ custom tools ∪ MCP tools. Custom tools are inactive while another agent or plain pi is active.
- Name collisions: a custom tool overrides an existing registered tool with the same name (warning); same-named tools across agents — the last applied agent wins until the other is re-applied.
- The picker shows them as `custom:git_status,git_log`.

### config.json

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
    }
  }
}
```

`defaultAgent` is optional. If it is unset, the last agent selection is remembered for the next `/new` session; otherwise the first agent marked `default: true` (or, when none is marked, the first discovered agent) is selected. Use `/agent none` to clear the current agent and restore plain pi for that session. Subagent deadlines are configured only on the parent's individual `subagents` entries; omitting `timeoutSeconds` means no deadline. `staleWarningMinutes` only changes the inspector warning, and `gracefulStopSeconds` controls stop escalation. Keybinding overrides apply from the project config. Each action takes a single key **or an array of keys** — add a fallback that your terminal definitely sends (e.g. `alt` keys on terminals that can't report `Ctrl+Shift`, see troubleshooting):

```json
{
  "keybindings": {
    "select": ["ctrl+shift+a", "alt+a"],
    "rotate": ["ctrl+shift+q", "alt+q"],
    "inspect": "f9"
  }
}
```

### MCP servers (per-agent, opt-in)

`mcpServers` in `config.json` defines [MCP](https://modelcontextprotocol.io) servers. Two kinds are supported:

- **stdio** — spawn a local process: `command`, `args`, `env`, `cwd` (Claude Desktop-style).
- **streamable HTTP** — connect to a URL: `url`, `headers`, `insecure`.

Header values can reference env vars as `${VAR}` so secrets never sit in a committed config: `"Authorization": "Bearer ${DOC_MCP_TOKEN}"` resolves at connect time (with a warning if unset). `insecure: true` skips TLS verification for self-signed certs (common on Tailscale IPs).

For per-project secrets without shell setup: put the values in a gitignored `.pi-agents/.env` (e.g. `DOC_MCP_TOKEN=...`; template in `.pi-agents/.env.example`). It's loaded automatically — project `.env` wins over the global `~/.pi/pi-agents/.env`, and your real shell environment wins over both. Nothing to key in per launch. Inside a git worktree, `.pi-agents/.env` is not checked out; the extension falls back to the main checkout's copy (a `.env` you create in the worktree itself still wins per key).

Servers can also be **per agent**: define `mcpServers` inside `agent.ts` (same shape) and only that agent can use them — other agents get a "server not defined" warning. The key then lives in a gitignored `.pi-agents/<name>/.env` (agent dir). Resolution order: shell env → agent `.env` → project `.env` → global `.env`. Example:

**Nothing is connected unless an agent opts in** — add the server names to the agent's `mcp` field and only those servers are started and only their tools are activated:

```ts
export default {
  name: "browser",
  description: "Playwright MCP agent: drives a browser via MCP tools.",
  tools: ["read", "bash"],
  mcp: ["playwright"],                 // connect ONLY this server
  mcpServers: {                        // optional: agent-local server
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] }
  },
  systemPrompt: "You drive a browser through the playwright__* tools.",
};
```

#### Global vs project servers

Both `config.json` files are merged per server name — **project wins on collision**:

| Where | File | Scope |
|---|---|---|
| Global | `~/.pi/agent/pi-agents/config.json` | all projects |
| Project | `<git-root>/.pi-agents/config.json` | this project |

```jsonc
// ~/.pi/agent/pi-agents/config.json — shared servers, once per machine
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}

// <project>/.pi-agents/config.json — project-specific or overrides (wins)
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--headed"] },
    "local-db": { "command": "node", "args": ["mcp/db-server.mjs"] }
  }
}
```

Recommended layout for a reusable setup: define your shared servers **globally**, define the agents that use them **globally** too (`~/.pi/agent/pi-agents/browser/agent.ts` with `mcp: ["playwright"]`), and only put project-specific servers in the project's `config.json`. Agents and servers don't need to live in the same place — any agent can reference any merged server.

MCP tools are registered as `<server>__<tool>`, e.g. `playwright__browser_navigate`. Names containing punctuation (such as a `pen.dev` server) or exceeding 64 characters are sanitized/shortened and given a stable hash suffix for provider compatibility. Existing safe names stay unchanged; original server/tool names are preserved in labels and MCP calls. Name collisions are reported rather than routing to an unrelated tool. Tool schemas come from the server (JSON Schema → TypeBox) and tool calls are forwarded with `client.callTool`. The tool allowlist and MCP tools are combined: `active = agent.tools (or current) ∪ agent.mcp tools`.

Details:
- Switching agents deactivates MCP tools and closes their connections, so agent-specific credentials cannot be reused by another agent. Servers are also shut down on session end (`session_shutdown`).
- Unknown server names and failed starts are reported as notifications; the rest of the agent still applies.
- Text/image results are passed through to the LLM; `structuredContent` is appended as JSON; errors surface as tool failures.
- The picker shows `mcp:playwright` in the agent description line.

## On-demand guide (`/agent:help`)

The extension bundles `guide.md` (next to `index.ts`) covering how to use the extension: switching agents, creating agents, adding tools, and configuring MCP servers.

`/agent:help <question>` is the only entry point — it injects the guide into the next turn's system prompt (one-shot, no per-turn token cost) and submits your question:

```
/agent:help how do I add an MCP server?
```

Works in plain pi or under any agent. The guide is not exposed as a tool and is never auto-added to any agent's toolset — it costs nothing unless you call the command.

## Troubleshooting: shortcuts don't fire

The built-in shortcuts are `f7` (picker), `f8` (rotate), and `f9` (subagent inspector). Function keys are plain escape sequences, so they work through iTerm2 and herdr without changing terminal settings. Configured shortcuts are retained as additional aliases.

- **`ctrl+q`** is commonly consumed by terminal flow control, and **`ctrl+a`** is commonly reserved by the line editor. They cannot reliably be used as extension shortcuts.
- Existing `ctrl+shift` and `alt` aliases may still require terminal-specific reporting. They remain supported when configured, but `f7`/`f8` do not require those settings.
- If you prefer custom aliases, configure them; the built-in `f7`/`f8`/`f9` aliases are still registered automatically:

  ```json
  { "keybindings": { "select": ["ctrl+shift+a", "alt+a"], "rotate": ["ctrl+shift+q", "alt+q"] } }
  ```

  On macOS, `alt+letter` requires the terminal to send `Option` as `Esc`: iTerm2 → Profile → Keys → **Left Option Key Sends: Esc+** (Terminal.app: *Use Option as Meta key*). This setting is independent of the key-reporting checkbox, so it won't affect herdr/tmux.
- **Works regardless of terminal:** `/agent` (picker), `/agent dev` (direct), and `pi --agent dev` (startup). Commands don't depend on key encoding.

## How it works

- `session_start`: agents are discovered and loaded; the selection is restored (priority: `--agent` flag → current session selection → selection from the session replaced by `/new` or `/clone` → `config.defaultAgent` → `default: true` agent → first agent). Project agents/config load only in **trusted** projects (`ctx.isProjectTrusted()`); the extension itself is global, so in untrusted projects only global agents are available
- `project_trust`: when pi asks about a linked worktree whose main checkout is already trusted, the extension answers `trusted: yes` (remembered) — worktrees contain the same committed code as the trusted main checkout
- Worktrees: agents come from the worktree's committed `.pi-agents/`; gitignored `.env` secrets fall back to the main checkout (detected via `git rev-parse --git-common-dir`), per key, worktree `.env` wins
- Applying an agent: `pi.setActiveTools(...)` restricts tools; `before_agent_start` appends the agent's system prompt to every turn
- MCP: servers from merged `config.json` are connected on demand when an agent with `mcp: [...]` is applied; their tools are registered as `<server>__<tool>` and activated together with the tool allowlist
- Selection is persisted via `pi.appendEntry`; it survives restarts and is inherited by `/new` and `/clone` sessions
- Switching to `(none)` restores the toolset from before the first agent was applied

## Limitations / roadmap

- Agent Studio saves descriptions, colors, prompts, tool allowlists, MCP assignments, and subagent delegation settings to canonical `agent.ts` + `prompt.md` definitions. Legacy `agent.json` definitions are discovered and migrated on save. Dynamic/computed TypeScript definitions use explicit saved overlays. Other metadata, policies, and executable custom-tool code remain untouched.
- MCP supports stdio and streamable HTTP transports (no SSE); custom server definitions are still configured statically, while the bundled Playwright, iOS Simulator, pen.dev, DocHub, DesignHub, and TaskHub recipes can be assigned in Studio.
- External edits to `.pi-agents/` need `/reload` (or a new session); Studio drafts and saves are applied immediately.
- Project-local installs (`pi install <repo> -l` / `pi-agents --local`) are recorded in `.pi/settings.json`, which git never checks out — freshly created worktrees of such a project have no extension. Use the default global install instead (the `.pi-agents/` configs remain per project)
