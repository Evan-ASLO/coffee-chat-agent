import {
	createExecutionContext,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import {
	decryptBytes,
	decryptCredential,
	encryptBytes,
	encryptCredential,
	openPayload,
	sealPayload,
} from "../src/lib/crypto";
import { decodeUtf8, fromBase64Url, toBase64, utf8 } from "../src/lib/encoding";
import type { AppBindings } from "../src/types";
import {
	parseResumeProfile,
	questionTopic,
	recipientObservation,
	templateDraft,
} from "../src/lib/providers";
import type { Prospect, UserSettings } from "../src/lib/store";
import { publicError } from "../src/lib/http";
import { ClientInputError } from "../src/lib/errors";
import { encodeMimeMessage } from "../src/lib/google";
import {
	extractResumeText,
	getResumeStatus,
	importResume,
	readResumeAttachment,
} from "../src/lib/resume";
import { saveCredential } from "../src/lib/credentials";
import { createSession, upsertUser } from "../src/lib/db";
import { insertProspects } from "../src/lib/store";
import { acceptVerifiedGoogleLogin } from "../src/lib/auth";
import {
	hmacSha256Hex,
	sha256Hex,
	snapshotHash,
	type NormalizedJob,
} from "../src/lib/jobs";
import { sha256 } from "../src/lib/encoding";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";

let ingestRequestCounter = 0;

beforeAll(async () => {
	const statements = JSON.parse(
		(env as typeof env & { MIGRATION_STATEMENTS: string })
			.MIGRATION_STATEMENTS,
	) as string[];
	await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
});

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request in Worker tests."));
});
afterEach(() => vi.restoreAllMocks());

describe("security boundaries", () => {
	it("returns no authenticated data without a valid session", async () => {
		const response = await SELF.fetch("http://example.com/api/session");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authenticated: false,
			betaAccessMode: "OPEN",
		});
	});

	it("adds restrictive security headers", async () => {
		const response = await SELF.fetch("http://example.com/api/health");
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Security-Policy")).toContain(
			"default-src 'self'",
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("rejects protected routes without authentication", async () => {
		const request = new Request(
			"http://example.com/api/workspace/init",
			{
				method: "POST",
				headers: { Origin: "http://example.com" },
			},
		);
		const response = await SELF.fetch(request);
		expect(response.status).toBe(401);
	});

	it("encrypts credentials with user-bound associated data", async () => {
		const mockEnv = encryptionEnv();
		const encrypted = await encryptCredential(
			mockEnv,
			"user-a",
			"API_KEY",
			"GEMINI",
			"secret-api-key",
		);
		await expect(
			decryptCredential(
				mockEnv,
				"user-a",
				"API_KEY",
				"GEMINI",
				encrypted,
			),
		).resolves.toBe("secret-api-key");
		await expect(
			decryptCredential(
				mockEnv,
				"user-b",
				"API_KEY",
				"GEMINI",
				encrypted,
			),
		).rejects.toThrow();
	});

	it("encrypts resume bytes with user-bound associated data", async () => {
		const mockEnv = encryptionEnv();
		const plaintext = utf8("private resume contents");
		const encrypted = await encryptBytes(
			mockEnv,
			"user-a",
			"RESUME",
			plaintext,
		);
		await expect(
			decryptBytes(mockEnv, "user-a", "RESUME", encrypted),
		).resolves.toEqual(plaintext);
		await expect(
			decryptBytes(mockEnv, "user-b", "RESUME", encrypted),
		).rejects.toThrow();
	});

	it("seals OAuth state so it cannot be modified", async () => {
		const mockEnv = encryptionEnv();
		const sealed = await sealPayload(mockEnv, "oauth", {
			state: "abc",
			createdAt: 1,
		});
		await expect(
			openPayload<{ state: string }>(mockEnv, "oauth", sealed),
		).resolves.toEqual({ state: "abc", createdAt: 1 });
		const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
		await expect(
			openPayload(mockEnv, "oauth", tampered),
		).rejects.toThrow();
	});

	it("builds complete recipient-focused template sentences", () => {
		const prospect = {
			firstName: "Abhay",
			fullName: "Abhay Example",
			title: "",
			company: "",
			sourceSnippet:
				"the industry they are building in. At Golden Ventures, someone pointed to…",
			whyRelevant:
				"Matched industry: Venture Capital; Matched location: Toronto",
			outreachObjective: "",
		} as Prospect;
		const settings = {
			senderName: "Evan",
			outreachGoal: "Learn from the recipient's professional experience.",
			emailWordLimit: 140,
			personalContext: [
				{
					category: "Experience to reference",
					content: "I am exploring venture capital through finance coursework.",
				},
			],
		} as UserSettings;
		expect(recipientObservation(prospect)).toBe(
			"Your venture capital experience in Toronto caught my attention.",
		);
		expect(questionTopic(prospect, settings)).toBe(
			"your path into venture capital and the work you do today",
		);
		const draft = templateDraft(prospect, settings);
		expect(draft.body).not.toContain("Different…");
		expect(draft.body).toContain("Best,\nEvan");
	});

	it("does not misclassify validation metadata as an origin attack", () => {
		const schema = z.object({
			senderName: z.string().min(1, "Enter your sender name."),
		});
		const result = schema.safeParse({ senderName: "" });
		if (result.success) throw new Error("Expected validation to fail.");
		expect(publicError(result.error)).toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
			message: "Enter your sender name.",
		});
		expect(publicError(new Error("Request origin is not allowed."))).toMatchObject({
			code: "FORBIDDEN",
			status: 403,
		});
	});

	it("returns actionable profile-readiness errors without exposing unknown failures", () => {
		expect(
			publicError(
				new ClientInputError(
					"Add at least one factual background, goal, experience, or interest before preparing drafts.",
				),
			),
		).toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
			message:
				"Add at least one factual background, goal, experience, or interest before preparing drafts.",
		});
		expect(publicError(new Error("Private provider failure."))).toMatchObject({
			code: "INTERNAL_ERROR",
			status: 500,
			message: "The operation could not be completed.",
		});
	});

	it("extracts readable text from DOCX resumes", () => {
		const docx = zipSync({
			"word/document.xml": strToU8(
				'<w:document><w:body><w:p><w:r><w:t>Evan Lowe</w:t></w:r></w:p><w:p><w:r><w:t>Finance student &amp; investment analyst with project leadership experience.</w:t></w:r></w:p></w:body></w:document>',
			),
		});
		expect(
			extractResumeText(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				docx,
			),
		).toBe(
			"Evan Lowe\nFinance student & investment analyst with project leadership experience.",
		);
	});

	it("parses factual resume profile suggestions", () => {
		expect(
			parseResumeProfile(
				'{"senderName":"Evan Lowe","backgroundSummary":"Finance student with investment research experience.","currentGoal":"","experienceToReference":"Built valuation models and led a student investment project."}',
			),
		).toEqual({
			senderName: "Evan Lowe",
			backgroundSummary: "Finance student with investment research experience.",
			currentGoal: "",
			experienceToReference:
				"Built valuation models and led a student investment project.",
		});
	});

	it("builds a Gmail MIME message with an optional resume attachment", () => {
		const raw = encodeMimeMessage({
			to: "recipient@example.com",
			subject: "Coffee chat",
			body: "Hello there.",
			senderName: "Evan Lowe",
			attachment: {
				fileName: "Evan-Lowe-Resume.pdf",
				mimeType: "application/pdf",
				data: utf8("resume bytes"),
			},
		});
		const mime = decodeUtf8(fromBase64Url(raw));
		expect(mime).toContain("Content-Type: multipart/mixed");
		expect(mime).toContain(
			'Content-Disposition: attachment; filename="Evan-Lowe-Resume.pdf"',
		);
		expect(mime).toContain(toBase64(utf8("resume bytes")));
	});

	it("stores an analyzed resume encrypted and reads it back for attachment", async () => {
		const mockEnv = env as unknown as AppBindings;
		const user = await upsertUser(mockEnv, {
			googleSub: "resume-test-user",
			email: "resume-test@example.com",
			name: "Resume Test",
			image: "",
		});
		await saveCredential(mockEnv, {
			userId: user.id,
			provider: "GEMINI",
			value: "test-gemini-key",
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					output_text:
						'{"senderName":"Resume Test","backgroundSummary":"Finance student with investment research experience.","currentGoal":"","experienceToReference":"Built valuation models and led a student investment project."}',
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		const contents =
			"Resume Test\nFinance student with investment research experience. Built valuation models and led a student investment project.";
		const result = await importResume(
			mockEnv,
			user.id,
			new File([contents], "Resume Test.txt", { type: "text/plain" }),
		);
		expect(result.suggestions.provider).toBe("GEMINI");
		expect(result.resume).toMatchObject({
			configured: true,
			fileName: "Resume Test.txt",
			mimeType: "text/plain",
			sizeBytes: contents.length,
		});
		await expect(getResumeStatus(mockEnv, user.id)).resolves.toMatchObject({
			configured: true,
			fileName: "Resume Test.txt",
		});
		const attachment = await readResumeAttachment(mockEnv, user.id);
		expect(attachment?.fileName).toBe("Resume Test.txt");
		expect(decodeUtf8(attachment?.data || new Uint8Array())).toBe(contents);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://generativelanguage.googleapis.com/v1beta/interactions",
			expect.objectContaining({ method: "POST" }),
		);
		fetchSpy.mockRestore();
	});
});

describe("worker export", () => {
	it("supports unit-style requests", async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			"http://example.com/api/health",
		);
		const context = createExecutionContext();
		const response = await worker.fetch(request, env, context);
		await waitOnExecutionContext(context);
		expect(response.status).toBe(200);
	});
});

describe("people-search fallback provider selection", () => {
	it("defaults to NONE and persists independently per user", async () => {
		const userA = await authenticatedTestUser("fallback-provider-a");
		const userB = await authenticatedTestUser("fallback-provider-b");
		const initial = (await (
			await authenticatedFetch(userA, "/api/session")
		).json()) as {
			settings: { peopleSearchFallbackProvider: string };
		};
		expect(initial.settings.peopleSearchFallbackProvider).toBe("NONE");

		const settingsInput = {
			senderName: "Fallback Provider A",
			discoveryProvider: "TAVILY",
			enrichmentProvider: "NONE",
			draftProvider: "TEMPLATE",
			geminiModel: "gemini-3.8-flash",
			openAiModel: "gpt-5-mini",
			anthropicModel: "claude-haiku-4-5",
			peopleSearchFallbackProvider: "OPENAI",
			outreachGoal: "Learn about professional experience.",
			emailWordLimit: 140,
			personalContext: [
				{
					category: "Background summary",
					content: "Test-only public context.",
				},
			],
			replySyncEnabled: true,
		};
		const updated = await authenticatedFetch(userA, "/api/settings", {
			method: "PUT",
			body: settingsInput,
		});
		expect(updated.status).toBe(200);
		const {
			peopleSearchFallbackProvider: _omittedForLegacyClient,
			...legacySettingsInput
		} = settingsInput;
		expect(_omittedForLegacyClient).toBe("OPENAI");
		const legacyUpdate = await authenticatedFetch(
			userA,
			"/api/settings",
			{
				method: "PUT",
				body: legacySettingsInput,
			},
		);
		expect(legacyUpdate.status).toBe(200);
		const [sessionA, sessionB] = await Promise.all([
			authenticatedFetch(userA, "/api/session").then((response) =>
				response.json(),
			),
			authenticatedFetch(userB, "/api/session").then((response) =>
				response.json(),
			),
		]);
		expect(sessionA).toMatchObject({
			settings: { peopleSearchFallbackProvider: "OPENAI" },
		});
		expect(sessionB).toMatchObject({
			settings: { peopleSearchFallbackProvider: "NONE" },
		});
	});

	it.each([
		{ name: "capped cited partial", code: "max_uses_exceeded", output: true, tavily: 1, http: 200, status: "SEARCH_LIMITED" },
		{ name: "capped missing output", code: "max_uses_exceeded", output: false, tavily: 1, http: 200, status: "SEARCH_LIMITED" },
		{ name: "capped empty failure", code: "max_uses_exceeded", output: false, tavily: 0, http: 200, status: "SEARCH_LIMITED" },
		{ name: "invalid tool input", code: "invalid_tool_input", output: true, tavily: 1, http: 200, status: "BAD_REQUEST" },
		{ name: "unknown tool error", code: "PRIVATE PROMPT SECRET-DO-NOT-STORE", output: true, tavily: 1, http: 200, status: "PROVIDER_ERROR" },
		{ name: "HTTP 400", code: null, output: false, tavily: 1, http: 400, status: "BAD_REQUEST" },
		{ name: "HTTP 422", code: null, output: false, tavily: 1, http: 422, status: "BAD_REQUEST" },
	])("preserves Tavily and safe Anthropic diagnostics for $name", async (testCase) => {
		const auth = await authenticatedTestUser("anthropic-diagnostics");
		const bindings = env as unknown as AppBindings;
		await saveCredential(bindings, {
			userId: auth.user.id, provider: "TAVILY", value: "test-tavily-diagnostics-key",
		});
		await saveCredential(bindings, {
			userId: auth.user.id, provider: "ANTHROPIC", value: "test-anthropic-diagnostics-key",
		});
		await env.DB.prepare(
			"UPDATE user_settings SET people_search_fallback_provider = 'ANTHROPIC', anthropic_model = 'claude-haiku-4-5' WHERE user_id = ?",
		).bind(auth.user.id).run();
		const tavilyUrl = "https://www.linkedin.com/in/tavily-diagnostics";
		const candidates = [
			{
				fullName: "Tavily Example", title: "Investment Analyst",
				company: "BMO Financial Group", location: "Toronto", sourceUrl: tavilyUrl,
				evidence: "Tavily Example is an Investment Analyst at BMO Financial Group in Toronto.",
			},
			{
				fullName: "Alexander Spark", title: "Managing Director",
				company: "BMO Financial Group", location: "Toronto",
				sourceUrl: "https://privatewealth.bmo.com/en/people/alexander-spark",
				evidence: "Alexander Spark is a Managing Director at BMO Financial Group in Toronto.",
			},
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected outbound request in discovery test."))
			.mockResolvedValueOnce(Response.json({
				results: testCase.tavily ? [{
					title: "Tavily Example - Investment Analyst - BMO | LinkedIn",
					url: tavilyUrl,
					content: candidates[0]!.evidence,
				}] : [],
			}))
			.mockResolvedValueOnce(Response.json({ results: [] }))
			.mockResolvedValueOnce(Response.json({
				content: [
					{
						type: "text",
						text: testCase.output ? JSON.stringify({ people: candidates }) : "",
						citations: candidates.map(({ sourceUrl }) => ({
							type: "web_search_result_location", url: sourceUrl,
						})),
					},
					{
						type: "web_search_tool_result",
						content: {
							type: "web_search_tool_result_error",
							error_code: testCase.code,
							message: "PRIVATE PROMPT https://private.example SECRET-DO-NOT-STORE",
						},
					},
				],
			}, { status: testCase.http }));
		try {
			const criteria = {
				roles: ["Investment Analyst"], companies: ["BMO Financial Group"],
				locations: ["Toronto"], industries: [], keywords: [], seniority: [],
				objective: "PRIVATE USER OBJECTIVE", count: 3,
			};
			const tavily = await authenticatedWorkerFetch(auth, "/api/discovery", {
				method: "POST", body: criteria,
			}, bindings);
			expect(tavily.status).toBe(200);
			expect(await tavily.json()).toMatchObject({ summary: {
				mode: "TAVILY", inserted: testCase.tavily, fallbackAttempted: false,
				fallbackStatus: "NOT_REQUESTED",
			} });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			const response = await authenticatedWorkerFetch(auth, "/api/discovery", {
				method: "POST", body: { ...criteria, mode: "AI_SUPPLEMENT" },
			}, bindings);
			expect(response.status).toBe(200);
			const payload = await response.json() as {
				prospects: Array<{ fullName: string; discoveryProvider: string; status: string }>;
				summary: Record<string, unknown>;
			};
			const partial = testCase.output && testCase.code === "max_uses_exceeded";
			const reason = testCase.status === "PROVIDER_ERROR" ? "unknown_tool_error" : testCase.code;
			expect(payload.summary).toMatchObject({
				mode: "AI_SUPPLEMENT", tavilyAttempted: false,
				fallbackProvider: "ANTHROPIC", fallbackAttempted: true,
				fallbackModel: "claude-haiku-4-5", fallbackStatus: testCase.status,
				fallbackReason: reason, fallbackHttpStatus: testCase.http === 200 ? null : testCase.http,
				primaryAccepted: 0,
				fallbackReturned: partial ? 2 : 0,
				fallbackAccepted: partial ? 2 : 0,
				inserted: partial ? 1 : 0,
				duplicates: partial ? 1 : 0,
			});
			expect(payload.prospects.map((person) => person.discoveryProvider)).toEqual([
				...(partial ? ["ANTHROPIC_GROUNDED"] : []),
			]);
			const saved = await authenticatedWorkerFetch(auth, "/api/prospects", {}, bindings);
			expect(await saved.json()).toMatchObject({ prospects: expect.arrayContaining([
				...(testCase.tavily ? [expect.objectContaining({ fullName: "Tavily Example", discoveryProvider: "TAVILY" })] : []),
			]) });
			expect(payload.prospects.every((person) => person.status === "DISCOVERED")).toBe(true);
			const auditRow = await env.DB.prepare(
				"SELECT metadata_json FROM audit_events WHERE user_id = ? AND action = 'DISCOVERY_COMPLETED' ORDER BY created_at DESC LIMIT 1",
			).bind(auth.user.id).first<{ metadata_json: string }>();
			expect(JSON.parse(auditRow!.metadata_json)).toEqual(payload.summary);
			expect(auditRow!.metadata_json).not.toMatch(
				/PRIVATE|SECRET-DO-NOT-STORE|diagnostics-key|Tavily Example|Alexander Spark|https:\/\//,
			);
			expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
				"https://api.tavily.com/search", "https://api.tavily.com/search",
				"https://api.anthropic.com/v1/messages",
			]);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe.sequential("approved-email beta access", () => {
	const allowlistEnv = {
		...(env as unknown as AppBindings),
		BETA_ACCESS_MODE: "ALLOWLIST",
		BETA_ADMIN_EMAILS: " Owner@Example.com , SECOND-OWNER@example.com ",
	};
	const requestedProfile = {
		googleSub: `requested-${crypto.randomUUID()}`,
		email: "Candidate.User@Example.com",
		name: "Candidate User",
		image: "",
	};
	let requestId = "";
	let adminUser: Awaited<ReturnType<typeof upsertUser>>;
	let adminAuth: Awaited<ReturnType<typeof authenticatedSessionForUser>>;
	let approvedUser: Awaited<ReturnType<typeof upsertUser>>;
	let approvedAuth: Awaited<ReturnType<typeof authenticatedSessionForUser>>;

	it("keeps OPEN mode backward compatible", async () => {
		const profile = {
			googleSub: `open-${crypto.randomUUID()}`,
			email: "Open.User@Example.com",
			name: "Open User",
			image: "",
		};
		const user = await acceptVerifiedGoogleLogin(
			env as unknown as AppBindings,
			profile,
		);
		expect(user).toMatchObject({ email: "open.user@example.com" });
		const stored = await env.DB.prepare(
			"SELECT email FROM users WHERE google_sub = ?",
		)
			.bind(profile.googleSub)
			.first<{ email: string }>();
		expect(stored?.email).toBe("open.user@example.com");
		const jobs = await SELF.fetch("http://example.com/api/jobs?pageSize=1");
		expect(jobs.status).toBe(200);
	});

	it("creates one neutral pending request without a user or session", async () => {
		const requestStart = await workerRequest(
			allowlistEnv,
			"/auth/google/request",
		{ method: "GET" },
		);
		expect(requestStart.status).toBe(302);
		expect(requestStart.headers.get("Location")).toContain(
			"accounts.google.com/o/oauth2",
		);

		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, requestedProfile),
		).resolves.toBeNull();
		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, {
				...requestedProfile,
				email: requestedProfile.email.toUpperCase(),
			}),
		).resolves.toBeNull();

		const requests = await env.DB.prepare(
			`SELECT id, email, status FROM beta_access_requests
			  WHERE google_sub = ? ORDER BY requested_at`,
		)
			.bind(requestedProfile.googleSub)
			.all<{ id: string; email: string; status: string }>();
		expect(requests.results).toHaveLength(1);
		expect(requests.results[0]).toMatchObject({
			email: "candidate.user@example.com",
			status: "PENDING",
		});
		requestId = requests.results[0]!.id;
		const normalUser = await env.DB.prepare(
			"SELECT id FROM users WHERE google_sub = ?",
		)
			.bind(requestedProfile.googleSub)
			.first<{ id: string }>();
		expect(normalUser).toBeNull();
		const sessions = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM sessions s
			  JOIN users u ON u.id = s.user_id
			  WHERE u.google_sub = ?`,
		)
			.bind(requestedProfile.googleSub)
			.first<{ count: number }>();
		expect(sessions?.count).toBe(0);

		const session = await workerRequest(allowlistEnv, "/api/session");
		expect(await session.json()).toEqual({
			authenticated: false,
			betaAccessMode: "ALLOWLIST",
		});
		const jobs = await workerRequest(
			allowlistEnv,
			"/api/jobs?pageSize=1",
		);
		expect(jobs.status).toBe(401);
		expect(await jobs.json()).toMatchObject({
			error: "BETA_ACCESS_REQUIRED",
		});
	});

	it("allows normalized environment admins without a D1 allowlist row", async () => {
		adminUser = (await acceptVerifiedGoogleLogin(allowlistEnv, {
			googleSub: `owner-${crypto.randomUUID()}`,
			email: "OWNER@example.com",
			name: "Owner",
			image: "",
		}))!;
		expect(adminUser.email).toBe("owner@example.com");
		const access = await env.DB.prepare(
			"SELECT email FROM beta_access WHERE email = ?",
		)
			.bind(adminUser.email)
			.first<{ email: string }>();
		expect(access).toBeNull();
		adminAuth = await authenticatedSessionForUser(adminUser, allowlistEnv);
		const session = await authenticatedWorkerFetch(
			adminAuth,
			"/api/session",
			{},
			allowlistEnv,
		);
		expect(await session.json()).toMatchObject({
			authenticated: true,
			betaAccessMode: "ALLOWLIST",
			isBetaAdmin: true,
			user: { email: "owner@example.com" },
		});
	});

	it("approves, revokes, and re-approves while enforcing admin authorization", async () => {
		const pending = await authenticatedWorkerFetch(
			adminAuth,
			"/api/beta/admin/access",
			{},
			allowlistEnv,
		);
		expect(pending.status).toBe(200);
		expect(await pending.json()).toMatchObject({
			requests: [
				expect.objectContaining({
					id: requestId,
					email: "candidate.user@example.com",
					status: "PENDING",
				}),
			],
		});

		const approved = await authenticatedWorkerFetch(
			adminAuth,
			`/api/beta/admin/requests/${requestId}/approve`,
			{ method: "POST" },
			allowlistEnv,
		);
		expect(approved.status).toBe(200);
		const approvedRequest = await env.DB.prepare(
			"SELECT google_sub, status FROM beta_access_requests WHERE id = ?",
		)
			.bind(requestId)
			.first<{ google_sub: string; status: string }>();
		expect(approvedRequest).toEqual({
			google_sub: "",
			status: "APPROVED",
		});
		approvedUser = (await acceptVerifiedGoogleLogin(
			allowlistEnv,
			requestedProfile,
		))!;
		expect(approvedUser.email).toBe("candidate.user@example.com");
		approvedAuth = await authenticatedSessionForUser(
			approvedUser,
			allowlistEnv,
		);
		const approvedJobs = await authenticatedWorkerFetch(
			approvedAuth,
			"/api/jobs?pageSize=1",
			{},
			allowlistEnv,
		);
		expect(approvedJobs.status).toBe(200);

		const nonAdmin = await authenticatedWorkerFetch(
			approvedAuth,
			"/api/beta/admin/access",
			{},
			allowlistEnv,
		);
		expect(nonAdmin.status).toBe(403);
		const nonAdminSession = await authenticatedWorkerFetch(
			approvedAuth,
			"/api/session",
			{},
			allowlistEnv,
		);
		expect(await nonAdminSession.json()).toMatchObject({
			authenticated: true,
			isBetaAdmin: false,
		});

		const revoked = await authenticatedWorkerFetch(
			adminAuth,
			"/api/beta/admin/access/revoke",
			{
				method: "POST",
				body: { email: requestedProfile.email.toUpperCase() },
			},
			allowlistEnv,
		);
		expect(revoked.status).toBe(200);
		const revokedSession = await authenticatedWorkerFetch(
			approvedAuth,
			"/api/session",
			{},
			allowlistEnv,
		);
		expect(await revokedSession.json()).toEqual({
			authenticated: false,
			betaAccessMode: "ALLOWLIST",
		});
		const revokedApi = await authenticatedWorkerFetch(
			approvedAuth,
			"/api/job-states?pageSize=1",
			{},
			allowlistEnv,
		);
		expect(revokedApi.status).toBe(401);
		const staleSession = await authenticatedSessionForUser(
			approvedUser,
			allowlistEnv,
		);
		const revalidated = await authenticatedWorkerFetch(
			staleSession,
			"/api/session",
			{},
			allowlistEnv,
		);
		expect(await revalidated.json()).toEqual({
			authenticated: false,
			betaAccessMode: "ALLOWLIST",
		});

		const reapproved = await authenticatedWorkerFetch(
			adminAuth,
			"/api/beta/admin/access/approve",
			{
				method: "POST",
				body: { email: "Candidate.User@Example.com" },
			},
			allowlistEnv,
		);
		expect(reapproved.status).toBe(200);
		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, requestedProfile),
		).resolves.toMatchObject({
			id: approvedUser.id,
			email: "candidate.user@example.com",
		});
		const newSession = await authenticatedSessionForUser(
			approvedUser,
			allowlistEnv,
		);
		const activeAgain = await authenticatedWorkerFetch(
			newSession,
			"/api/session",
			{},
			allowlistEnv,
		);
		expect(await activeAgain.json()).toMatchObject({ authenticated: true });
		const auditActions = await env.DB.prepare(
			"SELECT action FROM audit_events WHERE user_id = ? ORDER BY created_at",
		)
			.bind(adminUser.id)
			.all<{ action: string }>();
		expect(auditActions.results.map((row) => row.action)).toEqual(
			expect.arrayContaining([
				"BETA_ACCESS_REQUEST_APPROVED",
				"BETA_ACCESS_REVOKED",
				"BETA_ACCESS_APPROVED",
			]),
		);
	});

	it("denies and safely accepts a later verified re-request without enumeration", async () => {
		const profile = {
			googleSub: `denied-${crypto.randomUUID()}`,
			email: "Denied.User@Example.com",
			name: "Denied User",
			image: "",
		};
		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, profile),
		).resolves.toBeNull();
		const firstRequest = await env.DB.prepare(
			`SELECT id FROM beta_access_requests
			  WHERE email = ? AND status = 'PENDING'`,
		)
			.bind("denied.user@example.com")
			.first<{ id: string }>();
		const denied = await authenticatedWorkerFetch(
			adminAuth,
			`/api/beta/admin/requests/${firstRequest!.id}/deny`,
			{ method: "POST" },
			allowlistEnv,
		);
		expect(denied.status).toBe(200);
		const deniedRow = await env.DB.prepare(
			"SELECT google_sub, status FROM beta_access_requests WHERE id = ?",
		)
			.bind(firstRequest!.id)
			.first<{ google_sub: string; status: string }>();
		expect(deniedRow).toEqual({ google_sub: "", status: "DENIED" });

		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, {
				...profile,
				email: profile.email.toUpperCase(),
			}),
		).resolves.toBeNull();
		await expect(
			acceptVerifiedGoogleLogin(allowlistEnv, profile),
		).resolves.toBeNull();
		const statuses = await env.DB.prepare(
			`SELECT status, COUNT(*) AS count FROM beta_access_requests
			  WHERE email = ? GROUP BY status`,
		)
			.bind("denied.user@example.com")
			.all<{ status: string; count: number }>();
		expect(
			Object.fromEntries(
				statuses.results.map((row) => [row.status, row.count]),
			),
		).toMatchObject({ DENIED: 1, PENDING: 1 });
		const noUser = await env.DB.prepare(
			"SELECT id FROM users WHERE google_sub = ?",
		)
			.bind(profile.googleSub)
			.first<{ id: string }>();
		expect(noUser).toBeNull();
		const deniedAudit = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM audit_events
			  WHERE user_id = ? AND action = 'BETA_ACCESS_REQUEST_DENIED'`,
		)
			.bind(adminUser.id)
			.first<{ count: number }>();
		expect(deniedAudit?.count).toBe(1);
	});
});

describe.sequential("internship jobs platform", () => {
	let generatedBase = Date.now() + 60_000;
	let activeJobs: NormalizedJob[] = [];
	let snapshotA: NormalizedJob[] = [];
	let initialImportRunId = "";
	let retryLegacyUser: Awaited<ReturnType<typeof authenticatedTestUser>>;
	let retryLegacyPayload: {
		schemaVersion: 1;
		exportedAt: string;
		source: "internship-tracker-toronto";
		savedJobs: Array<{ url: string | null; company: string; title: string }>;
		applications: [];
	};
	let userA: Awaited<ReturnType<typeof authenticatedTestUser>>;
	let userB: Awaited<ReturnType<typeof authenticatedTestUser>>;

	it("matches the cross-language canonical snapshot hash contract", async () => {
		const job: NormalizedJob = {
			id: "5dd6b55988728fb5fdd68f3dda7e793db7ff849dd281416b71dae0ee3ce84149",
			externalId: "JR-12345",
			source: "workday",
			company: "Example Company",
			title: "Summer Finance Intern",
			location: "Toronto, ON",
			region: "Canada",
			categories: ["Finance", "Internship"],
			url: "https://jobs.example.com/JR-12345",
			postedAt: "2026-09-30T12:00:00.000Z",
			postedText: "Posted yesterday",
			description: "Support the finance team with analysis and reporting.",
		};
		await expect(snapshotHash([job])).resolves.toBe(
			"9d959e98a633ce986158a480be7e7b9d1dfa62c332d86e87f7d047dac4a66954",
		);
	});

	it("rejects invalid ingestion authentication", async () => {
		const job = await testJob("invalid-auth");
		const body = await snapshotBody([job], generatedBase);
		const response = await SELF.fetch(
			new Request("http://example.com/api/internal/jobs/snapshot", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Ingest-Timestamp": String(Math.floor(Date.now() / 1000)),
					"X-Ingest-Signature": "0".repeat(64),
				},
				body,
			}),
		);
		expect(response.status).toBe(401);
	});

	it("rate limits ingest before reading or authenticating the body", async () => {
		const limit = vi.fn().mockResolvedValue({ success: false });
		const request = new Request<unknown, IncomingRequestCfProperties>(
			"http://example.com/api/internal/jobs/snapshot",
			{
				method: "POST",
				headers: {
					"CF-Connecting-IP": "203.0.113.10",
					"Content-Type": "application/json",
				},
				body: "not signed json",
			},
		);
		const context = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...(env as unknown as AppBindings),
				JOBS_INGEST_RATE_LIMITER: { limit },
			},
			context,
		);
		await waitOnExecutionContext(context);
		expect(response.status).toBe(429);
		expect(limit).toHaveBeenCalledWith({ key: "203.0.113.10" });
	});

	it("rejects strict schema violations with a valid signature", async () => {
		const job = await testJob("invalid-schema");
		const payload = {
			schemaVersion: 1,
			generatedAt: new Date(generatedBase).toISOString(),
			snapshotHash: await snapshotHash([job]),
			jobs: [{ ...job, unknownField: true }],
		};
		const response = await signedIngest(JSON.stringify(payload));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST" });
	});

	it("enforces snapshot byte and job-count limits", async () => {
		const oversizedBody = JSON.stringify({
			padding: "x".repeat(2 * 1024 * 1024),
		});
		const oversized = await signedIngest(oversizedBody);
		expect(oversized.status).toBe(413);

		const base = await testJob("count-limit");
		const tooManyJobs = Array.from({ length: 1001 }, (_, index) => ({
			...base,
			id: index.toString(16).padStart(64, "0"),
			externalId: `count-${index}`,
			url: `https://jobs.example.com/count-${index}`,
		}));
		const tooMany = await signedIngest(
			JSON.stringify({
				schemaVersion: 1,
				generatedAt: new Date(generatedBase).toISOString(),
				snapshotHash: "0".repeat(64),
				jobs: tooManyJobs,
			}),
		);
		expect(tooMany.status).toBe(400);
	});

	it("reports a never-imported catalog and keeps job outreach linking disabled by default", async () => {
		const response = await SELF.fetch("http://example.com/api/jobs?pageSize=10");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			jobs: [],
			catalog: {
				state: "never-imported",
				generatedAt: null,
				importedAt: null,
				ageSeconds: null,
				staleAfterSeconds: 7200,
			},
			features: { jobOutreachLinking: false },
		});
	});

	it("does not consume the legacy import lock when the catalog has no matches", async () => {
		snapshotA = [await testJob("alpha"), await testJob("beta")];
		retryLegacyUser = await authenticatedTestUser("legacy-retry-user");
		retryLegacyPayload = {
			schemaVersion: 1,
			exportedAt: new Date().toISOString(),
			source: "internship-tracker-toronto",
			savedJobs: [
				{
					url: snapshotA[0]!.url,
					company: snapshotA[0]!.company,
					title: snapshotA[0]!.title,
				},
			],
			applications: [],
		};
		const response = await authenticatedFetch(
			retryLegacyUser,
			"/api/job-states/import-legacy",
			{ method: "POST", body: retryLegacyPayload },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			completed: false,
			idempotent: false,
			imported: 0,
			matched: 0,
			unmatched: 1,
			unmatchedReferences: [
				{
					kind: "saved",
					index: 0,
					url: snapshotA[0]!.url,
					company: snapshotA[0]!.company,
					title: snapshotA[0]!.title,
				},
			],
		});
		const lock = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM user_job_legacy_imports WHERE user_id = ?",
		)
			.bind(retryLegacyUser.user.id)
			.first<{ count: number }>();
		expect(lock?.count).toBe(0);
	});

	it("applies a snapshot, rejects exact replay, and accepts snapshot idempotency", async () => {
		activeJobs = snapshotA;
		const body = await snapshotBody(activeJobs, generatedBase);
		const timestamp = Math.floor(Date.now() / 1000);
		const first = await signedIngest(body, timestamp);
		expect(first.status).toBe(200);
		const firstResult = (await first.json()) as {
			importRunId: string;
			idempotent: boolean;
			activeCount: number;
			upsertedCount: number;
			deactivatedCount: number;
		};
		initialImportRunId = firstResult.importRunId;
		expect(firstResult).toMatchObject({
			idempotent: false,
			activeCount: 2,
			upsertedCount: 2,
			deactivatedCount: 0,
		});

		const replay = await signedIngest(body, timestamp);
		expect(replay.status).toBe(409);
		expect(await replay.json()).toMatchObject({ error: "CONFLICT" });

		const idempotent = await signedIngest(body, timestamp - 1);
		expect(idempotent.status).toBe(200);
		expect(await idempotent.json()).toMatchObject({
			idempotent: true,
			activeCount: 2,
		});
	});

	it("reports fresh and stale catalog metadata without blocking browsing", async () => {
		const freshResponse = await SELF.fetch(
			"http://example.com/api/jobs?pageSize=10",
		);
		expect(freshResponse.status).toBe(200);
		const fresh = (await freshResponse.json()) as {
			jobs: Array<{ id: string }>;
			catalog: {
				state: string;
				generatedAt: string | null;
				importedAt: string | null;
				ageSeconds: number | null;
			};
		};
		expect(fresh.jobs).toHaveLength(2);
		expect(fresh.catalog).toMatchObject({
			state: "fresh",
			generatedAt: new Date(generatedBase).toISOString(),
		});
		expect(fresh.catalog.importedAt).toBeTruthy();
		expect(fresh.catalog.ageSeconds).toBe(0);

		const original = await env.DB.prepare(
			"SELECT generated_at, generated_epoch FROM job_catalog_state WHERE singleton = 1",
		).first<{ generated_at: string; generated_epoch: number }>();
		const staleGeneratedAt = new Date(
			Date.now() - 3 * 60 * 60 * 1000,
		).toISOString();
		await env.DB.prepare(
			`UPDATE job_catalog_state
			    SET generated_at = ?, generated_epoch = ?
			  WHERE singleton = 1`,
		)
			.bind(staleGeneratedAt, Date.parse(staleGeneratedAt))
			.run();
		const staleResponse = await SELF.fetch(
			"http://example.com/api/jobs?pageSize=10",
		);
		expect(staleResponse.status).toBe(200);
		const stale = (await staleResponse.json()) as {
			jobs: Array<{ id: string }>;
			catalog: { state: string; ageSeconds: number };
		};
		expect(stale.jobs).toHaveLength(2);
		expect(stale.catalog.state).toBe("stale");
		expect(stale.catalog.ageSeconds).toBeGreaterThan(2 * 60 * 60);

		const detail = await SELF.fetch(
			`http://example.com/api/jobs/${activeJobs[0]!.id}`,
		);
		expect(detail.status).toBe(200);
		expect(await detail.json()).toMatchObject({
			job: { id: activeJobs[0]!.id },
			catalog: { state: "stale" },
			features: { jobOutreachLinking: false },
		});
		await env.DB.prepare(
			`UPDATE job_catalog_state
			    SET generated_at = ?, generated_epoch = ?
			  WHERE singleton = 1`,
		)
			.bind(original!.generated_at, original!.generated_epoch)
			.run();
	});

	it("keeps future-boundary signatures replay-locked for their full validity", async () => {
		const body = await snapshotBody(activeJobs, generatedBase);
		const nowSeconds = Math.floor(Date.now() / 1000);
		const futureTimestamp = nowSeconds + 300;
		const signature = await ingestSignature(body, futureTimestamp);
		const first = await signedIngest(body, futureTimestamp);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ idempotent: true });

		const replayRow = await env.DB.prepare(
			"SELECT expires_at FROM job_ingest_replays WHERE signature_hash = ?",
		)
			.bind(await sha256Hex(signature))
			.first<{ expires_at: string }>();
		expect(Date.parse(replayRow!.expires_at)).toBe(
			(futureTimestamp + 301) * 1000,
		);
		const replay = await signedIngest(body, futureTimestamp);
		expect(replay.status).toBe(409);

		const beyondFutureBoundary = await signedIngest(body, nowSeconds + 305);
		expect(beyondFutureBoundary.status).toBe(401);
	});

	it("completes a previously zero-match legacy import and makes retries idempotent", async () => {
		const first = await authenticatedFetch(
			retryLegacyUser,
			"/api/job-states/import-legacy",
			{ method: "POST", body: retryLegacyPayload },
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			completed: true,
			idempotent: false,
			imported: 1,
			matched: 1,
			unmatched: 0,
		});
		const retry = await authenticatedFetch(
			retryLegacyUser,
			"/api/job-states/import-legacy",
			{ method: "POST", body: retryLegacyPayload },
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			completed: true,
			idempotent: true,
			imported: 1,
			matched: 1,
			unmatched: 0,
		});
	});

	it("reactivates an A catalog after A to B to A and rejects stale snapshots", async () => {
		generatedBase += 60_000;
		const beta = activeJobs[1]!;
		const gamma = await testJob("gamma");
		activeJobs = [beta, gamma];
		const replacement = await signedIngest(
			await snapshotBody(activeJobs, generatedBase),
		);
		expect(replacement.status).toBe(200);
		expect(await replacement.json()).toMatchObject({
			activeCount: 2,
			deactivatedCount: 1,
		});

		const publicJobs = await SELF.fetch("http://example.com/api/jobs?pageSize=10");
		expect(publicJobs.status).toBe(200);
		const publicPayload = (await publicJobs.json()) as {
			jobs: Array<{ id: string; userState: unknown; outreachSummary: unknown }>;
		};
		expect(publicPayload.jobs.map((job) => job.id).sort()).toEqual(
			activeJobs.map((job) => job.id).sort(),
		);
		expect(publicPayload.jobs[0]).toMatchObject({
			userState: null,
			outreachSummary: null,
		});
		const filtered = (await (
			await SELF.fetch("http://example.com/api/jobs?q=gamma&pageSize=10")
		).json()) as { jobs: Array<{ id: string }> };
		expect(filtered.jobs.map((job) => job.id)).toEqual([gamma.id]);
		const unbounded = await SELF.fetch(
			"http://example.com/api/jobs?pageSize=51",
		);
		expect(unbounded.status).toBe(400);

		generatedBase += 60_000;
		const recovery = await signedIngest(
			await snapshotBody(snapshotA, generatedBase),
		);
		expect(recovery.status).toBe(200);
		const recoveryResult = (await recovery.json()) as {
			importRunId: string;
			snapshotHash: string;
			idempotent: boolean;
			activeCount: number;
			deactivatedCount: number;
		};
		expect(recoveryResult).toMatchObject({
			snapshotHash: await snapshotHash(snapshotA),
			idempotent: false,
			activeCount: 2,
			deactivatedCount: 1,
		});
		expect(recoveryResult.importRunId).not.toBe(initialImportRunId);
		const recoveredRows = await env.DB.prepare(
			"SELECT id, is_active FROM jobs WHERE id IN (?, ?, ?) ORDER BY id",
		)
			.bind(snapshotA[0]!.id, snapshotA[1]!.id, gamma.id)
			.all<{ id: string; is_active: number }>();
		expect(
			Object.fromEntries(
				recoveredRows.results.map((row) => [row.id, row.is_active]),
			),
		).toMatchObject({
			[snapshotA[0]!.id]: 1,
			[snapshotA[1]!.id]: 1,
			[gamma.id]: 0,
		});
		const repeatedHashRuns = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM job_import_runs WHERE snapshot_hash = ?",
		)
			.bind(await snapshotHash(snapshotA))
			.first<{ count: number }>();
		expect(repeatedHashRuns?.count).toBe(2);
		activeJobs = snapshotA;

		const staleJob = await testJob("stale");
		const stale = await signedIngest(
			await snapshotBody([staleJob], generatedBase - 30_000),
		);
		expect(stale.status).toBe(409);
		const afterStale = (await (
			await SELF.fetch("http://example.com/api/jobs?pageSize=10")
		).json()) as { jobs: Array<{ id: string }> };
		expect(afterStale.jobs.map((job) => job.id).sort()).toEqual(
			activeJobs.map((job) => job.id).sort(),
		);
	});

	it("keeps personalized job state private and supports status CRUD", async () => {
		userA = await authenticatedTestUser("jobs-user-a");
		userB = await authenticatedTestUser("jobs-user-b");
		const targetJob = activeJobs[0]!;

		const unauthenticated = await SELF.fetch(
			new Request(`http://example.com/api/jobs/${targetJob.id}/state`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Origin: env.APP_ORIGIN,
				},
				body: JSON.stringify({ status: "SAVED", notes: "" }),
			}),
		);
		expect(unauthenticated.status).toBe(401);

		const saved = await authenticatedFetch(
			userA,
			`/api/jobs/${targetJob.id}/state`,
			{
				method: "PUT",
				body: { status: "SAVED", notes: "Priority role" },
			},
		);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			job: {
				id: targetJob.id,
				userState: { status: "SAVED", notes: "Priority role" },
			},
		});

		const userAJobs = (await (
			await authenticatedFetch(userA, "/api/jobs?pageSize=10")
		).json()) as {
			jobs: Array<{ id: string; userState: { status: string } | null }>;
		};
		expect(
			userAJobs.jobs.find((job) => job.id === targetJob.id)?.userState?.status,
		).toBe("SAVED");

		const userBJobs = (await (
			await authenticatedFetch(userB, "/api/jobs?pageSize=10")
		).json()) as {
			jobs: Array<{ id: string; userState: { status: string } | null }>;
		};
		expect(
			userBJobs.jobs.find((job) => job.id === targetJob.id)?.userState,
		).toBeNull();

		for (const status of [
			"APPLIED",
			"INTERVIEWING",
			"REJECTED",
			"OFFER",
			"ARCHIVED",
		]) {
			const updated = await authenticatedFetch(
				userA,
				`/api/jobs/${targetJob.id}/state`,
				{
					method: "PUT",
					body: { status, notes: `Status ${status}` },
				},
			);
			expect(updated.status).toBe(200);
			expect(await updated.json()).toMatchObject({
				job: { userState: { status } },
			});
		}

		const removed = await authenticatedFetch(
			userA,
			`/api/jobs/${targetJob.id}/state`,
			{ method: "DELETE" },
		);
		expect(removed.status).toBe(200);
		const states = (await (
			await authenticatedFetch(userA, "/api/job-states?pageSize=100")
		).json()) as { jobs: Array<{ id: string }> };
		expect(states.jobs.some((job) => job.id === targetJob.id)).toBe(false);
	});

	it("imports the exact one-time legacy payload by URL and company/title fallback", async () => {
		const legacyUser = await authenticatedTestUser("legacy-jobs-user");
		const [urlMatched, identityMatched] = activeJobs;
		const payload = {
			schemaVersion: 1,
			exportedAt: new Date().toISOString(),
			source: "internship-tracker-toronto",
			savedJobs: [
				{
					url: `${urlMatched!.url}?utm_source=legacy`,
					company: "Ignored URL company",
					title: "Ignored URL title",
				},
			],
			applications: [
				{
					url: null,
					company: identityMatched!.company.toUpperCase(),
					title: identityMatched!.title.toUpperCase(),
					status: "interview",
				},
			],
		};
		const existingState = await authenticatedFetch(
			legacyUser,
			`/api/jobs/${urlMatched!.id}/state`,
			{
				method: "PUT",
				body: { status: "OFFER", notes: "Preserve this server state" },
			},
		);
		expect(existingState.status).toBe(200);
		const response = await authenticatedFetch(
			legacyUser,
			"/api/job-states/import-legacy",
			{
				method: "POST",
				body: payload,
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			completed: true,
			idempotent: false,
			imported: 1,
			matched: 2,
			unmatched: 0,
			skippedExisting: 1,
		});

		const imported = (await (
			await authenticatedFetch(legacyUser, "/api/job-states?pageSize=100")
		).json()) as {
			jobs: Array<{ id: string; userState: { status: string } }>;
		};
		expect(
			imported.jobs.find((job) => job.id === urlMatched!.id)?.userState.status,
		).toBe("OFFER");
		expect(
			imported.jobs.find((job) => job.id === identityMatched!.id)?.userState
				.status,
		).toBe("INTERVIEWING");

		const idempotent = await authenticatedFetch(
			legacyUser,
			"/api/job-states/import-legacy",
			{ method: "POST", body: payload },
		);
		expect(idempotent.status).toBe(200);
		expect(await idempotent.json()).toMatchObject({
			completed: true,
			idempotent: true,
			imported: 1,
			matched: 2,
			skippedExisting: 1,
		});

		const repeated = await authenticatedFetch(
			legacyUser,
			"/api/job-states/import-legacy",
			{
				method: "POST",
				body: {
					schemaVersion: 1,
					exportedAt: new Date().toISOString(),
					source: "internship-tracker-toronto",
					savedJobs: [],
					applications: [],
				},
			},
		);
		expect(repeated.status).toBe(409);
	});

	it("links only owned prospects to jobs and exposes authenticated outreach summaries", async () => {
		const disabledDiscovery = await authenticatedFetch(
			userA,
			"/api/discovery",
			{
				method: "POST",
				body: {
					roles: ["Recruiter"],
					industries: [],
					companies: [],
					locations: [],
					keywords: [],
					seniority: [],
					objective: "",
					count: 1,
					jobId: activeJobs[0]!.id,
				},
			},
		);
		expect(disabledDiscovery.status).toBe(403);
		expect(await disabledDiscovery.json()).toMatchObject({
			error: "FEATURE_DISABLED",
		});

		const [prospectA] = await insertProspects(env as unknown as AppBindings, userA.user.id, [
			testProspect("Owned Prospect", activeJobs[0]!.company),
		]);
		const [prospectB] = await insertProspects(env as unknown as AppBindings, userB.user.id, [
			testProspect("Other Prospect", activeJobs[0]!.company),
		]);
		const [broaderProspect] = await insertProspects(
			env as unknown as AppBindings,
			userA.user.id,
			[
				{
					...testProspect(
						"Broader Prospect",
						activeJobs[0]!.company,
					),
					matchQuality: "BROADER_COMPANY",
				},
			],
		);
		expect(prospectA).toBeTruthy();
		expect(prospectB).toBeTruthy();
		expect(broaderProspect?.matchQuality).toBe("BROADER_COMPANY");

		const disabledLink = await authenticatedFetch(
			userA,
			`/api/jobs/${activeJobs[0]!.id}/prospects/${prospectA!.id}`,
			{ method: "POST" },
		);
		expect(disabledLink.status).toBe(403);
		expect(await disabledLink.json()).toMatchObject({
			error: "FEATURE_DISABLED",
		});

		const enabledEnv = {
			...(env as unknown as AppBindings),
			ENABLE_JOB_OUTREACH_LINKING: "true",
		};
		const linked = await authenticatedWorkerFetch(
			userA,
			`/api/jobs/${activeJobs[0]!.id}/prospects/${prospectA!.id}`,
			{ method: "POST" },
			enabledEnv,
		);
		expect(linked.status).toBe(200);

		const crossUser = await authenticatedWorkerFetch(
			userA,
			`/api/jobs/${activeJobs[0]!.id}/prospects/${prospectB!.id}`,
			{ method: "POST" },
			enabledEnv,
		);
		expect(crossUser.status).toBe(400);

		const disabledUnlink = await authenticatedFetch(
			userA,
			`/api/jobs/${activeJobs[0]!.id}/prospects/${prospectA!.id}`,
			{ method: "DELETE" },
		);
		expect(disabledUnlink.status).toBe(403);

		const jobsA = (await (
			await authenticatedFetch(userA, "/api/jobs?pageSize=10")
		).json()) as {
			jobs: Array<{
				id: string;
				outreachSummary: { total: number };
			}>;
		};
		expect(
			jobsA.jobs.find((job) => job.id === activeJobs[0]!.id)?.outreachSummary
				.total,
		).toBe(1);

		const sessionA = (await (
			await authenticatedFetch(userA, "/api/session")
		).json()) as {
			prospects: Array<{
				id: string;
				matchQuality: string;
				linkedJobs: Array<{ id: string }>;
			}>;
		};
		expect(
			sessionA.prospects.find((prospect) => prospect.id === prospectA!.id)
				?.linkedJobs,
		).toContainEqual(expect.objectContaining({ id: activeJobs[0]!.id }));
		expect(
			sessionA.prospects.find(
				(prospect) => prospect.id === broaderProspect!.id,
			)?.matchQuality,
		).toBe("BROADER_COMPANY");

		const jobsB = (await (
			await authenticatedFetch(userB, "/api/jobs?pageSize=10")
		).json()) as {
			jobs: Array<{
				id: string;
				outreachSummary: { total: number };
			}>;
		};
		expect(
			jobsB.jobs.find((job) => job.id === activeJobs[0]!.id)?.outreachSummary
				.total,
		).toBe(0);

		const enabledJobs = await authenticatedWorkerFetch(
			userA,
			"/api/jobs?pageSize=10",
			{},
			enabledEnv,
		);
		expect(await enabledJobs.json()).toMatchObject({
			features: { jobOutreachLinking: true },
		});
	});

	it(
		"matches and imports the maximum 500 legacy references in batches",
		async () => {
			generatedBase += 60_000;
			const bulkJobs = Array.from({ length: 500 }, (_, index) => ({
				id: (10_000 + index).toString(16).padStart(64, "0"),
				externalId: `bulk-${index}`,
				source: "workday-bulk",
				company: `Bulk Company ${index}`,
				title: `Bulk Internship ${index}`,
				location: "Toronto, ON",
				region: "Canada",
				categories: ["Internship"],
				url: `https://jobs.example.com/bulk-${index}`,
				postedAt: null,
				postedText: null,
				description: null,
			})) satisfies NormalizedJob[];
			const ingest = await signedIngest(
				await snapshotBody(bulkJobs, generatedBase),
			);
			expect(ingest.status).toBe(200);
			expect(await ingest.json()).toMatchObject({ activeCount: 500 });

			const legacyUser = await authenticatedTestUser("legacy-max-user");
			const response = await authenticatedFetch(
				legacyUser,
				"/api/job-states/import-legacy",
				{
					method: "POST",
					body: {
						schemaVersion: 1,
						exportedAt: new Date().toISOString(),
						source: "internship-tracker-toronto",
						savedJobs: bulkJobs.map((job, index) =>
							index < 250
								? {
										url: `${job.url}?utm_source=legacy`,
										company: "Ignored",
										title: "Ignored",
									}
								: {
										url: null,
										company: job.company.toUpperCase(),
										title: job.title.toUpperCase(),
									},
						),
						applications: [],
					},
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				completed: true,
				idempotent: false,
				imported: 500,
				matched: 500,
				unmatched: 0,
				skippedExisting: 0,
				unmatchedReferences: [],
			});
		},
		20_000,
	);

	it("filters structured industry, length, and term facets in D1", async () => {
		generatedBase += 60_000;
		const structuredJobs = await Promise.all([
			normalizedJobFixture("bmo-investment", {
				company: "bmo",
				title: "Investment Team Intern - Winter 2027 - 4 Months",
				categories: ["Finance"],
			}),
			normalizedJobFixture("scotia-actuarial", {
				company: "Scotiabank",
				title: "Actuarial Insurance Intern - Winter '27 (4-month)",
				categories: ["Finance"],
			}),
			normalizedJobFixture("d2l-software", {
				source: "adzuna",
				company: "D2L",
				title: "Software Developer Intern - Summer '27 - 8 Months",
				categories: ["Technology"],
			}),
			normalizedJobFixture("deloitte-consulting", {
				company: "Deloitte",
				title: "Consulting Internship - Fall 2027 - 4 or 8 months",
				categories: ["Consulting"],
			}),
			normalizedJobFixture("maple-research", {
				company: "Maple Research Collective",
				title: "Research Internship",
				description:
					"This 12 Months placement begins in Spring 2028 and supports general research.",
				categories: ["Research"],
			}),
			normalizedJobFixture("bmo-finance-unspecified", {
				company: "BMO",
				title: "Finance Intern",
				categories: ["Finance"],
			}),
		]);
		const ingest = await signedIngest(
			await snapshotBody(structuredJobs, generatedBase),
		);
		expect(ingest.status).toBe(200);
		expect(await ingest.json()).toMatchObject({ activeCount: 6 });
		activeJobs = structuredJobs;

		const unfiltered = (await (
			await SELF.fetch("http://example.com/api/jobs?pageSize=20")
		).json()) as {
			jobs: Array<{
				id: string;
				source: string;
				industry: string;
				lengthMonths: number[];
				lengthLabel: string | null;
				term: { label: string } | null;
				discoveryCriteria: {
					companies: string[];
					roles: string[];
					keywords: string[];
				};
			}>;
			facets: {
				industries: Array<{ value: string; count: number }>;
				lengths: Array<{ value: number | string; count: number }>;
				terms: Array<{ value: string; label: string; count: number }>;
			};
		};
		const bmo = unfiltered.jobs.find(
			(job) => job.id === structuredJobs[0]!.id,
		)!;
		expect(bmo).toMatchObject({
			industry: "Banking & Financial Services",
			lengthMonths: [4],
			lengthLabel: "4 months",
			term: { label: "Winter '27" },
			discoveryCriteria: {
				companies: ["BMO Financial Group"],
				keywords: ["investment", "portfolio"],
			},
		});
		expect(bmo.discoveryCriteria.roles.slice(0, 2)).toEqual([
			"Junior Investment Analyst",
			"Investment Analyst I",
		]);
		expect(
			unfiltered.jobs.find((job) => job.id === structuredJobs[2]!.id)
				?.source,
		).toBe("adzuna");
		expect(
			Object.fromEntries(
				unfiltered.facets.industries.map((facet) => [
					facet.value,
					facet.count,
				]),
			),
		).toMatchObject({
			"Banking & Financial Services": 2,
			Insurance: 1,
			Technology: 1,
			"Consulting & Professional Services": 1,
			Other: 1,
		});
		expect(
			Object.fromEntries(
				unfiltered.facets.lengths.map((facet) => [
					String(facet.value),
					facet.count,
				]),
			),
		).toMatchObject({
			"4": 3,
			"8": 2,
			"12": 1,
			UNSPECIFIED: 1,
		});
		expect(
			unfiltered.facets.terms.map((facet) => [
				facet.value,
				facet.label,
			]),
		).toEqual(
			expect.arrayContaining([
				["WINTER-2027", "Winter '27"],
				["SUMMER-2027", "Summer '27"],
				["FALL-2027", "Fall '27"],
				["SPRING-2028", "Spring '28"],
				["UNSPECIFIED", "Unspecified"],
			]),
		);

		const combination = await SELF.fetch(
			`http://example.com/api/jobs?industry=${encodeURIComponent(
				"Banking & Financial Services",
			)}&length=4&term=WINTER-2027&category=Finance&pageSize=10`,
		);
		expect(combination.status).toBe(200);
		const combined = (await combination.json()) as {
			jobs: Array<{ id: string }>;
			pagination: { total: number };
			facets: {
				lengths: Array<{ value: number | string; count: number }>;
			};
		};
		expect(combined.jobs.map((job) => job.id)).toEqual([
			structuredJobs[0]!.id,
		]);
		expect(combined.pagination.total).toBe(1);

		const paged = (await (
			await SELF.fetch(
				"http://example.com/api/jobs?length=4&pageSize=1&page=2",
			)
		).json()) as {
			jobs: Array<{ id: string }>;
			pagination: { page: number; pageSize: number; total: number };
		};
		expect(paged.jobs).toHaveLength(1);
		expect(paged.pagination).toMatchObject({
			page: 2,
			pageSize: 1,
			total: 3,
		});

		const unspecified = (await (
			await SELF.fetch(
				"http://example.com/api/jobs?length=UNSPECIFIED&term=UNSPECIFIED&pageSize=10",
			)
		).json()) as { jobs: Array<{ id: string }> };
		expect(unspecified.jobs.map((job) => job.id)).toEqual([
			structuredJobs[5]!.id,
		]);
	});

	it("repopulates derived fields when the same hash arrives at a later generatedAt", async () => {
		const target = activeJobs[0]!;
		await env.DB.prepare(
			`UPDATE jobs SET industry = NULL, duration_min_months = NULL,
			        duration_max_months = NULL, duration_options_json = '[]',
			        term_season = NULL, term_year = NULL
			  WHERE id = ?`,
		)
			.bind(target.id)
			.run();
		generatedBase += 60_000;
		const refresh = await signedIngest(
			await snapshotBody(activeJobs, generatedBase),
		);
		expect(refresh.status).toBe(200);
		expect(await refresh.json()).toMatchObject({ idempotent: false });
		const restored = (await (
			await SELF.fetch(
				`http://example.com/api/jobs/${target.id}`,
			)
		).json()) as {
			job: {
				industry: string;
				lengthMonths: number[];
				term: { label: string };
			};
		};
		expect(restored.job).toMatchObject({
			industry: "Banking & Financial Services",
			lengthMonths: [4],
			term: { label: "Winter '27" },
		});
	});

	it("keeps structured filters behind the allowlist gate", async () => {
		const gatedEnv = {
			...(env as unknown as AppBindings),
			BETA_ACCESS_MODE: "ALLOWLIST",
			BETA_ADMIN_EMAILS: "filters-admin@example.com",
		};
		const denied = await workerRequest(
			gatedEnv,
			`/api/jobs?industry=${encodeURIComponent(
				"Banking & Financial Services",
			)}&length=4`,
		);
		expect(denied.status).toBe(401);
		const user = await upsertUser(gatedEnv, {
			googleSub: `filters-admin-${crypto.randomUUID()}`,
			email: "filters-admin@example.com",
			name: "Filters Admin",
			image: "",
		});
		const auth = await authenticatedSessionForUser(user, gatedEnv);
		const allowed = await authenticatedWorkerFetch(
			auth,
			`/api/jobs?industry=${encodeURIComponent(
				"Banking & Financial Services",
			)}&length=4&term=WINTER-2027`,
			{},
			gatedEnv,
		);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({
			pagination: { total: 1 },
		});
	});

	it("summarizes Tavily-only discovery, deduplicates source URLs, and links once", async () => {
		await saveCredential(env as unknown as AppBindings, {
			userId: userA.user.id,
			provider: "TAVILY",
			value: "test-tavily-discovery-key",
		});
		const bmoJob = (
			(await (
				await SELF.fetch(
					`http://example.com/api/jobs/${activeJobs[0]!.id}`,
				)
			).json()) as {
				job: NormalizedJob & {
					discoveryCriteria: {
						roles: string[];
						industries: string[];
						companies: string[];
						locations: string[];
						keywords: string[];
						seniority: string[];
						objective: string;
						count: number;
					};
				};
			}
		).job;
		const enabledEnv = {
			...(env as unknown as AppBindings),
			ENABLE_JOB_OUTREACH_LINKING: "true",
		};
		const providerResponses = [
			{ results: [] },
			{
				results: [
					{
						title:
							"Brent Joyce, Chief Investment Strategist | BMO",
						url: "https://privatewealth-insights.bmo.com/en/people/brent-joyce",
						content:
							"Brent Joyce is Chief Investment Strategist at BMO Financial Group in Toronto.",
					},
					{
						title: "Investment jobs at BMO",
						url: "https://www.bmo.com/careers/jobs/investment",
						content:
							"Search investment jobs at BMO Financial Group in Toronto.",
					},
				],
			},
			{ results: [] },
			{
				results: [
					{
						title:
							"Brent Joyce, Chief Investment Strategist | BMO",
						url: "https://privatewealth-insights.bmo.com/en/people/brent-joyce",
						content:
							"Brent Joyce is Chief Investment Strategist at BMO Financial Group in Toronto.",
					},
				],
			},
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No other provider is authorized."));
		for (const response of providerResponses) {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(response), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		const requestBody = {
			...bmoJob.discoveryCriteria,
			jobId: bmoJob.id,
		};
		const first = await authenticatedWorkerFetch(
			userA,
			"/api/discovery",
			{ method: "POST", body: requestBody },
			enabledEnv,
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			summary: {
				providerReturned: 2,
				accepted: 1,
				primaryProviderReturned: 0,
				primaryAccepted: 0,
				professionalBioProviderReturned: 2,
				professionalBioAccepted: 1,
				fallbackProvider: "NONE",
				fallbackAttempted: false,
				fallbackStatus: "NOT_REQUESTED",
				fallbackReturned: 0,
				fallbackAccepted: 0,
				inserted: 1,
				duplicates: 0,
				rejected: 1,
			},
			prospects: [
				{
					fullName: "Brent Joyce",
					company: "BMO Financial Group",
					companyDomain: "bmo.com",
					linkedinUrl: "",
					sourceUrl:
						"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
				},
			],
		});
		const retry = await authenticatedWorkerFetch(
			userA,
			"/api/discovery",
			{ method: "POST", body: requestBody },
			enabledEnv,
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			summary: {
				providerReturned: 1,
				accepted: 1,
				primaryProviderReturned: 0,
				primaryAccepted: 0,
				professionalBioProviderReturned: 1,
				professionalBioAccepted: 1,
				fallbackProvider: "NONE",
				fallbackAttempted: false,
				fallbackStatus: "NOT_REQUESTED",
				fallbackReturned: 0,
				fallbackAccepted: 0,
				inserted: 0,
				duplicates: 1,
				rejected: 0,
			},
			prospects: [],
		});
		const stored = await env.DB.prepare(
			`SELECT full_name, company, company_domain, linkedin_url, source_url
			   FROM prospects WHERE user_id = ? AND source_url = ?`,
		)
			.bind(
				userA.user.id,
				"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
			)
			.all<{
				full_name: string;
				company: string;
				company_domain: string;
				linkedin_url: string;
				source_url: string;
			}>();
		expect(stored.results).toEqual([
			{
				full_name: "Brent Joyce",
				company: "BMO Financial Group",
				company_domain: "bmo.com",
				linkedin_url: "",
				source_url:
					"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
			},
		]);
		const links = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM job_prospects jp
			  JOIN prospects p ON p.id = jp.prospect_id
			  WHERE jp.user_id = ? AND jp.job_id = ? AND p.source_url = ?`,
		)
			.bind(
				userA.user.id,
				bmoJob.id,
				"https://privatewealth-insights.bmo.com/en/people/brent-joyce",
			)
			.first<{ count: number }>();
		expect(links?.count).toBe(1);
		const primaryQuery = JSON.parse(
			String((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.body),
		);
		expect(primaryQuery.include_domains).toBeUndefined();
		expect(primaryQuery.include_domains_mode).toBeUndefined();
		expect(primaryQuery.query).toContain("(site:linkedin.com/in OR biography OR profile)");
		expect(primaryQuery.query).not.toContain(
			"Banking & Financial Services",
		);
		expect(primaryQuery.query).toContain(
			'("Junior Investment Analyst" OR "Investment Analyst I"',
		);
		expect(primaryQuery.query).not.toContain(" AND ");
		fetchSpy.mockRestore();
	});

	it("returns a safe missing-key status when grounded search is enabled", async () => {
		await env.DB.prepare(
			"UPDATE user_settings SET people_search_fallback_provider = 'OPENAI' WHERE user_id = ?",
		)
			.bind(userA.user.id)
			.run();
		const job = (
			(await (
				await SELF.fetch(
					`http://example.com/api/jobs/${activeJobs[0]!.id}`,
				)
			).json()) as {
				job: { id: string; discoveryCriteria: Record<string, unknown> };
			}
		).job;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Missing keys cannot call providers."));
		const response = await authenticatedWorkerFetch(
			userA,
			"/api/discovery",
			{
				method: "POST",
				body: { ...job.discoveryCriteria, jobId: job.id, mode: "AI_SUPPLEMENT" },
			},
			{
				...(env as unknown as AppBindings),
				ENABLE_JOB_OUTREACH_LINKING: "true",
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			prospects: [],
			summary: {
				fallbackProvider: "OPENAI",
				fallbackAttempted: false,
				fallbackStatus: "MISSING_KEY",
				fallbackModel: "",
				fallbackReturned: 0,
				fallbackAccepted: 0,
			},
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		await env.DB.prepare(
			"UPDATE user_settings SET people_search_fallback_provider = 'NONE' WHERE user_id = ?",
		)
			.bind(userA.user.id)
			.run();
		fetchSpy.mockRestore();
	});

	it("calls only the selected fallback provider with that user's key", async () => {
		const selectedUser = await authenticatedTestUser(
			"selected-openai-fallback",
		);
		for (const [provider, value] of [
			["TAVILY", "selected-tavily-key"],
			["GEMINI", "unselected-gemini-key"],
			["OPENAI", "selected-openai-key"],
			["ANTHROPIC", "unselected-anthropic-key"],
		] as const) {
			await saveCredential(env as unknown as AppBindings, {
				userId: selectedUser.user.id,
				provider,
				value,
			});
		}
		await env.DB.prepare(
			`UPDATE user_settings
			    SET people_search_fallback_provider = 'OPENAI',
			        openai_model = 'gpt-5.5'
			  WHERE user_id = ?`,
		)
			.bind(selectedUser.user.id)
			.run();
		const job = (
			(await (
				await SELF.fetch(
					`http://example.com/api/jobs/${activeJobs[0]!.id}`,
				)
			).json()) as {
				job: { id: string; discoveryCriteria: Record<string, unknown> };
			}
		).job;
		const sourceUrl =
			"https://www.linkedin.com/in/openai-selected-bmo";
		const grounded = openAiGroundedResponse({
			people: [
				{
					fullName: "OpenAI Selected",
					title: "Investment Analyst",
					company: "BMO Financial Group",
					location: "Toronto",
					sourceUrl,
					evidence:
						"OpenAI Selected is an Investment Analyst at BMO Financial Group in Toronto.",
				},
			],
			citations: [sourceUrl],
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Only the selected AI provider is authorized."))
			.mockResolvedValueOnce(
				new Response(JSON.stringify(grounded), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const response = await authenticatedWorkerFetch(
			selectedUser,
			"/api/discovery",
			{
				method: "POST",
				body: { ...job.discoveryCriteria, jobId: job.id, count: 1, mode: "AI_SUPPLEMENT" },
			},
			{
				...(env as unknown as AppBindings),
				ENABLE_JOB_OUTREACH_LINKING: "true",
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			prospects: [
				{
					fullName: "OpenAI Selected",
					discoveryProvider: "OPENAI_GROUNDED",
					linkedinUrl: sourceUrl,
				},
			],
			summary: {
				fallbackProvider: "OPENAI",
				fallbackAttempted: true,
				fallbackStatus: "SUCCESS",
				fallbackModel: "gpt-5.5",
				fallbackAccepted: 1,
			},
		});
		expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
			"https://api.openai.com/v1/responses",
		]);
		const openAiHeaders = fetchSpy.mock.calls[0]![1]!
			.headers as Record<string, string>;
		expect(openAiHeaders.Authorization).toBe(
			["Bearer", "selected-openai-key"].join(" "),
		);
		fetchSpy.mockRestore();
	});

	it("preserves accepted Tavily people and audits only safe rate-limit fields", async () => {
		await saveCredential(env as unknown as AppBindings, {
			userId: userB.user.id,
			provider: "TAVILY",
			value: "test-tavily-provider-error",
		});
		await saveCredential(env as unknown as AppBindings, {
			userId: userB.user.id,
			provider: "GEMINI",
			value: "test-gemini-provider-error",
		});
		await env.DB.prepare(
			"UPDATE user_settings SET people_search_fallback_provider = 'GEMINI' WHERE user_id = ?",
		)
			.bind(userB.user.id)
			.run();
		const job = (
			(await (
				await SELF.fetch(
					`http://example.com/api/jobs/${activeJobs[0]!.id}`,
				)
			).json()) as {
				job: { id: string; discoveryCriteria: Record<string, unknown> };
			}
		).job;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Only explicit discovery is authorized."))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								title:
									"Tavily Example - Investment Analyst - BMO | LinkedIn",
								url: "https://www.linkedin.com/in/tavily-preserved",
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
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message:
								"quota exceeded for private prompt https://private.example/person using SECRET-DO-NOT-STORE",
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		const tavily = await authenticatedWorkerFetch(
			userB,
			"/api/discovery",
			{
				method: "POST",
				body: { ...job.discoveryCriteria, jobId: job.id, count: 2 },
			},
			{
				...(env as unknown as AppBindings),
				ENABLE_JOB_OUTREACH_LINKING: "true",
			},
		);
		expect(tavily.status).toBe(200);
		expect(await tavily.json()).toMatchObject({
			summary: { mode: "TAVILY", inserted: 1, fallbackAttempted: false },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const response = await authenticatedWorkerFetch(userB, "/api/discovery", {
			method: "POST",
			body: { ...job.discoveryCriteria, jobId: job.id, count: 2, mode: "AI_SUPPLEMENT" },
		}, { ...(env as unknown as AppBindings), ENABLE_JOB_OUTREACH_LINKING: "true" });
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			prospects: Array<{ fullName: string }>;
			summary: Record<string, unknown>;
		};
		expect(payload).toMatchObject({
			prospects: [],
			summary: {
				mode: "AI_SUPPLEMENT", tavilyAttempted: false,
				inserted: 0,
				fallbackProvider: "GEMINI",
				fallbackAttempted: true,
				fallbackStatus: "RATE_LIMITED",
				fallbackModel: "gemini-3.8-flash",
				fallbackHttpStatus: 429,
				fallbackReturned: 0,
				fallbackAccepted: 0,
			},
		});
		const saved = await authenticatedWorkerFetch(userB, "/api/prospects", {}, env as unknown as AppBindings);
		expect(await saved.json()).toMatchObject({ prospects: expect.arrayContaining([
			expect.objectContaining({ fullName: "Tavily Example", discoveryProvider: "TAVILY" }),
		]) });
		expect(JSON.stringify(payload.summary)).not.toMatch(
			/private prompt|private\.example|SECRET-DO-NOT-STORE/i,
		);
		const auditRow = await env.DB.prepare(
			`SELECT metadata_json FROM audit_events
			  WHERE user_id = ? AND action = 'DISCOVERY_COMPLETED'
			  ORDER BY created_at DESC LIMIT 1`,
		)
			.bind(userB.user.id)
			.first<{ metadata_json: string }>();
		const auditMetadata = JSON.parse(auditRow!.metadata_json);
		expect(auditMetadata).toMatchObject({
			fallbackProvider: "GEMINI",
			fallbackStatus: "RATE_LIMITED",
			fallbackModel: "gemini-3.8-flash",
			fallbackHttpStatus: 429,
		});
		expect(JSON.stringify(auditMetadata)).not.toMatch(
			/private prompt|private\.example|SECRET-DO-NOT-STORE/i,
		);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		fetchSpy.mockRestore();
	});

	it("accepts cited grounded people and deduplicates their job link", async () => {
		const groundedUser = await authenticatedTestUser(
			"gemini-grounded-discovery",
		);
		await saveCredential(env as unknown as AppBindings, {
			userId: groundedUser.user.id,
			provider: "TAVILY",
			value: "test-tavily-grounded",
		});
		await saveCredential(env as unknown as AppBindings, {
			userId: groundedUser.user.id,
			provider: "GEMINI",
			value: "test-user-grounded-key",
		});
		await env.DB.prepare(
			"UPDATE user_settings SET people_search_fallback_provider = 'GEMINI' WHERE user_id = ?",
		)
			.bind(groundedUser.user.id)
			.run();
		const job = (
			(await (
				await SELF.fetch(
					`http://example.com/api/jobs/${activeJobs[0]!.id}`,
				)
			).json()) as {
				job: { id: string; discoveryCriteria: Record<string, unknown> };
			}
		).job;
		const grounded = geminiInteractionResponse({
			people: [
				{
					fullName: "Alexander Spark",
					title: "Managing Director",
					company: "BMO Financial Group",
					location: "Toronto",
					sourceUrl:
						"https://privatewealth.bmo.com/en/people/alexander-spark",
					evidence:
						"Alexander Spark is a Managing Director at BMO Financial Group in Toronto.",
				},
			],
			citations: [
				"https://privatewealth.bmo.com/en/people/alexander-spark",
			],
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Only explicit AI discovery is authorized."));
		for (const providerResponse of [
			grounded,
			grounded,
		]) {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(providerResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		const enabledEnv = {
			...(env as unknown as AppBindings),
			ENABLE_JOB_OUTREACH_LINKING: "true",
		};
		const body = { ...job.discoveryCriteria, jobId: job.id, count: 1, mode: "AI_SUPPLEMENT" };
		const first = await authenticatedWorkerFetch(
			groundedUser,
			"/api/discovery",
			{ method: "POST", body },
			enabledEnv,
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			prospects: [
				{
					fullName: "Alexander Spark",
					discoveryProvider: "GEMINI_GROUNDED",
					sourceUrl:
						"https://privatewealth.bmo.com/en/people/alexander-spark",
					matchQuality: "BROADER_COMPANY",
				},
			],
			summary: {
				fallbackProvider: "GEMINI",
				fallbackAttempted: true,
				fallbackStatus: "SUCCESS",
				fallbackModel: "gemini-3.8-flash",
				fallbackReturned: 1,
				fallbackAccepted: 1,
				inserted: 1,
				duplicates: 0,
			},
		});
		const retry = await authenticatedWorkerFetch(
			groundedUser,
			"/api/discovery",
			{ method: "POST", body },
			enabledEnv,
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			summary: {
				fallbackProvider: "GEMINI",
				fallbackStatus: "SUCCESS",
				fallbackReturned: 1,
				fallbackAccepted: 1,
				inserted: 0,
				duplicates: 1,
			},
		});
		const link = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM job_prospects jp
			  JOIN prospects p ON p.id = jp.prospect_id
			  WHERE jp.user_id = ? AND jp.job_id = ? AND p.source_url = ?`,
		)
			.bind(
				groundedUser.user.id,
				job.id,
				"https://privatewealth.bmo.com/en/people/alexander-spark",
			)
			.first<{ count: number }>();
		expect(link?.count).toBe(1);
		const auditRow = await env.DB.prepare(
			`SELECT metadata_json FROM audit_events
			  WHERE user_id = ? AND action = 'DISCOVERY_COMPLETED'
			  ORDER BY created_at DESC LIMIT 1`,
		)
			.bind(groundedUser.user.id)
			.first<{ metadata_json: string }>();
		expect(JSON.parse(auditRow!.metadata_json)).toMatchObject({
			fallbackProvider: "GEMINI",
			fallbackStatus: "SUCCESS",
			fallbackModel: "gemini-3.8-flash",
			fallbackReturned: 1,
			fallbackAccepted: 1,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		fetchSpy.mockRestore();
	});
});

describe("bounded ranked job contacts", () => {
	let owner: Awaited<ReturnType<typeof authenticatedTestUser>>;
	let other: Awaited<ReturnType<typeof authenticatedTestUser>>;
	const jobIds = ["e".repeat(64), "f".repeat(64)];
	const company = "Example Software Firm";
	const discovery = {
		roles: ["Senior Director"], industries: [], companies: ["Unrelated Company"],
		locations: [], keywords: [], seniority: ["Senior"], objective: "", count: 5,
		jobId: jobIds[0],
	};
	const bindings = () => ({ ...(env as unknown as AppBindings), ENABLE_JOB_OUTREACH_LINKING: "true" });
	const profiles = [
		["Zed Fictional", "Junior Marketing Specialist"],
		["Casey Fictional", "Senior Campus Recruiter"],
		["Alex Fictional", "Junior Software Engineer"],
		["Senior Fictional", "Senior Software Engineer"],
		["Unknown Fictional", "Software Engineer"],
	].map(([fullName, title]) => ({
		fullName, title, company, location: "Toronto",
		sourceUrl: `https://www.linkedin.com/in/ranked-${fullName!.split(" ")[0]!.toLowerCase()}`,
		evidence: `${fullName} is a ${title} at ${company}.`,
	}));

	beforeAll(async () => {
		owner = await authenticatedTestUser("ranked-owner");
		other = await authenticatedTestUser("ranked-other");
		const runId = crypto.randomUUID();
		const now = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,status,job_count)
			 VALUES(?,1,?,?,?, ?,?,'APPLIED',2)`,
		).bind(runId, jobIds[0], jobIds[1], now, Date.now(), now).run();
		for (const [index, title] of ["Software Engineering Intern", "Marketing Intern"].entries()) {
			await env.DB.prepare(
				`INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,url,canonical_url,
				 first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,is_active)
				 VALUES(?,'mock',?,?,?,?,'https://example.test/job','https://example.test/job',?,?,?,?,?,?)`,
			).bind(jobIds[index], company, company.toLowerCase(), title, title.toLowerCase(), now, now, runId, now, now, index === 0 ? 1 : 0).run();
		}
		for (const provider of ["TAVILY", "ANTHROPIC"] as const) {
			await saveCredential(bindings(), { userId: owner.user.id, provider, value: `fake-ranked-${provider}` });
		}
		await env.DB.prepare(
			`UPDATE user_settings SET people_search_fallback_provider='ANTHROPIC',anthropic_model='chosen-only-model',
			 enrichment_provider='NONE',draft_provider='TEMPLATE',sender_name='Fictional Sender',
			 personal_context_json='[{"category":"Background summary","content":"I study software engineering."}]'
			 WHERE user_id=?`,
		).bind(owner.user.id).run();
	});

	const independentCriteria = {
		roles: ["Software Engineer"], industries: [], companies: [company],
		locations: [], keywords: [], seniority: [], objective: "", count: 2,
	};
	for (const surface of ["general", "job"] as const) {
		for (const mode of [undefined, "TAVILY"] as const) {
			it.each(["full", "partial", "zero", "unconfirmed", "duplicates", "error", "bio-error", "missing-key"])(
				`${surface} ${mode || "legacy"} discovery keeps %s results Tavily-only`,
				async (outcome) => {
					const auth = await authenticatedTestUser("tavily-only");
					await saveCredential(bindings(), { userId: auth.user.id, provider: "ANTHROPIC", value: "fake-available-ai-key" });
					await env.DB.prepare("UPDATE user_settings SET people_search_fallback_provider='ANTHROPIC' WHERE user_id=?")
						.bind(auth.user.id).run();
					if (outcome !== "missing-key") {
						await saveCredential(bindings(), { userId: auth.user.id, provider: "TAVILY", value: "fake-tavily-only-key" });
					}
					const candidate = profiles[2]!;
					const asTavily = (person: typeof candidate) => ({
						title: `${person.fullName} - ${person.title} - ${company} | LinkedIn`,
						url: person.sourceUrl, content: person.evidence,
					});
					if (outcome === "duplicates") {
						await insertProspects(bindings(), auth.user.id, [{
							...testProspect(candidate.fullName!, company),
							matchQuality: "STRONG",
							title: candidate.title!, linkedinUrl: candidate.sourceUrl,
							sourceUrl: candidate.sourceUrl, sourceSnippet: candidate.evidence,
						}]);
					}
					const second = { ...candidate, fullName: "Additional Fictional", sourceUrl: "https://www.linkedin.com/in/additional-fictional" };
					const results = outcome === "zero" ? [] : outcome === "full"
						? [asTavily(candidate), asTavily(second)]
						: outcome === "unconfirmed" ? [asTavily(profiles[4]!)]
							: outcome === "duplicates" ? Array(5).fill(asTavily(candidate))
								: [asTavily(candidate)];
					let tavilyPass = 0;
					const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
						expect(url).toBe("https://api.tavily.com/search");
						const body = JSON.parse(String(init?.body));
						expect(body.include_domains).toBeUndefined();
						const primary = tavilyPass++ === 0;
						if (outcome === "error" || (outcome === "bio-error" && !primary)) {
							return Response.json({ error: "PRIVATE QUERY SECRET-DO-NOT-STORE" }, { status: 401 });
						}
						return Response.json({ results: primary ? results : [] });
					});
					try {
						const response = await authenticatedWorkerFetch(auth, "/api/discovery", {
							method: "POST", body: {
								...(surface === "job" ? discovery : independentCriteria), count: 2,
								...(mode ? { mode } : {}), anthropicSearchMaxUses: 3,
							},
						}, bindings());
						const failed = ["error", "bio-error", "missing-key"].includes(outcome);
						expect(response.status).toBe(outcome === "missing-key" ? 400 : failed ? 500 : 200);
						const payload = await response.json() as { summary: Record<string, unknown>; prospects: Prospect[] };
						expect(JSON.stringify(payload)).not.toMatch(/PRIVATE QUERY|SECRET-DO-NOT-STORE|fake-available-ai-key/);
						if (!failed) {
							expect(payload.summary).toMatchObject({
								mode: "TAVILY", tavilyAttempted: true, fallbackProvider: "NONE",
								fallbackAttempted: false, fallbackStatus: "NOT_REQUESTED",
								fallbackReturned: 0, fallbackAccepted: 0, anthropicSearchMaxUses: 1,
							});
							if (surface === "job" && outcome === "unconfirmed") {
								expect(payload.summary).toMatchObject({ jobQualified: 0, jobUnconfirmed: 1 });
							}
							if (outcome === "duplicates") expect(payload.summary).toMatchObject({ inserted: 0, duplicates: 1 });
							expect(payload.prospects.every((person) => person.status === "DISCOVERED" && !person.contactApprovedAt && !person.email && !person.draftBody)).toBe(true);
						}
						expect(spy.mock.calls.map(([url]) => url)).toEqual(
							Array(outcome === "missing-key" ? 0 : ["full", "error"].includes(outcome) ? 1 : 2)
								.fill("https://api.tavily.com/search"),
						);
					} finally {
						spy.mockRestore();
					}
				},
			);
		}

		it.each(["NONE", "ANTHROPIC"] as const)(`${surface} explicit AI reports disabled/missing %s without calling any provider`, async (provider) => {
			const auth = await authenticatedTestUser("ai-unavailable");
			await env.DB.prepare("UPDATE user_settings SET people_search_fallback_provider=? WHERE user_id=?")
				.bind(provider, auth.user.id).run();
			const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider call authorized."));
			try {
				const response = await authenticatedWorkerFetch(auth, "/api/discovery", {
					method: "POST", body: { ...(surface === "job" ? discovery : independentCriteria), mode: "AI_SUPPLEMENT" },
				}, bindings());
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ userId: auth.user.id, prospects: [], summary: {
					mode: "AI_SUPPLEMENT", tavilyAttempted: false, primaryProviderReturned: 0,
					professionalBioProviderReturned: 0, fallbackProvider: provider,
					fallbackAttempted: false, fallbackStatus: provider === "NONE" ? "DISABLED" : "MISSING_KEY",
				} });
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		it.each(["GEMINI", "OPENAI", "ANTHROPIC"] as const)(`${surface} explicit %s makes exactly one selected request, never reads Tavily, and merges duplicates safely`, async (provider) => {
			const auth = await authenticatedTestUser("one-selected-ai");
			for (const credential of ["TAVILY", "GEMINI", "OPENAI", "ANTHROPIC"] as const) {
				await saveCredential(bindings(), { userId: auth.user.id, provider: credential, value: `fake-own-${credential}` });
			}
			await env.DB.prepare("UPDATE encrypted_credentials SET ciphertext='unreadable-tavily-key' WHERE user_id=? AND provider='TAVILY'")
				.bind(auth.user.id).run();
			await env.DB.prepare("UPDATE user_settings SET people_search_fallback_provider=? WHERE user_id=?").bind(provider, auth.user.id).run();
			const people = [profiles[2]!];
			const citations = people.map((person) => person.sourceUrl);
			const output = provider === "GEMINI" ? geminiInteractionResponse({ people, citations })
				: provider === "OPENAI" ? openAiGroundedResponse({ people, citations })
					: { content: [{ type: "text", text: JSON.stringify({ people }), citations: citations.map((url) => ({ type: "web_search_result_location", url })) }] };
			const endpoint = {
				GEMINI: "https://generativelanguage.googleapis.com/v1beta/interactions",
				OPENAI: "https://api.openai.com/v1/responses",
				ANTHROPIC: "https://api.anthropic.com/v1/messages",
			}[provider];
			const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				expect(url).toBe(endpoint);
				return Response.json(output);
			});
			try {
				for (const invocation of [1, 2]) {
					const response = await authenticatedWorkerFetch(auth, "/api/discovery", {
						method: "POST", body: { ...(surface === "job" ? discovery : independentCriteria), mode: "AI_SUPPLEMENT" },
					}, bindings());
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({ summary: {
						mode: "AI_SUPPLEMENT", tavilyAttempted: false,
						primaryProviderReturned: 0, primaryAccepted: 0, professionalBioProviderReturned: 0,
						professionalBioAccepted: 0, fallbackProvider: provider, fallbackAttempted: true,
						fallbackStatus: "SUCCESS", inserted: invocation === 1 ? 1 : 0,
						duplicates: invocation === 1 ? 0 : 1, anthropicSearchMaxUses: 1,
					} });
					expect(spy).toHaveBeenCalledTimes(invocation);
				}
				const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
				expect(headers[provider === "ANTHROPIC" ? "x-api-key" : provider === "GEMINI" ? "x-goog-api-key" : "Authorization"])
					.toBe(provider === "OPENAI" ? "Bearer fake-own-OPENAI" : `fake-own-${provider}`);
				const saved = await authenticatedWorkerFetch(auth,
					surface === "job" ? `/api/jobs/${jobIds[0]}/prospects` : "/api/prospects", {}, bindings());
				const payload = await saved.json() as { prospects: Prospect[] };
				expect(payload.prospects).toHaveLength(1);
				expect(payload.prospects[0]).toMatchObject({ userId: auth.user.id, status: "DISCOVERED", contactApprovedAt: null, email: "", draftBody: "" });
				if (surface === "job") {
					expect(payload.prospects[0]!.linkedJobs).toEqual([expect.objectContaining({ id: jobIds[0], contactMatch: expect.objectContaining({ tier: 1 }) })]);
				}
				expect(spy).toHaveBeenCalledTimes(2);
			} finally {
				spy.mockRestore();
			}
		});
	}

	it("rejects invalid modes and protects both actions with authentication, CSRF, origin, beta and job feature gates", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider call authorized."));
		try {
			for (const mode of ["", "AUTO", "tavily", null, 3, true]) {
				const response = await authenticatedWorkerFetch(owner, "/api/discovery", {
					method: "POST", body: { ...independentCriteria, mode },
				}, bindings());
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST" });
			}
			for (const mode of ["TAVILY", "AI_SUPPLEMENT"]) {
				const body = { ...discovery, mode };
				const anonymous = await workerRequest(bindings(), "/api/discovery", {
					method: "POST", body: JSON.stringify(body), headers: { Origin: bindings().APP_ORIGIN },
				});
				expect(anonymous.status).toBe(401);
				for (const gate of ["csrf", "origin"]) {
					const request = authenticatedRequest(owner, "/api/discovery", { method: "POST", body });
					if (gate === "csrf") request.headers.delete("X-CSRF-Token");
					else request.headers.set("Origin", "https://unrelated.example");
					const context = createExecutionContext();
					const denied = await worker.fetch(request, bindings(), context);
					await waitOnExecutionContext(context);
					expect(denied.status).toBe(403);
				}
				const feature = await authenticatedWorkerFetch(owner, "/api/discovery", { method: "POST", body }, {
					...bindings(), ENABLE_JOB_OUTREACH_LINKING: "false",
				});
				expect(feature.status).toBe(403);
				const betaUser = await authenticatedTestUser("unapproved-discovery");
				const beta = await authenticatedWorkerFetch(betaUser, "/api/discovery", { method: "POST", body }, {
					...bindings(), BETA_ACCESS_MODE: "ALLOWLIST", BETA_ADMIN_EMAILS: "",
				});
				expect([401, 403]).toContain(beta.status);
			}
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("applies the existing shared discovery rate limit to both modes before provider calls", async () => {
		const auth = await authenticatedTestUser("discovery-rate-limit");
		const start = Math.floor(Date.now() / 3600000) * 3600000;
		await env.DB.prepare("INSERT INTO rate_limits(user_id,action,window_start,count,expires_at) VALUES(?,'DISCOVERY',?,20,?)")
			.bind(auth.user.id, new Date(start).toISOString(), new Date(start + 3600000).toISOString()).run();
		const spy = vi.spyOn(globalThis, "fetch");
		for (const mode of ["TAVILY", "AI_SUPPLEMENT"]) {
			const response = await authenticatedWorkerFetch(auth, "/api/discovery", {
				method: "POST", body: { ...independentCriteria, mode },
			}, bindings());
			expect(response.status).toBe(429);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects invalid budgets before any paid request and retains auth, CSRF and feature gates", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No outbound requests authorized."));
		try {
			for (const budget of [0, 2, 4, 100, "3", true, null]) {
				const response = await authenticatedWorkerFetch(owner, "/api/discovery", {
					method: "POST", body: { ...discovery, anthropicSearchMaxUses: budget },
				}, bindings());
				expect(response.status).toBe(400);
			}
			const unauthenticated = await workerRequest(bindings(), `/api/jobs/${jobIds[0]}/prospects`);
			expect(unauthenticated.status).toBe(401);
			const disabled = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[0]}/prospects`, {}, {
				...bindings(), ENABLE_JOB_OUTREACH_LINKING: "false",
			});
			expect(disabled.status).toBe(403);
			const noCsrf = authenticatedRequest(owner, "/api/discovery", { method: "POST", body: discovery });
			noCsrf.headers.delete("X-CSRF-Token");
			const context = createExecutionContext();
			const response = await worker.fetch(noCsrf, bindings(), context);
			await waitOnExecutionContext(context);
			expect(response.status).toBe(403);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("uses one explicit Anthropic request for all tiers, with default 1 and consented 3 caps", async () => {
		for (const budget of [undefined, 3]) {
			const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound provider."));
			spy.mockResolvedValueOnce(Response.json({
					content: [
						{
							type: "text", text: JSON.stringify({ people: profiles }),
							citations: profiles.map((person) => ({ type: "web_search_result_location", url: person.sourceUrl })),
						},
						{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
					],
				}));
			try {
				const response = await authenticatedWorkerFetch(owner, "/api/discovery", {
					method: "POST", body: { ...discovery, mode: "AI_SUPPLEMENT", ...(budget ? { anthropicSearchMaxUses: budget } : {}) },
				}, bindings());
				expect(response.status).toBe(200);
				const payload = await response.json() as { summary: Record<string, unknown>; prospects: Prospect[] };
				expect(payload.summary).toMatchObject({
					anthropicSearchMaxUses: budget || 1,
					fallbackStatus: "SEARCH_LIMITED", fallbackReason: "max_uses_exceeded",
					fallbackModel: "chosen-only-model", fallbackAccepted: 5,
					jobQualified: 3, jobUnconfirmed: 2,
					inserted: budget ? 0 : 5, duplicates: budget ? 5 : 0,
				});
				expect(payload.prospects.every((person) => person.status === "DISCOVERED" && !person.email && !person.contactApprovedAt && !person.draftBody)).toBe(true);
				expect(spy).toHaveBeenCalledTimes(1);
				expect(spy.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
				const anthropic = JSON.parse(String(spy.mock.calls[0]![1]!.body));
				expect(anthropic.messages[0].content).toContain(company);
				expect(anthropic.messages[0].content).not.toContain("Senior Director");
				expect(anthropic.messages[0].content).not.toContain("Unrelated Company");
				expect(anthropic.tools[0].max_uses).toBe(budget || 1);
				expect(anthropic.model).toBe("chosen-only-model");
				expect(anthropic.messages[0].content).toContain("priorityOrder");
				expect(anthropic.messages[0].content).not.toContain("I study software engineering");
				const auditRow = await env.DB.prepare(
					"SELECT metadata_json FROM audit_events WHERE user_id=? AND action='DISCOVERY_COMPLETED' ORDER BY created_at DESC LIMIT 1",
				).bind(owner.user.id).first<{ metadata_json: string }>();
				expect(JSON.parse(auditRow!.metadata_json).anthropicSearchMaxUses).toBe(budget || 1);
				expect(auditRow!.metadata_json).not.toMatch(/fake-ranked|linkedin\.com|evidence/);
			} finally {
				spy.mockRestore();
			}
		}
	});

	it("reuses only owned persisted links, preserves deterministic job-dependent ranking and expired jobs", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Reading contacts must never call providers."));
		try {
			const response = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[0]}/prospects`, {}, bindings());
			expect(response.status).toBe(200);
			const saved = await response.json() as { userId: string; prospects: Prospect[] };
			expect(saved.userId).toBe(owner.user.id);
			expect(saved.prospects.map((person) => person.fullName)).toEqual([
				"Alex Fictional", "Casey Fictional", "Zed Fictional", "Senior Fictional", "Unknown Fictional",
			]);
			expect(saved.prospects.map((person) => person.linkedJobs[0]?.contactMatch?.tier)).toEqual([1, 2, 3, null, null]);
			for (const person of saved.prospects) {
				const linked = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[1]}/prospects/${person.id}`, { method: "POST" }, bindings());
				expect(linked.status).toBe(200);
			}
			const marketing = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[1]}/prospects`, {}, bindings());
			expect(marketing.status).toBe(200);
			const marketingPayload = await marketing.json() as { prospects: Prospect[] };
			expect(marketingPayload.prospects.slice(0, 3).map((person) => person.fullName)).toEqual([
				"Zed Fictional", "Casey Fictional", "Alex Fictional",
			]);
			const forbiddenLink = await authenticatedWorkerFetch(other, `/api/jobs/${jobIds[0]}/prospects/${saved.prospects[0]!.id}`, { method: "POST" }, bindings());
			expect(forbiddenLink.status).toBe(400);
			const otherContacts = await authenticatedWorkerFetch(other, `/api/jobs/${jobIds[0]}/prospects`, {}, bindings());
			expect(await otherContacts.json()).toMatchObject({ userId: other.user.id, prospects: [] });
			const again = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[0]}/prospects`, {}, bindings());
			const againPayload = await again.json() as { prospects: Prospect[] };
			expect(againPayload.prospects.map((person) => person.id)).toEqual(saved.prospects.map((person) => person.id));
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("surfaces missing discovery keys without hiding saved contacts or starting fallback", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No configured discovery key."));
		try {
			const response = await authenticatedWorkerFetch(other, "/api/discovery", {
				method: "POST", body: { ...discovery, anthropicSearchMaxUses: 3 },
			}, bindings());
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ message: expect.stringContaining("Tavily API key in Settings") });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps preparation explicit and final sending blocked without an approved exact draft", async () => {
		const saved = await authenticatedWorkerFetch(owner, `/api/jobs/${jobIds[0]}/prospects`, {}, bindings());
		const { prospects } = await saved.json() as { prospects: Prospect[] };
		const id = prospects[0]!.id;
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		try {
			const premature = await authenticatedWorkerFetch(owner, `/api/prospects/${id}/send`, {
				method: "POST", body: { expectedVersion: 1, idempotencyKey: crypto.randomUUID() },
			}, bindings());
			expect(premature.status).not.toBe(200);
			expect(spy).not.toHaveBeenCalled();
			const prepared = await authenticatedWorkerFetch(owner, `/api/prospects/${id}/prepare`, { method: "POST" }, bindings());
			expect(prepared.status).toBe(200);
			expect(await prepared.json()).toMatchObject({ prospect: {
				status: "DRAFT_READY", draftVersion: 1, email: "",
				preparation: { research: { status: "EMPTY" } },
			} });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]![0]).toBe("https://api.tavily.com/search");
			expect(JSON.parse(String(spy.mock.calls[0]![1]?.body))).toMatchObject({
				query: '"Alex Fictional" "Example Software Firm" professional profile projects experience',
				search_depth: "basic", max_results: 5,
			});
		} finally {
			spy.mockRestore();
		}
	});
});

describe("account-scoped analytics", () => {
	it("returns bounded honest metrics for only the authenticated user", async () => {
		const bindings = env as unknown as AppBindings;
		const userA = await authenticatedTestUser("analytics-a");
		const userB = await authenticatedTestUser("analytics-b");
		const runId = crypto.randomUUID();
		const now = new Date().toISOString();
		const company = `Analytics Company ${crypto.randomUUID()}`;
		const firstJobId = await sha256Hex(`analytics\n${crypto.randomUUID()}`);
		const secondJobId = await sha256Hex(`analytics\n${crypto.randomUUID()}`);
		await bindings.DB.prepare(
			`INSERT INTO job_import_runs(
			   id, schema_version, snapshot_hash, content_hash, generated_at,
			   generated_epoch, received_at, applied_at, status, job_count
			 ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'APPLIED', 2)`,
		)
			.bind(
				runId,
				firstJobId,
				secondJobId,
				now,
				Date.now(),
				now,
				now,
			)
			.run();
		for (const [id, title] of [
			[firstJobId, "Analytics Internship One"],
			[secondJobId, "Analytics Internship Two"],
		] as const) {
			await bindings.DB.prepare(
				`INSERT INTO jobs(
				   id, source, company, company_normalized, title,
				   title_normalized, location, region, categories_json, url,
				   canonical_url, is_active, first_seen_at, last_seen_at,
				   latest_import_run_id, created_at, updated_at
				 ) VALUES (?, 'workday', ?, ?, ?, ?, 'Toronto, ON', 'Canada',
				           '["Internship"]', ?, ?, 1, ?, ?, ?, ?, ?)`,
			)
				.bind(
					id,
					company,
					company.toLowerCase(),
					title,
					title.toLowerCase(),
					`https://jobs.example.com/${id}`,
					`https://jobs.example.com/${id}`,
					now,
					now,
					runId,
					now,
					now,
				)
				.run();
		}

		expect(
			(
				await authenticatedFetch(userA, `/api/jobs/${firstJobId}/state`, {
					method: "PUT",
					body: { status: "INTERVIEWING", notes: "Panel interview" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await authenticatedFetch(userA, `/api/jobs/${secondJobId}/state`, {
					method: "PUT",
					body: { status: "OFFER", notes: "" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await authenticatedFetch(userB, `/api/jobs/${firstJobId}/state`, {
					method: "PUT",
					body: { status: "APPLIED", notes: "" },
				})
			).status,
		).toBe(200);

		const prospects = await insertProspects(bindings, userA.user.id, [
			testProspect("Analytics Draft", company),
			testProspect("Analytics Sent", company),
			testProspect("Analytics Reply", company),
		]);
		await bindings.DB.batch([
			bindings.DB.prepare(
				"UPDATE prospects SET status = 'DRAFT_READY', updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(now, prospects[0]!.id, userA.user.id),
			bindings.DB.prepare(
				"UPDATE prospects SET status = 'SENT', sent_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(now, now, prospects[1]!.id, userA.user.id),
			bindings.DB.prepare(
				"UPDATE prospects SET status = 'REPLIED', sent_at = ?, last_reply_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(now, now, now, prospects[2]!.id, userA.user.id),
		]);

		const unauthenticated = await SELF.fetch("http://example.com/api/analytics");
		expect(unauthenticated.status).toBe(401);

		const responseA = await authenticatedFetch(userA, "/api/analytics");
		expect(responseA.status).toBe(200);
		const analyticsA = await responseA.json<{
			applications: Record<string, number>;
			networking: Record<string, number>;
			topCompanies: Array<{ company: string; count: number }>;
			activity: { days: Array<{ date: string; count: number }> };
			recentActivity: Array<{ action: string; context: string }>;
		}>();
		expect(analyticsA.applications).toMatchObject({
			total: 2,
			inProgress: 1,
			interviewing: 1,
			offers: 1,
			applied: 0,
		});
		expect(analyticsA.networking).toMatchObject({
			tracked: 3,
			drafts: 1,
			sent: 2,
			replied: 1,
		});
		expect(analyticsA.topCompanies).toContainEqual({ company, count: 2 });
		expect(analyticsA.activity.days).toHaveLength(28);
		expect(
			analyticsA.recentActivity.some(
				(entry) =>
					entry.action === "JOB_STATE_UPDATED" &&
					entry.context.includes(company),
			),
		).toBe(true);

		const analyticsB = await (
			await authenticatedFetch(userB, "/api/analytics")
		).json<{ applications: Record<string, number>; networking: Record<string, number> }>();
		expect(analyticsB.applications).toMatchObject({
			total: 1,
			applied: 1,
			interviewing: 0,
			offers: 0,
		});
		expect(analyticsB.networking.tracked).toBe(0);
	});
});

function encryptionEnv(): AppBindings {
	const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
	let binary = "";
	for (const byte of key) binary += String.fromCharCode(byte);
	const encoded = btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
	return {
		...env,
		ACTIVE_KEY_VERSION: "1",
		MASTER_ENCRYPTION_KEY_V1: encoded,
		SESSION_SIGNING_KEY: encoded,
	} as AppBindings;
}

async function testJob(seed: string): Promise<NormalizedJob> {
	const source = "workday";
	const externalId = `jobs.example.com:${seed}`;
	return {
		id: await sha256Hex(`${source}\n${externalId}`),
		externalId,
		source,
		company: `${seed} Company`,
		title: `${seed} Internship`,
		location: "Toronto, ON",
		region: "Canada",
		categories: ["Finance", "Internship"],
		url: `https://jobs.example.com/${seed}`,
		postedAt: new Date("2026-09-30T12:00:00.000Z").toISOString(),
		postedText: "Posted yesterday",
		description: `Internship description for ${seed}.`,
	};
}

async function normalizedJobFixture(
	seed: string,
	overrides: Partial<NormalizedJob>,
): Promise<NormalizedJob> {
	const source = overrides.source || "workday";
	const externalId = overrides.externalId || `jobs.example.com:${seed}`;
	return {
		id: await sha256Hex(`${source}\n${externalId}`),
		externalId,
		source,
		company: overrides.company || `${seed} Company`,
		title: overrides.title || `${seed} Internship`,
		location: overrides.location ?? "Toronto, ON",
		region: overrides.region ?? "Canada",
		categories: overrides.categories || ["Internship"],
		url: overrides.url || `https://jobs.example.com/${seed}`,
		postedAt: overrides.postedAt ?? null,
		postedText: overrides.postedText ?? null,
		description: overrides.description ?? null,
	};
}

async function snapshotBody(
	jobs: NormalizedJob[],
	generatedEpoch: number,
): Promise<string> {
	return JSON.stringify({
		schemaVersion: 1,
		generatedAt: new Date(generatedEpoch).toISOString(),
		snapshotHash: await snapshotHash(jobs),
		jobs,
	});
}

function geminiInteractionResponse(input: {
	people: unknown[];
	citations: string[];
}): object {
	const text = JSON.stringify({ people: input.people });
	return {
		steps: [
			{
				type: "model_output",
				content: [
					{
						type: "text",
						text,
						annotations: input.citations.map((url) => ({
							type: "url_citation",
							url,
							title: new URL(url).hostname,
							start_index: 0,
							end_index: text.length,
						})),
					},
				],
			},
		],
	};
}

function openAiGroundedResponse(input: {
	people: unknown[];
	citations: string[];
}): object {
	const text = JSON.stringify({ people: input.people });
	return {
		output: [
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text,
						annotations: input.citations.map((url) => ({
							type: "url_citation",
							url,
						})),
					},
				],
			},
		],
	};
}

async function signedIngest(
	body: string,
	timestamp = Math.floor(Date.now() / 1000),
): Promise<Response> {
	const signature = await ingestSignature(body, timestamp);
	return SELF.fetch(
		new Request("http://example.com/api/internal/jobs/snapshot", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"CF-Connecting-IP": `198.51.100.${(ingestRequestCounter++ % 200) + 1}`,
				"X-Ingest-Timestamp": String(timestamp),
				"X-Ingest-Signature": signature,
			},
			body,
		}),
	);
}

async function ingestSignature(
	body: string,
	timestamp: number,
): Promise<string> {
	return hmacSha256Hex(
		(env as unknown as AppBindings).JOBS_INGEST_SECRET,
		`${timestamp}.${body}`,
	);
}

async function workerRequest(
	bindings: AppBindings,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const context = createExecutionContext();
	const response = await worker.fetch(
		new Request(`http://example.com${path}`, init),
		bindings,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function authenticatedTestUser(seed: string): Promise<{
	user: Awaited<ReturnType<typeof upsertUser>>;
	cookie: string;
	csrf: string;
}> {
	const bindings = env as unknown as AppBindings;
	const user = await upsertUser(bindings, {
		googleSub: `${seed}-${crypto.randomUUID()}`,
		email: `${seed}-${crypto.randomUUID()}@example.com`,
		name: seed,
		image: "",
	});
	return authenticatedSessionForUser(user, bindings);
}

async function authenticatedSessionForUser(
	user: Awaited<ReturnType<typeof upsertUser>>,
	bindings: AppBindings,
): Promise<{
	user: Awaited<ReturnType<typeof upsertUser>>;
	cookie: string;
	csrf: string;
}> {
	const token = `session-${crypto.randomUUID()}`;
	const csrf = `csrf-${crypto.randomUUID()}`;
	await createSession(
		bindings,
		user.id,
		await sha256(token),
		await sha256(csrf),
		new Date(Date.now() + 60 * 60 * 1000).toISOString(),
	);
	const secure = new URL(bindings.APP_ORIGIN).protocol === "https:";
	const sessionName = secure ? "__Host-cc_session" : "cc_session";
	const csrfName = secure ? "__Host-cc_csrf" : "cc_csrf";
	return {
		user,
		cookie: `${sessionName}=${token}; ${csrfName}=${csrf}`,
		csrf,
	};
}

async function authenticatedFetch(
	auth: Awaited<ReturnType<typeof authenticatedTestUser>>,
	path: string,
	options: {
		method?: string;
		body?: unknown;
	} = {},
): Promise<Response> {
	return SELF.fetch(authenticatedRequest(auth, path, options));
}

async function authenticatedWorkerFetch(
	auth: Awaited<ReturnType<typeof authenticatedTestUser>>,
	path: string,
	options: {
		method?: string;
		body?: unknown;
	},
	bindings: AppBindings,
): Promise<Response> {
	const context = createExecutionContext();
	const response = await worker.fetch(
		authenticatedRequest(auth, path, options),
		bindings,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

function authenticatedRequest(
	auth: Awaited<ReturnType<typeof authenticatedTestUser>>,
	path: string,
	options: {
		method?: string;
		body?: unknown;
	} = {},
): Request {
	const method = options.method || "GET";
	const headers: Record<string, string> = {
		Accept: "application/json",
		Cookie: auth.cookie,
	};
	if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
		headers.Origin = (env as unknown as AppBindings).APP_ORIGIN;
		headers["X-CSRF-Token"] = auth.csrf;
	}
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	return new Request(`http://example.com${path}`, {
		method,
		headers,
		body:
			options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

function testProspect(fullName: string, company: string) {
	const [firstName, ...lastNames] = fullName.split(" ");
	const profileUrl = `https://www.linkedin.com/in/${fullName
		.toLowerCase()
		.replace(/\s+/g, "-")}-${crypto.randomUUID()}`;
	return {
		firstName,
		lastName: lastNames.join(" "),
		fullName,
		title: "Recruiter",
		company,
		companyDomain: "example.com",
		location: "Toronto",
		linkedinUrl: profileUrl,
		discoveryProvider: "TAVILY",
		sourceUrl: profileUrl,
		sourceSnippet: "Recruiter profile",
		whyRelevant: "Works at the target company",
		outreachObjective: "Learn about the internship team",
		relevanceScore: 90,
		matchQuality: "STRONG",
	};
}
