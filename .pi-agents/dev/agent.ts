export default {
	name: "dev",
	description: "Implementation agent: focused changes, tests, tight scope.",
	color: "#30d158",
	tools: ["read","write","edit","bash","grep","find","ls"],
	subagents: [{ name: "dev-worker", model: "openai-codex/gpt-5.6-sol:medium" }],
	systemPromptFile: "./prompt.md",
	mcp: ["taskhub"],
	mcpServers: {"taskhub":{"url":"https://taskhub.phoenixchumphon.com/mcp","headers":{"Authorization":"Bearer ${TASKHUB_TOKEN}"}}},
};
