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
	professionalBioPerson,
	linkedInDiscoveryPerson,
	normalizeProfessionalSourceUrl,
	selectDiscoveryPeople,
	professionalBioDomains,
	type DiscoveryCriteria,
} from "../src/lib/providers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recall-first identifiable professional candidates", () => {
	const criteria: DiscoveryCriteria = {
		roles: ["Investment Analyst"], industries: [], companies: ["BMO Financial Group"],
		locations: ["Toronto"], keywords: [], seniority: [], objective: "", count: 3,
	};
	it("accepts an unfamiliar public bio with compact delimiters without claiming the target employer", () => {
		const person = professionalBioPerson({
			title: "Jane Doe|Designer at Other Firm",
			url: "https://alumni.university.edu/people/jane-doe?utm_source=search",
			content: "Jane Doe works as a designer at Other Firm.",
		}, criteria);
		expect(person).toMatchObject({
			fullName: "Jane Doe", company: "Other Firm", companyDomain: "",
			title: "Designer", matchQuality: "BROADER_COMPANY",
			sourceUrl: "https://alumni.university.edu/people/jane-doe",
		});
		expect(person?.whyRelevant).toContain("need review");
	});
	it("recovers a bare person name and a snippet-led identity, without inventing a title or company", () => {
		for (const title of ["Jamie Rivera", "Professional biography"]) {
			const person = professionalBioPerson({
				title, url: "https://consultancy.com/bio/jamie-rivera",
				content: "Jamie Rivera works with a professional research team.",
			}, criteria);
			expect(person).toMatchObject({ fullName: "Jamie Rivera", title: "", company: "", matchQuality: "BROADER_COMPANY" });
		}
	});
	it("does not turn a requested employer mention into a confirmed employment field", () => {
		const person = professionalBioPerson({
			title: "Casey Morgan", url: "https://consultancy.com/bio/casey",
			content: "Casey Morgan is an independent professional analyst interested in events hosted by BMO Financial Group in Toronto.",
		}, criteria);
		expect(person).toMatchObject({ fullName: "Casey Morgan", company: "", title: "", matchQuality: "BROADER_COMPANY" });
	});
	it("rejects non-person and unsafe pages even when a plausible name is supplied", () => {
		for (const url of [
			"javascript:alert(1)", "https://user:secret@consultancy.com/bio/jane",
			"http://127.0.0.1/people/jane", "http://[::1]/people/jane",
			"https://localhost/people/jane", "https://firm.internal/bio/jane",
			"https://consultancy.com/jobs/jane", "https://consultancy.com/search",
			"https://consultancy.com/login", "https://consultancy.com/people",
			"https://consultancy.com/", "https://linkedin.com/company/firm",
			"https://consultancy.com/jobs.html", "https://consultancy.com/j%6fbs/jane",
			"https://consultancy.com/company/firm", "https://consultancy.com/bio/jane.exe",
			"https://consultancy.com/bio/jane%00", "https://consultancy.com/bio/jane%ZZ",
		]) expect(professionalBioPerson({ title: "Jane Doe - Analyst", url, content: "Jane Doe is an analyst." }, criteria)).toBeNull();
		expect(professionalBioPerson({ title: "Conference Speakers", url: "https://conference.com/speakers/event", content: "Our professional team." }, criteria)).toBeNull();
		expect(normalizeProfessionalSourceUrl("https://consultancy.com/people/jane#bio")).toBe("https://consultancy.com/people/jane");
	});
	it("ranks strong evidence before uncertain matches and retains bounded deduplication counts", async () => {
		const weak = { title: "Jane Doe|Designer|Other Firm", url: "https://linkedin.com/in/jane-doe", content: "Designer at Other Firm." };
		const strong = { title: "Jamie Rivera - Investment Analyst - BMO | LinkedIn", url: "https://linkedin.com/in/jamie-rivera", content: "Investment Analyst at BMO Financial Group in Toronto." };
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [weak, weak, strong] })));
		const result = await discoverWithTavily("fake", { ...criteria, count: 2 });
		expect(result.people.map((person) => person.fullName)).toEqual(["Jamie Rivera", "Jane Doe"]);
		expect(result.rejectionCounts?.duplicate).toBe(1);
		expect(spy).toHaveBeenCalledTimes(1);
	});
	it("a wrong employer is reviewable but never promoted to a confirmed job tier", () => {
		const jobCriteria = deriveJobDiscoveryCriteria({
			id: "b".repeat(64), title: "Investment Analyst Intern", company: "BMO",
			location: "Toronto", region: "Canada", industry: null,
		});
		const candidate = linkedInDiscoveryPerson({
			title: "Jane Doe - Junior Investment Analyst - Other Firm | LinkedIn",
			url: "https://linkedin.com/in/jane-doe", content: "Jane Doe is a junior Investment Analyst at Other Firm.",
		}, jobCriteria);
		expect(candidate?.company).toBe("Other Firm");
		expect(candidate?.jobContact?.tier).toBeNull();
		expect(selectDiscoveryPeople(candidate ? [candidate] : [], jobCriteria)[0]?.jobContact?.tier).toBeNull();
	});
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

	it("ranks public employer bios and LinkedIn people from one job-linked web pass", async () => {
		const criteria = deriveJobDiscoveryCriteria({
			...job, location: "Toronto", region: "Canada", industry: null,
		});
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [
			{ title: "Casey Example - Senior Campus Recruiter - BMO Financial Group | LinkedIn",
				url: "https://www.linkedin.com/in/casey-example",
				content: "Casey Example is a Senior Campus Recruiter at BMO Financial Group focused on new-graduate hiring." },
			{ title: "Ava Example - Junior Investment Analyst at BMO Financial Group",
				url: "https://www.bmo.com/en/people/ava-example",
				content: "Ava Example is a Junior Investment Analyst at BMO Financial Group in Toronto." },
			{ title: "BMO investment jobs", url: "https://www.bmo.com/careers/jobs/investment",
				content: "Search investment jobs at BMO Financial Group." },
		] }));
		const result = await discoverWithTavily("fake-key", { ...criteria, count: 2 });
		expect(spy).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit)?.body));
		expect(body.include_domains).toBeUndefined();
		expect(result.people.map((candidate) => [candidate.fullName, candidate.jobContact?.tier]))
			.toEqual([["Ava Example", 1], ["Casey Example", 2]]);
		expect(result.rejectionCounts?.unsafeOrNonProfile).toBe(1);
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
		expect(query).toContain('"Recruiter" OR "Hiring Manager" OR "investment" OR "portfolio"');
		expect(query).toContain(
			'("BMO" OR "BMO Financial Group" OR "Bank of Montreal")',
		);
		expect(query).toContain(
			'("analyst" OR "associate" OR "recruiter" OR "biography" OR "profile")',
		);
		expect(query.length).toBeLessThanOrEqual(1800);
		expect(professionalBioDomains(criteria)).toEqual([
			"privatewealth.bmo.com",
			"privatewealth-insights.bmo.com",
			"bmo.com",
			"theorg.com",
		]);
	});

	it("keeps a specific RBC investment-banking search person-focused on both Tavily passes", async () => {
		const banking: DiscoveryCriteria = {
			roles: ["Investment Banking"], companies: ["RBC"], industries: [], locations: ["Toronto"],
			keywords: [], seniority: [], objective: "", count: 3,
		};
		const query = buildProfessionalBioQuery(banking);
		expect(buildDiscoveryQuery(banking)).toContain('"Investment Banking"');
		expect(query).toContain('"Investment Banking"');
		expect(query).toContain('"RBC Capital Markets"');
		expect(query).not.toContain('"leadership"');
		expect(query).not.toContain('"team"');
		expect(query).not.toContain('"wealth"');
		const responses = [
			{ results: [{ title: "RBC jobs", url: "https://www.linkedin.com/jobs/view/role",
				content: "Investment Banking in Toronto" }] },
			{ results: [
				{ title: "Investment Banking Team", url: "https://www.rbc.com/team",
					content: "Investment banking leadership at RBC." },
				{ title: "Morgan Example | Investment Banking Analyst", url: "https://www.rbc.com/people/morgan-example",
					content: "Morgan Example is an Investment Banking Analyst at RBC Capital Markets in Toronto." },
			] },
		];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json(responses.shift()));
		const found = await discoverWithTavily("fake", banking);
		expect(spy).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit)?.body));
		expect(firstBody.include_domains).toBeUndefined();
		expect(firstBody.include_domains_mode).toBeUndefined();
		expect(JSON.parse(String((spy.mock.calls[1]?.[1] as RequestInit)?.body)).query).toBe(query);
		expect(found.people).toHaveLength(1);
		expect(found.people[0]).toMatchObject({
			fullName: "Morgan Example", matchQuality: "STRONG",
			sourceUrl: "https://www.rbc.com/people/morgan-example",
		});
		expect(found.rejectionCounts?.unsafeOrNonProfile).toBe(2);
	});

	it("retains LinkedIn and public professional bios in the first broad-web pass without adding a search", async () => {
		const banking: DiscoveryCriteria = {
			roles: ["Investment Banking"], companies: ["RBC"], industries: [], locations: ["Toronto"],
			keywords: [], seniority: [], objective: "", count: 2,
		};
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [
			{ title: "Morgan Example - Investment Banking Analyst - RBC Capital Markets | LinkedIn",
				url: "https://www.linkedin.com/in/morgan-example",
				content: "Morgan Example is an Investment Banking Analyst at RBC Capital Markets in Toronto." },
			{ title: "Alex Example | Investment Banking Associate at RBC Capital Markets",
				url: "https://www.rbc.com/people/alex-example",
				content: "Alex Example is an Investment Banking Associate at RBC Capital Markets in Toronto." },
			{ title: "RBC Investment Banking jobs",
				url: "https://www.rbc.com/careers/jobs/investment-banking",
				content: "Find jobs with RBC Capital Markets." },
		] }));
		const found = await discoverWithTavily("fake", banking);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe("https://api.tavily.com/search");
		const firstBody = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit)?.body));
		expect(firstBody.include_domains).toBeUndefined();
		expect(firstBody.include_domains_mode).toBeUndefined();
		expect(firstBody.query).toContain('"Investment Banking"');
		expect(found).toMatchObject({
			primaryProviderReturned: 3, primaryAccepted: 2, fallbackProviderReturned: 0,
			fallbackAccepted: 0, rejectionCounts: { unsafeOrNonProfile: 1 },
		});
		expect(found.people.map((person) => person.fullName)).toEqual(["Alex Example", "Morgan Example"]);
		expect(found.people.every((person) => person.matchQuality === "STRONG")).toBe(true);
	});

	it("keeps VC/VC analyst intent in the second Tavily pass without targeting generic team directories", async () => {
		const ventureCriteria: DiscoveryCriteria = {
			roles: ["VC", "VC analyst"], industries: [], companies: [], locations: ["Toronto"],
			keywords: [], seniority: [], objective: "", count: 3,
		};
		const query = buildProfessionalBioQuery(ventureCriteria);
		expect(buildDiscoveryQuery(ventureCriteria)).toContain('"venture capital analyst"');
		expect(query).toContain('"venture capital"');
		expect(query).toContain('"venture capital analyst"');
		expect(query).not.toContain('"team"');
		expect(query).not.toContain('"leadership"');
		const response = [
			{ results: [
				{ title: "VC jobs", url: "https://venture.example/jobs", content: "Analyst jobs in Toronto." },
				{ title: "Venture capital firm", url: "https://www.linkedin.com/company/venture", content: "VC analyst." },
				{ title: "Venture capital posts", url: "https://www.linkedin.com/posts/venture", content: "VC analyst." },
			] },
			{ results: [
				{ title: "Venture Capital Team", url: "https://venture.example/team", content: "Meet our analyst team." },
				{ title: "Jane Doe | Venture Capital Analyst", url: "https://venture.example/team/jane-doe",
					content: "Jane Doe is a venture capital analyst in Toronto." },
			] },
		];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			new Response(JSON.stringify(response.shift()), { headers: { "Content-Type": "application/json" } }));
		const found = await discoverWithTavily("fake-key", ventureCriteria);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String((spy.mock.calls[1]?.[1] as RequestInit)?.body)).query).toBe(query);
		expect(found.rejectionCounts?.unsafeOrNonProfile).toBe(4);
		expect(found.people).toHaveLength(1);
		expect(found.people[0]).toMatchObject({ fullName: "Jane Doe", matchQuality: "BROADER_COMPANY",
			sourceUrl: "https://venture.example/team/jane-doe" });
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
			strongAccepted: 2,
			broaderAccepted: 1,
		});
		expect(result.people).toHaveLength(3);
		expect(result.people.find((person) => person.fullName === "Alexander Spark")).toMatchObject({
			fullName: "Alexander Spark",
			company: "BMO Financial Group",
			companyDomain: "bmo.com",
			linkedinUrl: "",
			sourceUrl:
				"https://privatewealth.bmo.com/en/people/alexander-spark",
		});
		expect(result.people.find((person) => person.fullName === "Brent Joyce")).toMatchObject({
			fullName: "Brent Joyce",
			company: "BMO Financial Group",
			companyDomain: "bmo.com",
			linkedinUrl: "",
			sourceUrl:
				"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
		});
		expect(result.people.find((person) => person.fullName === "Natalya Demberg")).toMatchObject({
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
		expect(primaryBody.include_domains).toBeUndefined();
		expect(primaryBody.include_domains_mode).toBeUndefined();
		expect(primaryBody.query).toContain(
			'("Investment Team" OR "Investment Analyst" OR "Portfolio Manager"',
		);
		expect(primaryBody.query).not.toContain(
			"Banking & Financial Services",
		);
		expect(fallbackBody.query).not.toContain("site:linkedin.com/in");
		expect(fallbackBody.query).not.toContain("site:");
		expect(fallbackBody.include_domains).toBeUndefined();
		expect(fallbackBody.include_domains_mode).toBeUndefined();
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
			company: "TD",
			matchQuality: "BROADER_COMPANY",
		});
	});

	it("retains company-only profiles for uncertain human review", async () => {
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
			strongAccepted: 0,
			broaderAccepted: 1,
			insufficientMatchRejected: 0,
		});
		expect(result.people[0]?.whyRelevant).toContain("need review");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("retains a differing employer without asserting the requested employer", async () => {
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
			primaryAccepted: 1,
			fallbackProviderReturned: 0,
			fallbackAccepted: 0,
			insufficientMatchRejected: 0,
			strongAccepted: 0,
			broaderAccepted: 1,
		});
		expect(result.people[0]?.company).toBe("UMBC");
		expect(result.people[0]?.matchQuality).toBe("BROADER_COMPANY");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
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
