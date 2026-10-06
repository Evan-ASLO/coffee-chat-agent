import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const origin = "http://127.0.0.1:8805";
const evidence = resolve(process.env.CONTACTS_EVIDENCE_DIR || ".tutorial-preview\\contacts-evidence");
const health = await fetch(`${origin}/__review/health`);
assert.equal(health.headers.get("x-contacts-review"), "seeded-local-only");
assert.deepEqual(await health.json(), { reviewOnly: true, seeded: true });
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const software = "b".repeat(64);
const marketing = "a".repeat(64);
const receipts = [];
const costly = (path) => path === "/api/discovery" || path.startsWith("/auth/") ||
	path === "/api/resume" || path === "/api/workspace/init" ||
	/^\/api\/prospects\/[^/]+\/(prepare|regenerate|send|sync)$/.test(path);

try {
	for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
		const context = await browser.newContext({ viewport, reducedMotion: "reduce", isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
		const page = await context.newPage();
		const errors = [];
		const external = [];
		const paid = [];
		let planned = null;
		let calls = 0;
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin) {
				external.push(url.origin);
				return route.abort("blockedbyclient");
			}
			if (costly(url.pathname)) {
				paid.push({ path: url.pathname, body: request.postDataJSON() });
				assert.ok(planned, `Unexpected paid action: ${url.pathname}`);
				assert.equal(url.pathname, planned.path);
				if (url.pathname === "/api/discovery") {
					calls++;
					assert.equal(request.postDataJSON().anthropicSearchMaxUses, planned.budget);
					assert.equal(request.postDataJSON().jobId, planned.jobId);
					await new Promise((done) => setTimeout(done, 300));
				}
				return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(planned.response) });
			}
			return route.continue();
		});
		async function navigate(view) {
			if (viewport.width < 500) await page.locator("#mobile-nav-toggle").click();
			await page.locator(`#primary-navigation [data-nav="${view}"]`).click();
			await page.locator(`.view-${view}`).waitFor();
		}
		async function readyContacts() {
			await page.waitForFunction(() =>
				document.querySelector(".networking-table") && !document.querySelector("#reload-job-contacts")?.disabled,
			);
		}
		async function assertNoOverflow() {
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		}

		await page.goto(`${origin}/__review/existing`);
		await page.locator(".home-recent-card").first().waitFor();
		assert.ok(await page.locator(".home-recent-card [data-job-network]").count() > 0);
		await navigate("jobs");
		await page.locator('[data-job-layout="list"]').click();
		assert.ok(await page.locator(".job-controls [data-job-network]").count() > 0);
		await page.locator('[data-job-mode="saved"]').click();
		await page.locator(`[data-job-network="${software}"]`).click();
		await readyContacts();
		assert.deepEqual(await page.locator(".networking-table .person-cell strong").allTextContents(), [
			"Fictional Avery", "Fictional Blair", "Fictional Casey", "Fictional Dana", "Fictional Emerson",
		]);
		assert.equal(paid.length, 0);
		await page.locator(".job-contact-priority details").first().locator("summary").click();
		assert.match(await page.locator(".job-contact-priority").first().innerText(), /entry-level role|public profile/i);
		assert.ok(await page.locator(".job-contact-priority").first().getByRole("link", { name: "Open public source" }).getAttribute("href"));
		await assertNoOverflow();
		await page.screenshot({ path: join(evidence, `${viewport.width}-ranked-contacts.png`), fullPage: true });
		await page.reload();
		await readyContacts();
		assert.ok(page.url().includes(`contactJob=${software}`));
		assert.equal(paid.length, 0);

		await navigate("applications");
		await page.locator(`[data-application-edit="${marketing}"]`).click();
		await page.locator("#application-dialog-network").click();
		await readyContacts();
		assert.equal(await page.locator(".networking-table .person-cell strong").first().textContent(), "Fictional Casey");
		assert.equal(paid.length, 0);

		await page.locator("#open-discovery-dialog").click();
		await page.locator("#find-form").waitFor();
		assert.ok(await page.locator(".search-cost-notice").last().isVisible());
		assert.match(await page.locator("#find-form").innerText(), /up to 3 web searches, plus model-token usage/);
		assert.equal(await page.locator("#anthropic-expanded-search").isChecked(), false);
		await assertNoOverflow();
		await page.screenshot({ path: join(evidence, `${viewport.width}-upfront-costs.png`), fullPage: true });
		planned = {
			path: "/api/discovery", budget: 3, jobId: marketing,
			response: { prospects: [], summary: {
				inserted: 0, duplicates: 3, accepted: 3, primaryAccepted: 2, professionalBioAccepted: 0,
				fallbackAccepted: 1, fallbackProvider: "ANTHROPIC", fallbackStatus: "SEARCH_LIMITED",
				fallbackReason: "max_uses_exceeded", anthropicSearchMaxUses: 3, jobQualified: 3, jobUnconfirmed: 0,
			} },
		};
		await page.locator("#anthropic-expanded-search").check();
		await page.locator("#find-form button[type=submit]").click();
		await page.waitForFunction(() => document.querySelector(".discovery-state")?.textContent.includes("3-search limit"));
		assert.equal(calls, 1);
		const separation = await page.locator(".discovery-state > div").first().evaluate((element) => {
			const title = element.querySelector("strong").getBoundingClientRect();
			const body = element.querySelector("span").getBoundingClientRect();
			return body.top - title.bottom;
		});
		assert.ok(separation >= 4, "Status heading and body must not concatenate.");
		await page.screenshot({ path: join(evidence, `${viewport.width}-partial-retry.png`), fullPage: true });
		await page.locator("#retry-job-discovery").click();
		assert.equal(calls, 1, "Retry opens the notice, not a paid request.");
		await page.locator("#anthropic-expanded-search").uncheck();
		planned = {
			path: "/api/discovery", budget: 1, jobId: marketing,
			response: { prospects: [], summary: {
				inserted: 0, duplicates: 0, accepted: 0, primaryAccepted: 0,
				fallbackAccepted: 0, fallbackProvider: "ANTHROPIC", fallbackStatus: "SEARCH_LIMITED",
				fallbackReason: "max_uses_exceeded", anthropicSearchMaxUses: 1, jobQualified: 0, jobUnconfirmed: 0,
			} },
		};
		await page.locator("#find-form button[type=submit]").click();
		await page.waitForFunction(() => document.querySelector(".discovery-state")?.textContent.includes("1-search limit"));
		assert.equal(calls, 2);
		planned = null;
		assert.ok(await page.locator("[data-prepare]").count() > 0);
		await page.locator("[data-review]").click();
		await page.locator("#draft-dialog").waitFor();
		page.once("dialog", (dialog) => dialog.dismiss());
		await page.locator("#send-draft").click();
		assert.equal(paid.length, 2, "Cancelling final send approval cannot send.");
		await page.getByRole("button", { name: "Close dialog", exact: true }).click();

		await page.locator("#clear-networking-job").click();
		await page.locator("#open-discovery-dialog").click();
		assert.equal(await page.locator("#anthropic-expanded-search").isChecked(), false);
		assert.ok(await page.locator("#companies").isVisible());
		planned = {
			path: "/api/discovery", budget: 1, jobId: undefined,
			response: { prospects: [], summary: {
				inserted: 0, duplicates: 0, accepted: 0, providerReturned: 0,
				fallbackProvider: "ANTHROPIC", fallbackStatus: "SUCCESS", anthropicSearchMaxUses: 1,
			} },
		};
		await page.locator("#companies").fill("Example Software Co");
		await page.locator("#find-form button[type=submit]").click();
		await page.waitForFunction(() => document.querySelector(".discovery-state")?.textContent.includes("No new people added"));
		assert.equal(calls, 3);
		planned = null;

		await page.goto(`${origin}/__review/second`);
		await navigate("jobs");
		await page.locator(`[data-job-network="${software}"]`).click();
		await page.getByText("No saved contacts for this job yet.", { exact: false }).waitFor();
		assert.equal(await page.locator(".networking-table .person-cell").count(), 0);
		assert.ok(await page.getByRole("button", { name: "Set up discovery in Settings" }).isVisible());
		await page.locator("#open-discovery-dialog").click();
		assert.equal(await page.locator("#find-form button[type=submit]").isDisabled(), true);
		assert.equal(paid.length, 3);
		await page.locator("#close-discovery-dialog").click();
		await navigate("settings");
		await page.locator('[data-onboarding-launch="start"], [data-onboarding-launch="replay"]').click();
		await page.locator('[data-tutorial-step="welcome"]').waitFor();
		for (const step of ["tavily", "hunter", "drafting", "search-fallback"]) {
			await page.locator(".tutorial-panel").getByRole("button", { name: "Next", exact: true }).click();
			await page.locator(`[data-tutorial-step="${step}"]`).waitFor();
		}
		assert.match(await page.locator(".tutorial-panel").innerText(), /up to 3 per search/);
		assert.equal(paid.length, 3, "Tutorial steps cannot call a paid provider.");
		await page.locator(".tutorial-header [data-tutorial-action=pause]").click();
		assert.deepEqual(external, []);
		assert.deepEqual(errors, []);
		receipts.push({ viewport, explicitMockRequests: paid.map(({ path, body }) => ({ path, budget: body?.anthropicSearchMaxUses })), externalRequests: external, pageErrors: errors, status: "passed" });
		await context.close();
	}
	for (const path of ["/api/discovery", "/api/workspace/init", "/api/resume", "/api/prospects/fictional/send"]) {
		const response = await fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin } });
		assert.equal(response.status, 403);
		assert.equal((await response.json()).error, "REVIEW_ONLY");
	}
	assert.equal((await fetch(`${origin}/auth/google/login`)).status, 403);
	await writeFile(join(evidence, "contacts-browser-receipt.json"), `${JSON.stringify(receipts, null, 2)}\n`);
	console.log("Focused desktop/phone contacts flow passed; all paid actions mocked and external requests blocked.");
} finally {
	await browser.close();
}
