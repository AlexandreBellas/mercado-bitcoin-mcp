import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MBClient } from "../client.js";
import type { Config } from "../config.js";
import { apiPath } from "../paths.js";
import { query, read, READ_ONLY, requireCredentials } from "./result.js";

export function registerTradingTools(server: McpServer, client: MBClient, config: Config): void {
	server.registerTool(
		"mb_list_orders",
		{
			description: "List orders for a specific trading pair. Filter by status, side, and date range.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL"),
				status: z.enum(["created", "working", "cancelled", "filled"]).optional().describe("Filter by status"),
				side: z.enum(["buy", "sell"]).optional().describe("Filter by side"),
				has_executions: z.boolean().optional().describe("Filter orders that have fills"),
				id_from: z.string().optional().describe("Start order ID"),
				id_to: z.string().optional().describe("End order ID"),
				created_at_from: z.string().optional().describe("Start date (ISO 8601)"),
				created_at_to: z.string().optional().describe("End date (ISO 8601)"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, status, side, has_executions, id_from, id_to, created_at_from, created_at_to }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath(["accounts", { value: accountId, name: "accountId" }, { value: symbol, name: "symbol" }, "orders"]),
					{
						status,
						side,
						has_executions: query(has_executions),
						id_from,
						id_to,
						created_at_from,
						created_at_to,
					},
				),
			);
		},
	);

	server.registerTool(
		"mb_get_order",
		{
			description: "Get one order, including executions (fills), average price, fees and timestamps.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Trading pair, e.g. BTC-BRL"),
				orderId: z.string().describe("Order ID"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, orderId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath([
						"accounts",
						{ value: accountId, name: "accountId" },
						{ value: symbol, name: "symbol" },
						"orders",
						{ value: orderId, name: "orderId" },
					]),
				),
			);
		},
	);

	server.registerTool(
		"mb_list_all_orders",
		{
			description: "List orders across all trading pairs for an account.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().optional().describe("Optional symbol filter"),
				status: z.enum(["created", "working", "cancelled", "filled"]).optional().describe("Filter by status"),
				has_executions: z.boolean().optional().describe("Filter orders that have fills"),
				size: z.number().optional().describe("Page size"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, status, has_executions, size }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(apiPath(["accounts", { value: accountId, name: "accountId" }, "orders"]), {
					symbol,
					status,
					has_executions: query(has_executions),
					size: query(size),
				}),
			);
		},
	);
}
