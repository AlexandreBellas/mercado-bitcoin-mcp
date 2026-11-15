const BODY_CAPTURE_LIMIT = 24_576;

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,32}$/;
const CF_RAY = /^[0-9a-f]{16}(?:-[A-Za-z0-9]{2,4})?$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const CF_ERROR = /error\s*code\s*[:=]\s*(\d{3,5})/i;
const CF_ERROR_TAG = /cf-error-code[^>]*>\s*(\d{3,5})\b/i;
const HTML_TITLE = /<title>\s*([^<]{1,120}?)\s*<\/title>/i;

export type UpstreamStep = "token" | "api";

export interface UpstreamFailure {
	log: Record<string, unknown>;
	message: string;
}

/** Replaces known secrets and bearer tokens. The raw secret never stays in the text. */
export function redactSecrets(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		out = out.split(secret).join("[redacted]");
	}
	return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

/**
 * Reads at most 24KB of an upstream body. Cloudflare challenge pages are larger
 * than the old 8KB cutoff, which used to discard them entirely.
 */
export async function captureBody(res: Response): Promise<string> {
	const stream = res.body;
	if (!stream) {
		try {
			return (await res.text()).slice(0, BODY_CAPTURE_LIMIT);
		} catch {
			return "";
		}
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let out = "";
	let total = 0;
	try {
		while (total < BODY_CAPTURE_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			const remaining = BODY_CAPTURE_LIMIT - total;
			const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			total += slice.byteLength;
			out += decoder.decode(slice, { stream: true });
			if (slice.byteLength < value.byteLength) break;
		}
		out += decoder.decode();
		return out;
	} catch {
		return out;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The stream is already finished.
		}
	}
}

/**
 * Safe diagnostic for a failed Mercado Bitcoin call. The log and the message
 * include the step, HTTP status, a Cloudflare or JSON error code, and a short
 * snippet. They never include the raw body, a secret, or an access token.
 */
export function describeUpstreamFailure(input: {
	step: UpstreamStep;
	status: number;
	body: string;
	headers?: Headers;
	secrets: string[];
}): UpstreamFailure {
	const { step, status, body, headers, secrets } = input;
	const redirect = status >= 300 && status < 400;
	const trimmed = body.trimStart();
	const jsonBody = trimmed.startsWith("{") || trimmed.startsWith("[");
	const contentType = mediaType(headers?.get("content-type"), secrets);
	const server = publicText(headers?.get("server"), secrets);
	const cfRay = publicRay(headers?.get("cf-ray"), secrets);
	const cfMitigated = publicCode(headers?.get("cf-mitigated"), secrets);

	let cloudflareError: string | undefined;
	let title: string | undefined;
	if (!jsonBody) {
		const redacted = redactSecrets(body, secrets);
		cloudflareError = safeCode(CF_ERROR.exec(redacted)?.[1] ?? CF_ERROR_TAG.exec(redacted)?.[1], secrets);
		title = publicText(HTML_TITLE.exec(redacted)?.[1], secrets);
	}

	const parsed = jsonBody ? parseJsonFields(body, secrets) : {};
	const looksHtml = contentType === "text/html" || trimmed.startsWith("<");
	const edge =
		cloudflareError !== undefined || (looksHtml && /cloudflare/i.test(redactSecrets(body, secrets)));

	const snippet = pickSnippet(body, secrets, {
		json: parsed,
		title,
		cloudflareError,
		plain: !jsonBody && !looksHtml,
	});

	const log: Record<string, unknown> = {
		message:
			redirect && step === "token"
				? "Mercado Bitcoin token endpoint redirected"
				: step === "token"
					? "Mercado Bitcoin authentication failed"
					: "Mercado Bitcoin API request failed",
		step,
		status,
	};
	if (redirect) log.redirect = true;
	if (edge) log.edge = "cloudflare";
	if (cloudflareError) log.cloudflareError = cloudflareError;
	if (cfRay) log.cfRay = cfRay;
	if (cfMitigated) log.cfMitigated = cfMitigated;
	if (contentType) log.contentType = contentType;
	if (server) log.server = server;
	if (title) log.title = title;
	if (parsed.code) log.code = parsed.code;
	if (parsed.mbMessage) log.mbMessage = parsed.mbMessage;
	if (parsed.oauthError) log.oauthError = parsed.oauthError;
	if (parsed.errorDescription) log.errorDescription = parsed.errorDescription;
	if (parsed.data) log.data = parsed.data;
	if (snippet) log.snippet = snippet;

	return { log, message: failureMessage(step, status, log) };
}

function failureMessage(step: UpstreamStep, status: number, log: Record<string, unknown>): string {
	const lead =
		step === "token"
			? "Mercado Bitcoin authentication failed at token exchange"
			: "Mercado Bitcoin API request failed";
	const facts = [`HTTP ${status}`];
	if (log.redirect === true) facts.push("redirect");
	if (typeof log.cloudflareError === "string") facts.push(`Cloudflare error ${log.cloudflareError}`);
	else if (log.edge === "cloudflare") facts.push("Cloudflare block");
	if (typeof log.code === "string") facts.push(`code ${log.code}`);
	if (typeof log.oauthError === "string" && log.oauthError !== log.code) facts.push(`error ${log.oauthError}`);
	if (typeof log.mbMessage === "string" && log.mbMessage !== log.snippet) facts.push(log.mbMessage);
	const dataError = dataField(log.data, "error");
	if (dataError && dataError !== log.code && dataError !== log.oauthError) facts.push(`error ${dataError}`);
	if (typeof log.cfRay === "string") facts.push(`cf-ray ${log.cfRay}`);
	let message = `${lead} (${facts.join(", ")}).`;
	if (typeof log.snippet === "string") message += ` Body: ${log.snippet}`;
	return message;
}

function dataField(data: unknown, key: string): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

interface JsonFields {
	code?: string;
	mbMessage?: string;
	oauthError?: string;
	errorDescription?: string;
	data?: { error?: string; message?: string };
}

function parseJsonFields(body: string, secrets: string[]): JsonFields {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const obj = parsed as Record<string, unknown>;
	const fields: JsonFields = {};
	const code = publicCode(obj.code, secrets);
	if (code) fields.code = code;
	const mbMessage = publicText(obj.message, secrets);
	if (mbMessage) fields.mbMessage = mbMessage;
	const oauthError = publicCode(obj.error, secrets);
	if (oauthError) fields.oauthError = oauthError;
	const errorDescription = publicText(obj.error_description, secrets);
	if (errorDescription) fields.errorDescription = errorDescription;

	if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
		const data = obj.data as Record<string, unknown>;
		const error = publicCode(data.error, secrets);
		const dataMessage = publicText(data.message, secrets);
		if (error || dataMessage) {
			fields.data = {
				...(error ? { error } : {}),
				...(dataMessage ? { message: dataMessage } : {}),
			};
		}
	}
	return fields;
}

function pickSnippet(
	body: string,
	secrets: string[],
	parts: { json: JsonFields; title?: string; cloudflareError?: string; plain: boolean },
): string | undefined {
	const bodyHasSecret = containsSecret(body, secrets);
	if (parts.plain && !bodyHasSecret) {
		const plain = publicText(body.replace(/\s+/g, " "), secrets);
		if (plain) return plain;
	}
	const dataMessage = parts.json.data?.message;
	if (dataMessage) return dataMessage;
	if (parts.json.errorDescription) return parts.json.errorDescription;
	if (parts.json.mbMessage) return parts.json.mbMessage;
	if (parts.title) return parts.title;
	if (parts.cloudflareError) return `error code: ${parts.cloudflareError}`;
	return undefined;
}

function mediaType(value: string | null | undefined, secrets: string[]): string | undefined {
	if (!value) return undefined;
	const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!MEDIA_TYPE.test(type) || type.length > 64) return undefined;
	if (containsSecret(type, secrets)) return undefined;
	return type;
}

function publicRay(value: string | null | undefined, secrets: string[]): string | undefined {
	if (!value) return undefined;
	const ray = value.trim();
	if (!CF_RAY.test(ray)) return undefined;
	if (containsSecret(ray, secrets)) return undefined;
	return ray;
}

function safeCode(value: string | undefined, secrets: string[]): string | undefined {
	return publicCode(value, secrets);
}

function publicCode(value: unknown, secrets: string[]): string | undefined {
	if (typeof value !== "string" || !SAFE_CODE.test(value)) return undefined;
	if (containsSecret(value, secrets)) return undefined;
	return value;
}

function publicText(value: unknown, secrets: string[]): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length === 0 || text.length > 200) return undefined;
	if (text.includes("=") || text.includes("\n") || text.includes("\r")) return undefined;
	if (/[A-Za-z0-9+/=_-]{32,}/.test(text)) return undefined;
	if (containsSecret(text, secrets)) return undefined;
	return text;
}

function containsSecret(value: string, secrets: string[]): boolean {
	return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}
