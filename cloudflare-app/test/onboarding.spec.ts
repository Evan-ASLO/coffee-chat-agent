import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src";
import type { AppBindings, AuthenticatedUser } from "../src/types";
import { acceptVerifiedGoogleLogin } from "../src/lib/auth";
import { createSession, upsertUser } from "../src/lib/db";
import { sha256 } from "../src/lib/encoding";
import { getSettings } from "../src/lib/store";
import { ONBOARDING_STEPS, getOnboarding, type OnboardingState } from "../src/lib/onboarding";

const bindings = env as AppBindings;
const legacyId = "00000000-0000-4000-8000-000000000801";
const legacyProfile = {
	googleSub: "tutorial-before-migration",
	email: "legacy-tutorial@example.test",
	name: "Fictional legacy tester",
	image: "",
};

beforeAll(async () => {
	const statements: string[] = JSON.parse(
		(env as typeof env & { MIGRATION_STATEMENTS: string }).MIGRATION_STATEMENTS,
	);
	const tutorialStart = statements.findIndex((statement) =>
		statement.startsWith("ALTER TABLE users ADD COLUMN onboarding_status"),
	);
	expect(tutorialStart).toBeGreaterThan(0);
	await env.DB.batch(statements.slice(0, tutorialStart).map((statement) => env.DB.prepare(statement)));
	await env.DB.prepare(
		"INSERT INTO users(id,google_sub,email,name,image,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
	).bind(legacyId, legacyProfile.googleSub, legacyProfile.email, legacyProfile.name, "", new Date().toISOString(), new Date().toISOString()).run();
	await env.DB.prepare("INSERT INTO user_settings(user_id,created_at,updated_at) VALUES(?,?,?)")
		.bind(legacyId, new Date().toISOString(), new Date().toISOString()).run();
	await env.DB.batch(statements.slice(tutorialStart).map((statement) => env.DB.prepare(statement)));
});

describe("first-login tutorial ownership and transitions", () => {
	it("backfills existing accounts as legacy and preserves that state on later login", async () => {
		expect(await getOnboarding(bindings, legacyId)).toMatchObject({
			version: 1, status: "legacy", step: "welcome", revision: 0, updatedAt: null,
		});
		const returned = await upsertUser(bindings, legacyProfile);
		expect(returned.id).toBe(legacyId);
		expect((await getOnboarding(bindings, legacyId)).status).toBe("legacy");
	});

	it("invites only genuinely new approved accounts, without Google or provider calls", async () => {
		const profile = fictionalProfile();
		const betaBindings = { ...bindings, BETA_ACCESS_MODE: "ALLOWLIST", BETA_ADMIN_EMAILS: profile.email };
		const network = vi.spyOn(globalThis, "fetch");
		try {
			const user = await acceptVerifiedGoogleLogin(betaBindings, profile);
			expect(user).not.toBeNull();
			if (!user) throw new Error("Expected approved fictional user");
			const auth = await session(user);
			const response = await request(auth, "/api/session", {}, betaBindings);
			const body = await response.json() as { onboarding: OnboardingState };
			expect(body.onboarding).toMatchObject({ status: "invited", step: "welcome", revision: 0 });
			expect((await acceptVerifiedGoogleLogin(betaBindings, profile))?.id).toBe(user.id);
			expect(await getOnboarding(bindings, user.id)).toEqual(body.onboarding);
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
		}
	});

	it("does not create tutorial/user state for denied verified beta logins", async () => {
		const profile = fictionalProfile();
		const betaBindings = { ...bindings, BETA_ACCESS_MODE: "ALLOWLIST", BETA_ADMIN_EMAILS: "" };
		expect(await acceptVerifiedGoogleLogin(betaBindings, profile)).toBeNull();
		await env.DB.prepare("UPDATE beta_access_requests SET status='DENIED',google_sub='' WHERE email=?")
			.bind(profile.email).run();
		expect(await acceptVerifiedGoogleLogin(betaBindings, profile)).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM users WHERE google_sub=?").bind(profile.googleSub).first()).toBeNull();
	});

	it("returns no state to signed-out, denied, or revoked sessions", async () => {
		const anonymous = await request(null, "/api/session");
		expect(await anonymous.json()).not.toHaveProperty("onboarding");
		for (const method of ["GET", "PUT"]) {
			expect((await request(null, "/api/onboarding", { method, body: method === "PUT" ? payload("start", "welcome", 0) : undefined })).status).toBe(401);
		}
		for (const access of ["DENIED", "REVOKED"]) {
			const auth = await newUser();
			if (access === "REVOKED") {
				await env.DB.prepare("INSERT INTO beta_access(email,status,created_at,updated_at) VALUES(?,'REVOKED',?,?)")
					.bind(auth.user.email, new Date().toISOString(), new Date().toISOString()).run();
			}
			const betaBindings = { ...bindings, BETA_ACCESS_MODE: "ALLOWLIST", BETA_ADMIN_EMAILS: "" };
			expect((await request(auth, "/api/onboarding", {}, betaBindings)).status).toBe(401);
			expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("start", "welcome", 0) }, betaBindings)).status).toBe(401);
			expect(await (await request(auth, "/api/session", {}, betaBindings)).json()).not.toHaveProperty("onboarding");
			expect((await getOnboarding(bindings, auth.user.id)).revision).toBe(0);
		}
	});

	it("scopes all reads and writes to the session, ignoring read selectors and rejecting write ownership fields", async () => {
		const first = await newUser();
		const second = await newUser();
		await mutate(first, "start", "welcome", 0);
		await mutate(first, "progress", "tavily", 1);
		const read = await request(first, `/api/onboarding?user_id=${second.user.id}`);
		expect(await read.json()).toMatchObject({ onboarding: { step: "tavily", revision: 2 } });
		const attack = await request(first, "/api/onboarding", {
			method: "PUT", body: { ...payload("skip", "tavily", 2), user_id: second.user.id },
		});
		expect(attack.status).toBe(400);
		expect((await getOnboarding(bindings, second.user.id)).status).toBe("invited");
		expect((await getOnboarding(bindings, first.user.id)).status).toBe("in_progress");
	});

	it("requires CSRF and same-origin protection on tutorial mutations", async () => {
		const auth = await newUser();
		for (const headers of [{ Origin: bindings.APP_ORIGIN }, { "X-CSRF-Token": auth.csrf }, { Origin: "https://other.example.test", "X-CSRF-Token": auth.csrf }]) {
			const context = createExecutionContext();
			const response = await worker.fetch(new Request("http://example.com/api/onboarding", {
				method: "PUT",
				headers: { Cookie: auth.cookie, "Content-Type": "application/json", ...headers },
				body: JSON.stringify(payload("start", "welcome", 0)),
			}), bindings, context);
			await waitOnExecutionContext(context);
			expect(response.status).toBe(403);
		}
		expect((await getOnboarding(bindings, auth.user.id)).revision).toBe(0);
	});

	it("validates version, stable steps, adjacency, actions, and strict payload shape", async () => {
		const auth = await newUser();
		for (const invalid of [
			{ ...payload("start", "welcome", 0), version: 2 },
			{ ...payload("start", "welcome", 0), step: "unrecognized" },
			{ ...payload("start", "welcome", 0), status: "completed" },
			{ ...payload("start", "welcome", 0), revision: -1 },
			payload("complete", "welcome", 0),
			payload("progress", "tavily", 0),
		]) {
			expect((await request(auth, "/api/onboarding", { method: "PUT", body: invalid })).status).toBe(400);
		}
		await mutate(auth, "start", "welcome", 0);
		expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("progress", "analytics", 1) })).status).toBe(400);
		expect((await getOnboarding(bindings, auth.user.id)).revision).toBe(1);
	});

	it("distinguishes Continue later from Skip, and resumes on a second session", async () => {
		const auth = await newUser();
		await mutate(auth, "start", "welcome", 0);
		await mutate(auth, "progress", "tavily", 1);
		const paused = await mutate(auth, "pause", "tavily", 2);
		expect(paused.status).toBe("paused");
		const secondDevice = await session(auth.user);
		expect(await (await request(secondDevice, "/api/onboarding")).json()).toEqual({ onboarding: paused });
		await mutate(secondDevice, "resume", "tavily", 3);
		const skipped = await mutate(secondDevice, "skip", "tavily", 4);
		expect(skipped.status).toBe("skipped");
		expect(await (await request(auth, "/api/onboarding")).json()).toEqual({ onboarding: skipped });
		expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("progress", "hunter", 2) })).status).toBe(409);
		expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("resume", "tavily", 5) })).status).toBe(400);
		expect((await getOnboarding(bindings, auth.user.id)).status).toBe("skipped");
		expect(await mutate(auth, "replay", "welcome", 5)).toMatchObject({ status: "in_progress", step: "welcome", revision: 6 });
	});

	it("allows key-free chapter skipping only as an explicit action", async () => {
		const auth = await newUser();
		const state = await mutate(auth, "explore", "home-summary", 0);
		expect(state).toMatchObject({ status: "in_progress", step: "home-summary" });
		expect((await getSettings(bindings, auth.user.id))).toMatchObject({
			draftProvider: "TEMPLATE", enrichmentProvider: "HUNTER", peopleSearchFallbackProvider: "NONE",
		});
		expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("explore", "home-summary", 1) })).status).toBe(400);
	});

	it("completes the whole guide with zero provider requests and rejects stale uncompletion", async () => {
		const auth = await newUser();
		const network = vi.spyOn(globalThis, "fetch");
		try {
			let saved = await mutate(auth, "start", "welcome", 0);
			for (const step of ONBOARDING_STEPS.slice(1)) saved = await mutate(auth, "progress", step, saved.revision);
			const staleRevision = saved.revision;
			saved = await mutate(auth, "complete", "workspace-settings", saved.revision);
			expect(saved.status).toBe("completed");
			expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("progress", "analytics", staleRevision) })).status).toBe(409);
			expect((await request(auth, "/api/onboarding", { method: "PUT", body: payload("progress", "analytics", saved.revision) })).status).toBe(400);
			const relogin = await upsertUser(bindings, {
				googleSub: auth.user.googleSub, email: auth.user.email, name: auth.user.name, image: "",
			});
			expect(relogin.id).toBe(auth.user.id);
			expect(await getOnboarding(bindings, relogin.id)).toEqual(saved);
			const secondDevice = await session(relogin);
			expect(await (await request(secondDevice, "/api/onboarding")).json()).toEqual({ onboarding: saved });
			expect(await mutate(auth, "replay", "welcome", saved.revision)).toMatchObject({ status: "in_progress", step: "welcome" });
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
		}
	});

	it("atomically admits only one of two writes with the same revision", async () => {
		const auth = await newUser();
		await mutate(auth, "start", "welcome", 0);
		const results = await Promise.all([
			request(auth, "/api/onboarding", { method: "PUT", body: payload("skip", "welcome", 1) }),
			request(auth, "/api/onboarding", { method: "PUT", body: payload("pause", "welcome", 1) }),
		]);
		expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
		expect((await getOnboarding(bindings, auth.user.id)).revision).toBe(2);
	});

	it("never stores credentials or personal context in progress/audits; old settings clients preserve tutorial state", async () => {
		const auth = await newUser();
		await mutate(auth, "start", "welcome", 0);
		const saved = await mutate(auth, "progress", "tavily", 1);
		const fakeKey = "FAKE-TEST-ONLY-TAVILY-SECRET-NOT-A-REAL-KEY";
		expect((await request(auth, "/api/credentials/TAVILY", { method: "PUT", body: { value: fakeKey } })).status).toBe(200);
		const settings = await getSettings(bindings, auth.user.id);
		const { userId: _userId, spreadsheetId: _spreadsheetId, ...editable } = settings;
		expect((await request(auth, "/api/settings", {
			method: "PUT",
			body: { ...editable, senderName: "Fictional tester", personalContext: [{ category: "Background summary", content: "Fictional private profile marker." }] },
		})).status).toBe(200);
		expect(await getOnboarding(bindings, auth.user.id)).toEqual(saved);
		const serialized = JSON.stringify(await (await request(auth, "/api/onboarding")).json());
		expect(serialized).not.toContain(fakeKey);
		expect(serialized).not.toContain("Fictional private profile marker.");
		expect(Object.keys(JSON.parse(serialized).onboarding).sort()).toEqual(["revision", "status", "step", "updatedAt", "version"]);
		const audits = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE user_id=?").bind(auth.user.id).all();
		expect(JSON.stringify(audits)).not.toContain(fakeKey);
		expect(JSON.stringify(audits)).not.toContain("Fictional private profile marker.");
		const encrypted = await env.DB.prepare("SELECT ciphertext,key_hint FROM encrypted_credentials WHERE user_id=?").bind(auth.user.id).first();
		expect(JSON.stringify(encrypted)).not.toContain(fakeKey);
	});
});

function fictionalProfile() {
	const id = crypto.randomUUID();
	return { googleSub: `tutorial-${id}`, email: `tutorial-${id}@example.test`, name: "Fictional tester", image: "" };
}

async function newUser() {
	return session(await upsertUser(bindings, fictionalProfile()));
}

async function session(user: AuthenticatedUser) {
	const token = `fake-session-${crypto.randomUUID()}`;
	const csrf = `fake-csrf-${crypto.randomUUID()}`;
	await createSession(bindings, user.id, await sha256(token), await sha256(csrf), new Date(Date.now() + 3600000).toISOString());
	const prefix = new URL(bindings.APP_ORIGIN).protocol === "https:" ? "__Host-" : "";
	return { user, csrf, cookie: `${prefix}cc_session=${token}; ${prefix}cc_csrf=${csrf}` };
}

function payload(action: string, step: string, revision: number) {
	return { version: 1, revision, action, step };
}

async function mutate(auth: Awaited<ReturnType<typeof session>>, action: string, step: string, revision: number) {
	const response = await request(auth, "/api/onboarding", { method: "PUT", body: payload(action, step, revision) });
	expect(response.status, await response.clone().text()).toBe(200);
	const body = await response.json() as { onboarding: OnboardingState };
	return body.onboarding;
}

async function request(
	auth: Awaited<ReturnType<typeof session>> | null,
	path: string,
	options: { method?: string; body?: unknown } = {},
	customBindings = bindings,
) {
	const context = createExecutionContext();
	const method = options.method || "GET";
	const response = await worker.fetch(new Request(`http://example.com${path}`, {
		method,
		headers: {
			Accept: "application/json",
			...(auth ? { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf } : {}),
			...(method !== "GET" ? { Origin: customBindings.APP_ORIGIN, "Content-Type": "application/json" } : {}),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}), customBindings, context);
	await waitOnExecutionContext(context);
	return response;
}
