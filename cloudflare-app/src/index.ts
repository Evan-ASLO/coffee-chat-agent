import { Hono } from "hono";
import { z } from "zod";
import type { AppEnvironment, CredentialProvider, QueueMessage } from "./types";
import {
	authenticatedUser,
	beginGoogleOAuth,
	credentialProvider,
	csrfCookieName,
	handleGoogleCallback,
	logout,
	requireCsrf,
	requireUser,
} from "./lib/auth";
import {
	applySecurityHeaders,
	assertSameOrigin,
	publicError,
	readJson,
} from "./lib/http";
import { logEvent } from "./lib/log";
import {
	audit,
	credentialStatus,
	getSettings,
	listProspects,
	updateSettings,
	usersForReplySync,
} from "./lib/store";
import {
	removeCredential,
	saveCredential,
} from "./lib/credentials";
import {
	discoverProspects,
	initializeWorkspace,
	prepareProspect,
	regenerateDraft,
	rejectProspect,
	saveEditedDraft,
	sendApprovedDraft,
	syncProspect,
	syncRepliesForUser,
} from "./lib/workflow";
import {
	deleteResume,
	getResumeStatus,
	importResume,
	MAX_RESUME_BYTES,
} from "./lib/resume";
import { ClientInputError } from "./lib/errors";

const app = new Hono<AppEnvironment>();

app.use("*", async (c, next) => {
	const requestId = c.req.header("CF-Ray") || crypto.randomUUID();
	c.set("requestId", requestId);
	await next();
	c.res = applySecurityHeaders(c.res);
	c.res.headers.set("X-Request-ID", requestId);
});

app.onError((error, c) => {
	const publicResult = publicError(error);
	logEvent("error", "request_failed", {
		requestId: c.get("requestId"),
		path: c.req.path,
		method: c.req.method,
		code: publicResult.code,
		internalMessage: error instanceof Error ? error.message : "Unknown error",
	});
	return c.json(
		{
			error: publicResult.code,
			message: publicResult.message,
			requestId: c.get("requestId"),
		},
		publicResult.status as 400 | 401 | 403 | 429 | 500,
	);
});

app.get("/api/health", (c) =>
	c.json({ ok: true, service: "coffee-chat-agent", version: "0.1.0" }),
);

app.get("/auth/google/login", (c) => beginGoogleOAuth(c, "login"));

app.get("/auth/google/connect", requireUser, (c) =>
	beginGoogleOAuth(c, "connect", c.get("user")?.id),
);

app.get("/auth/google/callback", (c) => handleGoogleCallback(c));

app.post("/logout", requireUser, async (c) => {
	assertSameOrigin(c);
	await requireCsrf(c);
	await logout(c);
	return c.json({ ok: true });
});

app.get("/api/session", async (c) => {
	const user = await authenticatedUser(c);
	if (!user) return c.json({ authenticated: false });
	c.set("user", user);
	const [settings, credentials, prospects, resume] = await Promise.all([
		getSettings(c.env, user.id),
		credentialStatus(c.env, user.id),
		listProspects(c.env, user.id),
		getResumeStatus(c.env, user.id),
	]);
	return c.json({
		authenticated: true,
		user,
		csrfCookieName: csrfCookieName(c),
		settings,
		credentials,
		prospects,
		resume,
	});
});

app.post("/api/workspace/init", requireUser, async (c) => {
	await protectMutation(c);
	const result = await initializeWorkspace(
		c.env,
		c.get("user")!.id,
		c.get("requestId"),
	);
	return c.json(result);
});

app.put("/api/settings", requireUser, async (c) => {
	await protectMutation(c);
	const input = settingsSchema.parse(await readJson(c));
	await updateSettings(c.env, c.get("user")!.id, {
		senderName: input.senderName,
		discoveryProvider: input.discoveryProvider,
		enrichmentProvider: input.enrichmentProvider,
		draftProvider: input.draftProvider,
		geminiModel: input.geminiModel,
		openAiModel: input.openAiModel,
		anthropicModel: input.anthropicModel,
		outreachGoal: input.outreachGoal,
		emailWordLimit: input.emailWordLimit,
		personalContext: input.personalContext,
		replySyncEnabled: input.replySyncEnabled,
	});
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "SETTINGS_UPDATED",
		entityType: "settings",
		requestId: c.get("requestId"),
		metadata: {
			draftProvider: input.draftProvider,
			discoveryProvider: input.discoveryProvider,
			enrichmentProvider: input.enrichmentProvider,
		},
	});
	return c.json({ ok: true });
});

app.post("/api/resume", requireUser, async (c) => {
	await protectMutation(c);
	const contentLength = Number(c.req.header("Content-Length") || 0);
	if (
		!Number.isFinite(contentLength) ||
		contentLength > MAX_RESUME_BYTES + 256 * 1024
	) {
		throw new ClientInputError("Resume files must be 5 MB or smaller.");
	}
	const body = await c.req.raw.formData();
	const file = body.get("resume");
	if (!(file instanceof File)) {
		throw new ClientInputError("Choose a PDF, DOCX, or TXT resume.");
	}
	const result = await importResume(c.env, c.get("user")!.id, file);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "RESUME_IMPORTED",
		entityType: "resume",
		requestId: c.get("requestId"),
		metadata: {
			mimeType: result.resume.mimeType,
			sizeBytes: result.resume.sizeBytes,
			provider: result.suggestions.provider,
			model: result.suggestions.model,
		},
	});
	return c.json(result);
});

app.delete("/api/resume", requireUser, async (c) => {
	await protectMutation(c);
	await deleteResume(c.env, c.get("user")!.id);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "RESUME_DELETED",
		entityType: "resume",
		requestId: c.get("requestId"),
	});
	return c.json({ ok: true });
});

app.put("/api/credentials/:provider", requireUser, async (c) => {
	await protectMutation(c);
	const provider = credentialProvider(c.req.param("provider"));
	if (provider === "GOOGLE") throw new Error("Google is connected through OAuth.");
	const input = credentialSchema.parse(await readJson(c, 16 * 1024));
	await saveCredential(c.env, {
		userId: c.get("user")!.id,
		provider,
		value: input.value,
	});
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "CREDENTIAL_UPDATED",
		entityType: "credential",
		requestId: c.get("requestId"),
		metadata: { provider },
	});
	return c.json({ configured: true });
});

app.delete("/api/credentials/:provider", requireUser, async (c) => {
	await protectMutation(c);
	const provider = credentialProvider(c.req.param("provider"));
	if (provider === "GOOGLE") throw new Error("Disconnect Google from account settings.");
	await removeCredential(c.env, c.get("user")!.id, provider);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "CREDENTIAL_DELETED",
		entityType: "credential",
		requestId: c.get("requestId"),
		metadata: { provider },
	});
	return c.json({ configured: false });
});

app.post("/api/discovery", requireUser, async (c) => {
	await protectMutation(c);
	const input = discoverySchema.parse(await readJson(c));
	const prospects = await discoverProspects(
		c.env,
		c.get("user")!.id,
		input,
		c.get("requestId"),
	);
	return c.json({ prospects });
});

app.get("/api/prospects", requireUser, async (c) =>
	c.json({ prospects: await listProspects(c.env, c.get("user")!.id) }),
);

app.post("/api/prospects/:id/prepare", requireUser, async (c) => {
	await protectMutation(c);
	const prospect = await prepareProspect(
		c.env,
		c.get("user")!.id,
		uuid.parse(c.req.param("id")),
		c.get("requestId"),
	);
	return c.json({ prospect });
});

app.post("/api/prospects/:id/regenerate", requireUser, async (c) => {
	await protectMutation(c);
	const prospect = await regenerateDraft(
		c.env,
		c.get("user")!.id,
		uuid.parse(c.req.param("id")),
		c.get("requestId"),
	);
	return c.json({ prospect });
});

app.patch("/api/prospects/:id/draft", requireUser, async (c) => {
	await protectMutation(c);
	const input = draftEditSchema.parse(await readJson(c));
	const version = await saveEditedDraft(
		c.env,
		c.get("user")!.id,
		uuid.parse(c.req.param("id")),
		input,
		c.get("requestId"),
	);
	return c.json({ version });
});

app.post("/api/prospects/:id/send", requireUser, async (c) => {
	await protectMutation(c);
	const input = sendSchema.parse(await readJson(c));
	const prospect = await sendApprovedDraft(
		c.env,
		c.get("user")!.id,
		{
			prospectId: uuid.parse(c.req.param("id")),
			expectedVersion: input.expectedVersion,
			idempotencyKey: input.idempotencyKey,
			attachResume: input.attachResume,
		},
		c.get("requestId"),
	);
	return c.json({ prospect });
});

app.post("/api/prospects/:id/reject", requireUser, async (c) => {
	await protectMutation(c);
	await rejectProspect(
		c.env,
		c.get("user")!.id,
		uuid.parse(c.req.param("id")),
		c.get("requestId"),
	);
	return c.json({ ok: true });
});

async function protectMutation(
	c: Parameters<typeof requireCsrf>[0],
): Promise<void> {
	assertSameOrigin(c);
	await requireCsrf(c);
}

const uuid = z.string().uuid();
const shortText = z.string().trim().max(500);
const personalContextItem = z.object({
	category: z.string().trim().min(1).max(120),
	content: z.string().trim().max(5000),
});
const settingsSchema = z.object({
	senderName: z
		.string()
		.trim()
		.min(1, "Enter your sender name.")
		.max(150, "Sender name is too long."),
	discoveryProvider: z.literal("TAVILY"),
	enrichmentProvider: z.enum(["HUNTER", "NONE"]),
	draftProvider: z.enum(["TEMPLATE", "GEMINI", "OPENAI", "ANTHROPIC"]),
	geminiModel: z.string().trim().regex(/^[a-z0-9._:-]+$/i).max(100),
	openAiModel: z.string().trim().regex(/^[a-z0-9._:-]+$/i).max(100),
	anthropicModel: z.string().trim().regex(/^[a-z0-9._:-]+$/i).max(100),
	outreachGoal: z
		.string()
		.trim()
		.min(1, "Enter a specific outreach goal.")
		.max(1000),
	emailWordLimit: z.number().int().min(60).max(250),
	personalContext: z.array(personalContextItem).min(1).max(30),
	replySyncEnabled: z.boolean(),
});
const credentialSchema = z.object({
	value: z.string().trim().min(8).max(10000),
});
const list = z.array(z.string().trim().min(1).max(120)).max(20);
const discoverySchema = z.object({
	roles: list,
	industries: list,
	companies: list,
	locations: list,
	keywords: list,
	seniority: list,
	objective: z.string().trim().max(1000),
	count: z.number().int().min(1).max(20),
});
const draftEditSchema = z.object({
	email: z.string().trim().max(320),
	subject: z.string().trim().min(1).max(200),
	body: z.string().trim().min(1).max(20000),
});
const sendSchema = z.object({
	expectedVersion: z.number().int().min(1),
	idempotencyKey: z.string().uuid(),
	attachResume: z.boolean().default(false),
});

export const worker = {
	fetch: app.fetch,
	async scheduled(
		_controller: ScheduledController,
		env: AppEnvironment["Bindings"],
		context: ExecutionContext,
	): Promise<void> {
		context.waitUntil(
			(async () => {
				const users = await usersForReplySync(env);
				for (const userId of users) {
					await env.MAIL_QUEUE.send({
						type: "SYNC_REPLIES",
						userId,
					} satisfies QueueMessage);
				}
				const now = new Date().toISOString();
				await env.DB.batch([
					env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL").bind(now),
					env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
					env.DB.prepare("DELETE FROM idempotency_keys WHERE expires_at < ?").bind(now),
				]);
			})(),
		);
	},
	async queue(
		batch: MessageBatch<QueueMessage>,
		env: AppEnvironment["Bindings"],
	): Promise<void> {
		for (const message of batch.messages) {
			try {
				if (message.body.type === "SYNC_PROSPECT") {
					await syncProspect(
						env,
						message.body.userId,
						message.body.prospectId,
					);
				} else {
					await syncRepliesForUser(env, message.body.userId);
				}
				message.ack();
			} catch (error) {
				logEvent("error", "queue_message_failed", {
					type: message.body.type,
					userId: message.body.userId,
					message:
						error instanceof Error ? error.message : "Unknown queue error",
				});
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<AppEnvironment["Bindings"], QueueMessage>;

export default worker;
