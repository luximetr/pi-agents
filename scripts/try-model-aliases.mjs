#!/usr/bin/env node
// Interactive model-alias preview of this checkout. No installation, no settings changes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: node scripts/try-model-aliases.mjs [--prepare-only] [Pi options, e.g. --model provider/model]
Creates a temporary, isolated Pi home and demo project, then opens interactive Pi with this checkout loaded.
Aliases are stored in the sandbox config, so your real ~/.pi/agent/pi-agents/config.json is never touched.
Credentials are copied from your normal Pi agent directory if present. Uses your own model and consumes tokens.
Try: /models  ·  F7 → F4 (Studio) → Manage subagents → Set model  ·  /agent:help model aliases
--prepare-only writes the sandbox and prints the launcher without starting Pi.`);
  process.exit(0);
}
const prepareOnly = args.includes("--prepare-only");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-agents-alias-demo-")));
const home = path.join(root, "pi-home");
const project = path.join(root, "project");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Isolated agent dir: credentials are copied (OAuth refresh writes stay in the sandbox),
// settings stay empty so no global packages or extensions load besides this checkout.
await mkdir(path.join(home, "pi-agents"), { recursive: true, mode: 0o700 });
let credentials = "not found — run /login inside Pi or set a provider API key in the environment";
for (const file of ["auth.json", "models-store.json", "models.json"]) {
  const source = path.join(realAgentDir, file);
  if (!existsSync(source)) continue;
  await copyFile(source, path.join(home, file));
  if (file === "auth.json") credentials = `copied from ${source}`;
}
await writeFile(path.join(home, "settings.json"), "{}\n", { mode: 0o600 });
await writeFile(path.join(home, "pi-agents", "config.json"), `${JSON.stringify({
  models: [
    { id: "m_demo_fast", name: "fast", model: "openai-codex/gpt-6-luna:minimal" },
    { id: "m_demo_strong", name: "strong", model: "openai-codex/gpt-6.1-sol:high" },
  ],
}, null, 2)}\n`, { mode: 0o600 });

const agents = [
  {
    name: "alias-demo", description: "Model alias demo coordinator", default: true, tools: [],
    subagents: [{ name: "alias-worker", model: "@fast" }, { name: "alias-verifier", model: "@strong", timeoutSeconds: 180 }],
    systemPrompt: "You coordinate two demo workers to demonstrate model aliases. Keep all work inside this temporary project and do not edit files.",
  },
  { name: "alias-worker", description: "Demo worker pinned to the @fast alias", tools: ["bash"], systemPrompt: "Do exactly what the task asks and report the requested token." },
  { name: "alias-verifier", description: "Demo worker pinned to the @strong alias", tools: ["bash"], systemPrompt: "Do exactly what the task asks and report the requested token." },
];
for (const agent of agents) {
  const directory = path.join(project, ".pi-agents", agent.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent.ts"), `export default ${JSON.stringify(agent, null, 2)};\n`, { mode: 0o600 });
}

const wrapper = path.join(root, "pi-under-test.sh");
const launch = path.join(root, "launch.sh");
// Pin the child launcher to this wrapper so delegated workers also load the checkout,
// then run Pi with only this extension enabled (no install into any settings file).
await writeFile(wrapper, `#!/bin/sh
export PI_CODING_AGENT_DIR=${quote(home)}
export PI_CODING_AGENT_BIN=${quote(wrapper)}
exec pi --no-extensions --extension ${quote(path.join(repo, "index.ts"))} --no-skills --no-prompt-templates --no-context-files --approve "$@"
`, { mode: 0o700 });
await writeFile(launch, `#!/bin/sh
cd ${quote(project)} || exit 1
exec ${quote(wrapper)} --agent alias-demo --session ${quote(path.join(root, "demo.jsonl"))} "$@"
`, { mode: 0o700 });

const prompt = `Demonstrate model aliases. Delegate alias-worker (configured @fast) a task to run bash \`printf FAST_OK\`, and alias-verifier (configured @strong) a task to run bash \`printf STRONG_OK\`. Keep both in the background, then reply "Demo running".`;
await writeFile(path.join(root, "demo-prompt.txt"), prompt + "\n", { mode: 0o600 });

console.log(`Sandbox: ${root}
Agent dir: ${home} (credentials: ${credentials})
Project: ${project} (agents: ${agents.map(agent => agent.name).join(", ")})
Aliases: @fast → openai-codex/gpt-6-luna:minimal · @strong → openai-codex/gpt-6.1-sol:high
Resume later: ${quote(launch)}

In Pi:
  /models                       add, rename, retarget, or delete aliases (writes only to the sandbox config)
  F7 → F4 → Manage subagents    pick a model for a child; aliases appear as "@fast → ..."
  F9 → 2 Runs                   each delegation card shows the model the child actually received
Current demo uses @fast / @strong; switch a target in /models and re-delegate to see it change.

Uses your own credentials and consumes tokens.`);
if (prepareOnly) {
  console.log(`\nPrepared sandbox only (--prepare-only). Inspect ${project} and ${path.join(home, "pi-agents", "config.json")}.`);
  process.exit(0);
}
const child = spawn(launch, [...args.filter(arg => arg !== "--prepare-only")], { stdio: "inherit" });
child.once("error", error => { console.error(`Could not open Pi: ${error.message}\nRun ${launch} from a terminal with Pi installed.`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
