import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deriveJobDiscoveryCriteria,
	employerDisplayName,
} from "../src/lib/job-discovery";
import {
	buildDiscoveryQuery,
	buildProfessionalBioQuery,
	discoverWithTavily,
	parseProfessionalBioTitle,
	type DiscoveryCriteria,
} from "../src/lib/providers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("job-derived networking criteria", () => {
	it("normalizes known employer display aliases", () => {
		expect(employerDisplayName("bmo")).toBe("BMO Financial Group");
		expect(employerDisplayName(" Bank of Montreal ")).toBe(
			"BMO Financial Group",
		);
		expect(employerDisplayName("td")).toBe("TD Bank Group");
		expect(employerDisplayName("Maple Ventures")).toBe("Maple Ventures");
	});

	it("derives investment professionals before recruiting roles", () => {
		const criteria = deriveJobDiscoveryCriteria({
			company: "bmo",
			title: "Investment Team Intern - Winter 2027",
			location: "Toronto, ON",
			region: "Canada",
			industry: "Banking & Financial Services",
		});
		expect(criteria.companies).toEqual(["BMO Financial Group"]);
		expect(criteria.roles.slice(0, 4)).toEqual([
			"Investment Team",
			"Investment Analyst",
			"Portfolio Manager",
			"Investment Professional",
		]);
		expect(criteria.roles).toEqual(
			expect.arrayContaining(["Talent Acquisition", "Recruiter"]),
		);
		expect(criteria.keywords).toEqual(["investment", "portfolio"]);
		expect(criteria.keywords).not.toContain(
			"Investment Team Intern - Winter 2027",
		);
		expect(criteria.objective).toContain(
			"Investment Team Intern - Winter 2027",
		);
		expect(criteria.objective).toContain("BMO Financial Group");
	});

	it("falls back to hiring and recruiting roles without guessing a team", () => {
		const criteria = deriveJobDiscoveryCriteria({
			company: "Unknown Employer",
			title: "Summer Intern",
			location: "",
			region: "",
			industry: null,
		});
		expect(criteria.roles).toEqual([
			"Hiring Manager",
			"Talent Acquisition",
			"Recruiter",
		]);
		expect(criteria.keywords).toEqual([]);
		expect(criteria.industries).toEqual([]);
	});
});

describe("discovery query semantics", () => {
	const criteria: DiscoveryCriteria = {
		roles: ["Recruiter", "Hiring Manager"],
		industries: ["Banking & Financial Services"],
		companies: ["bmo", "BMO Financial Group"],
		locations: ["Toronto", "Canada"],
		keywords: ["investment", "portfolio"],
		seniority: [],
		objective: "",
		count: 5,
	};

	it("uses OR within categories and AND between categories", () => {
		const query = buildDiscoveryQuery(criteria);
		expect(query).toContain('("Recruiter" OR "Hiring Manager")');
		expect(query).toContain('("bmo" OR "BMO Financial Group")');
		expect(query).toContain('("Toronto" OR "Canada")');
		expect(query).toContain(" AND ");
		expect(query).not.toContain('"Recruiter" "Hiring Manager"');
	});

	it("builds a broader professional bio query without a LinkedIn site lock", () => {
		const query = buildProfessionalBioQuery(criteria);
		expect(query).not.toContain("site:linkedin.com/in");
		expect(query).toContain('("investment" OR "portfolio")');
		expect(query).toContain(
			'("team" OR "bio" OR "profile" OR "leadership")',
		);
		expect(query.length).toBeLessThanOrEqual(1800);
	});

	it("sanitizes and caps large alternative groups", () => {
		const query = buildDiscoveryQuery({
			...criteria,
			roles: Array.from(
				{ length: 20 },
				(_, index) => `Role \"${index}\"\\unsafe`,
			),
		});
		expect(query).not.toContain("\\");
		expect((query.match(/Role/g) || [])).toHaveLength(8);
		expect(query.length).toBeLessThanOrEqual(1800);
	});
});

describe("professional bio fallback", () => {
	const criteria: DiscoveryCriteria = {
		roles: [
			"Investment Team",
			"Investment Analyst",
			"Portfolio Manager",
			"Talent Acquisition",
		],
		industries: ["Banking & Financial Services"],
		companies: ["BMO Financial Group"],
		locations: ["Toronto"],
		keywords: ["investment", "portfolio"],
		seniority: [],
		objective: "Learn about the investment team.",
		count: 2,
	};

	it("parses person-specific professional bio title patterns", () => {
		expect(
			parseProfessionalBioTitle("Meet Our Team - Alexander Spark"),
		).toMatchObject({
			fullName: "Alexander Spark",
			firstName: "Alexander",
			lastName: "Spark",
			title: "",
		});
		expect(
			parseProfessionalBioTitle(
				"Brent Joyce, Chief Investment Strategist | BMO",
			),
		).toMatchObject({
			fullName: "Brent Joyce",
			title: "Chief Investment Strategist",
		});
		expect(
			parseProfessionalBioTitle(
				"Natalya Demberg - Head of Investments | The Org",
			),
		).toMatchObject({
			fullName: "Natalya Demberg",
			title: "Head of Investments",
		});
		expect(parseProfessionalBioTitle("BMO Investment Team")).toBeNull();
	});

	it("accepts official and vetted bios while rejecting jobs and generic pages", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Brent Joyce, Chief Investment Strategist | BMO",
								url: "https://capitalmarkets.bmo.com/en/our-people/brent-joyce",
								content:
									"Brent Joyce is Chief Investment Strategist at BMO Financial Group in Toronto.",
							},
							{
								title:
									"Natalya Demberg - Head of Investments | The Org",
								url: "https://theorg.com/org/bmo-financial-group/org-chart/natalya-demberg",
								content:
									"Natalya Demberg leads an investment team at BMO Financial Group in Toronto.",
							},
							{
								title: "Investment jobs at BMO",
								url: "https://www.bmo.com/careers/jobs/investment",
								content:
									"Search investment jobs at BMO Financial Group in Toronto.",
							},
							{
								title: "BMO announces investment outlook",
								url: "https://www.bmo.com/news/investment-outlook",
								content: "News from BMO Financial Group in Toronto.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		const result = await discoverWithTavily("test-tavily-key", criteria);
		expect(result.providerReturned).toBe(4);
		expect(result.people).toHaveLength(2);
		expect(result.people[0]).toMatchObject({
			fullName: "Brent Joyce",
			company: "BMO Financial Group",
			companyDomain: "bmo.com",
			linkedinUrl: "",
			sourceUrl:
				"https://capitalmarkets.bmo.com/en/our-people/brent-joyce",
		});
		expect(result.people[1]).toMatchObject({
			fullName: "Natalya Demberg",
			company: "BMO Financial Group",
			linkedinUrl: "",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const primaryBody = JSON.parse(
			String((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.body),
		);
		const fallbackBody = JSON.parse(
			String((fetchSpy.mock.calls[1]?.[1] as RequestInit)?.body),
		);
		expect(primaryBody.query).toContain("site:linkedin.com/in");
		expect(primaryBody.query).toContain(
			'("Investment Team" OR "Investment Analyst"',
		);
		expect(fallbackBody.query).not.toContain("site:linkedin.com/in");
	});

	it("preserves accepted LinkedIn results without invoking fallback", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title:
								"Alex Example - Investment Analyst - BMO | LinkedIn",
							url: "https://www.linkedin.com/in/alex-example",
							content:
								"Investment Analyst at BMO Financial Group in Toronto.",
						},
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		const result = await discoverWithTavily("test-tavily-key", {
			...criteria,
			count: 1,
		});
		expect(result.people).toHaveLength(1);
		expect(result.people[0]?.linkedinUrl).toBe(
			"https://www.linkedin.com/in/alex-example",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
