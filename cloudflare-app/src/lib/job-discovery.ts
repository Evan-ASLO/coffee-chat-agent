import type { JobIndustry } from "./job-classification";

export interface JobDiscoveryCriteria {
	roles: string[];
	industries: string[];
	companies: string[];
	locations: string[];
	keywords: string[];
	seniority: string[];
	objective: string;
	count: number;
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

const EMPLOYER_PROFILE_DOMAINS = new Map<string, string[]>([
	["bmo financial group", ["bmo.com"]],
	["td bank group", ["td.com"]],
	["scotiabank", ["scotiabank.com"]],
	["cibc", ["cibc.com"]],
	["rbc", ["rbc.com"]],
	["d2l", ["d2l.com"]],
]);

const ROLE_RULES: Array<{
	pattern: RegExp;
	roles: string[];
	keywords: string[];
}> = [
	{
		pattern: /\b(investment|portfolio|asset management)\b/i,
		roles: [
			"Investment Team",
			"Investment Analyst",
			"Portfolio Manager",
			"Investment Professional",
		],
		keywords: ["investment", "portfolio"],
	},
	{
		pattern: /\b(capital markets?|equity research|fixed income)\b/i,
		roles: [
			"Capital Markets Team",
			"Capital Markets Analyst",
			"Investment Banking Analyst",
		],
		keywords: ["capital markets"],
	},
	{
		pattern: /\b(wealth|private banking)\b/i,
		roles: ["Wealth Management Team", "Wealth Advisor", "Portfolio Manager"],
		keywords: ["wealth management"],
	},
	{
		pattern: /\b(finance|accounting|treasury)\b/i,
		roles: ["Finance Team", "Financial Analyst", "Finance Manager"],
		keywords: ["finance"],
	},
	{
		pattern: /\b(software|developer|engineering|cybersecurity)\b/i,
		roles: [
			"Engineering Team",
			"Software Engineer",
			"Engineering Manager",
		],
		keywords: ["software engineering"],
	},
	{
		pattern: /\b(data|analytics|machine learning|artificial intelligence)\b/i,
		roles: ["Data Team", "Data Analyst", "Data Scientist", "Analytics Manager"],
		keywords: ["data analytics"],
	},
	{
		pattern: /\b(product)\b/i,
		roles: ["Product Team", "Product Manager", "Product Lead"],
		keywords: ["product"],
	},
	{
		pattern: /\b(marketing|brand|communications)\b/i,
		roles: ["Marketing Team", "Marketing Manager", "Brand Manager"],
		keywords: ["marketing"],
	},
	{
		pattern: /\b(operations|supply chain|logistics)\b/i,
		roles: ["Operations Team", "Operations Manager", "Operations Analyst"],
		keywords: ["operations"],
	},
	{
		pattern: /\b(risk|compliance|audit)\b/i,
		roles: ["Risk Team", "Risk Analyst", "Compliance Manager"],
		keywords: ["risk"],
	},
	{
		pattern: /\b(consulting|advisory|strategy)\b/i,
		roles: ["Consulting Team", "Consultant", "Engagement Manager"],
		keywords: ["consulting"],
	},
];

const SECONDARY_ROLES = [
	"Hiring Manager",
	"Talent Acquisition",
	"Recruiter",
];

export function employerDisplayName(company: string): string {
	const clean = company.trim().replace(/\s+/g, " ");
	const normalized = normalizeEmployer(clean);
	return EMPLOYER_DISPLAY_ALIASES.get(normalized) || clean;
}

export function deriveJobDiscoveryCriteria(input: {
	company: string;
	title: string;
	location: string;
	region: string;
	industry: JobIndustry | null;
}): JobDiscoveryCriteria {
	const company = employerDisplayName(input.company);
	const rule = ROLE_RULES.find((candidate) =>
		candidate.pattern.test(input.title),
	);
	const roles = unique([...(rule?.roles || []), ...SECONDARY_ROLES]).slice(
		0,
		8,
	);
	const locations = unique([input.location, input.region]).slice(0, 4);
	return {
		roles,
		industries:
			input.industry && input.industry !== "Other" ? [input.industry] : [],
		companies: company ? [company] : [],
		locations,
		keywords: unique(rule?.keywords || []).slice(0, 4),
		seniority: [],
		objective: `Learn about the ${input.title} opportunity, the team, and the application process at ${company || input.company}.`,
		count: 5,
	};
}

export function employerProfileDomains(companies: string[]): string[] {
	return Array.from(
		new Set(
			companies.flatMap((company) => {
				const display = employerDisplayName(company);
				return EMPLOYER_PROFILE_DOMAINS.get(normalizeEmployer(display)) || [];
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
