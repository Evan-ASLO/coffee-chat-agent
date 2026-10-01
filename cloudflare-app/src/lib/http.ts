import type { Context } from "hono";
import type { AppEnvironment } from "../types";
import { ClientInputError } from "./errors";

const securityHeaders: Record<string, string> = {
	"Content-Security-Policy": [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self' https://accounts.google.com",
		"img-src 'self' data: https://lh3.googleusercontent.com",
		"style-src 'self'",
		"script-src 'self'",
		"connect-src 'self'",
		"upgrade-insecure-requests",
	].join("; "),
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy":
		"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};

export function applySecurityHeaders(response: Response): Response {
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(securityHeaders)) {
		secured.headers.set(name, value);
	}
	secured.headers.set("Cache-Control", "no-store");
	return secured;
}

export function assertSameOrigin(c: Context<AppEnvironment>): void {
	const origin = c.req.header("Origin");
	if (!origin) throw new Error("Missing request origin.");
	const expected = new URL(c.env.APP_ORIGIN).origin;
	if (origin !== expected) throw new Error("Request origin is not allowed.");
}

export async function readJson<T>(
	c: Context<AppEnvironment>,
	maxBytes = 64 * 1024,
): Promise<T> {
	const contentLength = Number(c.req.header("Content-Length") || 0);
	if (contentLength > maxBytes) throw new Error("Request body is too large.");
	const text = await c.req.text();
	if (utf8Length(text) > maxBytes) throw new Error("Request body is too large.");
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error("Request body must be valid JSON.");
	}
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function publicError(error: unknown): {
	code: string;
	message: string;
	status: number;
} {
	if (error instanceof ClientInputError) {
		return {
			code: "INVALID_REQUEST",
			message: error.message,
			status: 400,
		};
	}
	const issues =
		error &&
		typeof error === "object" &&
		"issues" in error &&
		Array.isArray((error as { issues?: unknown[] }).issues)
			? (error as { issues: Array<{ message?: string }> }).issues
			: null;
	if (issues?.length) {
		return {
			code: "INVALID_REQUEST",
			message: issues[0]?.message || "Check the submitted fields.",
			status: 400,
		};
	}
	const message = error instanceof Error ? error.message : "Unexpected error.";
	if (
		message.includes("Unauthorized") ||
		message.includes("session") ||
		message.includes("authentication")
	) {
		return { code: "UNAUTHORIZED", message: "Sign in is required.", status: 401 };
	}
	if (
		message === "Missing request origin." ||
		message === "Request origin is not allowed." ||
		message === "CSRF validation failed." ||
		message.includes("forbidden")
	) {
		return { code: "FORBIDDEN", message: "The request was rejected.", status: 403 };
	}
	if (message.includes("rate limit")) {
		return {
			code: "RATE_LIMITED",
			message: "Too many requests. Please wait and try again.",
			status: 429,
		};
	}
	if (
		message.includes("required") ||
		message.includes("valid") ||
		message.includes("must") ||
		message.includes("not found")
	) {
		return { code: "INVALID_REQUEST", message, status: 400 };
	}
	return {
		code: "INTERNAL_ERROR",
		message: "The operation could not be completed.",
		status: 500,
	};
}
