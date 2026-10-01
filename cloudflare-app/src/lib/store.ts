import type {
	AppBindings,
	AuthenticatedUser,
	CredentialProvider,
	ProspectStatus,
} from "../types";
import { safeMetadata } from "./log";
import { prospectJobLinks } from "./jobs";

export interface PersonalContextItem {
	category: string;
	content: string;
}

export interface UserSettings {
	userId: string;
	senderName: string;
	discoveryProvider: string;
	enrichmentProvider: string;
	draftProvider: string;
	geminiModel: string;
	openAiModel: string;
	anthropicModel: string;
	outreachGoal: string;
	emailWordLimit: number;
	personalContext: PersonalContextItem[];
	spreadsheetId: string;
	replySyncEnabled: boolean;
}

export interface Prospect {
	id: string;
	userId: string;
	status: ProspectStatus;
	firstName: string;
	lastName: string;
	fullName: string;
	title: string;
	company: string;
	companyDomain: string;
	location: string;
	linkedinUrl: string;
	email: string;
	emailConfidence: number;
	discoveryProvider: string;
	sourceUrl: string;
	sourceSnippet: string;
	whyRelevant: string;
	outreachObjective: string;
	relevanceScore: number;
	matchQuality: "STRONG" | "BROADER_COMPANY";
	subject: string;
	draftBody: string;
	personalizationNotes: string;
	draftProvider: string;
	draftModel: string;
	draftVersion: number;
	draftHash: string;
	contactApprovedAt: string | null;
	draftApprovedAt: string | null;
	sentAt: string | null;
	lastReplyAt: string | null;
	replyFrom: string;
	replySnippet: string;
	gmailThreadId: string;
	gmailMessageId: string;
	sheetRow: number | null;
	errorCode: string;
	errorMessage: string;
	createdAt: string;
	updatedAt: string;
	linkedJobs: Array<{ id: string; title: string; company: string }>;
}

interface ProspectRow {
	id: string;
	user_id: string;
	status: ProspectStatus;
	first_name: string;
	last_name: string;
	full_name: string;
	title: string;
	company: string;
	company_domain: string;
	location: string;
	linkedin_url: string;
	email: string;
	email_confidence: number;
	discovery_provider: string;
	source_url: string;
	source_snippet: string;
	why_relevant: string;
	outreach_objective: string;
	relevance_score: number;
	match_quality: "STRONG" | "BROADER_COMPANY";
	subject: string;
	draft_body: string;
	personalization_notes: string;
	draft_provider: string;
	draft_model: string;
	draft_version: number;
	draft_hash: string;
	contact_approved_at: string | null;
	draft_approved_at: string | null;
	sent_at: string | null;
	last_reply_at: string | null;
	reply_from: string;
	reply_snippet: string;
	gmail_thread_id: string;
	gmail_message_id: string;
	sheet_row: number | null;
	error_code: string;
	error_message: string;
	created_at: string;
	updated_at: string;
}

export async function getSettings(
	env: AppBindings,
	userId: string,
): Promise<UserSettings> {
	const row = await env.DB.prepare(
		`SELECT user_id, sender_name, discovery_provider, enrichment_provider,
		        draft_provider, gemini_model, openai_model, anthropic_model,
		        outreach_goal, email_word_limit, personal_context_json,
		        spreadsheet_id, reply_sync_enabled
		   FROM user_settings WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{
			user_id: string;
			sender_name: string;
			discovery_provider: string;
			enrichment_provider: string;
			draft_provider: string;
			gemini_model: string;
			openai_model: string;
			anthropic_model: string;
			outreach_goal: string;
			email_word_limit: number;
			personal_context_json: string;
			spreadsheet_id: string | null;
			reply_sync_enabled: number;
		}>();
	if (!row) throw new Error("User settings were not found.");
	return {
		userId: row.user_id,
		senderName: row.sender_name,
		discoveryProvider: row.discovery_provider,
		enrichmentProvider: row.enrichment_provider,
		draftProvider: row.draft_provider,
		geminiModel: row.gemini_model,
		openAiModel: row.openai_model,
		anthropicModel: row.anthropic_model,
		outreachGoal: row.outreach_goal,
		emailWordLimit: row.email_word_limit,
		personalContext: parseContext(row.personal_context_json),
		spreadsheetId: row.spreadsheet_id || "",
		replySyncEnabled: row.reply_sync_enabled === 1,
	};
}

export async function updateSettings(
	env: AppBindings,
	userId: string,
	settings: Omit<UserSettings, "userId" | "spreadsheetId">,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE user_settings SET
		   sender_name = ?, discovery_provider = ?, enrichment_provider = ?,
		   draft_provider = ?, gemini_model = ?, openai_model = ?,
		   anthropic_model = ?, outreach_goal = ?, email_word_limit = ?,
		   personal_context_json = ?, reply_sync_enabled = ?, updated_at = ?
		 WHERE user_id = ?`,
	)
		.bind(
			settings.senderName,
			settings.discoveryProvider,
			settings.enrichmentProvider,
			settings.draftProvider,
			settings.geminiModel,
			settings.openAiModel,
			settings.anthropicModel,
			settings.outreachGoal,
			settings.emailWordLimit,
			JSON.stringify(settings.personalContext),
			settings.replySyncEnabled ? 1 : 0,
			new Date().toISOString(),
			userId,
		)
		.run();
}

export async function setSpreadsheetId(
	env: AppBindings,
	userId: string,
	spreadsheetId: string,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE user_settings SET spreadsheet_id = ?, updated_at = ? WHERE user_id = ?",
	)
		.bind(spreadsheetId, new Date().toISOString(), userId)
		.run();
}

export async function listProspects(
	env: AppBindings,
	userId: string,
): Promise<Prospect[]> {
	const [result, links] = await Promise.all([
		env.DB.prepare(
			"SELECT * FROM prospects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500",
		)
			.bind(userId)
			.all<ProspectRow>(),
		prospectJobLinks(env, userId),
	]);
	return result.results.map((row) => {
		const prospect = mapProspect(row);
		prospect.linkedJobs = links.get(prospect.id) ?? [];
		return prospect;
	});
}

export async function getProspect(
	env: AppBindings,
	userId: string,
	prospectId: string,
): Promise<Prospect | null> {
	const row = await env.DB.prepare(
		"SELECT * FROM prospects WHERE id = ? AND user_id = ?",
	)
		.bind(prospectId, userId)
		.first<ProspectRow>();
	return row ? mapProspect(row) : null;
}

export async function prospectIdsForDiscoveryUrls(
	env: AppBindings,
	userId: string,
	prospects: Array<{ linkedinUrl: string; sourceUrl: string }>,
): Promise<string[]> {
	const linkedinUrls = Array.from(
		new Set(
			prospects.map((item) => item.linkedinUrl.trim()).filter(Boolean),
		),
	).slice(0, 20);
	const sourceUrls = Array.from(
		new Set(
			prospects.map((item) => item.sourceUrl.trim()).filter(Boolean),
		),
	).slice(0, 20);
	const clauses: string[] = [];
	const bindings: string[] = [userId];
	if (linkedinUrls.length) {
		clauses.push(
			`linkedin_url IN (${linkedinUrls.map(() => "?").join(", ")})`,
		);
		bindings.push(...linkedinUrls);
	}
	if (sourceUrls.length) {
		clauses.push(
			`source_url IN (${sourceUrls.map(() => "?").join(", ")})`,
		);
		bindings.push(...sourceUrls);
	}
	if (!clauses.length) return [];
	const result = await env.DB.prepare(
		`SELECT id FROM prospects
		  WHERE user_id = ? AND (${clauses.join(" OR ")})`,
	)
		.bind(...bindings)
		.all<{ id: string }>();
	return result.results.map((row) => row.id);
}

export async function insertProspects(
	env: AppBindings,
	userId: string,
	prospects: Array<
		Pick<
			Prospect,
			| "firstName"
			| "lastName"
			| "fullName"
			| "title"
			| "company"
			| "companyDomain"
			| "location"
			| "linkedinUrl"
			| "discoveryProvider"
			| "sourceUrl"
			| "sourceSnippet"
			| "whyRelevant"
			| "outreachObjective"
			| "relevanceScore"
			| "matchQuality"
		>
	>,
): Promise<Prospect[]> {
	const inserted: Prospect[] = [];
	for (const item of prospects) {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const result = await env.DB.prepare(
			`INSERT OR IGNORE INTO prospects(
			   id, user_id, status, first_name, last_name, full_name, title,
			   company, company_domain, location, linkedin_url, discovery_provider,
			   source_url, source_snippet, why_relevant, outreach_objective,
			   relevance_score, match_quality, created_at, updated_at
			 ) VALUES (?, ?, 'DISCOVERED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				id,
				userId,
				item.firstName,
				item.lastName,
				item.fullName,
				item.title,
				item.company,
				item.companyDomain,
				item.location,
				item.linkedinUrl,
				item.discoveryProvider,
				item.sourceUrl,
				item.sourceSnippet,
				item.whyRelevant,
				item.outreachObjective,
				item.relevanceScore,
				item.matchQuality,
				now,
				now,
			)
			.run();
		if (result.meta.changes) {
			const prospect = await getProspect(env, userId, id);
			if (prospect) inserted.push(prospect);
		}
	}
	return inserted;
}

export async function transitionProspect(
	env: AppBindings,
	input: {
		userId: string;
		prospectId: string;
		from: ProspectStatus[];
		to: ProspectStatus;
		updates?: Record<string, string | number | null>;
	},
): Promise<boolean> {
	const allowedColumns = new Set([
		"email",
		"email_confidence",
		"subject",
		"draft_body",
		"personalization_notes",
		"draft_provider",
		"draft_model",
		"draft_version",
		"draft_hash",
		"contact_approved_at",
		"draft_approved_at",
		"sent_at",
		"last_reply_at",
		"reply_from",
		"reply_snippet",
		"gmail_thread_id",
		"gmail_message_id",
		"sheet_row",
		"error_code",
		"error_message",
	]);
	const updateEntries = Object.entries(input.updates ?? {});
	for (const [column] of updateEntries) {
		if (!allowedColumns.has(column)) {
			throw new Error(`Unsupported prospect update column: ${column}`);
		}
	}
	const assignments = [
		"status = ?",
		...updateEntries.map(([column]) => `${column} = ?`),
		"updated_at = ?",
	].join(", ");
	const placeholders = input.from.map(() => "?").join(", ");
	const values = [
		input.to,
		...updateEntries.map(([, value]) => value),
		new Date().toISOString(),
		input.prospectId,
		input.userId,
		...input.from,
	];
	const result = await env.DB.prepare(
		`UPDATE prospects SET ${assignments}
		  WHERE id = ? AND user_id = ? AND status IN (${placeholders})`,
	)
		.bind(...values)
		.run();
	return result.meta.changes === 1;
}

export async function patchDraft(
	env: AppBindings,
	userId: string,
	prospectId: string,
	updates: {
		email: string;
		subject: string;
		draftBody: string;
		draftHash: string;
	},
): Promise<number> {
	const now = new Date().toISOString();
	const result = await env.DB.prepare(
		`UPDATE prospects SET email = ?, subject = ?, draft_body = ?,
		        draft_hash = ?, draft_version = draft_version + 1,
		        draft_approved_at = NULL, error_code = '', error_message = '',
		        updated_at = ?
		  WHERE id = ? AND user_id = ? AND status = 'DRAFT_READY'`,
	)
		.bind(
			updates.email,
			updates.subject,
			updates.draftBody,
			updates.draftHash,
			now,
			prospectId,
			userId,
		)
		.run();
	if (result.meta.changes !== 1) throw new Error("Draft was not found.");
	const row = await env.DB.prepare(
		"SELECT draft_version FROM prospects WHERE id = ? AND user_id = ?",
	)
		.bind(prospectId, userId)
		.first<{ draft_version: number }>();
	return row?.draft_version ?? 0;
}

export async function claimDraftForSend(
	env: AppBindings,
	input: {
		userId: string;
		prospectId: string;
		expectedVersion: number;
	},
): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE prospects SET
		   status = 'SENDING', draft_approved_at = ?, error_code = '',
		   error_message = '', updated_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'DRAFT_READY'
		   AND draft_version = ?`,
	)
		.bind(
			new Date().toISOString(),
			new Date().toISOString(),
			input.prospectId,
			input.userId,
			input.expectedVersion,
		)
		.run();
	return result.meta.changes === 1;
}

export async function setSheetRow(
	env: AppBindings,
	userId: string,
	prospectId: string,
	row: number,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE prospects SET sheet_row = ?, updated_at = ? WHERE id = ? AND user_id = ?",
	)
		.bind(row, new Date().toISOString(), prospectId, userId)
		.run();
}

export async function listReplyCandidates(
	env: AppBindings,
	userId: string,
): Promise<Prospect[]> {
	const result = await env.DB.prepare(
		`SELECT * FROM prospects
		  WHERE user_id = ? AND status IN ('SENT', 'REPLIED')
		    AND sent_at > ?
		  ORDER BY sent_at DESC LIMIT 500`,
	)
		.bind(
			userId,
			new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
		)
		.all<ProspectRow>();
	return result.results.map(mapProspect);
}

export async function audit(
	env: AppBindings,
	input: {
		userId: string;
		action: string;
		entityType: string;
		entityId?: string;
		requestId: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO audit_events(
		   id, user_id, action, entity_type, entity_id, request_id,
		   metadata_json, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			input.userId,
			input.action,
			input.entityType,
			input.entityId ?? null,
			input.requestId,
			JSON.stringify(safeMetadata(input.metadata ?? {})),
			new Date().toISOString(),
		)
		.run();
}

export async function credentialStatus(
	env: AppBindings,
	userId: string,
): Promise<Record<CredentialProvider, { configured: boolean; hint: string }>> {
	const result = await env.DB.prepare(
		`SELECT provider, key_hint FROM encrypted_credentials
		  WHERE user_id = ? AND kind = 'API_KEY'`,
	)
		.bind(userId)
		.all<{ provider: CredentialProvider; key_hint: string }>();
	const output = Object.fromEntries(
		(["TAVILY", "HUNTER", "GEMINI", "OPENAI", "ANTHROPIC", "GOOGLE"] as CredentialProvider[]).map(
			(provider) => [provider, { configured: false, hint: "" }],
		),
	) as Record<CredentialProvider, { configured: boolean; hint: string }>;
	for (const row of result.results) {
		output[row.provider] = { configured: true, hint: row.key_hint };
	}
	const google = await env.DB.prepare(
		`SELECT key_hint FROM encrypted_credentials
		  WHERE user_id = ? AND kind = 'OAUTH_REFRESH_TOKEN' AND provider = 'GOOGLE'`,
	)
		.bind(userId)
		.first<{ key_hint: string }>();
	output.GOOGLE = {
		configured: Boolean(google),
		hint: google?.key_hint ?? "",
	};
	return output;
}

export async function enforceRateLimit(
	env: AppBindings,
	input: {
		userId: string;
		action: string;
		limit: number;
		windowSeconds: number;
	},
): Promise<void> {
	const now = Date.now();
	const startMs = Math.floor(now / (input.windowSeconds * 1000)) *
		input.windowSeconds *
		1000;
	const windowStart = new Date(startMs).toISOString();
	const expiresAt = new Date(startMs + input.windowSeconds * 1000).toISOString();
	await env.DB.prepare(
		`INSERT INTO rate_limits(user_id, action, window_start, count, expires_at)
		 VALUES (?, ?, ?, 1, ?)
		 ON CONFLICT(user_id, action, window_start)
		 DO UPDATE SET count = count + 1`,
	)
		.bind(input.userId, input.action, windowStart, expiresAt)
		.run();
	const row = await env.DB.prepare(
		`SELECT count FROM rate_limits
		  WHERE user_id = ? AND action = ? AND window_start = ?`,
	)
		.bind(input.userId, input.action, windowStart)
		.first<{ count: number }>();
	if ((row?.count ?? 0) > input.limit) {
		throw new Error(`${input.action} rate limit exceeded.`);
	}
}

export async function startIdempotentOperation(
	env: AppBindings,
	input: {
		userId: string;
		operation: string;
		key: string;
		requestHash: string;
	},
): Promise<"STARTED" | "EXISTING"> {
	const now = new Date();
	const result = await env.DB.prepare(
		`INSERT OR IGNORE INTO idempotency_keys(
		   user_id, operation, idempotency_key, request_hash, status,
		   expires_at, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 'STARTED', ?, ?, ?)`,
	)
		.bind(
			input.userId,
			input.operation,
			input.key,
			input.requestHash,
			new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
			now.toISOString(),
			now.toISOString(),
		)
		.run();
	if (result.meta.changes === 1) return "STARTED";
	const existing = await env.DB.prepare(
		`SELECT request_hash FROM idempotency_keys
		  WHERE user_id = ? AND operation = ? AND idempotency_key = ?`,
	)
		.bind(input.userId, input.operation, input.key)
		.first<{ request_hash: string }>();
	if (existing?.request_hash !== input.requestHash) {
		throw new Error("Idempotency key was reused for a different request.");
	}
	return "EXISTING";
}

export async function finishIdempotentOperation(
	env: AppBindings,
	input: {
		userId: string;
		operation: string;
		key: string;
		status: "COMPLETED" | "FAILED" | "UNCERTAIN";
		response?: Record<string, unknown>;
	},
): Promise<void> {
	await env.DB.prepare(
		`UPDATE idempotency_keys
		    SET status = ?, response_json = ?, updated_at = ?
		  WHERE user_id = ? AND operation = ? AND idempotency_key = ?`,
	)
		.bind(
			input.status,
			input.response ? JSON.stringify(input.response) : null,
			new Date().toISOString(),
			input.userId,
			input.operation,
			input.key,
		)
		.run();
}

export async function usersForReplySync(
	env: AppBindings,
): Promise<string[]> {
	const result = await env.DB.prepare(
		`SELECT DISTINCT p.user_id
		   FROM prospects p
		   JOIN user_settings s ON s.user_id = p.user_id
		  WHERE p.status IN ('SENT', 'REPLIED')
		    AND s.reply_sync_enabled = 1
		    AND p.sent_at > ?`,
	)
		.bind(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
		.all<{ user_id: string }>();
	return result.results.map((row) => row.user_id);
}

function parseContext(value: string): PersonalContextItem[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter(
					(item): item is PersonalContextItem =>
						typeof item?.category === "string" &&
						typeof item?.content === "string",
				)
			: [];
	} catch {
		return [];
	}
}

function mapProspect(row: ProspectRow): Prospect {
	return {
		id: row.id,
		userId: row.user_id,
		status: row.status,
		firstName: row.first_name,
		lastName: row.last_name,
		fullName: row.full_name,
		title: row.title,
		company: row.company,
		companyDomain: row.company_domain,
		location: row.location,
		linkedinUrl: row.linkedin_url,
		email: row.email,
		emailConfidence: row.email_confidence,
		discoveryProvider: row.discovery_provider,
		sourceUrl: row.source_url,
		sourceSnippet: row.source_snippet,
		whyRelevant: row.why_relevant,
		outreachObjective: row.outreach_objective,
		relevanceScore: row.relevance_score,
		matchQuality: row.match_quality,
		subject: row.subject,
		draftBody: row.draft_body,
		personalizationNotes: row.personalization_notes,
		draftProvider: row.draft_provider,
		draftModel: row.draft_model,
		draftVersion: row.draft_version,
		draftHash: row.draft_hash,
		contactApprovedAt: row.contact_approved_at,
		draftApprovedAt: row.draft_approved_at,
		sentAt: row.sent_at,
		lastReplyAt: row.last_reply_at,
		replyFrom: row.reply_from,
		replySnippet: row.reply_snippet,
		gmailThreadId: row.gmail_thread_id,
		gmailMessageId: row.gmail_message_id,
		sheetRow: row.sheet_row,
		errorCode: row.error_code,
		errorMessage: row.error_message,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		linkedJobs: [],
	};
}
