import type { AppBindings, CredentialProvider } from "../types";
import {
	readCredential,
	readOptionalCredential,
} from "./credentials";
import { ClientInputError, ConflictError } from "./errors";
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
	qualifiedDiscoveryCount,
	selectDiscoveryPeople,
	type DiscoveredPerson,
	type DiscoveryCriteria,
	type DiscoveryProviderResult,
	type DiscoveryRejectionCounts,
} from "./providers";
import { readResumeAttachment } from "./resume";
import {
	apolloEnrichmentEnabled,
	discoveryResearchSources,
	enrichWithApollo,
	personIdentityKey,
	preparationFailure,
	publicSourceUrl,
	researchApprovedPerson,
	validRecipientEmail,
	type EmailLookup,
	type PreparationStage,
} from "./preparation";
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
import {
	discoverWithPeopleSearchFallback,
	PeopleSearchFallbackError,
	anthropicSearchLimit,
	type PeopleSearchErrorCategory,
	type PeopleSearchErrorReason,
	type PeopleSearchFallbackProvider,
} from "./people-search-fallback";

type PeopleSearchFallbackStatus =
	| "NOT_REQUESTED"
	| "DISABLED"
	| "MISSING_KEY"
	| "SUCCESS"
	| PeopleSearchErrorCategory;

export type DiscoveryMode = "TAVILY" | "AI_SUPPLEMENT";

export interface DiscoverySummary {
	rejectionCounts?: DiscoveryRejectionCounts;
	mode: DiscoveryMode;
	tavilyAttempted: boolean;
	providerReturned: number;
	accepted: number;
	primaryProviderReturned: number;
	primaryAccepted: number;
	professionalBioProviderReturned: number;
	professionalBioAccepted: number;
	insufficientMatchRejected: number;
	strongAccepted: number;
	broaderAccepted: number;
	fallbackProvider: "NONE" | PeopleSearchFallbackProvider;
	fallbackAttempted: boolean;
	fallbackStatus: PeopleSearchFallbackStatus;
	fallbackReason: PeopleSearchErrorReason | null;
	fallbackModel: string;
	fallbackHttpStatus: number | null;
	fallbackReturned: number;
	fallbackAccepted: number;
	anthropicSearchMaxUses: 1 | 3;
	jobQualified: number | null;
	jobUnconfirmed: number | null;
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
	authorizedAnthropicSearchMaxUses: number = 1,
	signal?: AbortSignal,
	mode: DiscoveryMode = "TAVILY",
): Promise<{ prospects: Prospect[]; summary: DiscoverySummary }> {
	await enforceRateLimit(env, {
		userId,
		action: "DISCOVERY",
		limit: 20,
		windowSeconds: 3600,
	});
	const requestedCount = Math.min(
		criteria.count,
		Number(env.MAX_DISCOVERY_RESULTS || 20),
	);
	const anthropicSearchMaxUses = mode === "AI_SUPPLEMENT"
		? anthropicSearchLimit(authorizedAnthropicSearchMaxUses) : 1;
	let providerResult: DiscoveryProviderResult | null = null;
	let aiRejectionCounts: DiscoveryRejectionCounts | undefined;
	let people: DiscoveredPerson[] = [];
	let fallbackProvider: "NONE" | PeopleSearchFallbackProvider = "NONE";
	let fallbackAttempted = false;
	let fallbackStatus: PeopleSearchFallbackStatus = "NOT_REQUESTED";
	let fallbackReason: PeopleSearchErrorReason | null = null;
	let fallbackModel = "";
	let fallbackHttpStatus: number | null = null;
	let fallbackReturned = 0;
	if (mode === "TAVILY") {
		const tavilyKey = await readOptionalCredential(env, userId, "TAVILY");
		if (!tavilyKey) {
			throw new ClientInputError("Add your Tavily API key in Settings before searching. Saved contacts remain available without a key.");
		}
		try {
			providerResult = await discoverWithTavily(tavilyKey, {
				...criteria, count: requestedCount,
			}, signal);
			people = providerResult.people;
		} catch {
			signal?.throwIfAborted();
			throw new Error("Tavily discovery failed. No AI search was requested.");
		}
	} else if (mode === "AI_SUPPLEMENT") {
		signal?.throwIfAborted();
		const settings = await getSettings(env, userId);
		fallbackProvider = settings.peopleSearchFallbackProvider;
		if (fallbackProvider === "NONE") {
			fallbackStatus = "DISABLED";
		} else {
			const providerKey = await readOptionalCredential(
				env,
				userId,
				fallbackProvider,
			);
			if (!providerKey) {
				fallbackStatus = "MISSING_KEY";
			} else {
				fallbackAttempted = true;
				fallbackModel = peopleSearchModel(
					settings,
					fallbackProvider,
				);
				try {
					const grounded = await discoverWithPeopleSearchFallback({
						provider: fallbackProvider,
						apiKey: providerKey,
						model: fallbackModel,
						criteria,
						count: requestedCount,
						anthropicSearchMaxUses,
						signal,
					});
					fallbackStatus = grounded.status;
					fallbackReason = grounded.reason;
					fallbackModel = grounded.model;
					fallbackReturned = grounded.returned;
					aiRejectionCounts = grounded.rejectionCounts;
					people = grounded.people;
				} catch (error) {
					if (error instanceof PeopleSearchFallbackError) {
						fallbackStatus = error.category;
						fallbackReason = error.reason;
						fallbackHttpStatus = error.httpStatus;
					} else {
						fallbackStatus = "PROVIDER_ERROR";
					}
				}
			}
		}
	} else {
		throw new ClientInputError("Choose a valid discovery mode.");
	}
	const discovered = selectDiscoveryPeople(people, {
		...criteria, count: requestedCount,
	});
	const jobQualified = criteria.jobContext ? qualifiedDiscoveryCount(discovered, criteria) : null;
	const jobUnconfirmed = jobQualified === null ? null : discovered.length - jobQualified;
	const groundedAccepted = discovered.filter((person) => person.discoveryProvider !== "TAVILY").length;
	const strongAccepted = discovered.filter(
		(person) => person.matchQuality === "STRONG",
	).length;
	const broaderAccepted = discovered.filter(
		(person) => person.matchQuality === "BROADER_COMPANY",
	).length;
	signal?.throwIfAborted();
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
	const summary: DiscoverySummary = {
		mode,
		tavilyAttempted: mode === "TAVILY",
		providerReturned: (providerResult?.providerReturned ?? 0) + fallbackReturned,
		accepted: discovered.length,
		primaryProviderReturned: providerResult?.primaryProviderReturned ?? 0,
		primaryAccepted: providerResult?.primaryAccepted ?? 0,
		professionalBioProviderReturned: providerResult?.fallbackProviderReturned ?? 0,
		professionalBioAccepted: providerResult?.fallbackAccepted ?? 0,
		insufficientMatchRejected: providerResult?.insufficientMatchRejected ?? 0,
		rejectionCounts: providerResult?.rejectionCounts || aiRejectionCounts,
		strongAccepted,
		broaderAccepted,
		fallbackProvider,
		fallbackAttempted,
		fallbackStatus,
		fallbackReason,
		fallbackModel,
		fallbackHttpStatus,
		fallbackReturned,
		fallbackAccepted: groundedAccepted,
		anthropicSearchMaxUses,
		jobQualified,
		jobUnconfirmed,
		inserted: inserted.length,
		duplicates: discovered.length - inserted.length,
		rejected: Math.max(0, (providerResult?.providerReturned ?? 0) -
			(providerResult?.people.length ?? 0) + fallbackReturned - groundedAccepted),
	};
	await audit(env, {
		userId,
		action: "DISCOVERY_COMPLETED",
		entityType: "prospect",
		requestId,
		metadata: { ...summary },
	});
	for (const prospect of inserted) {
		await env.MAIL_QUEUE.send({
			type: "SYNC_PROSPECT",
			userId,
			prospectId: prospect.id,
		} satisfies QueueMessage);
	}
	return { prospects: inserted, summary };
}

function peopleSearchModel(
	settings: UserSettings,
	provider: PeopleSearchFallbackProvider,
): string {
	switch (provider) {
		case "GEMINI":
			return settings.geminiModel;
		case "OPENAI":
			return settings.openAiModel;
		case "ANTHROPIC":
			return settings.anthropicModel;
	}
}

export async function prepareProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
	signal?: AbortSignal,
): Promise<Prospect> {
	return beginPreparation(env, userId, prospectId, requestId, "INITIAL", signal);
}

export async function regenerateDraft(
	env: AppBindings,
	userId: string,
	prospectId: string,
	requestId: string,
	signal?: AbortSignal,
): Promise<Prospect> {
	return beginPreparation(env, userId, prospectId, requestId, "DRAFT", signal);
}

export async function retryPreparationStage(
	env: AppBindings, userId: string, prospectId: string, requestId: string,
	stage: PreparationStage, expectedVersion: number, signal?: AbortSignal,
): Promise<Prospect> {
	return beginPreparation(env, userId, prospectId, requestId, stage, signal, expectedVersion);
}

async function beginPreparation(
	env: AppBindings, userId: string, prospectId: string, requestId: string,
	stage: "INITIAL" | "DRAFT" | PreparationStage, signal?: AbortSignal, expectedVersion?: number,
): Promise<Prospect> {
	const previous = await requiredProspect(env, userId, prospectId);
	if (stage !== "INITIAL" && !previous.contactApprovedAt) {
		throw new ClientInputError("Approve this person before preparing or regenerating outreach.");
	}
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
		from: stage === "INITIAL" ? ["DISCOVERED", "ERROR"] : ["DRAFT_READY", "ERROR"],
		to: "PREPARING",
		expectedVersion: expectedVersion ?? previous.draftVersion,
		updates: {
			contact_approved_at: previous.contactApprovedAt || new Date().toISOString(),
			draft_approved_at: null, error_code: "", error_message: "",
		},
	});
	if (!claimed) throw new ConflictError("This contact changed or is already being prepared. Reload before retrying.");
	try {
		signal?.throwIfAborted();
		const provider = settings.draftProvider.toUpperCase() as CredentialProvider | "TEMPLATE";
		const apiKey =
			provider === "TEMPLATE"
				? undefined
				: await readCredential(env, userId, provider as CredentialProvider);
		let prospect = await requiredProspect(env, userId, prospectId);
		const identityKey = await personIdentityKey(prospect);
		if (stage !== "DRAFT") {
			if (stage === "INITIAL" || stage === "EMAIL") {
				prospect = await prepareEmail(env, prospect, settings, identityKey, stage === "EMAIL", signal);
			}
			signal?.throwIfAborted();
			if (stage === "INITIAL" || stage === "RESEARCH") {
				prospect = await prepareResearch(env, prospect, identityKey, stage === "RESEARCH", signal);
			}
		}
		signal?.throwIfAborted();
		const draft = await createDraft({ prospect, settings, apiKey, signal });
		assertDraftLength(draft.body, settings);
		const hash = await hashDraft(prospect.email, draft.subject, draft.body);
		const updated = await transitionProspect(env, {
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
		if (!updated) throw new ConflictError("Draft state changed during preparation.");
		await audit(env, {
			userId,
			action: stage === "DRAFT" ? "DRAFT_REGENERATED" : "DRAFT_PREPARED",
			entityType: "prospect",
			entityId: prospectId,
			requestId,
			metadata: {
				provider: draft.provider, model: draft.model, emailFound: Boolean(prospect.email),
				enrichmentProvider: prospect.preparation.email?.provider || "NONE",
				enrichmentStatus: prospect.preparation.email?.status || "NOT_REQUESTED",
				researchStatus: prospect.preparation.research?.status || "NOT_REQUESTED",
				researchSources: prospect.preparation.research?.sources.length || 0,
			},
		});
	} catch (error) {
		const latest = await requiredProspect(env, userId, prospectId);
		const retained = Boolean(latest.subject && latest.draftBody && latest.draftVersion);
		const cancelled = signal?.aborted;
		const message = cancelled
			? "Preparation stopped. Completed stages were kept; a started provider request may still be billed."
			: `Draft preparation failed. Saved email and research were kept.${retained ? " The previous draft was also kept." : ""} Check the selected drafting key/model, then explicitly retry the draft.`;
		await transitionProspect(env, {
			userId,
			prospectId,
			from: ["PREPARING"],
			to: retained ? "DRAFT_READY" : "ERROR",
			updates: {
				error_code: cancelled ? "PREPARATION_CANCELLED" : "DRAFT_FAILED",
				error_message: message,
				...(retained ? {
					draft_hash: await hashDraft(latest.email, latest.subject, latest.draftBody),
					draft_version: latest.draftVersion + 1,
				} : {}),
			},
		});
		await audit(env, {
			userId, action: "DRAFT_PREPARATION_FAILED", entityType: "prospect", entityId: prospectId, requestId,
			metadata: { stage, status: preparationFailure(error, signal), previousDraftKept: retained },
		});
		throw new ClientInputError(message);
	}
	await queueProspectSync(env, userId, prospectId);
	return requiredProspect(env, userId, prospectId);
}

async function savePreparation(
	env: AppBindings, prospect: Prospect, updates: Record<string, string | number | null> = {},
): Promise<Prospect> {
	const saved = await transitionProspect(env, {
		userId: prospect.userId, prospectId: prospect.id, from: ["PREPARING"], to: "PREPARING",
		updates: { ...updates, preparation_json: JSON.stringify(prospect.preparation) },
	});
	if (!saved) throw new ConflictError("Preparation state changed.");
	return requiredProspect(env, prospect.userId, prospect.id);
}

async function prepareEmail(
	env: AppBindings, prospect: Prospect, settings: UserSettings, identityKey: string,
	retry: boolean, signal?: AbortSignal,
): Promise<Prospect> {
	const saved = prospect.preparation.email;
	const email = validRecipientEmail(prospect.email);
	if (email && (!saved || (saved.identityKey === identityKey &&
		["MATCHED", "MANUAL"].includes(saved.status) && saved.emailHash === await sha256(email)))) {
		if (saved) return prospect;
		prospect.preparation.email = {
			provider: "MANUAL", status: "MANUAL", identityKey, checkedAt: new Date().toISOString(),
			emailHash: await sha256(email), matchConfidence: null, emailStatus: null, sourceUrl: "",
		};
		return savePreparation(env, prospect);
	}
	if (!retry && saved?.identityKey === identityKey) return prospect;
	const provider = settings.enrichmentProvider;
	if (!["APOLLO", "HUNTER", "NONE"].includes(provider)) throw new ClientInputError("Select a supported email enrichment provider.");
	const lookup: EmailLookup = {
		provider: provider === "NONE" ? "MANUAL" : provider as "APOLLO" | "HUNTER",
		status: provider === "NONE" ? "NO_EMAIL" : "RUNNING", identityKey, checkedAt: new Date().toISOString(),
		emailHash: "", matchConfidence: null, emailStatus: null,
		sourceUrl: publicSourceUrl(prospect.linkedinUrl || prospect.sourceUrl),
	};
	prospect.preparation.email = lookup;
	if (provider === "NONE") return savePreparation(env, prospect);
	if (provider === "APOLLO" && !apolloEnrichmentEnabled(env)) {
		lookup.status = "INTEGRATION_DISABLED";
		return savePreparation(env, prospect);
	}
	prospect = await savePreparation(env, prospect);
	let found = "";
	let confidence = 0;
	try {
		signal?.throwIfAborted();
		const key = await readOptionalCredential(env, prospect.userId, provider as "APOLLO" | "HUNTER");
		if (!key) {
			lookup.status = "MISSING_KEY";
		} else if (provider === "APOLLO") {
			const enrichment = await enrichWithApollo(env, key, prospect, signal);
			Object.assign(lookup, enrichment.lookup);
			found = enrichment.email;
		} else {
			const enrichment = await enrichWithHunter(key, prospect, signal);
			found = enrichment.email;
			confidence = enrichment.confidence;
			lookup.status = found ? "MATCHED" : "NO_EMAIL";
			lookup.emailHash = found ? await sha256(found) : "";
		}
	} catch (error) {
		lookup.status = preparationFailure(error, signal);
	}
	prospect.preparation.email = lookup;
	// An existing manually reviewed recipient is not replaced by a failed lookup.
	return savePreparation(env, prospect, found ? { email: found, email_confidence: confidence } : {});
}

async function prepareResearch(
	env: AppBindings, prospect: Prospect, identityKey: string, retry: boolean, signal?: AbortSignal,
): Promise<Prospect> {
	const saved = prospect.preparation.research;
	if (!retry && saved?.identityKey === identityKey) return prospect;
	prospect.preparation.research = {
		status: "RUNNING", identityKey, checkedAt: new Date().toISOString(),
		sources: saved?.identityKey === identityKey ? saved.sources : discoveryResearchSources(prospect),
	};
	prospect = await savePreparation(env, prospect);
	try {
		signal?.throwIfAborted();
		const key = await readOptionalCredential(env, prospect.userId, "TAVILY");
		if (!key) {
			prospect.preparation.research!.status = "MISSING_KEY";
		} else {
			const result = await researchApprovedPerson(key, prospect, signal);
			if (result.status !== "SOURCED" && saved?.identityKey === identityKey && saved.sources.length) {
				result.sources = saved.sources;
			}
			prospect.preparation.research = result;
		}
	} catch (error) {
		prospect.preparation.research!.status = preparationFailure(error, signal);
	}
	return savePreparation(env, prospect);
}

export async function saveEditedDraft(
	env: AppBindings,
	userId: string,
	prospectId: string,
	input: { email: string; subject: string; body: string; expectedVersion?: number },
	requestId: string,
): Promise<number> {
	const email = input.email ? validateEmail(input.email) : "";
	const subject = cleanHeader(input.subject);
	const body = input.body.trim().slice(0, 20000);
	if (!subject || !body) throw new Error("Subject and body are required.");
	const settings = await getSettings(env, userId);
	assertDraftLength(body, settings);
	const prospect = await requiredProspect(env, userId, prospectId);
	if (email !== prospect.email) {
		prospect.preparation.email = {
			provider: "MANUAL", status: email ? "MANUAL" : "NO_EMAIL",
			identityKey: await personIdentityKey(prospect), checkedAt: new Date().toISOString(),
			emailHash: email ? await sha256(email) : "", matchConfidence: null, emailStatus: null, sourceUrl: "",
		};
	}
	const version = await patchDraft(env, userId, prospectId, {
		email,
		subject,
		draftBody: body,
		draftHash: await hashDraft(email, subject, body),
		preparationJson: JSON.stringify(prospect.preparation),
		expectedVersion: input.expectedVersion ?? prospect.draftVersion,
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
	if (!prospect.contactApprovedAt) throw new ClientInputError("Approve this person before sending outreach.");
	if (prospect.status !== "DRAFT_READY") {
		throw new Error("Draft is not ready to send.");
	}
	if (prospect.draftVersion !== input.expectedVersion) {
		throw new ConflictError("Draft changed after review. Review the latest version.");
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
