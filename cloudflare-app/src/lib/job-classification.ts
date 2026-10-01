export const JOB_INDUSTRIES = [
	"Banking & Financial Services",
	"Insurance",
	"Technology",
	"Consulting & Professional Services",
	"Consumer & Retail",
	"Industrial & Manufacturing",
	"Healthcare & Life Sciences",
	"Government & Nonprofit",
	"Other",
] as const;

export type JobIndustry = (typeof JOB_INDUSTRIES)[number];

export const JOB_TERM_SEASONS = [
	"WINTER",
	"SPRING",
	"SUMMER",
	"FALL",
] as const;

export type JobTermSeason = (typeof JOB_TERM_SEASONS)[number];

export interface DerivedJobClassification {
	industry: JobIndustry;
	durationMonths: number[];
	durationMinMonths: number | null;
	durationMaxMonths: number | null;
	termSeason: JobTermSeason | null;
	termYear: number | null;
}

export interface JobTerm {
	season: JobTermSeason;
	year: number;
}

const COMPANY_INDUSTRIES = new Map<string, JobIndustry>([
	...aliases("Banking & Financial Services", [
		"scotiabank",
		"bank of nova scotia",
		"td",
		"td bank",
		"toronto dominion bank",
		"toronto-dominion bank",
		"bmo",
		"bank of montreal",
		"cibc",
		"canadian imperial bank of commerce",
		"rbc",
		"royal bank of canada",
		"national bank",
		"national bank of canada",
		"desjardins",
		"robinhood",
		"stripe",
		"wealthsimple",
		"koho",
		"interac",
		"visa",
		"mastercard",
	]),
	...aliases("Insurance", [
		"manulife",
		"sun life",
		"intact",
		"intact financial",
		"canada life",
		"definity",
		"aviva",
		"co-operators",
	]),
	...aliases("Technology", [
		"d2l",
		"desire2learn",
		"lyft",
		"shopify",
		"microsoft",
		"google",
		"amazon web services",
		"ibm",
		"oracle",
		"salesforce",
		"sap",
		"amd",
		"nvidia",
		"uber",
	]),
	...aliases("Consulting & Professional Services", [
		"deloitte",
		"pwc",
		"pricewaterhousecoopers",
		"ey",
		"ernst young",
		"kpmg",
		"accenture",
		"mckinsey",
		"mckinsey company",
		"bcg",
		"boston consulting group",
		"bain",
		"bain company",
		"slalom",
	]),
	...aliases("Consumer & Retail", [
		"amazon",
		"walmart",
		"loblaw",
		"loblaws",
		"shoppers drug mart",
		"canadian tire",
		"lululemon",
		"restaurant brands international",
		"tim hortons",
		"nike",
		"pepsico",
		"unilever",
		"procter gamble",
	]),
	...aliases("Industrial & Manufacturing", [
		"magna",
		"magna international",
		"bombardier",
		"general motors",
		"ford",
		"ford motor company",
		"toyota",
		"honda",
		"siemens",
		"honeywell",
		"aecon",
	]),
	...aliases("Healthcare & Life Sciences", [
		"uhn",
		"university health network",
		"sickkids",
		"hospital for sick children",
		"roche",
		"pfizer",
		"sanofi",
		"astrazeneca",
		"johnson johnson",
	]),
	...aliases("Government & Nonprofit", [
		"city of toronto",
		"ontario public service",
		"government of ontario",
		"government of canada",
		"united way",
		"ymca",
	]),
]);

const INDUSTRY_PATTERNS: Array<{
	industry: JobIndustry;
	company: RegExp;
	context: RegExp;
}> = [
	{
		industry: "Insurance",
		company: /\b(insurance|assurance|reinsurance|underwriters?)\b/i,
		context: /\b(insurance|actuar(?:y|ial)|underwrit(?:er|ing)|claims?)\b/i,
	},
	{
		industry: "Government & Nonprofit",
		company:
			/\b(government|ministry|municipality|city of|public service|non-?profit|charity|foundation)\b/i,
		context:
			/\b(government agency|public sector|non-?profit organization|charitable organization)\b/i,
	},
	{
		industry: "Healthcare & Life Sciences",
		company:
			/\b(health|hospital|pharma|pharmaceutical|biotech|life sciences|medical|therapeutics)\b/i,
		context:
			/\b(clinical research|pharmaceutical|biotech|life sciences|patient care|medical devices?)\b/i,
	},
	{
		industry: "Banking & Financial Services",
		company:
			/\b(bank|banking|credit union|financial|capital|wealth|payments?|fintech|investment|asset management)\b/i,
		context:
			/\b(investment banking|commercial banking|capital markets|wealth management|asset management|payments platform|fintech)\b/i,
	},
	{
		industry: "Consulting & Professional Services",
		company:
			/\b(consulting|consultants?|professional services|advisory|accounting|audit)\b/i,
		context:
			/\b(management consulting|professional services firm|advisory practice|public accounting)\b/i,
	},
	{
		industry: "Consumer & Retail",
		company:
			/\b(retail|consumer|grocery|apparel|restaurant|beverage|food|e-?commerce)\b/i,
		context:
			/\b(retail operations|consumer products|grocery|merchandising|restaurant operations)\b/i,
	},
	{
		industry: "Industrial & Manufacturing",
		company:
			/\b(manufacturing|industrial|automotive|aerospace|construction|engineering|machinery)\b/i,
		context:
			/\b(manufacturing operations|industrial automation|automotive|aerospace|plant operations)\b/i,
	},
	{
		industry: "Technology",
		company:
			/\b(software|technology|technologies|cloud|cybersecurity|semiconductor|digital platform)\b/i,
		context:
			/\b(software company|technology company|cloud platform|cybersecurity company|semiconductor)\b/i,
	},
];

const TITLE_INSURANCE_OVERRIDE =
	/\b(insurance|actuar(?:y|ial)|underwrit(?:er|ing)|claims?)\b/i;

export function deriveJobClassification(input: {
	company: string;
	title: string;
	description: string | null;
}): DerivedJobClassification {
	const durationMonths = parseInternshipDurationMonths(
		input.title,
		input.description,
	);
	const term = parseInternshipTerm(input.title, input.description);
	return {
		industry: classifyJobIndustry(input),
		durationMonths,
		durationMinMonths: durationMonths.length
			? Math.min(...durationMonths)
			: null,
		durationMaxMonths: durationMonths.length
			? Math.max(...durationMonths)
			: null,
		termSeason: term?.season ?? null,
		termYear: term?.year ?? null,
	};
}

export function classifyJobIndustry(input: {
	company: string;
	title: string;
	description: string | null;
}): JobIndustry {
	if (TITLE_INSURANCE_OVERRIDE.test(input.title)) return "Insurance";
	const company = normalizeClassifierText(input.company);
	const mapped = COMPANY_INDUSTRIES.get(company);
	if (mapped) return mapped;

	for (const pattern of INDUSTRY_PATTERNS) {
		if (pattern.company.test(company)) return pattern.industry;
	}
	const context = `${input.title}\n${input.description || ""}`;
	for (const pattern of INDUSTRY_PATTERNS) {
		if (pattern.context.test(context)) return pattern.industry;
	}
	return "Other";
}

export function parseInternshipDurationMonths(
	title: string,
	description: string | null,
): number[] {
	const titleValues = durationValues(title);
	if (titleValues.length) return titleValues;
	return durationValues(description || "");
}

export function parseInternshipTerm(
	title: string,
	description: string | null,
): JobTerm | null {
	const titleTerms = termValues(title);
	if (titleTerms.matched) return titleTerms.term;
	return termValues(description || "").term;
}

export function formatDurationMonths(values: number[]): string | null {
	const normalized = normalizeDurations(values);
	if (!normalized.length) return null;
	if (normalized.length === 1) return `${normalized[0]} months`;
	return `${normalized.slice(0, -1).join(", ")}${
		normalized.length > 2 ? "," : ""
	} or ${normalized.at(-1)} months`;
}

export function formatJobTerm(
	season: JobTermSeason,
	year: number,
): string {
	const labels: Record<JobTermSeason, string> = {
		WINTER: "Winter",
		SPRING: "Spring",
		SUMMER: "Summer",
		FALL: "Fall",
	};
	return `${labels[season]} '${String(year).slice(-2)}`;
}

function aliases(
	industry: JobIndustry,
	values: string[],
): Array<[string, JobIndustry]> {
	return values.map((value) => [normalizeClassifierText(value), industry]);
}

function normalizeClassifierText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function durationValues(text: string): number[] {
	const values: number[] = [];
	const patterns = [
		/\b(\d{1,2})\s*[- ]?months?\s*(?:or|\/|&)\s*(\d{1,2})\s*[- ]?months?\b/gi,
		/\b(\d{1,2})\s*(?:or|\/|&)\s*(\d{1,2})\s*[- ]?months?\b/gi,
		/\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*[- ]?months?\b/gi,
		/\b(\d{1,2})\s*[- ]?months?\b/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			for (const raw of match.slice(1)) {
				if (!raw) continue;
				const months = Number(raw);
				if (Number.isInteger(months) && months >= 1 && months <= 24) {
					values.push(months);
				}
			}
		}
	}
	const normalized = normalizeDurations(values);
	return normalized.length <= 4 ? normalized : [];
}

function normalizeDurations(values: number[]): number[] {
	return Array.from(
		new Set(
			values.filter(
				(value) => Number.isInteger(value) && value >= 1 && value <= 24,
			),
		),
	).sort((left, right) => left - right);
}

function termValues(text: string): {
	matched: boolean;
	term: JobTerm | null;
} {
	const terms = new Map<string, JobTerm>();
	const forward =
		/\b(winter|spring|summer|fall|autumn)\s*(?:term\s*)?(?:of\s*)?['’]?(20\d{2}|\d{2})\b/gi;
	const reverse =
		/\b['’]?(20\d{2}|\d{2})\s*(winter|spring|summer|fall|autumn)\b/gi;
	for (const match of text.matchAll(forward)) {
		addTerm(terms, match[1], match[2]);
	}
	for (const match of text.matchAll(reverse)) {
		addTerm(terms, match[2], match[1]);
	}
	const values = [...terms.values()];
	return {
		matched: values.length > 0,
		term: values.length === 1 ? values[0]! : null,
	};
}

function addTerm(
	terms: Map<string, JobTerm>,
	seasonValue: string | undefined,
	yearValue: string | undefined,
): void {
	if (!seasonValue || !yearValue) return;
	const season = normalizeSeason(seasonValue);
	const year = normalizeYear(yearValue);
	if (!season || year === null) return;
	terms.set(`${season}-${year}`, { season, year });
}

function normalizeSeason(value: string): JobTermSeason | null {
	const season = value.toUpperCase();
	if (season === "AUTUMN") return "FALL";
	return JOB_TERM_SEASONS.includes(season as JobTermSeason)
		? (season as JobTermSeason)
		: null;
}

function normalizeYear(value: string): number | null {
	const year = Number(value);
	if (!Number.isInteger(year)) return null;
	const normalized = value.length === 2 ? 2000 + year : year;
	return normalized >= 2000 && normalized <= 2099 ? normalized : null;
}
