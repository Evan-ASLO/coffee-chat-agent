import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { canonicalCareerTrack, professionalKeywordTrack } from "../src/lib/job-career-tracks";
import { deriveJobDiscoveryCriteria, rankJobContact } from "../src/lib/job-discovery";
import { classifyJobIndustry } from "../src/lib/job-classification";
import { ingestJobSnapshot, jobSnapshotSchema, normalizedJobSchema, snapshotHash, type JobRecord, type NormalizedJob } from "../src/lib/jobs";
import type { AppBindings } from "../src/types";
const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN" };
const legal = "Legal, Compliance & Governance", policy = "Public Policy & Government Relations";
const now = new Date().toISOString();
const accepted = [
	["Government Relations Student", policy, "Public Policy or Political Science undergraduate placement. Source: official employer Oracle recruiting.", "oracle"],
	["Legal & Contract Management Co-op", legal, "Undergraduate Pre-Law, Legal Studies or Business placement. Source: official employer posting.", "oracle"],
	["Corporate Compliance Intern", legal, "Bachelor's student placement supporting corporate ethics and compliance. Source: official employer posting.", "oracle"],
	["Policy Research Student", policy, "Student placement in public-policy and legislative research. Source: Government of Canada, GC Jobs.", "gcjobs"],
	["Law Clerk Co-op", legal, "Restricted qualification: current Law Clerk program enrolment required. Source: Government of Canada, GC Jobs.", "gcjobs"],
	["Compliance Intern", legal, "Bachelor's student placement; law or legal studies an asset, not mandatory. Source: official employer posting.", "oracle"],
] as const;
const preserved = [
	["Legal Summer Student", ["Business Operations"], "Mandatory accredited law-school enrolment.", "Other"],
	["Articling Student", ["Business Operations"], "Articling eligibility required.", "Other"],
	["Product Coordinator Intern, Driver Compliance", ["Business Operations"], "Driver and product compliance; not corporate legal work.", "Other"],
	["Sales Systems & Data Governance Intern", ["Business Operations"], "Sales systems and data governance.", "Other"],
	["Environmental Compliance Intern", ["Environmental Engineering"], "Environmental engineering placement.", "Other"],
	["Regulatory Affairs Intern", ["Business Operations"], "Science degree required; scientific regulatory work.", "Healthcare & Life Sciences"],
	["Risk Analyst Intern", ["Finance"], "Credit and market risk work.", "Banking & Financial Services"],
	["AI Policy Engineer Intern", ["Software Engineering"], "Software policy engineering, not public policy.", "Technology"],
] as const;
const records: NormalizedJob[] = [
	...accepted.map(([title, category, description, source], index) => ({
		id: String(index + 1).padStart(64, "0"), externalId: source === "gcjobs" ? `fictional-poster-${index}` : `CNRL-Campus:fictional-${index}`,
		source, company: "Government of Canada", title, location: "Ottawa", region: "Ontario", categories: [category],
		url: `https://postings.example.test/accepted/${index}`,
		postedAt: source === "gcjobs" ? null : now, postedText: null, description,
	})),
	...preserved.map(([title, categories, description], index) => ({
		id: String(index + 20).padStart(64, "0"), externalId: null, source: "existing-fixture", company: index === 6 ? "Example Bank" : "Example Firm",
		title, location: "Toronto", region: "Ontario", categories: [...categories], url: `https://postings.example.test/existing/${index}`,
		postedAt: null, postedText: null, description,
	})),
];
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
	const payload = jobSnapshotSchema.parse({ schemaVersion: 1, generatedAt: now, snapshotHash: await snapshotHash(records), jobs: records });
	await ingestJobSnapshot(bindings, { payload, contentHash: "f".repeat(64) });
});
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No actual source/provider/mail calls are authorized.")); });
afterEach(() => vi.restoreAllMocks());
interface Catalog {
	jobs: JobRecord[];
	pagination: { total: number; totalPages: number };
	facets: { categories: Array<{ value: string; label: string; count: number }> };
	filters: { category: string };
	catalog: { total: number };
}
async function list(params: Record<string, string>, gate = "OPEN") {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com/api/jobs?${new URLSearchParams(params)}`), { ...bindings, BETA_ACCESS_MODE: gate }, ctx);
	await waitOnExecutionContext(ctx);
	if (gate === "OPEN") expect(response.status, await response.clone().text()).toBe(200);
	return response;
}
describe("producer-agreed legal/public-policy placement contract", () => {
	it("accepts unchanged strict schema-v1 sources, null genuine posting dates and visible restricted qualifications", async () => {
		expect(records.map((job) => normalizedJobSchema.parse(job))).toHaveLength(14);
		expect(normalizedJobSchema.safeParse({ ...records[0], application_deadline: "2027-01-01" }).success).toBe(false);
		const catalog = await (await list({ category: "law clerk", pageSize: "50" })).json<Catalog>();
		expect(catalog.filters.category).toBe(legal);
		expect(catalog.jobs).toHaveLength(4);
		const restricted = catalog.jobs.find((job) => job.title === "Law Clerk Co-op")!;
		expect(restricted.description).toContain("Restricted qualification: current Law Clerk program enrolment required.");
		expect(restricted).toMatchObject({ source: "gcjobs", postedAt: null, postedText: null, industry: "Government & Nonprofit" });
		expect(catalog.catalog.total).toBe(14);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it.each([["legal operations", legal, 4], ["government relations", policy, 2]] as const)(
		"supports %s aliases, combined filters, complete counts/facets and distinct pages without Industry conflation", async (alias, category, count) => {
			const params = { category: alias, company: "Government of Canada", location: "Ottawa", region: "Ontario", industry: "Government & Nonprofit", pageSize: "1" };
			const first = await (await list(params)).json<Catalog>(), second = await (await list({ ...params, page: "2" })).json<Catalog>();
			expect(first.filters.category).toBe(category);
			expect(first.pagination).toMatchObject({ total: count, totalPages: count });
			expect(first.jobs[0].id).not.toBe(second.jobs[0].id);
			expect(first.jobs[0].industry).toBe("Government & Nonprofit");
			expect(first.facets.categories).toContainEqual({ value: category, label: category, count });
			expect(first.facets.categories).toContainEqual({ value: category === legal ? policy : legal, label: category === legal ? policy : legal, count: category === legal ? 2 : 4 });
			expect((await list(params, "ALLOWLIST")).status).toBe(401);
		},
	);
	it("searches verified tagged functions through exact aliases without interpreting employer Industry as profession", async () => {
		expect((await (await list({ q: "government relations", pageSize: "50" })).json<Catalog>()).pagination.total).toBe(2);
		expect((await (await list({ category: "legal", posted: "UNAVAILABLE", pageSize: "50" })).json<Catalog>()).jobs.map((job) => job.title)).toEqual(["Law Clerk Co-op"]);
		const recent = await (await list({ category: policy, posted: "24h", pageSize: "50" })).json<Catalog>();
		expect(recent.jobs.map((job) => job.title)).toEqual(["Government Relations Student"]);
		expect(recent.jobs[0].postedAt).toBe(now);
	});
	it("does not confer pre-law eligibility on existing mandatory-law or unrelated technical/business jobs", async () => {
		const all = await (await list({ pageSize: "50" })).json<Catalog>();
		for (const [title] of preserved) expect(all.jobs.find((job) => job.title === title)?.categories).not.toContain(legal);
		expect(all.jobs.find((job) => job.title === "Legal Summer Student")?.description).toContain("Mandatory accredited law-school");
		for (const alias of ["pre-law", "prelaw", "policy", "credit risk", "data governance", "regulatory affairs", "driver compliance", "software policy"]) {
			expect(professionalKeywordTrack(alias)).toBeUndefined();
			expect(canonicalCareerTrack(alias)).toBe(alias);
		}
		expect(canonicalCareerTrack("environmental compliance")).toBe("Environmental Engineering");
		expect(classifyJobIndustry({ company: "Canadian Natural Resources Limited", title: "Government Relations Student", description: "Public-policy student placement." })).toBe("Other");
		expect(classifyJobIndustry({ company: "BMO", title: "Corporate Compliance Intern", description: null })).toBe("Banking & Financial Services");
	});
	it.each([
		["Government Relations Student", "Junior Government Relations Analyst"],
		["Municipal Policy Research Student", "Junior Policy Analyst"],
		["Legal & Contract Management Co-op", "Junior Contract Management Analyst"],
		["Corporate Compliance Intern", "Junior Compliance Analyst"],
		["Law Clerk Co-op", "Junior Law Clerk"],
	])("keeps %s People context in the evidenced actual function with existing junior/recruiter/senior guards", (title, match) => {
		const criteria = deriveJobDiscoveryCriteria({ company: "Example Firm", title, location: "Ottawa", region: "Ontario", industry: null });
		expect(criteria.jobContext?.title).toBe(title);
		expect(criteria.roles.some((role) => /software|civil engineer|operations intern$/i.test(role))).toBe(false);
		const person = (role: string) => ({ fullName: "Fictional Person", title: role, company: "Example Firm", sourceUrl: "https://www.linkedin.com/in/fictional-person", sourceSnippet: `Fictional Person is a ${role} at Example Firm.` });
		expect(rankJobContact(person(match), { company: "Example Firm", title }).tier).toBe(1);
		expect(rankJobContact(person("Campus Recruiter"), { company: "Example Firm", title }).tier).toBe(2);
		expect(rankJobContact(person("Junior Software Engineer"), { company: "Example Firm", title }).tier).toBe(3);
		expect(rankJobContact(person(`Senior ${match}`), { company: "Example Firm", title }).tier).toBeNull();
		expect(rankJobContact({ ...person(match), sourceSnippet: "Fictional Person seeks a role at Example Firm." }, { company: "Example Firm", title }).tier).toBeNull();
	});
	it("does not promote AI/software policy, driver compliance or data governance into legal/public-policy peer fit", () => {
		const person = (title: string) => ({ fullName: "Fictional Person", title, company: "Example Firm", sourceUrl: "https://www.linkedin.com/in/fictional-person", sourceSnippet: `Fictional Person is a ${title} at Example Firm.` });
		expect(rankJobContact(person("Junior AI Policy Analyst"), { company: "Example Firm", title: "Policy Research Student" }).tier).toBe(3);
		for (const title of ["Junior Driver Compliance Analyst", "Junior Sales Data Governance Analyst"]) {
			expect(rankJobContact(person(title), { company: "Example Firm", title: "Corporate Compliance Intern" }).tier).toBe(3);
		}
		expect(deriveJobDiscoveryCriteria({ company: "Example Firm", title: "AI Policy Engineer Intern", location: "", region: "", industry: null }).roles.some((role) => /Data|Engineer/.test(role))).toBe(true);
	});
});
