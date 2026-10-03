import worker from "../../src/index";
import { applySecurityHeaders } from "../../src/lib/http";
import type { AppBindings } from "../../src/types";

// This fixture has no queue/cron handlers or network egress, even for accidental calls.
globalThis.fetch = async () => {
	throw new Error("External requests are disabled in the local layout review.");
};

function reviewResponse(response: Response): Response {
	const result = applySecurityHeaders(response);
	result.headers.set("X-Layout-Review", "seeded-local-only");
	return result;
}

export default {
	async fetch(request: Request, env: AppBindings, context: ExecutionContext) {
		const url = new URL(request.url);
		if (
			env.APP_ORIGIN !== "http://127.0.0.1:8804" ||
			url.hostname !== "127.0.0.1"
		) {
			return reviewResponse(new Response("Local review only.", { status: 403 }));
		}
		if (url.pathname === "/__review/health") {
			const result = await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM sessions WHERE id IN ('layout-session-normal', 'layout-session-empty', 'layout-session-long')",
			).first<{ count: number }>();
			const seeded = result?.count === 3;
			return reviewResponse(Response.json(
				{ reviewOnly: true, seeded },
				{ status: seeded ? 200 : 503 },
			));
		}
		if (url.pathname === "/__review/login" && request.method === "GET") {
			const scenario = url.searchParams.get("scenario") || "normal";
			if (!["normal", "empty", "long"].includes(scenario)) {
				return reviewResponse(new Response("Unknown review scenario.", { status: 400 }));
			}
			const headers = new Headers({ Location: "/" });
			headers.append(
				"Set-Cookie",
				`cc_session=layout-review-${scenario}; HttpOnly; SameSite=Lax; Path=/`,
			);
			headers.append("Set-Cookie", "cc_csrf=layout-review-csrf; SameSite=Lax; Path=/");
			return reviewResponse(new Response(null, { status: 303, headers }));
		}
		if (url.pathname === "/__review/logout" && request.method === "GET") {
			const headers = new Headers({ Location: "/" });
			headers.append("Set-Cookie", "cc_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/");
			headers.append("Set-Cookie", "cc_csrf=; Max-Age=0; SameSite=Lax; Path=/");
			return reviewResponse(new Response(null, { status: 303, headers }));
		}
		if (
			url.pathname.startsWith("/auth/") ||
			!["GET", "HEAD"].includes(request.method)
		) {
			return reviewResponse(
				Response.json(
					{
						error: "REVIEW_ONLY",
						message: "Local review only. OAuth, discovery, analysis, drafting, CRM creation and sending are disabled.",
					},
					{ status: 403 },
				),
			);
		}
		if (url.pathname.startsWith("/api/")) {
			return reviewResponse(await worker.fetch(request, env, context));
		}
		return reviewResponse(await env.ASSETS.fetch(request));
	},
};
