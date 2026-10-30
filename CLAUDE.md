# CLAUDE.md

Read-only Mercado Bitcoin MCP server on Cloudflare Workers.

## Commands

- `npm test` — vitest
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — `wrangler dev`
- `npm run deploy` — `wrangler deploy` (Workers Builds runs this on main; do not deploy from a cloud agent)
- `npx wrangler deploy --dry-run` — bundle check only

## Architecture

```text
src/
├── index.ts              Worker fetch handler. Exports AuthRateLimit and RequestRateLimit
├── http.ts               GET /health and POST /mcp
├── auth-gate.ts          Bearer MCP_AUTH_TOKEN check and per-IP lockout
├── auth-rate-limit.ts    SQLite Durable Object for auth-failure lockouts
├── request-rate-limit.ts SQLite Durable Object for MCP and upstream quotas
├── mcp.ts              Stateless Streamable HTTP transport
├── server.ts           Registers every read tool
├── auth.ts             OAuth2 client_credentials token cache (isolate memory)
├── client.ts           GET-only Mercado Bitcoin API client
├── paths.ts            Path-parameter validation and encoding
└── tools/              public, account, trading (list/get only), wallet (reads only)
```

The server is strictly read-only. Do not add POST or DELETE client methods, order placement, cancellation, withdrawals, transfers, or account creation. The only outbound POST is the hardcoded OAuth token URL in `auth.ts`.

`MB_API_KEY`, `MB_API_SECRET`, and `MCP_AUTH_TOKEN` are Worker secrets. Never log, return, or commit them, or the access token.

On Workers, call `fetch` as a free function (`httpFetch` in `src/http-fetch.ts`). Do not invoke it as a method of another object.
