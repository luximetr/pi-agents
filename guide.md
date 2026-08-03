# pi-agents guide

This extension defines "agents" in code — each agent is a tool allowlist + system prompt + optional MCP servers. Read this when asked to create agents, add tools, or wire up MCP.

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
  tools: ["read", "bash"],            // allowlist; omit = keep current tools
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
    }
  }
}
```

- `defaultAgent`: auto-selected on fresh sessions (`null`/unset = plain pi). Overridden by `--agent` flag and per-session selection.
- `keybindings`: each action takes a single key or an array of fallbacks (terminal key encoding varies).

## MCP servers

- Defined in `config.json` `mcpServers` (stdio only: `command`, `args`, `env`, `cwd`).
- **Nothing connects unless an agent opts in** via its `mcp` field.
- Server tools register as `<server>__<tool>`, e.g. `playwright__browser_navigate` — no collisions, server always identifiable.
- An agent's active toolset = its `tools` (or current toolset) ∪ its servers' tools.
- Best practice: shared servers globally (`~/.pi/agent/pi-agents/config.json`), project-specific ones in the project config. Agents and servers can live in different places — any agent can use any merged server.

## Add a tool

- Built-ins: list in `tools` — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (typed: `Tools.read`).
- Extension/MCP tools: list their registered names (`server__tool` for MCP). Unknown names are filtered with a warning at apply time.
- The `pi_agents_guide` tool is always available to every agent automatically.

## After editing .pi-agents/

Agents are discovered at session start — run `/reload` (or start a new session) for changes to take effect; the `/agent` picker always reads fresh definitions.
