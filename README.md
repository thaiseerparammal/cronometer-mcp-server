# Cronometer MCP Server

A personal [Model Context Protocol](https://modelcontextprotocol.io/) server that lets Claude read (and log) your [Cronometer](https://cronometer.com/) nutrition data. Built as a Cloudflare Worker with [Hono](https://hono.dev/) and the [`agents`](https://www.npmjs.com/package/agents) SDK — the same architecture as the companion Hevy and MyFitnessPal MCP servers.

> **Heads-up — this is unofficial.** Cronometer has no public API for individuals. This server talks to the same JSON REST API that Cronometer's own Android/Flutter app uses (`mobile.cronometer.com`), authenticating with *your* account email + password. It can break whenever Cronometer changes their app API, and automating their service may be against their Terms of Service. Use it for your own personal data only.

## Tools

| Tool | Description |
|------|-------------|
| `get_nutrition_diary` | Food diary for a date (default today): logged foods + daily calories/macros. |
| `get_nutrition_summary` | Aggregated daily totals over a date range, with overall and 7-day averages. |
| `get_goals` | Your current calorie and macro (protein/carb/fat) targets. |
| `search_food` | Search the Cronometer food database. |
| `log_food` | Log a food serving to a meal (breakfast/lunch/dinner/snacks). |

## How it works

```
Claude ──Bearer token──> Worker ──email+password──> mobile.cronometer.com/api/v2/login
                            │                          └── returns a session key
                            └── api/v2/* (auth block: { userId, token } in each request body)
```

1. You set your Cronometer **email + password** as Cloudflare secrets.
2. On first use the Worker logs in to `mobile.cronometer.com/api/v2/login` and caches the returned **session key** in memory.
3. Every data call carries that session in a JSON `auth` block. If the session is ever rejected, the Worker **re-logs-in automatically** — so it's effectively permanent with zero maintenance.

Access to the MCP endpoint itself is gated by a single static **`MCP_AUTH_TOKEN`** bearer token that Claude sends — appropriate for a single-user personal server.

## Deploy your own

Requires a [Cloudflare account](https://workers.cloudflare.com/) and `npm`.

```bash
# 1. Install
npm install

# 2. Copy the wrangler config (no per-account ids to fill in)
cp wrangler.example.jsonc wrangler.jsonc

# 3. Deploy
npx wrangler deploy

# 4. Set the secrets
echo "<your-mcp-auth-token>" | npx wrangler secret put MCP_AUTH_TOKEN   # openssl rand -hex 32
npx wrangler secret put CRONOMETER_EMAIL                                # your Cronometer email
npx wrangler secret put CRONOMETER_PASSWORD                             # your Cronometer password
```

There is **no web setup form** — your password never passes through a browser. Credentials live only as Cloudflare secrets (encrypted at rest) and are read by the Worker at runtime.

### Verify it works

Visit `https://<your-worker>.workers.dev/health?verify=1`. A successful response includes `"login_ok": true`.

## Connect from Claude

The MCP endpoint is `https://<your-worker>.workers.dev/mcp` (Streamable HTTP), authenticated with your bearer token.

**Claude Code:**
```bash
claude mcp add --transport http cronometer https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <your-mcp-auth-token>"
```

**Claude Desktop / claude.ai custom connector:** add a remote MCP server with the URL above and an `Authorization: Bearer <your-mcp-auth-token>` header.

## Verified vs. inferred

Because there is no official API, parts of this are reverse-engineered from the mobile app. Honest status:

| Piece | Status |
|-------|--------|
| `mobile.cronometer.com` reachable from a Cloudflare Worker (no bot-block) | ✅ Verified by live probing |
| `POST /api/v2/login` email+password → session key flow | ✅ Verified (clean JSON; dummy creds return a structured error) |
| `find_food`, `get_food`, `get_diary`, `get_nutrients`, `add_serving`, `get_macro_target_templates` paths | ⚠️ Reverse-engineered from the app — parsed defensively |
| Exact response field names for diary / nutrients / goals | ⚠️ Inferred — tune the parsers in `src/lib/transforms.ts` against the raw JSON |

Every tool includes the **raw API response** in its output, so even if a field name differs the data is still usable and easy to debug.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in MCP_AUTH_TOKEN + CRONOMETER_EMAIL + CRONOMETER_PASSWORD
npm run dev                      # wrangler dev on :8788
npm run type-check
```

## Project layout

```
src/
  index.ts            Worker entry (Hono app + Durable Object export)
  app.ts              Hono app: CORS, error handling, route mounting
  types.ts            Env / Props / Variables
  mcp-agent.ts        MyMCP (McpAgent) — the 5 nutrition tools
  mcp-handlers.ts     Streamable HTTP + SSE handlers
  middleware/auth.ts  Static bearer-token gate
  routes/
    mcp.ts            /mcp and /sse transport routes
    utility.ts        / and /health (login verification)
  lib/
    client.ts         CronometerClient: login + session + v2 API
    transforms.ts     Date validation + nutrition parsing/aggregation
    errors.ts         API error formatting
```

## License

MIT
