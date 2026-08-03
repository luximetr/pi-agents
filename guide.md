# pi-agents guide

This extension defines "agents" in code — each agent is a tool allowlist + system prompt + optional MCP servers. Read this when asked to create agents, add tools, wire up MCP, or explain how the extension works.

## Using the extension (quick start)

- Switch agents: `ctrl+shift+a` (picker), `alt+a` (rotate), or `/agent <name>` (`/agent none` clears).
- Start with an agent from the CLI: `pi --agent dev`.
- The active agent's system prompt is appended every turn; its tools are restricted to its allowlist (+ its MCP tools).
- No agent selected = plain pi, unchanged.
- `/agent:help <question>` answers a question from this guide (e.g. `/agent:help how do I add an MCP server?`).

## Where agents live

- Project: `<git-root>/.pi-agents/` (searched upward from cwd)
- Global: `~/.pi/agent/pi-agents/` (same layout; project wins on name collision)

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
  mcp: ["playwright"],                // MCP servers to connect (opt-in!)
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

## config.json (project or global, merged; project wins)

```json
{
  "defaultAgent": "dev",
  "keybindings": { "select": "ctrl+shift+a", "rotate": "alt+a" },
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
- `keybindings`: each action takes a single key or an array of fallbacks (terminal key encoding varies).

## MCP servers

Two kinds, defined in `config.json` `mcpServers`:

- **stdio** (default): spawn a local process — `command`, `args`, `env`, `cwd` (Claude Desktop-style).
- **streamable HTTP**: reach a remote/local URL — `url`, `headers`, `insecure`. `headers` values may reference env vars as `${VAR}` (e.g. `"Bearer ${DOC_MCP_TOKEN}"`) so secrets never land in a committed config file; if the var is unset you get a warning at activation. `insecure: true` skips TLS certificate verification (self-signed certs, e.g. on Tailscale IPs).

Secrets per project: put the actual values in a gitignored `.env` file — project `.pi-agents/.env` (and/or global `~/.pi/pi-agents/.env`; project wins, shell env wins over both). Template: `.pi-agents/.env.example`. No keying in per launch — the file is loaded automatically at session start.

Per agent: a server can also be defined **inside the agent** (`mcpServers` in `agent.ts`, same shape) — then only that agent can ever use it, and it overrides project/global servers with the same name. Its key goes in a gitignored `<agent-dir>/.env`, e.g. `.pi-agents/agent-doc/.env`. Resolution order: shell env → agent `.env` → project `.env` → global `.env`.

- **Nothing connects unless an agent opts in** via its `mcp` field.
- Server tools register as `<server>__<tool>`, e.g. `playwright__browser_navigate` — no collisions, server always identifiable.
- An agent's active toolset = its `tools` (or current toolset) ∪ its servers' tools.
- Best practice: shared servers globally (`~/.pi/agent/pi-agents/config.json`), project-specific ones in the project config. Agents and servers can live in different places — any agent can use any merged server.

## Add a tool

- Built-ins: list in `tools` — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (typed: `Tools.read`).
- Extension/MCP tools: list their registered names (`server__tool` for MCP). Unknown names are filtered with a warning at apply time.

## After editing .pi-agents/

Agents are discovered at session start — run `/reload` (or start a new session) for changes to take effect; the `/agent` picker always reads fresh definitions.
