import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpManager, mcpToolName } from "../mcp.ts";

function mockPi() {
	const tools = new Map<string, any>();
	const registrations: string[] = [];
	return {
		tools,
		registrations,
		pi: {
			getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name })),
			registerTool: (tool: any) => {
				registrations.push(tool.name);
				tools.set(tool.name, tool);
			},
		} as any,
	};
}

function mockContext() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any,
	};
}

async function writeFakeMcpServer(root: string): Promise<string> {
	const file = path.join(root, "fake-mcp.mjs");
	await writeFile(file, `#!/usr/bin/env node
const variant = process.argv[2] || "first";
const toolNames = JSON.parse(process.argv[3] || '["echo"]');
let buffer = "";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" }
      });
    } else if (request.method === "tools/list") {
      const field = variant === "first" ? "text" : "count";
      const type = variant === "first" ? "string" : "integer";
      send(request.id, { tools: toolNames.map(name => ({
        name,
        description: variant + " echo",
        inputSchema: {
          type: "object",
          properties: { [field]: { type } },
          required: [field],
          additionalProperties: false
        }
      })) });
    } else if (request.method === "tools/call") {
      send(request.id, {
        content: [{ type: "text", text: variant + ":" + JSON.stringify(request.params.arguments) }],
        structuredContent: { variant, toolName: request.params.name }
      });
    }
  }
});
`);
	await chmod(file, 0o755);
	return file;
}

test("MCP connection probes discover stdio tools without registering or activating them", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-probe-"));
	const { pi, tools, registrations } = mockPi();
	const manager = new McpManager(pi);
	try {
		const server = await writeFakeMcpServer(root);
		assert.deepEqual(await manager.testConnection("probe", { command: process.execPath, args: [server] }, {}), { ok: true, toolCount: 1 });
		assert.equal(tools.size, 0);
		assert.deepEqual(registrations, []);
		assert.deepEqual(manager.getStatuses(), {});
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP connection probes time out and terminate an unresponsive stdio server", async () => {
	const { pi } = mockPi();
	const manager = new McpManager(pi);
	const start = Date.now();
	const result = await manager.testConnection("stalled", {
		command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
	}, {}, 100);
	assert.deepEqual(result, { ok: false, reason: "Connection test timed out." });
	assert.ok(Date.now() - start < 5000);
	assert.deepEqual(manager.getStatuses(), {});
});

test("MCP stdio activation registers namespaced tools and forwards calls", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-"));
	const { pi, tools } = mockPi();
	const { ctx, notifications } = mockContext();
	const manager = new McpManager(pi);
	try {
		const server = await writeFakeMcpServer(root);
		const names = await manager.activate(
			["local", "missing"],
			{ local: { command: process.execPath, args: [server, "first"] } },
			{},
			ctx,
		);
		assert.deepEqual(names, ["local__echo"]);
		assert.match(notifications[0]?.message ?? "", /not defined/);
		assert.deepEqual(manager.getStatuses(["local"]).local, {
			state: "connected",
			toolNames: ["local__echo"],
			error: undefined,
		});

		const tool = tools.get("local__echo");
		assert.ok(tool);
		assert.match(tool.description, /first echo/);
		const result = await tool.execute("call-1", { text: "hello" }, new AbortController().signal);
		assert.equal(result.content[0].text, 'first:{"text":"hello"}');
		assert.match(result.content[1].text, /"variant": "first"/);
		assert.deepEqual(result.details, { server: "local", tool: "echo" });
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP disconnect deactivates previously registered tool executions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-disconnect-"));
	const { pi, tools } = mockPi();
	const { ctx } = mockContext();
	const manager = new McpManager(pi);
	try {
		const server = await writeFakeMcpServer(root);
		await manager.activate(["local"], { local: { command: process.execPath, args: [server, "first"] } }, {}, ctx);
		const tool = tools.get("local__echo");
		await manager.disconnectAll();
		assert.deepEqual(manager.getStatuses(["local"]).local, {
			state: "disconnected",
			toolNames: ["local__echo"],
			error: undefined,
		});
		await assert.rejects(
			tool.execute("call-2", { text: "hello" }, new AbortController().signal),
			/not connected/,
		);
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP reconnect refreshes a same-named tool's schema and metadata", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-refresh-"));
	const { pi, tools, registrations } = mockPi();
	const { ctx } = mockContext();
	const manager = new McpManager(pi);
	try {
		const server = await writeFakeMcpServer(root);
		await manager.activate(["local"], { local: { command: process.execPath, args: [server, "first"] } }, {}, ctx);
		await manager.disconnectAll();
		await manager.activate(["local"], { local: { command: process.execPath, args: [server, "second"] } }, {}, ctx);

		assert.equal(registrations.filter((name) => name === "local__echo").length, 2);
		const refreshed = tools.get("local__echo");
		assert.match(refreshed.description, /second echo/);
		assert.ok("count" in refreshed.parameters.properties);
		assert.equal("text" in refreshed.parameters.properties, false);
		const result = await refreshed.execute("call-3", { count: 2 }, new AbortController().signal);
		assert.equal(result.content[0].text, 'second:{"count":2}');
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP aliases are safe, bounded, stable, and distinguish normalized names", () => {
	assert.equal(mcpToolName("playwright", "browser_navigate"), "playwright__browser_navigate");
	assert.equal(mcpToolName("Server-1", "Tool_2"), "Server-1__Tool_2");
	const pairs = [
		["pen.dev", "get.editor/state"], ["pen_dev", "get.editor/state"],
		["pen.dev", "get_editor_state"], ["pen_dev", "get_editor_state"],
		["设计", "read file"], ["s".repeat(80), "t".repeat(80)],
		["s".repeat(80), "t".repeat(79) + "x"],
	];
	const names = pairs.map(([server, tool]) => mcpToolName(server, tool));
	assert.equal(new Set(names).size, pairs.length);
	names.forEach((name, i) => {
		assert.match(name, /^[a-zA-Z0-9_-]+$/);
		assert.ok(name.length <= 64);
		assert.equal(name, mcpToolName(pairs[i][0], pairs[i][1]));
	});
});

test("MCP aliases forward original names and remain stable across reconnects", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-alias-"));
	const { pi, tools } = mockPi();
	const { ctx, notifications } = mockContext();
	const manager = new McpManager(pi);
	try {
		const server = await writeFakeMcpServer(root);
		const originals = ["get.editor/state", "get_editor_state", "echo"];
		const config = { "pen.dev": { command: process.execPath, args: [server, "first", JSON.stringify(originals)] } };
		const names = await manager.activate(["pen.dev"], config, {}, ctx);
		assert.deepEqual(names, originals.map(name => mcpToolName("pen.dev", name)));
		for (const [i, name] of names.entries()) {
			const tool = tools.get(name);
			assert.equal(tool.label, `pen.dev: ${originals[i]}`);
			const result = await tool.execute("alias-call", { text: "hello" }, new AbortController().signal);
			assert.equal(JSON.parse(result.content[1].text.replace("Structured content:\n", "")).toolName, originals[i]);
			assert.deepEqual(result.details, { server: "pen.dev", tool: originals[i] });
		}
		await manager.disconnectAll();
		assert.deepEqual(await manager.activate(["pen.dev"], config, {}, ctx), names);
		assert.deepEqual(notifications, []);
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP refuses alias collisions with unrelated tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-agents-mcp-collision-"));
	const { pi, tools } = mockPi();
	const { ctx, notifications } = mockContext();
	const manager = new McpManager(pi);
	const name = mcpToolName("pen.dev", "echo");
	const foreign = { name };
	tools.set(name, foreign);
	try {
		const server = await writeFakeMcpServer(root);
		const names = await manager.activate(["pen.dev"], {
			"pen.dev": { command: process.execPath, args: [server] },
		}, {}, ctx);
		assert.deepEqual(names, []);
		assert.equal(tools.get(name), foreign);
		assert.equal(manager.getStatuses(["pen.dev"])["pen.dev"].state, "failed");
		assert.ok(notifications.some(entry => /name collision/.test(entry.message)));
	} finally {
		await manager.disconnectAll();
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP startup failures notify the user and leave the agent usable", async () => {
	const { pi } = mockPi();
	const { ctx, notifications } = mockContext();
	const manager = new McpManager(pi);
	try {
		const names = await manager.activate(
			["broken"],
			{ broken: { command: path.join(os.tmpdir(), "pi-agents-command-that-does-not-exist") } },
			{},
			ctx,
		);
		assert.deepEqual(names, []);
		assert.ok(notifications.some((entry) => entry.level === "error" && /failed to start/.test(entry.message)));
	} finally {
		await manager.disconnectAll();
	}
});
