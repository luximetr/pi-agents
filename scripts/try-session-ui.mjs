#!/usr/bin/env node
// Interactive preview of this checkout. No installation or publication.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/try-session-ui.mjs [--prepare-only] [Pi options, e.g. --model provider/model]\nCreates a temporary demo project and opens interactive Pi with a two-worker demo prompt, using this checkout in parent and workers.\nUses your normal Pi model/credentials and consumes tokens. No settings installation is performed.\n--prepare-only writes the demo files and prints the launcher without starting Pi.");
  process.exit(0);
}
const prepareOnly = args.includes("--prepare-only");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-agents-ui-demo-")));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const wrapper = path.join(root, "pi-under-test.sh");
const launch = path.join(root, "launch.sh");
const agents = [
  { name: "session-demo", description: "Interactive session overview demo", default: true, tools: ["session_plan"], mcp: [],
    subagents: [{ name: "demo-tester", timeoutSeconds: 120 }, { name: "demo-researcher", timeoutSeconds: 120 }],
    systemPrompt: "Help the user inspect session tasks. Use session_plan for accepted tasks and items. Follow the user's requested handling. Keep demo work inside this temporary project." },
  ...["demo-tester", "demo-researcher"].map(name => ({ name, description: "Temporary demo worker", tools: ["bash"], mcp: [],
    systemPrompt: "Follow the requested demo task exactly. Execute only its requested wait/printf command and report the token. Do not modify files or start other work." })),
];
for (const agent of agents) {
  const directory = path.join(root, ".pi-agents", agent.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "agent.ts"), `export default ${JSON.stringify(agent, null, 2)};\n`, { mode: 0o600 });
}
await writeFile(wrapper, `#!/bin/sh\nexport PI_CODING_AGENT_BIN=${quote(wrapper)}\nexec pi --no-extensions --extension ${quote(path.join(repo, "index.ts"))} --no-skills --no-prompt-templates --no-context-files --approve "$@"\n`, { mode: 0o700 });
await writeFile(launch, `#!/bin/sh\ncd ${quote(root)} || exit 1\nexec ${quote(wrapper)} --agent session-demo --session ${quote(path.join(root, "demo.jsonl"))} "$@"\n`, { mode: 0o700 });
const prompt = `Create two independent demo tasks with checklists: API check and auth research. Give each task a worker item and a review item.
Delegate demo-tester in the background for the API task: execute bash \`sleep 20; printf API_OK\` once, then report API_OK.
Delegate demo-researcher in the background for the research task: execute bash \`sleep 35; printf AUTH_OK\` once, then report AUTH_OK.
Link each run to its task and item. After launching, reply "Demo running". When reports arrive, leave them new and both tasks active so I can inspect the Inbox. Do not mark reports handled or items completed until I ask. Do not edit files.`;
await writeFile(path.join(root, "demo-prompt.txt"), prompt + "\n", { mode: 0o600 });
console.log(`Demo project: ${root}\nResume later: ${quote(launch)}\n\nThe demo starts two workers and leaves their reports awaiting review.\nIn Pi, press F9. Keys: 1 Tasks · 2 Runs · 3 Inbox.\nThis uses your normal Pi credentials and model tokens.\n`);
if (prepareOnly) process.exit(0);
const child = spawn(launch, [...args.filter(arg => arg !== "--prepare-only"), prompt], { stdio: "inherit" });
child.once("error", error => { console.error(`Could not open Pi: ${error.message}\nRun ${launch} from a terminal with Pi installed.`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
