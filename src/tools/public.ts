import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MBClient } from "../client.js";
import { apiPath } from "../paths.js";
import { query, read, READ_ONLY } from "./result.js";

export function registerPublicTools(server: McpServer, client: MBClient): void {
	server.registerTool(
		"mb_get_orderbook",
		{
			description:
				"Get the order book (asks and bids) for a trading pair on Mercado Bitcoin. Returns current buy and sell orders with prices and quantities.",
			inputSchema: {
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL, ETH-BRL"),
				limit: z.number().optional().describe("Max entries per side (up to 1000)"),
			},
			annotations: READ_ONLY,
		},
		async ({ symbol, limit }) =>
			read(() => client.publicGet(apiPath([{ value: symbol, name: "symbol" }, "orderbook"]), { limit: query(limit) })),
	);

	server.registerTool(
		"mb_get_trades",
		{
			description:
				"Get recent executed trades for a trading pair. Useful for seeing market activity, recent prices and volumes.",
			inputSchema: {
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL"),
				since: z.string().optional().describe("Return trades after this trade ID"),
				from: z.string().optional().describe("Start timestamp (Unix seconds)"),
				to: z.string().optional().describe("End timestamp (Unix seconds)"),
				limit: z.number().optional().describe("Max trades to return (up to 1000)"),
			},
			annotations: READ_ONLY,
		},
		async ({ symbol, since, from, to, limit }) =>
			read(() =>
				client.publicGet(apiPath([{ value: symbol, name: "symbol" }, "trades"]), {
					since,
					from,
					to,
					limit: query(limit),
				}),
			),
	);

	server.registerTool(
		"mb_get_symbols",
		{
			description:
				"List available trading symbols/pairs on Mercado Bitcoin with metadata (min/max price, min/max volume, asset type). Without a filter, returns only BRL pairs in pages of 200.",
			inputSchema: {
				symbols: z.string().optional().describe("Comma-separated filter, e.g. BTC-BRL,ETH-BRL. Overrides pagination."),
				limit: z.number().default(200).describe("Max symbols per page (default: 200)"),
				offset: z.number().default(0).describe("Skip first N results for pagination (default: 0)"),
				brl_only: z.boolean().default(true).describe("When true (default) and no filter, returns only -BRL pairs"),
			},
			annotations: READ_ONLY,
		},
		async ({ symbols, limit, offset, brl_only }) => {
			if (symbols) return read(() => client.publicGet("/symbols", { symbols }));
			return read(async () => {
				const data = await client.publicGet<Record<string, unknown>[]>("/symbols");
				let items = Array.isArray(data) ? data : [];
				if (brl_only) {
					items = items.filter((item) => {
						const sym = item["symbol"];
						return typeof sym === "string" && sym.endsWith("-BRL");
					});
				}
				const total = items.length;
				const page = items.slice(offset, offset + limit);
				const hasMore = offset + limit < total;
				return {
					total,
					showing: `${offset + 1}-${Math.min(offset + limit, total)} de ${total}`,
					hasMore,
					nextOffset: hasMore ? offset + limit : null,
					symbols: page,
				};
			});
		},
	);

	server.registerTool(
		"mb_get_tickers",
		{
			description:
				"Get current price tickers for one or more trading pairs. Returns last price, bid, ask, high, low, open, and 24h volume.",
			inputSchema: {
				symbols: z.string().describe("Comma-separated symbols, e.g. BTC-BRL,ETH-BRL"),
			},
			annotations: READ_ONLY,
		},
		async ({ symbols }) => read(() => client.publicGet("/tickers", { symbols })),
	);

	server.registerTool(
		"mb_get_candles",
		{
			description: "Get OHLCV candlestick data. Resolutions: 1m, 15m, 1h, 3h, 1d, 1w, 1M.",
			inputSchema: {
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL"),
				resolution: z.enum(["1m", "15m", "1h", "3h", "1d", "1w", "1M"]).describe("Candle interval"),
				from: z.string().optional().describe("Start timestamp (Unix seconds)"),
				to: z.string().describe("End timestamp (Unix seconds)"),
				countback: z.number().optional().describe("Number of candles to return (overrides 'from')"),
			},
			annotations: READ_ONLY,
		},
		async ({ symbol, resolution, from, to, countback }) =>
			read(() =>
				client.publicGet("/candles", {
					symbol,
					resolution,
					from,
					to,
					countback: query(countback),
				}),
			),
	);

	server.registerTool(
		"mb_get_asset_fees",
		{
			description:
				"Get deposit and withdrawal fees for a specific asset, including minimum amounts and confirmation requirements per network.",
			inputSchema: {
				asset: z.string().describe("Asset symbol, e.g. BTC, ETH, USDT"),
				network: z.string().optional().describe("Specific network, e.g. ethereum, stellar"),
			},
			annotations: READ_ONLY,
		},
		async ({ asset, network }) =>
			read(() => client.publicGet(apiPath([{ value: asset, name: "asset" }, "fees"]), { network })),
	);

	server.registerTool(
		"mb_get_asset_networks",
		{
			description: "List available blockchain networks for a specific asset.",
			inputSchema: {
				asset: z.string().describe("Asset symbol, e.g. USDT, BTC"),
			},
			annotations: READ_ONLY,
		},
		async ({ asset }) => read(() => client.publicGet(apiPath([{ value: asset, name: "asset" }, "networks"]))),
	);
}
