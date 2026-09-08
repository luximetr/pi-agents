# pi-agents

Opencode-style agents for [pi](https://github.com/earendil-dev/pi): define agents **in code** and switch between them at any time. The active agent is always applied to your session — its tools are restricted and its system prompt is appended every turn. No agent selected = plain pi.

## Install

### From GitHub (published) — recommended: global install

Install through pi's package manager — nothing is copied and the target project needs no node_modules of its own. **Install globally (the default):** the extension then loads in **every** project — including newly created **git worktrees**, which is exactly why global is the default (see [Worktrees](#worktrees) below):

```bash
pi install git:github.com/luximetr/pi-agents@v0.3.1        # all projects (user scope)
```

Agent definitions stay **per project**: commit `<git-root>/.pi-agents/` to the repo and every checkout — main branch, feature branch, worktree — gets the same agents. Global agents in `~/.pi/agent/pi-agents/` apply everywhere.

To track the latest commit on `main` instead of a pinned release:

```bash
pi install git:github.com/luximetr/pi-agents
```

To update an existing installation, run the same command with the desired ref (for example `@v0.3.1`). This replaces the existing checkout; it does not install a second active copy. For a `main` installation, use `pi update --extensions` or run the unpinned `pi install` command again. After updating, `/reload` in a running pi session (or restart).

Project agents and configs load only in projects pi considers **trusted** (the default unless the project carries trust-requiring resources such as `.pi/` or `.agents/skills` — then pi asks on first interactive start, or run `/trust`). Worktrees of an already-trusted repo are trusted automatically (they contain the same committed code); see [Worktrees](#worktrees). Manage with `pi list` / `pi remove`.

> **Project-local installs are not worktree-safe.** `pi install <repo> -l` records the extension in `<dir>/.pi/settings.json`, a file that git never checks out — freshly created worktrees of that repo have no extension. Prefer the global install; keep `-l` only for non-git or throwaway setups. If you already did a local install, migrate with `pi install git:github.com/luximetr/pi-agents` (global) and then `pi remove <repo> -l` in the project.

### With the `pi-agents` installer CLI

For local-checkout installs, bundled sample agents (`--agents`), and non-interactive setups. **One line per machine** — after linking the CLI once:

```bash
cd <this repo>
npm install
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
npm install
mkdir -p .pi/extensions/pi-agents
ln -sf ../../index.ts .pi/extensions/pi-agents/index.ts
ln -sf ../../agents.ts .pi/extensions/pi-agents/agents.ts
ln -sf ../../mcp.ts .pi/extensions/pi-agents/mcp.ts
ln -sf ../../ui.ts .pi/extensions/pi-agents/ui.ts
ln -sf ../../subagents.ts .pi/extensions/pi-agents/subagents.ts
ln -sf ../../subagent-observer.ts .pi/extensions/pi-agents/subagent-observer.ts
ln -sf ../../subagent-transcript.ts .pi/extensions/pi-agents/subagent-transcript.ts
ln -sf ../../subagent-explorer.ts .pi/extensions/pi-agents/subagent-explorer.ts
```

Project-local extensions load only in **trusted** projects — pi will ask on first interactive start (or run `/trust`).

**Global** (use in all projects): symlink the repo to `~/.pi/agent/extensions/pi-agents` instead.

Either way: `/reload` in pi (or restart) to pick up the extension.

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
| Edit or create an agent | In `f7`: select an agent and press `e`, or press `n` for a new JSON-backed agent |
| Rotate to next agent | `f8` (cycles: plain pi → dev → doc → … → plain pi; also accepts configured shortcuts) |
| Explore subagents and descendants (live + completed) | `f9` or `/subagents` |
| Switch directly | `/agent dev`, `/agent none` |
| Ask about the extension | `/agent:help <question>` (answered from the bundled guide) |
| Dashboard / picker | `/agent` or `f7`; type to filter, use `Tab`/`←→` to inspect overview, tools, MCP, and prompt |
| Start with agent | `pi --agent dev` |
| Active agent indicator | footer status line: `agent:dev · 7 tools · MCP:playwright`, tinted with the agent's color |

The interactive agent's model and reasoning level are selected in pi itself (`/model`, thinking UI). A parent agent can select a fixed model and timeout for each delegated subagent as described below.

## Agent Studio

`f7` is both the agent dashboard and the entry point to Agent Studio:

- Press `r` on an agent to choose its new position and save the order globally or for this project. Project order takes precedence; unlisted agents follow alphabetically. Rotation uses the same order.
- Press `Ctrl+D` (or `Delete`) on an agent to remove its entire folder, including prompts and `.env`, after confirmation. Standalone agents only have their source file removed. Config overrides are retained. Deleting the active agent restores plain pi; deleting a project override can reveal its global definition. Delegation references are not rewritten.
- Reorder and delete refresh the dashboard and available agents immediately; no reload is needed.

- Select an agent and press `e` to edit its description, color, prompt, built-in/extension tool allowlist, and MCP assignments. Tool and MCP selectors show details for the highlighted item in a right-side pane.
- Press `n` to create a project or global agent manually or **Describe with AI**. Review/edit the AI draft as JSON, choose its color, and confirm before anything is saved. Manual creation uses the same assisted description and prompt editors. Studio-created agents use a declarative `agent.json`; no TypeScript is generated.
- Open **Edit description** or **Edit prompt** to edit normally or press **F2** for AI help with that field’s current text, including unsaved edits. Suggestions appear in the same editor for review and further editing. **F3** restores the pre-AI text; **Enter/Ctrl+S** accepts the field into the Studio draft; **Escape** discards the field edits. Use **Shift+Enter** for newlines. There are no separate top-level AI refinement actions.
- Assistance is a neutral, tool-free Pi model request using the current provider/model, authentication, and reasoning level—not the active agent’s persona. It receives only the editable draft and available tool/MCP names, never agent `.env` values, MCP headers, or conversation history. PM, developer, documentation, designer, and dev-lead patterns guide the assistant internally; there is no template-selection menu. Requests are cancellable and time out after two minutes; normal provider usage charges apply.
- **Color** offers automatic coloring, named palette colors, or a custom `#rrggbb`/theme role. Color and description edits also work as session drafts.
- **Apply as session draft** tests changes immediately without touching the source definition. Drafts are stored in session history, survive resume/tree navigation, are marked `◆ draft` in the dashboard, and are inherited by delegated children.
- **Save agent.ts** or **Save agent.json** writes edited fields directly to the definition currently backing the agent. Static TypeScript object exports are patched without replacing imports, comments, custom tools, or unrelated fields. A referenced `systemPromptFile` is updated directly. Existing saved overlays that affected the agent are folded into the source and removed.
- Dynamic factory/computed definitions cannot be patched safely. Only those agents show explicit **Save project override (.pi-agents/config.json)** and **Save global override (~/.pi/agent/pi-agents/config.json)** actions, which persist editable fields under `agentOverrides`.
- **Revert session draft** returns to the saved source and any saved overlays. The dashboard marks saved overlays and shows their global/project provenance.
- **Set as default agent** saves a project/global startup default immediately, without activating the agent or applying pending edits. Project defaults take precedence over global defaults; resumed sessions keep their own agent selection.
- **`/new` preserves your current agent, model, reasoning level, and unsaved Studio drafts** across session replacement (including plain Pi mode). Model inheritance requires the model and its credentials to remain available; reasoning is clamped to the model's supported levels. This does not change Pi's model defaults for a fresh launch.

Use **Manage subagents** to add existing agents, remove assignments, or set each child's optional model and timeout in seconds. Blank settings restore the default model or no deadline. **Done** keeps changes in the Studio draft; Escape discards changes made in the subagent menu. Then apply or save the draft. Create new child agents from the dashboard first.

The MCP editor includes curated recipes for Playwright, iOS Simulator, pen.dev, local DocHub, and local DesignHub. They remain disconnected until assigned to an agent. Project/global `mcpServers` with the same name override the bundled recipe.

- `playwright`: pinned `@playwright/mcp@0.0.80`.
- `ios-simulator`: pinned `ios-simulator-mcp@2.1.0`; requires Xcode/iOS Simulator.
- `pen.dev`: connects to the Apple-silicon MCP server inside `/Applications/Pen.app`; keep Pen running.
Use **Manage MCP servers** in Studio to browse servers on the left and inspect the selected server’s details and settings on the right. Press Enter or Tab to focus its **Enable/Disable server**, **Manage credentials**, and **Test connection** actions; use ↑↓ and Enter to choose an action. Escape returns to the server list, then to Studio. Space toggles enablement directly from the list. Credential entry and testing return to the same server’s settings, with test results shown inline. **Test connection** initializes an isolated MCP client and discovers tools with a 10-second timeout; it does not enable the server, register tools, or change the active agent. Tests report missing credentials, connection failures, or the discovered tool count without exposing tokens.

Use the selected server’s **Manage credentials** action to enter masked tokens for DocHub, DesignHub, or other HTTP servers with `${VAR}` header references. Credentials are saved immediately beside the edited agent’s definition (for example `.pi-agents/doc/.env` or `~/.pi/agent/pi-agents/doc/.env`), not in shared scope-level files, drafts, agent overrides, or session history. Files use owner-only permissions and a local Git ignore rule; tracked `.env` files are refused. Empty input or Escape leaves credentials unchanged. Saving refreshes only the edited agent’s credentials and reconnects its MCP servers immediately if it is active—no `/reload` needed. Other agents keep their own credentials. Session drafts are preserved; authentication failures are reported and can be retried by saving a corrected token. Shell values may override these settings.

- `dochub`: connects to `http://localhost:3001/mcp`; set `DOCHUB_TOKEN` in the shell or `.pi-agents/.env`.
- `designhub`: connects through the editor proxy at `http://localhost:5101/mcp`; set `DESIGNHUB_TOKEN` in the shell or `.pi-agents/.env`.

Static TypeScript and declarative agents normally save directly to their source. The layered model remains available for dynamic definitions: `source definition + saved global/project override + session draft = effective agent`.

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

### Declarative agent (created by Studio)

```
.pi-agents/browser/agent.json
```

`agent.json` supports the normal serializable agent fields such as `name`, `description`, `tools`, `mcp`, and `systemPrompt`. Agent Studio saves edits directly to this file. Use `agent.ts` when imports, factories, or executable custom tools are needed. Studio patches static exported object definitions and their referenced prompt files directly; dynamic factories use clearly labeled config overrides.

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
  lifecycle: "resumable",                         // optional delegated context; default "disposable"
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
    "developer", // uses Pi's default model selection
    { name: "researcher", model: "anthropic/claude-sonnet-5", timeoutSeconds: 900 },
  ],
  systemPrompt: "Stay high-level; delegate implementation and research tasks.",
};
```

This adds the `delegate` tool automatically. The active parent's system prompt also receives a concise roster of its allowed children (name, description, model, and deadline), so it can route work without guessing agent names. By default (or with `lifecycle: "disposable"`) every delegation runs as a fresh, ephemeral `pi --mode rpc --no-session --agent <name>` session and returns only its final answer. Set `lifecycle: "resumable"` on the child agent definition to give that effective agent one private, disk-backed Pi session per root main-session ID. Its later delegations—including nested ones—resume that context across `/reload` and process restarts; a different main session gets a different participant. Top-level calls to the same resumable participant are serialized, while calls to different participants remain parallel. Nested delegation to any already-busy resumable participant is rejected visibly rather than queued; this conservative policy also prevents concurrent cross-participant cycles from deadlocking. A configured deadline includes time spent waiting in the queue. Session/lock storage errors and invalid persisted JSONL fail the delegation and never fall back to a fresh context. Stale locks are not removed automatically because the lock owner's child may still be alive; after verifying no child is running, an operator may remove the lock path named in the error. When `model` is configured, the child is launched with `--model <value>`; otherwise Pi uses its normal default model selection. Model and timeout settings belong to the parent-to-child relationship. Delegation remains restricted to the allowlist and nested delegation is capped at four levels. Set `PI_CODING_AGENT_BIN` if needed.

While the parent waits, the delegation card shows the child's configured model (including a thinking-level suffix). The footer counts active runs across the hierarchy and shows the `f9` hint. Press `f9` (or run `/subagents`) for **Agent Explorer**, a full-terminal overlay with a recursive run tree and live conversation pane. It includes grandchildren at every supported depth, unique run IDs for repeated agent names, configured/actual models, tasks, tool arguments/results, own usage, elapsed/remaining time, and stale warnings. Parents with active children show their delegation status rather than a misleading stale warning. Completed and failed runs stay selectable.

- `↑↓` / `j k`: select runs in the tree. `←→`: collapse/expand or navigate parent/child.
- `Enter`: focus the conversation at full width. `→`: dive into its first child; `←` / `Esc`: back. `Tab`: switch tree/conversation focus. Narrow terminals show one pane at a time.
- `Control-U` / `Control-D`: scroll the conversation by a page; `g`: beginning; `Shift-G`: follow live output again. Scrolling up pauses auto-follow. Each run keeps its scroll position while navigating. The equivalent MacBook `Fn-↑` / `Fn-↓` and `Fn-←` / `Fn-→` keys also work.
- `p`: expand/collapse the full task prompt. `e`: expand/collapse tool arguments and results. `s`: queue steering for the selected active run; its transcript reports RPC acceptance/rejection (acceptance is not immediate delivery).
- `x`: confirm stopping the selected run **and its descendants**, not unrelated siblings. `Esc`: back/close; `f9`: close directly. Viewing or closing the explorer never interrupts a run or switches the main session.

Observation uses a private local socket on macOS/Linux, independent of the child RPC pipes and model context; no Orca-specific integration is required. History is in memory for the current runtime: `/reload`, session replacement, and exit clear it. Each transcript retains up to 400 entries / 100,000 characters, with 16,000-character entry previews; up to 100 completed-run transcripts are retained alongside active runs. Omitted history is marked explicitly. Run metadata remains in the tree. Images appear as placeholders. No transcript files are written; observed tool output may contain sensitive content, so treat the viewer like the main chat.

A manual interruption or deadline returns diagnostic context to the parent so it can choose another approach. Delegate tool output stays compact by default; use Pi's tool-expand key to view the complete Markdown result. Model-visible results are capped at Pi's standard 2,000-line/50 KB tool limit; oversized full output is saved to a private temporary file and linked from the result. The agent cannot choose its deadline at call time: configure `timeoutSeconds` on the parent's subagent entry. Omit it to run without a deadline.

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

- Agent Studio saves descriptions, lifecycle, colors, prompts, tool allowlists, MCP assignments, and subagent delegation settings directly to JSON definitions and static TypeScript object definitions. Dynamic/computed definitions use explicit saved overlays. Other metadata, policies, and executable custom-tool code remain untouched.
- MCP supports stdio and streamable HTTP transports (no SSE); custom server definitions are still configured statically, while the bundled Playwright, iOS Simulator, pen.dev, DocHub, and DesignHub recipes can be assigned in Studio.
- External edits to `.pi-agents/` need `/reload` (or a new session); Studio drafts and saves are applied immediately.
- Project-local installs (`pi install <repo> -l` / `pi-agents --local`) are recorded in `.pi/settings.json`, which git never checks out — freshly created worktrees of such a project have no extension. Use the default global install instead (the `.pi-agents/` configs remain per project)
