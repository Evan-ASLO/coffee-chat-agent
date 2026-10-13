import type { JobIndustry } from "./job-classification";
import { technicalRoleProfile, technicalRoleNames, sameTechnicalFunction } from "./job-career-tracks";

export interface JobDiscoveryCriteria {
	roles: string[];
	industries: string[];
	companies: string[];
	locations: string[];
	keywords: string[];
	seniority: string[];
	objective: string;
	count: number;
	jobContext?: JobContactContext;
}

export interface JobContactContext {
	company: string;
	title: string;
}

export interface JobContactEvidence {
	fullName: string;
	title: string;
	company: string;
	sourceSnippet: string;
	sourceUrl: string;
}

export interface JobContactMatch {
	tier: 1 | 2 | 3 | null;
	label: string;
	reason: string;
	evidence: string;
	currentCompany: boolean;
	roleRelevant: boolean;
	score: number;
}

const EMPLOYER_DISPLAY_ALIASES = new Map<string, string>([
	["bmo", "BMO Financial Group"],
	["bank of montreal", "BMO Financial Group"],
	["td", "TD Bank Group"],
	["td bank", "TD Bank Group"],
	["toronto dominion bank", "TD Bank Group"],
	["toronto dominion", "TD Bank Group"],
	["scotiabank", "Scotiabank"],
	["bank of nova scotia", "Scotiabank"],
	["cibc", "CIBC"],
	["canadian imperial bank of commerce", "CIBC"],
	["rbc", "RBC"],
	["royal bank of canada", "RBC"],
	["d2l", "D2L"],
	["desire2learn", "D2L"],
]);

const EMPLOYER_DISCOVERY_HINTS = new Map<
	string,
	{ aliases: string[]; domains: string[]; topics: string[] }
>([
	[
		"bmo financial group",
		{
			aliases: ["BMO", "BMO Financial Group", "Bank of Montreal"],
			domains: [
				"privatewealth.bmo.com",
				"privatewealth-insights.bmo.com",
				"bmo.com",
			],
			topics: ["investment", "portfolio", "wealth", "talent"],
		},
	],
	[
		"td bank group",
		{
			aliases: ["TD", "TD Bank Group", "Toronto-Dominion Bank"],
			domains: ["td.com"],
			topics: ["investment", "wealth", "capital markets", "talent"],
		},
	],
	[
		"scotiabank",
		{
			aliases: ["Scotiabank", "Bank of Nova Scotia"],
			domains: ["scotiabank.com"],
			topics: ["investment", "wealth", "capital markets", "talent"],
		},
	],
	[
		"cibc",
		{
			aliases: ["CIBC", "Canadian Imperial Bank of Commerce"],
			domains: ["cibc.com"],
			topics: ["investment", "wealth", "capital markets", "talent"],
		},
	],
	[
		"rbc",
		{
			aliases: ["RBC", "Royal Bank of Canada", "RBC Capital Markets"],
			domains: ["rbc.com"],
			topics: ["investment", "wealth", "capital markets", "talent"],
		},
	],
	[
		"d2l",
		{
			aliases: ["D2L", "Desire2Learn"],
			domains: ["d2l.com"],
			topics: ["engineering", "product", "data", "talent"],
		},
	],
]);

const ROLE_RULES: Array<{
	pattern: RegExp;
	roles: string[];
	keywords: string[];
	preferFunction?: boolean;
}> = [
	{
		pattern: /\b(public policy|government relations|intergovernmental relations|public affairs|government affairs|legislative|parliamentary|justice research|human rights policy|policy research|policy analyst|advocacy)\b/i,
		roles: ["Junior Policy Analyst", "Government Relations Intern", "Junior Government Relations Analyst"],
		keywords: ["public policy", "government relations"],
		preferFunction: true,
	},
	{
		pattern: /\b(law clerk|paralegal)\b/i,
		roles: ["Junior Law Clerk", "Law Clerk Intern", "Junior Paralegal"],
		keywords: ["law clerk", "paralegal"],
		preferFunction: true,
	},
	{
		pattern: /\b(legal|contracts? management|corporate secretarial)\b/i,
		roles: ["Junior Legal Operations Analyst", "Legal Assistant Intern", "Junior Contract Analyst"],
		keywords: ["legal operations", "contract management"],
		preferFunction: true,
	},
	{
		pattern: /^(?!.*\b(?:data|sales|driver|product|environmental|credit|market|risk|software|engineer|engineering|science)\b).*\bgovernance\b/i,
		roles: ["Junior Governance Analyst", "Governance Intern", "Junior Compliance Analyst"],
		keywords: ["governance", "compliance"],
		preferFunction: true,
	},
	{
		pattern: /^(?!.*\b(?:driver|product|environmental|sales|data governance|software|engineer|engineering|scientific|science)\b).*\b(compliance|corporate governance|corporate ethics|privacy|data protection)\b/i,
		roles: ["Junior Compliance Analyst", "Compliance Analyst I", "Compliance Intern"],
		keywords: ["compliance", "governance"],
		preferFunction: true,
	},
	{
		pattern: /\b(investment|portfolio|asset management)\b/i,
		roles: [
			"Junior Investment Analyst",
			"Investment Analyst I",
			"Investment Intern",
		],
		keywords: ["investment", "portfolio"],
	},
	{
		pattern: /\b(capital markets?|equity research|fixed income)\b/i,
		roles: [
			"Junior Capital Markets Analyst",
			"Investment Banking Analyst",
			"Capital Markets Intern",
		],
		keywords: ["capital markets"],
	},
	{
		pattern: /\b(wealth|private banking)\b/i,
		roles: ["Junior Wealth Analyst", "Wealth Management Intern"],
		keywords: ["wealth management"],
	},
	{
		pattern: /\b(finance|financial|accounting|accountant|treasury)\b/i,
		roles: ["Junior Financial Analyst", "Financial Analyst I", "Accounting Intern"],
		keywords: ["finance"],
	},
	{
		pattern: /\b(data|analytics|machine learning|artificial intelligence)\b/i,
		roles: ["Junior Data Analyst", "Data Analyst I", "Data Science Intern"],
		keywords: ["data analytics"],
	},
	{
		pattern: /\b(software|developer|backend|frontend|full.stack|cybersecurity)\b/i,
		roles: ["Junior Software Engineer", "Software Engineer I", "Software Intern"],
		keywords: ["software engineering"],
	},
	{
		pattern: /\b(product)\b/i,
		roles: ["Junior Product Analyst", "Product Design Intern", "Junior Product Designer"],
		keywords: ["product"],
	},
	{
		pattern: /\b(marketing|brand|communications)\b/i,
		roles: ["Junior Marketing Specialist", "Marketing Intern", "Marketing Coordinator"],
		keywords: ["marketing"],
	},
	{
		pattern: /\b(operations|supply chain|logistics)\b/i,
		roles: ["Junior Operations Analyst", "Operations Analyst I", "Operations Intern"],
		keywords: ["operations"],
	},
	{
		pattern: /\b(risk|compliance|audit)\b/i,
		roles: ["Junior Risk Analyst", "Risk Analyst I", "Compliance Intern"],
		keywords: ["risk"],
	},
	{
		pattern: /\b(consulting|advisory|strategy)\b/i,
		roles: ["Junior Consultant", "Consulting Analyst", "Consulting Intern"],
		keywords: ["consulting"],
	},
];

const SECONDARY_ROLES = [
	"Campus Recruiter",
	"University Recruiter",
	"Early Careers Recruiter",
	"New Graduate Recruiter",
	"Junior",
	"Entry-level",
	"Graduate Trainee",
];

function roleRuleFor(title: string) {
	const technicalTitle = /\b(?:software|ai|engineer(?:ing)?|developer|data (?:analyst|engineer|science)|machine learning)\b/i.test(title);
	return ROLE_RULES.find((candidate) => candidate.pattern.test(title) && (!candidate.preferFunction || !technicalTitle));
}

export function employerDisplayName(company: string): string {
	const clean = company.trim().replace(/\s+/g, " ");
	const normalized = normalizeEmployer(clean);
	return EMPLOYER_DISPLAY_ALIASES.get(normalized) || clean;
}

export function sameEmployer(company: string, requested: string): boolean {
	const normalize = (value: string) => normalizeEmployer(value)
		.replace(/\s+(inc|incorporated|ltd|limited|corp|corporation)$/, "");
	return employerSearchAliases([requested]).some((alias) =>
		normalize(alias) === normalize(company),
	);
}

export function deriveJobDiscoveryCriteria(input: {
	company: string;
	title: string;
	location: string;
	region: string;
	industry: JobIndustry | null;
}): JobDiscoveryCriteria {
	const company = employerDisplayName(input.company);
	const rule = roleRuleFor(input.title);
	const technical = rule?.preferFunction ? undefined : technicalRoleProfile(input.title);
	const functionRoles = technical ? technicalRoleNames(input.title, technical) : rule?.roles || [];
	const roles = unique([...functionRoles, ...SECONDARY_ROLES]).slice(
		0,
		12,
	);
	const locations = unique([input.location, input.region]).slice(0, 4);
	return {
		roles,
		industries:
			input.industry && input.industry !== "Other" ? [input.industry] : [],
		companies: company ? [company] : [],
		locations,
		keywords: unique(technical ? [technical.keyword] : rule?.keywords || []).slice(0, 4),
		seniority: ["Junior", "Entry-level", "Intern", "New graduate"],
		objective: `Learn about the ${input.title} opportunity, the team, and the application process at ${company || input.company}.`,
		count: 5,
		jobContext: { company, title: input.title },
	};
}

const SENIOR_TITLE = /\b(senior|sr|lead|principal|staff|director|head|vp|vice president|chief|president|partner|founder|manager|managing)\b/i;
const JUNIOR_ROLE = /\b(junior|jr|entry.level|intern|trainee|apprentice|new.grad(?:uate)?|graduate (?:analyst|engineer|developer|consultant))\b|\b(?:analyst|engineer|developer|designer|specialist|consultant)\s+(?:i|1)\b/i;
const RECRUITING_ROLE = /\b(recruiter|recruiting|recruitment|talent acquisition)\b/i;
const EARLY_CAREERS = /\b(?:campus|university|student|early.careers?|new.grad(?:uate)?s?|internship|graduate)\s+(?:recruit\w*|talent|hiring)\b|\b(?:recruit\w*|hiring|talent acquisition)\s+(?:(?:for|of)\s+)?(?:campus|university|students|early.careers?|new.grad(?:uate)?s?|interns|internships|graduates)\b/i;

export function rankJobContact(
	person: JobContactEvidence,
	job: JobContactContext,
): JobContactMatch {
	const company = employerDisplayName(job.company);
	const base: JobContactMatch = {
		tier: null,
		label: "Unconfirmed fit",
		reason: `Current employment at ${company} is not confirmed by the saved public evidence.`,
		evidence: "",
		currentCompany: false,
		roleRelevant: false,
		score: 0,
	};
	if (!isJobContactSource(person.sourceUrl, company)) {
		return { ...base, reason: "A supported person-specific public source is required." };
	}
	const evidence = currentEmployerEvidence(person, company);
	if (!evidence) return base;
	const title = containsPhrase(evidence, person.title) ? normalizeEmployer(person.title) : "";
	const rule = roleRuleFor(job.title);
	const technical = rule?.preferFunction ? undefined : technicalRoleProfile(job.title);
	const jobRole = normalizeEmployer(job.title)
		.replace(/\b(internship|intern|co op|summer|winter|fall|spring|student|new grad|graduate|20\d\d)\b/g, " ")
		.replace(/\s+/g, " ").trim();
	const recruiter = RECRUITING_ROLE.test(title);
	const roleRelevant = Boolean(title && !recruiter && (
		technical ? sameTechnicalFunction(title, job.title) :
			rule ? rule.pattern.test(title) && (!rule.preferFunction || roleRuleFor(title) === rule) : jobRole.length > 4 && containsPhrase(title, jobRole)
	));
	const senior = SENIOR_TITLE.test(person.title) ||
		/\b(?:is|works as|serves as)\s+(?:an?\s+)?(?:senior|sr|lead|principal|staff|director|head|vp|vice president|chief|manager)\b/i.test(person.sourceSnippet);
	const junior = !senior && (
		JUNIOR_ROLE.test(title) ||
		/\b(?:is|works as|serves as)\s+(?:an?\s+)?(?:junior|entry.level|intern|trainee|apprentice)\b/i.test(evidence)
	);
	const confirmed = { ...base, evidence, currentCompany: true, roleRelevant };
	if (junior && roleRelevant) {
		return {
			...confirmed, tier: 1, label: "1 - Entry-level in this function",
			reason: `The public profile supports an entry-level role in the function of ${job.title} at ${company}.`,
			score: containsPhrase(title, jobRole) ? 100 : 90,
		};
	}
	if (recruiter && EARLY_CAREERS.test(normalizeEmployer(`${title} ${evidence}`)) &&
		!/\b(not|never|no longer|formerly|previously)\b/i.test(evidence)) {
		return {
			...confirmed, tier: 2, label: "2 - Intern / new-grad recruiter",
			reason: `The public profile supports internship, campus or new-graduate recruiting at ${company}; it does not confirm responsibility for this vacancy.`,
			score: EARLY_CAREERS.test(title) ? 90 : 80,
		};
	}
	if (junior) {
		return {
			...confirmed, tier: 3, label: "3 - Another entry-level employee",
			reason: `Entry-level employment at ${company} is supported, but relevance to ${job.title}'s function is not confirmed.`,
			score: JUNIOR_ROLE.test(title) ? 80 : 70,
		};
	}
	return {
		...confirmed,
		reason: recruiter
			? `Employment at ${company} is supported, but internship/new-graduate recruiting is not confirmed.`
			: senior
				? `Employment at ${company} is supported, but the role has senior or leadership indicators, not entry-level evidence.`
				: `Employment at ${company} is supported, but entry-level seniority is unconfirmed. Analyst or associate alone is not proof.`,
		score: roleRelevant ? 30 : 10,
	};
}

export function compareJobContactMatches(left: JobContactMatch, right: JobContactMatch): number {
	return (left.tier ?? 4) - (right.tier ?? 4) || right.score - left.score;
}

function containsPhrase(value: string, phrase: string): boolean {
	return Boolean(phrase) && ` ${normalizeEmployer(value)} `.includes(` ${normalizeEmployer(phrase)} `);
}

function currentEmployerEvidence(person: JobContactEvidence, company: string): string {
	const aliases = employerSearchAliases([company]);
	const snippets = person.sourceSnippet.slice(0, 2500).split(/\n+|(?<=[.!?;])\s+/);
	const isPastOrAspirational = (value: string) =>
		/\b(former|formerly|previously|past|ex|was|worked|interned|left|until|seeking|aspiring|aspirant|hoping|applying|application|looking for|interested in)\b/i.test(value);
	const endedEmployment = (value: string) => {
		const endYear = value.match(/\b(?:19|20)\d{2}\s*[-–—]\s*(?:[a-z]{3,9}\s+)?((?:19|20)\d{2})\b/i)?.[1];
		return Boolean(endYear && Number(endYear) < new Date().getUTCFullYear());
	};
	if (isPastOrAspirational(person.title) || snippets.some((snippet) =>
		(/\b(now|currently)\b.+\b(at|with|for)\b/i.test(snippet) &&
			!aliases.some((alias) => containsPhrase(snippet, alias))) ||
		(endedEmployment(snippet) && aliases.some((alias) => containsPhrase(snippet, alias))),
	)) return "";
	// A legacy company field can come from a keyword match, not current employment.
	// Require an employment statement or an intact search-result headline instead.
	for (const snippet of snippets) {
		const text = normalizeEmployer(snippet);
		if (isPastOrAspirational(text)) continue;
		const alias = aliases.find((item) => containsPhrase(text, item));
		if (!alias) continue;
		const headline = snippet.replace(/\s*[|–-]\s*LinkedIn\s*$/i, "")
			.split(/\s+(?:-|–|\|)\s+/).filter(Boolean);
		const headlineMatches = headline.length >= 3 &&
			normalizeEmployer(headline[0]!) === normalizeEmployer(person.fullName) &&
			aliases.some((item) => normalizeEmployer(headline[2]!) === normalizeEmployer(item)) &&
			!isPastOrAspirational(person.title);
		const employmentMatches = ["at", "with", "for"].some((word) =>
			containsPhrase(text, `${word} ${alias}`),
		) && (
			containsPhrase(text, person.title) ||
			/\b(works|working|serves|employed|joined)\b/i.test(text)
		);
		if (!headlineMatches && !employmentMatches) continue;
		const conflicting = snippets.some((other) =>
			other !== snippet &&
			aliases.some((item) => containsPhrase(other, item)) &&
			isPastOrAspirational(normalizeEmployer(other)),
		);
		if (!conflicting) {
			return [snippet.trim(), ...snippets.filter((other) =>
				other !== snippet && !isPastOrAspirational(other) &&
				/\b(recruit\w*|hiring)\b/i.test(other),
			)].join(" ").slice(0, 1000);
		}
	}
	return "";
}

function isJobContactSource(value: string, company: string): boolean {
	try {
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
		if (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) {
			return /^\/in\/[^/]+\/?$/i.test(url.pathname);
		}
		if (/\/(jobs?|careers?|search|news|press|articles?|blog|feed|tag|category)(\/|$)/i.test(url.pathname)) return false;
		if (/\/(team|people|staff|leadership|about|professionals|advisors|profiles)\/?$/i.test(url.pathname)) return false;
		return url.pathname !== "/" && (
			url.hostname === "theorg.com" && /^\/org\/[^/]+\/org-chart\/[^/]+\/?$/.test(url.pathname) ||
			employerProfileDomains([company]).some((domain) =>
				url.hostname === domain || url.hostname === `www.${domain}`,
			)
		);
	} catch {
		return false;
	}
}

export function employerProfileDomains(companies: string[]): string[] {
	return Array.from(
		new Set(
			companies.flatMap((company) => {
				const display = employerDisplayName(company);
				return (
					EMPLOYER_DISCOVERY_HINTS.get(normalizeEmployer(display))
						?.domains || []
				);
			}),
		),
	);
}

export function employerSearchAliases(companies: string[]): string[] {
	return Array.from(
		new Set(
			companies.flatMap((company) => {
				const display = employerDisplayName(company);
				return (
					EMPLOYER_DISCOVERY_HINTS.get(normalizeEmployer(display))
						?.aliases || [display]
				);
			}),
		),
	);
}

export function employerProfessionalTopics(companies: string[]): string[] {
	return Array.from(
		new Set(
			companies.flatMap((company) => {
				const display = employerDisplayName(company);
				return (
					EMPLOYER_DISCOVERY_HINTS.get(normalizeEmployer(display))
						?.topics || []
				);
			}),
		),
	);
}

function normalizeEmployer(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
