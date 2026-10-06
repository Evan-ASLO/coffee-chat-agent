import { z } from "zod";
import type { AppBindings } from "../types";
import { ClientInputError } from "./errors";
import { decodeUtf8, fromBase64Url, toBase64Url, utf8 } from "./encoding";

const PAGE_SIZE = 20;
const EVENT_PAGE_SIZE = 25;
const DAY_MS = 86_400_000;
const timestamp = z.string().datetime().refine(
	(value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
	"Use a canonical UTC timestamp.",
);
const actionLabels = {
	BETA_ACCESS_APPROVED: "Beta access approved",
	BETA_ACCESS_REQUEST_APPROVED: "Pending beta request approved",
	BETA_ACCESS_REQUEST_DENIED: "Beta request denied",
	BETA_ACCESS_REVOKED: "Beta access revoked",
	CREDENTIAL_DELETED: "Provider credential removed",
	CREDENTIAL_UPDATED: "Provider credential updated",
	DISCOVERY_COMPLETED: "People search completed",
	DRAFT_EDITED: "Outreach draft edited",
	DRAFT_PREPARED: "Outreach draft prepared",
	DRAFT_REGENERATED: "Outreach draft regenerated",
	EMAIL_SENT: "Outreach email sent",
	JOB_STATE_DELETED: "Job removed from tracker",
	JOB_STATE_UPDATED: "Job saved or application stage changed",
	LEGACY_JOB_STATE_IMPORTED: "Legacy job progress imported",
	LEGACY_JOB_STATE_UNMATCHED: "Legacy import needs a match",
	PROSPECT_REJECTED: "Networking prospect rejected",
	RESUME_DELETED: "Resume deleted",
	RESUME_IMPORTED: "Resume imported",
	SETTINGS_UPDATED: "Profile settings updated",
	WORKSPACE_INITIALIZED: "Google workspace initialized",
	OTHER: "Other recorded operational event",
};
type SafeAction = keyof typeof actionLabels;
const actionSchema = z.enum([
	"ALL",
	...Object.keys(actionLabels) as SafeAction[],
]);

export const ownerActivityQuerySchema = z.object({
	days: z.enum(["7", "28"]).default("28"),
	asOf: timestamp.optional(),
	cursor: z.string().min(1).max(1024).optional(),
}).strict();

export const ownerEventsQuerySchema = ownerActivityQuerySchema.extend({
	userId: z.string().uuid().optional(),
	action: actionSchema.default("ALL"),
}).strict();

type ActivityQuery = z.infer<typeof ownerActivityQuerySchema>;
type EventsQuery = z.infer<typeof ownerEventsQuerySchema>;
const cursorSchema = z.object({
	at: timestamp,
	id: z.string().uuid(),
	scope: z.string().max(256),
}).strict();

const fallbackStatuses = [
	"NOT_NEEDED", "DISABLED", "MISSING_KEY", "SUCCESS", "RATE_LIMITED",
	"SEARCH_LIMITED", "AUTH", "BAD_REQUEST", "UNSUPPORTED", "TIMEOUT",
	"MALFORMED_RESPONSE", "PROVIDER_ERROR",
] as const;
const failureStatuses = fallbackStatuses.filter((status) =>
	!["NOT_NEEDED", "DISABLED", "SUCCESS"].includes(status),
);
const fallbackReasons = [
	"max_uses_exceeded", "invalid_tool_input", "query_too_long",
	"request_too_large", "too_many_requests", "unavailable", "unknown_tool_error",
] as const;
const fallbackProviders = ["GEMINI", "OPENAI", "ANTHROPIC"] as const;
const literals = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const knownActions = Object.keys(actionLabels).filter((action) => action !== "OTHER");

// Project only named operational enums in SQL; never load the metadata document.
const savedStatus = "CASE WHEN json_valid(ae.metadata_json) THEN json_extract(ae.metadata_json, '$.status') END";
const fallbackStatus = "CASE WHEN json_valid(ae.metadata_json) THEN json_extract(ae.metadata_json, '$.fallbackStatus') END";
const categoryConditions = {
	peopleSearches: "ae.action = 'DISCOVERY_COMPLETED'",
	jobSaves: `ae.action = 'JOB_STATE_UPDATED' AND ${savedStatus} = 'SAVED'`,
	trackerChanges: `(ae.action = 'JOB_STATE_UPDATED' AND COALESCE(${savedStatus}, '') <> 'SAVED')
		OR ae.action IN ('JOB_STATE_DELETED', 'LEGACY_JOB_STATE_IMPORTED', 'LEGACY_JOB_STATE_UNMATCHED')`,
	draftChanges: "ae.action IN ('DRAFT_PREPARED', 'DRAFT_REGENERATED', 'DRAFT_EDITED')",
	outreachSends: "ae.action = 'EMAIL_SENT'",
	searchIssues: `ae.action = 'DISCOVERY_COMPLETED' AND ${fallbackStatus} IN (${literals(failureStatuses)})`,
};
const aggregateColumns = [
	"COUNT(ae.id) AS total",
	...Object.entries(categoryConditions).map(([key, condition]) =>
		`COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0) AS ${key}`,
	),
].join(",\n");

export interface ActivityCounts {
	total: number;
	peopleSearches: number;
	jobSaves: number;
	trackerChanges: number;
	draftChanges: number;
	outreachSends: number;
	searchIssues: number;
}

interface AccountRow extends ActivityCounts {
	id: string;
	name: string;
	email: string;
	created_at: string;
	last_event_at: string | null;
}

interface EventRow {
	id: string;
	user_id: string;
	name: string;
	email: string;
	action: string;
	created_at: string;
	fallback_status: unknown;
	fallback_reason: unknown;
	fallback_provider: unknown;
}

export interface OwnerActivity {
	period: { days: 7 | 28; from: string; asOf: string };
	summary: ActivityCounts & { accounts: number; accountsWithEvents: number };
	accounts: Array<{
		id: string;
		name: string;
		email: string;
		registeredAt: string;
		counts: ActivityCounts;
		lastRecordedEventAt: string | null;
	}>;
	pageSize: number;
	nextCursor: string | null;
	actions: Array<{ value: string; label: string }>;
}

export interface OwnerEvents {
	period: OwnerActivity["period"];
	events: Array<{
		id: string;
		user: { id: string; name: string; email: string };
		action: SafeAction;
		label: string;
		recordedAt: string;
		searchFallback: {
			status: typeof fallbackStatuses[number];
			reason: typeof fallbackReasons[number] | null;
			provider: typeof fallbackProviders[number] | null;
		} | null;
	}>;
	pageSize: number;
	nextCursor: string | null;
}

export async function getOwnerActivity(
	env: AppBindings,
	query: ActivityQuery,
	now = new Date(),
): Promise<OwnerActivity> {
	const period = activityPeriod(query, now);
	const scope = cursorScope(period, "accounts");
	const cursor = readCursor(query.cursor, scope, period.asOf);
	const [summary, accounts] = await Promise.all([
		env.DB.prepare(
			`SELECT COUNT(DISTINCT u.id) AS accounts,
			        COUNT(DISTINCT ae.user_id) AS accountsWithEvents, ${aggregateColumns}
			   FROM users u
			   LEFT JOIN audit_events ae
			     ON ae.user_id = u.id AND ae.created_at >= ? AND ae.created_at <= ?
			  WHERE u.deleted_at IS NULL AND u.created_at <= ?`,
		).bind(period.from, period.asOf, period.asOf)
			.first<ActivityCounts & { accounts: number; accountsWithEvents: number }>(),
		env.DB.prepare(
			`WITH page_users AS (
			   SELECT id, name, email, created_at FROM users
			    WHERE deleted_at IS NULL AND created_at <= ?
			      ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
			    ORDER BY created_at DESC, id DESC LIMIT ?
			 )
			 SELECT u.id, u.name, u.email, u.created_at,
			        MAX(ae.created_at) AS last_event_at, ${aggregateColumns}
			   FROM page_users u LEFT JOIN audit_events ae
			     ON ae.user_id = u.id AND ae.created_at >= ? AND ae.created_at <= ?
			  GROUP BY u.id
			  ORDER BY u.created_at DESC, u.id DESC`,
		).bind(
			period.asOf,
			...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
			PAGE_SIZE + 1, period.from, period.asOf,
		).all<AccountRow>(),
	]);
	if (!summary) throw new Error("Owner activity aggregate was unavailable.");
	const page = accounts.results.slice(0, PAGE_SIZE);
	const last = page.at(-1);
	return {
		period,
		summary: {
			...counts(summary),
			accounts: Number(summary.accounts),
			accountsWithEvents: Number(summary.accountsWithEvents),
		},
		accounts: page.map((row) => ({
			...accountIdentity(row.id, row.name, row.email),
			registeredAt: row.created_at,
			counts: counts(row),
			lastRecordedEventAt: row.last_event_at,
		})),
		pageSize: PAGE_SIZE,
		nextCursor: accounts.results.length > PAGE_SIZE && last
			? makeCursor(last.created_at, last.id, scope) : null,
		actions: [
			{ value: "ALL", label: "All recorded actions" },
			...Object.entries(actionLabels).map(([value, label]) => ({ value, label })),
		],
	};
}

export async function getOwnerEvents(
	env: AppBindings,
	query: EventsQuery,
	now = new Date(),
): Promise<OwnerEvents> {
	const period = activityPeriod(query, now);
	const scope = cursorScope(period, `events|${query.userId || ""}|${query.action}`);
	const cursor = readCursor(query.cursor, scope, period.asOf);
	if (cursor && cursor.at < period.from) throw new ClientInputError("Activity cursor is outside this period.");
	const rows = await env.DB.prepare(
		`SELECT ae.id, ae.user_id, u.name, u.email, ae.action, ae.created_at,
		        CASE WHEN ae.action = 'DISCOVERY_COMPLETED' AND json_valid(ae.metadata_json)
		             THEN json_extract(ae.metadata_json, '$.fallbackStatus') END AS fallback_status,
		        CASE WHEN ae.action = 'DISCOVERY_COMPLETED' AND json_valid(ae.metadata_json)
		             THEN json_extract(ae.metadata_json, '$.fallbackReason') END AS fallback_reason,
		        CASE WHEN ae.action = 'DISCOVERY_COMPLETED' AND json_valid(ae.metadata_json)
		             THEN json_extract(ae.metadata_json, '$.fallbackProvider') END AS fallback_provider
		   FROM users u CROSS JOIN audit_events ae
		     ON ae.user_id = u.id AND ae.created_at >= ? AND ae.created_at <= ?
		  WHERE u.deleted_at IS NULL AND u.created_at <= ?
		    ${query.userId ? "AND u.id = ?" : ""}
		    ${query.action === "OTHER" ? `AND ae.action NOT IN (${literals(knownActions)})`
				: query.action !== "ALL" ? "AND ae.action = ?" : ""}
		    ${cursor ? "AND (ae.created_at < ? OR (ae.created_at = ? AND ae.id < ?))" : ""}
		  ORDER BY ae.created_at DESC, ae.id DESC LIMIT ?`,
	).bind(
		period.from, period.asOf, period.asOf,
		...(query.userId ? [query.userId] : []),
		...(query.action !== "ALL" && query.action !== "OTHER" ? [query.action] : []),
		...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
		EVENT_PAGE_SIZE + 1,
	).all<EventRow>();
	const page = rows.results.slice(0, EVENT_PAGE_SIZE);
	const last = page.at(-1);
	return {
		period,
		events: page.map((row) => {
			const action: SafeAction = Object.hasOwn(actionLabels, row.action)
				? row.action as SafeAction : "OTHER";
			const status = enumValue(fallbackStatuses, row.fallback_status);
			return {
				id: row.id,
				user: accountIdentity(row.user_id, row.name, row.email),
				action,
				label: actionLabels[action],
				recordedAt: row.created_at,
				searchFallback: action === "DISCOVERY_COMPLETED" && status ? {
					status,
					reason: enumValue(fallbackReasons, row.fallback_reason),
					provider: enumValue(fallbackProviders, row.fallback_provider),
				} : null,
			};
		}),
		pageSize: EVENT_PAGE_SIZE,
		nextCursor: rows.results.length > EVENT_PAGE_SIZE && last
			? makeCursor(last.created_at, last.id, scope) : null,
	};
}

function activityPeriod(query: ActivityQuery, now: Date): OwnerActivity["period"] {
	const asOf = query.asOf ? new Date(query.asOf) : now;
	if (asOf.getTime() > now.getTime() || asOf.getTime() < now.getTime() - DAY_MS) {
		throw new ClientInputError("Refresh activity to use a snapshot from the past 24 hours.");
	}
	if (query.cursor && !query.asOf) throw new ClientInputError("Activity pagination requires its original snapshot time.");
	const days = query.days === "7" ? 7 : 28;
	const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() - days + 1));
	return { days, from: from.toISOString(), asOf: asOf.toISOString() };
}

function cursorScope(period: OwnerActivity["period"], suffix: string): string {
	return `${period.days}|${period.asOf}|${suffix}`;
}

function readCursor(value: string | undefined, scope: string, asOf: string) {
	if (!value) return null;
	let parsed: z.infer<typeof cursorSchema>;
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor encoding.");
		parsed = cursorSchema.parse(JSON.parse(decodeUtf8(fromBase64Url(value))));
	} catch {
		throw new ClientInputError("Invalid activity cursor. Refresh this view.");
	}
	if (parsed.scope !== scope || parsed.at > asOf) {
		throw new ClientInputError("Activity cursor does not match these filters.");
	}
	return parsed;
}

function makeCursor(at: string, id: string, scope: string): string {
	return toBase64Url(utf8(JSON.stringify({ at, id, scope })));
}

function accountIdentity(id: string, name: string, email: string) {
	return { id, name: name.slice(0, 150), email: email.slice(0, 320) };
}

function counts(row: ActivityCounts): ActivityCounts {
	return {
		total: Number(row.total),
		peopleSearches: Number(row.peopleSearches),
		jobSaves: Number(row.jobSaves),
		trackerChanges: Number(row.trackerChanges),
		draftChanges: Number(row.draftChanges),
		outreachSends: Number(row.outreachSends),
		searchIssues: Number(row.searchIssues),
	};
}

function enumValue<const T extends readonly string[]>(values: T, value: unknown): T[number] | null {
	return typeof value === "string" && values.some((entry) => entry === value)
		? value as T[number] : null;
}
