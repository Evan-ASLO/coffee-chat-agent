import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discoverWithPeopleSearchFallback,
	PeopleSearchFallbackError,
	type PeopleSearchFallbackProvider,
} from "../src/lib/people-search-fallback";
import type { DiscoveryCriteria } from "../src/lib/providers";

afterEach(() => {
	vi.restoreAllMocks();
});

const criteria: DiscoveryCriteria = {
	roles: ["Investment Analyst", "Portfolio Manager", "Talent Acquisition"],
	industries: ["Banking & Financial Services"],
	companies: ["BMO Financial Group"],
	locations: ["Toronto"],
	keywords: ["investment", "portfolio"],
	seniority: [],
	objective: "PRIVATE USER OBJECTIVE MUST NOT BE SENT",
	count: 2,
};

const people = [
	{
		fullName: "Alexander Spark",
		title: "Managing Director",
		company: "BMO Financial Group",
		location: "Toronto",
		sourceUrl: "https://privatewealth.bmo.com/en/people/alexander-spark",
		evidence:
			"Alexander Spark is a Managing Director at BMO Financial Group in Toronto.",
	},
	{
		fullName: "Jamie Example",
		title: "Investment Analyst",
		company: "BMO Financial Group",
		location: "Toronto",
		sourceUrl: "https://www.linkedin.com/in/jamie-bmo",
		evidence:
			"Jamie Example is an Investment Analyst at BMO Financial Group in Toronto.",
	},
];

const citations = people.map((person) => person.sourceUrl);

const providerCases: Array<{
	provider: PeopleSearchFallbackProvider;
	model: string;
	endpoint: string;
	discoveryProvider: string;
}> = [
	{
		provider: "GEMINI",
		model: "gemini-3.7-flash",
		endpoint:
			"https://generativelanguage.googleapis.com/v1beta/interactions",
		discoveryProvider: "GEMINI_GROUNDED",
	},
	{
		provider: "OPENAI",
		model: "gpt-5.5",
		endpoint: "https://api.openai.com/v1/responses",
		discoveryProvider: "OPENAI_GROUNDED",
	},
	{
		provider: "ANTHROPIC",
		model: "claude-haiku-4-5",
		endpoint: "https://api.anthropic.com/v1/messages",
		discoveryProvider: "ANTHROPIC_GROUNDED",
	},
];

function groundedResponse(
	provider: PeopleSearchFallbackProvider,
	input: {
		people: unknown[];
		citations?: string[];
		text?: string;
		anthropicToolErrors?: string[];
	},
): Response {
	const text = input.text ?? JSON.stringify({ people: input.people });
	const urls = input.citations || [];
	let body: unknown;
	if (provider === "GEMINI") {
		body = {
			steps: [
				{
					type: "model_output",
					content: [
						{
							type: "text",
							text,
							annotations: urls.map((url) => ({
								type: "url_citation",
								url,
							})),
						},
					],
				},
			],
		};
	} else if (provider === "OPENAI") {
		body = {
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text,
							annotations: urls.map((url) => ({
								type: "url_citation",
								url,
							})),
						},
					],
				},
			],
		};
	} else {
		body = {
			content: [
				{
					type: "text",
					text,
					citations: urls.map((url) => ({
						type: "web_search_result_location",
						url,
					})),
				},
				...(input.anthropicToolErrors || []).map((errorCode) => ({
					type: "web_search_tool_result",
					content: {
						type: "web_search_tool_result_error",
						error_code: errorCode,
					},
				})),
			],
		};
	}
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("cited people-search fallback providers", () => {
	for (const testCase of providerCases) {
		it(`accepts cited official and LinkedIn profiles through ${testCase.provider}`, async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					groundedResponse(testCase.provider, { people, citations }),
				);
			const result = await discoverWithPeopleSearchFallback({
				provider: testCase.provider,
				apiKey: `${testCase.provider.toLowerCase()}-user-secret`,
				model: testCase.model,
				criteria,
				count: 2,
			});
			expect(result).toMatchObject({
				provider: testCase.provider,
				model: testCase.model,
				status: "SUCCESS",
				reason: null,
				returned: 2,
				accepted: 2,
			});
			expect(result.people).toEqual([
				expect.objectContaining({
					fullName: "Alexander Spark",
					discoveryProvider: testCase.discoveryProvider,
					sourceUrl:
						"https://privatewealth.bmo.com/en/people/alexander-spark",
					matchQuality: "BROADER_COMPANY",
				}),
				expect.objectContaining({
					fullName: "Jamie Example",
					discoveryProvider: testCase.discoveryProvider,
					linkedinUrl: "https://www.linkedin.com/in/jamie-bmo",
					matchQuality: "STRONG",
				}),
			]);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, options] = fetchSpy.mock.calls[0]!;
			expect(url).toBe(testCase.endpoint);
			const body = JSON.parse(String((options as RequestInit).body));
			expect(body.model).toBe(testCase.model);
			const prompt = String(body.input || body.messages?.[0]?.content);
			expect(prompt).toContain("BMO Financial Group");
			expect(prompt).not.toContain(criteria.objective);
			expect(prompt).not.toContain("user-secret");
			expect(prompt).not.toMatch(
				/resume|senderName|personalContext|email/i,
			);
			if (testCase.provider === "GEMINI") {
				expect(body).toMatchObject({
					tools: [{ type: "google_search" }],
					store: false,
				});
			} else if (testCase.provider === "OPENAI") {
				expect(body.tools[0]).toMatchObject({
					type: "web_search",
					search_context_size: "low",
					filters: {
						allowed_domains: expect.arrayContaining([
							"privatewealth.bmo.com",
							"linkedin.com",
						]),
					},
				});
			} else {
				expect(body).toMatchObject({ max_tokens: 1400, temperature: 0.1 });
				expect(body.tools[0]).toMatchObject({
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 1,
					allowed_domains: expect.arrayContaining([
						"privatewealth.bmo.com",
						"linkedin.com",
					]),
				});
			}
		});
	}

	it("rejects uncited, host-mismatched, job, and Google redirect objects", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const candidates = [
			{
				person: people[0],
				citations: [],
			},
			{
				person: {
					...people[0],
					sourceUrl: "https://example.com/wrong-host",
				},
				citations: ["https://example.com/wrong-host"],
			},
			{
				person: {
					...people[0],
					sourceUrl:
						"https://www.bmo.com/careers/jobs/investment-analyst",
				},
				citations: [
					"https://www.bmo.com/careers/jobs/investment-analyst",
				],
			},
			{
				person: {
					...people[0],
					sourceUrl:
						"https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
				},
				citations: [
					"https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
				],
			},
			{
				person: {
					...people[1],
					company: "Unrelated Employer",
					evidence: "Jamie Example is an Investment Analyst at Unrelated Employer in Toronto.",
				},
				citations,
			},
			{
				person: {
					...people[1],
					title: "Profile",
					location: "Ottawa",
					evidence: "Jamie Example works at BMO Financial Group in Ottawa.",
				},
				citations,
			},
		];
		for (const testCase of providerCases) {
			for (const candidate of candidates) {
				fetchSpy.mockResolvedValueOnce(
					groundedResponse(testCase.provider, {
						people: [candidate.person],
						citations: candidate.citations,
						anthropicToolErrors:
							testCase.provider === "ANTHROPIC"
								? ["max_uses_exceeded"]
								: [],
					}),
				);
			}
			for (let index = 0; index < candidates.length; index += 1) {
				const result = await discoverWithPeopleSearchFallback({
					provider: testCase.provider,
					apiKey: "user-key",
					model: testCase.model,
					criteria,
					count: 1,
				});
				expect(result).toMatchObject({
					status:
						testCase.provider === "ANTHROPIC"
							? "SEARCH_LIMITED"
							: "SUCCESS",
					returned: 1,
					accepted: 0,
					people: [],
				});
			}
		}
	});

	for (const testCase of providerCases) {
		it(`classifies ${testCase.provider} HTTP 429 without leaking provider content`, async () => {
			const unsafeBody = JSON.stringify({
				error: {
					message:
						"private prompt https://private.example/profile API-KEY-DO-NOT-STORE",
				},
			});
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(unsafeBody, {
						status: 429,
						headers: { "Content-Type": "application/json" },
					}),
				);
			const error = await fallbackError({
				provider: testCase.provider,
				model: testCase.model,
			});
			expect(error).toMatchObject({
				category: "RATE_LIMITED",
				httpStatus: 429,
				message: "People-search fallback failed.",
			});
			expect(JSON.stringify(error)).not.toContain("private prompt");
			expect(JSON.stringify(error)).not.toContain("private.example");
			expect(JSON.stringify(error)).not.toContain("API-KEY-DO-NOT-STORE");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
	}

	it("classifies auth, bad request, unsupported, and provider failures safely", async () => {
		const cases: Array<{
			provider: PeopleSearchFallbackProvider;
			model: string;
			status: number;
			body: string;
			category: string;
		}> = [
			{
				provider: "GEMINI",
				model: "gemini-3.8-flash",
				status: 401,
				body: "invalid API key SECRET-VALUE",
				category: "AUTH",
			},
			{
				provider: "OPENAI",
				model: "gpt-5.5",
				status: 422,
				body: "invalid request body with private prompt",
				category: "BAD_REQUEST",
			},
			{
				provider: "ANTHROPIC",
				model: "claude-haiku-4-5",
				status: 400,
				body: "invalid request body with private prompt",
				category: "BAD_REQUEST",
			},
			{
				provider: "ANTHROPIC",
				model: "claude-haiku-4-5",
				status: 422,
				body: "invalid request body with private prompt",
				category: "BAD_REQUEST",
			},
			{
				provider: "ANTHROPIC",
				model: "claude-sonnet-4-6",
				status: 400,
				body: "web search tool is not enabled for this account",
				category: "UNSUPPORTED",
			},
			{
				provider: "GEMINI",
				model: "gemini-3.8-flash",
				status: 404,
				body: "model not found",
				category: "UNSUPPORTED",
			},
			{
				provider: "OPENAI",
				model: "gpt-5.5",
				status: 500,
				body: "internal provider details",
				category: "PROVIDER_ERROR",
			},
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		for (const testCase of cases) {
			fetchSpy.mockResolvedValueOnce(
				new Response(testCase.body, { status: testCase.status }),
			);
		}
		for (const testCase of cases) {
			const error = await fallbackError(testCase);
			expect(error).toMatchObject({
				category: testCase.category,
				httpStatus: testCase.status,
				reason: null,
				message: "People-search fallback failed.",
			});
			expect(error.message).not.toContain(testCase.body);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(cases.length);
	});

	it("retains only validated cited profiles when Anthropic reaches its search-use cap", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			groundedResponse("ANTHROPIC", {
				people: [people[0], people[0], people[1]],
				citations,
				anthropicToolErrors: ["max_uses_exceeded"],
			}),
		);
		const result = await discoverWithPeopleSearchFallback({
			provider: "ANTHROPIC",
			model: "claude-haiku-4-5",
			apiKey: "test-anthropic-key",
			criteria,
			count: 3,
		});
		expect(result).toMatchObject({
			status: "SEARCH_LIMITED",
			reason: "max_uses_exceeded",
			returned: 3,
			accepted: 2,
		});
		expect(result.people.map((person) => person.sourceUrl)).toEqual(citations);
		expect(result.people.map((person) => person.matchQuality)).toEqual([
			"BROADER_COMPANY", "STRONG",
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: "missing JSON", text: "" },
		{ name: "truncated JSON", text: '{"people":[' },
		{
			name: "invalid schema",
			text: JSON.stringify({ people, unexpected: "private prompt SECRET-DO-NOT-STORE" }),
		},
	])("reports the search-use cap without salvaging $name", async ({ text }) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			groundedResponse("ANTHROPIC", {
				people,
				citations,
				text,
				anthropicToolErrors: ["max_uses_exceeded"],
			}),
		);
		const error = await fallbackError({
			provider: "ANTHROPIC",
			model: "claude-haiku-4-5",
		});
		expect(error).toMatchObject({
			category: "SEARCH_LIMITED",
			reason: "max_uses_exceeded",
			httpStatus: null,
		});
		expect(JSON.stringify(error)).not.toMatch(/private prompt|SECRET-DO-NOT-STORE|Alexander Spark/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it.each([
		["too_many_requests", "RATE_LIMITED", "too_many_requests"],
		["invalid_tool_input", "BAD_REQUEST", "invalid_tool_input"],
		["query_too_long", "BAD_REQUEST", "query_too_long"],
		["request_too_large", "BAD_REQUEST", "request_too_large"],
		["unavailable", "PROVIDER_ERROR", "unavailable"],
		["private prompt SECRET-DO-NOT-STORE", "PROVIDER_ERROR", "unknown_tool_error"],
	])("classifies Anthropic tool error %s without salvaging or exposing its response", async (errorCode, category, reason) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			groundedResponse("ANTHROPIC", {
				people,
				citations,
				anthropicToolErrors: ["max_uses_exceeded", errorCode],
			}),
		);
		const error = await fallbackError({
				provider: "ANTHROPIC",
				model: "claude-haiku-4-5",
		});
		expect(error).toMatchObject({
			category,
			reason,
			httpStatus: null,
		});
		expect(JSON.stringify(error)).not.toMatch(/private prompt|SECRET-DO-NOT-STORE|Alexander Spark/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: "missing content", content: undefined },
		{ name: "invalid error type", content: { type: "text", error_code: "max_uses_exceeded" } },
	])("does not salvage a malformed Anthropic tool result with $name", async ({ content }) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				content: [
					{
						type: "text",
						text: JSON.stringify({ people }),
						citations: citations.map((url) => ({
							type: "web_search_result_location", url,
						})),
					},
					{ type: "web_search_tool_result", content },
				],
			}),
		);
		await expect(fallbackError({
			provider: "ANTHROPIC",
			model: "claude-haiku-4-5",
		})).resolves.toMatchObject({
			category: "PROVIDER_ERROR",
			reason: "unknown_tool_error",
			httpStatus: null,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("classifies malformed JSON and timeouts without retries", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: "not-json",
										annotations: [],
									},
								],
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockRejectedValueOnce(new Error("This operation was aborted"));
		await expect(
			fallbackError({ provider: "OPENAI", model: "gpt-5.5" }),
		).resolves.toMatchObject({
			category: "MALFORMED_RESPONSE",
			httpStatus: null,
		});
		await expect(
			fallbackError({ provider: "OPENAI", model: "gpt-5.5" }),
		).resolves.toMatchObject({
			category: "TIMEOUT",
			httpStatus: null,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("does not silently replace an unsupported configured Gemini model", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(
			fallbackError({
				provider: "GEMINI",
				model: "gemini-2.5-flash",
			}),
		).resolves.toMatchObject({
			category: "UNSUPPORTED",
			httpStatus: null,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

async function fallbackError(input: {
	provider: PeopleSearchFallbackProvider;
	model: string;
}): Promise<PeopleSearchFallbackError> {
	try {
		await discoverWithPeopleSearchFallback({
			provider: input.provider,
			apiKey: "user-key",
			model: input.model,
			criteria,
			count: 1,
		});
		throw new Error("Expected people-search fallback to fail.");
	} catch (error) {
		expect(error).toBeInstanceOf(PeopleSearchFallbackError);
		return error as PeopleSearchFallbackError;
	}
}
