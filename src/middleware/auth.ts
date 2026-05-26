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
 * Static bearer-token auth. The MCP client must send
 * `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 */
export const bearerAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
	async (c, next) => {
		const authHeader = c.req.header("Authorization");

		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			return c.json(
				{ error: "unauthorized", message: "Provide a valid Bearer token." },
				401,
				{ "WWW-Authenticate": `Bearer realm="${c.req.url}", error="invalid_token"` },
			);
		}

		const token = authHeader.substring(7);
		const expected = c.env.MCP_AUTH_TOKEN;

		if (!expected || !safeEqual(token, expected)) {
			return c.json({ error: "unauthorized", message: "Invalid token." }, 401);
		}

		const url = new URL(c.req.url);
		c.set("props", { authenticated: true, baseUrl: `${url.protocol}//${url.host}` });

		await next();
	},
);
