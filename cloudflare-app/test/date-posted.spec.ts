import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { jobListQuerySchema } from "../src/lib/jobs";
import { safeAppReturnPath } from "../src/lib/auth";
import type { AppBindings } from "../src/types";

const NOW = Date.parse("2026-10-09T22:00:00.000Z");
const HOUR = 3600000;
const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN" };
const fixtures: Array<[string, string | null]> = [
	...Array.from({ length: 30 }, (_, index): [string, string] => [`recent-${index}`, new Date(NOW - index * 60000).toISOString()]),
	["seconds", "2026-10-09T21:00:00Z"],
	["24h", new Date(NOW - 24 * HOUR).toISOString()],
	["before-24h", new Date(NOW - 24 * HOUR - 1).toISOString()],
	["7d", new Date(NOW - 7 * 24 * HOUR).toISOString()],
	["before-7d", new Date(NOW - 7 * 24 * HOUR - 1).toISOString()],
	["30d", new Date(NOW - 30 * 24 * HOUR).toISOString()],
	["before-30d", new Date(NOW - 30 * 24 * HOUR - 1).toISOString()],
	["missing", null],
	["invalid", "not-a-date"],
	["impossible", "2026-02-30T12:00:00.000Z"],
	["future", new Date(NOW + 1).toISOString()],
	["invalid-hour", "2026-10-09T24:00:00.000Z"],
	["date-only", "2026-10-09"],
	["not-utc", "2026-10-09T21:00:00+01:00"],
];
const id = (label: string) => label.padEnd(64, "_");
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const now = new Date(NOW).toISOString();
	await env.DB.prepare(`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
		VALUES('date-fixture',1,?,?,?,?,?,'APPLIED',?)`).bind("b".repeat(64), "c".repeat(64), now, NOW, now, fixtures.length).run();
	for (const [label, posted] of fixtures) {
		await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,location,region,
			categories_json,industry,duration_options_json,term_season,term_year,posted_at,first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
			VALUES(?,'fixture','Example Firm','example firm','Software Engineering Intern','software engineering intern',
			'https://example.test/job','https://example.test/job','Toronto','Ontario','["software"]','Technology','[6]','SUMMER',2027,?,?,?,'date-fixture',?,?,1)`)
			.bind(id(label), posted, now, now, now, now).run();
	}
	await env.DB.prepare("UPDATE jobs SET is_active=0 WHERE id=?").bind(id("recent-29")).run();
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());
async function call(query: string, allow = true) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com/api/jobs?${query}`),
		{ ...bindings, BETA_ACCESS_MODE: allow ? "OPEN" : "ALLOWLIST" }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
interface Catalog {
	jobs: Array<{ id: string; postedAt: string | null; userState: unknown; outreachSummary: unknown }>;
	pagination: { total: number; totalPages: number; page: number };
	facets: { industries: Array<{ count: number }> };
}
async function list(query: string) {
	const response = await call(query);
	expect(response.status).toBe(200);
	return response.json<Catalog>();
}
describe("source posting dates over the complete active catalog", () => {
	it.each([["24h", 31, "24h", "before-24h"], ["7d", 33, "7d", "before-7d"], ["30d", 35, "30d", "before-30d"]])(
		"uses inclusive rolling UTC %s cutoffs and excludes unreliable/future dates",
		async (range, total, boundary, before) => {
			const result = await list(`posted=${range}&pageSize=50`);
			expect(result.pagination.total).toBe(total);
			expect(result.jobs.map((job) => job.id)).toContain(id(String(boundary)));
			expect(result.jobs.map((job) => job.id)).not.toContain(id(String(before)));
			for (const label of ["missing", "invalid", "impossible", "future", "invalid-hour", "date-only", "not-utc"]) {
				expect(result.jobs.map((job) => job.id)).not.toContain(id(label));
			}
			expect(result.facets.industries[0].count).toBe(total);
		},
	);
	it("Any time retains all active rows; Date unavailable uses no import/refresh fallback", async () => {
		expect((await list("pageSize=50")).pagination.total).toBe(fixtures.length - 1);
		const unavailable = await list("posted=UNAVAILABLE&pageSize=50");
		expect(unavailable.jobs.map((job) => job.id).sort()).toEqual(
			["missing", "invalid", "impossible", "future", "invalid-hour", "date-only", "not-utc"].map(id).sort(),
		);
		expect(unavailable.pagination.total).toBe(7);
		expect(unavailable.jobs.every((job) => job.postedAt === null)).toBe(true);
	});
	it("counts and pages the entire catalog and intersects all other filters", async () => {
		const query = new URLSearchParams({
			posted: "24h", q: "Engineering", company: "Example Firm", location: "Toronto",
			region: "Ontario", category: "software", industry: "Technology", length: "6", term: "SUMMER-2027", pageSize: "24",
		});
		const first = await list(String(query));
		expect(first.jobs).toHaveLength(24);
		expect(first.pagination).toMatchObject({ total: 31, totalPages: 2, page: 1 });
		const second = await list(`${query}&page=2`);
		expect(second.jobs).toHaveLength(7);
		expect(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size).toBe(31);
		query.set("company", "Other");
		expect((await list(String(query))).pagination.total).toBe(0);
		expect(first.jobs.every((job) => job.userState === null && job.outreachSummary === null)).toBe(true);
	});
	it("retains source seconds precision and evaluates the UTC boundary, not a calendar day", async () => {
		const result = await list("posted=24h&pageSize=50");
		expect(result.jobs.map((job) => job.id)).toContain(id("seconds"));
		expect(result.jobs.map((job) => job.id)).toContain(id("recent-0"));
		vi.mocked(Date.now).mockReturnValue(NOW + 1);
		expect((await list("posted=24h&pageSize=50")).jobs.map((job) => job.id)).not.toContain(id("24h"));
	});
	it("rejects unsupported choices and preserves normal authorization before returning catalog data", async () => {
		expect(jobListQuerySchema.parse({}).posted).toBe("");
		for (const posted of ["today", "24", "yesterday", "2026-10-09", "' OR 1=1 --"]) {
			expect((await call(`posted=${encodeURIComponent(posted)}`)).status).toBe(400);
		}
		expect((await call("posted=24h", false)).status).toBe(401);
	});
	it("keeps the selected range in sealed recognized login return context", () => {
		expect(safeAppReturnPath("https://example.com", "/?posted=7d&contactJob=legacy%3Arole&oauth_token=secret#people"))
			.toBe("/?posted=7d&contactJob=legacy%3Arole#people");
	});
	it("keeps seconds, milliseconds and microseconds equivalent at every inclusive cutoff before and after source normalization", async () => {
		const company = "Precision equivalents";
		const equivalent: Array<[string, string | null]> = [];
		for (const days of [1, 7, 30]) {
			const value = new Date(NOW - days * 24 * HOUR).toISOString();
			equivalent.push([`precision-${days}-seconds`, value.replace(".000Z", "Z")],
				[`precision-${days}-milliseconds`, value], [`precision-${days}-microseconds`, value.replace(".000Z", ".000000Z")]);
		}
		equivalent.push(["precision-missing", null], ["precision-impossible", "2026-02-30T12:00:00.000000Z"],
			["precision-future", new Date(NOW + 1).toISOString().replace(".001Z", ".001000Z")],
			["precision-invalid-fraction", "2026-10-09T12:00:00.abc000Z"]);
		for (const [label, posted] of equivalent) await insertPrecisionJob(label, company, posted);
		const before = new Map<string, string[]>();
		for (const [range, count] of [["24h", 3], ["7d", 6], ["30d", 9], ["UNAVAILABLE", 4]] as const) {
			const result = await list(`company=${encodeURIComponent(company)}&posted=${range}&pageSize=50`);
			expect(result.pagination.total).toBe(count);
			before.set(range, result.jobs.map((job) => job.id).sort());
			expect(result.jobs.every((job) => range === "UNAVAILABLE" ? job.postedAt === null :
				/\.000Z$/.test(job.postedAt || ""))).toBe(true);
		}
		for (const [label, posted] of equivalent.slice(0, 9)) {
			await env.DB.prepare("UPDATE jobs SET posted_at=? WHERE id=?").bind(new Date(posted!).toISOString(), id(label)).run();
		}
		for (const [range, ids] of before) {
			const result = await list(`company=${encodeURIComponent(company)}&posted=${range}&pageSize=50`);
			expect(result.pagination.total).toBe(ids.length);
			expect(result.jobs.map((job) => job.id).sort()).toEqual(ids);
		}
	});
	it("truncates longer fractions consistently with JS instead of letting SQLite round over a millisecond boundary", async () => {
		const company = "Precision boundary";
		vi.mocked(Date.now).mockReturnValue(NOW + 761);
		for (const days of [1, 7, 30]) {
			const boundary = new Date(NOW + 761 - days * 24 * HOUR).toISOString();
			for (const [suffix, posted] of [
				["milliseconds", boundary], ["microseconds", boundary.replace(".761Z", ".761000Z")],
				["sub-millisecond", boundary.replace(".761Z", ".761999Z")],
				["before", boundary.replace(".761Z", ".760999Z")],
			]) await insertPrecisionJob(`fraction-${days}-${suffix}`, company, posted);
		}
		await insertPrecisionJob("fraction-future", company, new Date(NOW + 762).toISOString().replace(".762Z", ".762000Z"));
		for (const [range, days, total] of [["24h", 1, 3], ["7d", 7, 7], ["30d", 30, 11]] as const) {
			const result = await list(`company=${encodeURIComponent(company)}&posted=${range}&pageSize=50`);
			expect(result.pagination.total).toBe(total);
			for (const suffix of ["milliseconds", "microseconds", "sub-millisecond"]) {
				expect(result.jobs.map((job) => job.id)).toContain(id(`fraction-${days}-${suffix}`));
			}
			expect(result.jobs.map((job) => job.id)).not.toContain(id(`fraction-${days}-before`));
			expect(result.jobs.map((job) => job.id)).not.toContain(id("fraction-future"));
		}
		expect((await list(`company=${encodeURIComponent(company)}&posted=UNAVAILABLE`)).jobs.map((job) => job.id))
			.toEqual([id("fraction-future")]);
	});
});

async function insertPrecisionJob(label: string, company: string, posted: string | null) {
	const now = new Date(NOW).toISOString();
	await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,
		posted_at,first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
		VALUES(?,'fixture',?,?,'Intern','intern','https://example.test/job','https://example.test/job',?,?,?,'date-fixture',?,?,1)`)
		.bind(id(label), company, company.toLowerCase(), posted, now, now, now, now).run();
}
