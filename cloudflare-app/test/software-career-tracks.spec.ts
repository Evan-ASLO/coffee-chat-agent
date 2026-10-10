import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { canonicalCareerTrack, jobListQuerySchema } from "../src/lib/jobs";
import type { AppBindings } from "../src/types";
const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN" };
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
		VALUES('software-fixture',1,?,?,?,?,?,'APPLIED',3)`).bind("b".repeat(64), "c".repeat(64), now, Date.now(), now).run();
	for (const [id, company, title, industry, category] of [
		["bank", "CIBC", "Software Engineering Intern", "Banking & Financial Services", "Software Engineering"],
		["tech", "Example Technology", "Software Developer Co-op", "Technology", "Software Engineering"],
		["business", "Example Firm", "Business Development Intern", "Other", "Business"],
	]) await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,categories_json,industry,
		posted_at,first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
		VALUES(?,'fixture',?,?,?,?,'https://example.test/job','https://example.test/job',?,?,?, ?,?,'software-fixture',?,?,1)`)
		.bind(id.padEnd(64, "_"), company, company.toLowerCase(), title, title.toLowerCase(), JSON.stringify([category]), industry, now, now, now, now, now).run();
});
async function list(query: string) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com/api/jobs?${query}`), bindings, ctx);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(200);
	return response.json<{ jobs: Array<{ id: string; industry: string; discoveryCriteria: { roles: string[] } }>; filters: { category: string }; pagination: { total: number } }>();
}
describe("Software Engineering career track is independent of employer industry", () => {
	it.each(["Software Engineering", "software engineer", "SWE", "SDE", "backend", "full-stack", "iOS", "d\u00e9veloppeur logiciel"])(
		"normalizes the %s track without changing the industry", async (value) => {
			expect(jobListQuerySchema.parse({ category: value }).category).toBe("Software Engineering");
			const result = await list(`category=${encodeURIComponent(value)}&industry=${encodeURIComponent("Banking & Financial Services")}&posted=24h`);
			expect(result.filters.category).toBe("Software Engineering");
			expect(result.pagination.total).toBe(1);
			expect(result.jobs[0].industry).toBe("Banking & Financial Services");
			expect(result.jobs[0].discoveryCriteria.roles.some((role) => /software/i.test(role))).toBe(true);
		},
	);
	it("keyword SWE finds software titles, but no broad engineering/development reclassification occurs", async () => {
		expect((await list("q=SWE")).pagination.total).toBe(2);
		expect((await list("category=Software%20Engineering")).pagination.total).toBe(2);
		for (const value of ["Engineering", "Business Development", "DevOps", "QA", "Security"]) expect(canonicalCareerTrack(value)).toBe(value);
	});
});
