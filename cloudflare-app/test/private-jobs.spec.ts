import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { upsertUser, createSession } from "../src/lib/db";
import { sha256 } from "../src/lib/encoding";
import { getJob, createPrivateJob, privateJobCreateSchema, snapshotHash, ingestJobSnapshot, type JobRecord, type NormalizedJob } from "../src/lib/jobs";
import { getUserAnalytics } from "../src/lib/analytics";
const bindings = { ...env, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN", ENABLE_JOB_OUTREACH_LINKING: "true",
	BETA_ADMIN_EMAILS: "private-owner@example.test" };
type Auth = { id: string; csrf: string; cookie: string };
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
		VALUES('private-fixture',1,?,?,?,?,?,'APPLIED',2)`).bind("b".repeat(64), "c".repeat(64), now, Date.now(), now).run();
	for (const id of ["a".repeat(64), "d".repeat(64)]) await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,
		first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
		VALUES(?,'fixture','Catalog Firm','catalog firm','Intern','intern',?,?,?,?,'private-fixture',?,?,1)`)
		.bind(id, `https://example.test/catalog/${id[0]}`, `https://example.test/catalog/${id[0]}`, now, now, now, now).run();
});
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No actual provider/mail/URL fetch is authorized.")); });
afterEach(() => vi.restoreAllMocks());
async function auth(email = `${crypto.randomUUID()}@example.test`): Promise<Auth> {
	const user = await upsertUser(bindings, { googleSub: crypto.randomUUID(), email, name: "Fictional member", image: "" });
	const token = crypto.randomUUID(), csrf = crypto.randomUUID();
	await createSession(bindings, user.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 3600000).toISOString());
	return { id: user.id, csrf, cookie: `cc_session=${token}; cc_csrf=${csrf}` };
}
async function call(path: string, user: Auth | null, method = "GET", body?: unknown, csrf = true, gate = "OPEN") {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, { method,
		headers: { Origin: bindings.APP_ORIGIN, "Content-Type": "application/json",
			...(user ? { Cookie: user.cookie, ...(csrf ? { "X-CSRF-Token": user.csrf } : {}) } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), { ...bindings, BETA_ACCESS_MODE: gate }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
const input = (user: Auth, extra = {}) => ({ company: "Private Example Firm", title: "Mechanical Engineering Intern", location: "Toronto",
	url: "", status: "SAVED", notes: "PRIVATE-NOTE", expectedUserId: user.id, submissionKey: crypto.randomUUID(), ...extra });
async function add(user: Auth, extra = {}) {
	const response = await call("/api/private-jobs", user, "POST", input(user, extra));
	expect(response.status).toBe(200);
	return (await response.json<{ job: JobRecord }>()).job;
}
describe("private user-added job lifecycle and catalog isolation", () => {
	it("returns the full active public catalog total independently of filters, pages and private records", async () => {
		const user = await auth();
		await add(user);
		const result = await (await call("/api/jobs?pageSize=1", user)).json<{ pagination: { total: number }; catalog: { total: number } }>();
		expect(result.pagination.total).toBe(2); expect(result.catalog.total).toBe(2);
		const filtered = await (await call("/api/jobs?company=NoSuchCatalogCompany", user)).json<{ pagination: { total: number }; catalog: { total: number } }>();
		expect(filtered.pagination.total).toBe(0); expect(filtered.catalog.total).toBe(2);
		await env.DB.prepare("UPDATE jobs SET is_active=0 WHERE id=?").bind("d".repeat(64)).run();
		const afterClosure = await (await call("/api/jobs?pageSize=1", user)).json<{ catalog: { total: number } }>();
		expect(afterClosure.catalog.total).toBe(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("persists a URL-free owned role, idempotently retries creation and edits information/current stage/notes", async () => {
		const user = await auth(), body = input(user);
		const first = await (await call("/api/private-jobs", user, "POST", body)).json<{ job: JobRecord; idempotent: boolean }>();
		expect(first.job).toMatchObject({ manual: true, url: "", source: "User added", active: false, postedAt: null, manualVersion: 1, userState: { status: "SAVED", notes: "PRIVATE-NOTE" } });
		expect(first.job.id).toMatch(/^manual-[a-f0-9]{64}$/);
		const retry = await (await call("/api/private-jobs", user, "POST", body)).json<{ job: JobRecord; idempotent: boolean }>();
		expect(retry.idempotent).toBe(true); expect(retry.job.id).toBe(first.job.id);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE user_id=? AND action='JOB_STATE_UPDATED'").bind(user.id).first<{ n: number }>())?.n).toBe(1);
		const { submissionKey, ...edit } = body;
		const response = await call(`/api/private-jobs/${first.job.id}`, user, "PUT", { ...edit, company: "Edited private company", title: "Civil Engineering Co-op",
			url: "https://example.test/posting?id=123", status: "APPLIED", expectedVersion: 1, notes: "Changed note" });
		expect(response.status).toBe(200);
		const reloaded = await (await call(`/api/jobs/${first.job.id}`, user)).json<{ job: JobRecord }>();
		expect(reloaded.job).toMatchObject({ company: "Edited private company", title: "Civil Engineering Co-op", manualVersion: 2, userState: { status: "APPLIED", notes: "Changed note" } });
		expect((await call(`/api/private-jobs/${first.job.id}`, user, "PUT", { ...edit, expectedVersion: 1 })).status).toBe(409);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("counts each public/manual state once in complete analytics, filtered tracked pagination and current snapshot shapes", async () => {
		const user = await auth();
		await call(`/api/jobs/${"a".repeat(64)}/state`, user, "PUT", { status: "APPLIED", notes: "" });
		const manual = await add(user);
		let result = await getUserAnalytics(bindings, user.id);
		expect(result.applications).toMatchObject({ total: 1, saved: 1, applied: 1, archived: 0 });
		expect(result.topCompanies).toContainEqual({ company: "Private Example Firm", count: 1 });
		expect(result.recentActivity.some((entry) => entry.context.includes("Private Example Firm"))).toBe(true);
		const page = await (await call("/api/job-states?page=1&pageSize=1", user)).json<{ jobs: JobRecord[]; pagination: { total: number; totalPages: number } }>();
		const second = await (await call("/api/job-states?page=2&pageSize=1", user)).json<{ jobs: JobRecord[] }>();
		expect(page.pagination).toMatchObject({ total: 2, totalPages: 2 });
		expect(new Set([page.jobs[0].id, second.jobs[0].id]).size).toBe(2);
		expect((await (await call("/api/job-states?status=SAVED", user)).json<{ pagination: { total: number } }>()).pagination.total).toBe(1);
		await call(`/api/jobs/${manual.id}/state`, user, "PUT", { status: "OFFER", notes: "Offer now" });
		result = await getUserAnalytics(bindings, user.id); expect(result.applications).toMatchObject({ total: 2, saved: 0, offers: 1 });
		await call(`/api/jobs/${manual.id}/state`, user, "PUT", { status: "ARCHIVED", notes: "Archived now" });
		expect((await getUserAnalytics(bindings, user.id)).applications).toMatchObject({ total: 1, archived: 1 });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("never exposes guessed private IDs, edits, states, links or lists to a second account/signed-out caller", async () => {
		const user = await auth(), other = await auth(), body = input(user);
		const job = await add(user);
		expect((await call(`/api/jobs/${job.id}`, null)).status).not.toBe(200);
		expect((await call(`/api/jobs/${job.id}`, other)).status).not.toBe(200);
		expect(await getJob(bindings, job.id)).toBeNull();
		expect((await call(`/api/private-jobs/${job.id}`, other, "PUT", { ...body, submissionKey: undefined, expectedVersion: 1, expectedUserId: other.id })).status).toBe(400);
		expect((await call(`/api/jobs/${job.id}/state`, other, "PUT", { status: "SAVED", notes: "other" })).status).toBe(400);
		expect((await call(`/api/jobs/${job.id}/state`, other, "DELETE")).status).toBe(400);
		expect((await call(`/api/jobs/${job.id}/prospects`, other)).status).toBe(400);
		expect((await (await call("/api/job-states", other)).json<{ jobs: JobRecord[] }>()).jobs).toEqual([]);
		expect((await getUserAnalytics(bindings, other.id)).applications.total).toBe(0);
		expect((await call("/api/private-jobs", user, "POST", body, false)).status).toBe(403);
		expect((await call("/api/private-jobs", null, "POST", body)).status).toBe(401);
		expect((await call("/api/private-jobs", user, "POST", { ...body, expectedUserId: other.id })).status).toBe(409);
		expect((await call("/api/private-jobs", user, "POST", body, true, "ALLOWLIST")).status).toBe(401);
	});
	it("validates required/URL fields and provides same-owner duplicate guidance without merging or fetching pasted URLs", async () => {
		const user = await auth(), other = await auth();
		for (const extra of [{ company: "" }, { title: "" }, { company: "a".repeat(201) }, { url: "javascript:alert(1)" }, { url: "https://name:secret@example.test/" }]) {
			expect((await call("/api/private-jobs", user, "POST", input(user, extra))).status).toBe(400);
		}
		const body = input(user, { url: "https://example.test/private-role?utm_source=fixture&id=99#extra" });
		await call("/api/private-jobs", user, "POST", body);
		expect((await call("/api/private-jobs", user, "POST", input(user, { url: "https://example.test/private-role?id=99" }))).status).toBe(409);
		expect((await call("/api/private-jobs", other, "POST", input(other, { url: "https://example.test/private-role?id=99" }))).status).toBe(200);
		const original = await add(user, { title: "URL-free duplicate" });
		expect((await call("/api/private-jobs", user, "POST", input(user, { title: "URL-free duplicate" }))).status).toBe(409);
		expect((await getJob(bindings, original.id, user.id))?.userState?.notes).toBe("PRIVATE-NOTE");
		await call(`/api/jobs/${"a".repeat(64)}/state`, user, "PUT", { status: "SAVED", notes: "" });
		expect((await call("/api/private-jobs", user, "POST", input(user, { url: "https://example.test/catalog/a" }))).status).toBe(409);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("supports only owned saved People linkage with private role context, while preserving all provider/preparation gates", async () => {
		const user = await auth(), other = await auth(), job = await add(user), prospect = crypto.randomUUID(), foreign = crypto.randomUUID();
		const now = new Date().toISOString();
		for (const [id, owner] of [[prospect, user.id], [foreign, other.id]]) await env.DB.prepare(`INSERT INTO prospects(id,user_id,full_name,title,company,discovery_provider,source_url,source_snippet,created_at,updated_at)
			VALUES(?,?,'Jamie Example','Junior Mechanical Engineer','Private Example Firm','TAVILY','https://www.linkedin.com/in/jamie-example','Jamie Example is a Junior Mechanical Engineer at Private Example Firm.',?,?)`).bind(id, owner, now, now).run();
		expect((await call(`/api/jobs/${job.id}/prospects/${prospect}`, user, "POST")).status).toBe(200);
		expect((await call(`/api/jobs/${job.id}/prospects/${foreign}`, user, "POST")).status).toBe(400);
		expect((await call(`/api/jobs/${job.id}/prospects/${prospect}`, other, "POST")).status).toBe(400);
		const loaded = await (await call(`/api/jobs/${job.id}/prospects`, user)).json<{ job: JobRecord; prospects: Array<{ linkedJobs: Array<{ id: string; contactMatch: { tier: number } }> }> }>();
		expect(loaded.job.discoveryCriteria.jobContext?.title).toBe("Mechanical Engineering Intern");
		expect(loaded.prospects).toHaveLength(1); expect(loaded.prospects[0].linkedJobs[0]).toMatchObject({ id: job.id, contactMatch: { tier: 1 } });
		expect(loaded.job.outreachSummary?.total).toBe(1);
		expect((await call(`/api/jobs/${job.id}/prospects/${prospect}`, user, "DELETE")).status).toBe(200);
		expect((await (await call(`/api/jobs/${job.id}/prospects`, user)).json<{ prospects: unknown[] }>()).prospects).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("preserves private records across catalog refresh and old queries while keeping public counts/facets/source snapshots private-free", async () => {
		const user = await auth(), job = await add(user, { company: "PRIVATE-ONLY-FIRM" });
		const publicJob: NormalizedJob = { id: "e".repeat(64), externalId: "fixture", source: "fixture", company: "Fresh Catalog", title: "Intern",
			location: "Toronto", region: "Ontario", categories: ["Software Engineering"], url: "https://example.test/fresh", postedAt: null, postedText: null, description: null };
		const hash = await snapshotHash([publicJob]);
		await ingestJobSnapshot(bindings, { payload: { schemaVersion: 1, generatedAt: new Date(Date.now() + 1000).toISOString(), snapshotHash: hash, jobs: [publicJob] }, contentHash: hash });
		expect((await getJob(bindings, job.id, user.id))?.company).toBe("PRIVATE-ONLY-FIRM");
		const catalog = await (await call("/api/jobs?pageSize=50", user)).text();
		expect(catalog).not.toContain("PRIVATE-ONLY-FIRM"); expect(catalog).not.toContain(job.id);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id=?").bind(job.id).first<{ n: number }>())?.n).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM user_job_states WHERE job_id=?").bind(job.id).first<{ n: number }>())?.n).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM private_jobs WHERE id=? AND deleted_at IS NULL").bind(job.id).first<{ n: number }>())?.n).toBe(1);
	});
	it("removes private tracking without deleting prospects/audit history and rejects stale revival; account deletion clears private records", async () => {
		const user = await auth(), body = input(user);
		const job = (await (await call("/api/private-jobs", user, "POST", body)).json<{ job: JobRecord }>()).job;
		expect((await call(`/api/jobs/${job.id}/state`, user, "DELETE")).status).toBe(200);
		expect(await getJob(bindings, job.id, user.id, true)).toBeNull();
		expect((await call(`/api/jobs/${job.id}/state`, user, "PUT", { status: "SAVED", notes: "revive" })).status).toBe(400);
		expect((await call("/api/private-jobs", user, "POST", body)).status).toBe(409);
		expect((await getUserAnalytics(bindings, user.id)).applications.saved).toBe(0);
		const fresh = await add(user, { title: "Delete account fixture" });
		await env.DB.prepare("UPDATE users SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), user.id).run();
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM private_jobs WHERE user_id=?").bind(user.id).first<{ n: number }>())?.n).toBe(0);
		expect(await getJob(bindings, fresh.id, user.id)).toBeNull();
	});
	it("never exposes manual titles, URLs, notes or raw payload to owner operational event projections", async () => {
		const owner = await auth("private-owner@example.test"), member = await auth();
		await add(member, { company: "PRIVATE-PAYLOAD-FIRM", title: "PRIVATE-PAYLOAD-TITLE", url: "https://example.test/PRIVATE-PAYLOAD-URL", notes: "PRIVATE-PAYLOAD-NOTES" });
		const response = await call(`/api/beta/admin/activity/events?userId=${member.id}`, owner);
		expect(response.status).toBe(200); expect(await response.text()).not.toMatch(/PRIVATE-PAYLOAD/);
	});
	it("hydrates full100-row manual pages with bounded bind batches and stable exactly-once pagination", async () => {
		const user = await auth();
		for (let i = 0; i < 101; i++) await createPrivateJob(bindings, user.id, privateJobCreateSchema.parse(input(user, { title: `Private Intern ${i}` })));
		const first = await (await call("/api/job-states?page=1&pageSize=100", user)).json<{ jobs: JobRecord[]; pagination: { total: number } }>();
		const second = await (await call("/api/job-states?page=2&pageSize=100", user)).json<{ jobs: JobRecord[] }>();
		expect(first.jobs).toHaveLength(100); expect(second.jobs).toHaveLength(1); expect(first.pagination.total).toBe(101);
		expect(new Set([...first.jobs, ...second.jobs].map((entry) => entry.id)).size).toBe(101);
	});
});
