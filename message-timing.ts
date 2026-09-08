import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-message-timing";
const MESSAGE_ENTRY_TYPE = "pi-message-timestamp";
const STATUS_KEY = "pi-message-timing";

export interface MessageTimestampData {
	role: "user" | "assistant";
	timestamp: number;
}

export interface MessageTimingData {
	startedAt: number;
	endedAt: number;
	durationMs: number;
}

export function formatDuration(ms: number): string {
	const safeMs = Math.max(0, ms);
	if (safeMs < 1000) return `${Math.round(safeMs)}ms`;
	if (safeMs < 60_000) return `${(safeMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(safeMs / 60_000);
	return `${minutes}m ${Math.floor((safeMs % 60_000) / 1000)}s`;
}

export function formatClockTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function messageTiming(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const pendingAssistantTimestamps: number[] = [];

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (startedAt === undefined || !ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("muted", `⏱ working · ${formatDuration(Date.now() - startedAt)}`),
		);
	};

	pi.registerEntryRenderer<MessageTimestampData>(MESSAGE_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return new Text("");
		const label = data.role === "user" ? "You" : "Assistant";
		return new Text(theme.fg("dim", `${label} · ${formatClockTime(data.timestamp)}`), 1, 0);
	});

	pi.registerEntryRenderer<MessageTimingData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		return new Text(data ? theme.fg("dim", `took ${formatDuration(data.durationMs)}`) : "", 1, 0);
	});

	const appendTimestamp = (role: MessageTimestampData["role"], timestamp: number) => {
		pi.appendEntry<MessageTimestampData>(MESSAGE_ENTRY_TYPE, { role, timestamp });
	};

	// Pi emits extension message_end handlers before its interactive transcript
	// finalizes the streaming assistant component. Appending there therefore
	// places a custom entry above the assistant text. User messages do not stream,
	// so their label can be appended immediately; assistant labels wait for the
	// supported turn_end event, after message_end has reached the transcript.
	pi.on("message_end", (event) => {
		if (event.message.role === "user") {
			appendTimestamp("user", event.message.timestamp ?? Date.now());
		} else if (event.message.role === "assistant") {
			pendingAssistantTimestamps.push(event.message.timestamp ?? Date.now());
		}
	});

	pi.on("turn_end", () => {
		const timestamp = pendingAssistantTimestamps.shift();
		if (timestamp !== undefined) appendTimestamp("assistant", timestamp);
	});

	// Defensive fallback for an abnormal run that ends without turn_end.
	pi.on("agent_end", () => {
		while (pendingAssistantTimestamps.length > 0) {
			appendTimestamp("assistant", pendingAssistantTimestamps.shift()!);
		}
	});

	// agent_start may fire again for automatic retries. Keep the original start
	// until agent_settled so the displayed duration covers the complete task.
	pi.on("agent_start", (_event, ctx) => {
		if (startedAt !== undefined) return;
		startedAt = Date.now();
		updateStatus(ctx);
		if (ctx.hasUI) timer = setInterval(() => updateStatus(ctx), 1000);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined) return;
		const endedAt = Date.now();
		const timing: MessageTimingData = {
			startedAt,
			endedAt,
			durationMs: endedAt - startedAt,
		};
		startedAt = undefined;
		stopTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.appendEntry<MessageTimingData>(ENTRY_TYPE, timing);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		startedAt = undefined;
		pendingAssistantTimestamps.length = 0;
		stopTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
