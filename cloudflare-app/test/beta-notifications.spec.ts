import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { upsertUser, createSession } from "../src/lib/db";
import { saveCredential } from "../src/lib/credentials";
import { sha256 } from "../src/lib/encoding";
import { approveBetaEmail, revokeBetaEmail, requestVerifiedBetaAccess } from "../src/lib/beta";
import { processAcceptanceNotification, dispatchAcceptanceNotifications, acceptanceTemplate } from "../src/lib/beta-notifications";
import type { AppBindings } from "../src/types";

const bindings: AppBindings = { ...env as AppBindings, APP_ORIGIN: "http://example.com", BETA_ACCESS_MODE: "OPEN",
	BETA_ADMIN_EMAILS: "owner-notice@example.test,other-owner-notice@example.test" };
type Auth = { id: string; csrf: string; cookie: string };
let owner: Auth;
let other: Auth;
let tokenRefreshes: string[];
let messages: string[];
let mailResponse: () => Response | Promise<Response>;
beforeAll(async () => {
	const statements = JSON.parse((env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS) as string[];
	await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM beta_acceptance_notifications"),
		env.DB.prepare("DELETE FROM beta_access_requests"),
		env.DB.prepare("DELETE FROM beta_access"),
		env.DB.prepare("DELETE FROM rate_limits WHERE action='acceptance_email'"),
		env.DB.prepare("DELETE FROM encrypted_credentials WHERE provider='GOOGLE'"),
	]);
	owner = await auth("owner-notice@example.test");
	other = await auth("other-owner-notice@example.test");
	tokenRefreshes = []; messages = [];
	mailResponse = () => Response.json({ id: "fictional-message-id" });
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const host = new URL(String(input)).hostname;
		if (host === "oauth2.googleapis.com") {
			tokenRefreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") || "");
			return Response.json({ access_token: "fictional-owner-access-token" });
		}
		if (host === "gmail.googleapis.com") {
			messages.push(Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString("utf8"));
			return mailResponse();
		}
		throw new Error("No actual external request is authorized.");
	});
});
afterEach(() => vi.restoreAllMocks());
async function auth(email: string): Promise<Auth> {
	const value = await upsertUser(bindings, { googleSub: `fictional-${email}`, email, name: "Fictional member", image: "" });
	const token = crypto.randomUUID(), csrf = crypto.randomUUID();
	await createSession(bindings, value.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 3600000).toISOString());
	return { id: value.id, csrf, cookie: `cc_session=${token}; cc_csrf=${csrf}` };
}
async function connect(value = owner, token = "fictional-owner-refresh") {
	await saveCredential(bindings, { userId: value.id, provider: "GOOGLE", kind: "OAUTH_REFRESH_TOKEN", value: token });
}
async function call(path: string, value: Auth | null, body?: unknown, method = "POST", csrf = true) {
	if (body && typeof body === "object" && "notifyEmail" in body && body.notifyEmail === true && !("expectedSenderId" in body)) {
		body = { ...body, expectedSenderId: value?.id };
	}
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, {
		method, headers: { Origin: bindings.APP_ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(value ? { Cookie: value.cookie, ...(csrf ? { "X-CSRF-Token": value.csrf } : {}) } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), bindings, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
async function grant(email = "approved@example.test", notifyEmail = true) {
	await approveBetaEmail(bindings, email, owner.id, notifyEmail);
	return (await env.DB.prepare(`SELECT n.id,n.status,n.failure_code FROM beta_acceptance_notifications n
		JOIN beta_access a ON a.email=n.email AND a.approval_revision=n.grant_revision WHERE n.email=?`)
		.bind(email).first<{ id: string; status: string; failure_code: string | null }>())!;
}
async function status(id: string) {
	return (await env.DB.prepare("SELECT status,failure_code,gmail_message_id FROM beta_acceptance_notifications WHERE id=?")
		.bind(id).first<{ status: string; failure_code: string | null; gmail_message_id: string | null }>())!;
}
describe("explicit future-only transactional acceptance notices", () => {
	it("old clients and already-approved entries never create a notice or backfill email", async () => {
		await connect();
		expect((await call("/api/beta/admin/access/approve", owner, { email: "old@example.test" })).status).toBe(200);
		expect((await call("/api/beta/admin/access/approve", owner, { email: "old@example.test", notifyEmail: true })).status).toBe(200);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM beta_acceptance_notifications").first<{ n: number }>())?.n).toBe(0);
		expect(messages).toEqual([]);
		expect(tokenRefreshes).toEqual([]);
	});
	it("uses the approving owner's Gmail, not the applicant's, and sends a fixed private one-recipient template", async () => {
		await connect();
		const applicant = await auth("approved@example.test");
		await connect(applicant, "fictional-applicant-refresh");
		const response = await call("/api/beta/admin/access/approve", owner, { email: " APPROVED@example.test ".trim(), notifyEmail: true });
		expect(response.status).toBe(200);
		expect(tokenRefreshes).toEqual(["fictional-owner-refresh"]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("To: approved@example.test\r\n");
		expect(messages[0]).toContain("From: owner-notice@example.test\r\n");
		expect(messages[0]).not.toMatch(/Cc:|Bcc:|attachment|password|fictional-applicant-refresh/i);
		const encodedBody = messages[0].split("\r\n\r\n")[1];
		expect(Buffer.from(encodedBody, "base64").toString("utf8")).toBe(acceptanceTemplate().body);
		const row = await env.DB.prepare("SELECT id FROM beta_acceptance_notifications").first<{ id: string }>();
		expect((await status(row!.id)).status).toBe("SENT");
		await Promise.all([processAcceptanceNotification(bindings, row!.id), processAcceptanceNotification(bindings, row!.id)]);
		expect(messages).toHaveLength(1);
	});
	it("keeps granted access when owner Gmail is missing and exposes a proven-unsent setup failure", async () => {
		expect((await call("/api/beta/admin/access/approve", owner, { email: "missing@example.test", notifyEmail: true })).status).toBe(200);
		const row = await env.DB.prepare("SELECT id FROM beta_acceptance_notifications").first<{ id: string }>();
		expect(await status(row!.id)).toMatchObject({ status: "FAILED", failure_code: "GMAIL_NOT_CONNECTED" });
		expect((await env.DB.prepare("SELECT status FROM beta_access WHERE email='missing@example.test'").first<{ status: string }>())?.status).toBe("APPROVED");
		expect(messages).toEqual([]);
		expect((await call(`/api/beta/admin/notifications/${row!.id}/retry`, owner, {})).status).toBe(400);
		await connect();
		expect((await call(`/api/beta/admin/notifications/${row!.id}/retry`, owner, {})).status).toBe(200);
		expect((await status(row!.id)).status).toBe("SENT");
	});
	it("allows only the approving owner to explicitly retry a known rejected send, once", async () => {
		await connect();
		const row = await grant();
		mailResponse = () => Response.json({ error: "fictional rejected request" }, { status: 403 });
		await processAcceptanceNotification(bindings, row.id);
		expect((await status(row.id)).status).toBe("FAILED");
		expect((await call(`/api/beta/admin/notifications/${row.id}/retry`, other, {})).status).toBe(400);
		mailResponse = () => Response.json({ id: "fictional-retry-accepted" });
		expect((await call(`/api/beta/admin/notifications/${row.id}/retry`, owner, {})).status).toBe(200);
		expect((await status(row.id)).gmail_message_id).toBe("fictional-retry-accepted");
		expect((await call(`/api/beta/admin/notifications/${row.id}/retry`, owner, {})).status).toBe(409);
		expect(messages).toHaveLength(2);
	});
	it.each(["network", "missing-id", "server-error"])("never blindly retries an uncertain %s send", async (failure) => {
		await connect();
		const row = await grant();
		mailResponse = () => {
			if (failure === "network") throw new Error("Fictional network outcome unknown");
			return failure === "missing-id" ? Response.json({}) : Response.json({}, { status: 503 });
		};
		await processAcceptanceNotification(bindings, row.id);
		expect((await status(row.id)).status).toBe("UNCERTAIN");
		await dispatchAcceptanceNotifications(bindings);
		expect((await call(`/api/beta/admin/notifications/${row.id}/retry`, owner, {})).status).toBe(409);
		expect(messages).toHaveLength(1);
	});
	it("does not revive revoked or superseded grants, including after a legacy writer changes access", async () => {
		await connect();
		const old = await grant();
		await revokeBetaEmail(bindings, "approved@example.test", owner.id);
		await processAcceptanceNotification(bindings, old.id);
		expect((await status(old.id)).status).toBe("CANCELLED");
		const restored = await grant();
		expect(restored.id).not.toBe(old.id);
		await processAcceptanceNotification(bindings, restored.id);
		expect(messages).toHaveLength(1);
		const legacy = await grant("legacy@example.test");
		await env.DB.prepare("UPDATE beta_access SET status='REVOKED' WHERE email='legacy@example.test'").run();
		await env.DB.prepare("UPDATE beta_access SET status='APPROVED' WHERE email='legacy@example.test'").run();
		await processAcceptanceNotification(bindings, legacy.id);
		expect((await status(legacy.id)).status).toBe("CANCELLED");
		expect(messages).toHaveLength(1);
	});
	it("rechecks grant revocation after OAuth and never sends using a deleted/disconnected sender", async () => {
		await connect();
		const row = await grant();
		vi.mocked(fetch).mockImplementation(async () => {
			await revokeBetaEmail(bindings, "approved@example.test", owner.id);
			return Response.json({ access_token: "fictional-token" });
		});
		await processAcceptanceNotification(bindings, row.id);
		expect((await status(row.id)).status).toBe("CANCELLED");
		const next = await grant("second@example.test");
		await env.DB.prepare("UPDATE users SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), owner.id).run();
		expect((await status(next.id)).status).toBe("CANCELLED");
		await processAcceptanceNotification(bindings, next.id);
		expect(messages).toEqual([]);
		await env.DB.prepare("UPDATE users SET deleted_at=NULL WHERE id=?").bind(owner.id).run();
	});
	it("treats an orphaned send lock as uncertain, never as a proven unsent automatic retry", async () => {
		await connect();
		const row = await grant();
		await env.DB.prepare("UPDATE beta_acceptance_notifications SET status='SENDING',updated_at=? WHERE id=?")
			.bind(new Date(Date.now() - 10 * 60000).toISOString(), row.id).run();
		await dispatchAcceptanceNotifications(bindings);
		expect((await status(row.id)).status).toBe("UNCERTAIN");
		expect(messages).toEqual([]);
	});
	it("drains bulk approvals in bounded batches, deduplicates snapshots and gives each recipient their own message", async () => {
		await connect();
		for (let index = 0; index < 7; index++) await requestVerifiedBetaAccess({ ...bindings, BETA_ACCESS_MODE: "ALLOWLIST" },
			{ email: `bulk${index}@example.test`, googleSub: `fictional-bulk-${index}` });
		const snapshot = await (await call("/api/beta/admin/requests/pending", owner, undefined, "GET"))
			.json<{ snapshot: string; requests: Array<{ id: string }> }>();
		const input = { snapshot: snapshot.snapshot, requestIds: snapshot.requests.map((request) => request.id), notifyEmail: true };
		const approved = await (await call("/api/beta/admin/requests/approve-pending", owner, input))
			.json<{ approved: string[]; notificationsQueued: number }>();
		expect(approved.approved).toHaveLength(7);
		expect(approved.notificationsQueued).toBe(7);
		expect(messages).toHaveLength(5);
		await dispatchAcceptanceNotifications(bindings);
		expect(messages).toHaveLength(7);
		expect(new Set(messages.map((message) => message.match(/^To: (.+)\r$/m)?.[1])).size).toBe(7);
		expect((await (await call("/api/beta/admin/requests/approve-pending", owner, input)).json<{ approved: string[] }>()).approved).toEqual([]);
		expect(messages).toHaveLength(7);
	});
	it("keeps owner/CSRF permissions and never exposes or creates notifications for a nonowner", async () => {
		const member = await auth("member-notice@example.test");
		expect((await call("/api/beta/admin/access/approve", member, { email: "x@example.test", notifyEmail: true })).status).toBe(403);
		expect((await call("/api/beta/admin/access", member, undefined, "GET")).status).toBe(403);
		expect((await call("/api/beta/admin/access/approve", owner, { email: "x@example.test", notifyEmail: true }, "POST", false)).status).toBe(403);
		expect((await call("/api/beta/admin/access/approve", null, { email: "x@example.test", notifyEmail: true })).status).toBe(401);
		expect(messages).toEqual([]);
	});
	it("requires explicit notification consent for an individual pending request and skips repeated approval", async () => {
		await connect();
		await requestVerifiedBetaAccess({ ...bindings, BETA_ACCESS_MODE: "ALLOWLIST" },
			{ email: "individual@example.test", googleSub: "fictional-individual" });
		const pending = await env.DB.prepare("SELECT id FROM beta_access_requests").first<{ id: string }>();
		expect((await call(`/api/beta/admin/requests/${pending!.id}/approve`, owner, { notifyEmail: true })).status).toBe(200);
		expect(messages).toHaveLength(1);
		expect((await call(`/api/beta/admin/requests/${pending!.id}/approve`, owner, { notifyEmail: true })).status).toBe(409);
		expect(messages).toHaveLength(1);
	});
	it("never reopens a send when persistence fails after Gmail accepted it", async () => {
		await connect();
		const row = await grant();
		const db = new Proxy(bindings.DB, {
			get(target, key) {
				if (key === "prepare") return (sql: string) => {
					if (sql.includes("gmail_message_id=?")) throw new Error("Fictional accepted-send persistence failure");
					return target.prepare(sql);
				};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(processAcceptanceNotification({ ...bindings, DB: db }, row.id)).rejects.toThrow("persistence failure");
		expect((await status(row.id)).status).toBe("SENDING");
		await processAcceptanceNotification(bindings, row.id);
		expect((await call(`/api/beta/admin/notifications/${row.id}/retry`, owner, {})).status).toBe(409);
		expect(messages).toHaveLength(1);
	});
	it("keeps a daily-limit failure proven unsent and does not undo either approval", async () => {
		await connect();
		const first = await grant("limit-first@example.test");
		const second = await grant("limit-second@example.test");
		await processAcceptanceNotification({ ...bindings, MAX_SENDS_PER_DAY: "1" }, first.id);
		await processAcceptanceNotification({ ...bindings, MAX_SENDS_PER_DAY: "1" }, second.id);
		expect((await status(second.id)).status).toBe("FAILED");
		expect(messages).toHaveLength(1);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM beta_access WHERE status='APPROVED'").first<{ n: number }>())?.n).toBe(2);
	});
	it("rejects stale approving-owner email consent before granting or sending from another account", async () => {
		await connect();
		expect((await call("/api/beta/admin/access/approve", owner,
			{ email: "stale@example.test", notifyEmail: true, expectedSenderId: other.id })).status).toBe(409);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM beta_access WHERE email='stale@example.test'").first<{ n: number }>())?.n).toBe(0);
		expect(messages).toEqual([]);
	});
});
