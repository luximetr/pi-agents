export default {
	name: "agent-doc",
	description: "Documentation agent, MCP only: works exclusively through its own local MCP server (local__* tools).",
	tools: [], // no built-in tools — MCP server tools only
	mcp: ["dochub"],
	// Agent-local server: only agent-doc can connect to it. Key comes from
	// .pi-agents/agent-doc/.env (gitignored) via ${DOC_MCP_TOKEN}.
	mcpServers: {
		dochub: {
			url: "http://100.91.130.31:3001/mcp",
			headers: {
				Authorization: "Bearer ${DOC_MCP_TOKEN}",
			},
		},
	},
	systemPromptFile: "./prompt.md",
};
