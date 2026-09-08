import assert from "node:assert/strict";
import test from "node:test";
import messageTiming, { formatClockTime, formatDuration, type MessageTimingData } from "../message-timing.ts";

test("formats elapsed durations", () => {
	assert.equal(formatDuration(42), "42ms");
	assert.equal(formatDuration(1250), "1.3s");
	assert.equal(formatDuration(65_900), "1m 5s");
	assert.equal(formatDuration(-1), "0ms");
});

test("formats clock time without a date", () => {
	assert.match(formatClockTime(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
});

test("records one timing entry for a complete task across retries", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const entries: Array<{ customType: string; data: any }> = [];
	const statuses: Array<string | undefined> = [];
	const renderers = new Map<string, (entry: { data?: any }, options: unknown, theme: any) => any>();
	const pi: any = {
		on: (name: string, handler: (event: unknown, ctx: any) => void) => handlers.set(name, handler),
		registerEntryRenderer: (type: string, renderer: (entry: { data?: any }, options: unknown, theme: any) => any) => renderers.set(type, renderer),
		appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	messageTiming(pi);
	const userTimestamp = new Date(2025, 0, 2, 3, 4, 5).getTime();
	const assistantTimestamp = new Date(2025, 0, 2, 3, 4, 6).getTime();
	handlers.get("message_end")?.({ message: { role: "user", timestamp: userTimestamp } }, ctx);
	handlers.get("message_end")?.({ message: { role: "toolResult" } }, ctx);
	handlers.get("message_end")?.({ message: { role: "assistant", timestamp: assistantTimestamp } }, ctx);
	assert.deepEqual(entries.map(entry => entry.customType), ["pi-message-timestamp"]);
	// Pi has finalized the streaming assistant component by turn_end, so only
	// then is its display-only label appended to the transcript.
	handlers.get("turn_end")?.({}, ctx);
	handlers.get("agent_start")?.({}, ctx);
	handlers.get("agent_start")?.({}, ctx); // automatic retry
	handlers.get("agent_settled")?.({}, ctx);

	assert.deepEqual(entries.map(entry => entry.customType), [
		"pi-message-timestamp",
		"pi-message-timestamp",
		"pi-message-timing",
	]);
	assert.deepEqual(entries.slice(0, 2).map(entry => entry.data), [
		{ role: "user", timestamp: userTimestamp },
		{ role: "assistant", timestamp: assistantTimestamp },
	]);
	assert.ok((entries[2]?.data.durationMs ?? -1) >= 0);
	assert.match(statuses[0] ?? "", /^⏱ working · /);
	assert.equal(statuses.at(-1), undefined);

	const userLabel = renderers.get("pi-message-timestamp")?.({ data: entries[0]?.data }, {}, ctx.ui.theme).render(100).join("\n") ?? "";
	assert.equal(userLabel.trim(), "You · 03:04:05");
	const assistantLabel = renderers.get("pi-message-timestamp")?.({ data: entries[1]?.data }, {}, ctx.ui.theme).render(100).join("\n") ?? "";
	assert.equal(assistantLabel.trim(), "Assistant · 03:04:06");
	const timing = renderers.get("pi-message-timing")?.({ data: entries[2]?.data }, {}, ctx.ui.theme).render(100).join("\n") ?? "";
	assert.match(timing.trim(), /^took (?:\d+ms|\d+\.\d+s)$/);
	assert.doesNotMatch(timing, /→/);
});
