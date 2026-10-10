import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { canonicalCareerTrack } from "../src/lib/job-career-tracks";
import { deriveJobDiscoveryCriteria, rankJobContact } from "../src/lib/job-discovery";
import type { AppBindings } from "../src/types";
const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN" };
const tracks = [
	["Software Engineering", "Software Engineer Intern", "SWE"],
	["Data Science & AI", "Data Engineer Intern", "ML"],
	["Cybersecurity", "Browser Security Engineer Intern", "information security"],
	["IT & Infrastructure", "DevOps & Cloud Platform Intern", "SRE"],
	["Quality & Test Engineering", "Software Engineer Intern, Test Automation", "SDET"],
	["Hardware & Embedded Systems", "Firmware Engineering Co-op", "FPGA"],
	["Electrical & Electronics Engineering", "Electrical Engineering Student", "power systems"],
	["Mechanical, Mechatronics & Robotics", "Mechanical Engineering Intern", "robotics"],
	["Civil & Structural Engineering", "Civil/Transportation Engineering Intern", "geotechnical"],
	["Environmental Engineering", "Environmental Compliance Intern", "environmental compliance"],
	["Chemical, Process & Materials Engineering", "Process Engineer Co-op", "materials science"],
	["Industrial & Manufacturing Engineering", "Manufacturing Engineering Co-op", "factory automation"],
	["Aerospace Engineering", "Aerospace Engineering Intern", "avionics"],
	["Biomedical Engineering", "Biomedical Engineering Student", "medical device"],
	["Mining & Geological Engineering", "Mining Engineering Co-op", "geoscience"],
	["General Engineering", "Student, Engineering", "engineer"],
] as const;
const id = (value: string) => value.padEnd(64, "_");
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
		VALUES('technical-fixture',1,?,?,?,?,?,'APPLIED',?)`).bind("b".repeat(64), "c".repeat(64), now, Date.now(), now, 34).run();
	for (let index = 0; index < tracks.length; index++) for (let repeat = 0; repeat < 2; repeat++) {
		const [category, title] = tracks[index];
		const categories = category === "Quality & Test Engineering" ? [category, "Software Engineering"] : [category];
		await insert(`track-${index}-${repeat}`, title, categories, now);
	}
	await insert("business", "Business Analyst Student", ["Business Operations"], now);
	await insert("finance", "Financial Analyst Intern", ["Finance"], now);
});
async function insert(label: string, title: string, categories: readonly string[], now: string) {
	await env.DB.prepare(`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,categories_json,
		industry,location,region,duration_options_json,term_season,term_year,posted_at,first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
		VALUES(?,'fixture','Example Bank','example bank',?,?,'https://example.test/job','https://example.test/job',?,
		'Banking & Financial Services','Toronto','Ontario','[4]','SUMMER',2027,?,?,?,'technical-fixture',?,?,1)`)
		.bind(id(label), title, title.toLowerCase(), JSON.stringify(categories), now, now, now, now, now).run();
}
interface Catalog {
	jobs: Array<{ id: string; industry: string; title: string; discoveryCriteria: { roles: string[] } }>;
	pagination: { total: number; totalPages: number };
	facets: { categories: Array<{ value: string; label: string; count: number }> };
	filters: { category: string };
}
async function list(query: string, allow = true) {
	const context = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com/api/jobs?${query}`),
		{ ...bindings, BETA_ACCESS_MODE: allow ? "OPEN" : "ALLOWLIST" }, context);
	await waitOnExecutionContext(context);
	return response;
}
describe("published technical career tracks remain distinct from employer Industry", () => {
	it.each(tracks)("accepts exact %s and alias %s while preserving the selected title/function", async (category, title, alias) => {
		expect(canonicalCareerTrack(category)).toBe(category);
		expect(canonicalCareerTrack(alias)).toBe(category);
		const query = new URLSearchParams({ category: alias, company: "Example Bank", location: "Toronto", industry: "Banking & Financial Services",
			posted: "24h", length: "4", term: "SUMMER-2027", pageSize: "1" });
		const response = await list(String(query));
		expect(response.status).toBe(200);
		const first = await response.json<Catalog>();
		expect(first.filters.category).toBe(category);
		expect(first.pagination.total).toBe(category === "Software Engineering" ? 4 : 2);
		expect(first.jobs).toHaveLength(1);
		expect(first.jobs[0].industry).toBe("Banking & Financial Services");
		const second = await (await list(`${query}&page=2`)).json<Catalog>();
		expect(second.jobs[0].id).not.toBe(first.jobs[0].id);
		expect(second.pagination.total).toBe(first.pagination.total);
		expect(first.facets.categories).toContainEqual({ value: category, label: category, count: first.pagination.total });
		expect(first.facets.categories.map((option) => option.value)).toContain("Business Operations");
		const criteria = deriveJobDiscoveryCriteria({ company: "Example Bank", title, location: "Toronto", region: "Ontario", industry: "Banking & Financial Services" });
		expect(criteria.jobContext?.title).toBe(title);
		expect(criteria.roles.some((role) => /Junior|Engineer|Data|Security|Compliance|Research/.test(role))).toBe(true);
		expect(criteria.industries).toEqual(["Banking & Financial Services"]);
	});
	it("counts unique jobs while overlapping category facets are not summed as catalog size", async () => {
		const catalog = await (await list("pageSize=1")).json<Catalog>();
		expect(catalog.pagination.total).toBe(34);
		expect(catalog.facets.categories.reduce((n, option) => n + option.count, 0)).toBe(36);
		const empty = await (await list("category=Unlisted%20specialty")).json<Catalog>();
		expect(empty.jobs).toEqual([]);
		expect(empty.pagination.total).toBe(0);
		expect(empty.facets.categories.length).toBeGreaterThan(1);
		expect((await list("category=Mechanical", false)).status).toBe(401);
	});
	it.each([["QA", "Quality & Test Engineering"], ["ML", "Data Science & AI"], ["SRE", "IT & Infrastructure"], ["robotics", "Mechanical, Mechatronics & Robotics"]])(
		"finds the verified %s technical keyword through tagged functions, not employer Industry", async (keyword, category) => {
			const catalog = await (await list(`q=${encodeURIComponent(keyword)}`)).json<Catalog>();
			expect(catalog.pagination.total).toBe(2);
			expect(catalog.facets.categories.some((facet) => facet.value === category)).toBe(true);
		},
	);
	it("keeps business categories and ambiguous nontechnical terms out of Software Engineering", () => {
		expect(canonicalCareerTrack("engineering")).toBe("General Engineering");
		for (const value of ["Finance", "Marketing", "Business Operations", "Consulting", "business analyst", "financial analyst", "physical security", "process re-engineering"]) {
			expect(canonicalCareerTrack(value)).toBe(value);
		}
		expect(canonicalCareerTrack("SoC")).toBe("Hardware & Embedded Systems");
		expect(canonicalCareerTrack("SOC")).toBe("Cybersecurity");
		expect(canonicalCareerTrack("EHS")).toBe("Environmental Engineering");
		expect(canonicalCareerTrack("nuclear")).toBe("General Engineering");
	});
	it.each([
		["Mechanical Engineering Intern", "Junior Mechanical Engineer", "Junior Electrical Engineer"],
		["Electrical Engineering Student", "Junior Electrical Engineer", "Junior Software Engineer"],
		["Cybersecurity Intern", "Junior Security Engineer", "Junior Software Engineer"],
		["Data Engineer Intern", "Junior Data Engineer", "Junior Mechanical Engineer"],
		["Civil Engineering Student", "Junior Civil Engineer", "Junior Software Engineer"],
		["Student, Engineering", "Junior Engineer", "Junior Software Engineer"],
	])("ranks evidenced junior %s contacts in the actual function, not an unrelated engineering function", (title, match, other) => {
		const person = (role: string) => ({ fullName: "Jamie Example", title: role, company: "Example Bank",
			sourceUrl: "https://www.linkedin.com/in/jamie-example", sourceSnippet: `Jamie Example is a ${role} at Example Bank.` });
		expect(rankJobContact(person(match), { company: "Example Bank", title }).tier).toBe(1);
		expect(rankJobContact(person(other), { company: "Example Bank", title }).tier).toBe(3);
		expect(rankJobContact(person("Campus Recruiter"), { company: "Example Bank", title }).tier).toBe(2);
		expect(rankJobContact(person(`Senior ${match}`), { company: "Example Bank", title }).tier).toBeNull();
	});
});
