import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MBClient } from "../client.js";
import type { Config } from "../config.js";
import { apiPath } from "../paths.js";
import { query, read, READ_ONLY, requireCredentials } from "./result.js";

export function registerWalletTools(server: McpServer, client: MBClient, config: Config): void {
	server.registerTool(
		"mb_list_deposits",
		{
			description: "List cryptocurrency deposit history for an account.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Asset symbol, e.g. BTC, ETH"),
				limit: z.number().optional().describe("Max results (up to 10)"),
				page: z.number().optional().describe("Page number"),
				from: z.string().optional().describe("Start timestamp (Unix seconds)"),
				to: z.string().optional().describe("End timestamp (Unix seconds)"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, limit, page, from, to }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath([
						"accounts",
						{ value: accountId, name: "accountId" },
						"wallet",
						{ value: symbol, name: "symbol" },
						"deposits",
					]),
					{ limit: query(limit), page: query(page), from, to },
				),
			);
		},
	);

	server.registerTool(
		"mb_get_deposit_addresses",
		{
			description:
				"Get deposit addresses for receiving cryptocurrency. This is a read (GET) of addresses already issued by Mercado Bitcoin.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Asset symbol, e.g. BTC, USDT"),
				network: z.string().optional().describe("Network, e.g. ethereum, stellar"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, network }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath([
						"accounts",
						{ value: accountId, name: "accountId" },
						"wallet",
						{ value: symbol, name: "symbol" },
						"deposits",
						"addresses",
					]),
					{ network },
				),
			);
		},
	);

	server.registerTool(
		"mb_list_fiat_deposits",
		{
			description: "List BRL (fiat) deposit history via PIX.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().default("BRL").describe("Fiat currency (default: BRL)"),
				limit: z.number().optional().describe("Max results (up to 50)"),
				page: z.number().optional().describe("Page number (starts at 1)"),
				from: z.string().optional().describe("Start timestamp (Unix seconds)"),
				to: z.string().optional().describe("End timestamp (Unix seconds)"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, limit, page, from, to }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath([
						"accounts",
						{ value: accountId, name: "accountId" },
						"wallet",
						"fiat",
						{ value: symbol, name: "symbol" },
						"deposits",
					]),
					{ limit: query(limit), page: query(page), from, to },
				),
			);
		},
	);

	server.registerTool(
		"mb_list_withdrawals",
		{
			description: "List withdrawal history for an asset. Does not create a withdrawal.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Asset symbol, e.g. BTC, BRL"),
				page: z.number().optional().describe("Page number"),
				pageSize: z.number().optional().describe("Page size (up to 50)"),
				from: z.string().optional().describe("Start timestamp (Unix seconds)"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, page, pageSize, from }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath(["accounts", { value: accountId, name: "accountId" }, "wallet", { value: symbol, name: "symbol" }, "withdraw"]),
					{ page: query(page), page_size: query(pageSize), from },
				),
			);
		},
	);

	server.registerTool(
		"mb_get_withdrawal",
		{
			description: "Get one withdrawal by ID. Status codes: 1=open, 2=done, 3=canceled.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbol: z.string().describe("Asset symbol"),
				withdrawId: z.string().describe("Withdrawal ID"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbol, withdrawId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath([
						"accounts",
						{ value: accountId, name: "accountId" },
						"wallet",
						{ value: symbol, name: "symbol" },
						"withdraw",
						{ value: withdrawId, name: "withdrawId" },
					]),
				),
			);
		},
	);

	server.registerTool(
		"mb_get_withdraw_limits",
		{
			description: "Get withdrawal limits per asset.",
			inputSchema: {
				accountId: z.string().describe("Account ID"),
				symbols: z.string().optional().describe("Comma-separated assets, e.g. BTC,ETH,BRL"),
			},
			annotations: READ_ONLY,
		},
		async ({ accountId, symbols }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath(["accounts", { value: accountId, name: "accountId" }, "wallet", "withdraw", "config", "limits"]),
					{ symbols },
				),
			);
		},
	);

	server.registerTool(
		"mb_get_brl_withdraw_config",
		{
			description: "Get BRL withdrawal configuration: minimum/maximum limits, used limits and fee structure.",
			inputSchema: { accountId: z.string().describe("Account ID") },
			annotations: READ_ONLY,
		},
		async ({ accountId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(apiPath(["accounts", { value: accountId, name: "accountId" }, "wallet", "withdraw", "config", "BRL"])),
			);
		},
	);

	server.registerTool(
		"mb_list_withdraw_addresses",
		{
			description: "List pre-registered crypto addresses allowed for withdrawals. This does not add an address.",
			inputSchema: { accountId: z.string().describe("Account ID") },
			annotations: READ_ONLY,
		},
		async ({ accountId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(apiPath(["accounts", { value: accountId, name: "accountId" }, "wallet", "withdraw", "addresses"])),
			);
		},
	);

	server.registerTool(
		"mb_list_bank_accounts",
		{
			description: "List pre-registered bank accounts allowed for BRL withdrawals. This does not add an account.",
			inputSchema: { accountId: z.string().describe("Account ID") },
			annotations: READ_ONLY,
		},
		async ({ accountId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(() =>
				client.authGet(
					apiPath(["accounts", { value: accountId, name: "accountId" }, "wallet", "withdraw", "bank-accounts"]),
				),
			);
		},
	);
}
