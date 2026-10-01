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
import { upsertUser } from "../src/lib/db";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";

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
