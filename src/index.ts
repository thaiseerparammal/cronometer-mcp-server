import app from "./app.js";

export default app;

// Durable Object export required by the agents SDK / wrangler migration.
export { MyMCP } from "./mcp-agent.js";
