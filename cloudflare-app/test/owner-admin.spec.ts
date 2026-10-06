import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import type { AppBindings } from "../src/types";
import { createSession, upsertUser } from "../src/lib/db";
import { sha256 } from "../src/lib/encoding";
import {
	approveBetaSnapshot,
	pendingBetaApprovalSnapshot,
} from "../src/lib/beta";
import {
	getOwnerActivity,
	ownerActivityQuerySchema,
	type OwnerActivity,
	type OwnerEvents,
} from "../src/lib/owner-activity";

const bindings: AppBindings = {
	...env as AppBindings,
	APP_ORIGIN: "http://example.com",
	BETA_ACCESS_MODE: "ALLOWLIST",
	BETA_ADMIN_EMAILS: " OWNER@example.test ",
};
type Auth = Awaited<ReturnType<typeof newAccount>>;
type Snapshot = Awaited<ReturnType<typeof pendingBetaApprovalSnapshot>>;
type Approval = Awaited<ReturnType<typeof approveBetaSnapshot>>;
let owner: Auth;
let member: Auth;
const day = 86_400_000;

beforeAll(async () => {
	const statements: string[] = JSON.parse(
		(env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS,
	);
	await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM beta_access_requests"),
		env.DB.prepare("DELETE FROM beta_access"),
		env.DB.prepare("DELETE FROM users"),
	]);
	owner = await newAccount("owner@example.test");
	member = await newAccount("member@example.test");
});

describe("owner operational activity", () => {
	it("authorizes every owner read on the server without changing personal Analytics", async () => {
		for (const path of [
			"/api/beta/admin/activity", "/api/beta/admin/activity/events",
			"/api/beta/admin/access", "/api/beta/admin/requests/pending",
		]) {
			expect((await request(path)).status).toBe(401);
			expect((await request(path, member)).status).toBe(403);
			expect((await request(`${path}?isBetaAdmin=true&email=owner@example.test`, member)).status).toBe(403);
			expect((await request(path, owner)).status).toBe(200);
		}
		await event(owner, "EMAIL_SENT");
		await event(member, "DISCOVERY_COMPLETED");
		const personal = await request("/api/analytics", member);
		const own = await personal.json<{ recentActivity: Array<{ action: string }> }>();
		expect(own.recentActivity.map((entry) => entry.action)).toEqual(["DISCOVERY_COMPLETED"]);
	});

	it("returns only explicit account and safe event fields, never sensitive metadata", async () => {
		const secret = "PRIVATE-QUERY-RESUME-TOKEN-PROVIDER-BODY";
		await event(member, "DISCOVERY_COMPLETED", {
			query: secret, prompt: secret, body: secret, resume: secret,
			fallbackModel: secret, key_hint: secret,
			fallbackStatus: "SEARCH_LIMITED", fallbackReason: "max_uses_exceeded",
			fallbackProvider: "ANTHROPIC", nested: { private: secret },
		});
		await event(member, "DISCOVERY_COMPLETED", {
			fallbackStatus: secret, fallbackReason: secret, fallbackProvider: secret,
		});
		await event(member, secret, { anything: secret });
		await env.DB.prepare(
			"INSERT INTO audit_events(id,user_id,action,entity_type,request_id,metadata_json,created_at) VALUES(?,?,'JOB_STATE_UPDATED','job','private','not-json',?)",
		).bind(crypto.randomUUID(), member.user.id, new Date().toISOString()).run();
		const activity = await (await request("/api/beta/admin/activity", owner)).json<OwnerActivity>();
		const feed = await (await request("/api/beta/admin/activity/events", owner)).json<OwnerEvents>();
		const serialized = JSON.stringify({ activity, feed });
		for (const forbidden of [secret, "metadata_json", "google_sub", "googleSub", "token_hash", "csrf_hash", "entity_id", "key_hint", "draft_body", "image"]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(Object.keys(activity.accounts[0]!).sort()).toEqual(
			["id", "name", "email", "registeredAt", "counts", "lastRecordedEventAt"].sort(),
		);
		expect(feed.events.some((entry) => entry.action === "OTHER")).toBe(true);
		expect(feed.events.filter((entry) => entry.searchFallback)).toMatchObject([{
			searchFallback: { status: "SEARCH_LIMITED", reason: "max_uses_exceeded", provider: "ANTHROPIC" },
		}]);
		expect(activity.summary.searchIssues).toBe(1);
	});

	it("uses matching UTC bounds and categories for totals and each account including inactive accounts", async () => {
		const now = new Date();
		const query = ownerActivityQuerySchema.parse({ days: "7" });
		const first = await getOwnerActivity(bindings, query, now);
		await event(member, "JOB_STATE_UPDATED", { status: "SAVED" }, first.period.from);
		await event(member, "JOB_STATE_UPDATED", { status: "APPLIED" }, now.toISOString());
		await event(member, "DISCOVERY_COMPLETED", { fallbackStatus: "TIMEOUT" }, now.toISOString());
		await event(member, "DRAFT_PREPARED", {}, now.toISOString());
		await event(member, "EMAIL_SENT", {}, now.toISOString());
		await event(member, "SETTINGS_UPDATED", {}, now.toISOString());
		await event(member, "EMAIL_SENT", {}, new Date(Date.parse(first.period.from) - 1).toISOString());
		await event(member, "EMAIL_SENT", {}, new Date(now.getTime() + 1).toISOString());
		const activity = await getOwnerActivity(bindings, query, now);
		expect(activity.summary).toEqual({
			accounts: 2, accountsWithEvents: 1, total: 6, peopleSearches: 1,
			jobSaves: 1, trackerChanges: 1, draftChanges: 1, outreachSends: 1, searchIssues: 1,
		});
		expect(activity.accounts.find((entry) => entry.id === member.user.id)?.counts).toEqual({
			total: 6, peopleSearches: 1, jobSaves: 1, trackerChanges: 1,
			draftChanges: 1, outreachSends: 1, searchIssues: 1,
		});
		expect(activity.accounts.find((entry) => entry.id === owner.user.id)?.lastRecordedEventAt).toBeNull();
		expect(activity.accounts.reduce((sum, entry) => sum + entry.counts.total, 0)).toBe(activity.summary.total);
		expect(activity.period.from).toMatch(/T00:00:00.000Z$/);
	});

	it("paginates accounts and tied-timestamp events without duplicates and scopes filters/cursors", async () => {
		for (let index = 0; index < 21; index++) await newAccount(`extra-${index}@example.test`);
		const at = new Date(Date.now() - 1000).toISOString();
		for (let index = 0; index < 27; index++) await event(member, "EMAIL_SENT", {}, at);
		await event(owner, "DISCOVERY_COMPLETED", {}, at);
		const first = await (await request("/api/beta/admin/activity", owner)).json<OwnerActivity>();
		expect(first.accounts).toHaveLength(20);
		expect(first.summary.accounts).toBe(23);
		expect(first.nextCursor).toBeTruthy();
		const second = await (await request(`/api/beta/admin/activity?${new URLSearchParams({
			asOf: first.period.asOf, cursor: first.nextCursor!,
		})}`, owner)).json<OwnerActivity>();
		expect(second.accounts).toHaveLength(3);
		expect(new Set([...first.accounts, ...second.accounts].map((entry) => entry.id)).size).toBe(23);
		expect(second.nextCursor).toBeNull();
		const filters = new URLSearchParams({ userId: member.user.id, action: "EMAIL_SENT" });
		const feed = await (await request(`/api/beta/admin/activity/events?${filters}`, owner)).json<OwnerEvents>();
		expect(feed.events).toHaveLength(25);
		expect(feed.events.every((entry) => entry.user.id === member.user.id && entry.action === "EMAIL_SENT")).toBe(true);
		filters.set("asOf", feed.period.asOf);
		filters.set("cursor", feed.nextCursor!);
		const next = await (await request(`/api/beta/admin/activity/events?${filters}`, owner)).json<OwnerEvents>();
		expect(next.events).toHaveLength(2);
		expect(new Set([...feed.events, ...next.events].map((entry) => entry.id)).size).toBe(27);
		expect(next.nextCursor).toBeNull();
		filters.set("userId", owner.user.id);
		expect((await request(`/api/beta/admin/activity/events?${filters}`, owner)).status).toBe(400);
	});

	it("rejects malicious filters, malformed cursors, invalid dates and unbounded ranges", async () => {
		for (const query of [
			"days=365", "days=-7", "days=7%20OR%201=1", "limit=100000",
			"userId=anything", "action=EMAIL_SENT%27%20OR%201=1",
			"asOf=not-a-date", "asOf=2026-02-31T00:00:00.000Z",
			`asOf=${new Date(Date.now() + day).toISOString()}`,
			`asOf=${new Date(Date.now() - 2 * day).toISOString()}`,
			"cursor=bad", "cursor=%25%25%25", `cursor=${"a".repeat(1025)}`,
		]) {
			expect((await request(`/api/beta/admin/activity/events?${query}`, owner)).status, query).toBe(400);
		}
	});

	it("handles empty event filters and excludes deleted registered accounts", async () => {
		await event(member, "EMAIL_SENT");
		await env.DB.prepare("UPDATE users SET deleted_at=? WHERE id=?")
			.bind(new Date().toISOString(), member.user.id).run();
		const activity = await (await request("/api/beta/admin/activity?days=7", owner)).json<OwnerActivity>();
		expect(activity.summary.accounts).toBe(1);
		expect(activity.summary.total).toBe(0);
		const feed = await (await request(`/api/beta/admin/activity/events?userId=${member.user.id}`, owner)).json<OwnerEvents>();
		expect(feed.events).toEqual([]);
		expect(feed.nextCursor).toBeNull();
	});
});

describe("reviewed pending-beta approvals", () => {
	it.each([0, 1, 3])("approves exactly %i reviewed requests with per-request owner audits", async (count) => {
		const targets = await pending(count);
		const review = await snapshot();
		const response = await approve(review);
		expect(response.status).toBe(200);
		const result = await response.json<Approval>();
		expect(result.reviewed).toBe(count);
		expect(result.approved.sort()).toEqual(targets.map((entry) => entry.id).sort());
		expect(result.skipped).toEqual([]);
		const audit = await env.DB.prepare(
			"SELECT user_id,entity_id,request_id FROM audit_events WHERE action='BETA_ACCESS_REQUEST_APPROVED'",
		).all<{ user_id: string; entity_id: string; request_id: string }>();
		expect(audit.results).toHaveLength(count);
		expect(audit.results.every((entry) => entry.user_id === owner.user.id && entry.request_id)).toBe(true);
		const access = await env.DB.prepare("SELECT COUNT(*) AS count FROM beta_access WHERE email LIKE 'pending-%' AND status='APPROVED'")
			.first<{ count: number }>();
		expect(access?.count).toBe(count);
		const subs = await env.DB.prepare("SELECT google_sub FROM beta_access_requests WHERE status='APPROVED'")
			.all<{ google_sub: string }>();
		expect(subs.results.every((entry) => entry.google_sub === "")).toBe(true);
	});

	it("counts more than 500 requests honestly and bounds each reviewed transaction to 50", async () => {
		await pending(501);
		const listing = await (await request("/api/beta/admin/access", owner)).json<{
			requests: unknown[]; pendingTotal: number; approvalBatchLimit: number;
		}>();
		expect(listing.requests).toHaveLength(500);
		expect(listing.pendingTotal).toBe(501);
		const review = await snapshot();
		expect(review.pendingTotal).toBe(501);
		expect(review.requests).toHaveLength(50);
		expect(review.hasMore).toBe(true);
		expect(review.batchLimit).toBe(50);
		expect((await (await approve(review)).json<Approval>()).approved).toHaveLength(50);
		expect((await snapshot()).pendingTotal).toBe(451);
	});

	it("never includes newly arriving requests or silently changed identities", async () => {
		const targets = await pending(2);
		const review = await snapshot();
		const arrivals = await pending(1);
		await env.DB.prepare("UPDATE beta_access_requests SET email=? WHERE id=?")
			.bind("changed@example.test", targets[0]!.id).run();
		const result = await (await approve(review)).json<Approval>();
		expect(result.approved).toEqual([targets[1]!.id]);
		expect(result.skipped).toEqual([{ id: targets[0]!.id, reason: "ALREADY_HANDLED_OR_CHANGED" }]);
		expect(await status(arrivals[0]!.id)).toBe("PENDING");
		expect(await status(targets[0]!.id)).toBe("PENDING");
	});

	it("skips denied, already-approved and repeated targets and cannot resurrect revoked access", async () => {
		const targets = await pending(3);
		const review = await snapshot();
		expect((await request(`/api/beta/admin/requests/${targets[0]!.id}/deny`, owner, { method: "POST" })).status).toBe(200);
		expect((await request(`/api/beta/admin/requests/${targets[1]!.id}/approve`, owner, { method: "POST" })).status).toBe(200);
		expect((await request("/api/beta/admin/access/revoke", owner, {
			method: "POST", body: { email: targets[1]!.email },
		})).status).toBe(200);
		const result = await (await approve(review)).json<Approval>();
		expect(result.approved).toEqual([targets[2]!.id]);
		expect(result.skipped).toHaveLength(2);
		const repeated = await (await approve(review)).json<Approval>();
		expect(repeated.approved).toEqual([]);
		expect(repeated.skipped).toHaveLength(3);
		expect((await request(`/api/beta/admin/requests/${targets[1]!.id}/approve`, owner, { method: "POST" })).status).toBe(409);
		const revoked = await env.DB.prepare("SELECT status FROM beta_access WHERE email=?")
			.bind(targets[1]!.email).first<{ status: string }>();
		expect(revoked?.status).toBe("REVOKED");
	});

	it("identifies genuine reapplications and skips a revocation after review", async () => {
		const targets = await pending(2);
		const now = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO beta_access(email,status,created_at,updated_at) VALUES(?,'REVOKED',?,?)")
				.bind(targets[0]!.email, now, now),
			env.DB.prepare("INSERT INTO beta_access_requests(id,email,google_sub,status,requested_at,updated_at) VALUES(?,?,'','DENIED',?,?)")
				.bind(crypto.randomUUID(), targets[1]!.email, now, now),
		]);
		const review = await snapshot();
		expect(review.requests.find((entry) => entry.id === targets[0]!.id)?.reapplication).toBe("REVOKED_ACCESS");
		expect(review.requests.find((entry) => entry.id === targets[1]!.id)?.reapplication).toBe("PREVIOUSLY_DENIED");
		await env.DB.prepare("INSERT INTO beta_access(email,status,created_at,updated_at) VALUES(?,'REVOKED',?,?)")
			.bind(targets[1]!.email, now, now).run();
		const result = await (await approve(review)).json<Approval>();
		expect(result.approved).toEqual([targets[0]!.id]);
		expect(result.skipped.map((entry) => entry.id)).toEqual([targets[1]!.id]);
	});

	it("serializes simultaneous approve/deny and double submissions without false success", async () => {
		const [target] = await pending(1);
		const review = await snapshot();
		const responses = await Promise.all([
			approve(review),
			approve(review),
			request(`/api/beta/admin/requests/${target!.id}/deny`, owner, { method: "POST" }),
		]);
		const results = await Promise.all(responses.slice(0, 2).map((response) => response.json<Approval>()));
		const approvedCount = results.reduce((count, result) => count + result.approved.length, 0);
		const finalStatus = await status(target!.id);
		expect(approvedCount).toBe(finalStatus === "APPROVED" ? 1 : 0);
		expect(responses[2]!.status).toBe(finalStatus === "DENIED" ? 200 : 409);
		const access = await env.DB.prepare("SELECT status FROM beta_access WHERE email=?")
			.bind(target!.email).first<{ status: string }>();
		expect(access?.status ?? null).toBe(finalStatus === "APPROVED" ? "APPROVED" : null);
	});

	it("rejects forged/duplicate IDs, modified or expired snapshots, wrong roles, CSRF and origins", async () => {
		await pending(1);
		const review = await snapshot();
		const body = approvalBody(review);
		for (const auth of [undefined, member]) {
			expect((await request("/api/beta/admin/requests/approve-pending", auth, { method: "POST", body })).status)
				.toBe(auth ? 403 : 401);
		}
		for (const altered of [
			{ ...body, requestIds: [crypto.randomUUID()] },
			{ ...body, requestIds: [body.requestIds[0], body.requestIds[0]] },
			{ ...body, requestIds: ["not-a-uuid"] },
			{ ...body, requestIds: [] },
			{ ...body, snapshot: `${body.snapshot}tampered` },
			{ ...body, approveFuture: true },
		]) {
			expect((await request("/api/beta/admin/requests/approve-pending", owner, { method: "POST", body: altered })).status).toBe(400);
		}
		const invalidHeaders: Array<Record<string, string>> = [
			{ "X-CSRF-Token": "" }, { Origin: "https://evil.example" },
		];
		for (const headers of invalidHeaders) {
			expect((await request("/api/beta/admin/requests/approve-pending", owner, {
				method: "POST", body, headers,
			})).status).toBe(403);
		}
		await expect(approveBetaSnapshot(bindings, body, owner.user.id, "expiry-test", Date.now() + 11 * 60_000))
			.rejects.toThrow("expired");
		await expect(approveBetaSnapshot(bindings, body, member.user.id, "actor-test"))
			.rejects.toThrow("different owner");
		expect((await snapshot()).pendingTotal).toBe(1);
	});

	it("rolls back access, decisions and audits on write failure and safely retries the same reviewed set", async () => {
		const targets = await pending(3);
		const review = await snapshot();
		await env.DB.prepare(
			`CREATE TRIGGER fail_local_approval BEFORE INSERT ON beta_access
			 WHEN NEW.email = '${targets[1]!.email}'
			 BEGIN SELECT RAISE(ABORT, 'synthetic local write failure'); END`,
		).run();
		try {
			const response = await approve(review);
			expect(response.status).toBe(500);
			expect(JSON.stringify(await response.json())).not.toContain("synthetic local");
			for (const target of targets) expect(await status(target.id)).toBe("PENDING");
			const audit = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='BETA_ACCESS_REQUEST_APPROVED'")
				.first<{ count: number }>();
			expect(audit?.count).toBe(0);
			const access = await env.DB.prepare("SELECT COUNT(*) AS count FROM beta_access WHERE email LIKE 'pending-%'")
				.first<{ count: number }>();
			expect(access?.count).toBe(0);
		} finally {
			await env.DB.prepare("DROP TRIGGER fail_local_approval").run();
		}
		const result = await (await approve(review)).json<Approval>();
		expect(result.approved).toHaveLength(3);
		expect(result.skipped).toEqual([]);
	});
});

async function newAccount(email: string) {
	const user = await upsertUser(bindings, {
		googleSub: `synthetic-${crypto.randomUUID()}`, email, name: `Fictional ${email}`, image: "",
	});
	const now = new Date(Date.now() - 60 * day).toISOString();
	await env.DB.batch([
		env.DB.prepare("UPDATE users SET created_at=? WHERE id=?").bind(now, user.id),
		env.DB.prepare("INSERT INTO beta_access(email,status,created_at,updated_at) VALUES(?,'APPROVED',?,?)")
			.bind(email, now, now),
	]);
	const token = crypto.randomUUID();
	const csrf = crypto.randomUUID();
	await createSession(bindings, user.id, await sha256(token), await sha256(csrf),
		new Date(Date.now() + day).toISOString());
	return { user, csrf, cookie: `cc_session=${token}; cc_csrf=${csrf}` };
}

async function event(auth: Auth, action: string, metadata = {}, at = new Date().toISOString()) {
	await env.DB.prepare(
		"INSERT INTO audit_events(id,user_id,action,entity_type,entity_id,request_id,metadata_json,created_at) VALUES(?,?,?,'private','private-recipient','private-request',?,?)",
	).bind(crypto.randomUUID(), auth.user.id, action, JSON.stringify(metadata), at).run();
}

async function pending(count: number) {
	const targets = Array.from({ length: count }, () => {
		const id = crypto.randomUUID();
		return { id, email: `pending-${id}@example.test` };
	});
	const now = new Date().toISOString();
	if (count) await env.DB.batch(targets.map((entry) => env.DB.prepare(
		"INSERT INTO beta_access_requests(id,email,google_sub,status,requested_at,updated_at) VALUES(?,?,?,'PENDING',?,?)",
	).bind(entry.id, entry.email, `synthetic-${entry.id}`, now, now)));
	return targets;
}

async function status(id: string) {
	return (await env.DB.prepare("SELECT status FROM beta_access_requests WHERE id=?")
		.bind(id).first<{ status: string }>())?.status;
}

async function snapshot() {
	const response = await request("/api/beta/admin/requests/pending", owner);
	expect(response.status).toBe(200);
	return response.json<Snapshot>();
}

function approvalBody(review: Snapshot) {
	return { snapshot: review.snapshot, requestIds: review.requests.map((entry) => entry.id) };
}

function approve(review: Snapshot) {
	return request("/api/beta/admin/requests/approve-pending", owner, {
		method: "POST", body: approvalBody(review),
	});
}

async function request(
	path: string,
	auth?: Auth,
	options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
	const context = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, {
		method: options.method || "GET",
		headers: {
			Accept: "application/json", "Content-Type": "application/json",
			Origin: bindings.APP_ORIGIN,
			...(auth ? { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf } : {}),
			...options.headers,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}), bindings, context);
	await waitOnExecutionContext(context);
	return response;
}
