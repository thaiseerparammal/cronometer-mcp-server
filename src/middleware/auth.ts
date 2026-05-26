import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types.js";

/** Constant-time-ish string comparison to avoid trivial token timing leaks. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Static bearer-token auth. Accepts the token in either:
 *   - Authorization: Bearer <token>  header, OR
 *   - ?token=<token>                 query parameter
 *
 * The query-param form lets mcp-remote (Claude Desktop) connect without
 * needing --header support, using a URL like /mcp?token=<token>.
 */
export const bearerAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
	async (c, next) => {
		const expected = c.env.MCP_AUTH_TOKEN;

		// Extract token from header or query param
		const authHeader = c.req.header("Authorization");
		const queryToken = c.req.query("token");

		let token: string | undefined;
		if (authHeader?.startsWith("Bearer ")) {
			token = authHeader.substring(7);
		} else if (queryToken) {
			token = queryToken;
		}

		if (!token) {
			return c.json(
				{ error: "unauthorized", message: "Provide a Bearer token via Authorization header or ?token= query param." },
				401,
				{ "WWW-Authenticate": `Bearer realm="${c.req.url}", error="invalid_token"` },
			);
		}

		if (!expected || !safeEqual(token, expected)) {
			return c.json({ error: "unauthorized", message: "Invalid token." }, 401);
		}

		const url = new URL(c.req.url);
		c.set("props", { authenticated: true, baseUrl: `${url.protocol}//${url.host}` });

		await next();
	},
);
