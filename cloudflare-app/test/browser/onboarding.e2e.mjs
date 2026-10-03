import { test as base, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidence = process.env.TUTORIAL_EVIDENCE_DIR || join(root, ".tutorial-preview", "evidence");
const require = createRequire(import.meta.url);
const { stepIds } = require("../../public/onboarding.js");
const costly = (url) => url.pathname.startsWith("/auth/") ||
	url.pathname === "/api/discovery" || url.pathname === "/api/resume" ||
	url.pathname === "/api/workspace/init" ||
	/^\/api\/prospects\/[^/]+\/(prepare|regenerate|send|sync)$/.test(url.pathname);

const test = base.extend({
	safety: [async ({ page }, use, testInfo) => {
		const mutations = [];
		const forbidden = [];
		const external = [];
		const pageErrors = [];
		const consoleErrors = [];
		const allowed = new Set();
		const safety = { mutations, forbidden, allowed, resourceFailuresExpected: false };
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (costly(url)) forbidden.push(url.pathname);
			if (request.method() !== "GET") mutations.push({ path: url.pathname, method: request.method() });
			if (url.pathname === "/api/onboarding" && request.method() === "PUT") {
				expect(Object.keys(request.postDataJSON()).sort()).toEqual(["action", "revision", "step", "version"]);
			}
		});
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
				external.push(`${url.origin}${url.pathname}`);
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});
		await use(safety);
		await mkdir(evidence, { recursive: true });
		if (testInfo.status !== testInfo.expectedStatus) {
			await screenshot(page, `failure-${testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 80)}.png`);
		}
		await writeFile(join(evidence, `network-${testInfo.testId.replace(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify({
			test: testInfo.title, mutationCounts: counts(mutations.map((item) => item.path)),
			costlyRequests: forbidden, allowedExplicitUserRequests: [...allowed],
			externalRequests: external, pageErrors, consoleErrors,
		}, null, 2));
		expect(forbidden.filter((path) => !allowed.has(path)), "Tutorial controls must not cause billable/Google actions").toEqual([]);
		expect(external, "No real external requests are permitted").toEqual([]);
		expect(pageErrors, "No JavaScript exceptions").toEqual([]);
		expect(consoleErrors.filter((message) => !(safety.resourceFailuresExpected && message.startsWith("Failed to load resource:"))), "No unexpected console errors").toEqual([]);
	}, { auto: true }],
});

test.beforeEach(async ({ request }) => {
	expect((await request.post("/__review/reset")).ok()).toBe(true);
});

test("new approved invitation is optional; legacy, signed-out and denied visitors are not forced", async ({ page }) => {
	await page.goto("/__review/new");
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "invited");
	await expect(panel(page)).toContainText("Set up API keys");
	await expect(panel(page)).toContainText("Explore your workspace");
	await screenshot(page, "desktop-new-account-invitation.png");
	await navigate(page, "jobs");
	await expect(page.locator("#job-filter-form")).toBeVisible();
	await expect(panel(page)).toContainText("You're exploring another page");
	await panel(page).getByRole("button", { name: "Return to this step", exact: true }).click();
	await expect(page.locator("[data-tour=home-summary]")).toBeVisible();
	await page.goto("/__review/existing");
	await expect(panel(page)).toBeHidden();
	await navigate(page, "settings");
	await expect(page.getByRole("button", { name: "Replay tutorial", exact: true })).toBeVisible();
	await page.goto("/__review/signed-out");
	await expect(page.locator(".beta-landing")).toBeVisible();
	await expect(page.locator("#onboarding-root")).toBeHidden();
	expect((await page.request.get("/api/onboarding")).status()).toBe(401);
	await page.goto("/__review/denied");
	await expect(page.locator(".beta-landing")).toBeVisible();
	await expect(panel(page)).toBeHidden();
	expect((await page.request.get("/api/onboarding")).status()).toBe(401);
});

test("password credential save failure, retry and masked saved status never cache a raw key", async ({ page, safety }) => {
	safety.resourceFailuresExpected = true;
	await startNew(page);
	await next(page, "tavily");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveAttribute("type", "password");
	const key = "FAKE-LOCAL-TAVILY-KEY-NOT-A-REAL-SECRET";
	let fail = true;
	await page.route("**/api/credentials/TAVILY", async (route) => {
		if (fail) {
			fail = false;
			await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Fictional save failure." }) });
		} else await route.continue();
	});
	await page.getByLabel("Tavily API key", { exact: true }).fill(key);
	await page.locator('[data-save-secret="TAVILY"]').click();
	await expect(page.locator("#secret-status-TAVILY")).toContainText("Not saved");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(key);
	expect((await sessionState(page)).credentials.TAVILY.configured).toBe(false);
	await page.locator('[data-save-secret="TAVILY"]').click();
	await expect(page.locator("#secret-status-TAVILY")).toContainText("Saved");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue("");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toBeVisible();
	await expect(panel(page)).toContainText("not provider-validated");
	expect((await sessionState(page)).credentials.TAVILY.configured).toBe(true);
	expect(await page.content()).not.toContain(key);
	expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
	expect(JSON.stringify((await sessionState(page)).onboarding)).not.toContain(key);
	await screenshot(page, "desktop-tavily-saved.png");
	await next(page, "hunter");
	expect((await sessionState(page)).settings.peopleSearchFallbackProvider).toBe("NONE");
});

test("manual and Template paths use real preferences; one AI selection and explicit fallback remain unchanged by touring", async ({ page, safety }) => {
	await startNew(page);
	await next(page, "tavily");
	await next(page, "hunter");
	await panel(page).getByRole("button", { name: "Choose email enrichment" }).click();
	await expect(page.locator("#profile-settings-dialog")).toBeVisible();
	await expect(panel(page)).toBeHidden();
	expect(await page.locator("dialog:modal").count()).toBe(1);
	await expect(page.locator("[data-tutorial-note]")).toContainText("Tutorial is waiting");
	await page.getByLabel("Your name", { exact: true }).fill("Fictional browser reviewer");
	await page.getByRole("combobox", { name: "Email enrichment", exact: true }).selectOption("NONE");
	await page.getByRole("textbox", { name: "Background summary", exact: true }).fill("Fictional review context, not a real experience.");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(panel(page)).toBeVisible();
	expect((await sessionState(page)).settings).toMatchObject({ enrichmentProvider: "NONE", draftProvider: "TEMPLATE", peopleSearchFallbackProvider: "NONE" });
	await next(page, "drafting");
	const beforeCancel = safety.mutations.filter((item) => item.path === "/api/settings").length;
	await panel(page).getByRole("button", { name: "Choose a drafting path" }).click();
	await page.getByRole("combobox", { name: "Draft provider", exact: true }).selectOption("OPENAI");
	await page.getByRole("button", { name: "Close profile settings", exact: true }).click();
	await expect(panel(page)).toBeVisible();
	expect(safety.mutations.filter((item) => item.path === "/api/settings").length).toBe(beforeCancel);
	expect((await sessionState(page)).settings.draftProvider).toBe("TEMPLATE");
	await panel(page).getByRole("button", { name: "Choose a drafting path" }).click();
	await page.getByRole("combobox", { name: "Draft provider", exact: true }).selectOption("GEMINI");
	await page.getByLabel("Gemini model", { exact: true }).fill("gemini-3.7-flash");
	await page.getByRole("combobox", { name: /^Cited people-search fallback/ }).selectOption("OPENAI");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(panel(page)).toContainText("GEMINI");
	await page.locator(".credentials-details > summary").click();
	await page.getByLabel("Gemini API key", { exact: true }).fill("FAKE-LOCAL-GEMINI-KEY-NOT-A-REAL-SECRET");
	await page.locator('[data-save-secret="GEMINI"]').click();
	await expect(panel(page)).toContainText("Saved");
	await next(page, "search-fallback");
	await expect(panel(page)).toContainText("OPENAI");
	await next(page, "personal-context");
	await next(page, "google-connections");
	const session = await sessionState(page);
	expect(session.settings).toMatchObject({ enrichmentProvider: "NONE", draftProvider: "GEMINI", geminiModel: "gemini-3.7-flash", peopleSearchFallbackProvider: "OPENAI" });
	expect(session.credentials.OPENAI.configured).toBe(false);
	expect(session.credentials.ANTHROPIC.configured).toBe(false);
	expect(session.credentials.HUNTER.configured).toBe(false);
});

test("forward and Back visit every real page, complete across devices, and explicitly replay legacy accounts", async ({ page, browser }) => {
	await page.goto("/__review/existing");
	await navigate(page, "settings");
	await page.getByRole("button", { name: "Replay tutorial", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	await screenshot(page, "desktop-existing-account-replay.png");
	for (const step of stepIds.slice(1)) {
		await next(page, step);
		await expect(panel(page)).toBeVisible();
		await expect(page.locator(".tutorial-spotlight")).toBeVisible();
		expect(await page.locator("#journey-canvas canvas").count()).toBeLessThanOrEqual(1);
		if (step === "home-summary") await screenshot(page, "desktop-home-workspace-tour.png");
		if (step === "applications") {
			await page.locator("[data-application-edit]").first().click();
			await expect(page.locator("#application-dialog")).toBeVisible();
			await expect(panel(page)).toBeHidden();
			expect(await page.locator("dialog:modal").count()).toBe(1);
			await screenshot(page, "desktop-application-dialog.png");
			await page.getByRole("button", { name: "Close application editor", exact: true }).click();
			await expect(panel(page)).toBeVisible();
		}
		if (step === "networking-find") {
			await panel(page).getByRole("button", { name: "Inspect the search form (no search)" }).click();
			await expect(page.locator("#find-form")).toBeVisible();
			await expect(panel(page)).toBeHidden();
			await page.getByRole("button", { name: "Close people search", exact: true }).click();
			await expect(panel(page)).toBeVisible();
		}
		if (step === "networking-send") {
			await page.locator("[data-review]").first().click();
			await expect(page.locator("#draft-dialog")).toBeVisible();
			await expect(panel(page)).toBeHidden();
			await expect(page.getByLabel("Recipient email", { exact: true })).toHaveValue("");
			await screenshot(page, "desktop-fictional-draft-review.png");
			await page.getByRole("button", { name: "Close dialog", exact: true }).click();
			await expect(panel(page)).toBeVisible();
		}
	}
	await panel(page).getByRole("button", { name: "Back", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "analytics");
	await next(page, "workspace-settings");
	await panel(page).getByRole("button", { name: "Finish tutorial", exact: true }).click();
	await expect(panel(page)).toBeHidden();
	expect((await sessionState(page)).onboarding.status).toBe("completed");
	await expect(page.getByRole("button", { name: "Replay tutorial", exact: true })).toBeVisible();
	await screenshot(page, "desktop-completed-settings.png");
	await page.reload();
	await expect(panel(page)).toBeHidden();
	const otherDevice = await browser.newContext();
	const otherPage = await otherDevice.newPage();
	await otherPage.goto(`${baseUrl()}/__review/existing`);
	await expect(panel(otherPage)).toBeHidden();
	expect((await sessionState(otherPage)).onboarding.status).toBe("completed");
	await otherDevice.close();
	await page.getByRole("button", { name: "Replay tutorial", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	expect((await sessionState(page)).onboarding.status).toBe("in_progress");
});

test("progress errors stay visible; retry confirms a lost response and stale writes cannot unskip", async ({ page, safety }) => {
	safety.resourceFailuresExpected = true;
	await page.goto("/__review/new");
	let mode = "fail";
	await page.route("**/api/onboarding", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		if (mode === "fail") {
			mode = "normal";
			return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Fictional offline save." }) });
		}
		if (mode === "lose-response") {
			mode = "normal";
			await route.fetch();
			return route.abort("internetdisconnected");
		}
		return route.continue();
	});
	await panel(page).getByRole("button", { name: "Start tutorial", exact: true }).click();
	await expect(panel(page)).toContainText("Progress was not confirmed saved");
	expect((await sessionState(page)).onboarding.status).toBe("invited");
	await panel(page).getByRole("button", { name: "Retry saving", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "in_progress");
	mode = "lose-response";
	await panel(page).getByRole("button", { name: "Next", exact: true }).click();
	await expect(panel(page)).toContainText("Progress was not confirmed saved");
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	expect((await sessionState(page)).onboarding.step).toBe("tavily");
	await panel(page).getByRole("button", { name: "Retry saving", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "tavily");
	const state = (await sessionState(page)).onboarding;
	expect((await mutateViaRequest(page, { ...state, action: "skip" })).ok()).toBe(true);
	await panel(page).getByRole("button", { name: "Next", exact: true }).click();
	await expect(panel(page)).toBeHidden();
	expect((await sessionState(page)).onboarding.status).toBe("skipped");
	await page.reload();
	await expect(panel(page)).toBeHidden();
});

test("Continue later, Escape and resume are distinct from Skip and survive sign-in", async ({ page }) => {
	await startNew(page);
	await next(page, "tavily");
	await page.getByLabel("Tavily API key", { exact: true }).fill("FAKE-UNSAVED-INPUT-MUST-BE-CLEARED");
	await page.evaluate(() => { window.testSecretControl = document.getElementById("secret-TAVILY"); });
	await page.keyboard.press("Escape");
	await expect(panel(page)).toBeHidden();
	expect(await page.evaluate(() => window.testSecretControl.value)).toBe("");
	expect((await sessionState(page)).onboarding).toMatchObject({ status: "paused", step: "tavily" });
	await expect(page.locator("#main-content")).toBeFocused();
	await page.goto("/__review/new");
	await expect(panel(page)).toBeHidden();
	await navigate(page, "settings");
	await page.getByRole("button", { name: "Resume tutorial", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "tavily");
	await expect(page.locator("#tutorial-title")).toBeFocused();
	await page.keyboard.press("Tab");
	expect(await page.evaluate(() => document.activeElement.closest("#onboarding-root") !== null)).toBe(true);
	await panel(page).getByRole("button", { name: "Skip tutorial", exact: true }).click();
	await expect(panel(page)).toBeHidden();
	expect((await sessionState(page)).onboarding.status).toBe("skipped");
	await page.goto("/__review/new");
	await expect(panel(page)).toBeHidden();
});

test("account changes and revoked sessions dispose unsaved controls and private tutorial state", async ({ page, safety }) => {
	safety.resourceFailuresExpected = true;
	await startNew(page);
	await next(page, "tavily");
	const firstCookies = await page.context().cookies();
	await page.getByLabel("Tavily API key", { exact: true }).fill("FAKE-ACCOUNT-SWITCH-UNSAVED-KEY");
	await page.evaluate(() => { window.testOldControl = document.getElementById("secret-TAVILY"); });
	await page.request.get("/__review/second");
	await page.evaluate(async () => { await refresh(); });
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "invited");
	expect(await page.evaluate(() => window.testOldControl.value)).toBe("");
	expect((await sessionState(page)).user.email).toBe("tutorial-second@example.test");
	await page.context().addCookies(firstCookies);
	await page.evaluate(async () => { await refresh(); });
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "tavily");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toBeVisible();
	await page.getByLabel("Tavily API key", { exact: true }).fill("FAKE-REVOKED-UNSAVED-KEY");
	await page.request.post("/__review/revoke-new");
	await panel(page).getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.locator(".beta-landing")).toBeVisible();
	await expect(page.locator("#onboarding-root")).toBeHidden();
	expect((await page.request.get("/api/onboarding")).status()).toBe(401);
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("account switches clear old private controls before a failed workspace refresh", async ({ page, safety }) => {
	safety.resourceFailuresExpected = true;
	await startNew(page);
	await next(page, "tavily");
	await page.getByLabel("Tavily API key", { exact: true }).fill("FAKE-INTERRUPTED-ACCOUNT-SWITCH-KEY");
	await page.evaluate(() => { window.testOldControl = document.getElementById("secret-TAVILY"); });
	await page.request.get("/__review/second");
	await page.route(/\/api\/jobs(?:\?|$)/, (route) => route.fulfill({
		status: 503, contentType: "application/json",
		body: JSON.stringify({ message: "Fictional workspace refresh unavailable." }),
	}));
	const error = await page.evaluate(async () => {
		try { await refresh(); return null; }
		catch (error) { return error.message; }
	});
	expect(error).toBe("Fictional workspace refresh unavailable.");
	expect(await page.evaluate(() => window.testOldControl.value)).toBe("");
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "invited");
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	const session = await sessionState(page);
	expect(session.user.email).toBe("tutorial-second@example.test");
	expect(session.credentials.TAVILY.configured).toBe(false);
	expect(await page.content()).not.toContain("FAKE-INTERRUPTED-ACCOUNT-SWITCH-KEY");
	await expect(page.locator(".top-email")).toHaveText("tutorial-second@example.test");
});

test("explicit mocked Connect redirect preserves the already-saved step without granting real Google access", async ({ page, safety }) => {
	safety.allowed.add("/auth/google/connect");
	await startNew(page);
	for (const step of stepIds.slice(1, 7)) await next(page, step);
	expect((await sessionState(page)).onboarding.step).toBe("google-connections");
	await page.route("**/auth/google/connect", (route) => route.fulfill({ status: 302, headers: { Location: "/?connected=1" }, body: "" }));
	await page.locator('[data-tour="google-connections"] a[href="/auth/google/connect"]').click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "google-connections");
	expect((await sessionState(page)).credentials.GOOGLE.configured).toBe(false);
});

test("restored-page events reload authenticated progress after disposing private controls", async ({ page }) => {
	await startNew(page);
	await next(page, "tavily");
	await page.getByLabel("Tavily API key", { exact: true }).fill("FAKE-RESTORED-PAGE-UNSAVED-KEY");
	const disposed = await page.evaluate(() => {
		const input = document.getElementById("secret-TAVILY");
		window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		return { key: input.value, roots: document.querySelectorAll("#onboarding-root").length };
	});
	expect(disposed).toEqual({ key: "", roots: 0 });
	const restored = page.waitForEvent("domcontentloaded");
	await page.evaluate(() => {
		setTimeout(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })), 0);
	});
	await restored;
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "tavily");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue("");
	await next(page, "hunter");
	expect((await sessionState(page)).onboarding.step).toBe("hunter");
});

test("phone menu, reduced motion, resizing and empty/missing targets keep the guide readable and safe", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await startNew(page);
	await next(page, "tavily");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toBeInViewport();
	const field = await page.getByLabel("Tavily API key", { exact: true }).boundingBox();
	const coach = await panel(page).boundingBox();
	expect(field.y + field.height).toBeLessThanOrEqual(coach.y);
	expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
	await screenshot(page, "phone-tavily-input-and-guide.png");
	await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
	await page.locator("#primary-navigation [data-nav=jobs]").click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "tavily");
	await expect(panel(page)).toContainText("You're exploring another page");
	await screenshot(page, "phone-manual-navigation.png");
	await panel(page).getByRole("button", { name: "Return to this step", exact: true }).click();
	await expect(page.getByLabel("Tavily API key", { exact: true })).toBeInViewport();
	await page.setViewportSize({ width: 768, height: 1024 });
	await expect(panel(page)).toBeInViewport();
	for (const step of stepIds.slice(2, 13)) await next(page, step);
	await expect(page.locator("#main-content")).toContainText("Mark a job as Applied");
	await page.evaluate(() => document.querySelector("[data-tour=applications]").removeAttribute("data-tour"));
	await page.setViewportSize({ width: 767, height: 1024 });
	await expect(page.locator("#tutorial-target-note")).toBeVisible();
	await expect(page.locator(".tutorial-spotlight")).toBeHidden();
	const fallbackReturn = page.locator("#tutorial-target-note").getByRole("button", { name: "Return to this step", exact: true });
	await fallbackReturn.focus();
	await page.setViewportSize({ width: 760, height: 1000 });
	await expect(fallbackReturn).toBeFocused();
	await page.evaluate(() => { window.scrollBy(0, 20); });
	await expect(fallbackReturn).toBeFocused();
	await fallbackReturn.click();
	await expect(fallbackReturn).toBeFocused();
	await next(page, "networking-find");
	await expect(page.locator("#main-content")).toContainText("Use Find people");
	await page.setViewportSize({ width: 320, height: 568 });
	await screenshot(page, "small-phone-networking-guide.png");
	const narrow = await panel(page).boundingBox();
	const content = await page.locator(".tutorial-content").boundingBox();
	const title = await page.locator("#tutorial-title").boundingBox();
	expect(narrow.x).toBeGreaterThanOrEqual(0);
	expect(narrow.x + narrow.width).toBeLessThanOrEqual(320);
	expect(narrow.y + narrow.height).toBeLessThanOrEqual(568);
	expect(title.y + title.height).toBeLessThanOrEqual(content.y + content.height);
	expect(content.height).toBeGreaterThanOrEqual(title.height + 16);
	await expect(panel(page).getByRole("button", { name: "Next", exact: true })).toBeInViewport();
});

test("key-free Jobs saves and actual application editing remain functional with the tutorial module absent", async ({ page }) => {
	await page.route("**/onboarding.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* tutorial intentionally absent in this regression */" }));
	await page.goto("/__review/new");
	await expect(page.locator(".home-reference-hero")).toBeVisible();
	await navigate(page, "jobs");
	const save = page.locator("[data-job-save]").filter({ hasText: "Save" }).first();
	await save.click();
	await page.locator('[data-job-mode="saved"]').click();
	await expect(page.locator(".job-cards .job-card")).toHaveCount(1);
	await page.locator(".job-more > summary").first().click();
	await page.locator("[data-job-apply]").first().click();
	await navigate(page, "applications");
	await page.locator("[data-application-edit]").first().click();
	await page.getByRole("combobox", { name: "Stage", exact: true }).selectOption("INTERVIEWING");
	await page.getByLabel("Private next step or notes", { exact: true }).fill("Fictional review next step.");
	await page.getByRole("button", { name: "Save application", exact: true }).click();
	await expect(page.locator(".applications-table")).toContainText("Interviewing");
	await expect(page.locator(".applications-table")).toContainText("Fictional review next step.");
	expect((await sessionState(page)).credentials.TAVILY.configured).toBe(false);
	await expect(panel(page)).toHaveCount(0);
});

test("the loaded tutorial module leaves ordinary key-free workflows usable when server state is absent", async ({ page }) => {
	await page.route("**/api/session", async (route) => {
		const response = await route.fetch();
		const session = await response.json();
		delete session.onboarding;
		await route.fulfill({ response, json: session });
	});
	await page.goto("/__review/new");
	await expect(page.locator(".home-reference-hero")).toBeVisible();
	expect(await page.evaluate(() => typeof window.WorkspaceOnboarding?.create)).toBe("function");
	await expect(page.locator("#onboarding-root")).toBeHidden();
	await navigate(page, "jobs");
	await page.locator("[data-job-save]").filter({ hasText: "Save" }).first().click();
	await page.locator('[data-job-mode="saved"]').click();
	await expect(page.locator(".job-cards .job-card")).toHaveCount(1);
	await navigate(page, "settings");
	await expect(page.locator(".tutorial-entry-card")).toContainText("The tutorial is unavailable until the workspace is reloaded.");
	await expect(page.locator("[data-onboarding-launch]")).toHaveCount(0);
	await page.getByRole("button", { name: "Edit profile", exact: true }).click();
	await expect(page.locator("#profile-settings-dialog")).toBeVisible();
	await page.getByRole("button", { name: "Close profile settings", exact: true }).click();
	await expect(page.locator("#profile-settings-dialog")).toBeHidden();
	expect((await sessionState(page)).credentials.TAVILY.configured).toBe(false);
});

test("desktop and mobile tutorial plus taught native dialogs pass scoped WCAG axe checks", async ({ page }) => {
	await startNew(page);
	await axeCheck(page, "desktop-welcome");
	await next(page, "tavily");
	await axeCheck(page, "desktop-tavily");
	await page.setViewportSize({ width: 390, height: 844 });
	await axeCheck(page, "phone-tavily");
	await next(page, "hunter");
	await panel(page).getByRole("button", { name: "Choose email enrichment" }).click();
	await axeCheck(page, "native-preferences", "#profile-settings-dialog");
	await page.getByRole("button", { name: "Close profile settings", exact: true }).click();
	await expect(panel(page)).toBeVisible();
});

test("repeated safe navigation does not duplicate controllers, listeners or Three canvases", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await startNew(page);
	for (let iteration = 0; iteration < 4; iteration += 1) {
		await navigate(page, "jobs");
		await navigate(page, "home");
		await expect(page.locator("#onboarding-root")).toHaveCount(1);
		await expect(panel(page)).toHaveCount(1);
		expect(await page.locator("#journey-canvas canvas").count()).toBeLessThanOrEqual(1);
	}
	await next(page, "tavily");
	await panel(page).getByRole("button", { name: "Back", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", "welcome");
	expect((await sessionState(page)).onboarding.step).toBe("welcome");
});

for (const [label, width, height] of [
	["phone-320", 320, 700],
	["phone-360", 360, 780],
	["phone-390", 390, 844],
	["phone-430", 430, 932],
	["tablet-768", 768, 1024],
	["tablet-1024", 1024, 768],
	["landscape", 844, 390],
	["400-percent-reflow", 320, 225],
	["200-percent-reflow", 768, 450],
]) {
	test.describe(`touch layout ${label}`, () => {
		test.use({ hasTouch: true });
		test(`responsive tutorial controls and drawer remain reachable: ${label}`, async ({ page }) => {
			await page.setViewportSize({ width, height });
			await page.goto("/__review/new");
			await expect(panel(page)).toHaveAttribute("data-tutorial-status", "invited");
			await expect(page.locator("#tutorial-title")).toBeFocused();
			for (const action of ["pause", "start", "explore", "skip"]) {
				await expectReachable(page.locator(`[data-tutorial-action="${action}"]`));
			}
			await page.locator('[data-tutorial-action="start"]').tap();
			await next(page, "tavily");
			await expect(page.locator("#tutorial-title")).toBeFocused();
			const input = page.getByLabel("Tavily API key", { exact: true });
			await input.focus();
			await expectReachable(input);
			await page.keyboard.press("Tab");
			const save = page.locator('[data-save-secret="TAVILY"]');
			await expect(save).toBeFocused();
			await expectReachable(save);
			const toggle = page.getByRole("button", { name: "Toggle navigation", exact: true });
			await toggle.tap();
			await expect(panel(page)).toBeHidden();
			for (const button of await page.locator("#primary-navigation button").all()) {
				await expectReachable(button);
			}
			await page.keyboard.press("Escape");
			await expect(toggle).toBeFocused();
			await expect(panel(page)).toBeVisible();
			expect((await sessionState(page)).onboarding).toMatchObject({ status: "in_progress", step: "tavily" });
			await next(page, "hunter");
			await panel(page).getByRole("button", { name: "Choose email enrichment" }).click();
			await expect(panel(page)).toBeHidden();
			await expect(page.locator("#profile-settings-dialog")).toBeVisible();
			await expectReachable(page.getByRole("button", { name: "Close profile settings", exact: true }));
			await page.getByRole("button", { name: "Close profile settings", exact: true }).click();
			await expect(panel(page)).toBeVisible();
			await expect(page.locator("#tutorial-title")).toBeFocused();
			await screenshot(page, `responsive-tutorial-${label}.png`);
		});
	});
}

test("combined review denies external actions even for authenticated fictional tutorial accounts", async ({ page }) => {
	await page.goto("/__review/new");
	for (const endpoint of [
		"/api/discovery", "/api/resume", "/api/workspace/init",
		"/api/prospects/30000000-0000-4000-8000-000000000802/prepare",
		"/api/prospects/30000000-0000-4000-8000-000000000802/regenerate",
		"/api/prospects/30000000-0000-4000-8000-000000000802/send",
		"/api/prospects/30000000-0000-4000-8000-000000000802/sync",
	]) {
		const response = await page.request.post(endpoint);
		expect(response.status()).toBe(403);
		expect((await response.json()).error).toBe("REVIEW_ONLY");
		expect(response.headers()["x-layout-review"]).toBe("seeded-local-only");
	}
	const oauth = await page.request.get("/auth/google/connect", { maxRedirects: 0 });
	expect(oauth.status()).toBe(403);
	expect((await oauth.json()).error).toBe("REVIEW_ONLY");
	await page.goto("/__review/login?scenario=normal");
	const mutation = await page.request.put("/api/settings", { data: { senderName: "Must remain read-only" } });
	expect(mutation.status()).toBe(403);
	expect((await mutation.json()).error).toBe("REVIEW_ONLY");
});

test("keyboard-sized visual viewport and safe insets bound the coach without changing progress", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await startNew(page);
	await next(page, "tavily");
	const before = (await sessionState(page)).onboarding;
	await page.evaluate(() => {
		const viewport = Object.assign(new EventTarget(), { width: 360, height: 320, offsetTop: 48, offsetLeft: 0 });
		Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
		document.getElementById("onboarding-root").style.padding = "24px 12px 16px";
		window.dispatchEvent(new Event("resize"));
	});
	await expect(panel(page)).toHaveClass(/tutorial-panel-scroll/);
	const rect = await panel(page).boundingBox();
	expect(rect.x).toBeGreaterThanOrEqual(20);
	expect(rect.x + rect.width).toBeLessThanOrEqual(340);
	expect(rect.y).toBeGreaterThanOrEqual(80);
	expect(rect.y + rect.height).toBeLessThanOrEqual(344);
	await page.getByLabel("Tavily API key", { exact: true }).focus();
	await expectReachable(page.getByLabel("Tavily API key", { exact: true }));
	expect((await sessionState(page)).onboarding).toEqual(before);
	await screenshot(page, "keyboard-visual-viewport-safe-insets.png");
});

async function expectReachable(locator) {
	await locator.evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }));
	await locator.page().evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(await locator.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const hit = document.elementFromPoint(x, y);
		return { bounded: rect.left >= 0 && rect.right <= innerWidth && y >= 0 && y <= innerHeight, hit: Boolean(hit && element.contains(hit)) };
	})).toEqual({ bounded: true, hit: true });
}

function panel(page) { return page.locator(".tutorial-panel"); }
function baseUrl() { return process.env.TUTORIAL_PREVIEW_URL || "http://127.0.0.1:8803"; }
function counts(items) { return Object.fromEntries([...new Set(items)].map((item) => [item, items.filter((entry) => entry === item).length])); }
async function sessionState(page) { return (await page.request.get("/api/session")).json(); }
async function startNew(page) {
	await page.goto("/__review/new");
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "invited");
	await panel(page).getByRole("button", { name: "Start tutorial", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-status", "in_progress");
}
async function next(page, step) {
	await panel(page).getByRole("button", { name: "Next", exact: true }).click();
	await expect(panel(page)).toHaveAttribute("data-tutorial-step", step);
	await expect(panel(page)).toHaveAttribute("aria-busy", "false");
	await expect(panel(page)).toBeVisible();
}
async function navigate(page, view) {
	const button = page.locator(`#primary-navigation [data-nav="${view}"]`);
	await expect(button).toBeAttached();
	if (!(await button.isVisible())) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
	await button.click();
	await expect(page.locator(".app-frame")).toHaveClass(new RegExp(`view-${view}`));
}
async function mutateViaRequest(page, { version, revision, step, action }) {
	const session = await sessionState(page);
	const csrf = (await page.context().cookies()).find((cookie) => cookie.name === session.csrfCookieName)?.value;
	return page.request.put("/api/onboarding", {
		headers: { Origin: baseUrl(), "X-CSRF-Token": csrf },
		data: { version, revision, step, action },
	});
}
async function screenshot(page, filename) {
	await mkdir(evidence, { recursive: true });
	await page.evaluate(() => document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; }));
	if (await panel(page).isVisible()) await expect(page.locator("#tutorial-title")).toBeVisible();
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await page.screenshot({ path: join(evidence, filename), fullPage: false });
}
async function axeCheck(page, name, selector = "#onboarding-root") {
	const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
	await mkdir(evidence, { recursive: true });
	await writeFile(join(evidence, `axe-${name}.json`), JSON.stringify({
		name, violations: result.violations.map(({ id, impact, description, nodes }) => ({
			id, impact, description, targets: nodes.map((node) => node.target),
		})), passes: result.passes.length, incomplete: result.incomplete.map(({ id }) => id),
	}, null, 2));
	expect(result.violations, `WCAG violations: ${name}`).toEqual([]);
}
