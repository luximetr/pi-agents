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

### config.json

```json
{
  "defaultAgent": "dev",
  "keybindings": { "select": "ctrl+shift+a", "rotate": "alt+a" }
}
```

`defaultAgent` is optional — unset (or `null`) means plain pi is the default. Keybinding overrides apply from the project config.

## How it works

- `session_start`: agents are discovered and loaded; the selection is restored (priority: `--agent` flag → persisted session selection → `config.defaultAgent` → `default: true` agent → plain pi)
- Applying an agent: `pi.setActiveTools(...)` restricts tools; `before_agent_start` appends the agent's system prompt to every turn
- Selection is persisted per session via `pi.appendEntry`, so it survives restarts of the same session
- Switching to `(none)` restores the toolset from before the first agent was applied

## Limitations / roadmap

- Tool allowlists only — MCP-backed agent tools are future work (the loader is ready for a `mcp` field)
- Agents are discovered at session start; edits to `.pi-agents/` need `/reload` (or a new session) to take effect for shortcuts/commands — the picker always reads fresh definitions
