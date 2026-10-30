import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthManager, clearAuthManagerCache } from "../src/auth.js";
import { MBClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { MB_API_BASE, MB_TOKEN_URL } from "../src/constants.js";
import { handleRequest } from "../src/http.js";
import { outboundBudget } from "../src/request-gate.js";
import {
	bearerKey,
	consumeBuckets,
	MemoryQuotaBook,
	MINUTE_MS,
	quotaScope,
	requestQuotaPolicy,
	retryAfterMs,
	validateBucketRequest,
	type WindowRow,
} from "../src/request-quota.js";
import {
	ACCESS_TOKEN,
	API_KEY,
	API_SECRET,
	invocationSensitiveFetch,
	jsonRpc,
	MCP_TOKEN,
	mcpRequest,
	testEnv,
} from "./helpers.js";

afterEach(() => {
	clearAuthManagerCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const CLIENT_A = "a".repeat(64);
const CLIENT_B = "b".repeat(64);

function merge(rows: WindowRow[], updates: WindowRow[]): WindowRow[] {
	const map = new Map(rows.map((row) => [row.bucket, row]));
	for (const row of updates) map.set(row.bucket, row);
	return [...map.values()];
}

describe("request quota", () => {
	const now = 1_700_000_060_000;

	it("allows the limit, then denies without incrementing, and resets on the next window", () => {
		const request = [{ key: "mcp:global", limit: 2, windowMs: MINUTE_MS }];
		const book = new MemoryQuotaBook();
		expect(book.consume(request, now).allowed).toBe(true);
		expect(book.consume(request, now + 10).allowed).toBe(true);
		const denied = book.consume(request, now + 20);
		expect(denied.allowed).toBe(false);
		expect(denied.limitedBy).toBe("mcp:global");
		expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
		expect(book.snapshot().find((row) => row.bucket === "mcp:global")?.count).toBe(2);

		const nextWindow = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
		const reset = book.consume(request, nextWindow);
		expect(reset.allowed).toBe(true);
		expect(book.snapshot().find((row) => row.bucket === "mcp:global")?.count).toBe(1);
	});

	it("stops one client at its own limit and the Worker at the global cap", () => {
		let rows: WindowRow[] = [];
		const client = (hash: string) => [
			{ key: `mcp:${hash}`, limit: 1, windowMs: MINUTE_MS },
			{ key: "mcp:global", limit: 2, windowMs: MINUTE_MS },
		];
		let result = consumeBuckets(rows, now, client(CLIENT_A));
		rows = merge(rows, result.rows);
		expect(result.decision.allowed).toBe(true);
		result = consumeBuckets(rows, now + 1, client(CLIENT_B));
		rows = merge(rows, result.rows);
		expect(result.decision.allowed).toBe(true);

		const sameClient = consumeBuckets(rows, now + 2, client(CLIENT_A));
		expect(sameClient.decision).toMatchObject({ allowed: false, limitedBy: `mcp:${CLIENT_A}` });
		expect(rows.find((row) => row.bucket === `mcp:${CLIENT_A}`)?.count).toBe(1);

		const globalOnly = [
			{ key: `mcp:${"c".repeat(64)}`, limit: 5, windowMs: MINUTE_MS },
			{ key: "mcp:global", limit: 2, windowMs: MINUTE_MS },
		];
		expect(consumeBuckets(rows, now + 3, globalOnly).decision.limitedBy).toBe("mcp:global");
	});

	it("holds an outbound bucket for Retry-After and does not extend the hold with a shorter one", () => {
		const book = new MemoryQuotaBook();
		book.block("mb:private", now + 30_000, now);
		const held = book.consume([{ key: "mb:private", limit: 3, windowMs: 1_000 }], now + 1_000);
		expect(held.allowed).toBe(false);
		expect(held.retryAfter).toBe(29);
		expect(book.snapshot()[0]?.count).toBe(0);

		book.block("mb:private", now + 5_000, now + 1_000);
		expect(book.snapshot()[0]?.blockedUntil).toBe(now + 30_000);

		const later = book.consume([{ key: "mb:private", limit: 3, windowMs: 1_000 }], now + 30_000);
		expect(later.allowed).toBe(true);
		expect(book.snapshot()[0]?.count).toBe(1);
	});

	it("reads Retry-After as seconds or an HTTP date, with a 1s to 2min cap", () => {
		expect(retryAfterMs(null, now)).toBe(1_000);
		expect(retryAfterMs("0", now)).toBe(1_000);
		expect(retryAfterMs("30", now)).toBe(30_000);
		expect(retryAfterMs("9999", now)).toBe(120_000);
		expect(retryAfterMs("not-a-date", now)).toBe(1_000);
		expect(retryAfterMs(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
	});

	it("falls back when the configured limits are missing or out of range", () => {
		expect(
			requestQuotaPolicy({
				RATE_LIMIT_PER_MINUTE: "0",
				RATE_LIMIT_GLOBAL_PER_MINUTE: "nope",
				MB_PUBLIC_PER_SECOND: "1000",
				MB_PRIVATE_PER_SECOND: "",
			}),
		).toEqual({
			perMinute: 60,
			globalPerMinute: 600,
			publicPerSecond: 1,
			privatePerSecond: 3,
			tokenPerSecond: 1,
		});
		expect(requestQuotaPolicy({ RATE_LIMIT_PER_MINUTE: "61", MB_PRIVATE_PER_SECOND: "10" })).toMatchObject({
			perMinute: 61,
			privatePerSecond: 10,
		});
	});

	it("hashes the bearer token and never uses the raw token as a bucket", async () => {
		const hash = await bearerKey(MCP_TOKEN);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toContain(MCP_TOKEN);
		expect(await bearerKey(MCP_TOKEN)).toBe(hash);
		expect(await bearerKey(`${MCP_TOKEN}x`)).not.toBe(hash);
		expect(quotaScope(`mcp:${hash}`)).toBe("client");
		expect(quotaScope("mcp:global")).toBe("global");
		expect(() => validateBucketRequest({ key: `mcp:${MCP_TOKEN}`, limit: 1, windowMs: MINUTE_MS })).toThrow(/bucket/);
	});

	it("keeps the free-plan SQLite migration and does not add a paid rate-limit binding", () => {
		const wrangler = readFileSync("wrangler.jsonc", "utf8");
		expect(wrangler).toContain('"tag": "v1"');
		expect(wrangler).toContain('"tag": "v2"');
		expect(wrangler).toContain('"AuthRateLimit"');
		expect(wrangler).toContain('"RequestRateLimit"');
		expect(wrangler).not.toMatch(/ratelimits|kv_namespaces|r2_buckets/);
	});
});

describe("authenticated MCP limit", () => {
	it("returns 429 with Retry-After and does not run the handler again", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const env = testEnv({ RATE_LIMIT_PER_MINUTE: "1" });
		const mcp = async () => {
			calls += 1;
			return new Response("ok");
		};
		const first = await handleRequest(mcpRequest({ token: MCP_TOKEN }), env, mcp);
		const second = await handleRequest(mcpRequest({ token: MCP_TOKEN }), env, mcp);

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(Number(second.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(Number(second.headers.get("retry-after"))).toBeLessThanOrEqual(60);
		const body = await second.json();
		expect(body).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32029, message: "Too many requests. Try again later." },
		});
		expect(calls).toBe(1);
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain('"scope":"client"');
		expect(logged).not.toContain(MCP_TOKEN);
		expect(JSON.stringify(body)).not.toContain(MCP_TOKEN);
	});

	it("does not count health checks or rejected bearer tokens", async () => {
		let consumes = 0;
		const book = new MemoryQuotaBook();
		const env = testEnv({
			RATE_LIMIT_PER_MINUTE: "1",
			REQUEST_RATE_LIMIT: {
				getByName() {
					return {
						consume(requests) {
							consumes += 1;
							return book.consume(requests);
						},
						block(key, untilMs) {
							book.block(key, untilMs);
						},
					};
				},
			},
		});
		const health = await handleRequest(
			new Request("https://mercado-bitcoin-mcp.example.workers.dev/health"),
			env,
			async () => {
				throw new Error("handler should not run");
			},
		);
		const denied = await handleRequest(mcpRequest({ token: "not-the-token" }), env, async () => new Response("no"));
		const allowed = await handleRequest(mcpRequest({ token: MCP_TOKEN }), env, async () => new Response("yes"));
		expect(health.status).toBe(200);
		expect(denied.status).toBe(401);
		expect(allowed.status).toBe(200);
		expect(await allowed.text()).toBe("yes");
		expect(consumes).toBe(1);
		const keys = book.snapshot().map((row) => row.bucket);
		expect(keys.some((key) => key.startsWith("mcp:") && key !== "mcp:global")).toBe(true);
		expect(keys.join(" ")).not.toContain(MCP_TOKEN);
		expect(keys.join(" ")).not.toContain("not-the-token");
	});

	it("fails closed when the quota object is down", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let called = false;
		const env = testEnv({
			REQUEST_RATE_LIMIT: {
				getByName() {
					return {
						consume() {
							throw new Error("do down");
						},
						block() {},
					};
				},
			},
		});
		const response = await handleRequest(mcpRequest({ token: MCP_TOKEN }), env, async () => {
			called = true;
			return new Response("ok");
		});
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: "Request limiting is unavailable." },
		});
		expect(called).toBe(false);
		expect(errors.mock.calls.map((args) => args.join(" ")).join("\n")).not.toContain(MCP_TOKEN);
	});

	it("limits initialize before any Mercado Bitcoin call", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls.push(String(input));
				return Response.json({});
			}),
		);
		const env = testEnv({ RATE_LIMIT_PER_MINUTE: "1" });
		const body = jsonRpc("initialize", 1, {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "limit-check", version: "0" },
		});
		const first = await handleRequest(mcpRequest({ token: MCP_TOKEN, body }), env);
		const second = await handleRequest(mcpRequest({ token: MCP_TOKEN, body }), env);
		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(calls).toEqual([]);
	});
});

describe("Mercado Bitcoin outbound limit", () => {
	it("stops a second private read without another fetch", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls += 1;
				if (String(input) === MB_TOKEN_URL) return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3599 });
				return Response.json([{ id: "acc-1" }]);
			}),
		);
		const env = testEnv({ MB_PRIVATE_PER_SECOND: "1" });
		const budget = outboundBudget(env);
		const auth = new AuthManager(loadConfig(env, MB_API_BASE));
		auth.useOutbound(budget);
		const client = new MBClient(loadConfig(env, MB_API_BASE), auth, budget);

		await expect(client.authGet("/accounts")).resolves.toEqual([{ id: "acc-1" }]);
		await expect(client.authGet("/accounts")).rejects.toThrow(/private limit reached/);
		expect(calls).toBe(2);
	});

	it("remembers a 429 Retry-After and does not call Mercado Bitcoin again", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls += 1;
				if (String(input) === MB_TOKEN_URL) return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3599 });
				return Response.json(
					{ code: "HUH429", message: "slow down", data: { error: "rate_limit" } },
					{ status: 429, headers: { "retry-after": "30" } },
				);
			}),
		);
		const env = testEnv();
		const budget = outboundBudget(env);
		const auth = new AuthManager(loadConfig(env, MB_API_BASE));
		auth.useOutbound(budget);
		const client = new MBClient(loadConfig(env, MB_API_BASE), auth, budget);

		await expect(client.authGet("/accounts")).rejects.toThrow(/HTTP 429/);
		await expect(client.authGet("/accounts")).rejects.toThrow(/private limit reached\. Retry after/);
		expect(calls).toBe(2);
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).not.toContain(API_SECRET);
		expect(logged).not.toContain(API_KEY);
		expect(logged).not.toContain(ACCESS_TOKEN);
	});

	it("caps public reads at one per second", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json([]);
			}),
		);
		const env = testEnv({ MB_PUBLIC_PER_SECOND: "1" });
		const client = new MBClient(loadConfig(env, MB_API_BASE), new AuthManager(loadConfig(env, MB_API_BASE)), outboundBudget(env));
		await expect(client.publicGet("/symbols")).resolves.toEqual([]);
		await expect(client.publicGet("/symbols")).rejects.toThrow(/public limit reached/);
		expect(calls).toBe(1);
	});

	it("does not retry a token 429", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json(
					{ code: "HUH429", message: "slow down", data: { error: "rate_limit" } },
					{ status: 429, headers: { "retry-after": "30" } },
				);
			}),
		);
		const env = testEnv();
		const auth = new AuthManager(loadConfig(env, MB_API_BASE));
		auth.useOutbound(outboundBudget(env));
		await expect(auth.getToken()).rejects.toThrow(/authentication failed/);
		await expect(auth.getToken()).rejects.toThrow(/token limit reached/);
		expect(calls).toBe(1);
	});
});
