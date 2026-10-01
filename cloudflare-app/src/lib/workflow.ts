import type { AppBindings, CredentialProvider } from "../types";
import { readCredential } from "./credentials";
import { ClientInputError } from "./errors";
import {
	createTrackingSheet,
	latestIncomingReply,
	sendGmailMessage,
	syncProspectToSheet,
} from "./google";
import {
	createDraft,
	discoverWithTavily,
	enrichWithHunter,
	type DiscoveryCriteria,
} from "./providers";
import { readResumeAttachment } from "./resume";
import {
	audit,
	claimDraftForSend,
	enforceRateLimit,
	finishIdempotentOperation,
	getProspect,
	getSettings,
	insertProspects,
	listReplyCandidates,
	patchDraft,
	prospectIdsForDiscoveryUrls,
	setSheetRow,
	setSpreadsheetId,
	startIdempotentOperation,
	transitionProspect,
	type Prospect,
	type UserSettings,
} from "./store";
import { linkProspectsToJob } from "./jobs";
import { sha256 } from "./encoding";
import type { QueueMessage } from "../types";

export interface DiscoverySummary {
	providerReturned: number;
	accepted: number;
	primaryProviderReturned: number;
	primaryAccepted: number;
	fallbackProviderReturned: number;
	fallbackAccepted: number;
	insufficientMatchRejected: number;
	strongAccepted: number;
	broaderAccepted: number;
	inserted: number;
	duplicates: number;
	rejected: number;
}

export async function initializeWorkspace(
	env: AppBindings,
	userId: string,
	requestId: string,
): Promise<{ spreadsheetId: string }> {
	const settings = await getSettings(env, userId);
	if (settings.spreadsheetId) {
		return { spreadsheetId: settings.spreadsheetId };
	}
	const spreadsheetId = await createTrackingSheet(env, userId);
	await setSpreadsheetId(env, userId, spreadsheetId);
	await audit(env, {
		userId,
		action: "WORKSPACE_INITIALIZED",
		entityType: "workspace",
		requestId,
		metadata: { spreadsheetId },
	});
	return { spreadsheetId };
}

export async function discoverProspects(
	env: AppBindings,
	userId: string,
	criteria: DiscoveryCriteria,
	requestId: string,
	jobId?: string,
): Promise<{ prospects: Prospect[]; summary: DiscoverySummary }> {
	await enforceRateLimit(env, {
		userId,
		action: "DISCOVERY",
		limit: 20,
		windowSeconds: 3600,
	});
	const tavilyKey = await readCredential(env, userId, "TAVILY");
	const providerResult = await discoverWithTavily(tavilyKey, {
		...criteria,
		count: Math.min(
			criteria.count,
			Number(env.MAX_DISCOVERY_RESULTS || 20),
		),
	});
	const discovered = providerResult.people;
	const inserted = await insertProspects(env, userId, discovered);
	if (jobId) {
		const linkedProspectIds = new Set([
			...inserted.map((prospect) => prospect.id),
			...(await prospectIdsForDiscoveryUrls(
				env,
				userId,
				discovered,
			)),
		]);
		await linkProspectsToJob(env, userId, jobId, [...linkedProspectIds]);
	}
	await audit(env, {
		userId,
		action: "DISCOVERY_COMPLETED",
		entityType: "prospect",
		requestId,
		metadata: {
		providerReturned: providerResult.providerReturned,
		accepted: discovered.length,
		primaryProviderReturned: providerResult.primaryProviderReturned,
		primaryAccepted: providerResult.primaryAccepted,
		fallbackProviderReturned: providerResult.fallbackProviderReturned,
		fallbackAccepted: providerResult.fallbackAccepted,
		insufficientMatchRejected:
			providerResult.insufficientMatchRejected,
		strongAccepted: providerResult.strongAccepted,
		broaderAccepted: providerResult.broaderAccepted,
		inserted: inserted.length,
		duplicates: discovered.length - inserted.length,
		rejected: Math.max(
			0,
			providerResult.providerReturned - discovered.length,
		),
		},
	});
	for (const prospect of inserted) {
		await env.MAIL_QUEUE.send({
			type: "SYNC_PROSPECT",
			userId,
			prospectId: prospect.id,
		} satisfies QueueMessage);
	}
	return {
		prospects: inserted,
		summary: {
			providerReturned: providerResult.providerReturned,
			accepted: discovered.length,
			primaryProviderReturned: providerResult.primaryProviderReturned,
			primaryAccepted: providerResult.primaryAccepted,
			fallbackProviderReturned: providerResult.fallbackProviderReturned,
			fallbackAccepted: providerResult.fallbackAccepted,
			insufficientMatchRejected:
				providerResult.insufficientMatchRejected,
			strongAccepted: providerResult.strongAccepted,
			broaderAccepted: providerResult.broaderAccepted,
			inserted: inserted.length,
			duplicates: discovered.length - inserted.length,
			rejected: Math.max(
				0,
				providerResult.providerReturned - discovered.length,
			),
		},
	};
}

export async function prepareProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
): Promise<Prospect> {
	await enforceRateLimit(env, {
		userId,
		action: "DRAFT",
		limit: Number(env.MAX_DRAFTS_PER_HOUR || 30),
		windowSeconds: 3600,
	});
	const settings = await getSettings(env, userId);
	assertProfileReady(settings);
	const claimed = await transitionProspect(env, {
		userId,
		prospectId,
		from: ["DISCOVERED", "ERROR"],
		to: "PREPARING",
		updates: {
			contact_approved_at: new Date().toISOString(),
			error_code: "",
			error_message: "",
		},
	});
	if (!claimed) throw new Error("Prospect is not available for preparation.");

	try {
		let prospect = await requiredProspect(env, userId, prospectId);
		let email = prospect.email;
		let confidence = prospect.emailConfidence;
		if (settings.enrichmentProvider === "HUNTER") {
			const hunterKey = await readCredential(env, userId, "HUNTER");
			const enrichment = await enrichWithHunter(hunterKey, prospect);
			email = enrichment.email || email;
			confidence = enrichment.confidence || confidence;
		}
		prospect = { ...prospect, email, emailConfidence: confidence };
		const provider = settings.draftProvider.toUpperCase() as CredentialProvider | "TEMPLATE";
		const apiKey =
			provider === "TEMPLATE"
				? undefined
				: await readCredential(env, userId, provider as CredentialProvider);
		const draft = await createDraft({ prospect, settings, apiKey });
		assertDraftLength(draft.body, settings);
		const draftHash = await hashDraft(email, draft.subject, draft.body);
		const updated = await transitionProspect(env, {
			userId,
			prospectId,
			from: ["PREPARING"],
			to: "DRAFT_READY",
			updates: {
				email,
				email_confidence: confidence,
				subject: draft.subject,
				draft_body: draft.body,
				personalization_notes: draft.personalizationNotes,
				draft_provider: draft.provider,
				draft_model: draft.model,
				draft_version: prospect.draftVersion + 1,
				draft_hash: draftHash,
				error_code: "",
				error_message: "",
			},
		});
		if (!updated) throw new Error("Draft state changed during preparation.");
		await audit(env, {
			userId,
			action: "DRAFT_PREPARED",
			entityType: "prospect",
			entityId: prospectId,
			requestId,
			metadata: {
				provider: draft.provider,
				model: draft.model,
				emailFound: Boolean(email),
			},
		});
		await queueProspectSync(env, userId, prospectId);
		return requiredProspect(env, userId, prospectId);
	} catch (error) {
		await transitionProspect(env, {
			userId,
			prospectId,
			from: ["PREPARING"],
			to: "ERROR",
			updates: {
				error_code: "PREPARATION_FAILED",
				error_message:
					error instanceof Error ? error.message.slice(0, 1000) : "Preparation failed.",
			},
		});
		throw error;
	}
}

export async function regenerateDraft(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
): Promise<Prospect> {
	const moved = await transitionProspect(env, {
		userId,
		prospectId,
		from: ["DRAFT_READY", "ERROR"],
		to: "PREPARING",
		updates: { error_code: "", error_message: "", draft_approved_at: null },
	});
	if (!moved) throw new Error("Draft is not available for regeneration.");
	return prepareFromPreparing(env, userId, prospectId, requestId);
}

async function prepareFromPreparing(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
): Promise<Prospect> {
	try {
		const prospect = await requiredProspect(env, userId, prospectId);
		const settings = await getSettings(env, userId);
		assertProfileReady(settings);
		const provider = settings.draftProvider.toUpperCase() as CredentialProvider | "TEMPLATE";
		const apiKey =
			provider === "TEMPLATE"
				? undefined
				: await readCredential(env, userId, provider as CredentialProvider);
		const draft = await createDraft({ prospect, settings, apiKey });
		assertDraftLength(draft.body, settings);
		const hash = await hashDraft(prospect.email, draft.subject, draft.body);
		await transitionProspect(env, {
			userId,
			prospectId,
			from: ["PREPARING"],
			to: "DRAFT_READY",
			updates: {
				subject: draft.subject,
				draft_body: draft.body,
				personalization_notes: draft.personalizationNotes,
				draft_provider: draft.provider,
				draft_model: draft.model,
				draft_version: prospect.draftVersion + 1,
				draft_hash: hash,
				error_code: "",
				error_message: "",
			},
		});
		await audit(env, {
			userId,
			action: "DRAFT_REGENERATED",
			entityType: "prospect",
			entityId: prospectId,
			requestId,
			metadata: { provider: draft.provider, model: draft.model },
		});
		await queueProspectSync(env, userId, prospectId);
		return requiredProspect(env, userId, prospectId);
	} catch (error) {
		await transitionProspect(env, {
			userId,
			prospectId,
			from: ["PREPARING"],
			to: "ERROR",
			updates: {
				error_code: "DRAFT_FAILED",
				error_message:
					error instanceof Error ? error.message.slice(0, 1000) : "Draft failed.",
			},
		});
		throw error;
	}
}

export async function saveEditedDraft(
	env: AppBindings,
	userId: string,
	prospectId: string,
	input: { email: string; subject: string; body: string },
	requestId: string,
): Promise<number> {
	const email = input.email ? validateEmail(input.email) : "";
	const subject = cleanHeader(input.subject);
	const body = input.body.trim().slice(0, 20000);
	if (!subject || !body) throw new Error("Subject and body are required.");
	const settings = await getSettings(env, userId);
	assertDraftLength(body, settings);
	const version = await patchDraft(env, userId, prospectId, {
		email,
		subject,
		draftBody: body,
		draftHash: await hashDraft(email, subject, body),
	});
	await audit(env, {
		userId,
		action: "DRAFT_EDITED",
		entityType: "prospect",
		entityId: prospectId,
		requestId,
		metadata: { version, emailPresent: Boolean(email) },
	});
	await queueProspectSync(env, userId, prospectId);
	return version;
}

export async function sendApprovedDraft(
	env: AppBindings,
	userId: string,
	input: {
		prospectId: string;
		expectedVersion: number;
		idempotencyKey: string;
		attachResume: boolean;
	},
	requestId: string,
): Promise<Prospect> {
	await enforceRateLimit(env, {
		userId,
		action: "SEND",
		limit: Number(env.MAX_SENDS_PER_DAY || 50),
		windowSeconds: 24 * 60 * 60,
	});
	const prospect = await requiredProspect(env, userId, input.prospectId);
	if (prospect.status !== "DRAFT_READY") {
		throw new Error("Draft is not ready to send.");
	}
	if (prospect.draftVersion !== input.expectedVersion) {
		throw new Error("Draft changed after review. Review the latest version.");
	}
	validateEmail(prospect.email);
	const currentHash = await hashDraft(
		prospect.email,
		prospect.subject,
		prospect.draftBody,
	);
	if (currentHash !== prospect.draftHash) {
		throw new Error("Draft integrity check failed.");
	}
	const resume = input.attachResume
		? await readResumeAttachment(env, userId)
		: null;
	if (input.attachResume && !resume) {
		throw new ClientInputError(
			"Upload a resume in Settings before attaching it to an email.",
		);
	}
	const requestHash = await sha256(
		`${prospect.id}|${prospect.draftVersion}|${prospect.draftHash}|${resume?.uploadedAt || "no-resume"}`,
	);
	const started = await startIdempotentOperation(env, {
		userId,
		operation: "SEND_EMAIL",
		key: input.idempotencyKey,
		requestHash,
	});
	if (started === "EXISTING") {
		throw new Error("This send request was already processed.");
	}
	const claimed = await claimDraftForSend(env, {
		userId,
		prospectId: prospect.id,
		expectedVersion: prospect.draftVersion,
	});
	if (!claimed) {
		await finishIdempotentOperation(env, {
			userId,
			operation: "SEND_EMAIL",
			key: input.idempotencyKey,
			status: "FAILED",
		});
		throw new Error("Draft changed before send.");
	}
	try {
		const settings = await getSettings(env, userId);
		const sent = await sendGmailMessage(env, userId, {
			to: prospect.email,
			subject: prospect.subject,
			body: prospect.draftBody,
			senderName: settings.senderName,
			attachment: resume
				? {
						fileName: resume.fileName,
						mimeType: resume.mimeType,
						data: resume.data,
					}
				: undefined,
		});
		await transitionProspect(env, {
			userId,
			prospectId: prospect.id,
			from: ["SENDING"],
			to: "SENT",
			updates: {
				sent_at: new Date().toISOString(),
				gmail_message_id: sent.messageId,
				gmail_thread_id: sent.threadId,
				error_code: "",
				error_message: "",
			},
		});
		await finishIdempotentOperation(env, {
			userId,
			operation: "SEND_EMAIL",
			key: input.idempotencyKey,
			status: "COMPLETED",
			response: { prospectId: prospect.id, messageId: sent.messageId },
		});
		await audit(env, {
			userId,
			action: "EMAIL_SENT",
			entityType: "prospect",
			entityId: prospect.id,
			requestId,
			metadata: {
				recipientDomain: prospect.email.split("@")[1] || "",
				resumeAttached: Boolean(resume),
			},
		});
		await queueProspectSync(env, userId, prospect.id);
		return requiredProspect(env, userId, prospect.id);
	} catch (error) {
		const uncertain =
			error instanceof Error && error.message === "GMAIL_SEND_UNCERTAIN";
		await transitionProspect(env, {
			userId,
			prospectId: prospect.id,
			from: ["SENDING"],
			to: uncertain ? "SENDING" : "DRAFT_READY",
			updates: {
				error_code: uncertain ? "SEND_UNCERTAIN" : "SEND_FAILED",
				error_message: uncertain
					? "Delivery outcome is uncertain. Check Gmail Sent before taking any action."
					: error instanceof Error
						? error.message.slice(0, 1000)
						: "Send failed.",
			},
		});
		await finishIdempotentOperation(env, {
			userId,
			operation: "SEND_EMAIL",
			key: input.idempotencyKey,
			status: uncertain ? "UNCERTAIN" : "FAILED",
		});
		throw error;
	}
}

export async function rejectProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
): Promise<void> {
	const changed = await transitionProspect(env, {
		userId,
		prospectId,
		from: ["DISCOVERED", "DRAFT_READY", "ERROR"],
		to: "REJECTED",
		updates: { error_code: "", error_message: "" },
	});
	if (!changed) throw new Error("Prospect cannot be rejected in its current state.");
	await audit(env, {
		userId,
		action: "PROSPECT_REJECTED",
		entityType: "prospect",
		entityId: prospectId,
		requestId,
	});
	await queueProspectSync(env, userId, prospectId);
}

export async function syncProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
): Promise<void> {
	const settings = await getSettings(env, userId);
	if (!settings.spreadsheetId) return;
	const prospect = await getProspect(env, userId, prospectId);
	if (!prospect) return;
	const row = await syncProspectToSheet(
		env,
		userId,
		settings.spreadsheetId,
		prospect,
	);
	if (row && !prospect.sheetRow) {
		await setSheetRow(env, userId, prospectId, row);
	}
}

export async function syncRepliesForUser(
	env: AppBindings,
	userId: string,
): Promise<number> {
	const candidates = await listReplyCandidates(env, userId);
	let updated = 0;
	for (const prospect of candidates) {
		if (!prospect.sentAt || !prospect.gmailThreadId) continue;
		const reply = await latestIncomingReply(
			env,
			userId,
			prospect.gmailThreadId,
			prospect.sentAt,
		);
		if (!reply) continue;
		if (
			prospect.lastReplyAt &&
			new Date(reply.receivedAt) <= new Date(prospect.lastReplyAt)
		) {
			continue;
		}
		const changed = await transitionProspect(env, {
			userId,
			prospectId: prospect.id,
			from: ["SENT", "REPLIED"],
			to: "REPLIED",
			updates: {
				last_reply_at: reply.receivedAt,
				reply_from: reply.from,
				reply_snippet: reply.snippet,
			},
		});
		if (changed) {
			updated += 1;
			await queueProspectSync(env, userId, prospect.id);
		}
	}
	return updated;
}

async function queueProspectSync(
	env: AppBindings,
	userId: string,
	prospectId: string,
): Promise<void> {
	await env.MAIL_QUEUE.send({
		type: "SYNC_PROSPECT",
		userId,
		prospectId,
	} satisfies QueueMessage);
}

async function requiredProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
): Promise<Prospect> {
	const prospect = await getProspect(env, userId, prospectId);
	if (!prospect) throw new Error("Prospect not found.");
	return prospect;
}

function validateEmail(value: string): string {
	const email = value.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
		throw new Error("A valid recipient email is required.");
	}
	return email;
}

function cleanHeader(value: string): string {
	return value.replace(/[\r\n]/g, " ").trim().slice(0, 200);
}

function assertDraftLength(body: string, settings: UserSettings): void {
	const words = body.trim().split(/\s+/).filter(Boolean).length;
	if (words > settings.emailWordLimit + 15) {
		throw new Error(
			`Generated email is ${words} words; limit is ${settings.emailWordLimit}.`,
		);
	}
}

function assertProfileReady(settings: UserSettings): void {
	if (!settings.senderName.trim()) {
		throw new ClientInputError(
			"Save your sender name before preparing drafts.",
		);
	}
	const factualContext = settings.personalContext.filter(
		(item) =>
			item.content.trim() &&
			!["tone", "avoid"].includes(item.category.trim().toLowerCase()),
	);
	if (!factualContext.length) {
		throw new ClientInputError(
			"Add at least one factual background, goal, experience, or interest before preparing drafts.",
		);
	}
}

async function hashDraft(
	email: string,
	subject: string,
	body: string,
): Promise<string> {
	return sha256(`${email}\n${subject}\n${body}`);
}
