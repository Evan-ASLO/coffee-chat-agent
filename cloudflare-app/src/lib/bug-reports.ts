import { z } from "zod";
import type { AppBindings } from "../types";
import { ClientInputError, ConflictError } from "./errors";
import { sha256, utf8, toBase64Url, fromBase64Url, decodeUtf8 } from "./encoding";
import { enforceRateLimit } from "./store";

export const bugReportInput = z.object({
	submissionKey: z.string().uuid(),
	expectedUserId: z.string().uuid(),
	summary: z.string().trim().min(3).max(160),
	description: z.string().trim().min(10).max(4000),
	page: z.enum(["home", "jobs", "applications", "networking", "settings", "analytics"]),
}).strict();
export const bugReportStatusInput = z.object({ status: z.enum(["OPEN", "RESOLVED"]) }).strict();
export const bugReportQuery = z.object({
	status: z.enum(["ALL", "OPEN", "RESOLVED"]).default("OPEN"),
	cursor: z.string().min(1).max(1024).optional(),
}).strict();
const reportCursor = z.object({
	id: z.string().uuid(), at: z.string().datetime(), status: z.enum(["ALL", "OPEN", "RESOLVED"]),
}).strict();
interface StoredReceipt { id: string; created_at: string; content_hash: string }

export async function submitBugReport(env: AppBindings, userId: string, input: z.infer<typeof bugReportInput>) {
	if (input.expectedUserId !== userId) throw new ConflictError("Account changed. Reload before submitting this report.");
	const hash = await sha256(JSON.stringify({ summary: input.summary, description: input.description, page: input.page }));
	const lookup = () => env.DB.prepare(`SELECT r.id,r.created_at,r.content_hash FROM bug_reports r JOIN users u ON u.id=r.user_id
		WHERE r.user_id=? AND r.submission_key=? AND u.deleted_at IS NULL`)
		.bind(userId, input.submissionKey).first<StoredReceipt>();
	const receipt = (row: StoredReceipt) => {
		if (row.content_hash !== hash) throw new ConflictError("This report changed. Submit it with a new request key.");
		return { id: row.id, createdAt: row.created_at };
	};
	const existing = await lookup();
	if (existing) return receipt(existing);
	await enforceRateLimit(env, { userId, action: "BUG_REPORT", limit: 5, windowSeconds: 3600 });
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT OR IGNORE INTO bug_reports(id,user_id,submission_key,content_hash,summary,description,page,status,created_at,updated_at)
		SELECT ?,id,?,?,?,?,?,'OPEN',?,? FROM users WHERE id=? AND deleted_at IS NULL`)
		.bind(id, input.submissionKey, hash, input.summary, input.description, input.page, now, now, userId).run();
	const saved = await lookup();
	if (!saved) throw new Error("Bug report persistence could not be confirmed.");
	return receipt(saved);
}

export async function listBugReports(env: AppBindings, query: z.infer<typeof bugReportQuery>) {
	let cursor: z.infer<typeof reportCursor> | undefined;
	if (query.cursor) {
		try {
			cursor = reportCursor.parse(JSON.parse(decodeUtf8(fromBase64Url(query.cursor))));
			if (cursor.status !== query.status) throw new Error("Filter changed");
		} catch { throw new ClientInputError("Report page could not be read. Refresh the inbox."); }
	}
	const scope = query.status === "ALL" ? "" : "AND r.status=?";
	const bindStatus = query.status === "ALL" ? [] : [query.status];
	const [counts, reports] = await Promise.all([
		env.DB.prepare(`SELECT COALESCE(SUM(r.status='OPEN'),0) AS open,COALESCE(SUM(r.status='RESOLVED'),0) AS resolved
			FROM bug_reports r JOIN users u ON u.id=r.user_id WHERE u.deleted_at IS NULL`)
			.first<{ open: number; resolved: number }>(),
		env.DB.prepare(`SELECT r.id,r.summary,r.description,r.page,r.status,r.created_at,r.updated_at,u.id AS user_id,u.name,u.email
			FROM bug_reports r JOIN users u ON u.id=r.user_id WHERE u.deleted_at IS NULL ${scope}
			${cursor ? "AND (r.created_at < ? OR (r.created_at=? AND r.id<?))" : ""}
			ORDER BY r.created_at DESC,r.id DESC LIMIT 21`)
			.bind(...bindStatus, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []))
			.all<{ id: string; summary: string; description: string; page: string; status: "OPEN" | "RESOLVED"; created_at: string; updated_at: string; user_id: string; name: string; email: string }>(),
	]);
	if (!counts) throw new Error("Bug report counts were unavailable.");
	const page = reports.results.slice(0, 20);
	const last = page.at(-1);
	return {
		counts, reports: page.map((row) => ({
			id: row.id, summary: row.summary, description: row.description, page: row.page, status: row.status,
			createdAt: row.created_at, updatedAt: row.updated_at,
			reporter: { id: row.user_id, name: row.name, email: row.email },
		})), pageSize: 20,
		nextCursor: reports.results.length > 20 && last
			? toBase64Url(utf8(JSON.stringify({ id: last.id, at: last.created_at, status: query.status }))) : null,
	};
}

export async function updateBugReportStatus(env: AppBindings, id: string, status: "OPEN" | "RESOLVED") {
	const result = await env.DB.prepare(`UPDATE bug_reports SET status=?,updated_at=? WHERE id=?
		AND user_id IN (SELECT id FROM users WHERE deleted_at IS NULL)`)
		.bind(status, new Date().toISOString(), id).run();
	if (!result.meta.changes) throw new ClientInputError("Report was not found. Refresh the inbox.");
	return { id, status };
}
