import { MyMCP } from "./mcp-agent.js";

export const mcpHandlers = {
	streamableHTTP: MyMCP.serve("/mcp", { binding: "MCP_OBJECT" }),
	sse: MyMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }),
};
