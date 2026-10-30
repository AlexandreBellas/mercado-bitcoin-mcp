import { MB_TOKEN_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Config } from "./config.js";
import { httpFetch } from "./http-fetch.js";
import type { OutboundBudget } from "./request-gate.js";

interface TokenState {
	accessToken: string;
	expiresAt: number;
}

const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
const ERROR_BODY_LIMIT = 8192;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,32}$/;

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
			const text = await readErrorBody(res);
			const secrets = [this.config.apiKey, this.config.apiSecret];
			const log = tokenFailureLog(res.status, text, secrets);
			if (res.status >= 300 && res.status < 400) {
				log.message = "Mercado Bitcoin token endpoint redirected";
			}
			console.error(JSON.stringify(log));
			throw new Error("Mercado Bitcoin authentication failed.");
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
 * Fields safe to print from a token error. The raw body is never included:
 * Mercado Bitcoin may echo the client id, client secret, or a token.
 */
export function tokenFailureLog(status: number, body: string, secrets: string[]): Record<string, unknown> {
	const log: Record<string, unknown> = {
		message: "Mercado Bitcoin authentication failed",
		status,
	};
	if (body.length === 0 || body.length > ERROR_BODY_LIMIT) return log;

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return log;
	}
	if (!parsed || typeof parsed !== "object") return log;

	const obj = parsed as Record<string, unknown>;
	const code = publicCode(obj.code, secrets);
	if (code) log.code = code;
	const mbMessage = publicText(obj.message, secrets);
	if (mbMessage) log.mbMessage = mbMessage;

	if (obj.data && typeof obj.data === "object") {
		const data = obj.data as Record<string, unknown>;
		const error = publicCode(data.error, secrets);
		const dataMessage = publicText(data.message, secrets);
		if (error || dataMessage) {
			log.data = {
				...(error ? { error } : {}),
				...(dataMessage ? { message: dataMessage } : {}),
			};
		}
	}
	return log;
}

function publicCode(value: unknown, secrets: string[]): string | undefined {
	if (typeof value !== "string" || !SAFE_CODE.test(value)) return undefined;
	if (containsSecret(value, secrets)) return undefined;
	return value;
}

function publicText(value: unknown, secrets: string[]): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text.length === 0 || text.length > 200) return undefined;
	if (text.includes("=") || text.includes("\n") || text.includes("\r")) return undefined;
	if (/[A-Za-z0-9+/=_-]{32,}/.test(text)) return undefined;
	if (containsSecret(text, secrets)) return undefined;
	return text;
}

function containsSecret(value: string, secrets: string[]): boolean {
	return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

async function readErrorBody(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.length > ERROR_BODY_LIMIT ? "" : text;
	} catch {
		return "";
	}
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
