import { MB_TOKEN_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Config } from "./config.js";
import { httpFetch } from "./http-fetch.js";
import type { OutboundBudget } from "./request-gate.js";
import { captureBody, describeUpstreamFailure } from "./upstream-error.js";

interface TokenState {
	accessToken: string;
	expiresAt: number;
}

const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

/**
 * OAuth2 client_credentials for Mercado Bitcoin API v4.
 * The only outbound POST in this server. It exchanges the Worker secrets for a
 * short-lived access token and cannot call any other endpoint.
 * The access token stays in isolate memory and is never logged or returned.
 */
export class AuthManager {
	private token: TokenState | null = null;
	private refreshPromise: Promise<string> | null = null;
	private budget: OutboundBudget | null = null;

	constructor(private config: Config) {}

	/** Same object for every request in this isolate. It only talks to the quota Durable Object. */
	useOutbound(budget: OutboundBudget): void {
		this.budget = budget;
	}

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

		// Form-encoded string with an explicit Content-Type. cache is omitted:
		// "no-store" adds Cache-Control and Pragma, and on the edge it also
		// selects the cache path. redirect stays manual so a 3xx cannot carry
		// the client secret off the allowlisted host.
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			scope: "global",
			client_id: this.config.apiKey,
			client_secret: this.config.apiSecret,
		}).toString();
		await this.budget?.acquire("token");
		const res = await httpFetch(MB_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": USER_AGENT,
			},
			body,
			redirect: "manual",
		});
		await this.budget?.observe("token", res);

		if (!res.ok) {
			const text = await captureBody(res);
			const secrets = [this.config.apiKey, this.config.apiSecret];
			const failure = describeUpstreamFailure({
				step: "token",
				status: res.status,
				body: text,
				headers: res.headers,
				secrets,
			});
			console.error(JSON.stringify(failure.log));
			throw new Error(failure.message);
		}

		const data = (await res.json()) as Oauth2AuthorizeResponse;
		if (typeof data.access_token !== "string" || data.access_token.length === 0) {
			console.error(
				JSON.stringify({
					message: "Mercado Bitcoin authentication failed",
					status: res.status,
					reason: "missing access_token",
				}),
			);
			throw new Error("Mercado Bitcoin authentication failed.");
		}

		const now = Date.now();
		const expiresAt = expiresAtFromToken(data, now);
		this.token = { accessToken: data.access_token, expiresAt };

		console.error(
			JSON.stringify({
				message: "Mercado Bitcoin token refreshed",
				expiresIn: Math.max(0, Math.round((expiresAt - now) / 1000)),
			}),
		);
		return this.token.accessToken;
	}
}

/**
 * Live responses use expires_in as a TTL in seconds. The v4 swagger also
 * documents expiration, which expiresAtFromExpiration interprets. expires_in
 * wins when both are present. Anything else is cached for 60 seconds.
 */
export function expiresAtFromToken(data: { expires_in?: unknown; expiration?: unknown }, now: number): number {
	if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0) {
		return now + data.expires_in * 1000;
	}
	return expiresAtFromExpiration(data.expiration, now);
}

/**
 * Oauth2AuthorizeResponse.expiration from the Mercado Bitcoin v4 swagger.
 * A value of 1e9 or more is a unix timestamp in seconds. A smaller positive
 * number is a TTL in seconds. Anything else falls back to a 60s cache.
 */
export function expiresAtFromExpiration(expiration: unknown, now: number): number {
	if (typeof expiration !== "number" || !Number.isFinite(expiration) || expiration <= 0) {
		return now + 60_000;
	}
	if (expiration >= 1_000_000_000) return expiration * 1000;
	return now + expiration * 1000;
}

/**
 * Fields safe to print from a token error. Delegates to the shared upstream
 * diagnostic. The raw body is never included: Mercado Bitcoin may echo the
 * client id, client secret, or a token.
 */
export function tokenFailureLog(status: number, body: string, secrets: string[]): Record<string, unknown> {
	return describeUpstreamFailure({ step: "token", status, body, secrets }).log;
}

interface Oauth2AuthorizeResponse {
	access_token?: unknown;
	expires_in?: unknown;
	expiration?: unknown;
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
