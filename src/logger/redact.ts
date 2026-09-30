export interface RedactionOptions {
	extraSecretKeys?: (normalizedKey: string) => boolean;
	extraValuePatterns?: RegExp[];
}

const SECRET_KEY_EXACT =
	/^(authorization|x-api-key|cookie|set-cookie|refresh|access|token)$/i;
const TOKEN_VALUE =
	/\b(Bearer\s+[\w.-]+|sk-[\w-]+|eyJ[\w.-]+)\b|ckh_[A-Za-z0-9_-]{20,}/g;
const MASK = "***REDACTED***";

export function createRedactor(options: RedactionOptions = {}) {
	const patterns = [TOKEN_VALUE, ...(options.extraValuePatterns ?? [])].map(
		(pattern) =>
			new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			),
	);
	function isSecretKey(key: string): boolean {
		const normalized = key.toLowerCase().replace(/[-_]/g, "");
		return (
			SECRET_KEY_EXACT.test(key) ||
			normalized.includes("apikey") ||
			normalized.endsWith("secret") ||
			normalized.endsWith("password") ||
			(normalized.endsWith("token") && !normalized.endsWith("tokens")) ||
			!!options.extraSecretKeys?.(normalized)
		);
	}
	function walk(value: unknown, keys: boolean, seen: WeakSet<object>): unknown {
		if (typeof value === "string") {
			return patterns.reduce(
				(text, pattern) => text.replace(pattern, MASK),
				value,
			);
		}
		if (!value || typeof value !== "object") return value;
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		try {
			if (Array.isArray(value))
				return value.map((item) => walk(item, keys, seen));
			// Define own properties so a diagnostic __proto__ key cannot change the output prototype.
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					keys && isSecretKey(key) ? MASK : walk(item, keys, seen),
				]),
			);
		} finally {
			seen.delete(value);
		}
	}
	return {
		redact: (value: unknown): unknown => walk(value, true, new WeakSet()),
		// Schema keys describe arguments, not credentials; only their string values are scrubbed.
		redactStrings: (value: unknown): unknown =>
			walk(value, false, new WeakSet()),
	};
}

export type Redactor = ReturnType<typeof createRedactor>;
const defaultRedactor = createRedactor();
export const redact = defaultRedactor.redact;
export const redactStrings = defaultRedactor.redactStrings;
