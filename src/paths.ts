/** One URL path segment: ASCII letters, digits, "_" and "-". No dots, slashes, or percent signs. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class PathParamError extends Error {
	constructor(name: string) {
		super(`${name} is not a valid path parameter.`);
		this.name = "PathParamError";
	}
}

export class UnsafePathError extends Error {
	constructor() {
		super("Refusing to request an unsafe Mercado Bitcoin API path.");
		this.name = "UnsafePathError";
	}
}

/**
 * Validate a caller-supplied path parameter and encode it.
 * The allowed alphabet is unchanged by encodeURIComponent; encoding still runs so a
 * future relaxation of the pattern cannot splice raw bytes into the path.
 */
export function pathSegment(value: string, name: string): string {
	if (!SEGMENT.test(value)) throw new PathParamError(name);
	return encodeURIComponent(value);
}

export function assertSafePath(path: string): void {
	if (!path.startsWith("/")) throw new UnsafePathError();
	const segments = path.slice(1).split("/");
	if (segments.length === 0 || segments.some((segment) => !SEGMENT.test(segment))) {
		throw new UnsafePathError();
	}
}

/** Build an absolute API path from static segments and validated caller parameters. */
export function apiPath(parts: Array<string | { readonly value: string; readonly name: string }>): string {
	const encoded = parts.map((part) => {
		if (typeof part === "string") {
			if (!SEGMENT.test(part)) throw new UnsafePathError();
			return part;
		}
		return pathSegment(part.value, part.name);
	});
	const path = `/${encoded.join("/")}`;
	assertSafePath(path);
	return path;
}
