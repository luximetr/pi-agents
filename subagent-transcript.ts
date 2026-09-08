/** Display-only history: never injected into the parent model's context. */
export interface TranscriptEntry {
	id: string;
	kind: "user" | "assistant" | "tool" | "event";
	text: string;
	title?: string;
	output?: string;
	status?: "running" | "finished" | "failed";
}

export const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_ENTRY_CHARS = 16_000;
const MAX_ENTRIES = 400;

export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
}

function bounded(text: string): string {
	return text.length > MAX_ENTRY_CHARS ? `[Earlier content omitted]\n${text.slice(-MAX_ENTRY_CHARS)}` : text;
}

/** RPC tool updates are cumulative; replace them rather than appending duplicates. */
export class SubagentTranscript {
	private entries: TranscriptEntry[] = [];
	private serial = 0;
	private assistantId?: string;
	truncated = false;

	constructor(task: string) { this.add("user", task); }

	private trim() {
		let size = this.entries.reduce((sum, entry) => sum + entry.text.length + (entry.output?.length ?? 0) + (entry.title?.length ?? 0), 0);
		while (this.entries.length > MAX_ENTRIES || (size > MAX_TRANSCRIPT_CHARS && this.entries.length > 1)) {
			const removed = this.entries.shift()!;
			size -= removed.text.length + (removed.output?.length ?? 0) + (removed.title?.length ?? 0);
			this.truncated = true;
		}
	}

	add(kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
		const entry: TranscriptEntry = { id: `entry-${++this.serial}`, kind, text: bounded(text) };
		this.entries.push(entry);
		this.trim();
		return entry;
	}

	snapshot(): TranscriptEntry[] { return this.entries.map(entry => ({ ...entry })); }

	consume(event: Record<string, unknown>) {
		const message = event.message as { role?: string } | undefined;
		if (event.type === "message_start" && message?.role === "assistant") this.assistantId = undefined;
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") {
				let entry = this.entries.find(item => item.id === this.assistantId);
				if (!entry) { entry = this.add("assistant", ""); this.assistantId = entry.id; }
				entry.text = bounded(entry.text + delta.delta);
			}
		}
		if (event.type === "message_end" && (message?.role === "assistant" || message?.role === undefined)) {
			const text = messageText(message);
			if (text) {
				const entry = this.entries.find(item => item.id === this.assistantId);
				if (entry) entry.text = bounded(text);
				else this.add("assistant", text);
			}
			this.assistantId = undefined;
		}
		if (event.type === "message_end" && message?.role === "user") {
			const text = messageText(message);
			// The initial task is already recorded before the first RPC event arrives.
			if (text && !(this.entries.length === 1 && this.entries[0].text === bounded(text))) this.add("user", text);
		}
		if (typeof event.type === "string" && event.type.startsWith("tool_execution_")) {
			const id = `tool:${String(event.toolCallId ?? event.toolName ?? "unknown")}`;
			let entry = this.entries.find(item => item.id === id);
			if (!entry) {
				entry = this.add("tool", "");
				entry.id = id;
				entry.title = bounded(String(event.toolName ?? "tool"));
				entry.status = "running";
			}
			if (event.args !== undefined) entry.text = bounded(JSON.stringify(event.args, null, 2));
			if (event.type === "tool_execution_update") entry.output = bounded(messageText(event.partialResult));
			if (event.type === "tool_execution_end") {
				if (event.result !== undefined) entry.output = bounded(messageText(event.result));
				entry.status = event.isError ? "failed" : "finished";
			}
		}
		this.trim();
	}
}
