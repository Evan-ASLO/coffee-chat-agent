interface JsonRequest {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
	attempts?: number;
}

const allowedHosts = new Set([
	"api.tavily.com",
	"api.hunter.io",
	"generativelanguage.googleapis.com",
	"api.openai.com",
	"api.anthropic.com",
	"oauth2.googleapis.com",
	"gmail.googleapis.com",
	"sheets.googleapis.com",
]);

export async function fetchJson<T>(
	url: string,
	options: JsonRequest = {},
): Promise<T> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
		throw new Error("Outbound destination is not allowed.");
	}
	const attempts = Math.min(Math.max(options.attempts ?? 2, 1), 4);
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			Math.min(Math.max(options.timeoutMs ?? 15000, 1000), 30000),
		);
		try {
			const response = await fetch(url, {
				method: options.method ?? (options.body === undefined ? "GET" : "POST"),
				headers: {
					Accept: "application/json",
					...(options.body === undefined
						? {}
						: { "Content-Type": "application/json" }),
					...options.headers,
				},
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				const retryable = [429, 500, 502, 503, 504].includes(response.status);
				if (retryable && attempt < attempts) {
					await sleep(300 * 2 ** (attempt - 1));
					continue;
				}
				throw new Error(
					`Provider request failed with HTTP ${response.status}: ${safeProviderMessage(text)}`,
				);
			}
			return text ? (JSON.parse(text) as T) : ({} as T);
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error("Provider request failed.");
			if (
				attempt >= attempts ||
				(!lastError.message.includes("aborted") &&
					!lastError.message.includes("HTTP 5") &&
					!lastError.message.includes("HTTP 429"))
			) {
				throw lastError;
			}
			await sleep(300 * 2 ** (attempt - 1));
		} finally {
			clearTimeout(timeout);
		}
	}
	throw lastError ?? new Error("Provider request failed.");
}

export async function fetchForm<T>(
	url: string,
	body: URLSearchParams,
	options: Omit<JsonRequest, "body"> = {},
): Promise<T> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
		throw new Error("Outbound destination is not allowed.");
	}
	const response = await fetch(url, {
		method: options.method ?? "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			...options.headers,
		},
		body,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Provider request failed with HTTP ${response.status}: ${safeProviderMessage(text)}`,
		);
	}
	return text ? (JSON.parse(text) as T) : ({} as T);
}

function safeProviderMessage(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim().slice(0, 500);
	return compact
		.replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(/tvly-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
