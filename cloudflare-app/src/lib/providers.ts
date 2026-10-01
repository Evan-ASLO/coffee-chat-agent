import type { Prospect } from "./store";
import type { UserSettings } from "./store";
import { fetchJson } from "./fetch";
import {
	employerDisplayName,
	employerProfileDomains,
	employerProfessionalTopics,
	employerSearchAliases,
} from "./job-discovery";

export interface DiscoveryCriteria {
	roles: string[];
	industries: string[];
	companies: string[];
	locations: string[];
	keywords: string[];
	seniority: string[];
	objective: string;
	count: number;
}

export interface DiscoveredPerson {
	firstName: string;
	lastName: string;
	fullName: string;
	title: string;
	company: string;
	companyDomain: string;
	location: string;
	linkedinUrl: string;
	discoveryProvider: "TAVILY";
	sourceUrl: string;
	sourceSnippet: string;
	whyRelevant: string;
	outreachObjective: string;
	relevanceScore: number;
}

export interface DiscoveryProviderResult {
	providerReturned: number;
	primaryProviderReturned: number;
	primaryAccepted: number;
	fallbackProviderReturned: number;
	fallbackAccepted: number;
	people: DiscoveredPerson[];
}

export interface DraftResult {
	subject: string;
	body: string;
	personalizationNotes: string;
	provider: string;
	model: string;
}

export type AiProvider = "GEMINI" | "OPENAI" | "ANTHROPIC";

export interface ResumeProfileSuggestions {
	senderName: string;
	backgroundSummary: string;
	currentGoal: string;
	experienceToReference: string;
	provider: AiProvider;
	model: string;
}

export async function discoverWithTavily(
	apiKey: string,
	criteria: DiscoveryCriteria,
): Promise<DiscoveryProviderResult> {
	const primary = await fetchJson<{
		results?: Array<{ title?: string; url?: string; content?: string }>;
	}>("https://api.tavily.com/search", {
		headers: { Authorization: `Bearer ${apiKey}` },
		body: {
			query: buildDiscoveryQuery(criteria),
			search_depth: "basic",
			max_results: Math.min(criteria.count * 3, 20),
			topic: "general",
			include_answer: false,
			include_raw_content: false,
			safe_search: true,
		},
		attempts: 3,
	});
	const seen = new Set<string>();
	const people: DiscoveredPerson[] = [];
	const primaryResults = primary.results ?? [];
	for (const result of primaryResults) {
		const person = linkedInPerson(result, criteria);
		if (!person) continue;
		const key = person.linkedinUrl || person.sourceUrl;
		if (seen.has(key)) continue;
		seen.add(key);
		people.push(person);
		if (people.length >= criteria.count) {
			return {
				providerReturned: primaryResults.length,
				primaryProviderReturned: primaryResults.length,
				primaryAccepted: people.length,
				fallbackProviderReturned: 0,
				fallbackAccepted: 0,
				people,
			};
		}
	}

	const primaryAccepted = people.length;
	let fallbackResults: Array<{
		title?: string;
		url?: string;
		content?: string;
	}> = [];
	if (people.length < criteria.count) {
		const fallback = await fetchJson<{
			results?: Array<{ title?: string; url?: string; content?: string }>;
		}>("https://api.tavily.com/search", {
			headers: { Authorization: `Bearer ${apiKey}` },
			body: {
				query: buildProfessionalBioQuery(criteria),
				include_domains: professionalBioDomains(criteria),
				include_domains_mode: "restrict",
				search_depth: "basic",
				max_results: Math.min((criteria.count - people.length) * 4, 20),
				topic: "general",
				include_answer: false,
				include_raw_content: false,
				safe_search: true,
			},
			attempts: 3,
		});
		fallbackResults = fallback.results ?? [];
		for (const result of fallbackResults) {
			const person =
				linkedInPerson(result, criteria) ||
				professionalBioPerson(result, criteria);
			if (!person) continue;
			const key = person.linkedinUrl || person.sourceUrl;
			if (seen.has(key)) continue;
			seen.add(key);
			people.push(person);
			if (people.length >= criteria.count) break;
		}
	}
	return {
		providerReturned: primaryResults.length + fallbackResults.length,
		primaryProviderReturned: primaryResults.length,
		primaryAccepted,
		fallbackProviderReturned: fallbackResults.length,
		fallbackAccepted: people.length - primaryAccepted,
		people,
	};
}

export async function enrichWithHunter(
	apiKey: string,
	prospect: Prospect,
): Promise<{ email: string; confidence: number }> {
	const params = new URLSearchParams({ api_key: apiKey });
	if (
		prospect.firstName &&
		prospect.lastName &&
		(prospect.companyDomain || prospect.company)
	) {
		params.set("first_name", prospect.firstName);
		params.set("last_name", prospect.lastName);
		if (prospect.companyDomain) params.set("domain", prospect.companyDomain);
		else params.set("company", prospect.company);
	} else {
		const handle = linkedinHandle(prospect.linkedinUrl);
		if (!prospect.firstName || !prospect.lastName || !handle) return { email: "", confidence: 0 };
		params.set("first_name", prospect.firstName);
		params.set("last_name", prospect.lastName);
		params.set("linkedin_handle", handle);
	}
	try {
		const response = await fetchJson<{
			data?: { email?: string; score?: number };
		}>(`https://api.hunter.io/v2/email-finder?${params}`, {
			attempts: 2,
		});
		return {
			email: normalizeEmail(response.data?.email || ""),
			confidence: clamp(Number(response.data?.score || 0), 0, 100),
		};
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("HTTP 404") &&
			error.message.includes("not_found")
		) {
			return { email: "", confidence: 0 };
		}
		throw error;
	}
}

export async function createDraft(
	input: {
		prospect: Prospect;
		settings: UserSettings;
		apiKey?: string;
	},
): Promise<DraftResult> {
	const provider = input.settings.draftProvider.toUpperCase();
	if (provider === "TEMPLATE") {
		return templateDraft(input.prospect, input.settings);
	}
	if (!input.apiKey) throw new Error(`${provider} is not configured.`);
	const prompt = draftPrompt(input.prospect, input.settings);
	if (provider === "GEMINI") {
		const models = [input.settings.geminiModel || "gemini-3.8-flash"];
		if (models[0] === "gemini-3.8-flash") models.push("gemini-3.7-flash");
		let lastError: Error | undefined;
		for (const model of models) {
			try {
				const response = await fetchJson<{
					output_text?: string;
					steps?: Array<{
						type: string;
						content?: Array<{ type: string; text?: string }>;
					}>;
				}>("https://generativelanguage.googleapis.com/v1beta/interactions", {
					headers: { "x-goog-api-key": input.apiKey },
					body: {
						model,
						input: prompt,
						system_instruction:
							"Return only the requested valid JSON object with no Markdown.",
						store: false,
						generation_config: {
							temperature: 0.4,
							max_output_tokens: 700,
							thinking_level: "low",
						},
					},
					attempts: 3,
				});
				const text =
					response.output_text ||
					(response.steps ?? [])
						.filter((step) => step.type === "model_output")
						.flatMap((step) => step.content ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text || "")
						.join("");
				const draft = parseDraft(text);
				return {
					...draft,
					provider,
					model,
					personalizationNotes:
						model === models[0]
							? draft.personalizationNotes
							: `Fallback model used: ${model}. ${draft.personalizationNotes}`,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error("Gemini failed.");
			}
		}
		throw lastError ?? new Error("Gemini failed.");
	}
	if (provider === "OPENAI") {
		const model = input.settings.openAiModel || "gpt-5-mini";
		const response = await fetchJson<{
			output_text?: string;
			output?: Array<{
				content?: Array<{ type: string; text?: string }>;
			}>;
		}>("https://api.openai.com/v1/responses", {
			headers: { Authorization: `Bearer ${input.apiKey}` },
			body: { model, input: prompt, max_output_tokens: 700 },
			attempts: 3,
		});
		const text =
			response.output_text ||
			(response.output ?? [])
				.flatMap((item) => item.content ?? [])
				.map((part) => part.text || "")
				.join("");
		return { ...parseDraft(text), provider, model };
	}
	if (provider === "ANTHROPIC") {
		const model = input.settings.anthropicModel || "claude-haiku-4-5";
		const response = await fetchJson<{
			content?: Array<{ type: string; text?: string }>;
		}>("https://api.anthropic.com/v1/messages", {
			headers: {
				"x-api-key": input.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: {
				model,
				max_tokens: 700,
				system: "Return only the requested valid JSON object with no Markdown.",
				messages: [{ role: "user", content: prompt }],
			},
			attempts: 3,
		});
		const text = (response.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text || "")
			.join("");
		return { ...parseDraft(text), provider, model };
	}
	throw new Error("Unsupported draft provider.");
}

export async function analyzeResumeProfile(input: {
	provider: AiProvider;
	settings: UserSettings;
	apiKey: string;
	resumeText?: string;
	pdfBase64?: string;
}): Promise<ResumeProfileSuggestions> {
	if (!input.resumeText && !input.pdfBase64) {
		throw new Error("Resume content is required.");
	}
	if (input.pdfBase64 && input.provider !== "GEMINI") {
		throw new Error("Gemini is required to analyze PDF resumes.");
	}
	const prompt = resumeProfilePrompt(input.resumeText);
	if (input.provider === "GEMINI") {
		const models = [input.settings.geminiModel || "gemini-3.8-flash"];
		if (models[0] === "gemini-3.8-flash") models.push("gemini-3.7-flash");
		let lastError: Error | undefined;
		for (const model of models) {
			try {
				const response = await fetchJson<{
					output_text?: string;
					steps?: Array<{
						type: string;
						content?: Array<{ type: string; text?: string }>;
					}>;
				}>("https://generativelanguage.googleapis.com/v1beta/interactions", {
					headers: { "x-goog-api-key": input.apiKey },
					body: {
						model,
						input: input.pdfBase64
							? [
									{
										type: "document",
										data: input.pdfBase64,
										mime_type: "application/pdf",
									},
									{ type: "text", text: prompt },
								]
							: prompt,
						system_instruction:
							"Return only the requested valid JSON object with no Markdown.",
						store: false,
						generation_config: {
							temperature: 0.1,
							max_output_tokens: 900,
							thinking_level: "low",
						},
					},
					attempts: 3,
					timeoutMs: 30000,
				});
				return {
					...parseResumeProfile(geminiOutputText(response)),
					provider: input.provider,
					model,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error("Gemini failed.");
			}
		}
		throw lastError ?? new Error("Gemini failed.");
	}
	if (input.provider === "OPENAI") {
		const model = input.settings.openAiModel || "gpt-5-mini";
		const response = await fetchJson<{
			output_text?: string;
			output?: Array<{
				content?: Array<{ type: string; text?: string }>;
			}>;
		}>("https://api.openai.com/v1/responses", {
			headers: { Authorization: `Bearer ${input.apiKey}` },
			body: { model, input: prompt, max_output_tokens: 900 },
			attempts: 3,
			timeoutMs: 30000,
		});
		const text =
			response.output_text ||
			(response.output ?? [])
				.flatMap((item) => item.content ?? [])
				.map((part) => part.text || "")
				.join("");
		return {
			...parseResumeProfile(text),
			provider: input.provider,
			model,
		};
	}
	const model = input.settings.anthropicModel || "claude-haiku-4-5";
	const response = await fetchJson<{
		content?: Array<{ type: string; text?: string }>;
	}>("https://api.anthropic.com/v1/messages", {
		headers: {
			"x-api-key": input.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: {
			model,
			max_tokens: 900,
			system: "Return only the requested valid JSON object with no Markdown.",
			messages: [{ role: "user", content: prompt }],
		},
		attempts: 3,
		timeoutMs: 30000,
	});
	const text = (response.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text || "")
		.join("");
	return {
		...parseResumeProfile(text),
		provider: input.provider,
		model,
	};
}

export function templateDraft(
	prospect: Prospect,
	settings: UserSettings,
): DraftResult {
	const context = Object.fromEntries(
		settings.personalContext.map((item) => [item.category.toLowerCase(), item.content]),
	);
	const senderFact = truncateWords(
		context["experience to reference"] ||
			context["background summary"] ||
			context.interests ||
			"",
		18,
	);
	const recipient = recipientObservation(prospect);
	const topic = questionTopic(prospect, settings);
	const body = [
		`Hi ${prospect.firstName || prospect.fullName},`,
		"",
		recipient,
		senderFact ? ensureSentence(senderFact) : "",
		`I would especially value your perspective on ${topic}.`,
		"Would you be open to a 15-minute coffee chat in the next few weeks?",
		"",
		"Best,",
		settings.senderName,
	]
		.filter((line, index, all) => line || (index > 0 && all[index - 1] !== ""))
		.join("\n");
	return {
		subject: prospect.company
			? `A question about your work at ${prospect.company}`
			: `Learning from your ${prospect.title || "professional"} experience`,
		body,
		personalizationNotes:
			"Centered the recipient's role/profile evidence and used at most one sender fact.",
		provider: "TEMPLATE",
		model: "",
	};
}

function resumeProfilePrompt(resumeText?: string): string {
	return [
		"Extract factual profile information from the supplied resume for a professional networking email tool.",
		"Return only JSON with exactly these string fields:",
		'{"senderName":"","backgroundSummary":"","currentGoal":"","experienceToReference":""}',
		"Rules:",
		"- Use only facts explicitly present in the resume.",
		"- Do not invent goals, interests, achievements, employers, dates, or skills.",
		"- senderName: the person's full name if clearly stated.",
		"- backgroundSummary: 2-4 concise sentences covering education and current/recent professional background.",
		"- currentGoal: include only an objective or goal explicitly stated in the resume; otherwise return an empty string.",
		"- experienceToReference: concise factual highlights from work, projects, leadership, education, and skills that can support personalized outreach.",
		"- Exclude phone numbers, street addresses, email addresses, references, and sensitive demographic information.",
		resumeText ? `RESUME_TEXT:\n${resumeText}` : "The resume is attached as a document input.",
	].join("\n");
}

function geminiOutputText(response: {
	output_text?: string;
	steps?: Array<{
		type: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
}): string {
	return (
		response.output_text ||
		(response.steps ?? [])
			.filter((step) => step.type === "model_output")
			.flatMap((step) => step.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text || "")
			.join("")
	);
}

export function parseResumeProfile(
	text: string,
): Omit<ResumeProfileSuggestions, "provider" | "model"> {
	const parsed = parseJsonObject(text) as {
		senderName?: string;
		backgroundSummary?: string;
		currentGoal?: string;
		experienceToReference?: string;
	};
	const result = {
		senderName: cleanText(parsed.senderName || "", 150),
		backgroundSummary: cleanText(parsed.backgroundSummary || "", 5000),
		currentGoal: cleanText(parsed.currentGoal || "", 5000),
		experienceToReference: cleanText(
			parsed.experienceToReference || "",
			5000,
		),
	};
	if (!result.backgroundSummary && !result.experienceToReference) {
		throw new Error("Resume provider returned incomplete profile information.");
	}
	return result;
}

function draftPrompt(prospect: Prospect, settings: UserSettings): string {
	return [
		"Write one recipient-focused professional coffee-chat email.",
		"Rules:",
		"- Use only supplied facts.",
		"- The opening and majority of the email must focus on the recipient.",
		"- Explain why this specific recipient was selected using their role, company, public snippet, or relevance evidence.",
		"- Ask about one concrete recipient-specific topic supported by the evidence.",
		"- Include at most one short sender sentence and never open with the sender.",
		"- Never invent a shared connection, achievement, or experience.",
		"- Ask for a 15-minute conversation.",
		`- Keep the body at or under ${settings.emailWordLimit} words.`,
		"- Return only JSON with subject, body, personalizationNotes.",
		"",
		`SENDER_NAME: ${settings.senderName}`,
		`OUTREACH_GOAL: ${prospect.outreachObjective || settings.outreachGoal}`,
		`PERSON: ${JSON.stringify({
			firstName: prospect.firstName,
			fullName: prospect.fullName,
			title: prospect.title,
			company: prospect.company,
			location: prospect.location,
			publicProfileSnippet: prospect.sourceSnippet,
			whyRelevant: prospect.whyRelevant,
		})}`,
		`SENDER_CONTEXT: ${JSON.stringify(settings.personalContext)}`,
	].join("\n");
}

function parseDraft(text: string): Omit<DraftResult, "provider" | "model"> {
	const parsed = parseJsonObject(text) as {
		subject?: string;
		body?: string;
		personalizationNotes?: string;
	};
	const subject = cleanText(parsed.subject || "", 200).replace(/[\r\n]/g, " ");
	const body = cleanText(parsed.body || "", 10000);
	const personalizationNotes = cleanText(
		parsed.personalizationNotes || "",
		2000,
	);
	if (!subject || !body) throw new Error("Draft provider returned incomplete output.");
	if (/\[[^\]]{1,80}\]/.test(body)) {
		throw new Error("Draft provider returned an unresolved placeholder.");
	}
	return { subject, body, personalizationNotes };
}

function parseJsonObject(text: string): Record<string, unknown> {
	const clean = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "");
	const start = clean.indexOf("{");
	const end = clean.lastIndexOf("}");
	const objectText = start >= 0 && end > start ? clean.slice(start, end + 1) : clean;
	return JSON.parse(objectText) as Record<string, unknown>;
}

export function buildDiscoveryQuery(criteria: DiscoveryCriteria): string {
	const groups = [
		queryGroup(criteria.roles, 8),
		queryGroup(criteria.companies, 6),
		queryGroup(criteria.locations, 6),
		queryGroup(criteria.industries, 6),
		queryGroup(criteria.keywords, 4),
		queryGroup(criteria.seniority, 6),
	].filter(Boolean);
	return buildBoundedQuery("site:linkedin.com/in", groups);
}

export function buildProfessionalBioQuery(
	criteria: DiscoveryCriteria,
): string {
	const roleTopics = Array.from(
		new Set([
			...criteria.keywords,
			...employerProfessionalTopics(criteria.companies),
			...professionalRoleTopics(criteria.roles),
		]),
	);
	return buildBoundedQuery("", [
		queryGroup(roleTopics, 10),
		queryGroup(employerSearchAliases(criteria.companies), 8),
		queryGroup(criteria.locations, 6),
		queryGroup(["team", "bio", "profile", "leadership"], 4),
	]);
}

export function professionalBioDomains(
	criteria: DiscoveryCriteria,
): string[] {
	return Array.from(
		new Set([
			...employerProfileDomains(criteria.companies),
			"theorg.com",
		]),
	)
		.map((domain) => domain.trim().toLowerCase())
		.filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
		.slice(0, 20);
}

function buildBoundedQuery(prefix: string, groups: string[]): string {
	const parts = prefix ? [prefix] : [];
	for (const group of groups.filter(Boolean)) {
		const candidate = [...parts, group].join(" AND ");
		if (candidate.length > 1800) break;
		parts.push(group);
	}
	return parts.join(" AND ");
}

function quote(value: string): string {
	return `"${sanitizeQueryToken(value)}"`;
}

function queryGroup(values: string[], limit: number): string {
	const tokens = Array.from(
		new Set(
			values
				.map(sanitizeQueryToken)
				.filter(Boolean),
		),
	).slice(0, limit);
	if (!tokens.length) return "";
	if (tokens.length === 1) return quote(tokens[0]!);
	return `(${tokens.map(quote).join(" OR ")})`;
}

function professionalRoleTopics(roles: string[]): string[] {
	const ignored = new Set([
		"team",
		"manager",
		"analyst",
		"professional",
		"hiring",
		"acquisition",
		"recruiter",
	]);
	return Array.from(
		new Set(
			roles.flatMap((role) =>
				sanitizeQueryToken(role)
					.toLowerCase()
					.split(" ")
					.filter(
						(token) =>
							token.length >= 4 &&
							!ignored.has(token),
					),
			),
		),
	);
}

function sanitizeQueryToken(value: string): string {
	return value
		.replace(/["\\\u0000-\u001f\u007f]/g, " ")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 120);
}

function linkedInPerson(
	result: { title?: string; url?: string; content?: string },
	criteria: DiscoveryCriteria,
): DiscoveredPerson | null {
	const linkedinUrl = normalizeLinkedIn(result.url || "");
	if (!linkedinUrl) return null;
	const parsed = parseSearchTitle(result.title || "");
	if (!isPersonName(parsed.fullName)) return null;
	const evidence = `${result.title || ""} ${result.content || ""}`;
	const score = scoreEvidence(evidence, criteria);
	return {
		...parsed,
		companyDomain: "",
		location: matchedLocation(evidence, criteria.locations),
		linkedinUrl,
		discoveryProvider: "TAVILY",
		sourceUrl: linkedinUrl,
		sourceSnippet: cleanText(result.content || "", 2500),
		whyRelevant:
			score.reasons.join("; ") ||
			"Matched the requested public profile criteria.",
		outreachObjective: cleanText(criteria.objective, 1000),
		relevanceScore: score.value,
	};
}

function professionalBioPerson(
	result: { title?: string; url?: string; content?: string },
	criteria: DiscoveryCriteria,
): DiscoveredPerson | null {
	const sourceUrl = normalizeProfessionalSourceUrl(result.url || "");
	if (!sourceUrl || isRejectedProfilePage(sourceUrl)) return null;
	const parsed = parseProfessionalBioTitle(result.title || "");
	if (!parsed) return null;
	const evidence = `${result.title || ""} ${result.content || ""}`;
	const company = matchedRequestedCompany(evidence, criteria.companies);
	if (!company || !matchesRoleEvidence(evidence, criteria)) return null;
	if (
		criteria.locations.length &&
		!matchesAnyCriterion(evidence, criteria.locations)
	) {
		return null;
	}
	const url = new URL(sourceUrl);
	const officialDomains = employerProfileDomains(criteria.companies);
	const official = officialDomains.some(
		(domain) =>
			url.hostname === domain || url.hostname === `www.${domain}`,
	);
	const vetted =
		url.hostname === "theorg.com" || url.hostname.endsWith(".theorg.com");
	if (!official && !vetted) return null;
	const score = scoreEvidence(evidence, {
		...criteria,
		companies: [company],
	});
	return {
		...parsed,
		company,
		companyDomain: officialDomains.at(-1) || "",
		location: matchedLocation(evidence, criteria.locations),
		linkedinUrl: "",
		discoveryProvider: "TAVILY",
		sourceUrl,
		sourceSnippet: cleanText(result.content || "", 2500),
		whyRelevant:
			score.reasons.join("; ") ||
			"Matched a public professional biography for the requested company.",
		outreachObjective: cleanText(criteria.objective, 1000),
		relevanceScore: score.value,
	};
}

function parseSearchTitle(title: string): Pick<
	DiscoveredPerson,
	"firstName" | "lastName" | "fullName" | "title" | "company"
> {
	const clean = cleanText(title, 500)
		.replace(/\s*[|–-]\s*LinkedIn\s*$/i, "")
		.replace(/\s+/g, " ");
	const parts = clean.split(/\s+(?:-|–|\|)\s+/).filter(Boolean);
	const fullName = parts[0] || "";
	const names = fullName.split(/\s+/);
	return {
		firstName: names[0] || "",
		lastName: names.slice(1).join(" "),
		fullName,
		title: parts[1] || "",
		company: parts[2] || "",
	};
}

export function parseProfessionalBioTitle(
	title: string,
): Pick<
	DiscoveredPerson,
	"firstName" | "lastName" | "fullName" | "title"
> | null {
	const clean = cleanText(title, 500)
		.replace(/\s*[|]\s*(?:The Org|BMO.*|Company Profile)\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
	let name = "";
	let role = "";
	const teamMatch = clean.match(
		/^meet (?:our|the) team\s*[-–—:|]\s*([^|,–—]+?)(?:\s*[-–—|]\s*(.+))?$/i,
	);
	if (teamMatch) {
		name = teamMatch[1] || "";
		role = teamMatch[2] || "";
	} else {
		const commaMatch = clean.match(/^([^,]+),\s*(.+)$/);
		const dashMatch = clean.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
		if (commaMatch) {
			name = commaMatch[1] || "";
			role = commaMatch[2] || "";
		} else if (dashMatch) {
			name = dashMatch[1] || "";
			role = dashMatch[2] || "";
		}
	}
	name = cleanText(name, 150);
	if (!isPersonName(name)) return null;
	role = cleanText(role, 200);
	const names = name.split(/\s+/);
	return {
		firstName: names[0] || "",
		lastName: names.slice(1).join(" "),
		fullName: name,
		title: isGenericProfileTitle(role) ? "" : role,
	};
}

function scoreEvidence(
	evidence: string,
	criteria: DiscoveryCriteria,
): { value: number; reasons: string[] } {
	const lower = evidence.toLowerCase();
	const groups = [
		["role", criteria.roles, 25],
		["seniority", criteria.seniority, 10],
		["company", criteria.companies, 20],
		["industry", criteria.industries, 15],
		["location", criteria.locations, 10],
		["keyword", criteria.keywords, 5],
	] as const;
	let value = 20;
	const reasons: string[] = [];
	for (const [label, values, points] of groups) {
		const match = values.find((item) => lower.includes(item.toLowerCase()));
		if (match) {
			value += points;
			reasons.push(`Matched ${label}: ${match}`);
		}
	}
	return { value: clamp(value, 0, 100), reasons };
}

export function recipientObservation(prospect: Prospect): string {
	const role = [prospect.title, prospect.company ? `at ${prospect.company}` : ""]
		.filter(Boolean)
		.join(" ");
	if (role) return `Your work as ${role} caught my attention.`;
	const industry = matchedReason(prospect.whyRelevant, "industry");
	const location = matchedReason(prospect.whyRelevant, "location");
	if (industry && location) {
		return `Your ${industry.toLowerCase()} experience in ${location} caught my attention.`;
	}
	if (industry) {
		return `Your experience in ${industry.toLowerCase()} caught my attention.`;
	}
	if (location) {
		return `Your professional experience in ${location} caught my attention.`;
	}
	return "Your professional background caught my attention.";
}

export function questionTopic(
	prospect: Prospect,
	settings: UserSettings,
): string {
	let topic = cleanText(
		prospect.outreachObjective || settings.outreachGoal,
		300,
	)
		.replace(/[.!?]+$/, "")
		.replace(
			/^(?:i want to |my goal is to |to )?(?:learn|learning|understand|explore)(?: more)?(?: about| from)? /i,
			"",
		)
		.replace(/^the recipient'?s /i, "")
		.trim();
	if (
		!topic ||
		/^(?:professional )?experience$/i.test(topic) ||
		/^their (?:professional )?experience$/i.test(topic)
	) {
		const industry = matchedReason(prospect.whyRelevant, "industry");
		if (prospect.title) {
			topic = `your path into ${prospect.title} and the work you do today`;
		} else if (industry) {
			topic = `your path into ${industry.toLowerCase()} and the work you do today`;
		} else if (prospect.company) {
			topic = `your experience at ${prospect.company}`;
		} else {
			topic = "your career path and current work";
		}
	}
	return lowerFirst(topic);
}

function matchedReason(value: string, label: string): string {
	const match = value.match(
		new RegExp(`Matched ${label}:\\s*([^;]+)`, "i"),
	);
	return cleanText(match?.[1] || "", 150);
}

function normalizeLinkedIn(value: string): string {
	try {
		const url = new URL(value.replace(/^http:/, "https:"));
		if (
			url.protocol !== "https:" ||
			!(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) ||
			!url.pathname.startsWith("/in/")
		) {
			return "";
		}
		return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

function normalizeProfessionalSourceUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (
				key.toLowerCase().startsWith("utm_") ||
				["fbclid", "gclid"].includes(key.toLowerCase())
			) {
				url.searchParams.delete(key);
			}
		}
		if (url.pathname !== "/") {
			url.pathname = url.pathname.replace(/\/+$/, "");
		}
		return url.toString();
	} catch {
		return "";
	}
}

function isRejectedProfilePage(value: string): boolean {
	const url = new URL(value);
	const hostname = url.hostname.toLowerCase();
	if (
		[
			"facebook.com",
			"instagram.com",
			"x.com",
			"twitter.com",
			"tiktok.com",
			"reddit.com",
			"zoominfo.com",
			"rocketreach.co",
			"signalhire.com",
			"contactout.com",
			"crunchbase.com",
		].some(
			(domain) => hostname === domain || hostname.endsWith(`.${domain}`),
		)
	) {
		return true;
	}
	return /\/(jobs?|careers?|search|news|press|articles?|blog|feed|tag|category)(\/|$)/i.test(
		url.pathname,
	);
}

function matchedRequestedCompany(
	evidence: string,
	companies: string[],
): string {
	return (
		companies.find((company) =>
			matchesCriterionEvidence(evidence, company, [
				"financial",
				"group",
				"company",
				"inc",
				"limited",
			]),
		) || ""
	);
}

function matchesRoleEvidence(
	evidence: string,
	criteria: DiscoveryCriteria,
): boolean {
	const values = criteria.keywords.length
		? criteria.keywords
		: criteria.roles;
	return values.some((value) =>
		matchesCriterionEvidence(evidence, value, [
			"team",
			"manager",
			"professional",
			"talent",
			"acquisition",
			"recruiter",
			"hiring",
		]),
	);
}

function matchesAnyCriterion(evidence: string, values: string[]): boolean {
	return values.some((value) =>
		matchesCriterionEvidence(evidence, value, [
			"ontario",
			"canada",
			"remote",
		]),
	);
}

function matchesCriterionEvidence(
	evidence: string,
	value: string,
	ignoredWords: string[],
): boolean {
	const normalizedEvidence = normalizeEvidence(evidence);
	const normalizedValue = normalizeEvidence(value);
	if (normalizedValue && normalizedEvidence.includes(normalizedValue)) return true;
	const ignored = new Set(ignoredWords);
	const tokens = normalizedValue
		.split(" ")
		.filter(
			(token) =>
				token.length >= 3 &&
				!ignored.has(token),
		);
	return tokens.some((token) => normalizedEvidence.includes(token));
}

function normalizeEvidence(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function matchedLocation(evidence: string, locations: string[]): string {
	return (
		locations.find((location) =>
			matchesCriterionEvidence(evidence, location, [
				"ontario",
				"canada",
				"remote",
			]),
		) || ""
	);
}

function isPersonName(value: string): boolean {
	const words = value.trim().split(/\s+/).filter(Boolean);
	if (words.length < 2 || words.length > 5) return false;
	const generic = new Set([
		"meet",
		"our",
		"team",
		"leadership",
		"management",
		"company",
		"group",
		"careers",
		"jobs",
		"investment",
		"professionals",
		"profile",
	]);
	if (words.some((word) => generic.has(word.toLowerCase()))) return false;
	if (
		!words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word))
	) {
		return false;
	}
	return /^[\p{Lu}]/u.test(words[0]!) && /^[\p{Lu}]/u.test(words.at(-1)!);
}

function isGenericProfileTitle(value: string): boolean {
	return (
		!value ||
		/^(?:profile|bio|biography|meet (?:our|the) team|leadership|the org)$/i.test(
			value.trim(),
		)
	);
}

function linkedinHandle(value: string): string {
	return normalizeLinkedIn(value).match(/\/in\/([^/?#]+)/i)?.[1] || "";
}

function normalizeEmail(value: string): string {
	const email = value.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

function matchedValue(evidence: string, values: string[]): string {
	const lower = evidence.toLowerCase();
	return values.find((value) => lower.includes(value.toLowerCase())) || "";
}

function cleanText(value: string, maximum: number): string {
	return String(value || "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.trim()
		.slice(0, maximum);
}

function truncateWords(value: string, maximum: number): string {
	const words = cleanText(value, 10000).split(/\s+/).filter(Boolean);
	return words.length <= maximum
		? words.join(" ")
		: `${words.slice(0, maximum).join(" ")}…`;
}

function ensureSentence(value: string): string {
	if (!value || /[.!?…]$/.test(value)) return value;
	return `${value}.`;
}

function lowerFirst(value: string): string {
	return value ? value.charAt(0).toLowerCase() + value.slice(1) : "";
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
