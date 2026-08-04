# pi-agents

Opencode-style agents for [pi](https://github.com/earendil-dev/pi): define agents **in code** and switch between them at any time. The active agent is always applied to your session — its tools are restricted and its system prompt is appended every turn. No agent selected = plain pi.

## Install

**One line per project** — after linking the CLI once:

```bash
cd <this repo>
npm install
npm link            # once: makes the `pi-agents` command available on your machine
```

then, in any project on your machine:

```bash
pi-agents install            # install into the current project
pi-agents install <dir>      # …or an explicit project dir
pi-agents --global           # …or enable it in ALL projects (~/.pi/agent/settings.json)
pi-agents --agents           # also copy the bundled sample agents into <dir>/.pi-agents/
```

The installer delegates to pi's package manager (`pi install <repo> [-l]`): the repo path
is recorded in the project's `.pi/settings.json` (or `~/.pi/agent/settings.json` for
`--global`) and the extension is loaded from the repo directly — nothing is copied and
the target project needs **no node_modules of its own** (deps resolve from this repo).
It also records the project trust decision (same as accepting pi's "Trust project
folder?" prompt), so the extension loads immediately. Manage with `pi-agents status`,
`pi-agents remove`, or pi's own `pi list` / `pi remove`. The pi one-liner works too:
`pi install <path-to-this-repo> -l` (add `-a` to trust).

`pi-agents` CLI reference:

| Command | Effect |
|---|---|
| `pi-agents install [dir]` | install into dir (default: current dir) — the default command |
| `pi-agents --global` | install for all projects (`~/.pi/agent/settings.json`) |
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
```

Project-local extensions load only in **trusted** projects — pi will ask on first interactive start (or run `/trust`).

**Global** (use in all projects): symlink the repo to `~/.pi/agent/extensions/pi-agents` instead.

Either way: `/reload` in pi (or restart) to pick up the extension.

## Usage

| Action | How |
|---|---|
| Open agent picker | `ctrl+shift+a` |
| Rotate to next agent | `ctrl+shift+q` (cycles: plain pi → dev → doc → … → plain pi) |
| Switch directly | `/agent dev`, `/agent none` |
| Ask about the extension | `/agent:help <question>` (answered from the bundled guide) |
| Picker | `/agent` |
| Start with agent | `pi --agent dev` |
| Active agent indicator | footer status line: `agent:dev`, tinted with the agent's color |

Model and reasoning level are **not** part of an agent — pick them in pi itself (`/model`, thinking UI).

## Defining agents

Agents live in `.pi-agents/` — project root (walked up to git root) and global `~/.pi/agent/pi-agents/` (pi's agent config dir). Project agents override global ones with the same name.

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

### agent.ts

```ts
export default {
  name: "doc",                                    // optional for single-file agents
  description: "Documentation agent: read-only, writes docs, READMEs.",
  color: "#bf5af2",                               // theme role or "#rrggbb"; auto-assigned by name when omitted
  tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],  // tool allowlist
  systemPrompt: `You are the DOC agent. ...`,     // inline prompt…
  // systemPromptFile: "./prompt.md",             // …or from a file (relative to agent)
  // default: true,                               // auto-select on fresh sessions
};
```

Files are TypeScript loaded with [jiti](https://github.com/unjs/jiti) — you can use imports, helpers, or an async factory (`export default async () => ({...})`). Omit `tools` to keep the current toolset; pass `tools: []` to disable all built-in tools (the agent keeps only its MCP tools, if any).

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
  "keybindings": { "select": "ctrl+shift+a", "rotate": "ctrl+shift+q" },
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

`defaultAgent` is optional. If it is unset, the last agent selection is remembered for the next `/new` session; otherwise the first agent marked `default: true` (or, when none is marked, the first discovered agent) is selected. Use `/agent none` to clear the current agent and restore plain pi for that session. Keybinding overrides apply from the project config. Each action takes a single key **or an array of keys** — add a fallback that your terminal definitely sends:

```json
{
  "keybindings": {
    "select": ["ctrl+shift+a", "ctrl+shift+s"],
    "rotate": ["ctrl+shift+q", "ctrl+shift+t"]
  }
}
```

### MCP servers (per-agent, opt-in)

`mcpServers` in `config.json` defines [MCP](https://modelcontextprotocol.io) servers. Two kinds are supported:

- **stdio** — spawn a local process: `command`, `args`, `env`, `cwd` (Claude Desktop-style).
- **streamable HTTP** — connect to a URL: `url`, `headers`, `insecure`.

Header values can reference env vars as `${VAR}` so secrets never sit in a committed config: `"Authorization": "Bearer ${DOC_MCP_TOKEN}"` resolves at connect time (with a warning if unset). `insecure: true` skips TLS verification for self-signed certs (common on Tailscale IPs).

For per-project secrets without shell setup: put the values in a gitignored `.pi-agents/.env` (e.g. `DOC_MCP_TOKEN=...`; template in `.pi-agents/.env.example`). It's loaded automatically — project `.env` wins over the global `~/.pi/pi-agents/.env`, and your real shell environment wins over both. Nothing to key in per launch.

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

MCP tools are registered as `<server>__<tool>`, e.g. `playwright__browser_navigate`, so tools from different servers never collide and the server is always identifiable in the tool name. Tool schemas come from the server (JSON Schema → TypeBox) and tool calls are forwarded with `client.callTool`. The tool allowlist and MCP tools are combined: `active = agent.tools (or current) ∪ agent.mcp tools`.

Details:
- Switching to an agent without the server's MCP tools deactivates them; **connections stay alive** for fast switching back. All servers are shut down on session end (`session_shutdown`).
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

The shortcuts are plain terminal key sequences — if your terminal doesn't send them, pi never sees them and the key falls through.

- **`ctrl+q`** is commonly consumed by terminal flow control, and **`ctrl+a`** is commonly reserved by the line editor. They cannot reliably be used as extension shortcuts.
- **`ctrl+shift+a` (select) and `ctrl+shift+q` (rotate)** require the terminal to report `Ctrl+Shift` distinctly (Kitty keyboard protocol / CSI-u). Terminals that do: kitty, WezTerm, Ghostty, iTerm2 with **Report modifiers using CSI u** enabled. Since `ctrl+shift+a` works in your terminal, `ctrl+shift+q` should work with the same setup.
- **Works regardless of terminal:** `/agent` (picker), `/agent dev` (direct), and `pi --agent dev` (startup). Commands don't depend on key encoding.
- **Add a fallback key** that your terminal sends reliably via `keybindings` above. For example, use `"rotate": ["ctrl+shift+q", "ctrl+shift+t"]`.

## How it works

- `session_start`: agents are discovered and loaded; the selection is restored (priority: `--agent` flag → current session selection → selection from the session replaced by `/new` or `/clone` → `config.defaultAgent` → `default: true` agent → first agent)
- Applying an agent: `pi.setActiveTools(...)` restricts tools; `before_agent_start` appends the agent's system prompt to every turn
- MCP: servers from merged `config.json` are connected on demand when an agent with `mcp: [...]` is applied; their tools are registered as `<server>__<tool>` and activated together with the tool allowlist
- Selection is persisted via `pi.appendEntry`; it survives restarts and is inherited by `/new` and `/clone` sessions
- Switching to `(none)` restores the toolset from before the first agent was applied

## Limitations / roadmap

- MCP supports stdio and streamable HTTP transports (no SSE); server config is static (no dynamic add/remove at runtime)
- Agents are discovered at session start; edits to `.pi-agents/` need `/reload` (or a new session) to take effect for shortcuts/commands — the picker always reads fresh definitions
