import { MB_API_ORIGIN, MB_TOKEN_URL } from "./constants.js";

const API_PREFIX = "/api/v4/";

/**
 * Free-function wrapper around the global fetch.
 * Calling fetch as a method of another object throws "Illegal invocation" on Workers.
 * Outbound calls are limited to the Mercado Bitcoin host: GET under /api/v4/, or the
 * single POST to /oauth2/token.
 */
export async function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = toUrl(input);
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	if (!isAllowedOutbound(url, method)) {
		throw new Error("Refusing to request outside the Mercado Bitcoin API.");
	}
	return fetch(input, init);
}

export function isAllowedOutbound(url: URL, method: string): boolean {
	if (url.origin !== MB_API_ORIGIN || url.username !== "" || url.password !== "") return false;
	if (method === "GET") return url.pathname.startsWith(API_PREFIX);
	if (method === "POST") {
		return url.pathname === "/oauth2/token" && url.search === "" && url.hash === "" && `${url.origin}${url.pathname}` === MB_TOKEN_URL;
	}
	return false;
}

function toUrl(input: RequestInfo | URL): URL {
	if (typeof input === "string" || input instanceof URL) return new URL(input);
	return new URL(input.url);
}
