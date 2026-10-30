import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthManager, clearAuthManagerCache, expiresAtFromExpiration } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { MB_API_BASE, MB_API_ORIGIN, MB_TOKEN_URL } from "../src/constants.js";
import { httpFetch, isAllowedOutbound } from "../src/http-fetch.js";
import { API_KEY, API_SECRET, ACCESS_TOKEN, invocationSensitiveFetch } from "./helpers.js";

afterEach(() => {
	clearAuthManagerCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("OAuth token URL", () => {
	it("is the host root /oauth2/token, not under /api/v4", () => {
		expect(MB_TOKEN_URL).toBe("https://api.mercadobitcoin.net/oauth2/token");
		expect(new URL(MB_TOKEN_URL).origin).toBe(MB_API_ORIGIN);
		expect(new URL(MB_TOKEN_URL).origin).toBe(new URL(MB_API_BASE).origin);
		expect(new URL(MB_TOKEN_URL).pathname).toBe("/oauth2/token");
		expect(MB_TOKEN_URL.startsWith(`${MB_API_BASE}/`)).toBe(false);
	});

	it("allows only that POST and GETs under /api/v4 on the same host", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch((input) => {
				calls.push(String(input));
				return Response.json({});
			}),
		);

		expect(isAllowedOutbound(new URL(MB_TOKEN_URL), "POST")).toBe(true);
		expect(isAllowedOutbound(new URL("https://api.mercadobitcoin.net/api/v4/accounts"), "GET")).toBe(true);
		expect(isAllowedOutbound(new URL("https://api.mercadobitcoin.net/api/v4/oauth2/token"), "POST")).toBe(false);
		expect(isAllowedOutbound(new URL("https://evil.example/oauth2/token"), "POST")).toBe(false);
		expect(isAllowedOutbound(new URL(MB_TOKEN_URL), "GET")).toBe(false);
		expect(isAllowedOutbound(new URL("https://api.mercadobitcoin.net/api/v4/accounts"), "POST")).toBe(false);

		await expect(httpFetch("https://api.mercadobitcoin.net/api/v4/oauth2/token", { method: "POST" })).rejects.toThrow(
			/outside/,
		);
		await expect(httpFetch("https://evil.example/oauth2/token", { method: "POST" })).rejects.toThrow(/outside/);
		await httpFetch(MB_TOKEN_URL, { method: "POST" });
		await httpFetch("https://api.mercadobitcoin.net/api/v4/accounts");
		expect(calls).toEqual([MB_TOKEN_URL, "https://api.mercadobitcoin.net/api/v4/accounts"]);
	});
});

describe("Oauth2AuthorizeResponse.expiration", () => {
	const now = 1_700_000_000_000;

	it("reads a unix timestamp in seconds and a short TTL in seconds", () => {
		expect(expiresAtFromExpiration(1_900_000_000, now)).toBe(1_900_000_000_000);
		expect(expiresAtFromExpiration(3600, now)).toBe(now + 3_600_000);
		expect(expiresAtFromExpiration(undefined, now)).toBe(now + 60_000);
		expect(expiresAtFromExpiration("3600", now)).toBe(now + 60_000);
	});

	it("caches from expiration and ignores expires_in", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls.push(String(input));
				return Response.json({ access_token: ACCESS_TOKEN, expires_in: 7200, expiration: 3600 });
			}),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE));
		await auth.getToken();
		await auth.getToken();
		expect(calls).toEqual([MB_TOKEN_URL]);
	});

	it("refreshes when expiration is inside the 60s buffer even if expires_in is long", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json({
					access_token: ACCESS_TOKEN,
					expires_in: 7200,
					expiration: Math.floor(Date.now() / 1000) + 30,
				});
			}),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE));
		await auth.getToken();
		await auth.getToken();
		expect(calls).toBe(2);
	});
});
