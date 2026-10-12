import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.trim().split("\n")[0]!.replace(/\s+/g, " ");

/** `action` stays bare; other primitives become `key=value`; arrays collapse to `key=[n]`. */
export function summarizeArgs(args: unknown, maxTotal = 100): string {
	if (!args || typeof args !== "object") return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		let shown: string | undefined;
		if (typeof value === "string") shown = oneLine(value);
		else if (typeof value === "number" || typeof value === "boolean") shown = String(value);
		else if (Array.isArray(value)) shown = `[${value.length}]`;
		if (!shown) continue;
		parts.push(key === "action" ? clip(shown, 40) : `${key}=${clip(shown, 40)}`);
	}
	return clip(parts.join(" "), maxTotal);
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map(part => (part.type === "text" ? part.text ?? "" : "[image]")).join("\n");
}

/**
 * Compact renderers for extension tools: one call line; collapsed results show
 * nothing on success and a single line on error; expanding (Ctrl+O) shows the
 * full output.
 */
export function compactToolRenderers(title: string, summarize: (args: unknown) => string = summarizeArgs) {
	return {
		/** "self": no padded, coloured shell box around the call line (Pi's default for read/bash/etc.). */
		renderShell: "self" as const,
		renderCall(args: unknown, theme: Theme) {
			const summary = summarize(args);
			return new Text(theme.fg("toolTitle", theme.bold(title)) + (summary ? theme.fg("muted", ` ${summary}`) : ""), 0, 0);
		},
		renderResult(
			result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
			options: { expanded: boolean; isPartial?: boolean },
			theme: Theme,
			context?: { isError?: boolean },
		) {
			if (options.isPartial) return new Container();
			const text = resultText(result).trim();
			const failed = context?.isError ?? result.isError ?? false;
			if (options.expanded && text) return new Text(theme.fg(failed ? "error" : "toolOutput", text), 0, 0);
			if (failed) return new Text(theme.fg("error", clip(oneLine(text || "failed"), 120)), 0, 0);
			return new Container();
		},
	};
}
