import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deriveJobDiscoveryCriteria,
	employerDisplayName,
	rankJobContact,
	compareJobContactMatches,
} from "../src/lib/job-discovery";
import {
	buildDiscoveryQuery,
	buildProfessionalBioQuery,
	discoverWithTavily,
	parseProfessionalBioTitle,
	professionalBioDomains,
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

	it("targets junior investment peers before early-career recruiting and other juniors", () => {
		const criteria = deriveJobDiscoveryCriteria({
			company: "bmo",
			title: "Investment Team Intern - Winter 2027",
			location: "Toronto, ON",
			region: "Canada",
			industry: "Banking & Financial Services",
		});
		expect(criteria.companies).toEqual(["BMO Financial Group"]);
		expect(criteria.roles.slice(0, 3)).toEqual([
			"Junior Investment Analyst",
			"Investment Analyst I",
			"Investment Intern",
		]);
		expect(criteria.roles).toEqual(
			expect.arrayContaining(["Campus Recruiter", "New Graduate Recruiter", "Junior"]),
		);
		expect(criteria.roles.join(" ")).not.toMatch(/manager|director|leadership/i);
		expect(criteria.seniority).toContain("Entry-level");
		expect(criteria.jobContext).toEqual({ company: "BMO Financial Group", title: "Investment Team Intern - Winter 2027" });
		expect(criteria.keywords).toEqual(["investment", "portfolio"]);
		expect(criteria.keywords).not.toContain(
			"Investment Team Intern - Winter 2027",
		);
		expect(criteria.objective).toContain(
			"Investment Team Intern - Winter 2027",
		);
		expect(criteria.objective).toContain("BMO Financial Group");
	});

	it("targets early-career recruiters and other juniors without guessing an unknown function", () => {
		const criteria = deriveJobDiscoveryCriteria({
			company: "Unknown Employer",
			title: "Summer Intern",
			location: "",
			region: "",
			industry: null,
		});
		expect(criteria.roles).toEqual([
			"Campus Recruiter",
			"University Recruiter",
			"Early Careers Recruiter",
			"New Graduate Recruiter",
			"Junior",
			"Entry-level",
			"Graduate Trainee",
		]);
		expect(criteria.keywords).toEqual([]);
		expect(criteria.industries).toEqual([]);
	});
});

describe("job-specific contact priorities", () => {
	const job = { company: "BMO Financial Group", title: "Investment Intern" };
	const person = (title: string, sourceSnippet = `Alex Example is a ${title} at BMO Financial Group.`) => ({
		fullName: "Alex Example", title, company: "BMO Financial Group", sourceSnippet,
		sourceUrl: "https://www.linkedin.com/in/fictional-alex",
	});

	it("ranks by tier before score, with job-dependent function relevance", () => {
		const peer = person("Junior Investment Analyst");
		const campus = person("Senior Campus Recruiter");
		const other = person("Junior Software Engineer");
		expect(rankJobContact(peer, job)).toMatchObject({ tier: 1, currentCompany: true, roleRelevant: true });
		expect(rankJobContact(campus, job)).toMatchObject({ tier: 2 });
		expect(rankJobContact(other, job)).toMatchObject({ tier: 3, roleRelevant: false });
		expect(rankJobContact(other, { ...job, title: "Software Engineering Intern" }).tier).toBe(1);
		expect(rankJobContact(peer, { ...job, title: "Software Engineering Intern" }).tier).toBe(3);
		expect(compareJobContactMatches({ ...rankJobContact(peer, job), score: 0 }, { ...rankJobContact(campus, job), score: 100 })).toBeLessThan(0);
		expect(compareJobContactMatches({ ...rankJobContact(campus, job), score: 0 }, { ...rankJobContact(other, job), score: 100 })).toBeLessThan(0);
	});

	it.each([
		"Senior Investment Analyst", "Lead Investment Analyst", "Associate Director of Investments",
		"VP Investment Associate", "Principal Investment Analyst", "Investment Analyst II",
		"Investment Analyst", "Investment Associate", "Recruiter",
	])("keeps %s unconfirmed rather than manufacturing junior or campus evidence", (title) => {
		expect(rankJobContact(person(title), job)).toMatchObject({ tier: null, currentCompany: true });
	});

	it("uses explicit recruitment remit, not recruiter age, seniority or university attendance", () => {
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group focused on new-graduate hiring."), job).tier).toBe(2);
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group. Studied at a university and looks young."), job).tier).toBeNull();
		expect(rankJobContact(person("Junior Recruiter"), job).tier).toBe(3);
		expect(rankJobContact(person("Investment Analyst", "Alex Example is an Investment Analyst at BMO Financial Group. Young face in a photo."), job).tier).toBeNull();
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group. Recruits for internships and new graduates."), job).tier).toBe(2);
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group, not a campus recruiter."), job).tier).toBeNull();
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter and a new graduate at BMO Financial Group."), job).tier).toBeNull();
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group and is early in their career."), job).tier).toBeNull();
		expect(rankJobContact(person("Recruiter", "Alex Example is a Recruiter at BMO Financial Group. Hiring new graduates and interns."), job).tier).toBe(2);
	});

	it("does not trust unsupported or contradictory role/seniority fields", () => {
		expect(rankJobContact(person("Junior Investment Analyst", "Alex Example works at BMO Financial Group."), job).tier).toBeNull();
		expect(rankJobContact(person("Junior Investment Analyst", "Alex Example - Junior Investment Analyst - BMO | LinkedIn\nAlex Example is a Senior Investment Analyst at BMO Financial Group."), job).tier).toBeNull();
	});

	it.each([
		"Alex Example was a Junior Investment Analyst at BMO Financial Group.",
		"Alex Example is a Junior Investment Analyst at Other Firm. Interested in BMO Financial Group.",
		"Alex Example previously worked as a Junior Investment Analyst at BMO Financial Group; now at Other Firm.",
		"Alex Example - Junior Investment Analyst - BMO | LinkedIn\nAlex Example currently works at Other Firm.",
		"Alex Example - Junior Investment Analyst - BMO | LinkedIn\nJunior Investment Analyst at BMO, 2020 - 2022.",
		"Junior Investment Analyst, BMO Financial Group", // A company keyword alone is not employment evidence.
	])("rejects former, aspirational, ambiguous or wrong-employer evidence: %s", (evidence) => {
		expect(rankJobContact(person("Junior Investment Analyst", evidence), job)).toMatchObject({ tier: null, currentCompany: false });
	});

	it("recognizes employer aliases, but still requires a supported source", () => {
		const candidate = person("Investment Analyst I", "Alex Example is an Investment Analyst I at Bank of Montreal.");
		expect(rankJobContact(candidate, job).tier).toBe(1);
		expect(rankJobContact({ ...candidate, sourceUrl: "https://example.test/uncited" }, job).tier).toBeNull();
		expect(rankJobContact({ ...candidate, sourceUrl: "https://www.bmo.com/careers/jobs/alex" }, job).tier).toBeNull();
		expect(rankJobContact({ ...candidate, sourceUrl: "https://www.bmo.com/en/people" }, job).tier).toBeNull();
	});

	it("collects and ranks all returned candidates before truncating, without per-tier searches", async () => {
		const criteria = deriveJobDiscoveryCriteria({
			...job, company: "bmo", location: "Toronto", region: "Canada", industry: null,
		});
		const profiles = [
			["Zed Example", "Junior Software Engineer", "BMO"],
			["Casey Example", "Senior Campus Recruiter", "BMO"],
			["Wrong Example", "Junior Investment Analyst", "Other Firm"],
			["Senior Example", "Senior Investment Analyst", "BMO"],
			["Amy Example", "Junior Investment Analyst", "BMO"],
		].map(([name, title, company]) => ({
			title: `${name} - ${title} - ${company} | LinkedIn`,
			url: `https://www.linkedin.com/in/fictional-${name!.split(" ")[0]!.toLowerCase()}`,
			content: `${name} is a ${title} at ${company}.`,
		}));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: profiles })));
		const result = await discoverWithTavily("fake-tavily-key", { ...criteria, count: 3 });
		expect(result.people.map((candidate) => candidate.fullName)).toEqual(["Amy Example", "Casey Example", "Zed Example"]);
		expect(result.people.map((candidate) => candidate.jobContact?.tier)).toEqual([1, 2, 3]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const query = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).query;
		expect(query).toContain('"Campus Recruiter"');
		expect(query).toContain('"Junior Investment Analyst"');
		expect(query).not.toMatch(/manager|leadership/i);
		expect(buildProfessionalBioQuery(criteria)).not.toMatch(/manager|leadership/i);
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
		expect(query).toContain(
			'("Recruiter" OR "Hiring Manager" OR "investment" OR "portfolio")',
		);
		expect(query).toContain('("bmo" OR "BMO Financial Group")');
		expect(query).toContain('("Toronto" OR "Canada")');
		expect(query).toContain(" AND ");
		expect(query).not.toContain('"Recruiter" "Hiring Manager"');
		expect(query).not.toContain("site:");
		expect(query).not.toContain("Banking & Financial Services");
	});

	it("builds a broader professional bio query without a LinkedIn site lock", () => {
		const query = buildProfessionalBioQuery(criteria);
		expect(query).not.toContain("site:linkedin.com/in");
		expect(query).not.toContain("site:");
		expect(query).toContain('"investment" OR "portfolio" OR "wealth"');
		expect(query).toContain(
			'("BMO" OR "BMO Financial Group" OR "Bank of Montreal")',
		);
		expect(query).toContain(
			'("team" OR "bio" OR "profile" OR "leadership")',
		);
		expect(query.length).toBeLessThanOrEqual(1800);
		expect(professionalBioDomains(criteria)).toEqual([
			"privatewealth.bmo.com",
			"privatewealth-insights.bmo.com",
			"bmo.com",
			"theorg.com",
		]);
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
		expect((query.match(/Role/g) || [])).toHaveLength(12);
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
		count: 3,
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
								title: "Meet Our Team - Alexander Spark",
								url: "https://privatewealth.bmo.com/en/people/alexander-spark",
								content:
									"Alexander Spark works with the investment and portfolio team at BMO Financial Group in Toronto.",
							},
							{
								title:
									"Brent Joyce, Chief Investment Strategist | BMO",
								url: "https://privatewealth-insights.bmo.com/en/people/brent-joyce",
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
		expect(result).toMatchObject({
			providerReturned: 5,
			primaryProviderReturned: 0,
			primaryAccepted: 0,
			fallbackProviderReturned: 5,
			fallbackAccepted: 3,
			insufficientMatchRejected: 0,
			strongAccepted: 3,
			broaderAccepted: 0,
		});
		expect(result.people).toHaveLength(3);
		expect(result.people[0]).toMatchObject({
			fullName: "Alexander Spark",
			company: "BMO Financial Group",
			companyDomain: "bmo.com",
			linkedinUrl: "",
			sourceUrl:
				"https://privatewealth.bmo.com/en/people/alexander-spark",
		});
		expect(result.people[1]).toMatchObject({
			fullName: "Brent Joyce",
			company: "BMO Financial Group",
			companyDomain: "bmo.com",
			linkedinUrl: "",
			sourceUrl:
				"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
		});
		expect(result.people[2]).toMatchObject({
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
		expect(primaryBody.query).not.toContain("site:");
		expect(primaryBody.include_domains).toEqual(["linkedin.com"]);
		expect(primaryBody.include_domains_mode).toBe("restrict");
		expect(primaryBody.query).toContain(
			'("Investment Team" OR "Investment Analyst" OR "Portfolio Manager"',
		);
		expect(primaryBody.query).not.toContain(
			"Banking & Financial Services",
		);
		expect(fallbackBody.query).not.toContain("site:linkedin.com/in");
		expect(fallbackBody.query).not.toContain("site:");
		expect(fallbackBody.include_domains).toEqual([
			"privatewealth.bmo.com",
			"privatewealth-insights.bmo.com",
			"bmo.com",
			"theorg.com",
		]);
		expect(fallbackBody.include_domains_mode).toBe("restrict");
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
		expect(result).toMatchObject({
			primaryProviderReturned: 1,
			primaryAccepted: 1,
			fallbackProviderReturned: 0,
			fallbackAccepted: 0,
			insufficientMatchRejected: 0,
			strongAccepted: 1,
			broaderAccepted: 0,
		});
		expect(result.people[0]?.linkedinUrl).toBe(
			"https://www.linkedin.com/in/alex-example",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("accepts BMO and TD LinkedIn profiles with company and role evidence", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Alex Example - Investment Analyst - BMO | LinkedIn",
								url: "https://www.linkedin.com/in/alex-bmo",
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
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Taylor Example - Portfolio Manager - TD | LinkedIn",
								url: "https://www.linkedin.com/in/taylor-td",
								content:
									"Portfolio Manager at TD Bank Group in Toronto.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		const bmo = await discoverWithTavily("test-key", {
			...criteria,
			count: 1,
		});
		const td = await discoverWithTavily("test-key", {
			...criteria,
			companies: ["TD Bank Group"],
			count: 1,
		});
		expect(bmo.people[0]).toMatchObject({
			fullName: "Alex Example",
			company: "BMO Financial Group",
			matchQuality: "STRONG",
		});
		expect(td.people[0]).toMatchObject({
			fullName: "Taylor Example",
			company: "TD Bank Group",
			matchQuality: "STRONG",
		});
	});

	it("accepts professional company-and-location profiles as broader matches", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Morgan Example - Managing Director - BMO | LinkedIn",
								url: "https://www.linkedin.com/in/morgan-bmo",
								content:
									"Managing Director at BMO Financial Group in Toronto.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Jordan Example - Vice President - TD | LinkedIn",
								url: "https://www.linkedin.com/in/jordan-td",
								content:
									"Vice President at TD Bank Group in Toronto.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		const bmo = await discoverWithTavily("test-key", {
			...criteria,
			count: 1,
		});
		const td = await discoverWithTavily("test-key", {
			...criteria,
			companies: ["TD Bank Group"],
			count: 1,
		});
		expect(bmo).toMatchObject({
			strongAccepted: 0,
			broaderAccepted: 1,
			insufficientMatchRejected: 0,
		});
		expect(bmo.people[0]).toMatchObject({
			company: "BMO Financial Group",
			matchQuality: "BROADER_COMPANY",
		});
		expect(td.people[0]).toMatchObject({
			company: "TD Bank Group",
			matchQuality: "BROADER_COMPANY",
		});
	});

	it("rejects company-only profiles without location or hiring relevance", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Casey Example - Managing Director - BMO | LinkedIn",
								url: "https://www.linkedin.com/in/casey-bmo",
								content: "Managing Director at BMO Financial Group.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const result = await discoverWithTavily("test-key", {
			...criteria,
			count: 1,
		});
		expect(result).toMatchObject({
			people: [],
			strongAccepted: 0,
			broaderAccepted: 0,
			insufficientMatchRejected: 1,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("rejects a Lyft query result without Lyft company evidence", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Gaurav Shinde - Graduate Researcher - UMBC | LinkedIn",
								url: "https://www.linkedin.com/in/gaurav-shinde",
								content:
									"Machine learning researcher at University of Maryland Baltimore County.",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const result = await discoverWithTavily("test-key", {
			roles: ["Engineering Team", "Software Engineer"],
			industries: ["Technology"],
			companies: ["Lyft"],
			locations: ["Toronto"],
			keywords: ["software engineering", "machine learning"],
			seniority: [],
			objective: "",
			count: 1,
		});
		expect(result).toMatchObject({
			primaryProviderReturned: 1,
			primaryAccepted: 0,
			fallbackProviderReturned: 0,
			fallbackAccepted: 0,
			insufficientMatchRejected: 1,
			strongAccepted: 0,
			broaderAccepted: 0,
			people: [],
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("preserves manual no-company venture capital discovery", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title:
								"Jamie Example - Venture Capital Analyst - Golden Ventures | LinkedIn",
							url: "https://www.linkedin.com/in/jamie-vc",
							content:
								"Venture Capital Analyst at Golden Ventures in Toronto.",
						},
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		const result = await discoverWithTavily("test-key", {
			roles: ["Venture Capital Analyst"],
			industries: ["Venture Capital"],
			companies: [],
			locations: ["Toronto"],
			keywords: [],
			seniority: [],
			objective: "",
			count: 1,
		});
		expect(result.people[0]).toMatchObject({
			fullName: "Jamie Example",
			company: "Golden Ventures",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
