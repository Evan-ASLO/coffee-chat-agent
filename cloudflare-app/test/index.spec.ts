import {
	createExecutionContext,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("security boundaries", () => {
	it("returns no authenticated data without a valid session", async () => {
		const response = await SELF.fetch("http://example.com/api/session");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authenticated: false });
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

		const beyondFutureBoundary = await signedIngest(body, nowSeconds + 301);
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
		expect(prospectA).toBeTruthy();
		expect(prospectB).toBeTruthy();

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
				linkedJobs: Array<{ id: string }>;
			}>;
		};
		expect(
			sessionA.prospects.find((prospect) => prospect.id === prospectA!.id)
				?.linkedJobs,
		).toContainEqual(expect.objectContaining({ id: activeJobs[0]!.id }));

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
	return {
		firstName,
		lastName: lastNames.join(" "),
		fullName,
		title: "Recruiter",
		company,
		companyDomain: "example.com",
		location: "Toronto",
		linkedinUrl: `https://www.linkedin.com/in/${fullName
			.toLowerCase()
			.replace(/\s+/g, "-")}-${crypto.randomUUID()}`,
		discoveryProvider: "TAVILY",
		sourceUrl: "https://www.linkedin.com",
		sourceSnippet: "Recruiter profile",
		whyRelevant: "Works at the target company",
		outreachObjective: "Learn about the internship team",
		relevanceScore: 90,
	};
}
