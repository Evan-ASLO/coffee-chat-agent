import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 20_000 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = "http://127.0.0.1:8806";
if (!process.env.OWNER_EVIDENCE_DIR) throw new Error("Set OWNER_EVIDENCE_DIR to a session-artifact directory.");
const output = resolve(process.env.OWNER_EVIDENCE_DIR);
const preview = join(root, ".tutorial-preview");
const receipt = JSON.parse(await readFile(join(preview, "receipt.json"), "utf8"));
const config = JSON.parse(await readFile(join(preview, "wrangler.jsonc"), "utf8"));
assert.equal(receipt.port, 8806);
assert.equal(config.vars.LOCAL_OWNER_PREVIEW, "true");
assert.equal(config.vars.BETA_ADMIN_EMAILS, "owner-activity@example.test");
assert.equal(config.workers_dev, false);
const health = await fetch(`${base}/__review/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { reviewOnly: true, ready: true });
await mkdir(output, { recursive: true });
const records = [];
const external = [];
const pageErrors = [];
const browser = await chromium.launch({ channel: "msedge", headless: true });
let activePage;

function record(label, details = {}) {
	records.push({ label, passed: true, ...details });
}

async function newPage(viewport) {
	const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (["http:", "https:"].includes(url.protocol) && url.origin !== base) {
			external.push(url.origin);
			await route.abort("blockedbyclient");
		} else {
			await route.continue();
		}
	});
	const page = await context.newPage();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	activePage = page;
	return page;
}

async function login(page, account = "owner") {
	await page.goto(`${base}/__review/${account}`);
	await expect(page.locator(".view-settings")).toBeVisible();
}

async function openActivity(page) {
	await page.locator("#owner-controls > summary").click();
	await expect(page.locator(".owner-accounts-table")).toBeVisible();
	await expect(page.locator(".owner-event-list")).toBeVisible();
}

async function openBeta(page) {
	await page.locator("#owner-beta-tab").click();
	await expect(page.locator("#beta-approve-all")).toBeVisible();
	await expect(page.locator("#owner-panel")).not.toContainText("Loading beta access...");
}

async function api(page, path, body) {
	const csrf = (await page.context().cookies(base)).find((cookie) => cookie.name === "cc_csrf")?.value || "";
	return page.request.fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Origin: base, "X-CSRF-Token": csrf },
		...(body === undefined ? {} : { data: body }),
	});
}

async function localSql(sql) {
	const file = join(preview, "owner-browser-fixture.sql");
	await writeFile(file, sql);
	try {
		const result = spawnSync(process.execPath, [
			join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
			"d1", "execute", "onboarding-review", "--config", join(preview, "wrangler.jsonc"),
			"--local", "--persist-to", receipt.state, "--file", file,
		], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
		if (result.status !== 0) throw new Error(`Local fixture write failed: ${result.stderr}\n${result.stdout}`);
	} finally {
		await unlink(file);
	}
}

async function pendingFixtures(count, label) {
	const now = new Date().toISOString();
	const rows = Array.from({ length: count }, () => {
		const id = randomUUID();
		return { id, email: `fictional-${label}-${id.slice(0, 8)}@example.test` };
	});
	await localSql(rows.map((row) =>
		`INSERT INTO beta_access_requests(id,email,google_sub,status,requested_at,updated_at) VALUES('${row.id}','${row.email}','local-browser-${row.id}','PENDING','${now}','${now}');`,
	).join("\n"));
	return rows;
}

async function screenshot(page, name, selector = "#owner-controls > summary") {
	const locator = page.locator(selector);
	await locator.scrollIntoViewIfNeeded();
	await page.evaluate((selection) => {
		const target = document.querySelector(selection);
		window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 18, behavior: "instant" });
	}, selector);
	await page.screenshot({ path: join(output, name) });
}

async function layout(page, label) {
	const result = await page.evaluate(() => {
		const visible = (element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
		const controls = [...document.querySelectorAll("#owner-controls button, #owner-controls select, #owner-controls input, #owner-bulk-dialog button")].filter(visible);
		const unnamed = controls.filter((element) => ![
			element.getAttribute("aria-label"),
			element.matches("input,select") ? "" : element.textContent,
			[...(element.labels || [])].map((label) => label.textContent).join(" "),
		].some((value) => value?.trim())).map((element) => element.id);
		const short = controls.filter((element) => element.getBoundingClientRect().height < 43.9).map((element) => element.id);
		const modal = document.getElementById("owner-bulk-dialog");
		return {
			width: innerWidth, bodyWidth: document.documentElement.scrollWidth,
			unnamed, short,
			modalFits: !modal?.open || modal.getBoundingClientRect().width <= innerWidth,
		};
	});
	assert.ok(result.bodyWidth <= result.width + 1, `${label}: horizontal page overflow ${JSON.stringify(result)}`);
	assert.deepEqual(result.unnamed, []);
	assert.deepEqual(result.short, []);
	assert.equal(result.modalFits, true);
	record(label, result);
}

try {
	for (const route of ["/api/beta/admin/activity", "/api/beta/admin/activity/events", "/api/beta/admin/requests/pending"]) {
		assert.equal((await fetch(`${base}${route}`)).status, 401);
	}
	record("unauthenticated owner routes denied");
	const desktop = await newPage({ width: 1440, height: 1000 });
	await login(desktop);
	let releaseLoading;
	const loadingGate = new Promise((done) => { releaseLoading = done; });
	const activityRoute = "**/api/beta/admin/activity?*";
	await desktop.route(activityRoute, async (route) => { await loadingGate; await route.continue(); });
	await desktop.locator("#owner-controls > summary").click();
	await expect(desktop.locator("#owner-panel")).toContainText("Loading recorded activity...");
	releaseLoading();
	await expect(desktop.locator(".owner-accounts-table")).toBeVisible();
	await expect(desktop.locator(".owner-event-list li")).toHaveCount(25);
	await desktop.unroute(activityRoute);
	await expect(desktop.locator(".owner-accounts-table tbody tr")).toHaveCount(20);
	await expect(desktop.locator("#owner-panel")).toContainText("No recorded activity in this period");
	const activity = await (await api(desktop, "/api/beta/admin/activity")).json();
	assert.equal(activity.summary.accounts, 24);
	assert.ok(activity.summary.total > 25);
	assert.ok(!JSON.stringify(activity).includes("FICTIONAL-PRIVATE-CANARY"));
	await layout(desktop, "desktop dashboard and loading");
	await screenshot(desktop, "desktop-activity.png");

	await desktop.locator("#owner-accounts-next").click();
	await expect(desktop.locator(".owner-accounts-table tbody tr")).toHaveCount(4);
	await expect(desktop.locator("#owner-accounts-next")).toBeDisabled();
	await desktop.locator("#owner-accounts-previous").click();
	await expect(desktop.locator(".owner-accounts-table tbody tr")).toHaveCount(20);
	const firstEvents = await desktop.locator(".owner-event-list li").allTextContents();
	await desktop.locator("#owner-events-next").click();
	await expect(desktop.locator(".owner-events .owner-pagination")).toContainText("Page 2");
	await expect(desktop.locator(".owner-event-list")).toBeVisible();
	const secondEvents = await desktop.locator(".owner-event-list li").allTextContents();
	assert.ok(secondEvents.every((event) => !firstEvents.includes(event)));
	await desktop.locator("#owner-events-previous").click();
	await desktop.locator("#owner-action-filter").selectOption("EMAIL_SENT");
	await expect(desktop.locator(".owner-event-list")).toBeVisible();
	assert.ok((await desktop.locator(".owner-event-list li strong").allTextContents()).every((text) => text === "Outreach email sent"));
	await desktop.locator("#owner-action-filter").selectOption("RESUME_DELETED");
	await expect(desktop.locator(".owner-events")).toContainText("No recorded events match");
	await desktop.locator("#owner-events-reset").click();
	await expect(desktop.locator(".owner-event-list")).toBeVisible();
	const filterUser = await desktop.locator("[data-owner-user]").first().getAttribute("data-owner-user");
	await desktop.locator("[data-owner-user]").first().click();
	await expect(desktop.locator("#owner-user-filter")).toHaveValue(filterUser);
	await expect(desktop.locator(".owner-events")).not.toContainText("Loading recent events...");
	await desktop.locator("#owner-events-reset").click();
	await desktop.locator("#owner-days").selectOption("7");
	await expect(desktop.locator(".owner-accounts-table")).toBeVisible();
	await expect(desktop.locator("#owner-events-next")).toBeDisabled();
	await desktop.locator("#owner-days").selectOption("28");
	await expect(desktop.locator(".owner-event-list li")).toHaveCount(25);
	record("desktop range, account/action filters, empty results and both paginations");
	await screenshot(desktop, "desktop-events.png", "#owner-events-title");

	await desktop.route(activityRoute, (route) => route.fulfill({
		status: 500, contentType: "application/json", body: JSON.stringify({ message: "Fictional activity unavailable." }),
	}));
	await desktop.locator("#owner-refresh").click();
	await expect(desktop.locator("#owner-panel [role=alert]")).toContainText("Fictional activity unavailable.");
	await expect(desktop.locator(".owner-metrics")).toHaveCount(0);
	await desktop.unroute(activityRoute);
	await desktop.locator("#owner-refresh").click();
	await expect(desktop.locator(".owner-event-list")).toBeVisible();
	const eventRoute = "**/api/beta/admin/activity/events?*";
	await desktop.route(eventRoute, (route) => route.fulfill({
		status: 500, contentType: "application/json", body: JSON.stringify({ message: "Fictional event feed unavailable." }),
	}));
	await desktop.locator("#owner-action-filter").selectOption("EMAIL_SENT");
	await expect(desktop.locator("#owner-events-retry")).toBeVisible();
	await desktop.unroute(eventRoute);
	await desktop.locator("#owner-events-retry").click();
	await expect(desktop.locator(".owner-event-list")).toBeVisible();
	record("dashboard and event failures recover without fabricated zeros");

	await openBeta(desktop);
	const initialReview = await (await api(desktop, "/api/beta/admin/requests/pending")).json();
	assert.ok(initialReview.requests.length >= 3 && !initialReview.hasMore);
	await desktop.locator("#beta-approve-all").click();
	await expect(desktop.locator("#owner-bulk-confirm")).toBeEnabled();
	await expect(desktop.locator("#owner-bulk-dialog")).toContainText("after revoked access");
	await expect(desktop.locator("#owner-bulk-dialog")).toContainText("after an earlier denial");
	assert.equal(await desktop.evaluate(() => document.activeElement.id), "owner-bulk-cancel");
	await desktop.locator("#owner-bulk-confirm").focus();
	await desktop.keyboard.press("Tab");
	assert.equal(await desktop.evaluate(() => document.activeElement.id), "owner-bulk-cancel");
	await desktop.keyboard.press("Shift+Tab");
	assert.equal(await desktop.evaluate(() => document.activeElement.id), "owner-bulk-confirm");
	await desktop.keyboard.press("Escape");
	await expect(desktop.locator("#owner-bulk-dialog")).toHaveCount(0);
	await expect(desktop.locator("#beta-approve-all")).toBeFocused();
	await desktop.locator("#beta-approve-all").click();
	await expect(desktop.locator("#owner-bulk-confirm")).toBeEnabled();
	await desktop.locator("#owner-bulk-cancel").click();
	await expect(desktop.locator("#owner-bulk-dialog")).toHaveCount(0);
	assert.equal((await (await api(desktop, "/api/beta/admin/requests/pending")).json()).pendingTotal, initialReview.pendingTotal);
	record("native confirmation cancel, Escape, focus loop and no mutation before approval");

	await desktop.locator("#beta-approve-all").click();
	await expect(desktop.locator("#owner-bulk-confirm")).toBeEnabled();
	const reviewedNames = await desktop.locator(".owner-approval-list li > strong:first-child").allTextContents();
	const [late] = await pendingFixtures(1, "arrived-after-review");
	await expect(desktop.locator("#owner-bulk-dialog")).not.toContainText(late.email);
	const denied = initialReview.requests[0];
	assert.equal((await api(desktop, `/api/beta/admin/requests/${denied.id}/deny`, {})).status(), 200);
	let bulkPosts = 0;
	desktop.on("request", (request) => {
		if (request.url().endsWith("/api/beta/admin/requests/approve-pending") && request.method() === "POST") bulkPosts++;
	});
	await screenshot(desktop, "desktop-approval-confirmation.png", "#owner-bulk-title");
	await desktop.locator("#owner-bulk-confirm").dblclick();
	await expect(desktop.locator("#owner-bulk-dialog")).toContainText(`${reviewedNames.length - 1} approved; 1 skipped`);
	assert.equal(bulkPosts, 1);
	const remaining = await (await api(desktop, "/api/beta/admin/requests/pending")).json();
	assert.deepEqual(remaining.requests.map((entry) => entry.id), [late.id]);
	await screenshot(desktop, "desktop-approval-results.png", "#owner-bulk-title");
	await desktop.locator("#owner-bulk-cancel").click();
	record("real local approval skips a concurrent denial, excludes arrivals and ignores double-click", { approved: reviewedNames.length - 1, skipped: 1 });

	await pendingFixtures(2, "retry");
	await desktop.locator("#owner-access-refresh").click();
	await expect(desktop.locator("#beta-approve-all")).toContainText("(3)");
	await desktop.locator("#beta-approve-all").click();
	await expect(desktop.locator("#owner-bulk-confirm")).toBeEnabled();
	let failedBody;
	const bulkRoute = "**/api/beta/admin/requests/approve-pending";
	await desktop.route(bulkRoute, async (route) => {
		failedBody = route.request().postDataJSON();
		await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Fictional approval unavailable." }) });
	});
	await desktop.locator("#owner-bulk-confirm").click();
	await expect(desktop.locator("#owner-bulk-dialog [role=alert]")).toContainText("result was not confirmed");
	await expect(desktop.locator("#owner-bulk-confirm")).toContainText("Retry these 3 accounts");
	const [afterFailure] = await pendingFixtures(1, "after-failure");
	await desktop.unroute(bulkRoute);
	const retryRequest = desktop.waitForRequest((request) => request.url().endsWith("/requests/approve-pending"));
	await desktop.locator("#owner-bulk-confirm").click();
	assert.deepEqual((await retryRequest).postDataJSON(), failedBody);
	await expect(desktop.locator("#owner-bulk-dialog")).toContainText("3 approved; 0 skipped");
	const afterRetry = await (await api(desktop, "/api/beta/admin/requests/pending")).json();
	assert.deepEqual(afterRetry.requests.map((entry) => entry.id), [afterFailure.id]);
	await desktop.locator("#owner-bulk-cancel").click();
	record("failed response retains the exact confirmation for retry and excludes later arrivals");

	await desktop.request.get(`${base}/__review/member`);
	await desktop.evaluate(() => refresh("settings"));
	await expect(desktop.locator("#owner-controls")).toHaveCount(0);
	assert.equal((await api(desktop, "/api/beta/admin/activity")).status(), 403);
	await desktop.evaluate(() => { state.session.isBetaAdmin = true; render(); });
	await desktop.locator("#owner-controls > summary").click();
	await expect(desktop.locator("#owner-controls")).toHaveCount(0);
	await screenshot(desktop, "member-settings.png", ".settings-reference-hero");
	record("account switching clears owner UI and a forged client owner flag is denied by the server");
	await login(desktop);
	await openActivity(desktop);
	await desktop.locator("#logout").click();
	await expect(desktop.locator("#owner-controls")).toHaveCount(0);
	await expect(desktop.locator(".beta-landing")).toBeVisible();
	assert.equal((await api(desktop, "/api/beta/admin/activity")).status(), 401);
	record("logout clears owner controls and invalidates the authenticated session");
	await desktop.context().close();

	await pendingFixtures(2, "phone");
	const phone = await newPage({ width: 390, height: 844 });
	await login(phone);
	await openActivity(phone);
	await layout(phone, "phone dashboard, contained table scroll and 44px controls");
	await screenshot(phone, "phone-activity.png");
	await phone.locator("#owner-accounts-next").click();
	await expect(phone.locator(".owner-accounts-table tbody tr")).toHaveCount(4);
	await openBeta(phone);
	await phone.locator("#beta-approve-all").click();
	await expect(phone.locator("#owner-bulk-confirm")).toBeEnabled();
	await layout(phone, "phone confirmation bounds and accessible names");
	await screenshot(phone, "phone-approval-confirmation.png", "#owner-bulk-title");
	await phone.keyboard.press("Escape");
	await expect(phone.locator("#beta-approve-all")).toBeFocused();
	await phone.locator("#beta-approve-all").click();
	await expect(phone.locator("#owner-bulk-confirm")).toBeEnabled();
	await phone.locator("#owner-bulk-confirm").click();
	await expect(phone.locator("#owner-bulk-dialog")).toContainText("3 approved; 0 skipped");
	await phone.locator("#owner-bulk-cancel").click();
	await expect(phone.locator("#beta-approve-all")).toBeDisabled();
	await expect(phone.locator("#beta-approve-all")).toContainText("(0)");
	await expect(phone.locator("#owner-panel")).toContainText("No access requests are pending.");
	record("phone approval succeeds and zero-pending control is disabled");
	await phone.context().close();

	for (const [path, method] of [
		["/auth/google/connect", "GET"], ["/api/discovery", "POST"], ["/api/workspace/init", "POST"],
		["/api/internal/jobs/snapshot", "POST"], ["/api/credentials/ANTHROPIC", "PUT"],
		["/api/prospects/00000000-0000-4000-8000-000000000000/prepare", "POST"],
		["/api/prospects/00000000-0000-4000-8000-000000000000/send", "POST"],
	]) {
		assert.equal((await fetch(`${base}${path}`, { method, redirect: "manual" })).status, 403);
	}
	assert.deepEqual(external, []);
	assert.deepEqual(pageErrors, []);
	record("review blocks provider/OAuth/discovery/draft/CRM/ingestion/send actions; zero external requests");
	const handoff = await pendingFixtures(3, "ready-for-review");
	record("three fresh fictional pending requests remain for local handoff", { pending: handoff.length });
	await writeFile(join(output, "browser-evidence.json"), JSON.stringify({
		passed: true, base, checkedAt: new Date().toISOString(),
		viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }],
		externalRequests: external.length, pageErrors, records,
	}, null, 2));
	console.log(`Owner browser checks passed: ${records.length} focused scenarios; evidence: ${output}`);
} catch (error) {
	if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(output, "failure.png") });
	await writeFile(join(output, "browser-evidence.json"), JSON.stringify({
		passed: false, checkedAt: new Date().toISOString(), error: error.message, records, external, pageErrors,
	}, null, 2));
	throw error;
} finally {
	await browser.close();
}
