import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discoverWithPeopleSearchFallback,
	UnsupportedPeopleSearchModelError,
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
		model: "claude-sonnet-4-6",
		endpoint: "https://api.anthropic.com/v1/messages",
		discoveryProvider: "ANTHROPIC_GROUNDED",
	},
];

function groundedResponse(
	provider: PeopleSearchFallbackProvider,
	input: { people: unknown[]; citations?: string[] },
): Response {
	const text = JSON.stringify({ people: input.people });
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
		];
		for (const testCase of providerCases) {
			for (const candidate of candidates) {
				fetchSpy.mockResolvedValueOnce(
					groundedResponse(testCase.provider, {
						people: [candidate.person],
						citations: candidate.citations,
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
					returned: 1,
					accepted: 0,
					people: [],
				});
			}
		}
	});

	it("surfaces malformed output, provider errors, and Anthropic tool errors without retries", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(groundedResponse("OPENAI", { people: [] }))
			.mockResolvedValueOnce(
				new Response("provider rejected the web-search tool", {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: [
							{
								type: "web_search_tool_result",
								content: {
									type: "web_search_tool_result_error",
									error_code: "unavailable",
								},
							},
						],
					}),
					{ status: 200 },
				),
			);
		await expect(
			discoverWithPeopleSearchFallback({
				provider: "OPENAI",
				apiKey: "user-key",
				model: "gpt-5.5",
				criteria,
				count: 1,
			}),
		).resolves.toMatchObject({ returned: 0, accepted: 0 });
		await expect(
			discoverWithPeopleSearchFallback({
				provider: "OPENAI",
				apiKey: "user-key",
				model: "gpt-5.5",
				criteria,
				count: 1,
			}),
		).rejects.toThrow(/HTTP 400/i);
		await expect(
			discoverWithPeopleSearchFallback({
				provider: "ANTHROPIC",
				apiKey: "user-key",
				model: "claude-sonnet-4-6",
				criteria,
				count: 1,
			}),
		).rejects.toThrow(/unavailable/i);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("surfaces malformed JSON and timeouts without retries", async () => {
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
		for (let index = 0; index < 2; index += 1) {
			await expect(
				discoverWithPeopleSearchFallback({
					provider: "OPENAI",
					apiKey: "user-key",
					model: "gpt-5.5",
					criteria,
					count: 1,
				}),
			).rejects.toThrow();
		}
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("does not silently replace an unsupported configured Gemini model", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(
			discoverWithPeopleSearchFallback({
				provider: "GEMINI",
				apiKey: "user-key",
				model: "gemini-2.5-flash",
				criteria,
				count: 1,
			}),
		).rejects.toBeInstanceOf(UnsupportedPeopleSearchModelError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
