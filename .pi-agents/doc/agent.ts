import { Tools } from "../../agents";

export default {
	name: "doc",
	description: "Documentation agent: read-only built-ins + dochub MCP server for search and writes.",
	color: "#bf5af2",
	tools: [Tools.read, Tools.grep, Tools.ls, Tools.find],
	mcp: ["dochub"],
	// Agent-local server: only agent-doc can connect to it. Key comes from
	// .pi-agents/agent-doc/.env (gitignored) via ${DOCHUB_MCP_TOKEN}.
	mcpServers: {
		dochub: {
			url: "http://100.91.130.31:3001/mcp",
			headers: {
				Authorization: "Bearer ${DOCHUB_MCP_TOKEN}",
			},
		},
	},
	systemPromptFile: "./prompt.md",
};
