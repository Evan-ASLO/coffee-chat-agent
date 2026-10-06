import worker from "../src";
import tutorialReview from "./local-onboarding-preview";
import { applySecurityHeaders } from "../src/lib/http";
import type { AppBindings } from "../src/types";

type ReviewBindings = AppBindings & { LOCAL_CONTACTS_PREVIEW?: string };

globalThis.fetch = async () => {
	throw new Error("External requests are disabled in the fictional contacts review.");
};

function reviewResponse(response: Response): Response {
	const result = applySecurityHeaders(response);
	result.headers.set("X-Contacts-Review", "seeded-local-only");
	return result;
}

export default {
	async fetch(request: Request, env: ReviewBindings, context: ExecutionContext) {
		const url = new URL(request.url);
		if (env.LOCAL_CONTACTS_PREVIEW !== "true" || env.APP_ORIGIN !== "http://127.0.0.1:8805" || url.origin !== env.APP_ORIGIN) {
			return reviewResponse(new Response("Loopback contacts review only.", { status: 403 }));
		}
		if (url.pathname === "/__review/health" && request.method === "GET") {
			const row = await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM job_prospects WHERE user_id='10000000-0000-4000-8000-000000000808'",
			).first<{ count: number }>();
			const seeded = row?.count === 10;
			return reviewResponse(Response.json({ reviewOnly: true, seeded }, { status: seeded ? 200 : 503 }));
		}
		if (request.method === "GET" && /^\/__review\/(existing|new|second|denied|signed-out)$/.test(url.pathname)) {
			return reviewResponse(await tutorialReview.fetch(request, { ...env, LOCAL_TUTORIAL_PREVIEW: "true" }, context));
		}
		if (url.pathname.startsWith("/auth/") || (!["GET", "HEAD"].includes(request.method) &&
			!(request.method === "PUT" && url.pathname === "/api/onboarding"))) {
			return reviewResponse(Response.json({
				error: "REVIEW_ONLY",
				message: "Fictional review only. Discovery, provider calls, OAuth, keys, CRM, drafting, enrichment and sending are blocked. Browser tests mock explicit actions.",
			}, { status: 403 }));
		}
		return reviewResponse(url.pathname.startsWith("/api/")
			? await worker.fetch(request, env, context)
			: await env.ASSETS.fetch(request));
	},
};
