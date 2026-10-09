import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const port = Number(process.env.PREPARATION_PREVIEW_PORT || 8807);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const evidence = resolve(process.env.PREPARATION_EVIDENCE_DIR || ".tutorial-preview\\preparation-evidence");
const health = await fetch(`${origin}/__review/preparation/health`, { signal: AbortSignal.timeout(10000) });
assert.equal(health.headers.get("x-preparation-review"), "mock-only");
assert.deepEqual(await health.json(), { reviewOnly: true, mockOnly: true, seeded: true });
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const personId = "30000000-0000-4000-8000-000000000909";
const userId = "10000000-0000-4000-8000-000000000909";
const secondUser = "10000000-0000-4000-8000-000000000910";
const jobId = "b".repeat(64);
const receipts = [];
let activePage;

try {
	for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
		const context = await browser.newContext({
			viewport, reducedMotion: "reduce", isMobile: viewport.width < 500, hasTouch: viewport.width < 500,
		});
		const page = await context.newPage();
		activePage = page;
		page.setDefaultTimeout(30000);
		const errors = [];
		const external = [];
		const unexpected = [];
		const actions = [];
		const cases = [];
		const screenshots = [];
		let planned = null;
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin) {
				external.push(url.origin);
				return route.abort("blockedbyclient");
			}
			const allowed = /^\/api\/prospects\/[a-f0-9-]+\/(?:prepare|regenerate|preparation\/retry|draft)$/.test(url.pathname);
			const forbidden = url.pathname.startsWith("/auth/") || url.pathname === "/api/discovery" ||
				url.pathname === "/api/resume" || url.pathname === "/api/workspace/init" ||
				url.pathname.startsWith("/api/credentials/") ||
				/^\/api\/prospects\/[^/]+\/(?:send|sync)$/.test(url.pathname);
			if (forbidden || (allowed && (!planned || planned.path !== url.pathname || planned.method !== request.method()))) {
				unexpected.push(`${request.method()} ${url.pathname}`);
				return route.abort("blockedbyclient");
			}
			if (allowed) {
				const action = planned;
				planned = null;
				const response = await route.fetch();
				actions.push({ path: url.pathname, method: request.method(), body: request.postDataJSON(), status: response.status() });
				if (action.defer) {
					action.defer({ route, response });
					return;
				}
				return route.fulfill({ response });
			}
			return route.continue();
		});
		async function screenshot(name, fullPage = true) {
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport overflow.");
			const file = `${viewport.width}-${name}.png`;
			await page.screenshot({ path: join(evidence, file), fullPage });
			screenshots.push(file);
		}
		async function navigate(view) {
			if (["settings", "analytics", "home"].includes(view)) {
				await page.locator(".account-menu > summary").click();
				await page.locator(`.account-menu [data-nav="${view}"]`).click();
			} else await page.locator(`#primary-navigation [data-nav="${view}"]`).click();
			await page.locator(`.view-${view}`).waitFor();
		}
		async function session() {
			return page.evaluate(async () => {
				const response = await fetch("/api/session");
				if (!response.ok) throw new Error("Fictional session read failed.");
				return response.json();
			});
		}
		async function person() {
			return (await session()).prospects.find((value) => value.id === personId);
		}
		async function counts() {
			return page.evaluate(async () => {
				const response = await fetch("/__review/preparation/receipt");
				if (!response.ok) throw new Error("Mock call receipt unavailable.");
				const receipt = await response.json();
				if (!receipt.mockOnly) throw new Error("Not a mock receipt.");
				return { APOLLO: 0, TAVILY: 0, OPENAI: 0, ...Object.fromEntries(receipt.calls.map((row) => [row.provider, row.count])) };
			});
		}
		async function record(name, expected) {
			const actual = await counts();
			assert.deepEqual(actual, expected, name);
			cases.push({ name, calls: actual });
			console.log(`${viewport.width}: ${name} ${JSON.stringify(actual)}`);
		}
		async function scenario(name, reset = false) {
			const result = await page.evaluate(async ({ name, reset }) => {
				const csrf = /(?:^|;\s*)cc_csrf=([^;]+)/.exec(document.cookie)?.[1];
				const response = await fetch("/__review/preparation/scenario", {
					method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
					body: JSON.stringify({ scenario: name, reset }),
				});
				return { status: response.status, body: await response.json() };
			}, { name, reset });
			assert.equal(result.status, 200);
			assert.equal(result.body.mockOnly, true);
			if (reset) {
				await page.reload();
				await page.locator(`[data-prepare="${personId}"]`).waitFor();
				assert.deepEqual(await counts(), { APOLLO: 0, TAVILY: 0, OPENAI: 0 });
			}
		}
		async function action(name, locator, { confirmation = null, httpStatus = 200, status = "DRAFT_READY" } = {}) {
			assert.equal(planned, null);
			planned = { path: `/api/prospects/${personId}/${name}`, method: name === "draft" ? "PATCH" : "POST" };
			let confirmed = "";
			if (confirmation) page.once("dialog", async (dialog) => {
				confirmed = dialog.message();
				await dialog.accept();
			});
			const completed = page.waitForResponse((response) => new URL(response.url()).pathname === planned?.path ||
				new URL(response.url()).pathname === `/api/prospects/${personId}/${name}`);
			await locator.click();
			assert.equal((await completed).status(), httpStatus);
			await page.waitForFunction(({ id, status }) => !state.preparationRequest &&
				state.session?.prospects?.some((value) => value.id === id && value.status === status), { id: personId, status });
			if (confirmation) assert.match(confirmed, confirmation);
			assert.equal(planned, null);
		}
		const prepareButton = () => page.locator(`[data-prepare="${personId}"]`);
		const reviewButton = () => page.locator(`[data-review="${personId}"]`);
		const regenerateButton = () => page.locator(`[data-regenerate="${personId}"]`);
		async function review() {
			await reviewButton().click();
			await page.locator("#draft-dialog").waitFor();
		}
		async function closeReview() {
			await page.locator('#draft-dialog [aria-label="Close dialog"]').click();
		}

		await page.goto(`${origin}/__review/preparation`);
		await page.locator(".view-networking").waitFor();
		assert.equal((await session()).user.id, userId);
		await scenario("success", true);
		assert.match(await page.locator(".preparation-costs").innerText(), /1 ordinary Apollo.*1 basic Tavily.*1 OPENAI/s);
		await screenshot("preparation-costs");
		await action("prepare", prepareButton(), { confirmation: /1 credit.*even with no email/s });
		const initial = await person();
		assert.equal(initial.contactApprovedAt !== null, true);
		assert.equal(initial.draftApprovedAt, null);
		assert.equal(initial.email, "fictional.alex@example-software-review.com");
		assert.equal(initial.emailConfidence, 0);
		assert.equal(initial.preparation.email.status, "MATCHED");
		assert.equal(initial.preparation.research.status, "SOURCED");
		assert.equal(initial.preparation.research.sources.length, 2);
		assert.ok(initial.linkedJobs.some((job) => job.id === jobId));
		await record("general approval", { APOLLO: 1, TAVILY: 1, OPENAI: 1 });
		await page.reload();
		await review();
		assert.equal(await page.locator("#draft-email").inputValue(), initial.email);
		assert.equal(await page.locator("#draft-context .research-sources li").count(), 2);
		assert.match(await page.locator("#draft-body").inputValue(), /genuine accessibility project/);
		await screenshot("saved-sourced-draft");
		await page.locator("#send-draft").scrollIntoViewIfNeeded();
		await screenshot("draft-source-review", false);
		await closeReview();
		await action("regenerate", regenerateButton(), { confirmation: /no new Tavily call/ });
		await record("draft-only regeneration", { APOLLO: 1, TAVILY: 1, OPENAI: 2 });
		await review();
		await page.locator("#draft-email").fill("reviewed@example-software-review.com");
		await page.locator("#draft-body").fill(`${await page.locator("#draft-body").inputValue()} Thank you for considering it.`);
		assert.equal(await page.locator("#send-draft").isDisabled(), true);
		assert.match(await page.locator("#draft-save-state").innerText(), /Unsaved changes/);
		await screenshot("unsaved-draft-blocks-send");
		await action("draft", page.locator("#save-draft"));
		await review();
		assert.equal((await person()).preparation.email.provider, "MANUAL");
		assert.equal(await page.locator("#send-draft").isDisabled(), false);
		let cancelled = "";
		page.once("dialog", async (dialog) => { cancelled = dialog.message(); await dialog.dismiss(); });
		await page.locator("#send-draft").click();
		assert.match(cancelled, /Send this exact email.*reviewed@example-software-review.com/);
		assert.equal((await person()).draftApprovedAt, null);
		await record("saved edits and cancelled send", { APOLLO: 1, TAVILY: 1, OPENAI: 2 });
		await closeReview();

		await navigate("jobs");
		await page.locator(`[data-job-network="${jobId}"]`).first().click();
		await page.waitForFunction(() => document.querySelector(".networking-table") && !document.querySelector("#reload-job-contacts")?.disabled);
		assert.ok(page.url().includes(`contactJob=${jobId}`));
		await scenario("success", true);
		await action("prepare", prepareButton(), { confirmation: /Approve Fictional Alex/ });
		assert.ok((await person()).linkedJobs.some((job) => job.id === jobId));
		await record("job-linked approval", { APOLLO: 1, TAVILY: 1, OPENAI: 1 });
		await review();
		await screenshot("job-linked-sourced-draft");
		await closeReview();

		await scenario("no-email", true);
		await action("prepare", prepareButton(), { confirmation: /Approve Fictional Alex/ });
		assert.equal((await person()).preparation.email.status, "NO_EMAIL");
		await review();
		assert.equal(await page.locator("#send-draft").isDisabled(), true);
		assert.match(await page.locator("#draft-save-state").innerText(), /No recipient email is saved/);
		await screenshot("no-email-keeps-draft");
		await closeReview();
		await action("regenerate", regenerateButton(), { confirmation: /no new Tavily call/ });
		await record("no-email outcome cached", { APOLLO: 1, TAVILY: 1, OPENAI: 2 });
		await scenario("success");
		await review();
		await action("preparation/retry", page.locator('#draft-context [data-retry-preparation="EMAIL"]'), { confirmation: /1 ordinary Apollo.*no new Tavily call/s });
		await record("explicit email retry", { APOLLO: 2, TAVILY: 1, OPENAI: 3 });

		await scenario("research-failed", true);
		await action("prepare", prepareButton(), { confirmation: /Approve Fictional Alex/ });
		assert.equal((await person()).preparation.research.status, "FAILED");
		assert.equal((await person()).preparation.research.sources[0].origin, "DISCOVERY");
		await review();
		assert.match(await page.locator("#draft-context").innerText(), /limited context.*Provider request failed/s);
		await screenshot("research-failure-keeps-evidence");
		await scenario("success");
		await action("preparation/retry", page.locator('#draft-context [data-retry-preparation="RESEARCH"]'), { confirmation: /1 basic Tavily/ });
		await record("explicit research retry", { APOLLO: 1, TAVILY: 2, OPENAI: 2 });

		await scenario("draft-failed", true);
		await action("prepare", prepareButton(), { confirmation: /Approve Fictional Alex/, httpStatus: 400, status: "ERROR" });
		assert.equal((await person()).preparation.email.status, "MATCHED");
		assert.equal((await person()).preparation.research.status, "SOURCED");
		assert.match(await page.locator(".networking-table").innerText(), /Saved email and research were kept/);
		await screenshot("draft-failure-keeps-prior-stages");
		await scenario("success");
		await action("regenerate", regenerateButton(), { confirmation: /no new Tavily call/ });
		await record("draft-only failure recovery", { APOLLO: 1, TAVILY: 1, OPENAI: 2 });

		for (const [name, status] of [["missing-key", "MISSING_KEY"], ["gate-disabled", "INTEGRATION_DISABLED"]]) {
			await scenario(name, true);
			await action("prepare", prepareButton(), { confirmation: /no Apollo call/ });
			assert.equal((await person()).preparation.email.status, status);
			assert.equal((await person()).email, "");
			await record(name, { APOLLO: 0, TAVILY: 1, OPENAI: 1 });
			await review();
			assert.equal(await page.locator("#send-draft").isDisabled(), true);
			await screenshot(name);
			await closeReview();
		}
		await navigate("settings");
		await page.locator(".credentials-details > summary").click();
		assert.match(await page.locator("#apollo-setup-guidance").innerText(), /Unavailable pending Apollo authorization.*may require OAuth/s);
		assert.equal(await page.locator('[data-save-secret="APOLLO"]').isDisabled(), true);
		await screenshot("apollo-authorization-pending");
		await navigate("networking");

		await scenario("success", true);
		let resolveDeferred;
		const deferred = new Promise((resolve) => { resolveDeferred = resolve; });
		planned = { path: `/api/prospects/${personId}/prepare`, method: "POST", defer: resolveDeferred };
		page.once("dialog", (dialog) => dialog.accept());
		await prepareButton().click();
		const pending = await deferred;
		assert.equal(pending.response.status(), 200);
		await navigate("jobs");
		await pending.route.fulfill({ response: pending.response });
		assert.equal(await page.locator("#draft-dialog").isVisible(), false);
		assert.equal(await page.locator(".view-networking").count(), 0);
		await record("cancelled UI retains only owned persisted result", { APOLLO: 1, TAVILY: 1, OPENAI: 1 });
		await page.goto(`${origin}/__review/preparation-second`);
		await page.locator(".view-networking").waitFor();
		assert.equal((await session()).user.id, secondUser);
		assert.equal((await session()).prospects.some((value) => value.id === personId), false);
		assert.doesNotMatch(await page.locator(".networking-table").innerText(), /Fictional Alex|reviewed@/);
		await record("second-account isolation", { APOLLO: 0, TAVILY: 0, OPENAI: 0 });
		await screenshot("second-account-isolation");
		await page.goto(`${origin}/__review/preparation`);
		await page.locator(".view-networking").waitFor();
		await review();
		await screenshot("final-mock-review");

		assert.deepEqual(errors, []);
		assert.deepEqual(external, []);
		assert.deepEqual(unexpected, []);
		receipts.push({ viewport, actions, cases, screenshots, uncaughtErrors: errors, externalRequests: external, unexpectedActions: unexpected, sends: 0 });
		await context.close();
	}
	await writeFile(join(evidence, "preparation-browser-receipt.json"), `${JSON.stringify({
		origin, mockOnly: true, realProviderCalls: 0, mailCalls: 0, receipts,
	}, null, 2)}\n`);
	console.log(`Persisted mock preparation passed at 1440 and 390; zero real providers/mail. Evidence: ${evidence}`);
} catch (error) {
	if (activePage && !activePage.isClosed()) {
		await activePage.screenshot({ path: join(evidence, "preparation-failure.png"), fullPage: true })
			.catch((captureError) => console.error(`Failure screenshot unavailable: ${captureError.message}`));
	}
	throw error;
} finally {
	await browser.close();
}
