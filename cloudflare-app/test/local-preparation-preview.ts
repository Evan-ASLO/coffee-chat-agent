import worker from "../src";
import contactsReview from "./local-contacts-preview";
import { createSession, findSession } from "../src/lib/db";
import { saveCredential } from "../src/lib/credentials";
import { randomToken, sha256 } from "../src/lib/encoding";
import { applySecurityHeaders } from "../src/lib/http";
import type { AppBindings } from "../src/types";

type ReviewBindings = AppBindings & { LOCAL_PREPARATION_PREVIEW?: string; LOCAL_CONTACTS_PREVIEW?: string };
const users = ["10000000-0000-4000-8000-000000000909", "10000000-0000-4000-8000-000000000910"];
const scenarios = ["success", "no-email", "draft-failed", "research-failed", "missing-key", "gate-disabled"];
let database: D1Database | undefined;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	if (!database) throw new Error("Local preparation mocks are not initialized.");
	const url = new URL(String(input));
	const headers = new Headers(init?.headers);
	const key = headers.get("x-api-key") || headers.get("authorization")?.replace(/^Bearer /, "") || "";
	const match = /^FAKE-PREPARATION-(APOLLO|TAVILY|OPENAI)-(10000000-0000-4000-8000-0000000009(?:09|10))$/.exec(key);
	if (!match || !users.includes(match[2]!)) throw new Error("Only fixed fictional credentials can use this mock. All real egress is blocked.");
	const [, provider, userId] = match;
	const allowed = {
		APOLLO: "https://api.apollo.io/api/v1/people/match",
		TAVILY: "https://api.tavily.com/search",
		OPENAI: "https://api.openai.com/v1/responses",
	};
	if (`${url.origin}${url.pathname}` !== allowed[provider as keyof typeof allowed]) throw new Error("Unmocked outbound destination is blocked.");
	const scenario = await database.prepare("SELECT scenario FROM local_preparation_review WHERE user_id=?").bind(userId!).first<{ scenario: string }>();
	await database.prepare("INSERT INTO local_preparation_calls(user_id,provider,created_at) VALUES(?,?,?)").bind(userId!, provider!, new Date().toISOString()).run();
	const person = await database.prepare("SELECT full_name,title,company,company_domain,linkedin_url FROM prospects WHERE user_id=? AND id IN ('30000000-0000-4000-8000-000000000909','30000000-0000-4000-8000-000000000910')")
		.bind(userId!).first<{ full_name: string; title: string; company: string; company_domain: string; linkedin_url: string }>();
	if (!person) throw new Error("The fictional contact fixture is missing.");
	if (provider === "APOLLO") {
		if (url.searchParams.get("name") !== person.full_name) throw new Error("Only the stored fictional identity can be enriched.");
		return Response.json({ person: {
			name: person.full_name, linkedin_url: person.linkedin_url, match_confidence: "high",
			email_status: "verified", email: scenario?.scenario === "no-email" ? null : `fictional.alex@${person.company_domain}`,
			organization: { name: person.company, primary_domain: person.company_domain },
			employment_history: [{ current: true, end_date: null, organization_name: person.company }],
		} });
	}
	if (provider === "TAVILY") {
		if (scenario?.scenario === "research-failed") return Response.json({ error: "Synthetic research failure." }, { status: 500 });
		return Response.json({ results: [{
			title: `${person.full_name} - public engineering profile`,
			url: `https://${person.company_domain}/team/fictional-alex`,
			content: `${person.full_name} is a ${person.title} at ${person.company}. Their professional project improves accessible developer tools.`,
		}] });
	}
	if (scenario?.scenario === "draft-failed") return Response.json({ error: "Synthetic drafting failure." }, { status: 500 });
	const text = JSON.stringify({
		subject: "Your early-career engineering work",
		body: `Your work on accessible developer tools at ${person.company} caught my attention. How did you choose your first engineering project? My coursework includes a genuine accessibility project. Would you be open to a 15-minute conversation about starting in this field?`,
		personalizationNotes: "FICTIONAL LOCAL MOCK: uses only the supplied public engineering evidence and the fictional sender's saved coursework. Never send this fixture.",
	});
	return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
};

async function marked(response: Response): Promise<Response> {
	let result = response;
	if (result.headers.get("Content-Type")?.includes("text/html")) {
		const html = (await result.text()).replace("<body>", '<body><aside class="notice warning" id="preparation-review-banner"><strong>FICTIONAL LOCAL REVIEW.</strong> Provider responses are deterministic mocks. Apollo is not authorized or live. Real keys, external services and sending are blocked.</aside>');
		const headers = new Headers(result.headers);
		headers.delete("Content-Length");
		headers.delete("Content-Encoding");
		result = new Response(html, { status: result.status, headers });
	}
	result = applySecurityHeaders(result);
	result.headers.set("X-Preparation-Review", "mock-only");
	result.headers.set("X-Contacts-Review", "seeded-local-only");
	return result;
}

export default {
	async fetch(request: Request, env: ReviewBindings, context: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (env.LOCAL_PREPARATION_PREVIEW !== "true" || url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1" || url.origin !== env.APP_ORIGIN) {
			return new Response("Loopback fictional preparation review only.", { status: 403 });
		}
		database = env.DB;
		if (["GET", "HEAD"].includes(request.method) &&
			!/^\/(?:api|auth|__review)(?:\/|$)/.test(url.pathname) && url.pathname !== "/logout") {
			return marked(await env.ASSETS.fetch(request));
		}
		if (request.method === "GET" && ["/__review/preparation", "/__review/preparation-second"].includes(url.pathname)) {
			const userId = users[url.pathname.endsWith("-second") ? 1 : 0]!;
			const token = randomToken();
			const csrf = randomToken();
			await createSession(env, userId, await sha256(token), await sha256(csrf), new Date(Date.now() + 604800000).toISOString());
			const headers = new Headers({ Location: "/#networking" });
			headers.append("Set-Cookie", `cc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
			headers.append("Set-Cookie", `cc_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=604800`);
			return marked(new Response(null, { status: 302, headers }));
		}
		const token = /(?:^|;\s*)cc_session=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
		const session = token ? await findSession(env, await sha256(token)) : null;
		const fixture = session && users.includes(session.user_id) ? session : null;
		if (url.pathname === "/__review/preparation/health") {
			const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM local_preparation_review").first<{ count: number }>();
			return marked(Response.json({ reviewOnly: true, mockOnly: true, seeded: row?.count === 2 }));
		}
		if (url.pathname === "/__review/preparation/receipt" && request.method === "GET" && fixture) {
			const calls = await env.DB.prepare("SELECT provider,COUNT(*) AS count FROM local_preparation_calls WHERE user_id=? GROUP BY provider")
				.bind(fixture.user_id).all<{ provider: string; count: number }>();
			return marked(Response.json({
				mockOnly: true, calls: calls.results.filter((row) => row.provider !== "SYNC_PROSPECT"),
				mockSyncMessages: calls.results.find((row) => row.provider === "SYNC_PROSPECT")?.count || 0,
			}));
		}
		if (url.pathname === "/__review/preparation/scenario" && request.method === "POST" && fixture) {
			if (request.headers.get("Origin") !== env.APP_ORIGIN ||
				await sha256(request.headers.get("X-CSRF-Token") || "") !== fixture.csrf_hash) {
				return marked(Response.json({ message: "Review control requires the same-origin fictional session and CSRF token." }, { status: 403 }));
			}
			const input = await request.json() as { scenario?: string; reset?: boolean };
			if (!scenarios.includes(input.scenario || "")) return marked(Response.json({ message: "Unknown mock scenario." }, { status: 400 }));
			await env.DB.prepare("UPDATE local_preparation_review SET scenario=? WHERE user_id=?").bind(input.scenario!, fixture.user_id).run();
			if (input.scenario === "missing-key") {
				await env.DB.prepare("DELETE FROM encrypted_credentials WHERE user_id=? AND provider='APOLLO'").bind(fixture.user_id).run();
			} else {
				await saveCredential({ ...env, ENABLE_APOLLO_ENRICHMENT: "true" }, {
					userId: fixture.user_id, provider: "APOLLO", value: `FAKE-PREPARATION-APOLLO-${fixture.user_id}`,
				});
			}
			if (input.reset === true) {
				await env.DB.batch([
					env.DB.prepare(`UPDATE prospects SET status='DISCOVERED',email='',email_confidence=0,subject='',draft_body='',
						draft_version=0,draft_hash='',personalization_notes='',contact_approved_at=NULL,draft_approved_at=NULL,
						error_code='',error_message='',preparation_json='{"version":1,"email":null,"research":null}'
						WHERE user_id=? AND id IN ('30000000-0000-4000-8000-000000000909','30000000-0000-4000-8000-000000000910')`).bind(fixture.user_id),
					env.DB.prepare("DELETE FROM local_preparation_calls WHERE user_id=?").bind(fixture.user_id),
					env.DB.prepare("DELETE FROM rate_limits WHERE user_id=? AND action='DRAFT'").bind(fixture.user_id),
				]);
			}
			return marked(Response.json({ mockOnly: true, scenario: input.scenario }));
		}
		if (fixture) {
			const scenario = await env.DB.prepare("SELECT scenario FROM local_preparation_review WHERE user_id=?").bind(fixture.user_id).first<{ scenario: string }>();
			const queue: AppBindings["MAIL_QUEUE"] = {
				async send(message) {
					if (message.type !== "SYNC_PROSPECT" || message.userId !== fixture.user_id ||
						message.prospectId !== fixture.user_id.replace(/^10000000/, "30000000")) {
						throw new Error("Only this fictional prospect's sync message can be recorded locally.");
					}
					await env.DB.prepare("INSERT INTO local_preparation_calls(user_id,provider,created_at) VALUES(?,'SYNC_PROSPECT',?)")
						.bind(fixture.user_id, new Date().toISOString()).run();
					return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
				},
				async metrics() { throw new Error("Real queue metrics are unavailable in this local review."); },
				async sendBatch() { throw new Error("Batch queues and Google delivery are blocked in this local review."); },
			};
			const bindings = { ...env, MAIL_QUEUE: queue, ENABLE_APOLLO_ENRICHMENT: scenario?.scenario === "gate-disabled" ? undefined : "true" };
			const safeMutation = (request.method === "POST" && /^\/api\/prospects\/[a-f0-9-]+\/(?:prepare|regenerate|preparation\/retry)$/.test(url.pathname)) ||
				(request.method === "PATCH" && /^\/api\/prospects\/[a-f0-9-]+\/draft$/.test(url.pathname)) ||
				(["PUT", "DELETE"].includes(request.method) && /^\/api\/jobs\/b{64}\/state$/.test(url.pathname)) ||
				(request.method === "PUT" && url.pathname === "/api/settings") ||
				(request.method === "PUT" && url.pathname === "/api/onboarding") || (request.method === "POST" && url.pathname === "/logout");
			if (url.pathname.startsWith("/auth/") || (!["GET", "HEAD"].includes(request.method) && !safeMutation)) {
				return marked(Response.json({ error: "REVIEW_ONLY", message: "Only fictional stored preparation and draft editing are enabled. Keys, discovery, OAuth, CRM, resume and sends are blocked." }, { status: 403 }));
			}
			return marked(url.pathname.startsWith("/api/") || url.pathname === "/logout"
				? await worker.fetch(request, bindings, context) : await env.ASSETS.fetch(request));
		}
		return marked(await contactsReview.fetch(request, env, context));
	},
};
