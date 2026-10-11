import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showSubagentChat } from "../subagent-chat.ts";

const theme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const snap = (id: string, over: Record<string, unknown> = {}): any => ({
	id, agent: `agent-${id}`, task: "t", startedAt: 0, lastActivityAt: 0, status: "running", phase: "running", partialText: "", recentEvents: [],
	model: "anthropic/claude-haiku-4-5", transcript: [
		{ id: "e1", kind: "user", text: `task for ${id}` },
		{ id: "e2", kind: "tool", title: "read", text: '{"path":"a.ts"}', output: "FILE-BODY", status: "finished" },
		{ id: "e3", kind: "assistant", text: `answer from ${id}` },
	], ...over,
});

function open(runs: any[], initialId: string, sent: string[] = []) {
	const selected: string[] = [];
	let component: any; let closed = false;
	const ctx: any = { ui: { custom: (factory: any) => new Promise<void>(resolve => {
		component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, undefined, () => { closed = true; resolve(); });
	}) } };
	const promise = showSubagentChat(ctx, {
		getHandles: () => runs.map(run => ({ id: run.id, snapshot: () => run }) as any),
		initialId, onSelect: id => selected.push(id),
		send: async (id, text) => { sent.push(`${id}:${text}`); return { notice: "sent" }; },
	});
	const text = () => stripVTControlCharacters(component.render(80).join("\n"));
	return { component, text, promise, selected, closed: () => closed };
}

test("chat view shows the selected agent's conversation in one screen", () => {
	const view = open([snap("a"), snap("b", { status: "finished", endedAt: 5000 })], "a");
	const text = view.text();
	assert.match(text, /▸ ◌ agent-a/);
	assert.match(text, /● main/);
	assert.match(text, /✓ agent-b/);
	assert.match(text, /> task for a/);
	assert.match(text, /✓ read/);
	assert.doesNotMatch(text, /FILE-BODY/, "tool output stays collapsed");
	assert.match(text, /answer from a/);
	assert.match(text, /steer ›/);
	for (const line of view.component.render(80)) assert.ok(visibleWidth(line) <= 80);
	assert.equal(view.component.render(80).length, 20);
	view.component.handleInput("\x1b"); // Esc
});

test("Tab switches chats, ctrl+o expands tools, Tab past the last returns to main", async () => {
	const view = open([snap("a"), snap("b", { status: "finished", endedAt: 5000 })], "a");
	view.component.handleInput("\t");
	assert.deepEqual(view.selected, ["b"]);
	assert.match(view.text(), /task for b/);
	assert.match(view.text(), /reply ›/, "finished runs get a reply prompt");
	view.component.handleInput("\x0f"); // ctrl+o
	assert.match(view.text(), /FILE-BODY/);
	view.component.handleInput("\t"); // wraps to main → closes
	await view.promise;
	assert.ok(view.closed());
});

test("Enter sends the typed text for the viewed run", async () => {
	const sent: string[] = [];
	const view = open([snap("a")], "a", sent);
	for (const ch of "hello") view.component.handleInput(ch);
	view.component.handleInput("\r");
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.deepEqual(sent, ["a:hello"]);
	assert.match(view.text(), /sent/);
	view.component.handleInput("\x1b");
	await view.promise;
});

test("Down focuses the bar; arrows only highlight; Enter confirms the switch; Esc cancels", async () => {
	const view = open([snap("a"), snap("b", { status: "finished", endedAt: 5000 })], "a");
	view.component.handleInput("\x1b[B"); // Down on empty input → focus bar
	assert.match(view.text(), /↑↓ choose/);
	view.component.handleInput("\x1b[B"); // highlight agent-b, view unchanged
	assert.deepEqual(view.selected, []);
	assert.match(view.text(), /▸ ✓ agent-b/);
	assert.match(view.text(), /task for a/);
	view.component.handleInput("\r"); // confirm
	assert.deepEqual(view.selected, ["b"]);
	assert.match(view.text(), /task for b/);
	assert.match(view.text(), /reply ›/);
	view.component.handleInput("\x1b[B"); // focus again, move up to agent-a, cancel with Esc
	view.component.handleInput("\x1b[A");
	view.component.handleInput("\x1b");
	assert.match(view.text(), /task for b/);
	assert.match(view.text(), /▸ ✓ agent-b/);
	view.component.handleInput("\x1b[B");
	view.component.handleInput("\x1b[A");
	view.component.handleInput("\x1b[A"); // main
	view.component.handleInput("\r"); // Enter on main → leave
	await view.promise;
	assert.ok(view.closed());
});
