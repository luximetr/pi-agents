import { createServer } from "node:http";

/** Real HTTP/JSON-RPC server enforcing bearer auth on every MCP request. */
export async function startAuthenticatedMcp() {
	let token = "first-token";
	const requests: Array<{ authorization?: string; method?: string }> = [];
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const message = raw ? JSON.parse(raw) : undefined;
		requests.push({ authorization: req.headers.authorization, method: message?.method });
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(403).end("Invalid credential");
			return;
		}
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		if (message.id === undefined) { res.writeHead(202).end(); return; }
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "auth-test", version: "1" } };
				break;
			case "tools/list":
				result = { tools: [{ name: "echo", description: "Authenticated echo", inputSchema: { type: "object", properties: {} } }] };
				break;
			case "tools/call":
				result = { content: [{ type: "text", text: "authenticated" }] };
				break;
			default: result = {};
		}
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${address.port}/mcp`, requests,
		setToken(value: string) { token = value; },
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		},
	};
}
