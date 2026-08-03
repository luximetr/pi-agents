# pi-agents

Opencode-style agents for [pi](https://github.com/earendil-dev/pi): define agents **in code** and switch between them at any time. The active agent is always applied to your session — its tools are restricted and its system prompt is appended every turn. No agent selected = plain pi.

## Install

**Project-local (recommended while developing):**

```bash
cd <this repo>
npm install
mkdir -p .pi/extensions/pi-agents
ln -sf ../../index.ts .pi/extensions/pi-agents/index.ts
ln -sf ../../agents.ts .pi/extensions/pi-agents/agents.ts
ln -sf ../../ui.ts .pi/extensions/pi-agents/ui.ts
```

Project-local extensions load only in **trusted** projects — pi will ask on first interactive start (or run `/trust`).

**Global** (use in all projects): symlink the repo to `~/.pi/agent/extensions/pi-agents` instead.

Either way: `/reload` in pi (or restart) to pick up the extension.

## Usage

| Action | How |
|---|---|
| Open agent picker | `ctrl+shift+a` |
| Rotate to next agent | `alt+a` (cycles: plain pi → dev → doc → … → plain pi) |
| Switch directly | `/agent dev`, `/agent none` |
| Picker | `/agent` |
| Start with agent | `pi --agent dev` |
| Active agent indicator | footer status line: `agent:dev` |

Model and reasoning level are **not** part of an agent — pick them in pi itself (`/model`, thinking UI).

## Defining agents

Agents live in `.pi-agents/` — project root (walked up to git root) and global `~/.pi/pi-agents/`. Project agents override global ones with the same name.

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
  tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],  // tool allowlist
  systemPrompt: `You are the DOC agent. ...`,     // inline prompt…
  // systemPromptFile: "./prompt.md",             // …or from a file (relative to agent)
  // default: true,                               // auto-select on fresh sessions
};
```

Files are TypeScript loaded with [jiti](https://github.com/unjs/jiti) — you can use imports, helpers, or an async factory (`export default async () => ({...})`). Omit `tools` to keep the current toolset.

#### Typed tools

`tools` accepts any registered tool name (built-ins plus extension/MCP tools) and unknown names are filtered with a warning at apply time. For type checking + autocomplete, import the types from the extension and use the enum-style accessor:

```ts
import { Tools, type AgentConfig } from "../../.pi/extensions/pi-agents/agents"; // path relative to your agent file

const cfg: AgentConfig = {
  name: "doc",
  description: "Documentation agent.",
  tools: [Tools.read, Tools.grep, Tools.find, Tools.ls, Tools.write, Tools.edit, Tools.bash],
  systemPrompt: "You are the DOC agent.",
};
export default cfg;
```

Plain string literals work too — `"read"` and `Tools.read` are the same value. Any string is allowed at the type level (`ToolName`), so custom tools registered by other extensions type-check as well; the built-ins just get autocomplete in editors.

### config.json

```json
{
  "defaultAgent": "dev",
  "keybindings": { "select": "ctrl+shift+a", "rotate": "alt+a" }
}
```

`defaultAgent` is optional — unset (or `null`) means plain pi is the default. Keybinding overrides apply from the project config. Each action takes a single key **or an array of keys** — add a fallback that your terminal definitely sends:

```json
{
  "keybindings": {
    "select": ["ctrl+shift+a", "ctrl+q"],
    "rotate": ["alt+a", "ctrl+shift+r"]
  }
}
```

## Troubleshooting: shortcuts don't fire

The shortcuts are plain terminal key sequences — if your terminal doesn't send them, pi never sees them and the key falls through (e.g. `alt+a` types `å`).

- **`alt+a` (rotate)** requires the terminal to send `Alt` as an escape prefix. On macOS the default is *not* to send it:
  - iTerm2: Settings → Profiles → Keys → **Option key sends:** → `ESC+`
  - Terminal.app: Settings → Profiles → Keyboard → enable **Use Option as Meta key**
  - kitty / WezTerm / Ghostty: works out of the box
- **`ctrl+shift+a` (select)** requires the terminal to report `Ctrl+Shift` distinctly (Kitty keyboard protocol / CSI-u). Terminals that do: kitty, WezTerm, Ghostty, iTerm2 with **Report modifiers using CSI u** enabled. Other terminals send the same bytes as plain `ctrl+a`, which pi sees as its built-in "cursor to line start".
- **Works regardless of terminal:** `/agent` (picker), `/agent dev` (direct), and `pi --agent dev` (startup). Commands don't depend on key encoding.
- **Add a fallback key** that your terminal sends reliably via `keybindings` above — plain `ctrl+letter` combos work in every terminal.

## How it works

- `session_start`: agents are discovered and loaded; the selection is restored (priority: `--agent` flag → persisted session selection → `config.defaultAgent` → `default: true` agent → plain pi)
- Applying an agent: `pi.setActiveTools(...)` restricts tools; `before_agent_start` appends the agent's system prompt to every turn
- Selection is persisted per session via `pi.appendEntry`, so it survives restarts of the same session
- Switching to `(none)` restores the toolset from before the first agent was applied

## Limitations / roadmap

- Tool allowlists only — MCP-backed agent tools are future work (the loader is ready for a `mcp` field)
- Agents are discovered at session start; edits to `.pi-agents/` need `/reload` (or a new session) to take effect for shortcuts/commands — the picker always reads fresh definitions
