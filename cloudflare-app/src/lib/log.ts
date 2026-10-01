const forbiddenKey = /(authorization|cookie|token|secret|api.?key|password)/i;

export function safeMetadata(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			forbiddenKey.test(key) ? "[REDACTED]" : sanitize(item),
		]),
	);
}

function sanitize(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > 500 ? `${value.slice(0, 500)}…` : value;
	}
	if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
	if (value && typeof value === "object") {
		return safeMetadata(value as Record<string, unknown>);
	}
	return value;
}

export function logEvent(
	level: "info" | "warn" | "error",
	event: string,
	metadata: Record<string, unknown>,
): void {
	console[level](
		JSON.stringify({
			event,
			...safeMetadata(metadata),
			timestamp: new Date().toISOString(),
		}),
	);
}
