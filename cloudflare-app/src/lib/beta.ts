import type { AppBindings } from "../types";
import { z } from "zod";
import { ClientInputError, ConflictError } from "./errors";
import { openPayload, sealPayload } from "./crypto";

export const BETA_APPROVAL_BATCH_LIMIT = 50;
const SNAPSHOT_LIFETIME_MS = 10 * 60 * 1000;
const SNAPSHOT_PURPOSE = "pending-beta-approval";
const reviewedRequestSchema = z.object({
	id: z.string().uuid(),
	email: z.string().email().max(320),
	updatedAt: z.string().datetime(),
	accessStatus: z.enum(["APPROVED", "REVOKED"]).nullable(),
	accessUpdatedAt: z.string().datetime().nullable(),
}).strict();
type ReviewedRequest = z.infer<typeof reviewedRequestSchema>;
const snapshotSchema = z.object({
	adminUserId: z.string().uuid(),
	expiresAt: z.number().int(),
	requests: z.array(reviewedRequestSchema).max(BETA_APPROVAL_BATCH_LIMIT),
}).strict();

export const bulkBetaApprovalSchema = z.object({
	snapshot: z.string().max(48 * 1024).regex(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/),
	requestIds: z.array(z.string().uuid()).max(BETA_APPROVAL_BATCH_LIMIT)
		.refine((ids) => new Set(ids).size === ids.length, "Duplicate request IDs are not allowed."),
}).strict();

export type BetaAccessMode = "OPEN" | "ALLOWLIST";
export type BetaAccessStatus = "APPROVED" | "REVOKED";
export type BetaRequestStatus = "PENDING" | "APPROVED" | "DENIED";

export interface BetaAccessEntry {
	email: string;
	status: BetaAccessStatus;
	createdAt: string;
	updatedAt: string;
}

export interface BetaAccessRequestEntry {
	id: string;
	email: string;
	status: BetaRequestStatus;
	requestedAt: string;
	updatedAt: string;
}

export function betaAccessMode(env: AppBindings): BetaAccessMode {
	return env.BETA_ACCESS_MODE === "ALLOWLIST" ? "ALLOWLIST" : "OPEN";
}

export function normalizeBetaEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function betaAdminEmails(env: AppBindings): Set<string> {
	return new Set(
		(env.BETA_ADMIN_EMAILS || "")
			.split(",")
			.map(normalizeBetaEmail)
			.filter(Boolean),
	);
}

export function isBetaAdmin(env: AppBindings, email: string): boolean {
	return betaAdminEmails(env).has(normalizeBetaEmail(email));
}

export async function hasBetaAccess(
	env: AppBindings,
	email: string,
): Promise<boolean> {
	if (betaAccessMode(env) === "OPEN") return true;
	const normalizedEmail = normalizeBetaEmail(email);
	if (isBetaAdmin(env, normalizedEmail)) return true;
	const access = await env.DB.prepare(
		"SELECT status FROM beta_access WHERE email = ?",
	)
		.bind(normalizedEmail)
		.first<{ status: BetaAccessStatus }>();
	return access?.status === "APPROVED";
}

export async function requestVerifiedBetaAccess(
	env: AppBindings,
	input: { email: string; googleSub: string },
): Promise<void> {
	if (betaAccessMode(env) !== "ALLOWLIST") return;
	const email = normalizeBetaEmail(input.email);
	if (await hasBetaAccess(env, email)) return;
	const now = new Date().toISOString();
	const existing = await env.DB.prepare(
		`SELECT id FROM beta_access_requests
		  WHERE status = 'PENDING' AND (email = ? OR google_sub = ?)
		  ORDER BY requested_at ASC`,
	)
		.bind(email, input.googleSub)
		.all<{ id: string }>();
	if (existing.results.length) {
		const [primary, ...duplicates] = existing.results;
		await env.DB.batch([
			...duplicates.map((row) =>
				env.DB.prepare(
					"DELETE FROM beta_access_requests WHERE id = ? AND status = 'PENDING'",
				).bind(row.id),
			),
			env.DB.prepare(
				`UPDATE beta_access_requests
				    SET email = ?, google_sub = ?, updated_at = ?
				  WHERE id = ? AND status = 'PENDING'`,
			).bind(email, input.googleSub, now, primary!.id),
		]);
		return;
	}
	try {
		await env.DB.prepare(
			`INSERT INTO beta_access_requests(
			   id, email, google_sub, status, requested_at, updated_at
			 ) VALUES (?, ?, ?, 'PENDING', ?, ?)`,
		)
			.bind(crypto.randomUUID(), email, input.googleSub, now, now)
			.run();
	} catch (error) {
		const raced = await env.DB.prepare(
			`UPDATE beta_access_requests
			    SET email = ?, google_sub = ?, updated_at = ?
			  WHERE status = 'PENDING' AND (email = ? OR google_sub = ?)`,
		)
			.bind(email, input.googleSub, now, email, input.googleSub)
			.run();
		if (!raced.meta.changes) throw error;
	}
}

export async function listBetaAccessAdmin(
	env: AppBindings,
): Promise<{
	requests: BetaAccessRequestEntry[];
	access: BetaAccessEntry[];
	pendingTotal: number;
	listLimit: number;
	approvalBatchLimit: number;
}> {
	const [requests, access, pending] = await Promise.all([
		env.DB.prepare(
			`SELECT id, email, status, requested_at, updated_at
			   FROM beta_access_requests
			  ORDER BY
			    CASE status WHEN 'PENDING' THEN 0 WHEN 'DENIED' THEN 1 ELSE 2 END,
			    updated_at DESC
			  LIMIT 500`,
		).all<{
			id: string;
			email: string;
			status: BetaRequestStatus;
			requested_at: string;
			updated_at: string;
		}>(),
		env.DB.prepare(
			`SELECT email, status, created_at, updated_at
			   FROM beta_access
			  ORDER BY
			    CASE status WHEN 'APPROVED' THEN 0 ELSE 1 END,
			    updated_at DESC
			  LIMIT 500`,
		).all<{
			email: string;
			status: BetaAccessStatus;
			created_at: string;
			updated_at: string;
		}>(),
		env.DB.prepare("SELECT COUNT(*) AS total FROM beta_access_requests WHERE status = 'PENDING'")
			.first<{ total: number }>(),
	]);
	if (!pending) throw new Error("Pending beta count was unavailable.");
	return {
		requests: requests.results.map((row) => ({
			id: row.id,
			email: row.email,
			status: row.status,
			requestedAt: row.requested_at,
			updatedAt: row.updated_at,
		})),
		access: access.results.map((row) => ({
			email: row.email,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		})),
		pendingTotal: Number(pending.total),
		listLimit: 500,
		approvalBatchLimit: BETA_APPROVAL_BATCH_LIMIT,
	};
}

interface PendingReviewRow {
	id: string;
	email: string;
	requested_at: string;
	updated_at: string;
	access_status: BetaAccessStatus | null;
	access_updated_at: string | null;
	previously_denied: number;
}

const pendingReviewColumns = `r.id, r.email, r.requested_at, r.updated_at,
	a.status AS access_status, a.updated_at AS access_updated_at,
	EXISTS (SELECT 1 FROM beta_access_requests old
	         WHERE old.email = r.email AND old.status = 'DENIED') AS previously_denied`;

function reviewedRequest(row: PendingReviewRow): ReviewedRequest {
	return {
		id: row.id,
		email: row.email,
		updatedAt: row.updated_at,
		accessStatus: row.access_status,
		accessUpdatedAt: row.access_updated_at,
	};
}

export async function pendingBetaApprovalSnapshot(
	env: AppBindings,
	adminUserId: string,
	now = Date.now(),
) {
	const results = await env.DB.batch<PendingReviewRow & { total: number }>([
		env.DB.prepare("SELECT COUNT(*) AS total FROM beta_access_requests WHERE status = 'PENDING'"),
		env.DB.prepare(
			`SELECT ${pendingReviewColumns}
			   FROM beta_access_requests r LEFT JOIN beta_access a ON a.email = r.email
			  WHERE r.status = 'PENDING'
			  ORDER BY r.requested_at ASC, r.id ASC LIMIT ?`,
		).bind(BETA_APPROVAL_BATCH_LIMIT),
	]);
	const total = results[0]?.results[0]?.total;
	const rows = results[1]?.results;
	if (total === undefined || !rows) throw new Error("Pending beta snapshot was unavailable.");
	const expiresAt = now + SNAPSHOT_LIFETIME_MS;
	return {
		pendingTotal: Number(total),
		batchLimit: BETA_APPROVAL_BATCH_LIMIT,
		hasMore: total > rows.length,
		expiresAt: new Date(expiresAt).toISOString(),
		requests: rows.map((row) => ({
			id: row.id,
			email: row.email,
			requestedAt: row.requested_at,
			reapplication: row.access_status === "REVOKED" ? "REVOKED_ACCESS"
				: row.previously_denied ? "PREVIOUSLY_DENIED" : null,
		})),
		snapshot: await sealPayload(env, SNAPSHOT_PURPOSE, {
			adminUserId, expiresAt, requests: rows.map(reviewedRequest),
		}),
	};
}

export async function approveBetaSnapshot(
	env: AppBindings,
	input: z.infer<typeof bulkBetaApprovalSchema>,
	adminUserId: string,
	requestId: string,
	now = Date.now(),
) {
	let payload: z.infer<typeof snapshotSchema>;
	try {
		payload = snapshotSchema.parse(await openPayload(env, SNAPSHOT_PURPOSE, input.snapshot));
	} catch {
		throw new ClientInputError("Invalid beta approval snapshot. Review pending requests again.");
	}
	if (payload.adminUserId !== adminUserId) {
		throw new ClientInputError("This approval snapshot belongs to a different owner session.");
	}
	if (payload.expiresAt <= now || payload.expiresAt > now + SNAPSHOT_LIFETIME_MS) {
		throw new ConflictError("This approval review expired. Review pending requests again.");
	}
	const ids = new Set(input.requestIds);
	if (ids.size !== payload.requests.length || payload.requests.some((entry) => !ids.has(entry.id))) {
		throw new ClientInputError("Approve only the exact requests in the reviewed snapshot.");
	}
	return approvePendingRequests(env, payload.requests, adminUserId, requestId);
}

async function approvePendingRequests(
	env: AppBindings,
	requests: ReviewedRequest[],
	adminUserId: string,
	requestId: string,
) {
	if (!requests.length) return { reviewed: 0, approved: [], skipped: [] };
	const now = new Date().toISOString();
	const targets = JSON.stringify(requests.map((request) => ({
		...request, auditId: crypto.randomUUID(),
	})));
	// D1 batch is one transaction. Its audit rows are conditional transition
	// receipts; both writes use only those receipts, not a fresh pending query.
	const results = await env.DB.batch<{ id: string }>([
		env.DB.prepare(
			`INSERT INTO audit_events(id, user_id, action, entity_type, entity_id,
			                          request_id, metadata_json, created_at)
			 SELECT json_extract(j.value, '$.auditId'), ?, 'BETA_ACCESS_REQUEST_APPROVED',
			        'beta_access_request', r.id, ?,
			        json_object('email', r.email, 'source', 'reviewed_pending'), ?
			   FROM json_each(?) j
			   JOIN beta_access_requests r ON r.id = json_extract(j.value, '$.id')
			   LEFT JOIN beta_access a ON a.email = r.email
			  WHERE r.status = 'PENDING'
			    AND r.email = json_extract(j.value, '$.email')
			    AND r.updated_at = json_extract(j.value, '$.updatedAt')
			    AND a.status IS json_extract(j.value, '$.accessStatus')
			    AND a.updated_at IS json_extract(j.value, '$.accessUpdatedAt')`,
		).bind(adminUserId, requestId, now, targets),
		env.DB.prepare(
			`INSERT INTO beta_access(email, status, invited_by_user_id, created_at, updated_at)
			 SELECT json_extract(j.value, '$.email'), 'APPROVED', ?, ?, ?
			   FROM json_each(?) j
			   JOIN audit_events ae ON ae.id = json_extract(j.value, '$.auditId')
			  WHERE ae.user_id = ?
			 ON CONFLICT(email) DO UPDATE SET status = 'APPROVED',
			   invited_by_user_id = excluded.invited_by_user_id, updated_at = excluded.updated_at`,
		).bind(adminUserId, now, now, targets, adminUserId),
		env.DB.prepare(
			`UPDATE beta_access_requests SET status = 'APPROVED', google_sub = '', updated_at = ?
			  WHERE id IN (
			    SELECT ae.entity_id FROM json_each(?) j
			    JOIN audit_events ae ON ae.id = json_extract(j.value, '$.auditId')
			    WHERE ae.user_id = ?
			  ) AND status = 'PENDING'
			 RETURNING id`,
		).bind(now, targets, adminUserId),
	]);
	if (results.some((result) => !result.success) || !results[2]) {
		throw new Error("The pending beta approval transaction did not return a confirmed result.");
	}
	const approved = results[2].results.map((row) => row.id);
	const approvedIds = new Set(approved);
	return {
		reviewed: requests.length,
		approved,
		skipped: requests.filter((entry) => !approvedIds.has(entry.id)).map((entry) => ({
			id: entry.id,
			reason: "ALREADY_HANDLED_OR_CHANGED" as const,
		})),
	};
}

export async function approveBetaRequest(
	env: AppBindings,
	requestId: string,
	adminUserId: string,
	auditRequestId: string,
): Promise<string> {
	const request = await env.DB.prepare(
		`SELECT ${pendingReviewColumns}
		   FROM beta_access_requests r LEFT JOIN beta_access a ON a.email = r.email
		  WHERE r.id = ? AND r.status = 'PENDING'`,
	)
		.bind(requestId)
		.first<PendingReviewRow>();
	if (!request) throw new ConflictError("This request is no longer pending. Refresh beta access.");
	const result = await approvePendingRequests(env, [reviewedRequest(request)], adminUserId, auditRequestId);
	if (!result.approved.length) throw new ConflictError("This request changed before approval. Refresh beta access.");
	return request.email;
}

export async function denyBetaRequest(
	env: AppBindings,
	requestId: string,
): Promise<string> {
	const now = new Date().toISOString();
	const request = await env.DB.prepare(
		`UPDATE beta_access_requests
		    SET status = 'DENIED', google_sub = '', updated_at = ?
		  WHERE id = ? AND status = 'PENDING' RETURNING email`,
	)
		.bind(now, requestId)
		.first<{ email: string }>();
	if (!request) throw new ConflictError("This request is no longer pending. Refresh beta access.");
	return request.email;
}

export async function approveBetaEmail(
	env: AppBindings,
	emailValue: string,
	adminUserId: string,
): Promise<string> {
	const email = normalizeBetaEmail(emailValue);
	const now = new Date().toISOString();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO beta_access(
			   email, status, invited_by_user_id, created_at, updated_at
			 ) VALUES (?, 'APPROVED', ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   status = 'APPROVED',
			   invited_by_user_id = excluded.invited_by_user_id,
			   updated_at = excluded.updated_at`,
		).bind(email, adminUserId, now, now),
		env.DB.prepare(
			`UPDATE beta_access_requests
			    SET status = 'APPROVED', google_sub = '', updated_at = ?
			  WHERE email = ? AND status IN ('PENDING', 'DENIED')`,
		).bind(now, email),
	]);
	return email;
}

export async function revokeBetaEmail(
	env: AppBindings,
	emailValue: string,
	adminUserId: string,
): Promise<string> {
	const email = normalizeBetaEmail(emailValue);
	const now = new Date().toISOString();
	const access = await env.DB.prepare(
		"SELECT email FROM beta_access WHERE email = ?",
	)
		.bind(email)
		.first<{ email: string }>();
	if (!access) throw new ClientInputError("Approved beta access was not found.");
	await env.DB.batch([
		env.DB.prepare(
			`UPDATE beta_access
			    SET status = 'REVOKED', invited_by_user_id = ?, updated_at = ?
			  WHERE email = ?`,
		).bind(adminUserId, now, email),
		env.DB.prepare(
			`UPDATE sessions SET revoked_at = ?
			  WHERE revoked_at IS NULL
			    AND user_id IN (
			      SELECT id FROM users WHERE email = ?
			    )`,
		).bind(now, email),
	]);
	return email;
}
