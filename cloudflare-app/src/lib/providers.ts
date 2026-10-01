import type { Prospect } from "./store";
import type { UserSettings } from "./store";
import { fetchJson } from "./fetch";

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
): Promise<DiscoveredPerson[]> {
	const query = buildDiscoveryQuery(criteria);
	const response = await fetchJson<{
		results?: Array<{ title?: string; url?: string; content?: string }>;
	}>("https://api.tavily.com/search", {
		headers: { Authorization: `Bearer ${apiKey}` },
		body: {
			query,
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
	for (const result of response.results ?? []) {
		const linkedinUrl = normalizeLinkedIn(result.url || "");
		if (!linkedinUrl || seen.has(linkedinUrl)) continue;
		const parsed = parseSearchTitle(result.title || "");
		if (!parsed.fullName) continue;
		seen.add(linkedinUrl);
		const evidence = `${result.title || ""} ${result.content || ""}`;
		const score = scoreEvidence(evidence, criteria);
		people.push({
			...parsed,
			companyDomain: "",
			location: matchedValue(evidence, criteria.locations),
			linkedinUrl,
			discoveryProvider: "TAVILY",
			sourceUrl: linkedinUrl,
			sourceSnippet: cleanText(result.content || "", 2500),
			whyRelevant:
				score.reasons.join("; ") ||
				"Matched the requested public profile criteria.",
			outreachObjective: cleanText(criteria.objective, 1000),
			relevanceScore: score.value,
		});
		if (people.length >= criteria.count) break;
	}
	return people;
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

function buildDiscoveryQuery(criteria: DiscoveryCriteria): string {
	return [
		"site:linkedin.com/in",
		...criteria.roles.map(quote),
		...criteria.seniority.map(quote),
		...criteria.companies.map(quote),
		...criteria.industries.map(quote),
		...criteria.locations.map(quote),
		...criteria.keywords.map(quote),
	].join(" ");
}

function quote(value: string): string {
	return `"${value.replace(/"/g, "")}"`;
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
