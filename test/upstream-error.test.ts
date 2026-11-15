import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthManager, clearAuthManagerCache, tokenFailureLog } from "../src/auth.js";
import { MBClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { MB_API_BASE, MB_TOKEN_URL } from "../src/constants.js";
import { captureBody, describeUpstreamFailure } from "../src/upstream-error.js";
import { ACCESS_TOKEN, API_KEY, API_SECRET, invocationSensitiveFetch } from "./helpers.js";

afterEach(() => {
	clearAuthManagerCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const SECRETS = [API_KEY, API_SECRET, ACCESS_TOKEN];

describe("upstream failure diagnostics", () => {
	it("reports a plain Cloudflare error code, ray, and snippet", () => {
		const failure = describeUpstreamFailure({
			step: "token",
			status: 403,
			body: "error code: 1109\n",
			headers: new Headers({
				"content-type": "text/plain; charset=UTF-8",
				server: "cloudflare",
				"cf-ray": "a5b104b418e64544-IAD",
				"cf-mitigated": "block",
			}),
			secrets: SECRETS,
		});
		expect(failure.log).toEqual({
			message: "Mercado Bitcoin authentication failed",
			step: "token",
			status: 403,
			edge: "cloudflare",
			cloudflareError: "1109",
			cfRay: "a5b104b418e64544-IAD",
			cfMitigated: "block",
			contentType: "text/plain",
			server: "cloudflare",
			snippet: "error code: 1109",
		});
		expect(failure.message).toBe(
			"Mercado Bitcoin authentication failed at token exchange (HTTP 403, Cloudflare error 1109, cf-ray a5b104b418e64544-IAD). Body: error code: 1109",
		);
	});

	it("reads a Cloudflare challenge page that is larger than the old 8KB discard", async () => {
		const html =
			`<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>` +
			`${" ".repeat(8500)}error code: 1109 <!-- ${API_SECRET} ${API_KEY} ${ACCESS_TOKEN} -->` +
			`</body></html>`;
		expect(html.length).toBeGreaterThan(8192);

		const headers = new Headers({
			"content-type": "text/html; charset=UTF-8",
			server: "cloudflare",
			"cf-ray": "a5b104b418e64544-GRU",
			"cf-mitigated": "challenge",
		});
		const captured = await captureBody(new Response(html, { status: 403, headers }));
		expect(captured).toContain("error code: 1109");
		expect(captured).toContain(API_SECRET);

		const failure = describeUpstreamFailure({
			step: "api",
			status: 403,
			body: captured,
			headers,
			secrets: SECRETS,
		});
		expect(failure.log).toMatchObject({
			message: "Mercado Bitcoin API request failed",
			step: "api",
			status: 403,
			edge: "cloudflare",
			cloudflareError: "1109",
			cfRay: "a5b104b418e64544-GRU",
			cfMitigated: "challenge",
			contentType: "text/html",
			title: "Attention Required! | Cloudflare",
			snippet: "Attention Required! | Cloudflare",
		});
		expect(failure.message).toBe(
			"Mercado Bitcoin API request failed (HTTP 403, Cloudflare error 1109, cf-ray a5b104b418e64544-GRU). Body: Attention Required! | Cloudflare",
		);
		const printed = `${failure.message}\n${JSON.stringify(failure.log)}`;
		expect(printed).not.toContain(API_SECRET);
		expect(printed).not.toContain(API_KEY);
		expect(printed).not.toContain(ACCESS_TOKEN);
	});

	it("stops reading a huge body before the trailing marker", async () => {
		const marker = "END_MARKER_SHOULD_BE_DROPPED";
		const html = `<title>Attention Required! | Cloudflare</title>${"a".repeat(40_000)}${marker}`;
		const captured = await captureBody(new Response(html, { status: 403 }));
		expect(captured.startsWith("<title>Attention Required! | Cloudflare</title>")).toBe(true);
		expect(captured).not.toContain(marker);
		expect(captured.length).toBeLessThan(html.length);
	});

	it("reports an OAuth error and error_description that the old parser dropped", () => {
		const body = JSON.stringify({
			error: "invalid_client",
			error_description: "Client authentication failed",
			client_secret: API_SECRET,
		});
		expect(tokenFailureLog(401, body, SECRETS)).toEqual({
			message: "Mercado Bitcoin authentication failed",
			step: "token",
			status: 401,
			oauthError: "invalid_client",
			errorDescription: "Client authentication failed",
			snippet: "Client authentication failed",
		});
		expect(JSON.stringify(tokenFailureLog(401, body, SECRETS))).not.toContain(API_SECRET);
		expect(JSON.stringify(tokenFailureLog(401, body, SECRETS))).not.toContain("client_secret");
	});

	it("drops header values that are not a ray, a short code, or that contain a secret", () => {
		const failure = describeUpstreamFailure({
			step: "token",
			status: 302,
			body: "",
			headers: new Headers({
				"cf-ray": API_KEY,
				"cf-mitigated": API_SECRET,
				server: `cloudflare ${API_SECRET}`,
				location: `https://evil.example/?secret=${API_SECRET}`,
			}),
			secrets: SECRETS,
		});
		expect(failure.log).toEqual({
			message: "Mercado Bitcoin token endpoint redirected",
			step: "token",
			status: 302,
			redirect: true,
		});
		expect(failure.message).toBe(
			"Mercado Bitcoin authentication failed at token exchange (HTTP 302, redirect).",
		);
		expect(JSON.stringify(failure.log)).not.toContain(API_SECRET);
		expect(failure.message).not.toContain("evil.example");
	});

	it("returns the token-step diagnostic from AuthManager without the secret", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(
				async () =>
					new Response(`error code: 1109 ${API_SECRET}`, {
						status: 403,
						headers: {
							"content-type": "text/plain",
							server: "cloudflare",
							"cf-ray": "a5b104b418e64544-IAD",
						},
					}),
			),
		);
		const auth = new AuthManager(loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE));
		await expect(auth.getToken()).rejects.toThrow(
			"Mercado Bitcoin authentication failed at token exchange (HTTP 403, Cloudflare error 1109, cf-ray a5b104b418e64544-IAD). Body: error code: 1109",
		);
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain('"cloudflareError":"1109"');
		expect(logged).toContain('"step":"token"');
		expect(logged).not.toContain(API_SECRET);
		expect(logged).not.toContain(API_KEY);
	});

	it("returns the API-step diagnostic and does not echo the access token", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				if (String(input) === MB_TOKEN_URL) {
					return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
				}
				return new Response(
					`<!DOCTYPE html><title>Attention Required! | Cloudflare</title> ${ACCESS_TOKEN} error code: 1109`,
					{
						status: 403,
						headers: {
							"content-type": "text/html",
							"cf-ray": "a5b104b418e64544-IAD",
							"cf-mitigated": "challenge",
						},
					},
				);
			}),
		);
		const config = loadConfig({ MB_API_KEY: API_KEY, MB_API_SECRET: API_SECRET }, MB_API_BASE);
		const client = new MBClient(config, new AuthManager(config));
		await expect(client.authGet("/accounts")).rejects.toThrow(
			"Mercado Bitcoin API request failed (HTTP 403, Cloudflare error 1109, cf-ray a5b104b418e64544-IAD). Body: Attention Required! | Cloudflare",
		);
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain('"step":"api"');
		expect(logged).not.toContain(ACCESS_TOKEN);
		expect(logged).not.toContain(API_SECRET);
		expect(logged).not.toContain(API_KEY);
	});
});
