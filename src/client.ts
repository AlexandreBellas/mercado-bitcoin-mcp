import type { AuthManager } from "./auth.js";
import type { Config } from "./config.js";
import { MB_API_BASE, MB_API_ORIGIN } from "./constants.js";
import { httpFetch } from "./http-fetch.js";
import { assertSafePath } from "./paths.js";
import type { OutboundBudget } from "./request-gate.js";
import { captureBody, describeUpstreamFailure, redactSecrets } from "./upstream-error.js";

const QUERY_KEY = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Read-only Mercado Bitcoin API v4 client.
 * Every call is a GET. There is no POST or DELETE method on this class.
 */
export class MBClient {
	constructor(
		private config: Config,
		private auth: AuthManager,
		private budget?: OutboundBudget,
	) {}

	get hasCredentials(): boolean {
		return this.config.apiKey.length > 0 && this.config.apiSecret.length > 0;
	}

	async publicGet<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
		const url = this.buildUrl(path, params);
		await this.budget?.acquire("public");
		const res = await getOnly(url);
		await this.budget?.observe("public", res);
		return this.handleResponse<T>(res);
	}

	async authGet<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
		const url = this.buildUrl(path, params);
		const token = await this.auth.getToken();
		await this.budget?.acquire("private");
		const res = await getOnly(url, { headers: { Authorization: `Bearer ${token}` } });
		await this.budget?.observe("private", res);
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
		if (!res.ok) {
			const body = await captureBody(res);
			const failure = describeUpstreamFailure({
				step: "api",
				status: res.status,
				body,
				headers: res.headers,
				secrets: this.secretValues(),
			});
			console.error(JSON.stringify(failure.log));
			throw new Error(failure.message);
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

	private secretValues(): string[] {
		return [this.config.apiKey, this.config.apiSecret, this.auth.currentAccessToken() ?? ""];
	}

	private redact(text: string): string {
		return redactSecrets(text, this.secretValues());
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
