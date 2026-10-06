import { Hono } from "hono";
import { z } from "zod";
import type {
	AppEnvironment,
	AuthenticatedUser,
	CredentialProvider,
	QueueMessage,
} from "./types";
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
import { ClientInputError, PublicHttpError } from "./lib/errors";
import {
	JOB_STATES,
	deleteJobState,
	getCatalogFreshness,
	getJob,
	importLegacyJobState,
	ingestJobSnapshot,
	jobListQuerySchema,
	jobStateInputSchema,
	legacyJobImportSchema,
	linkProspectToJob,
	listJobs,
	listUserJobStates,
	putJobState,
	unlinkProspectFromJob,
	verifyJobSnapshotRequest,
} from "./lib/jobs";
import {
	approveBetaEmail,
	approveBetaRequest,
	betaAccessMode,
	denyBetaRequest,
	isBetaAdmin,
	listBetaAccessAdmin,
	revokeBetaEmail,
} from "./lib/beta";
import { getUserAnalytics } from "./lib/analytics";
import {
	getOnboarding,
	onboardingInputSchema,
	updateOnboarding,
} from "./lib/onboarding";

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
		publicResult.status as 400 | 401 | 403 | 409 | 413 | 429 | 500,
	);
});

app.get("/api/health", (c) =>
	c.json({ ok: true, service: "coffee-chat-platform", version: "0.2.0" }),
);

app.post("/api/internal/jobs/snapshot", async (c) => {
	const clientKey = c.req.header("CF-Connecting-IP") || "unknown";
	const rateLimit = await c.env.JOBS_INGEST_RATE_LIMITER.limit({
		key: clientKey.slice(0, 128),
	});
	if (!rateLimit.success) {
		throw new Error("Job ingest rate limit exceeded.");
	}
	const verified = await verifyJobSnapshotRequest(c.env, c.req.raw);
	const result = await ingestJobSnapshot(c.env, verified);
	logEvent("info", "job_snapshot_ingested", {
		requestId: c.get("requestId"),
		importRunId: result.importRunId,
		snapshotHash: result.snapshotHash,
		idempotent: result.idempotent,
		activeCount: result.activeCount,
		upsertedCount: result.upsertedCount,
		deactivatedCount: result.deactivatedCount,
	});
	return c.json(result);
});

app.get("/api/jobs", async (c) => {
	const user = await authenticatedUser(c);
	requireBetaCatalogAccess(c.env, user);
	if (user) c.set("user", user);
	const query = jobListQuerySchema.parse(c.req.query());
	return c.json({
		...(await listJobs(c.env, query, user?.id)),
		features: {
			jobOutreachLinking: jobOutreachLinkingEnabled(c.env),
		},
	});
});

app.get("/api/jobs/:id", async (c) => {
	const user = await authenticatedUser(c);
	requireBetaCatalogAccess(c.env, user);
	if (user) c.set("user", user);
	const [job, catalog] = await Promise.all([
		getJob(c.env, jobId.parse(c.req.param("id")), user?.id),
		getCatalogFreshness(c.env),
	]);
	if (!job) throw new ClientInputError("Job was not found.");
	return c.json({
		job,
		catalog,
		features: {
			jobOutreachLinking: jobOutreachLinkingEnabled(c.env),
		},
	});
});

app.get("/auth/google/login", (c) => beginGoogleOAuth(c, "login"));

app.get("/auth/google/request", (c) => beginGoogleOAuth(c, "request"));

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
	const mode = betaAccessMode(c.env);
	if (!user) {
		return c.json({
			authenticated: false,
			betaAccessMode: mode,
		});
	}
	c.set("user", user);
	const [settings, credentials, prospects, resume, onboarding] = await Promise.all([
		getSettings(c.env, user.id),
		credentialStatus(c.env, user.id),
		listProspects(c.env, user.id),
		getResumeStatus(c.env, user.id),
		getOnboarding(c.env, user.id),
	]);
	return c.json({
		authenticated: true,
		betaAccessMode: mode,
		isBetaAdmin: isBetaAdmin(c.env, user.email),
		user,
		csrfCookieName: csrfCookieName(c),
		settings,
		credentials,
		prospects,
		resume,
		onboarding,
	});
});

app.get("/api/onboarding", requireUser, async (c) =>
	c.json({ onboarding: await getOnboarding(c.env, c.get("user")!.id) }),
);

app.put("/api/onboarding", requireUser, async (c) => {
	await protectMutation(c);
	const input = onboardingInputSchema.parse(await readJson(c, 4 * 1024));
	return c.json({
		onboarding: await updateOnboarding(c.env, c.get("user")!.id, input),
	});
});

app.get("/api/analytics", requireUser, async (c) => {
	return c.json(await getUserAnalytics(c.env, c.get("user")!.id));
});

app.get("/api/beta/admin/access", requireUser, async (c) => {
	requireBetaAdmin(c.env, c.get("user")!);
	return c.json(await listBetaAccessAdmin(c.env));
});

app.post(
	"/api/beta/admin/requests/:id/approve",
	requireUser,
	async (c) => {
		await protectMutation(c);
		const admin = c.get("user")!;
		requireBetaAdmin(c.env, admin);
		const requestId = uuid.parse(c.req.param("id"));
		const email = await approveBetaRequest(c.env, requestId, admin.id);
		await audit(c.env, {
			userId: admin.id,
			action: "BETA_ACCESS_REQUEST_APPROVED",
			entityType: "beta_access_request",
			entityId: requestId,
			requestId: c.get("requestId"),
			metadata: { email },
		});
		return c.json({ ok: true });
	},
);

app.post(
	"/api/beta/admin/requests/:id/deny",
	requireUser,
	async (c) => {
		await protectMutation(c);
		const admin = c.get("user")!;
		requireBetaAdmin(c.env, admin);
		const requestId = uuid.parse(c.req.param("id"));
		const email = await denyBetaRequest(c.env, requestId);
		await audit(c.env, {
			userId: admin.id,
			action: "BETA_ACCESS_REQUEST_DENIED",
			entityType: "beta_access_request",
			entityId: requestId,
			requestId: c.get("requestId"),
			metadata: { email },
		});
		return c.json({ ok: true });
	},
);

app.post("/api/beta/admin/access/approve", requireUser, async (c) => {
	await protectMutation(c);
	const admin = c.get("user")!;
	requireBetaAdmin(c.env, admin);
	const input = betaEmailSchema.parse(await readJson(c, 8 * 1024));
	const email = await approveBetaEmail(c.env, input.email, admin.id);
	await audit(c.env, {
		userId: admin.id,
		action: "BETA_ACCESS_APPROVED",
		entityType: "beta_access",
		entityId: email,
		requestId: c.get("requestId"),
		metadata: { email },
	});
	return c.json({ ok: true });
});

app.post("/api/beta/admin/access/revoke", requireUser, async (c) => {
	await protectMutation(c);
	const admin = c.get("user")!;
	requireBetaAdmin(c.env, admin);
	const input = betaEmailSchema.parse(await readJson(c, 8 * 1024));
	const email = await revokeBetaEmail(c.env, input.email, admin.id);
	await audit(c.env, {
		userId: admin.id,
		action: "BETA_ACCESS_REVOKED",
		entityType: "beta_access",
		entityId: email,
		requestId: c.get("requestId"),
		metadata: { email },
	});
	return c.json({ ok: true });
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
	const peopleSearchFallbackProvider =
		input.peopleSearchFallbackProvider ??
		(await getSettings(c.env, c.get("user")!.id))
			.peopleSearchFallbackProvider;
	await updateSettings(c.env, c.get("user")!.id, {
		senderName: input.senderName,
		discoveryProvider: input.discoveryProvider,
		enrichmentProvider: input.enrichmentProvider,
		draftProvider: input.draftProvider,
		geminiModel: input.geminiModel,
		openAiModel: input.openAiModel,
		anthropicModel: input.anthropicModel,
		peopleSearchFallbackProvider,
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
			peopleSearchFallbackProvider,
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
	const { jobId: linkedJobId, anthropicSearchMaxUses, ...submittedCriteria } = input;
	let criteria = submittedCriteria;
	if (linkedJobId) {
		requireJobOutreachLinking(c.env);
		const job = await getJob(c.env, linkedJobId, c.get("user")!.id, true);
		if (!job) throw new ClientInputError("Job was not found.");
		const derived = job.discoveryCriteria;
		criteria = {
			...derived,
			count: submittedCriteria.count,
			objective:
				submittedCriteria.objective ||
				derived.objective,
		};
	}
	const result = await discoverProspects(
		c.env,
		c.get("user")!.id,
		criteria,
		c.get("requestId"),
		linkedJobId,
		anthropicSearchMaxUses,
		c.req.raw.signal,
	);
	return c.json(result);
});

app.get("/api/prospects", requireUser, async (c) =>
	c.json({ prospects: await listProspects(c.env, c.get("user")!.id) }),
);

app.get("/api/jobs/:id/prospects", requireUser, async (c) => {
	requireJobOutreachLinking(c.env);
	const id = jobId.parse(c.req.param("id"));
	const job = await getJob(c.env, id, c.get("user")!.id, true);
	if (!job) throw new ClientInputError("Job was not found.");
	return c.json({ job, userId: c.get("user")!.id, prospects: await listProspects(c.env, c.get("user")!.id, id) });
});

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

app.get("/api/job-states", requireUser, async (c) => {
	const query = jobStateListQuerySchema.parse(c.req.query());
	return c.json(
		await listUserJobStates(c.env, c.get("user")!.id, {
			statuses: query.status
				? query.status.split(",").map((status) => jobState.parse(status))
				: undefined,
			page: query.page,
			pageSize: query.pageSize,
		}),
	);
});

app.put("/api/jobs/:id/state", requireUser, async (c) => {
	await protectMutation(c);
	const id = jobId.parse(c.req.param("id"));
	const input = jobStateInputSchema.parse(await readJson(c, 8 * 1024));
	const job = await putJobState(c.env, c.get("user")!.id, id, input);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "JOB_STATE_UPDATED",
		entityType: "job",
		entityId: id,
		requestId: c.get("requestId"),
		metadata: { status: input.status },
	});
	return c.json({ job });
});

app.delete("/api/jobs/:id/state", requireUser, async (c) => {
	await protectMutation(c);
	const id = jobId.parse(c.req.param("id"));
	await deleteJobState(c.env, c.get("user")!.id, id);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: "JOB_STATE_DELETED",
		entityType: "job",
		entityId: id,
		requestId: c.get("requestId"),
	});
	return c.json({ ok: true });
});

app.post("/api/job-states/import-legacy", requireUser, async (c) => {
	await protectMutation(c);
	const input = legacyJobImportSchema.parse(await readJson(c, 256 * 1024));
	const result = await importLegacyJobState(
		c.env,
		c.get("user")!.id,
		input,
	);
	await audit(c.env, {
		userId: c.get("user")!.id,
		action: result.completed
			? "LEGACY_JOB_STATE_IMPORTED"
			: "LEGACY_JOB_STATE_UNMATCHED",
		entityType: "job_state",
		requestId: c.get("requestId"),
		metadata: { ...result },
	});
	return c.json(result);
});

app.post(
	"/api/jobs/:jobId/prospects/:prospectId",
	requireUser,
	async (c) => {
		await protectMutation(c);
		requireJobOutreachLinking(c.env);
		const linkedJobId = jobId.parse(c.req.param("jobId"));
		const prospectId = uuid.parse(c.req.param("prospectId"));
		await linkProspectToJob(
			c.env,
			c.get("user")!.id,
			linkedJobId,
			prospectId,
		);
		return c.json({ ok: true });
	},
);

app.delete(
	"/api/jobs/:jobId/prospects/:prospectId",
	requireUser,
	async (c) => {
		await protectMutation(c);
		requireJobOutreachLinking(c.env);
		await unlinkProspectFromJob(
			c.env,
			c.get("user")!.id,
			jobId.parse(c.req.param("jobId")),
			uuid.parse(c.req.param("prospectId")),
		);
		return c.json({ ok: true });
	},
);

async function protectMutation(
	c: Parameters<typeof requireCsrf>[0],
): Promise<void> {
	assertSameOrigin(c);
	await requireCsrf(c);
}

const uuid = z.string().uuid();
const jobId = z.string().regex(/^[a-f0-9]{64}$/);
const jobState = z.enum(JOB_STATES);
const betaEmailSchema = z
	.object({
		email: z.string().trim().email().max(320),
	})
	.strict();
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
	peopleSearchFallbackProvider: z.enum([
		"NONE",
		"GEMINI",
		"OPENAI",
		"ANTHROPIC",
	]).optional(),
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
	jobId: jobId.optional(),
	anthropicSearchMaxUses: z.union([z.literal(1), z.literal(3)]).default(1),
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
					env.DB.prepare("DELETE FROM job_ingest_replays WHERE expires_at < ?").bind(now),
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

const jobStateListQuerySchema = z
	.object({
		status: z.string().trim().max(200).default(""),
		page: z.coerce.number().int().min(1).max(100).default(1),
		pageSize: z.coerce.number().int().min(1).max(100).default(50),
	})
	.strict();

function jobOutreachLinkingEnabled(
	env: AppEnvironment["Bindings"],
): boolean {
	return env.ENABLE_JOB_OUTREACH_LINKING?.trim().toLowerCase() === "true";
}

function requireJobOutreachLinking(
	env: AppEnvironment["Bindings"],
): void {
	if (jobOutreachLinkingEnabled(env)) return;
	throw new PublicHttpError(
		"Job-linked outreach is disabled.",
		403,
		"FEATURE_DISABLED",
		"Job-linked outreach is not enabled yet.",
	);
}

function requireBetaCatalogAccess(
	env: AppEnvironment["Bindings"],
	user: AuthenticatedUser | null,
): void {
	if (betaAccessMode(env) === "OPEN" || user) return;
	throw new PublicHttpError(
		"Beta access is required.",
		401,
		"BETA_ACCESS_REQUIRED",
		"Sign in with an approved private-beta account.",
	);
}

function requireBetaAdmin(
	env: AppEnvironment["Bindings"],
	user: AuthenticatedUser,
): void {
	if (isBetaAdmin(env, user.email)) return;
	throw new PublicHttpError(
		"Beta admin access is required.",
		403,
		"FORBIDDEN",
		"The request was rejected.",
	);
}
