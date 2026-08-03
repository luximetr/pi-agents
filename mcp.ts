import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import https from "node:https";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { McpServerConfig } from "./agents.ts";

/** Separator between server name and tool name in the registered pi tool name. */
const TOOL_SEP = "__";

/**
 * Structural view of an MCP callTool result. The SDK's inferred return type
 * resolves its content members as `unknown` in some TS setups, so we type the
 * parts we actually forward instead of relying on it.
 */
interface McpCallToolResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * Minimal fetch() replacement that skips TLS certificate verification, for
 * insecure HTTP MCP servers (self-signed certs, e.g. on Tailscale IPs).
 * Buffers the whole response, which is fine for MCP tool traffic.
 */
async function insecureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
	const body = typeof init?.body === "string" || init?.body instanceof Uint8Array ? init.body : undefined;
	// The SDK passes a Headers instance; https.request needs a plain object.
	const headers: OutgoingHttpHeaders = {};
	if (init?.headers) {
		const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit);
		h.forEach((value, key) => {
			headers[key] = value;
		});
	}

	const response = await new Promise<{ status: number; statusText: string; headers: IncomingHttpHeaders; data: Buffer }>(
		(resolve, reject) => {
			const req = https.request(
				url,
				{
					method: init?.method ?? "GET",
					headers: headers,
					rejectUnauthorized: false,
					signal: init?.signal ?? undefined,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							statusText: res.statusMessage ?? "",
							headers: res.headers,
							data: Buffer.concat(chunks),
						}),
					);
				},
			);
			req.on("error", reject);
			if (body !== undefined) req.write(body as Buffer | string);
			req.end();
		},
	);

	return new Response(new Uint8Array(response.data), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers as HeadersInit,
	});
}

interface Connection {
	client: Client;
	transport: Transport;
	/** Prefixed pi tool names exposed by this server. */
	toolNames: string[];
}

/** Matches `${VAR}` env-var references in header values. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replace `${VAR}` references with values from the shell environment, falling
 * back to `.env`-loaded secrets. Unresolved names are collected in `missing`
 * (value is left untouched so the problem is visible).
 */
function resolveEnvRefs(value: string, missing: string[], env: Record<string, string>): string {
	return value.replace(ENV_REF, (match, name: string) => {
		const v = process.env[name] ?? env[name];
		if (v === undefined) {
			missing.push(name);
			return match;
		}
		return v;
	});
}

/**
 * Connects MCP stdio servers on demand (only when an agent requests them) and
 * registers their tools with pi under `<server>__<tool>` names. Connections are
 * cached across agent switches and closed on session shutdown.
 */
export class McpManager {
	private connections = new Map<string, Connection>();
	/** In-flight connect promises, to dedupe concurrent activation. */
	private pending = new Map<string, Promise<string[]>>();
	private stderr = new Map<string, string>();
	/** Unresolved ${VAR} env refs per server, warned once at activation. */
	private envWarnings = new Map<string, string[]>();
	private pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/**
	 * Connect the given servers (if not already connected) and return the
	 * prefixed tool names available for activation. Unknown server names and
	 * failed connections are reported via notify and skipped.
	 */
	async activate(
		serverNames: string[],
		servers: Record<string, McpServerConfig>,
		env: Record<string, string>,
		ctx: ExtensionContext,
		opts?: { silent?: boolean },
	): Promise<string[]> {
		const tools: string[] = [];
		for (const name of serverNames) {
			const cfg = servers[name];
			if (!cfg) {
				if (!opts?.silent) {
					ctx.ui.notify(`Agent: MCP server "${name}" is not defined in config.json mcpServers`, "warning");
				}
				continue;
			}
			try {
				tools.push(...(await this.connect(name, cfg, env)));
				const missing = this.envWarnings.get(name);
				if (missing && missing.length > 0) {
					if (!opts?.silent) {
						ctx.ui.notify(
							`MCP server "${name}": env var(s) not set: ${missing.join(", ")} (used in headers; set in shell or .pi-agents/.env)`,
							"warning",
						);
					}
					this.envWarnings.delete(name);
				}
			} catch (err) {
				if (!opts?.silent) ctx.ui.notify(`MCP server "${name}" failed to start: ${err}`, "error");
			}
		}
		return tools;
	}

	/** Connect a server once and register its tools; returns prefixed tool names. */
	private async connect(name: string, cfg: McpServerConfig, env: Record<string, string>): Promise<string[]> {
		const existing = this.connections.get(name);
		if (existing) return existing.toolNames;
		const inflight = this.pending.get(name);
		if (inflight) return inflight;

		const promise = this.doConnect(name, cfg, env);
		this.pending.set(name, promise);
		try {
			const toolNames = await promise;
			return toolNames;
		} finally {
			this.pending.delete(name);
		}
	}

	private async doConnect(name: string, cfg: McpServerConfig, env: Record<string, string>): Promise<string[]> {
		const client = new Client({ name: "pi-agents", version: "0.1.0" }, { capabilities: {} });
		const transport = cfg.url ? this.makeHttpTransport(name, cfg, env) : this.makeStdioTransport(name, cfg);

		try {
			await client.connect(transport);
			const { tools } = await client.listTools();
			const toolNames: string[] = [];
			for (const tool of tools) {
				const prefixed = `${name}${TOOL_SEP}${tool.name}`;
				if (!this.pi.getAllTools().some((t) => t.name === prefixed)) {
					this.registerTool(name, prefixed, tool);
				}
				toolNames.push(prefixed);
			}
			this.connections.set(name, { client, transport, toolNames });
			return toolNames;
		} catch (err) {
			try {
				await client.close();
			} catch {
				// already dead
			}
			const stderrLog = this.stderr.get(name);
			const detail = stderrLog ? ` — stderr: ${stderrLog.slice(-500)}` : "";
			throw new Error(`${err}${detail}`);
		}
	}

	/** Build a stdio transport (command/args/env/cwd). */
	private makeStdioTransport(name: string, cfg: McpServerConfig): StdioClientTransport {
		const transport = new StdioClientTransport({
			command: cfg.command ?? "",
			args: cfg.args,
			env: cfg.env,
			cwd: cfg.cwd,
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk: Buffer) => {
			this.stderr.set(name, (this.stderr.get(name) ?? "") + chunk.toString("utf-8"));
		});
		return transport;
	}

	/** Build a streamable HTTP transport (url/headers/insecure). */
	private makeHttpTransport(name: string, cfg: McpServerConfig, env: Record<string, string>): StreamableHTTPClientTransport {
		let url: URL;
		try {
			url = new URL(cfg.url!);
		} catch {
			throw new Error(`invalid URL "${cfg.url}"`);
		}

		const missing: string[] = [];
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(cfg.headers ?? {})) {
			headers[key] = resolveEnvRefs(value, missing, env);
		}
		if (missing.length > 0) this.envWarnings.set(name, missing);

		return new StreamableHTTPClientTransport(url, {
			requestInit: { headers },
			// Skip TLS verification for self-signed certs (insecure: true).
			fetch: cfg.insecure ? (insecureFetch as typeof fetch) : undefined,
		});
	}

	private registerTool(serverName: string, prefixedName: string, tool: { name: string; description?: string; inputSchema?: unknown }) {
		const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
		const description = tool.description?.trim() || `${serverName} MCP tool ${tool.name}`;
		const firstLine = description.split("\n")[0].trim();

		this.pi.registerTool({
			name: prefixedName,
			label: `${serverName}: ${tool.name}`,
			description: `${description}\n\n(provided by MCP server "${serverName}")`,
			promptSnippet: `${prefixedName}: ${firstLine.slice(0, 90)}`,
			parameters: jsonSchemaToTypeBox(schema),
			execute: async (_toolCallId, args, signal) => {
				const conn = this.connections.get(serverName);
				if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
				const result = (await conn.client.callTool(
					{ name: tool.name, arguments: args as Record<string, unknown> },
					undefined,
					{ signal },
				)) as McpCallToolResult;

				const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
				for (const part of result.content) {
					if (part.type === "text") {
						content.push({ type: "text", text: part.text ?? "" });
					} else if (part.type === "image" && part.data && part.mimeType) {
						content.push({ type: "image", data: part.data, mimeType: part.mimeType });
					} else {
						content.push({ type: "text", text: JSON.stringify(part) });
					}
				}
				if (result.structuredContent !== undefined) {
					content.push({ type: "text", text: `Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}` });
				}
				if (result.isError) {
					const message = content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n").trim();
					throw new Error(message || `MCP tool ${tool.name} failed (isError)`);
				}
				return { content, details: { server: serverName, tool: tool.name } };
			},
		});
	}

	/** Close all connections (kills server processes). Called on session shutdown. */
	async disconnectAll(): Promise<void> {
		const conns = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(conns.map((c) => c.client.close()));
	}
}

/**
 * Convert a JSON Schema (MCP tool input schema) into a TypeBox schema for
 * pi.registerTool. Supports the common subset: object/string/number/integer/
 * boolean/null/array, enums, and anyOf/oneOf. Unknown shapes become Type.Unknown.
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
	switch (schema.type) {
		case "string": {
			const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
			if (enumValues && enumValues.length > 0) return Type.Union(enumValues.map((v) => Type.Literal(v)));
			return Type.String();
		}
		case "number":
			return Type.Number();
		case "integer":
			return Type.Integer();
		case "boolean":
			return Type.Boolean();
		case "null":
			return Type.Null();
		case "array": {
			const items = schema.items as Record<string, unknown> | undefined;
			return Type.Array(items ? jsonSchemaToTypeBox(items) : Type.Unknown());
		}
		case "object": {
			const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
			const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
			const properties: Record<string, TSchema> = {};
			for (const [key, propSchema] of Object.entries(props)) {
				const ts = jsonSchemaToTypeBox(propSchema);
				properties[key] = required.has(key) ? ts : Type.Optional(ts);
			}
			// JSON Schema default is additionalProperties: true; only close the
			// object when the server explicitly asks for it.
			return Type.Object(properties, { additionalProperties: schema.additionalProperties === false ? false : true });
		}
		default: {
			if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
				return Type.Union(schema.anyOf.map((s) => jsonSchemaToTypeBox(s as Record<string, unknown>)));
			}
			if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
				return Type.Union(schema.oneOf.map((s) => jsonSchemaToTypeBox(s as Record<string, unknown>)));
			}
			if (Array.isArray(schema.enum) && schema.enum.length > 0) {
				return Type.Union(schema.enum.map((v) => Type.Literal(v)));
			}
			return Type.Unknown();
		}
	}
}
