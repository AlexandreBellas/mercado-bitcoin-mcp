import { MB_TOKEN_URL } from "./constants.js";
import type { Config } from "./config.js";
import { httpFetch } from "./http-fetch.js";

interface TokenState {
	accessToken: string;
	expiresAt: number;
}

/**
 * OAuth2 client_credentials for Mercado Bitcoin API v4.
 * The only outbound POST in this server. It exchanges the Worker secrets for a
 * short-lived access token and cannot call any other endpoint.
 * The access token stays in isolate memory and is never logged or returned.
 */
export class AuthManager {
	private token: TokenState | null = null;
	private refreshPromise: Promise<string> | null = null;

	constructor(private config: Config) {}

	matches(config: Config): boolean {
		return this.config.apiKey === config.apiKey && this.config.apiSecret === config.apiSecret;
	}

	currentAccessToken(): string | null {
		return this.token?.accessToken ?? null;
	}

	async getToken(): Promise<string> {
		if (this.token && Date.now() < this.token.expiresAt - 60_000) {
			return this.token.accessToken;
		}
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = this.refresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async refresh(): Promise<string> {
		if (!this.config.apiKey || !this.config.apiSecret) {
			throw new Error(
				"MB_API_KEY and MB_API_SECRET are required. Create a read-only (Leitura) key on Mercado Bitcoin.",
			);
		}

		const res = await httpFetch(MB_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "client_credentials",
				scope: "global",
				client_id: this.config.apiKey,
				client_secret: this.config.apiSecret,
			}),
			redirect: "manual",
			cache: "no-store",
		});

		if (res.status >= 300 && res.status < 400) {
			console.error(JSON.stringify({ message: "Mercado Bitcoin token endpoint redirected", status: res.status }));
			throw new Error("Mercado Bitcoin authentication failed.");
		}

		if (!res.ok) {
			console.error(JSON.stringify({ message: "Mercado Bitcoin authentication failed", status: res.status }));
			throw new Error("Mercado Bitcoin authentication failed.");
		}

		const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
		if (typeof data.access_token !== "string" || data.access_token.length === 0) {
			throw new Error("Mercado Bitcoin authentication failed.");
		}

		const expiresIn =
			typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
				? data.expires_in
				: 60;

		this.token = {
			accessToken: data.access_token,
			expiresAt: Date.now() + expiresIn * 1000,
		};

		console.error(JSON.stringify({ message: "Mercado Bitcoin token refreshed", expiresIn }));
		return this.token.accessToken;
	}
}

let cached: AuthManager | null = null;

export function getAuthManager(config: Config): AuthManager {
	if (!cached || !cached.matches(config)) {
		cached = new AuthManager(config);
	}
	return cached;
}

/** Test hook. Drops the isolate token cache. */
export function clearAuthManagerCache(): void {
	cached = null;
}
