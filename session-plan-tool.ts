import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jsonSchemaToTypeBox } from "./mcp.ts";
import type { SessionCoordination } from "./session-coordination.ts";

export const SESSION_PLAN_TOOL = "session_plan";

/** Plain-word guidance for the optional task list. */
export const COORDINATION_GUIDE = `session_plan keeps a short, high-level task list for longer work.
- Create a task only for genuinely new work; one task per outcome.
- Add a few items per task. Keep titles and item text to one short line.
- Update an item only when its progress changes: in_progress, completed, dropped.
- Do not rewrite tasks or add notes when nothing changed.
- Pass taskId (and itemId when it fits) to delegate so runs are tied to the right item.
- Reports arrive on their own. Reading a report does not handle it; mark it handled or deferred once you have dealt with it.
- A task completes by itself when all items are done and all reports are handled.`;

const string = { type: "string" };
const item = {
	type: "object", properties: {
		id: string, text: string, owner: string,
		status: { type: "string", enum: ["pending", "in_progress", "completed", "dropped"] },
		dependsOn: { type: "array", items: string },
	}, required: ["text"], additionalProperties: false,
};

export function sessionPlanTool(getStore: () => SessionCoordination, changed: () => void): ToolDefinition {
	const tool: ToolDefinition = {
		name: SESSION_PLAN_TOOL,
		label: "Task list",
		description: "Keep a short task list for longer work. Items move through pending, in_progress, completed, dropped. Reports from workers are marked handled or deferred; reading a report does not handle it.",
		promptSnippet: "session_plan: optional short task list",
		parameters: jsonSchemaToTypeBox({
			type: "object", properties: {
				action: { type: "string", enum: ["list", "inspect", "create", "update", "add_item", "update_item", "result", "handle_result"] },
				taskId: string, itemId: string, runId: string,
				title: string, objective: string, owner: string, text: string, note: string,
				status: { type: "string", enum: ["active", "blocked", "completed", "dropped", "pending", "in_progress"] },
				handling: { type: "string", enum: ["new", "handled", "deferred"] },
				dependsOn: { type: "array", items: string }, items: { type: "array", items: item },
			}, required: ["action"], additionalProperties: false,
		}),
		execute: async (_id, params) => {
			const store = getStore();
			const p = params as Record<string, any>;
			const required = (key: string): string => {
				if (typeof p[key] !== "string" || !p[key].trim()) throw new Error(`${p.action} requires ${key}.`);
				return p[key];
			};
			const fields = (...keys: string[]) => Object.fromEntries(keys.filter(key => p[key] !== undefined).map(key => [key, p[key]]));
			let value: unknown;
			switch (p.action) {
				case "list": value = store.contextDigest(); break;
				case "inspect": {
					const state = store.snapshot();
					value = p.taskId ? state.tasks.find(task => task.id === p.taskId) : { ...state, results: state.results.map(({ text: _report, ...metadata }) => metadata) };
					if (!value) throw new Error("Unknown task ID.");
					break;
				}
				case "create": value = store.createTask({ ...fields("objective", "owner", "items"), title: required("title") }); break;
				case "update": value = store.updateTask(required("taskId"), fields("title", "objective", "owner", "status")); break;
				case "add_item": value = store.addItem(required("taskId"), { ...fields("owner", "status", "dependsOn"), text: required("text") }); break;
				case "update_item": value = store.updateItem(required("taskId"), required("itemId"), fields("text", "owner", "status", "dependsOn")); break;
				case "result": {
					value = store.snapshot().results.find(result => result.runId === required("runId"));
					if (!value) throw new Error("No saved report for that run ID.");
					break;
				}
				case "handle_result": {
					const result = store.handleResult(required("runId"), required("handling") as Parameters<SessionCoordination["handleResult"]>[1], p.note);
					value = { runId: result.runId, taskId: result.taskId, itemId: result.itemId, handling: result.handling, executionStatus: result.executionStatus, note: result.note };
					break;
				}
				default: throw new Error(`Unknown session_plan action: ${p.action}`);
			}
			changed();
			return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? { ok: true }) }], details: {} };
		},
	};
	// Opt-in: newer Pi versions read `defaultActive` and keep the tool inactive on
	// registration. Older versions ignore the unknown property; the active set is
	// re-scoped per agent, which keeps the same behavior there.
	(tool as ToolDefinition & { defaultActive?: boolean }).defaultActive = false;
	return tool;
}
