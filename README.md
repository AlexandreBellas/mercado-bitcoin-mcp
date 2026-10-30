# mercado-bitcoin-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the [Mercado Bitcoin](https://www.mercadobitcoin.com.br) API v4. It runs on Cloudflare Workers (free plan) and exposes market data and account reads. It cannot place orders, cancel orders, transfer funds, create accounts, or withdraw.

## Endpoint

1. `GET /health` returns `{ "status": "ok" }`.
2. `POST /mcp` is the stateless Streamable HTTP MCP endpoint.
3. Every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
4. A missing or wrong token gets `401` with a JSON-RPC error body.
5. Repeated failures from the same client IP are locked out (`429`) by a SQLite Durable Object.
6. Authenticated `/mcp` requests are limited to 60 per minute for that bearer token and 600 per minute for the whole Worker. The limit returns `429` with `Retry-After` and does not call Mercado Bitcoin. `GET /health` is not limited.

## Secrets

Set these as Worker secrets. Do not put the values in the repo, in `wrangler.jsonc`, or in git.

| Secret | Role |
| --- | --- |
| `MB_API_KEY` | Mercado Bitcoin API key id. Sent as OAuth `client_id`. |
| `MB_API_SECRET` | Mercado Bitcoin API secret. Sent as OAuth `client_secret`. |
| `MCP_AUTH_TOKEN` | Bearer token your MCP client must present. The Worker compares it in constant time. |

The Worker refuses `/mcp` when `MCP_AUTH_TOKEN` is missing. The access token from Mercado Bitcoin is cached in isolate memory and is never logged or returned.

Optional plain vars (already in `wrangler.jsonc`, not secrets): `AUTH_FAILURE_LIMIT` (10), `AUTH_FAILURE_WINDOW_SECONDS` (900), `AUTH_LOCKOUT_SECONDS` (1800), `RATE_LIMIT_PER_MINUTE` (60), `RATE_LIMIT_GLOBAL_PER_MINUTE` (600), `MB_PUBLIC_PER_SECOND` (1), `MB_PRIVATE_PER_SECOND` (3).

```bash
npx wrangler secret put MB_API_KEY
npx wrangler secret put MB_API_SECRET
npx wrangler secret put MCP_AUTH_TOKEN
```

For local `npm run dev`, copy `.dev.vars.example` to `.dev.vars` and fill the same three names. `.dev.vars` is gitignored.

## Read-only Mercado Bitcoin key

Create a key with the **Leitura** permission only.

1. Sign in to [Mercado Bitcoin](https://www.mercadobitcoin.com.br) on the web.
2. Open your profile, then **Configurações**.
3. Under **Integração**, open **Chaves API**.
4. Choose **Nova Chave**, name it, and set the permission to **Leitura**.
5. Confirm with 2FA.
6. Copy the API key id into `MB_API_KEY` and the secret into `MB_API_SECRET`.

The secret is shown once. Do not grant trade or withdrawal permission. This server has no write tools, and a Leitura key is a second barrier.

## Client configuration

Point a remote MCP client at `https://<your-worker>.workers.dev/mcp` and send the bearer token:

```json
{
  "mcpServers": {
    "mercado-bitcoin": {
      "url": "https://mercado-bitcoin-mcp.<account>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

## Tools

All 25 tools are registered in every deployment. Each one is read-only.

| Tool | What it reads |
| --- | --- |
| `mb_status` | Whether Mercado Bitcoin credentials are configured. No secrets and no balances. |
| `mb_get_orderbook` | Order book for one pair. |
| `mb_get_trades` | Recent trades for one pair. |
| `mb_get_symbols` | Trading pairs and metadata. |
| `mb_get_tickers` | Last, bid, ask, high, low, open, and 24h volume. |
| `mb_get_candles` | OHLCV candles. |
| `mb_get_asset_fees` | Public deposit and withdrawal fees. |
| `mb_get_asset_networks` | Networks for one asset. |
| `mb_list_accounts` | Your account ids. |
| `mb_get_balances` | Balances for one account. |
| `mb_get_tier` | Fee tier. |
| `mb_get_trading_fees` | Maker and taker fees for one pair. |
| `mb_get_positions` | Open positions. |
| `mb_list_orders` | Orders for one pair. |
| `mb_get_order` | One order, including fills. |
| `mb_list_all_orders` | Orders across pairs. |
| `mb_list_deposits` | Crypto deposit history. |
| `mb_get_deposit_addresses` | Existing deposit addresses (GET). |
| `mb_list_fiat_deposits` | BRL deposit history. |
| `mb_list_withdrawals` | Withdrawal history. |
| `mb_get_withdrawal` | One withdrawal. |
| `mb_get_withdraw_limits` | Withdrawal limits. |
| `mb_get_brl_withdraw_config` | BRL withdrawal limits and fees. |
| `mb_list_withdraw_addresses` | Pre-registered crypto addresses. |
| `mb_list_bank_accounts` | Pre-registered bank accounts. |

Authenticated tools need `MB_API_KEY` and `MB_API_SECRET`. Public market tools do not. Path parameters are validated and encoded so a value cannot change the API path.

## Develop

```bash
npm install
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

`npm run deploy` is `wrangler deploy`. Cloudflare Workers Builds should run it on pushes to `main` after the secrets exist in the Cloudflare account. Do not commit secret values.

## Disclaimer

Digital assets are high risk and you can lose the capital you commit to them. This software is provided as is, with no warranty. It is not affiliated with, endorsed by, or operated by Mercado Bitcoin. You are responsible for your Mercado Bitcoin account, the read-only API key, and the bearer token that protects this Worker.

## License

MIT. See [LICENSE](LICENSE).
