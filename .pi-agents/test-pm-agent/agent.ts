export default {
	"name": "test-pm-agent",
	"description": "Project manager",
	"tools": ["read","write","edit","bash","grep","find","ls"],
	"mcp": [],
	"systemPromptFile": "./prompt.md",
	color: "#ff9f0a",
	subagents: [{ name: "test-dev-agent", model: "openai-codex/gpt-6-luna:max" }],
};
