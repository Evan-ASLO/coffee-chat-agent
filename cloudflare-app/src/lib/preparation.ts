import { z } from "zod";
import type { AppBindings } from "../types";
import type { Prospect } from "./store";
import { sha256 } from "./encoding";
import { PublicHttpError } from "./errors";
import { fetchJson, ProviderHttpError } from "./fetch";
import { employerSearchAliases, sameEmployer } from "./job-discovery";

const failureStatus = z.enum(["MISSING_KEY", "FORBIDDEN", "QUOTA", "FAILED", "INVALID_RESPONSE", "CANCELLED"]);
const sourceSchema = z.object({
	url: z.string().max(2000),
	title: z.string().max(180),
	snippet: z.string().max(1200),
	origin: z.enum(["TAVILY", "DISCOVERY"]),
}).strict();
const emailSchema = z.object({
	provider: z.enum(["APOLLO", "HUNTER", "MANUAL"]),
	status: z.enum([
		"RUNNING", "MATCHED", "MANUAL", "NO_MATCH", "NO_EMAIL", "LOW_CONFIDENCE",
		"IDENTITY_MISMATCH", "EMPLOYER_MISMATCH", "UNVERIFIED_EMAIL", "INTEGRATION_DISABLED",
		...failureStatus.options,
	]),
	identityKey: z.string(),
	checkedAt: z.string(),
	emailHash: z.string(),
	matchConfidence: z.enum(["high", "medium", "low", "none"]).nullable(),
	emailStatus: z.enum(["verified", "unverified"]).nullable(),
	sourceUrl: z.string().max(2000),
}).strict();
const researchSchema = z.object({
	status: z.enum(["RUNNING", "SOURCED", "EMPTY", "IRRELEVANT", ...failureStatus.options]),
	identityKey: z.string(),
	checkedAt: z.string(),
	sources: z.array(sourceSchema).max(5),
}).strict();
const preparationSchema = z.object({
	version: z.literal(1),
	email: emailSchema.nullable(),
	research: researchSchema.nullable(),
}).strict();

export type PreparationState = z.infer<typeof preparationSchema>;
export type EmailLookup = z.infer<typeof emailSchema>;
export type PersonResearch = z.infer<typeof researchSchema>;
export type ResearchSource = z.infer<typeof sourceSchema>;
export type PreparationStage = "EMAIL" | "RESEARCH";
export type PersonIdentity = Pick<Prospect, "fullName" | "firstName" | "lastName" | "company" | "companyDomain" | "linkedinUrl" | "sourceUrl" | "title">;

export function emptyPreparation(): PreparationState {
	return { version: 1, email: null, research: null };
}

export function parsePreparation(value: string | undefined): PreparationState {
	if (value === undefined) return emptyPreparation();
	try {
		return preparationSchema.parse(JSON.parse(value));
	} catch {
		throw new Error("Stored preparation context is invalid. Contact support before retrying.");
	}
}

export function apolloEnrichmentEnabled(env: AppBindings): boolean {
	return env.ENABLE_APOLLO_ENRICHMENT === "true";
}

export function requireApolloIntegration(env: AppBindings): void {
	if (!apolloEnrichmentEnabled(env)) {
		throw new PublicHttpError(
			"Apollo integration is disabled pending Apollo authorization of this product and its authentication model. Saving a key cannot enable it.",
			403, "APOLLO_INTEGRATION_DISABLED",
		);
	}
}

export async function personIdentityKey(person: PersonIdentity): Promise<string> {
	return sha256(JSON.stringify([
		person.fullName, person.company, person.companyDomain, person.linkedinUrl, person.sourceUrl, person.title,
	].map((value) => value.trim().toLowerCase())));
}

export function preparationFailure(error: unknown, signal?: AbortSignal): z.infer<typeof failureStatus> {
	if (signal?.aborted) return "CANCELLED";
	if (error instanceof ProviderHttpError) {
		if ([401, 403].includes(error.status)) return "FORBIDDEN";
		if ([402, 429].includes(error.status)) return "QUOTA";
	}
	return "FAILED";
}

export function publicSourceUrl(value: string): string {
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
			!host.includes(".") || host === "localhost" || /\.(local|internal|localhost|invalid)$/.test(host) ||
			/^[\d.]+$/.test(host) || host.includes(":")) return "";
		url.hash = "";
		url.search = "";
		return url.href.slice(0, 2000);
	} catch {
		return "";
	}
}

function linkedInIdentity(value: string): string {
	const source = publicSourceUrl(value);
	if (!source) return "";
	const url = new URL(source);
	return /(^|\.)linkedin\.com$/.test(url.hostname) && /^\/in\/[^/]+\/?$/.test(url.pathname)
		? url.pathname.toLowerCase().replace(/\/$/, "") : "";
}

function normalized(value: string): string {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function domain(value: string): string {
	const clean = value.trim().toLowerCase().replace(/^www\./, "");
	return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(clean) ? clean : "";
}

export function validRecipientEmail(value: string): string {
	const email = value.trim().toLowerCase();
	const parts = email.split("@");
	if (email.length > 254 || parts.length !== 2 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]!) ||
		!parts[0] || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") || !domain(parts[1]!)) return "";
	if (/^(?:email_not_unlocked|not_unlocked|no[_-]?email|unknown|redacted|placeholder|noreply|no-reply)$/i.test(parts[0]!) ||
		/(^|\.)(example\.(com|net|org)|test|invalid|example|local|internal|localhost)$/.test(parts[1]!)) return "";
	return email;
}

const apolloPersonSchema = z.object({
	name: z.string().nullable().optional(),
	first_name: z.string().nullable().optional(),
	last_name: z.string().nullable().optional(),
	linkedin_url: z.string().nullable().optional(),
	email: z.string().nullable().optional(),
	email_status: z.string().nullable().optional(),
	match_confidence: z.enum(["high", "medium", "low", "none"]).nullable().optional(),
	organization: z.object({
		name: z.string().nullable().optional(),
		primary_domain: z.string().nullable().optional(),
	}).nullable().optional(),
	employment_history: z.array(z.object({
		current: z.boolean().nullable().optional(),
		organization_name: z.string().nullable().optional(),
		end_date: z.string().nullable().optional(),
	})).optional(),
});

export async function enrichWithApollo(
	env: AppBindings, apiKey: string, prospect: Prospect, signal?: AbortSignal,
): Promise<{ email: string; lookup: EmailLookup }> {
	requireApolloIntegration(env);
	const lookup: EmailLookup = {
		provider: "APOLLO", status: "NO_MATCH", identityKey: await personIdentityKey(prospect),
		checkedAt: new Date().toISOString(), emailHash: "", matchConfidence: null,
		emailStatus: null, sourceUrl: publicSourceUrl(prospect.linkedinUrl || prospect.sourceUrl),
	};
	const result = (status: EmailLookup["status"]) => ({ email: "", lookup: { ...lookup, status } });
	const identity = linkedInIdentity(prospect.linkedinUrl);
	if (!prospect.fullName.trim() || !prospect.company.trim() ||
		(prospect.linkedinUrl && !identity)) return result("IDENTITY_MISMATCH");
	const params = new URLSearchParams({
		name: prospect.fullName, organization_name: prospect.company,
		reveal_personal_emails: "false", reveal_phone_number: "false",
		run_waterfall_email: "false", run_waterfall_phone: "false",
	});
	if (identity) params.set("linkedin_url", `https://www.linkedin.com${identity}`);
	const expectedDomain = domain(prospect.companyDomain);
	if (expectedDomain) params.set("domain", expectedDomain);
	let response: unknown;
	try {
		response = await fetchJson<unknown>(`https://api.apollo.io/api/v1/people/match?${params}`, {
			method: "POST", headers: { "x-api-key": apiKey }, attempts: 1, timeoutMs: 15000, signal,
		});
	} catch (error) {
		return result(preparationFailure(error, signal));
	}
	const parsed = z.object({ person: apolloPersonSchema.nullable() }).safeParse(response);
	if (!parsed.success) return result("INVALID_RESPONSE");
	const person = parsed.data.person;
	if (!person || person.match_confidence === "none") return result("NO_MATCH");
	lookup.matchConfidence = person.match_confidence || null;
	if (person.match_confidence !== "high") return result("LOW_CONFIDENCE");
	const name = person.name || [person.first_name, person.last_name].filter(Boolean).join(" ");
	if (normalized(name) !== normalized(prospect.fullName) ||
		(identity && linkedInIdentity(person.linkedin_url || "") !== identity)) return result("IDENTITY_MISMATCH");
	const employer = person.organization?.name || "";
	const currentEmployment = person.employment_history?.some((item) =>
		item.current === true && !item.end_date && sameEmployer(item.organization_name || "", prospect.company));
	const returnedDomain = domain(person.organization?.primary_domain || "");
	if (!sameEmployer(employer, prospect.company) || !currentEmployment ||
		(expectedDomain && expectedDomain !== returnedDomain)) return result("EMPLOYER_MISMATCH");
	if (!person.email) return result("NO_EMAIL");
	lookup.emailStatus = person.email_status === "verified" ? "verified" : "unverified";
	const email = validRecipientEmail(person.email);
	const emailDomain = email.split("@")[1] || "";
	if (person.email_status !== "verified" || !email || !returnedDomain ||
		!(emailDomain === returnedDomain || emailDomain.endsWith(`.${returnedDomain}`)) ||
		/^(gmail|yahoo|hotmail|outlook|icloud|aol|protonmail|proton|live)\./.test(emailDomain)) return result("UNVERIFIED_EMAIL");
	return { email, lookup: { ...lookup, status: "MATCHED", emailHash: await sha256(email) } };
}

function professionalText(value: string, limit: number): string {
	return value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f]/g, " ")
		.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email omitted]")
		.replace(/(?:\+?\d[\s().-]*){9,}/g, "[phone omitted]")
		.replace(/\b(?:sk-|tvly-|AIza)[\w-]+/g, "[credential omitted]")
		.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function researchSource(
	prospect: Prospect,
	result: { title?: string; url?: string; content?: string },
	origin: ResearchSource["origin"],
): ResearchSource | null {
	const url = publicSourceUrl(result.url || "");
	const title = professionalText(result.title || "", 180);
	const snippet = professionalText(result.content || "", 1200);
	if (!url || !snippet) return null;
	const name = normalized(prospect.fullName);
	const text = ` ${normalized(`${title} ${snippet}`)} `;
	const start = text.indexOf(` ${name} `);
	if (name.split(" ").length < 2 || start < 0) return null;
	const associated = text.slice(Math.max(0, start - 100), start + name.length + 250);
	if (!employerSearchAliases([prospect.company]).some((alias) =>
		` ${associated} `.includes(` ${normalized(alias)} `))) return null;
	const linkedIn = /(^|\.)linkedin\.com$/.test(new URL(url).hostname);
	if (linkedIn && (!linkedInIdentity(prospect.linkedinUrl) ||
		linkedInIdentity(url) !== linkedInIdentity(prospect.linkedinUrl))) return null;
	if (!linkedIn && !` ${normalized(snippet)} `.includes(` ${name} `)) return null;
	if (!/\b(engineer|developer|analyst|recruiter|intern|graduate|career|professional|team|company|research|speaker|conference|project|product|design|marketing|finance|portfolio|consultant|manager|director|investment|operations|strategy)\b/i.test(snippet)) return null;
	if (/\b(ignore (?:all |previous )?instructions|system prompt|api[_ -]?key|political party|religion|sexual orientation|medical condition|diagnosed|birthday|married|husband|wife)\b/i.test(`${title} ${snippet}`)) return null;
	return { url, title: title || prospect.fullName, snippet, origin };
}

export function discoveryResearchSources(prospect: Prospect): ResearchSource[] {
	const source = researchSource(prospect, {
		title: prospect.fullName, url: prospect.sourceUrl || prospect.linkedinUrl, content: prospect.sourceSnippet,
	}, "DISCOVERY");
	return source ? [source] : [];
}

export async function researchApprovedPerson(
	apiKey: string, prospect: Prospect, signal?: AbortSignal,
): Promise<PersonResearch> {
	const research: PersonResearch = {
		status: "EMPTY", identityKey: await personIdentityKey(prospect),
		checkedAt: new Date().toISOString(), sources: discoveryResearchSources(prospect),
	};
	const name = prospect.fullName.replace(/["\r\n]/g, " ").trim().slice(0, 150);
	const company = prospect.company.replace(/["\r\n]/g, " ").trim().slice(0, 150);
	if (!name || !company) return { ...research, status: "IRRELEVANT" };
	let response: unknown;
	try {
		response = await fetchJson<unknown>("https://api.tavily.com/search", {
			headers: { Authorization: `Bearer ${apiKey}` },
			body: {
				query: `"${name}" "${company}" professional profile projects experience`,
				search_depth: "basic", max_results: 5, topic: "general",
				include_answer: false, include_raw_content: false, safe_search: true,
			},
			attempts: 1, timeoutMs: 15000, signal,
		});
	} catch (error) {
		return { ...research, status: preparationFailure(error, signal) };
	}
	const parsed = z.object({ results: z.array(z.object({
		title: z.string().optional(), url: z.string(), content: z.string().optional(),
	})) }).safeParse(response);
	if (!parsed.success) return { ...research, status: "INVALID_RESPONSE" };
	const sources = new Map<string, ResearchSource>();
	for (const item of parsed.data.results.slice(0, 5)) {
		const source = researchSource(prospect, item, "TAVILY");
		if (source) sources.set(source.url, source);
	}
	if (!sources.size) return { ...research, status: parsed.data.results.length ? "IRRELEVANT" : "EMPTY" };
	for (const source of research.sources) {
		if (sources.size < 5 && !sources.has(source.url)) sources.set(source.url, source);
	}
	return { ...research, status: "SOURCED", sources: [...sources.values()] };
}
