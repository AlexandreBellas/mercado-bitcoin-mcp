import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthManagerCache } from "../src/auth.js";
import { clearAuthLockoutCache } from "../src/auth-gate.js";
import { handleRequest } from "../src/http.js";
import { MB_TOKEN_URL } from "../src/constants.js";
import {
	ACCESS_TOKEN,
	API_KEY,
	API_SECRET,
	invocationSensitiveFetch,
	jsonRpc,
	MCP_TOKEN,
	mcpRequest,
	testEnv,
	type FetchCall,
} from "./helpers.js";

const WRITE_TOOLS = [
	"mb_place_order",
	"mb_cancel_order",
	"mb_cancel_all_orders",
	"mb_internal_transfer",
	"mb_create_account",
	"mb_withdraw",
];

const READ_TOOLS = [
	"mb_status",
	"mb_get_orderbook",
	"mb_get_trades",
	"mb_get_symbols",
	"mb_get_tickers",
	"mb_get_candles",
	"mb_get_asset_fees",
	"mb_get_asset_networks",
	"mb_list_accounts",
	"mb_get_balances",
	"mb_get_tier",
	"mb_get_trading_fees",
	"mb_get_positions",
	"mb_list_orders",
	"mb_get_order",
	"mb_list_all_orders",
	"mb_list_deposits",
	"mb_get_deposit_addresses",
	"mb_list_fiat_deposits",
	"mb_list_withdrawals",
	"mb_get_withdrawal",
	"mb_get_withdraw_limits",
	"mb_get_brl_withdraw_config",
	"mb_list_withdraw_addresses",
	"mb_list_bank_accounts",
];

afterEach(() => {
	clearAuthLockoutCache();
	clearAuthManagerCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
		else if (path.endsWith(".ts")) files.push(path);
	}
	return files;
}

async function callMcp(body: unknown, env = testEnv()): Promise<unknown> {
	const response = await handleRequest(mcpRequest({ token: MCP_TOKEN, body }), env);
	expect(response.status).toBe(200);
	return response.json();
}

describe("read-only tool registry", () => {
	it("registers every read tool and no write tool", async () => {
		const listed = (await callMcp(jsonRpc("tools/list", 1))) as {
			result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
		};
		const tools = listed.result?.tools ?? [];
		const names = tools.map((tool) => tool.name).sort();
		expect(names).toEqual([...READ_TOOLS].sort());
		for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
			expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
		}
	});

	it("has no write client and no stdio or process.env usage", () => {
		const files = sourceFiles("src");
		const posts: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text, file).not.toContain("authPost");
			expect(text, file).not.toContain("authDelete");
			expect(text, file).not.toContain("node:fs");
			expect(text, file).not.toContain("process.exit");
			expect(text, file).not.toContain("process.env");
			expect(text, file).not.toContain("StdioServerTransport");
			expect(text, file).not.toContain("MB_OPERATION_MODE");
			expect(text, file).not.toContain("MB_DRY_RUN");
			expect(text, file).not.toContain("MB_AUTO_CONFIRM");
			for (const name of WRITE_TOOLS) expect(text, file).not.toContain(name);
			if (/method:\s*["']POST["']/.test(text)) posts.push(file.split("\\").join("/"));
			expect(text, file).not.toMatch(/method:\s*["']DELETE["']/);
		}
		expect(posts).toEqual(["src/auth.ts"]);
		const auth = readFileSync("src/auth.ts", "utf8");
		expect(auth).toContain("httpFetch(MB_TOKEN_URL");
		const constants = readFileSync("src/constants.ts", "utf8");
		expect(constants).toContain('export const MB_API_BASE = "https://api.mercadobitcoin.net/api/v4"');
		expect(constants).toContain("MB_TOKEN_URL = `${MB_API_BASE}/oauth2/token`");
		expect(auth.match(/method:\s*["']POST["']/g)).toHaveLength(1);
	});

	it("rejects a path parameter that would escape the API and does not fetch it", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch((input) => {
				calls.push(String(input));
				return Response.json({});
			}),
		);
		const response = (await callMcp(
			jsonRpc("tools/call", 2, { name: "mb_get_orderbook", arguments: { symbol: "../admin" } }),
		)) as { result?: { isError?: boolean; content?: { text: string }[] } };
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toContain("symbol is not a valid path parameter");
		expect(calls).toEqual([]);
	});

	it("exchanges a token and calls a GET tool without echoing secrets", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				const body =
					typeof init?.body === "string"
						? init.body
						: init?.body instanceof URLSearchParams
							? init.body.toString()
							: null;
				calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body });
				if (url === MB_TOKEN_URL) {
					return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "bearer" });
				}
				if (url === "https://api.mercadobitcoin.net/api/v4/accounts") {
					return Response.json([{ id: "acc-1", name: "main" }]);
				}
				return new Response("unexpected", { status: 500 });
			}),
		);

		const first = (await callMcp(jsonRpc("tools/call", 3, { name: "mb_list_accounts", arguments: {} }))) as {
			result?: { isError?: boolean; content?: { text: string }[] };
		};
		expect(first.result?.isError).toBeUndefined();
		expect(first.result?.content?.[0]?.text).toContain("acc-1");
		expect(calls.map((call) => ({ url: call.url, method: call.method, authorization: call.authorization }))).toEqual([
			{ url: MB_TOKEN_URL, method: "POST", authorization: null },
			{ url: "https://api.mercadobitcoin.net/api/v4/accounts", method: "GET", authorization: `Bearer ${ACCESS_TOKEN}` },
		]);
		expect(calls[0]?.body).toContain("grant_type=client_credentials");
		expect(calls[0]?.body).toContain(encodeURIComponent(API_KEY));

		const second = (await callMcp(jsonRpc("tools/call", 4, { name: "mb_list_accounts", arguments: {} }))) as {
			result?: { content?: { text: string }[] };
		};
		expect(second.result?.content?.[0]?.text).toContain("acc-1");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

		const leaked = JSON.stringify(first) + JSON.stringify(second) + errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(leaked).not.toContain(API_SECRET);
		expect(leaked).not.toContain(API_KEY);
		expect(leaked).not.toContain(ACCESS_TOKEN);
		expect(leaked).not.toContain(MCP_TOKEN);
	});
});
