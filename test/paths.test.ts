import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthManager, clearAuthManagerCache } from "../src/auth.js";
import { MBClient } from "../src/client.js";
import { MB_API_BASE } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { apiPath, pathSegment, PathParamError } from "../src/paths.js";
import { invocationSensitiveFetch } from "./helpers.js";

afterEach(() => {
	clearAuthManagerCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("path parameters", () => {
	it("encodes an accepted segment and rejects traversal", () => {
		const spy = vi.spyOn(globalThis, "encodeURIComponent");
		expect(pathSegment("BTC-BRL", "symbol")).toBe(encodeURIComponent("BTC-BRL"));
		expect(spy).toHaveBeenCalledWith("BTC-BRL");
		for (const value of ["../admin", "..", ".", "a/b", "a\\b", "a%2f", "%2e%2e", "a?b", "a b", "", "a#b"]) {
			expect(() => pathSegment(value, "symbol")).toThrow(PathParamError);
		}
		expect(() => pathSegment("../admin", "symbol")).toThrow(/symbol is not a valid path parameter/);
	});

	it("builds a path only from validated segments", () => {
		expect(apiPath(["accounts", { value: "acc-1", name: "accountId" }, "balances"])).toBe("/accounts/acc-1/balances");
		expect(() => apiPath(["accounts", { value: "../oauth2", name: "accountId" }])).toThrow(PathParamError);
		expect(() => apiPath(["..", "oauth2"])).toThrow();
	});

	it("refuses a raw path that fetch would resolve with dot segments", async () => {
		const fetchImpl = invocationSensitiveFetch(() => Response.json({}));
		vi.stubGlobal("fetch", fetchImpl);
		const client = new MBClient(loadConfig({}, MB_API_BASE), new AuthManager(loadConfig({}, MB_API_BASE)));
		await expect(client.publicGet("/../oauth2/token")).rejects.toThrow(/unsafe/);
		await expect(client.publicGet("/accounts/..%2F..%2Foauth2")).rejects.toThrow(/unsafe/);
	});

	it("requests the encoded path and nothing above the API prefix", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch((input) => {
				calls.push(String(input));
				return Response.json({ asks: [], bids: [] });
			}),
		);
		const client = new MBClient(loadConfig({}, MB_API_BASE), new AuthManager(loadConfig({}, MB_API_BASE)));
		await client.publicGet(apiPath([{ value: "BTC-BRL", name: "symbol" }, "orderbook"]));
		expect(calls).toEqual(["https://api.mercadobitcoin.net/api/v4/BTC-BRL/orderbook"]);
	});
});
