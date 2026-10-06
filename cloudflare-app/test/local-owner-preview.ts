import worker from "../src";
import type { AppBindings } from "../src/types";
import { applySecurityHeaders } from "../src/lib/http";
import { createSession } from "../src/lib/db";
import { randomToken, sha256 } from "../src/lib/encoding";

type ReviewBindings = AppBindings & { LOCAL_OWNER_PREVIEW?: string };
const accounts = {
	owner: "10000000-0000-4000-8000-000000000808",
	member: "10000000-0000-4000-8000-000000000809",
};

globalThis.fetch = async () => {
	throw new Error("External requests are disabled in the fictional owner review.");
};

function response(result: Response): Response {
	const secured = applySecurityHeaders(result);
	secured.headers.set("X-Owner-Review", "fictional-local-only");
	return secured;
}

export default {
	async fetch(request: Request, env: ReviewBindings, context: ExecutionContext) {
		const url = new URL(request.url);
		if (env.LOCAL_OWNER_PREVIEW !== "true" || env.APP_ORIGIN !== "http://127.0.0.1:8806" ||
			url.origin !== env.APP_ORIGIN || env.BETA_ADMIN_EMAILS !== "owner-activity@example.test") {
			return response(new Response("Loopback fictional owner review only.", { status: 403 }));
		}
		if (url.pathname === "/__review/health" && request.method === "GET") {
			const seed = await env.DB.prepare(
				"SELECT COUNT(*) AS count FROM users WHERE google_sub LIKE 'local-owner-%'",
			).first<{ count: number }>();
			const ready = Boolean(seed && seed.count >= 24);
			return response(Response.json({ reviewOnly: true, ready }, { status: ready ? 200 : 503 }));
		}
		if (request.method === "GET" && /^\/__review\/(owner|member|signed-out)$/.test(url.pathname)) {
			const choice = url.pathname.slice("/__review/".length);
			const headers = new Headers({ Location: choice === "signed-out" ? "/" : "/#settings" });
			if (choice === "signed-out") {
				headers.append("Set-Cookie", "cc_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
				headers.append("Set-Cookie", "cc_csrf=; Path=/; Max-Age=0; SameSite=Strict");
			} else {
				const id = accounts[choice as keyof typeof accounts];
				const account = await env.DB.prepare(
					"SELECT id FROM users WHERE id=? AND google_sub LIKE 'local-owner-%' AND email LIKE '%@example.test'",
				).bind(id).first<{ id: string }>();
				if (!account) return response(new Response("Fictional account is not seeded.", { status: 503 }));
				const token = randomToken();
				const csrf = randomToken();
				await createSession(env, account.id, await sha256(token), await sha256(csrf),
					new Date(Date.now() + 7 * 86_400_000).toISOString());
				headers.append("Set-Cookie", `cc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
				headers.append("Set-Cookie", `cc_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=604800`);
			}
			return response(new Response(null, { status: 302, headers }));
		}
		const betaMutation = request.method === "POST" && (
			url.pathname === "/api/beta/admin/requests/approve-pending" ||
			/^\/api\/beta\/admin\/requests\/[a-f0-9-]{36}\/(approve|deny)$/.test(url.pathname) ||
			/^\/api\/beta\/admin\/access\/(approve|revoke)$/.test(url.pathname)
		);
		if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/__review/") ||
			(!["GET", "HEAD"].includes(request.method) && !betaMutation && url.pathname !== "/logout")) {
			return response(Response.json({
				error: "REVIEW_ONLY",
				message: "Fictional review only. OAuth, providers, discovery, enrichment, drafting, credentials, CRM, ingestion and sending are blocked.",
			}, { status: 403 }));
		}
		if (betaMutation && url.pathname.startsWith("/api/beta/admin/access/")) {
			let input: unknown;
			try {
				input = await request.clone().json();
			} catch {
				return response(Response.json({ error: "INVALID_REQUEST", message: "Enter a fictional email." }, { status: 400 }));
			}
			if (!input || typeof input !== "object" || !("email" in input) ||
				typeof input.email !== "string" || !/^[a-z0-9.+_-]+@example\.test$/i.test(input.email)) {
				return response(Response.json({ error: "REVIEW_ONLY", message: "Only fictional example.test emails are allowed in this local review." }, { status: 403 }));
			}
		}
		return response(url.pathname.startsWith("/api/") || url.pathname === "/logout"
			? await worker.fetch(request, env, context)
			: await env.ASSETS.fetch(request));
	},
};
