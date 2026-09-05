import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DeclarativeAgentInput } from "./agents.ts";
import { assistAgentField, type AssistanceContext } from "./studio-assistance.ts";
import { AGENT_FIELD_LABELS, AgentField, FieldEditorAction } from "./studio-menu.ts";

/** Manual editing and AI suggestions share one field-local draft; Escape discards all changes. */
export async function editAgentField(
	ctx: ExtensionContext,
	field: AgentField,
	current: DeclarativeAgentInput,
	available: AssistanceContext,
): Promise<string | undefined> {
	const title = `${AGENT_FIELD_LABELS[field]} · ${current.name}`;
	const initial = current[field] ?? "";
	if (ctx.mode !== "tui") return ctx.ui.editor(title, initial);

	let editor: Editor | undefined;
	let beforeSuggestion: string | undefined;
	while (true) {
		const action = await ctx.ui.custom<FieldEditorAction>((tui, theme, _kb, done) => {
			if (!editor) {
				editor = new Editor(tui, {
					borderColor: text => theme.fg("borderAccent", text),
					selectList: {
						selectedPrefix: text => theme.fg("accent", text),
						selectedText: text => theme.fg("accent", text),
						description: text => theme.fg("muted", text),
						scrollInfo: text => theme.fg("dim", text),
						noMatch: text => theme.fg("warning", text),
					},
				});
				editor.disableSubmit = true;
				editor.setText(initial);
			}
			const input = editor;
			return {
				get focused() { return input.focused; },
				set focused(value: boolean) { input.focused = value; },
				render(width: number) {
					return [
						theme.fg("accent", theme.bold(title)),
						...input.render(Math.max(4, width)),
						...(beforeSuggestion === undefined ? [] : [theme.fg("warning", "AI suggestion · review/edit before saving · F3 restores pre-AI text")]),
						theme.fg("dim", "Enter/Ctrl+S save · Shift+Enter newline · F2 AI assistance · Esc cancel"),
					].map(line => truncateToWidth(line, width));
				},
				invalidate() { input.invalidate(); },
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done(FieldEditorAction.Cancel);
					else if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) done(FieldEditorAction.Save);
					else if (matchesKey(data, Key.f2)) done(FieldEditorAction.Assist);
					else if (matchesKey(data, Key.f3) && beforeSuggestion !== undefined) {
						input.setText(beforeSuggestion);
						beforeSuggestion = undefined;
					} else input.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!action || action === FieldEditorAction.Cancel || !editor) return undefined;
		const text = editor.getExpandedText();
		if (action === FieldEditorAction.Save) {
			if (field === AgentField.Description && !text.trim()) {
				ctx.ui.notify("A description is required.", "warning");
				continue;
			}
			return text;
		}
		const suggestion = await assistAgentField(ctx, field, { ...current, [field]: text }, available);
		if (suggestion !== undefined) {
			beforeSuggestion = text;
			editor.setText(suggestion);
		}
	}
}
