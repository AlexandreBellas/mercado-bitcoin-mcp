import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthManager, clearAuthManagerCache, expiresAtFromExpiration, expiresAtFromToken, tokenFailureLog } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { MB_API_BASE, MB_API_ORIGIN, MB_TOKEN_URL, SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
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

describe("token lifetime", () => {
	const now = 1_700_000_000_000;

	it("reads a unix timestamp in seconds and a short TTL in seconds", () => {
		expect(expiresAtFromExpiration(1_900_000_000, now)).toBe(1_900_000_000_000);
		expect(expiresAtFromExpiration(3600, now)).toBe(now + 3_600_000);
		expect(expiresAtFromExpiration(undefined, now)).toBe(now + 60_000);
		expect(expiresAtFromExpiration("3600", now)).toBe(now + 60_000);
	});

	it("prefers expires_in seconds, including when expiration is also present", () => {
		expect(expiresAtFromToken({ expires_in: 3599 }, now)).toBe(now + 3_599_000);
		expect(expiresAtFromToken({ expiration: 1_900_000_000 }, now)).toBe(1_900_000_000_000);
		expect(expiresAtFromToken({ expires_in: 3599, expiration: 1_900_000_000 }, now)).toBe(now + 3_599_000);
		expect(expiresAtFromToken({ expires_in: "3599", expiration: 3600 }, now)).toBe(now + 3_600_000);
		expect(expiresAtFromToken({}, now)).toBe(now + 60_000);
	});

	it("caches a live expires_in of 3599 seconds", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json({
					access_token: ACCESS_TOKEN,
					expires_in: 3599,
					scope: "global",
					token_type: "bearer",
				});
			}),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE));
		await auth.getToken();
		await auth.getToken();
		expect(calls).toBe(1);
	});

	it("uses expiration when expires_in is absent and refreshes inside the 60s buffer", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json({
					access_token: ACCESS_TOKEN,
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

describe("token request", () => {
	it("posts a form string with Accept and User-Agent and without cache mode", async () => {
		let init: RequestInit | undefined;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (_input, requestInit) => {
				init = requestInit;
				return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3599 });
			}),
		);
		const secret = "sec+ret/with=equals";
		const auth = new AuthManager(
			loadConfig({ MB_API_KEY: `  ${API_KEY}\n`, MB_API_SECRET: `\t${secret}  ` }, MB_API_BASE),
		);
		await auth.getToken();

		const headers = new Headers(init?.headers);
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("manual");
		expect(init?.cache).toBeUndefined();
		expect(typeof init?.body).toBe("string");
		expect(init?.body).toBe(
			new URLSearchParams({
				grant_type: "client_credentials",
				scope: "global",
				client_id: API_KEY,
				client_secret: secret,
			}).toString(),
		);
		expect(headers.get("accept")).toBe("application/json");
		expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(headers.get("user-agent")).toBe(`${SERVER_NAME}/${SERVER_VERSION}`);
	});

	it("treats whitespace-only credentials as missing and does not fetch", async () => {
		let called = false;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				called = true;
				return Response.json({});
			}),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: "  ", MB_API_SECRET: "\n" }, MB_API_BASE));
		await expect(auth.getToken()).rejects.toThrow(/MB_API_KEY/);
		expect(called).toBe(false);
	});

	it("logs status, code, and data.error without secrets or the raw body", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () =>
				Response.json(
					{
						code: "HUH422",
						message: "unprocessable",
						data: { error: "invalid_request", message: "grant_type missing" },
						client_secret: API_SECRET,
						access_token: ACCESS_TOKEN,
						debug: `client_id=${API_KEY}&client_secret=${API_SECRET}`,
					},
					{ status: 422 },
				),
			),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE));
		await expect(auth.getToken()).rejects.toThrow(/authentication failed/);
		expect(errors.mock.calls).toHaveLength(1);
		expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
			message: "Mercado Bitcoin authentication failed",
			status: 422,
			code: "HUH422",
			mbMessage: "unprocessable",
			data: { error: "invalid_request", message: "grant_type missing" },
		});
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).not.toContain(API_SECRET);
		expect(logged).not.toContain(API_KEY);
		expect(logged).not.toContain(ACCESS_TOKEN);
		expect(logged).not.toContain("client_secret");
	});

	it("logs a 401 invalid_client code and drops a non-JSON body", () => {
		expect(
			tokenFailureLog(
				401,
				JSON.stringify({ code: "HUH401", message: "unauthorized", data: { error: "invalid_client" } }),
				[API_KEY, API_SECRET],
			),
		).toEqual({
			message: "Mercado Bitcoin authentication failed",
			status: 401,
			code: "HUH401",
			mbMessage: "unauthorized",
			data: { error: "invalid_client" },
		});

		const leaked = `client_id=${API_KEY}&client_secret=${API_SECRET}`;
		expect(tokenFailureLog(422, leaked, [API_KEY, API_SECRET])).toEqual({
			message: "Mercado Bitcoin authentication failed",
			status: 422,
		});
		expect(
			tokenFailureLog(
				422,
				JSON.stringify({ code: API_KEY, message: `bad ${API_SECRET}`, data: { error: API_SECRET, message: "ok" } }),
				[API_KEY, API_SECRET],
			),
		).toEqual({
			message: "Mercado Bitcoin authentication failed",
			status: 422,
			data: { message: "ok" },
		});
	});
});
