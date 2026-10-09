import { z } from "zod";
import type { AppBindings } from "../types";
import { isBetaAdmin, normalizeBetaEmail } from "./beta";
import { ClientInputError, ConflictError } from "./errors";
import { ProviderHttpError, fetchJson } from "./fetch";
import { googleAccessToken, encodeMimeMessage } from "./google";
import { enforceRateLimit } from "./store";

export const betaNotificationInput = z.object({ notifyEmail: z.boolean().default(false) }).strict();
export function acceptanceTemplate() {
	return {
		subject: "You're approved for Internship & Coffee Chat",
		body: "Your access to Internship & Coffee Chat has been approved.\n\nOpen https://coffee-chat-agent.evanastonlowe.workers.dev and sign in with the Google email address that was approved.\n\nThis is an access notification, not an outreach email.",
	};
}

export function acceptanceNotificationInsert(
	env: AppBindings, targets: string, senderId: string, now: string, notify: boolean,
): D1PreparedStatement {
	return env.DB.prepare(`INSERT INTO beta_acceptance_notifications
		(id,email,sender_user_id,grant_revision,status,created_at,updated_at)
		SELECT a.approval_revision,a.email,?,a.approval_revision,'QUEUED',?,?
		FROM json_each(?) target JOIN beta_access a ON a.email=json_extract(target.value,'$.email')
		JOIN users sender ON sender.id=? AND sender.deleted_at IS NULL
		WHERE ?=1 AND a.status='APPROVED' AND a.approval_revision=json_extract(target.value,'$.auditId')
		AND a.invited_by_user_id=sender.id ON CONFLICT(email,grant_revision) DO NOTHING`)
		.bind(senderId, now, now, targets, senderId, notify ? 1 : 0);
}

export type AcceptanceNotificationStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN" | "CANCELLED";
interface NotificationRow {
	id: string;
	email: string;
	sender_user_id: string;
	status: AcceptanceNotificationStatus;
	sender_email: string;
	sender_deleted: string | null;
	current_grant: number;
	gmail_ready: number;
}
const notificationSelection = `SELECT n.id,n.email,n.sender_user_id,n.status,u.email AS sender_email,u.deleted_at AS sender_deleted,
	(a.status='APPROVED' AND a.approval_revision=n.grant_revision AND a.invited_by_user_id=n.sender_user_id) AS current_grant,
	EXISTS(SELECT 1 FROM encrypted_credentials c WHERE c.user_id=n.sender_user_id AND c.kind='OAUTH_REFRESH_TOKEN' AND c.provider='GOOGLE') AS gmail_ready
	FROM beta_acceptance_notifications n JOIN users u ON u.id=n.sender_user_id LEFT JOIN beta_access a ON a.email=n.email`;
async function notification(env: AppBindings, id: string) {
	return env.DB.prepare(`${notificationSelection} WHERE n.id=?`).bind(id).first<NotificationRow>();
}
function validTarget(env: AppBindings, row: NotificationRow): boolean {
	return Boolean(row.current_grant && !row.sender_deleted && isBetaAdmin(env, row.sender_email) &&
		z.string().email().max(320).safeParse(row.sender_email).success &&
		z.string().email().max(320).safeParse(row.email).success && normalizeBetaEmail(row.email) === row.email);
}
async function finish(env: AppBindings, id: string, status: NotificationRow["status"], code: string, from: "QUEUED" | "SENDING") {
	await env.DB.prepare("UPDATE beta_acceptance_notifications SET status=?,failure_code=?,updated_at=? WHERE id=? AND status=?")
		.bind(status, code, new Date().toISOString(), id, from).run();
}

export async function processAcceptanceNotification(env: AppBindings, id: string): Promise<void> {
	const row = await notification(env, id);
	if (!row || row.status !== "QUEUED") return;
	if (!validTarget(env, row)) {
		await finish(env, id, "CANCELLED", "GRANT_OR_SENDER_CHANGED", "QUEUED");
		return;
	}
	if (!row.gmail_ready) {
		await finish(env, id, "FAILED", "GMAIL_NOT_CONNECTED", "QUEUED");
		return;
	}
	const claim = await env.DB.prepare(`UPDATE beta_acceptance_notifications SET status='SENDING',failure_code=NULL,updated_at=?
		WHERE id=? AND status='QUEUED' AND EXISTS(SELECT 1 FROM beta_access a WHERE a.email=beta_acceptance_notifications.email
			AND a.status='APPROVED' AND a.approval_revision=beta_acceptance_notifications.grant_revision
			AND a.invited_by_user_id=beta_acceptance_notifications.sender_user_id)`)
		.bind(new Date().toISOString(), id).run();
	if (!claim.meta.changes) return;
	let token: string;
	try {
		const configuredLimit = Number(env.MAX_SENDS_PER_DAY);
		if (!Number.isInteger(configuredLimit) || configuredLimit < 1) throw new Error("Acceptance send limit is unavailable.");
		await enforceRateLimit(env, { userId: row.sender_user_id, action: "acceptance_email",
			limit: Math.min(50, configuredLimit), windowSeconds: 86400 });
		token = await googleAccessToken(env, row.sender_user_id);
	} catch {
		await finish(env, id, "FAILED", "GMAIL_SETUP_OR_LIMIT", "SENDING");
		return;
	}
	const current = await notification(env, id);
	if (!current || current.status !== "SENDING") return;
	if (!validTarget(env, current)) {
		await finish(env, id, "CANCELLED", "GRANT_OR_SENDER_CHANGED", "SENDING");
		return;
	}
	if (!current.gmail_ready) {
		await finish(env, id, "FAILED", "GMAIL_NOT_CONNECTED", "SENDING");
		return;
	}
	const template = acceptanceTemplate();
	let response: { id?: string };
	try {
		response = await fetchJson<{ id?: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
			headers: { Authorization: `Bearer ${token}` },
			body: { raw: encodeMimeMessage({ to: current.email, ...template, senderName: current.sender_email }) },
			attempts: 1, timeoutMs: 20000,
		});
		if (typeof response.id !== "string" || !/^[A-Za-z0-9_-]{1,240}$/.test(response.id)) throw new Error("GMAIL_SEND_UNCERTAIN");
	} catch (error) {
		const unsent = error instanceof ProviderHttpError && [400, 401, 403, 404, 422, 429].includes(error.status);
		await finish(env, id, unsent ? "FAILED" : "UNCERTAIN", unsent ? "GMAIL_REJECTED" : "CHECK_GMAIL_SENT", "SENDING");
		return;
	}
	// Persist failures after Gmail accepted the message must never reopen a send.
	await env.DB.prepare(`UPDATE beta_acceptance_notifications SET status='SENT',failure_code=NULL,
		gmail_message_id=?,sent_at=?,updated_at=? WHERE id=? AND status='SENDING'`)
		.bind(response.id, new Date().toISOString(), new Date().toISOString(), id).run();
}

export async function dispatchAcceptanceNotifications(env: AppBindings, senderId?: string): Promise<void> {
	await env.DB.prepare(`UPDATE beta_acceptance_notifications SET status='UNCERTAIN',failure_code='CHECK_GMAIL_SENT',updated_at=?
		WHERE status='SENDING' AND updated_at<?`)
		.bind(new Date().toISOString(), new Date(Date.now() - 5 * 60000).toISOString()).run();
	const rows = await env.DB.prepare(`SELECT id FROM beta_acceptance_notifications WHERE status='QUEUED'
		${senderId ? "AND sender_user_id=?" : ""} ORDER BY created_at,id LIMIT 5`)
		.bind(...(senderId ? [senderId] : [])).all<{ id: string }>();
	await Promise.all(rows.results.map((row) => processAcceptanceNotification(env, row.id)));
}

export async function retryAcceptanceNotification(env: AppBindings, id: string, senderId: string) {
	const row = await notification(env, id);
	if (!row || row.sender_user_id !== senderId) throw new ClientInputError("This notification belongs to another approving owner.");
	if (row.status !== "FAILED" || !validTarget(env, row)) throw new ConflictError("Only a confirmed unsent notice for the current grant can be retried.");
	if (!row.gmail_ready) throw new ClientInputError("Connect your Gmail in Setup & profile before retrying.");
	const result = await env.DB.prepare(`UPDATE beta_acceptance_notifications SET status='QUEUED',failure_code=NULL,updated_at=?
		WHERE id=? AND status='FAILED' AND EXISTS(SELECT 1 FROM beta_access a WHERE a.email=beta_acceptance_notifications.email
			AND a.status='APPROVED' AND a.approval_revision=beta_acceptance_notifications.grant_revision
			AND a.invited_by_user_id=beta_acceptance_notifications.sender_user_id)`)
		.bind(new Date().toISOString(), id).run();
	if (!result.meta.changes) throw new ConflictError("The grant or notification changed. Refresh beta access.");
	return { ok: true, status: "QUEUED" as const };
}
