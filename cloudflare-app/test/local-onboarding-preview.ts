import worker from "../src";
import type { AppBindings } from "../src/types";
import { acceptVerifiedGoogleLogin } from "../src/lib/auth";
import { createSession } from "../src/lib/db";
import { randomToken, sha256 } from "../src/lib/encoding";

type ReviewBindings = AppBindings & { LOCAL_TUTORIAL_PREVIEW?: string };
const profiles = {
	new: { googleSub: "local-tutorial-new", email: "tutorial-new@example.test", name: "Fictional new reviewer", image: "" },
	existing: { googleSub: "local-tutorial-existing", email: "tutorial-existing@example.test", name: "Fictional existing reviewer", image: "" },
	second: { googleSub: "local-tutorial-second", email: "tutorial-second@example.test", name: "Fictional second reviewer", image: "" },
	denied: { googleSub: "local-tutorial-denied", email: "tutorial-denied@example.test", name: "Fictional denied reviewer", image: "" },
};

export default {
	async fetch(request: Request, env: ReviewBindings, context: ExecutionContext) {
		const url = new URL(request.url);
		if (env.LOCAL_TUTORIAL_PREVIEW !== "true" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
			return Response.json({ message: "This test entry point is loopback-only." }, { status: 403 });
		}
		if (url.pathname === "/__review/reset" && request.method === "POST") {
			const now = new Date().toISOString();
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE users SET onboarding_status=CASE WHEN google_sub='local-tutorial-existing' THEN 'legacy' ELSE 'invited' END,
					 onboarding_step='welcome',onboarding_revision=onboarding_revision+1,onboarding_updated_at=?
					 WHERE google_sub IN ('local-tutorial-new','local-tutorial-existing','local-tutorial-second')`,
				).bind(now),
				env.DB.prepare(
					"DELETE FROM encrypted_credentials WHERE user_id IN (SELECT id FROM users WHERE google_sub IN ('local-tutorial-new','local-tutorial-existing','local-tutorial-second'))",
				),
				env.DB.prepare(
					"DELETE FROM user_job_states WHERE user_id IN (SELECT id FROM users WHERE google_sub IN ('local-tutorial-new','local-tutorial-second'))",
				),
				env.DB.prepare(
					`UPDATE user_settings SET draft_provider='TEMPLATE',enrichment_provider='HUNTER',people_search_fallback_provider='NONE'
					 WHERE user_id IN (SELECT id FROM users WHERE google_sub IN ('local-tutorial-new','local-tutorial-existing','local-tutorial-second'))`,
				),
				env.DB.prepare(
					"UPDATE beta_access SET status='APPROVED',updated_at=? WHERE email IN ('tutorial-new@example.test','tutorial-existing@example.test','tutorial-second@example.test')",
				).bind(now),
			]);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__review/revoke-new" && request.method === "POST") {
			await env.DB.prepare("UPDATE beta_access SET status='REVOKED' WHERE email='tutorial-new@example.test'").run();
			return Response.json({ ok: true });
		}
		if (url.pathname.startsWith("/__review/") && request.method === "GET") {
			const choice = url.pathname.slice("/__review/".length);
			if (choice === "signed-out") {
				const headers = new Headers({ Location: "/" });
				headers.append("Set-Cookie", "cc_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
				headers.append("Set-Cookie", "cc_csrf=; Path=/; Max-Age=0; SameSite=Strict");
				return new Response(null, { status: 302, headers });
			}
			if (!(choice in profiles)) return Response.json({ message: "Unknown fictional review account." }, { status: 404 });
			const profile = profiles[choice as keyof typeof profiles];
			const user = await acceptVerifiedGoogleLogin(env, profile);
			if (!user) {
				const headers = new Headers({ Location: "/?access=requested" });
				headers.append("Set-Cookie", "cc_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
				headers.append("Set-Cookie", "cc_csrf=; Path=/; Max-Age=0; SameSite=Strict");
				return new Response(null, { status: 302, headers });
			}
			const token = randomToken();
			const csrf = randomToken();
			await createSession(env, user.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 7 * 86400000).toISOString());
			const headers = new Headers({ Location: "/" });
			headers.append("Set-Cookie", `cc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
			headers.append("Set-Cookie", `cc_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=604800`);
			return new Response(null, { status: 302, headers });
		}
		// This separate, non-deployed entry point cannot make billable or Google actions.
		if (
			url.pathname.startsWith("/auth/") ||
			url.pathname.startsWith("/api/internal/") ||
			(request.method !== "GET" && (
				url.pathname === "/api/discovery" ||
				url.pathname === "/api/workspace/init" ||
				url.pathname === "/api/resume" ||
				/^\/api\/prospects\/[^/]+\/(prepare|regenerate|send|sync)$/.test(url.pathname)
			))
		) {
			return Response.json({ error: "LOCAL_REVIEW_ONLY", message: "External discovery, provider analysis, Google authorization, CRM creation, and sending are disabled in this fictional local review." }, { status: 403 });
		}
		return worker.fetch(request, env, context);
	},
};
