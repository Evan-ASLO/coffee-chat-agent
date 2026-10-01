import { z } from "zod";
import { fetchJson, ProviderHttpError } from "./fetch";
import {
	employerProfessionalTopics,
	employerSearchAliases,
} from "./job-discovery";
import {
	linkedInDiscoveryPerson,
	normalizeProfessionalSourceUrl,
	professionalBioDomains,
	professionalBioPerson,
	type DiscoveredPerson,
	type DiscoveryCriteria,
} from "./providers";

export type PeopleSearchFallbackProvider =
	| "GEMINI"
	| "OPENAI"
	| "ANTHROPIC";

export type PeopleSearchErrorCategory =
	| "RATE_LIMITED"
	| "AUTH"
	| "BAD_REQUEST"
	| "UNSUPPORTED"
	| "TIMEOUT"
	| "MALFORMED_RESPONSE"
	| "PROVIDER_ERROR";

const GEMINI_SEARCH_MODELS = new Set([
	"gemini-3.8-flash",
	"gemini-3.7-flash",
]);

const groundedPersonSchema = z
	.object({
		fullName: z.string().trim().min(3).max(150),
		title: z.string().trim().max(200),
		company: z.string().trim().min(1).max(200),
		location: z.string().trim().max(200),
		sourceUrl: z.string().url().max(2048),
		evidence: z.string().trim().min(1).max(1200),
	})
	.strict();

const groundedResponseSchema = z
	.object({
		people: z.array(groundedPersonSchema).max(10),
	})
	.strict();

interface GeminiInteractionResponse {
	output_text?: string;
	steps?: Array<{
		type?: string;
		content?: Array<{
			type?: string;
			text?: string;
			annotations?: Array<{
				type?: string;
				url?: string;
			}>;
		}>;
	}>;
}

interface OpenAiResponse {
	output_text?: string;
	output?: Array<{
		type?: string;
		content?: Array<{
			type?: string;
			text?: string;
			annotations?: Array<{
				type?: string;
				url?: string;
			}>;
		}>;
	}>;
}

interface AnthropicResponse {
	content?: Array<{
		type?: string;
		text?: string;
		citations?: Array<{
			type?: string;
			url?: string;
		}>;
		content?:
			| Array<unknown>
			| {
					type?: string;
					error_code?: string;
			  };
	}>;
}

interface GroundedOutput {
	text: string;
	citations: string[];
}

export interface PeopleSearchFallbackResult {
	provider: PeopleSearchFallbackProvider;
	model: string;
	returned: number;
	accepted: number;
	people: DiscoveredPerson[];
}

export class PeopleSearchFallbackError extends Error {
	constructor(
		readonly category: PeopleSearchErrorCategory,
		readonly httpStatus: number | null = null,
	) {
		super("People-search fallback failed.");
		this.name = "PeopleSearchFallbackError";
	}
}

export async function discoverWithPeopleSearchFallback(input: {
	provider: PeopleSearchFallbackProvider;
	apiKey: string;
	model: string;
	criteria: DiscoveryCriteria;
	count: number;
}): Promise<PeopleSearchFallbackResult> {
	try {
		const provider = input.provider;
		const model = validateConfiguredModel(provider, input.model);
		const allowedDomains = Array.from(
			new Set(["linkedin.com", ...professionalBioDomains(input.criteria)]),
		);
		const prompt = groundedPrompt(
			input.criteria,
			Math.min(Math.max(input.count, 1), 10),
			allowedDomains,
		);
		const output = await requestGroundedSearch({
			provider,
			apiKey: input.apiKey,
			model,
			prompt,
			allowedDomains,
		});
		const parsed = groundedResponseSchema.parse(parseJsonObject(output.text));
		const citedUrls = new Set(
			output.citations
				.map(normalizeProfessionalSourceUrl)
				.filter(Boolean),
		);
		const people = new Map<string, DiscoveredPerson>();
		for (const candidate of parsed.people) {
			const sourceUrl = normalizeProfessionalSourceUrl(candidate.sourceUrl);
			if (!sourceUrl || !citedUrls.has(sourceUrl)) continue;
			const result = {
				title: `${candidate.fullName} - ${candidate.title}`,
				url: sourceUrl,
				content: `${candidate.evidence} ${candidate.company} ${candidate.location}`,
			};
			const accepted =
				linkedInDiscoveryPerson(result, input.criteria) ||
				professionalBioPerson(result, input.criteria);
			if (!accepted) continue;
			people.set(accepted.linkedinUrl || accepted.sourceUrl, {
				...accepted,
				discoveryProvider: groundedDiscoveryProvider(provider),
			});
			if (people.size >= input.count) break;
		}
		return {
			provider,
			model,
			returned: parsed.people.length,
			accepted: people.size,
			people: [...people.values()],
		};
	} catch (error) {
		throw classifyPeopleSearchError(error);
	}
}

function validateConfiguredModel(
	provider: PeopleSearchFallbackProvider,
	selectedModel: string,
): string {
	const model = selectedModel.trim();
	if (!model) throw new PeopleSearchFallbackError("UNSUPPORTED");
	if (provider === "GEMINI" && !GEMINI_SEARCH_MODELS.has(model)) {
		throw new PeopleSearchFallbackError("UNSUPPORTED");
	}
	return model;
}

async function requestGroundedSearch(input: {
	provider: PeopleSearchFallbackProvider;
	apiKey: string;
	model: string;
	prompt: string;
	allowedDomains: string[];
}): Promise<GroundedOutput> {
	switch (input.provider) {
		case "GEMINI": {
			const response = await fetchJson<GeminiInteractionResponse>(
				"https://generativelanguage.googleapis.com/v1beta/interactions",
				{
					headers: { "x-goog-api-key": input.apiKey },
					body: {
						model: input.model,
						input: input.prompt,
						tools: [{ type: "google_search" }],
						store: false,
						system_instruction:
							"Return only the requested JSON object with no Markdown or extra prose.",
						generation_config: {
							temperature: 0.1,
							max_output_tokens: 1400,
							thinking_level: "low",
						},
					},
					attempts: 1,
					timeoutMs: 20000,
				},
			);
			return extractGeminiOutput(response);
		}
		case "OPENAI": {
			const response = await fetchJson<OpenAiResponse>(
				"https://api.openai.com/v1/responses",
				{
					headers: {
						Authorization: ["Bearer", input.apiKey].join(" "),
					},
					body: {
						model: input.model,
						input: input.prompt,
						tools: [
							{
								type: "web_search",
								search_context_size: "low",
								filters: {
									allowed_domains: input.allowedDomains.slice(0, 100),
								},
							},
						],
						tool_choice: "auto",
						store: false,
						max_output_tokens: 1400,
					},
					attempts: 1,
					timeoutMs: 20000,
				},
			);
			return extractOpenAiOutput(response);
		}
		case "ANTHROPIC": {
			const response = await fetchJson<AnthropicResponse>(
				"https://api.anthropic.com/v1/messages",
				{
					headers: {
						"x-api-key": input.apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: {
						model: input.model,
						max_tokens: 1400,
						temperature: 0.1,
						tools: [
							{
								type: "web_search_20250305",
								name: "web_search",
								max_uses: 1,
								allowed_domains: input.allowedDomains,
							},
						],
						messages: [{ role: "user", content: input.prompt }],
					},
					attempts: 1,
					timeoutMs: 20000,
				},
			);
			return extractAnthropicOutput(response);
		}
	}
}

function groundedPrompt(
	criteria: DiscoveryCriteria,
	count: number,
	allowedDomains: string[],
): string {
	return JSON.stringify({
		task:
			"Use the provider web-search tool with minimal queries to find cited public professional profiles for this job-networking search.",
		maxPeople: count,
		companyAliases: employerSearchAliases(criteria.companies),
		professionalRoleTopics: Array.from(
			new Set([
				...criteria.roles,
				...criteria.keywords,
				...employerProfessionalTopics(criteria.companies),
			]),
		),
		location: criteria.locations,
		approvedDomains: allowedDomains,
		requirements: [
			"Use only public person-specific professional sources on the approved domains.",
			"Each person must have a direct cited LinkedIn /in page or approved public biography page.",
			"Reject job, careers, search, news, list, social-feed, and data-broker pages.",
			"Do not invent or infer names, roles, company, location, evidence, or URLs.",
			"sourceUrl must exactly equal a cited source URL.",
			"Return fewer people or an empty array when sources are insufficient.",
		],
		output: {
			people: [
				{
					fullName: "string",
					title: "string or empty string",
					company: "string",
					location: "string or empty string",
					sourceUrl: "absolute cited URL",
					evidence: "short cited factual sentence",
				},
			],
		},
	});
}

function extractGeminiOutput(
	response: GeminiInteractionResponse,
): GroundedOutput {
	let text = response.output_text || "";
	const citations: string[] = [];
	for (const step of response.steps || []) {
		if (step.type !== "model_output") continue;
		const blocks = (step.content || []).filter(
			(content) => content.type === "text",
		);
		if (blocks.length) {
			text = blocks.map((content) => content.text || "").join("");
		}
		collectUrlCitations(blocks, citations);
	}
	return requireGroundedOutput(text, citations, "Gemini");
}

function extractOpenAiOutput(response: OpenAiResponse): GroundedOutput {
	let text = response.output_text || "";
	const citations: string[] = [];
	for (const item of response.output || []) {
		if (item.type !== "message") continue;
		const blocks = (item.content || []).filter(
			(content) => content.type === "output_text",
		);
		if (blocks.length) {
			text = blocks.map((content) => content.text || "").join("");
		}
		collectUrlCitations(blocks, citations);
	}
	return requireGroundedOutput(text, citations, "OpenAI");
}

function extractAnthropicOutput(
	response: AnthropicResponse,
): GroundedOutput {
	const textBlocks = (response.content || []).filter(
		(content) => content.type === "text",
	);
	const citations: string[] = [];
	for (const block of textBlocks) {
		for (const citation of block.citations || []) {
			if (
				citation.type === "web_search_result_location" &&
				citation.url
			) {
				citations.push(citation.url);
			}
		}
	}
	for (const block of response.content || []) {
		if (
			block.type === "web_search_tool_result" &&
			block.content &&
			!Array.isArray(block.content)
		) {
			throw new PeopleSearchFallbackError(
				anthropicToolErrorCategory(block.content.error_code),
			);
		}
	}
	return requireGroundedOutput(
		textBlocks.map((content) => content.text || "").join(""),
		citations,
		"Anthropic",
	);
}

function collectUrlCitations(
	blocks: Array<{
		annotations?: Array<{ type?: string; url?: string }>;
	}>,
	citations: string[],
): void {
	for (const block of blocks) {
		for (const annotation of block.annotations || []) {
			if (annotation.type === "url_citation" && annotation.url) {
				citations.push(annotation.url);
			}
		}
	}
}

function requireGroundedOutput(
	text: string,
	citations: string[],
	provider: string,
): GroundedOutput {
	if (!text.trim()) {
		throw new Error(`${provider} web search returned no JSON output.`);
	}
	return { text, citations };
}

function parseJsonObject(value: string): unknown {
	const clean = value
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "");
	const start = clean.indexOf("{");
	const end = clean.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("People-search fallback returned malformed JSON.");
	}
	return JSON.parse(clean.slice(start, end + 1));
}

function classifyPeopleSearchError(
	error: unknown,
): PeopleSearchFallbackError {
	if (error instanceof PeopleSearchFallbackError) return error;
	if (error instanceof ProviderHttpError) {
		return new PeopleSearchFallbackError(
			httpErrorCategory(error.status, error.message),
			error.status,
		);
	}
	if (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.message.toLowerCase().includes("aborted"))
	) {
		return new PeopleSearchFallbackError("TIMEOUT");
	}
	if (
		error instanceof z.ZodError ||
		error instanceof SyntaxError ||
		(error instanceof Error &&
			/malformed json|no json output|unexpected end of json/i.test(
				error.message,
			))
	) {
		return new PeopleSearchFallbackError("MALFORMED_RESPONSE");
	}
	return new PeopleSearchFallbackError("PROVIDER_ERROR");
}

function httpErrorCategory(
	status: number,
	message: string,
): PeopleSearchErrorCategory {
	if (status === 429) return "RATE_LIMITED";
	if (status === 401 || status === 403) return "AUTH";
	if (status === 404) return "UNSUPPORTED";
	if (status === 400 || status === 422) {
		return /not supported|unsupported|does not support|model.*not found|tool.*(?:disabled|not enabled|unavailable)|web.search.*(?:disabled|not enabled)/i.test(
			message,
		)
			? "UNSUPPORTED"
			: "BAD_REQUEST";
	}
	return "PROVIDER_ERROR";
}

function anthropicToolErrorCategory(
	errorCode?: string,
): PeopleSearchErrorCategory {
	switch (errorCode) {
		case "too_many_requests":
			return "RATE_LIMITED";
		case "invalid_tool_input":
		case "max_uses_exceeded":
		case "query_too_long":
		case "request_too_large":
			return "BAD_REQUEST";
		default:
			return "PROVIDER_ERROR";
	}
}

function groundedDiscoveryProvider(
	provider: PeopleSearchFallbackProvider,
):
	| "GEMINI_GROUNDED"
	| "OPENAI_GROUNDED"
	| "ANTHROPIC_GROUNDED" {
	switch (provider) {
		case "GEMINI":
			return "GEMINI_GROUNDED";
		case "OPENAI":
			return "OPENAI_GROUNDED";
		case "ANTHROPIC":
			return "ANTHROPIC_GROUNDED";
	}
}
