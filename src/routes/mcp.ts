import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth.js";
import type { Env, Variables } from "../types.js";

/**
 * MCP transport routes. Mirrors the Hevy server: forward the raw request to the
 * agents SDK handler after attaching auth props to the execution context.
 */
export function createMcpRoutes(mcpHandlers: {
	streamableHTTP: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };
	sse: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };
}) {
	const mcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

	const forward = (handler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }) =>
		async (c: any) => {
			const props = c.get("props");
			const ctx = c.executionCtx as any;
			ctx.props = props;
			return handler.fetch(c.req.raw, c.env, ctx);
		};

	mcpRoutes.all("/mcp/*", bearerAuth, forward(mcpHandlers.streamableHTTP));
	mcpRoutes.all("/mcp", bearerAuth, forward(mcpHandlers.streamableHTTP));
	mcpRoutes.all("/sse/*", bearerAuth, forward(mcpHandlers.sse));
	mcpRoutes.all("/sse", bearerAuth, forward(mcpHandlers.sse));

	return mcpRoutes;
}
