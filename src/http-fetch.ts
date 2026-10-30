/**
 * Free-function wrapper around the global fetch.
 * Calling fetch as a method of another object throws "Illegal invocation" on Workers.
 */
export function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, init);
}
