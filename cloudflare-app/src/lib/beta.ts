import type { AppBindings } from "../types";
import { ClientInputError } from "./errors";

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
}> {
	const [requests, access] = await Promise.all([
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
	]);
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
	};
}

export async function approveBetaRequest(
	env: AppBindings,
	requestId: string,
	adminUserId: string,
): Promise<string> {
	const request = await env.DB.prepare(
		"SELECT email FROM beta_access_requests WHERE id = ?",
	)
		.bind(requestId)
		.first<{ email: string }>();
	if (!request) throw new ClientInputError("Access request was not found.");
	await approveBetaEmail(env, request.email, adminUserId);
	return request.email;
}

export async function denyBetaRequest(
	env: AppBindings,
	requestId: string,
): Promise<string> {
	const now = new Date().toISOString();
	const request = await env.DB.prepare(
		"SELECT email FROM beta_access_requests WHERE id = ? AND status = 'PENDING'",
	)
		.bind(requestId)
		.first<{ email: string }>();
	if (!request) throw new ClientInputError("Pending access request was not found.");
	await env.DB.prepare(
		`UPDATE beta_access_requests
		    SET status = 'DENIED', google_sub = '', updated_at = ?
		  WHERE id = ? AND status = 'PENDING'`,
	)
		.bind(now, requestId)
		.run();
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
