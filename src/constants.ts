import packageJson from "../package.json";

export const SERVER_NAME = "mercado-bitcoin-mcp";
export const SERVER_VERSION = packageJson.version;

export const MB_API_BASE = "https://api.mercadobitcoin.net/api/v4";
export const MB_TOKEN_URL = `${MB_API_BASE}/oauth2/token`;

export const MCP_PATH = "/mcp";
