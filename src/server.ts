import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthManager } from "./auth.js";
import { MBClient } from "./client.js";
import { MB_API_BASE, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { hasCredentials, loadConfig, type CredentialEnv } from "./config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerPublicTools } from "./tools/public.js";
import { READ_ONLY, ok } from "./tools/result.js";
import { registerTradingTools } from "./tools/trading.js";
import { registerWalletTools } from "./tools/wallet.js";

export function createMbServer(env: CredentialEnv): McpServer {
	const config = loadConfig(env, MB_API_BASE);
	const auth = getAuthManager(config);
	const client = new MBClient(config, auth);
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	server.registerTool(
		"mb_status",
		{
			description:
				"Show whether this read-only Mercado Bitcoin MCP server has API credentials configured. Does not reveal secrets or balances.",
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async () =>
			ok({
				service: SERVER_NAME,
				version: SERVER_VERSION,
				mode: "read-only",
				mercadoBitcoinCredentialsConfigured: hasCredentials(config),
			}),
	);

	registerPublicTools(server, client);
	registerAccountTools(server, client, config);
	registerTradingTools(server, client, config);
	registerWalletTools(server, client, config);
	return server;
}
