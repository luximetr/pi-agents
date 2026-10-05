#!/usr/bin/env node
// Deterministic fixture previews of the actual TUI renderers; no provider calls.
// Usage: node scripts/preview-session-ui.mjs [output-directory]
// Optional PNG capture: CHROME_BIN=/path/to/chrome node scripts/preview-session-ui.mjs ...
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const output = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(os.tmpdir(), "pi-agents-session-previews-"));
await mkdir(output, { recursive: true });
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderSessionOverview } = await jiti.import("../session-overview.ts");
const { showSubagentInspector } = await jiti.import("../subagent-explorer.ts");
const { SessionCoordination } = await jiti.import("../session-coordination.ts");
const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-agents-preview-state-")));
const storeOptions = { projectCwd: fixtureRoot, rootSessionId: "renderer-fixture", directory: path.join(fixtureRoot, "coordination") };
const coordination = SessionCoordination.open(storeOptions);
coordination.createTask({
  id: "login", title: "Finish login fix", objective: "Fix login, review worker reports, and verify the full flow.", owner: "main",
  items: [
    { id: "investigate", text: "Investigate the bug", status: "completed" },
    { id: "implement", text: "Implement login fix", status: "in_progress", owner: "dev-worker" },
    { id: "review", text: "Review implementation", status: "pending", owner: "main", dependsOn: ["implement"] },
    { id: "verify", text: "Verify login end to end", owner: "main", dependsOn: ["review"] },
  ],
});
coordination.createTask({
  id: "auth", title: "Evaluate authentication options", objective: "Compare supported authentication approaches.", owner: "researcher",
  items: [{ id: "compare", text: "Compare authentication options", status: "in_progress", owner: "researcher" }, { id: "choose", text: "Choose an approach", dependsOn: ["compare"] }],
});
coordination.linkRun("login-implementation", { taskId: "login", itemId: "implement", agent: "dev-worker", task: "Implement login fix" });
coordination.linkRun("auth-options", { taskId: "auth", itemId: "compare", agent: "researcher", task: "auth options" });
coordination.recordResult({
  runId: "login-implementation", agent: "dev-worker", title: "Login implementation", task: "Implement login fix", executionStatus: "completed",
  summary: "Login implementation is ready. Review cookie handling and run tests before marking it handled.",
  text: "Implemented login session renewal and cookie handling.\n\nChanged files: auth/login.ts and auth/login.test.ts.\nThe implementation still needs main-agent review and end-to-end verification.",
});
coordination.recordResult({
  runId: "legacy-auth", taskId: "auth", agent: "researcher", title: "Legacy auth migration", task: "Assess legacy auth migration", executionStatus: "completed",
  summary: "Migration comparison saved for after the login fix.", text: "Legacy auth migration can be addressed after current login verification.",
});
coordination.markDelivered(["login-implementation", "legacy-auth"]);
coordination.handleResult("legacy-auth", "deferred", "Resume after login E2E.");
// Read through the same validation path used on application restoration. Fixture
// timestamps, scope, links, and result flags come from real coordination actions.
let state = SessionCoordination.open(storeOptions).snapshot();
assert.equal(state.tasks[0].items[1].status, "in_progress", "an unhandled report leaves the task item unfinished");
assert.equal(state.results[0].executionStatus, "completed");
assert.equal(state.results[0].handling, "new");
assert.throws(() => coordination.updateItem("login", "implement", { status: "completed" }), /unhandled result/i);
const now = Date.now();
const runs = [
  { id: "auth-options", agent: "researcher", task: "auth options", status: "running", phase: "researching" },
  { id: "login-implementation", agent: "dev-worker", task: "Implement login fix", status: "finished", phase: "completed", endedAt: now - 5000 },
].map(run => ({ startedAt: now - 40000, lastActivityAt: now, partialText: "", recentEvents: [], workspace: "shared", workspaceCwd: "/tmp/pi-agents-preview", transcript: [], ...run }));
const handles = runs.map(run => ({ id: run.id, snapshot: () => ({ ...run }), steer: () => false, stop() {} }));
const colors = { accent: "100;181;246", muted: "157;168;183", dim: "112;128;145", success: "127;199;154", warning: "235;191;100", error: "235;112;116", text: "223;230;238", toolTitle: "181;155;238" };
const theme = { fg: (role, text) => `\x1b[38;2;${colors[role] ?? colors.text}m${text}\x1b[39m`, bold: text => `\x1b[1m${text}\x1b[22m` };
let component;
const ctx = { mode: "tui", ui: { theme, custom: factory => new Promise(resolve => {
  component = factory({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, theme, {}, resolve);
}) } };
const closed = showSubagentInspector(ctx, () => handles, 5, "Main session", {
  getCoordination: () => state,
  onHandleResult: (runId, handling) => { coordination.handleResult(runId, handling); state = coordination.snapshot(); },
  onResultAction() {}, getResultActions: () => ["reply"],
});
const previews = [];
try {
  previews.push({ name: "overview", width: 110, lines: renderSessionOverview(state, runs, 110) });
  component.handleInput("1");
  previews.push({ name: "session", width: 120, lines: component.render(120) });
  component.handleInput("3");
  previews.push({ name: "inbox", width: 120, lines: component.render(120) });
  assert.equal(state.results[0].handling, "new", "viewing Inbox must not acknowledge the result");
  assert.equal(state.tasks[0].items[1].status, "in_progress", "viewing Inbox must preserve checklist progress");
  component.handleInput("\r");
  previews.push({ name: "inbox-report", width: 120, lines: component.render(120) });
  assert.equal(state.results[0].handling, "new", "opening a report must not acknowledge it");
  for (const width of [40, 12]) {
    const lines = renderSessionOverview(state, runs, width, 5);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    previews.push({ name: `overview-${width}`, width, lines });
  }
} finally {
  component.handleInput("\x1b[20~");
  component.dispose?.();
}
await closed;

const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function ansiHtml(text) {
  let color = "#dfe6ee", bold = false, output = "", last = 0;
  const token = /\x1b\[([0-9;]*)m/g;
  for (const match of text.matchAll(token)) {
    output += `<span style="color:${color};font-weight:${bold ? 600 : 400}">${escape(stripVTControlCharacters(text.slice(last, match.index)))}</span>`;
    const codes = match[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0) { color = "#dfe6ee"; bold = false; }
      else if (codes[i] === 1) bold = true;
      else if (codes[i] === 22) bold = false;
      else if (codes[i] === 39) color = "#dfe6ee";
      else if (codes[i] === 38 && codes[i + 1] === 2) { color = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; i += 4; }
    }
    last = match.index + match[0].length;
  }
  return output + `<span style="color:${color};font-weight:${bold ? 600 : 400}">${escape(stripVTControlCharacters(text.slice(last)))}</span>`;
}
for (const preview of previews) {
  assert.ok(preview.lines.every(line => visibleWidth(line) <= preview.width), `${preview.name} exceeds terminal width`);
  await writeFile(path.join(output, `${preview.name}.txt`), preview.lines.map(stripVTControlCharacters).join("\n") + "\n");
  const caption = preview.width < 70 ? `FIXTURE PREVIEW · ${preview.width} columns` : `RENDERED FIXTURE PREVIEW · ${preview.name} · actual pi-agents TUI renderer · ${preview.width} columns`;
  const html = `<!doctype html><meta charset="utf-8"><title>${escape(preview.name)} — rendered fixture preview</title><style>html,body{margin:0;background:#111820;color:#dfe6ee}body{padding:24px;width:${Math.ceil(preview.width * 9.05)}px}p{margin:0 0 18px;font:12px system-ui;color:#9da8b7}pre{margin:0;font:15px/23px Menlo,Consolas,monospace;white-space:pre}</style><p>${escape(caption)}</p><pre>${preview.lines.map(ansiHtml).join("\n")}</pre>`;
  const htmlPath = path.join(output, `${preview.name}.html`);
  await writeFile(htmlPath, html);
  if (process.env.CHROME_BIN) {
    const profile = await mkdtemp(path.join(os.tmpdir(), "pi-agents-preview-browser-"));
    const png = path.join(output, `${preview.name}.png`);
    await rm(png, { force: true });
    const child = spawn(process.env.CHROME_BIN, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", `--user-data-dir=${profile}`, `--screenshot=${png}`, `--window-size=${Math.ceil(preview.width * 9.05 + 55)},${preview.lines.length * 23 + (preview.width < 23 ? 120 : 95)}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
    let failure, exited = false;
    child.once("error", error => { failure = error; });
    child.once("exit", () => { exited = true; });
    const deadline = Date.now() + 20000;
    while (!existsSync(png) && !failure && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!exited) child.kill("SIGTERM");
    if (failure) throw failure;
    assert.ok(existsSync(png), `Chrome did not capture ${preview.name}`);
  }
}
await writeFile(path.join(output, "fixture.json"), JSON.stringify({ source: "scripts/preview-session-ui.mjs", kind: "rendered fixture previews, not live screenshots", state, runs }, null, 2));
await rm(fixtureRoot, { recursive: true, force: true });
console.log(`PASS: validated durable fixture and rendered ${previews.length} fixture previews; viewing preserves item progress and unhandled reports.\nArtifacts: ${output}`);
