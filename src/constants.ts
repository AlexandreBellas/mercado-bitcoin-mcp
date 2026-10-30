import packageJson from "../package.json";

export const SERVER_NAME = "mercado-bitcoin-mcp";
export const SERVER_VERSION = packageJson.version;

/** Only host this server may call. */
export const MB_API_ORIGIN = "https://api.mercadobitcoin.net";

/** GET API. Every read stays under this prefix. */
export const MB_API_BASE = "https://api.mercadobitcoin.net/api/v4";

/**
 * OAuth2 token endpoint. The v4 swagger says every request uses the /api/v4
 * context except /oauth2/token, which lives on the same host without that prefix.
 */
export const MB_TOKEN_URL = "https://api.mercadobitcoin.net/oauth2/token";

export const MCP_PATH = "/mcp";

const tokenUrl = new URL(MB_TOKEN_URL);
const apiBase = new URL(MB_API_BASE);
if (
	tokenUrl.origin !== MB_API_ORIGIN ||
	apiBase.origin !== MB_API_ORIGIN ||
	tokenUrl.pathname !== "/oauth2/token" ||
	apiBase.pathname !== "/api/v4" ||
	tokenUrl.href !== MB_TOKEN_URL
) {
	throw new Error("Mercado Bitcoin host allowlist is inconsistent.");
}
