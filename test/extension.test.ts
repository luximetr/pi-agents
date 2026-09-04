import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../index.ts";

async function makeAgent(root: string, name: string, extra = "") {
	await mkdir(path.join(root, ".pi-agents", name), { recursive: true });
	await writeFile(
		path.join(root, ".pi-agents", name, "agent.ts"),
		`export default { name: ${JSON.stringify(name)}, description: ${JSON.stringify(name)}, tools: ["read"], ${extra} };\n`,
	);
}

function boot(root: string, options?: { flag?: string; sessionFile?: string; trusted?: boolean }) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const activeToolsets: string[][] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const tools = new Map<string, any>([
		["read", { name: "read" }],
		["bash", { name: "bash" }],
		["delegate", { name: "delegate" }],
	]);
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerFlag: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getFlag: () => options?.flag,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => ["read", "bash"],
		setActiveTools: (names: string[]) => activeToolsets.push([...names]),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	extension(pi);
	const ctx: any = {
		cwd: root,
		isProjectTrusted: () => options?.trusted ?? true,
		sessionManager: { getSessionFile: () => options?.sessionFile },
		ui: {
			theme: { fg: (_role: string, text: string) => text, getColorMode: () => "truecolor" },
			setStatus: () => {},
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	return { handlers, commands, activeToolsets, notifications, entries, tools, ctx };
}

test("session startup activates config.defaultAgent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-default-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["read"]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "beta" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("--agent takes precedence over the configured default", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-flag-"));
	try {
		await makeAgent(root, "alpha");
		await makeAgent(root, "beta");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "beta" }));
		const runtime = boot(root, { flag: "alpha" });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: "alpha" } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a persisted plain-pi selection suppresses configured defaults", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-persisted-none-"));
	try {
		await makeAgent(root, "alpha");
		await writeFile(path.join(root, ".pi-agents", "config.json"), JSON.stringify({ defaultAgent: "alpha" }));
		const sessionFile = path.join(root, "session.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: "pi-agents-state", data: { name: null } })}\n`);
		const runtime = boot(root, { sessionFile });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, []);
		assert.deepEqual(runtime.entries, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("untrusted projects do not load or activate project agents", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-untrusted-runtime-"));
	try {
		await makeAgent(root, "project-agent", "default: true");
		const runtime = boot(root, { trusted: false });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, []);
		assert.ok(runtime.notifications.some((entry) => entry.level === "warning" && /not trusted/.test(entry.message)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent custom tools are registered, activated, and wrap string results", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-custom-tool-"));
	try {
		await mkdir(path.join(root, ".pi-agents", "custom"), { recursive: true });
		await writeFile(path.join(root, ".pi-agents", "custom", "agent.ts"), `
			export default {
				name: "custom", description: "custom", default: true, tools: [],
				customTools: {
					ping: { description: "Return a pong", execute: async (args) => "pong:" + args.value }
				}
			};
		`);
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		assert.deepEqual(runtime.activeToolsets.at(-1), ["ping"]);
		const result = await runtime.tools.get("ping").execute("ping-1", { value: "ok" }, undefined, undefined, runtime.ctx);
		assert.deepEqual(result, { content: [{ type: "text", text: "pong:ok" }], details: {} });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/agent none restores the toolset captured before activation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-clear-"));
	try {
		await makeAgent(root, "alpha", "default: true");
		const runtime = boot(root);
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		await runtime.commands.get("agent").handler("none", runtime.ctx);
		assert.deepEqual(runtime.activeToolsets, [["read"], ["read", "bash"]]);
		assert.deepEqual(runtime.entries.at(-1), { customType: "pi-agents-state", data: { name: null } });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
