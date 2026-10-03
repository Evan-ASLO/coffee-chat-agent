import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
	baseUrl, evidenceDirectory, assertReviewReady, createMonitor, createReviewContext,
	openView, settleLayout, measure, hasDefects, assertCleanMonitor,
} from "./browser-helpers.mjs";
import { installJourneyDiagnostics, readJourneyDiagnostics, interactiveJourneyPoints } from "./journey-diagnostics.mjs";

await assertReviewReady();
const output = path.join(evidenceDirectory, "interactions");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
	channel: process.env.LAYOUT_BROWSER_CHANNEL || "msedge", headless: true,
});
const monitor = createMonitor();
const records = [];
const only = process.argv.find((argument) => argument.startsWith("--only="))?.split("=")[1] || "all";
assert.ok(["all", "controls", "dialogs", "journey"].includes(only), "Choose a supported interaction group.");
let currentPage;
let currentCase;

async function checkLayout(page, label) {
	await settleLayout(page);
	const metrics = await measure(page);
	records.push({ label, viewport: page.viewportSize(), ...metrics, passed: !hasDefects(metrics) });
	assert.equal(hasDefects(metrics), false, `${label}: ${JSON.stringify(metrics)}`);
}

async function checkNames(page) {
	const unnamed = await page.evaluate(() => {
		return [...document.querySelectorAll("button, input:not([type=hidden]), select, textarea, a.button, a.row-action-button")]
			.filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
			.filter((element) => {
				const labelledBy = (element.getAttribute("aria-labelledby") || "")
					.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
				return ![
					element.getAttribute("aria-label"), labelledBy,
					[...(element.labels || [])].map((label) => label.textContent).join(" "),
					element.matches("input, select, textarea") ? "" : element.textContent,
				].some((text) => text?.trim());
			})
			.map((element) => `${element.tagName}#${element.id}`);
	});
	assert.deepEqual(unnamed, [], "Every available control needs an accessible name.");
}

async function switchView(page, view) {
	const toggle = page.locator("#mobile-nav-toggle");
	if (await toggle.isVisible()) await toggle.click();
	await page.locator(`#primary-navigation [data-nav="${view}"]`).click();
	await page.waitForSelector(`.view-${view}`);
	await page.waitForFunction(() => document.activeElement?.id === "main-content");
	if (view === "home") {
		await page.waitForFunction(() => document.querySelector("#journey-canvas")?.getAttribute("aria-busy") === "false");
	}
	await settleLayout(page);
}

async function checkDrawer(page) {
	await openView(page, "jobs");
	await page.locator("#job-q").fill("Unsaved filter text stays here");
	await page.locator("#mobile-nav-toggle").click();
	assert.equal(await page.locator("#primary-navigation").getAttribute("role"), "dialog");
	assert.equal(await page.locator("#primary-navigation").getAttribute("aria-modal"), "true");
	assert.equal(await page.evaluate(() => document.getElementById("main-content").inert), true);
	assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), "hidden");
	await checkLayout(page, "open-drawer");
	const last = page.locator("#primary-navigation button").last();
	await last.focus();
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => document.activeElement.id), "mobile-nav-close");
	await page.keyboard.press("Shift+Tab");
	assert.equal(await page.evaluate(() => document.activeElement.dataset.nav), "settings");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#mobile-nav-toggle").getAttribute("aria-expanded"), "false");
	assert.equal(await page.evaluate(() => document.activeElement.id), "mobile-nav-toggle");
	assert.equal(await page.locator("#job-q").inputValue(), "Unsaved filter text stays here");
	assert.equal(await page.evaluate(() => document.getElementById("main-content").inert), false);
	await page.locator("#mobile-nav-toggle").click();
	await page.locator("#mobile-nav-close").click();
	await page.locator("#mobile-nav-toggle").click();
	await page.locator("#nav-scrim").click({ position: { x: page.viewportSize().width - 10, y: 150 } });
	await page.locator("#mobile-nav-toggle").click();
	await page.setViewportSize({ width: 1280, height: 900 });
	await settleLayout(page);
	assert.equal(await page.locator("#mobile-nav-toggle").getAttribute("aria-expanded"), "false");
	assert.equal(await page.evaluate(() => document.getElementById("main-content").inert), false);
	assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).overflow), "hidden");
	assert.equal(await page.locator("#job-q").inputValue(), "Unsaved filter text stays here");
	await page.setViewportSize({ width: 844, height: 390 });
	await settleLayout(page);
	await page.locator("#mobile-nav-toggle").click();
	await page.locator("#primary-navigation [data-nav=settings]").focus();
	await page.keyboard.press("Escape");
	await page.locator("#mobile-nav-toggle").click();
	await page.locator("#mobile-nav-close").click();
	for (const view of ["applications", "networking", "analytics", "settings", "home", "jobs"]) {
		await switchView(page, view);
		await checkLayout(page, `drawer-navigation-${view}`);
	}
	records.push({ label: "drawer-focus-values-orientation-and-all-destinations", passed: true });
}

async function checkJobs(page) {
	await openView(page, "jobs");
	for (const selector of ["#job-q", "#job-location", "#job-industry", "#job-category", "#job-term", "#job-company", "#job-region", "#job-length"]) {
		assert.equal(await page.locator(selector).isVisible(), true, `${selector} stays available.`);
	}
	await page.locator("#job-company").fill("Northstar Analytics");
	await page.locator("#job-location").fill("Toronto, Ontario (Hybrid)");
	await page.locator("#job-region").fill("Canada");
	await page.locator("#job-category").fill("Internship");
	const industry = await page.locator("#job-industry option").filter({ hasText: "Technology" }).first().getAttribute("value");
	await page.locator("#job-industry").selectOption(industry);
	await page.locator("#job-term").selectOption({ index: 1 });
	await page.locator("#job-length").selectOption({ index: 1 });
	const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs");
	await page.locator("#job-filter-form").getByRole("button", { name: "Search", exact: true }).click();
	const response = await responsePromise;
	assert.equal(response.status(), 200, await response.text());
	assert.equal((await response.json()).pagination.total, 2, "The exact seeded filters select two matching roles.");
	await page.waitForFunction(() => document.querySelectorAll(".job-card").length === 2);
	assert.equal(await page.locator("#job-company").inputValue(), "Northstar Analytics");
	await checkLayout(page, "all-job-filters-applied");
	await page.locator("#clear-job-filters").click();
	await page.waitForFunction(() => document.querySelectorAll(".job-card").length === 18);
	for (const mode of ["saved", "all"]) {
		await page.locator(`[data-job-mode="${mode}"]`).click();
		assert.equal(await page.locator(".job-card").count(), mode === "saved" ? 6 : 18);
		for (const layout of ["list", "grid"]) {
			await page.locator(`[data-job-layout="${layout}"]`).click();
			await checkLayout(page, `jobs-${mode}-${layout}`);
		}
	}
	const menu = page.locator(".job-more").first();
	await menu.locator("summary").click();
	await checkLayout(page, "job-actions-menu");
	await menu.locator("select").focus();
	await menu.locator("summary").click();
	await checkNames(page);
	records.push({ label: "job-filter-saved-list-grid-and-action-controls", passed: true });
}

async function checkTable(page, context, view, actionSelector) {
	await openView(page, view);
	const region = page.locator(".responsive-table-wrap");
	assert.match(await region.getAttribute("aria-label"), /Scroll/);
	assert.equal(await region.getAttribute("role"), "region");
	assert.equal(await region.getAttribute("tabindex"), "0");
	assert.ok(await region.locator("caption").textContent());
	assert.ok(await region.locator('th[scope="col"]').count() >= 6);
	const preceding = view === "applications" ? "#application-sort" : "#open-discovery-dialog-secondary";
	await page.locator(preceding).focus();
	await page.keyboard.press("Tab");
	assert.equal(await region.evaluate((element) => element === document.activeElement), true);
	const outline = await region.evaluate((element) => getComputedStyle(element).outlineStyle);
	assert.notEqual(outline, "none", "The scrollable table has visible keyboard focus.");
	await page.keyboard.press("ArrowRight");
	await page.waitForFunction(() => document.querySelector(".responsive-table-wrap").scrollLeft > 0);
	await region.evaluate((element) => { element.scrollLeft = 0; });
	await region.scrollIntoViewIfNeeded();
	const box = await region.boundingBox();
	const y = Math.max(35, Math.min(page.viewportSize().height - 35, box.y + box.height / 2));
	const cdp = await context.newCDPSession(page);
	const start = box.x + box.width - 20;
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start, y, id: 1 }] });
	for (let step = 1; step <= 5; step++) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove", touchPoints: [{ x: start - step * (box.width - 40) / 5, y, id: 1 }],
		});
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await page.waitForFunction(() => document.querySelector(".responsive-table-wrap").scrollLeft > 0);
	await cdp.detach();
	await page.locator(actionSelector).first().focus();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
	await checkNames(page);
	records.push({ label: `${view}-bounded-table-keyboard-touch-and-action-reachability`, passed: true });
}

async function reachableControl(locator) {
	await locator.scrollIntoViewIfNeeded();
	await locator.focus();
	return locator.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const dialog = element.closest("dialog").getBoundingClientRect();
		const top = Math.max(rect.top, dialog.top, 0);
		const bottom = Math.min(rect.bottom, dialog.bottom, innerHeight);
		const hit = document.elementFromPoint(rect.left + rect.width / 2, (top + bottom) / 2);
		return {
			reachable: rect.left >= 0 && rect.right <= innerWidth + 1 &&
				bottom - top >= Math.min(44, rect.height) - 1 && element.contains(hit),
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			obscuredBy: hit?.className,
		};
	});
}

async function checkDialog(page, id, trigger, actions, label) {
	await trigger.click();
	const dialog = page.locator(`#${id}`);
	await dialog.waitFor({ state: "visible" });
	await checkLayout(page, `${label}-opened`);
	const bounds = await dialog.boundingBox();
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
	assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height + 1);
	const titleId = await dialog.getAttribute("aria-labelledby");
	assert.ok(titleId && (await page.locator(`#${titleId}`).textContent()).trim());
	await checkNames(page);
	for (const selector of actions) {
		const availability = await reachableControl(dialog.locator(selector));
		assert.equal(availability.reachable, true, `${label} ${selector}: ${JSON.stringify(availability)}`);
	}
	for (let index = 0; index < 12; index++) {
		await page.keyboard.press("Tab");
		assert.equal(await dialog.evaluate((element) =>
			element.contains(document.activeElement) || document.activeElement === document.body,
		), true, "Native modal focus cannot reach background app controls.");
	}
	const close = dialog.getByRole("button", { name: /^Close/ }).first();
	await close.click();
	assert.equal(await dialog.isVisible(), false);
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
	await trigger.click();
	await page.keyboard.press("Escape");
	assert.equal(await dialog.isVisible(), false);
	records.push({ label: `${label}-close-actions-focus-and-escape`, passed: true });
}

async function checkDialogs(page, label) {
	await openView(page, "applications");
	const application = page.locator("tr").filter({ hasText: "Cloud Platform Reliability" })
		.locator("[data-application-edit]").first();
	await checkDialog(page, "application-dialog", application,
		["#application-dialog-notes", "#application-dialog-save", "#application-dialog-remove"], `${label}-application`);
	await openView(page, "networking");
	await checkDialog(page, "discovery-dialog", page.locator("#open-discovery-dialog"),
		["#roles", "#objective", "#find-form button.primary"], `${label}-discovery`);
	await checkDialog(page, "draft-dialog", page.locator("[data-review]").first(),
		["#draft-email", "#draft-body", "#save-draft", "#send-draft"], `${label}-draft`);
	await openView(page, "settings");
	await checkDialog(page, "profile-settings-dialog", page.locator("#open-profile-settings"),
		["#sender-name", "#background", "#settings-form button.primary"], `${label}-profile`);
	for (const details of [".privacy-card details", ".credentials-details"]) {
		for (const disclosure of await page.locator(details).all()) {
			await disclosure.locator("summary").click();
			await checkLayout(page, `${label}-settings-disclosure`);
		}
	}
	await page.locator("#secret-TAVILY").fill("fake-local-review-key");
	await checkNames(page);
	await page.screenshot({ path: path.join(output, `${label}-settings-open.png`), fullPage: true });
}

async function checkJourney(context, page) {
	await page.evaluate(() => window.__layoutJourney.ready);
	await page.waitForSelector(".journey-webgl-canvas");
	const canvas = page.locator(".journey-webgl-canvas");
	await canvas.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
	await page.waitForFunction(() => [...window.__layoutJourney.frames.values()].includes("animate"));
	let diagnostics = await readJourneyDiagnostics(page);
	assert.equal(diagnostics.activeContexts, 1, "Capability probes release their extra WebGL contexts.");
	assert.equal(diagnostics.canvasCount, 1);
	assert.ok(Math.abs(diagnostics.pixelRatio - 1.25) < 0.025);
	await page.evaluate(() => {
		window.__layoutJourney.visibilityOverride = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal((await readJourneyDiagnostics(page)).animationFrames, 0);
	await page.evaluate(() => {
		window.__layoutJourney.visibilityOverride = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForFunction(() => [...window.__layoutJourney.frames.values()].includes("animate"));
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
	await page.waitForFunction(() => ![...window.__layoutJourney.frames.values()].includes("animate"));
	await canvas.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
	await page.evaluate(() => { window.__previousJourneyCanvas = document.querySelector(".journey-webgl-canvas"); });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.waitForFunction(() => document.querySelector(".journey-webgl-canvas") &&
		document.querySelector(".journey-webgl-canvas") !== window.__previousJourneyCanvas);
	await settleLayout(page);
	assert.equal((await readJourneyDiagnostics(page)).animationFrames, 0);
	assert.equal(await page.evaluate(() => window.__previousJourneyCanvas.isConnected), false);
	await canvas.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
	await settleLayout(page);
	let hit;
	const candidates = await interactiveJourneyPoints(page);
	const attemptedHits = [];
	for (const point of candidates) {
		await canvas.dispatchEvent("pointermove", { clientX: point.x, clientY: point.y });
		const hovered = await page.locator("[data-journey-target].hovered")
			.evaluateAll((buttons) => buttons[0]?.dataset.journeyTarget);
		attemptedHits.push({ ...point, hovered });
		if (hovered === point.area) {
			hit = point;
			break;
		}
	}
	records.push({ label: "projected-real-touch-targets", candidates: candidates.length, attemptedHits });
	assert.ok(hit, "The real rendered world exposes at least one interactive area.");
	await canvas.dispatchEvent("pointerleave");
	await page.touchscreen.tap(hit.x, hit.y);
	await page.waitForFunction((area) => document.querySelector(`[data-journey-target="${area}"]`)?.classList.contains("active"), hit.area);
	const targets = await page.locator("[data-journey-target]").evaluateAll((buttons) =>
		buttons.map((button) => button.dataset.journeyTarget));
	for (const area of targets) {
		const button = page.locator(`[data-journey-target="${area}"]`);
		await button.focus();
		await page.keyboard.press("Enter");
		assert.equal(await button.evaluate((element) => element.classList.contains("active")), true);
		await checkLayout(page, `journey-keyboard-${area}`);
	}
	await page.locator("#journey-reset").click();
	await page.screenshot({ path: path.join(output, "journey-webgl-phone.png"), fullPage: true });
	await page.setViewportSize({ width: 844, height: 390 });
	await settleLayout(page);
	await page.waitForSelector(".journey-webgl-canvas");
	await page.waitForFunction(() => document.querySelector("#journey-canvas").getAttribute("aria-busy") === "false");
	diagnostics = await readJourneyDiagnostics(page);
	assert.equal(diagnostics.activeContexts, 1);
	assert.ok(Math.abs(diagnostics.pixelRatio - 1.5) < 0.025, "Desktop quality is rebuilt after the mobile breakpoint.");
	await checkLayout(page, "journey-orientation");
	await page.setViewportSize({ width: 1280, height: 900 });
	await settleLayout(page);
	await page.screenshot({ path: path.join(output, "journey-webgl-desktop.png"), fullPage: true });
	await switchView(page, "jobs");
	await settleLayout(page);
	diagnostics = await readJourneyDiagnostics(page);
	assert.equal(diagnostics.activeContexts, 0);
	assert.equal(diagnostics.observedTargets, 0);
	assert.equal(diagnostics.visibilityListeners, 0);
	assert.equal(diagnostics.animationFrames, 0);
	assert.ok(diagnostics.disposed.geometries > 0 && diagnostics.disposed.materials > 0);
	for (let iteration = 0; iteration < 12; iteration++) {
		await page.evaluate(() => { navigate("home"); navigate("jobs"); });
	}
	await settleLayout(page);
	assert.equal((await readJourneyDiagnostics(page)).activeContexts, 0, "Stale asynchronous mounts cannot leak a world.");
	await switchView(page, "home");
	assert.equal((await readJourneyDiagnostics(page)).canvasCount, 1);
	await switchView(page, "jobs");
	records.push({ label: "real-webgl-touch-keyboard-motion-visibility-orientation-disposal-and-mount-race",
		...(await readJourneyDiagnostics(page)), passed: true });
	await context.close();
}

try {
	for (const [scenario, viewport, label] of only === "journey" ? [] : [
		["normal", { width: 320, height: 700 }, "phone-320"],
		["normal", { width: 390, height: 560 }, "phone-390-short"],
		["normal", { width: 844, height: 390 }, "phone-landscape"],
		["long", { width: 320, height: 225 }, "long-400-percent-reflow"],
		["long", { width: 768, height: 450 }, "long-200-percent-reflow"],
		["normal", { width: 1536, height: 900 }, "desktop"],
	]) {
		currentCase = label;
		const { context, page, login } = await createReviewContext(browser, scenario, viewport, monitor, { hasTouch: true });
		currentPage = page;
		await login();
		if (label === "phone-320" && only !== "dialogs") {
			await checkDrawer(page);
			await page.setViewportSize(viewport);
			await settleLayout(page);
			await checkJobs(page);
			await checkTable(page, context, "applications", "[data-application-edit]");
			await checkTable(page, context, "networking", "[data-review]");
		}
		if (only !== "controls") await checkDialogs(page, label);
		await context.close();
		if (only === "controls") break;
	}
	if (only === "all" || only === "journey") {
		currentCase = "actual-webgl";
		const world = await createReviewContext(browser, "normal", { width: 390, height: 900 }, monitor, {
			hasTouch: true, reducedMotion: "no-preference", deviceScaleFactor: 3,
		});
		currentPage = world.page;
		await installJourneyDiagnostics(world.context);
		await world.login();
		await checkJourney(world.context, world.page);
	}
	if (only === "all") {
		currentCase = "review-safety-denials";
		const request = await browser.newContext();
		for (const [method, endpoint] of [
			["GET", "/auth/google/login"], ["GET", "/auth/google/connect"], ["GET", "/auth/google/callback"],
			["POST", "/api/prospects/discover"], ["POST", "/api/resume"], ["POST", "/api/workspace/init"],
			["POST", "/api/prospects/00000000-0000-4000-8000-000000000101/prepare"],
			["POST", "/api/prospects/00000000-0000-4000-8000-000000000101/send"],
			["PUT", "/api/settings"], ["DELETE", "/api/resume"],
		]) {
			const response = await request.request.fetch(`${baseUrl}${endpoint}`, { method });
			assert.equal(response.status(), 403);
			assert.equal((await response.json()).error, "REVIEW_ONLY");
			assert.equal(response.headers()["x-layout-review"], "seeded-local-only");
		}
		await request.close();
		records.push({ label: "review-only-oauth-and-mutation-denials", passed: true });
	}
	assertCleanMonitor(monitor);
	const result = only === "all" ? "interaction-results.json" : `interaction-${only}-results.json`;
	await writeFile(path.join(evidenceDirectory, result), JSON.stringify({ records, ...monitor }, null, 2));
	console.log(`${records.length} browser interaction/layout checks passed (${only}).`);
} catch (error) {
	if (currentPage && !currentPage.isClosed()) {
		await currentPage.screenshot({ path: path.join(output, `failure-${only}.png`), fullPage: true });
	}
	await writeFile(path.join(evidenceDirectory, `interaction-${only}-failure.json`), JSON.stringify({
		currentCase, only, failure: error.stack, records, ...monitor,
	}, null, 2));
	throw error;
} finally {
	await browser.close();
}
