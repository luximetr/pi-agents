import assert from "node:assert/strict";
import test from "node:test";
import { MAIN_ENTRY, barRuns, nextBarEntry, renderAgentBar, shortModel, stepBarEntry, taskTitle } from "../agent-bar.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const run = (id: string, over: Record<string, unknown> = {}): any => ({ id, agent: "explorer", task: "t", startedAt: 0, lastActivityAt: 0, status: "running", phase: "", partialText: "", recentEvents: [], model: "anthropic/claude-haiku-4-5:low", ...over });

test("shortModel strips provider, prefix and thinking level", () => {
	assert.equal(shortModel("anthropic/claude-haiku-4-5:low"), "haiku-4-5");
	assert.equal(shortModel(undefined), "");
});

test("bar is hidden without runs and vertical with them", () => {
	assert.deepEqual(renderAgentBar([], MAIN_ENTRY, 100), []);
	const lines = renderAgentBar([run("a"), run("b", { status: "finished", endedAt: 65000 })], "a", 100, 12000);
	assert.equal(lines.length, 4, "main + 2 runs + hint");
	assert.match(lines[0]!, /^  ● main/);
	assert.match(lines[1]!, /^▸ ◌ explorer · haiku-4-5 · 12s/);
	assert.match(lines[2]!, /^  ✓ explorer · haiku-4-5 · 1m05s/);
	assert.match(lines[3]!, /↓ agents/);
	assert.match(renderAgentBar([run("a")], "a", 100, 0, undefined, true).at(-1)!, /enter open/);
});

test("bar caps rows, keeps selection visible and never exceeds width", () => {
	const runs = Array.from({ length: 12 }, (_, i) => run(`r${i}`, { startedAt: i }));
	for (const width of [20, 40, 80]) for (const line of renderAgentBar(runs, "r11", width)) assert.ok(visibleWidth(line) <= width);
	const lines = renderAgentBar(runs, "r11", 80, 0, undefined, false, 4);
	assert.equal(lines.length, 5);
	assert.ok(lines.some(line => line.startsWith("▸")));
	assert.match(lines.at(-1)!, /\+9 more/);
});

test("stepBarEntry moves and clamps", () => {
	const runs = [run("done", { status: "finished", endedAt: 5 }), run("live")];
	assert.equal(stepBarEntry(runs, MAIN_ENTRY, 1), "live");
	assert.equal(stepBarEntry(runs, "live", 1), "done");
	assert.equal(stepBarEntry(runs, "done", 1), "done");
	assert.equal(stepBarEntry(runs, MAIN_ENTRY, -1), MAIN_ENTRY);
});

test("nextBarEntry cycles main → active runs → finished → main", () => {
	const runs = [run("done", { status: "finished", endedAt: 5 }), run("live")];
	assert.equal(nextBarEntry(runs, MAIN_ENTRY), "live");
	assert.equal(nextBarEntry(runs, "live"), "done");
	assert.equal(nextBarEntry(runs, "done"), MAIN_ENTRY);
});

test("runs of one thread are a single entry that goes back to working after a reply", () => {
	const first = run("r1", { threadId: "t1", status: "finished", startedAt: 0, endedAt: 5000 });
	const reply = run("r2", { threadId: "t1", startedAt: 8000 });
	const other = run("r3", { startedAt: 9000 });
	assert.deepEqual(barRuns([first, reply, other]).map(entry => entry.id), ["r2", "r3"]);
	assert.equal(barRuns([first, reply])[0]!.startedAt, 0, "elapsed spans the whole conversation");
	const lines = renderAgentBar([first, reply], "t1", 100, 12000);
	assert.equal(lines.length, 3, "main + one conversation + hint");
	assert.match(lines[1]!, /^▸ ◌ explorer · haiku-4-5 · 12s/);
	assert.equal(nextBarEntry([first, reply], MAIN_ENTRY), "t1");
	assert.equal(barRuns([first])[0]!.status, "finished");
});

test("rows end with the conversation's task title", () => {
	const first = run("r1", { threadId: "t1", status: "finished", startedAt: 0, endedAt: 5000, task: "## Explore the auth flow\nlook at src/" });
	const reply = run("r2", { threadId: "t1", startedAt: 8000, task: "and the tests?" });
	const lines = renderAgentBar([first, reply], MAIN_ENTRY, 100, 12000);
	assert.match(lines[1]!, /· 12s · Explore the auth flow$/);
	assert.equal(taskTitle("\x1b[31m  - fix **bug**\n"), "fix **bug**");
	assert.equal(taskTitle(undefined), "");
	const narrow = renderAgentBar([first], MAIN_ENTRY, 40, 12000)[1]!;
	assert.ok(visibleWidth(narrow) <= 40);
});
