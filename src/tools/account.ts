import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MBClient } from "../client.js";
import type { Config } from "../config.js";
import { apiPath } from "../paths.js";
import { read, READ_ONLY, requireCredentials } from "./result.js";

export function registerAccountTools(server: McpServer, client: MBClient, config: Config): void {
	server.registerTool(
		"mb_list_accounts",
		{
			description:
				"List all your Mercado Bitcoin accounts (wallets). Returns account IDs needed for other reads.",
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async () => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() => client.authGet("/accounts"));
		},
	);

	server.registerTool(
		"mb_get_balances",
		{
			description:
				"Get asset balances for an account: available, on_hold (in open orders), and total. By default, only assets with balance > 0 are returned.",
			inputSchema: {
				accountId: z.string().describe("Account ID (use mb_list_accounts to find it)"),
				hide_zero: z.boolean().default(true).describe("Hide assets with zero balance (default: true)"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, hide_zero }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const data = await client.authGet<Array<{ symbol: string; available: string; on_hold: string; total: string }>>(
					apiPath(["accounts", { value: accountId, name: "accountId" }, "balances"]),
				);
				if (hide_zero && Array.isArray(data)) return data.filter((balance) => parseFloat(balance.total) > 0);
				return data;
			});
		},
	);

	server.registerTool(
		"mb_get_tier",
		{
			description: "Get the fee tier level of an account. Higher tiers have lower trading fees.",
			inputSchema: { accountId: z.string().describe("Account ID") },
			annotations: READ_ONLY,
		},
		async ({ accountId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() => client.authGet(apiPath(["accounts", { value: accountId, name: "accountId" }, "tier"])));
		},
	);

	server.registerTool(
		"mb_get_trading_fees",
		{
			description: "Get maker and taker fee rates for a specific market.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath(["accounts", { value: accountId, name: "accountId" }, { value: symbol, name: "symbol" }, "fees"]),
				),
			);
		},
	);

	server.registerTool(
		"mb_get_positions",
		{
			description: "List open positions with average entry price, quantity and side.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbols: z.string().optional().describe("Comma-separated filter, e.g. BTC-BRL,ETH-BRL"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbols }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(apiPath(["accounts", { value: accountId, name: "accountId" }, "positions"]), { symbols }),
			);
		},
	);
}
