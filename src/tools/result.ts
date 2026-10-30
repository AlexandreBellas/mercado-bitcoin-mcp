import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { hasCredentials } from "../config.js";

export const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

export function ok(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

export function requireCredentials(config: Config): CallToolResult | null {
	if (hasCredentials(config)) return null;
	return err(
		"This read requires Mercado Bitcoin credentials. Set the MB_API_KEY and MB_API_SECRET Worker secrets to a read-only (Leitura) API key.",
	);
}

export async function read(fn: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		return ok(await fn());
	} catch (error) {
		const message = error instanceof Error ? error.message : "Request failed.";
		return err(message);
	}
}

export function query(value: string | number | boolean | undefined): string | undefined {
	if (value === undefined) return undefined;
	return String(value);
}
