import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { createSession, upsertUser } from "../src/lib/db";
import { sha256 } from "../src/lib/encoding";
import type { AppBindings } from "../src/types";

const bindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN", BETA_ADMIN_EMAILS: "owner@example.test" };
let member: Awaited<ReturnType<typeof auth>>;
let owner: Awaited<ReturnType<typeof auth>>;
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});
beforeEach(async () => { await env.DB.prepare("DELETE FROM bug_reports").run(); member = await auth(`${crypto.randomUUID()}@example.test`); owner = await auth("owner@example.test"); });
async function auth(email: string) {
	const user = await upsertUser(bindings, { googleSub: email === "owner@example.test" ? "fixture-bug-owner" : crypto.randomUUID(), email, name: "Fictional reporter", image: "" });
	const token = crypto.randomUUID(), csrf = crypto.randomUUID();
	await createSession(bindings, user.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 3600000).toISOString());
	return { user, csrf, cookie: `cc_session=${token}; cc_csrf=${csrf}` };
}
function input() {
	return { summary: "People link did not load", description: "Clicking People to contact did not open the selected role.", page: "networking", submissionKey: crypto.randomUUID(), expectedUserId: member.user.id };
}
async function call(url: string, who: typeof member | null, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
	const context = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${url}`, {
		method, headers: { Origin: bindings.APP_ORIGIN, "Content-Type": "application/json", ...(who ? { Cookie: who.cookie, "X-CSRF-Token": who.csrf } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), bindings, context);
	await waitOnExecutionContext(context);
	return response;
}
describe("private persisted bug reporting", () => {
	it("persists reports, returns an idempotent receipt and reveals text only in the owner inbox", async () => {
		const body = input();
		const submitted = await call("/api/bug-reports", member, "POST", body);
		expect(submitted.status).toBe(200);
		const first = await submitted.json<{ receipt: { id: string; createdAt: string } }>();
		expect(await (await call("/api/bug-reports", member, "POST", body)).json()).toEqual(first);
		expect((await call("/api/beta/admin/bug-reports", member)).status).toBe(403);
		const inbox = await (await call("/api/beta/admin/bug-reports", owner)).json<{ reports: Array<{ id: string; summary: string; description: string; reporter: { id: string; email: string } }> }>();
		expect(inbox.reports.find((report) => report.id === first.receipt.id)).toMatchObject({
			summary: body.summary, description: body.description, reporter: { id: member.user.id, email: member.user.email },
		});
		const repeat = await (await call("/api/beta/admin/bug-reports", owner)).json();
		expect(repeat).toEqual(inbox);
		expect((await env.DB.prepare("SELECT COUNT(*) AS total FROM bug_reports WHERE user_id=?").bind(member.user.id).first<{ total: number }>())?.total).toBe(1);
		expect((await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE user_id=?").bind(member.user.id).first<{ total: number }>())?.total).toBe(0);
	});
	it("blocks anonymous, CSRF, origin and reporter spoofing, validates limits and limits new submissions", async () => {
		expect((await call("/api/bug-reports", null, "POST", input())).status).toBe(401);
		expect((await call("/api/bug-reports", member, "POST", input(), { "X-CSRF-Token": "wrong" })).status).toBe(403);
		expect((await call("/api/bug-reports", member, "POST", input(), { Origin: "https://other.example" })).status).toBe(403);
		expect((await call("/api/bug-reports", member, "POST", { ...input(), expectedUserId: owner.user.id })).status).toBe(409);
		for (const bad of [{ summary: "x" }, { description: "x" }, { page: "/?token=private" }, { summary: "x".repeat(161) }, { description: "x".repeat(4001) }, { reporterEmail: "spoof@example.test" }]) {
			expect((await call("/api/bug-reports", member, "POST", { ...input(), ...bad })).status).toBe(400);
		}
		for (let i = 0; i < 5; i++) expect((await call("/api/bug-reports", member, "POST", input())).status).toBe(200);
		expect((await call("/api/bug-reports", member, "POST", input())).status).toBe(429);
	});
	it("restricts status management to owners and applies deletion cleanup without deleting other reporters", async () => {
		const result = await (await call("/api/bug-reports", member, "POST", input())).json<{ receipt: { id: string } }>();
		const path = `/api/beta/admin/bug-reports/${result.receipt.id}`;
		expect((await call(path, member, "PATCH", { status: "RESOLVED" })).status).toBe(403);
		expect((await call(path, owner, "PATCH", { status: "RESOLVED" }, { "X-CSRF-Token": "wrong" })).status).toBe(403);
		expect((await call(path, owner, "PATCH", { status: "RESOLVED" })).status).toBe(200);
		const resolved = await (await call("/api/beta/admin/bug-reports?status=RESOLVED", owner)).json<{ reports: Array<{ id: string }> }>();
		expect(resolved.reports.some((row) => row.id === result.receipt.id)).toBe(true);
		await env.DB.prepare("UPDATE users SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), member.user.id).run();
		expect(await env.DB.prepare("SELECT id FROM bug_reports WHERE id=?").bind(result.receipt.id).first()).toBeNull();
	});
	it("rejects content changes under an existing request key", async () => {
		const body = input();
		expect((await call("/api/bug-reports", member, "POST", body)).status).toBe(200);
		expect((await call("/api/bug-reports", member, "POST", { ...body, summary: "Changed summary" })).status).toBe(409);
	});
	it("paginates owner reports and keeps cursors tied to the status filter", async () => {
		const now = new Date().toISOString();
		for (let index = 0; index < 22; index++) {
			await env.DB.prepare(`INSERT INTO bug_reports(id,user_id,submission_key,content_hash,summary,description,page,status,created_at,updated_at)
				VALUES(?,?,?,'fixture','Fictional issue','A sufficiently detailed fictional issue.','home','OPEN',?,?)`)
				.bind(crypto.randomUUID(), member.user.id, crypto.randomUUID(), now, now).run();
		}
		const first = await (await call("/api/beta/admin/bug-reports", owner)).json<{ reports: Array<{ id: string }>; nextCursor: string }>();
		expect(first.reports).toHaveLength(20);
		const next = await (await call(`/api/beta/admin/bug-reports?cursor=${first.nextCursor}`, owner)).json<{ reports: Array<{ id: string }> }>();
		expect(next.reports).toHaveLength(2);
		expect(new Set([...first.reports, ...next.reports].map((row) => row.id)).size).toBe(22);
		expect((await call(`/api/beta/admin/bug-reports?status=RESOLVED&cursor=${first.nextCursor}`, owner)).status).toBe(400);
	});
});
