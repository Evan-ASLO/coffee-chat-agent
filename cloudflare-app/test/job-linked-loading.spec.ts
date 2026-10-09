import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { createSession, upsertUser } from "../src/lib/db";
import { sha256 } from "../src/lib/encoding";
import { saveCredential } from "../src/lib/credentials";
import { safeAppReturnPath } from "../src/lib/auth";
import type { AppBindings } from "../src/types";

const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN", ENABLE_JOB_OUTREACH_LINKING: "true" };
const ids = ["a".repeat(64), "legacy:internship-123_a.v1".padEnd(64, "_"), "catalog-12345".padEnd(64, "_")];
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
		VALUES('linked-fixture',1,?,?,?,?,?,'APPLIED',3)`).bind("b".repeat(64), "c".repeat(64), now, Date.now(), now).run();
	for (const id of ids) {
		await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,
			first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
			VALUES(?,'fixture','Example Firm','example firm','Software Engineering Intern','software engineering intern',
			'https://example.test/job','https://example.test/job',?,?,'linked-fixture',?,?,1)`).bind(id, now, now, now, now).run();
	}
});
afterEach(() => vi.restoreAllMocks());
async function user() {
	const value = await upsertUser(bindings, { googleSub: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.test`, name: "Fictional member", image: "" });
	const token = crypto.randomUUID(), csrf = crypto.randomUUID();
	await createSession(bindings, value.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 3600000).toISOString());
	await saveCredential(bindings, { userId: value.id, provider: "TAVILY", value: "fake-linked-only" });
	return { value, csrf, cookie: `cc_session=${token}; cc_csrf=${csrf}` };
}
async function call(path: string, auth: Awaited<ReturnType<typeof user>> | null, method = "GET", body?: unknown, enabled = true) {
	const context = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, {
		method, headers: { Origin: bindings.APP_ORIGIN, "Content-Type": "application/json", ...(auth ? { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), { ...bindings, ENABLE_JOB_OUTREACH_LINKING: enabled ? "true" : "false" }, context);
	await waitOnExecutionContext(context);
	return response;
}
describe("catalog-referenced People context", () => {
	it.each(ids)("opens and searches the actual stored %s job reference without requiring a saved job", async (id) => {
		const auth = await user();
		const path = `/api/jobs/${encodeURIComponent(id)}/prospects`;
		const first = await call(path, auth);
		expect(first.status).toBe(200);
		const payload = await first.json<{ job: { id: string; title: string }; prospects: unknown[] }>();
		expect(payload.job.id).toBe(id);
		expect(payload.prospects).toEqual([]);
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [{
			title: "Jamie Example - Junior Software Engineer - Example Firm | LinkedIn",
			url: "https://www.linkedin.com/in/jamie-linked",
			content: "Jamie Example is a Junior Software Engineer at Example Firm.",
		}] }));
		const searched = await call("/api/discovery", auth, "POST", {
			jobId: id, roles: ["Unrelated Director"], companies: ["Other Firm"], industries: [], locations: [], keywords: [], seniority: [],
			objective: "", count: 1,
		});
		expect(searched.status).toBe(200);
		expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).query).toContain('"Example Firm"');
		expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).query).not.toContain("Unrelated Director");
		expect(spy).toHaveBeenCalledTimes(1);
		const loaded = await (await call(path, auth)).json<{ prospects: Array<{ userId: string; linkedJobs: Array<{ id: string; contactMatch: { tier: number } }> }> }>();
		expect(loaded.prospects).toHaveLength(1);
		expect(loaded.prospects[0]).toMatchObject({ userId: auth.value.id, linkedJobs: [expect.objectContaining({ id, contactMatch: expect.objectContaining({ tier: 1 }) })] });
	});
	it("retains auth and readiness gates, rejects unsafe references and reports missing jobs without provider work", async () => {
		const auth = await user();
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider call authorized"));
		expect((await call(`/api/jobs/${ids[0]}/prospects`, null)).status).toBe(401);
		expect((await call(`/api/jobs/${ids[0]}/prospects`, auth, "GET", undefined, false)).status).toBe(403);
		expect((await call("/api/jobs/missing-catalog-role/prospects", auth)).status).toBe(400);
		expect((await call("/api/jobs/job%3Ftoken%3Dsecret/prospects", auth)).status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});
	it("preserves only same-app login destinations and strips tokens from return context", () => {
		expect(safeAppReturnPath("https://example.com", "/?contactJob=legacy%3Ajob-1&q=finance&oauth_token=secret#people"))
			.toBe("/?q=finance&contactJob=legacy%3Ajob-1#people");
		expect(safeAppReturnPath("https://example.com")).toBe("/");
		for (const value of ["//evil.example/", "/\\evil.example/", "/auth/google/callback", "/#unknown"]) {
			expect(() => safeAppReturnPath("https://example.com", value)).toThrow("Invalid app return");
		}
	});
});
