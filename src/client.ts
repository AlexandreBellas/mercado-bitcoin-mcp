import type { AuthManager } from "./auth.js";
import type { Config } from "./config.js";
import { MB_API_BASE, MB_API_ORIGIN } from "./constants.js";
import { httpFetch } from "./http-fetch.js";
import { assertSafePath } from "./paths.js";

const QUERY_KEY = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Read-only Mercado Bitcoin API v4 client.
 * Every call is a GET. There is no POST or DELETE method on this class.
 */
export class MBClient {
	constructor(
		private config: Config,
		private auth: AuthManager,
	) {}

	get hasCredentials(): boolean {
		return this.config.apiKey.length > 0 && this.config.apiSecret.length > 0;
	}

	async publicGet<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
		const url = this.buildUrl(path, params);
		const res = await getOnly(url);
		return this.handleResponse<T>(res);
	}

	async authGet<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
		const url = this.buildUrl(path, params);
		const token = await this.auth.getToken();
		const res = await getOnly(url, { headers: { Authorization: `Bearer ${token}` } });
		return this.handleResponse<T>(res);
	}

	private buildUrl(path: string, params?: Record<string, string | undefined>): string {
		assertSafePath(path);
		const base = new URL(this.config.baseUrl);
		const url = new URL(`${this.config.baseUrl}${path}`);
		assertUnderBase(url, base);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value === undefined || value === "") continue;
				if (!QUERY_KEY.test(key)) {
					throw new Error("Refusing an unsafe query parameter.");
				}
				url.searchParams.set(key, value);
			}
		}
		assertUnderBase(url, base);
		return url.toString();
	}

	private async handleResponse<T>(res: Response): Promise<T> {
		if (res.status >= 300 && res.status < 400) {
			throw new Error(`Mercado Bitcoin API error (HTTP ${res.status}).`);
		}
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Mercado Bitcoin API error (HTTP ${res.status}): ${this.redact(body).slice(0, 500)}`);
		}
		if (res.status === 204) return {} as T;
		const text = await res.text();
		if (!text) return {} as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			return { raw: this.redact(text).slice(0, 500) } as T;
		}
	}

	private redact(text: string): string {
		const secrets = [this.config.apiKey, this.config.apiSecret, this.auth.currentAccessToken() ?? ""];
		let out = text;
		for (const secret of secrets) {
			if (secret.length === 0) continue;
			out = out.split(secret).join("[redacted]");
		}
		return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
	}
}

function assertUnderBase(url: URL, base: URL): void {
	const allowed = new URL(MB_API_BASE);
	if (
		base.origin !== MB_API_ORIGIN ||
		base.pathname !== allowed.pathname ||
		url.origin !== MB_API_ORIGIN ||
		!url.pathname.startsWith(`${allowed.pathname}/`)
	) {
		throw new Error("Refusing to request outside the Mercado Bitcoin API.");
	}
}

/** GET only. A non-GET method never leaves this server through the API client. */
function getOnly(url: string, init?: RequestInit): Promise<Response> {
	const method = init?.method ?? "GET";
	if (method !== "GET") {
		throw new Error("This server is read-only and refuses non-GET Mercado Bitcoin API calls.");
	}
	const headers = new Headers(init?.headers);
	return httpFetch(url, {
		method: "GET",
		headers,
		redirect: "manual",
		cache: "no-store",
	});
}
