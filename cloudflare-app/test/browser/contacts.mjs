import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const port = Number(process.env.CONTACTS_PREVIEW_PORT || 8805);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const evidence = resolve(process.env.CONTACTS_EVIDENCE_DIR || ".tutorial-preview\\contacts-evidence");
const health = await fetch(`${origin}/__review/health`);
assert.equal(health.headers.get("x-contacts-review"), "seeded-local-only");
assert.deepEqual(await health.json(), { reviewOnly: true, seeded: true });
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const owner = "10000000-0000-4000-8000-000000000808";
const software = "b".repeat(64);
const marketing = "a".repeat(64);
const receipts = [];
const costly = (path) => path === "/api/discovery" || path.startsWith("/auth/") ||
	path === "/api/resume" || path === "/api/workspace/init" ||
	/^\/api\/prospects\/[^/]+\/(prepare|regenerate|send|sync)$/.test(path);
const merge = (existing, added) => [...new Map([...existing, ...added].map((person) => [person.id, person])).values()];

try {
	for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
		const context = await browser.newContext({ viewport, reducedMotion: "reduce", isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
		const page = await context.newPage();
		const errors = [];
		const external = [];
		const paid = [];
		const added = [];
		let planned = null;
		let preference = null;
		let pendingRoute = null;
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin) {
				external.push(url.origin);
				return route.abort("blockedbyclient");
			}
			if (costly(url.pathname)) {
				const action = planned;
				assert.ok(action, `Unexpected paid action: ${url.pathname}`);
				planned = null;
				assert.equal(url.pathname, "/api/discovery");
				const body = request.postDataJSON();
				paid.push({ path: url.pathname, mode: body.mode, budget: body.anthropicSearchMaxUses, jobId: body.jobId });
				assert.equal(body.mode, action.mode);
				assert.equal(body.anthropicSearchMaxUses, action.budget || 1);
				assert.equal(body.jobId, action.jobId);
				if (action.defer) {
					pendingRoute = route;
					return;
				}
				await new Promise((done) => setTimeout(done, 150));
				added.push(...(action.prospects || []));
				return route.fulfill({
					status: action.httpStatus || 200, contentType: "application/json",
					body: JSON.stringify(action.httpStatus ? { error: "MOCK_PROVIDER_FAILURE", message: "Selected AI provider could not complete this request." } : {
						userId: owner, prospects: action.prospects || [],
						summary: {
							mode: action.mode, tavilyAttempted: action.mode === "TAVILY",
							providerReturned: 0, accepted: 0, inserted: 0, duplicates: 0,
							primaryProviderReturned: 0, primaryAccepted: 0,
							professionalBioProviderReturned: 0, professionalBioAccepted: 0,
							fallbackProvider: action.mode === "TAVILY" ? "NONE" : "ANTHROPIC",
							fallbackAttempted: action.mode === "AI_SUPPLEMENT",
							fallbackStatus: action.mode === "TAVILY" ? "NOT_REQUESTED" : "SUCCESS",
							fallbackAccepted: 0, fallbackReason: null,
							anthropicSearchMaxUses: action.budget || 1,
							...(action.jobId ? { jobQualified: 0, jobUnconfirmed: 0 } : {}),
							...action.summary,
						},
					}),
				});
			}
			if (url.pathname === "/api/session" || /^\/api\/jobs\/[a-f0-9]{64}\/prospects$/.test(url.pathname)) {
				const response = await route.fetch();
				const data = await response.json();
				const identity = data.user?.id || data.userId;
				if (identity === owner) {
					const jobId = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{64})\/prospects$/)?.[1];
					data.prospects = merge(data.prospects, added.filter((person) => !jobId || person.linkedJobs.some((job) => job.id === jobId)));
					if (preference && data.settings) {
						data.settings.peopleSearchFallbackProvider = preference;
						if (preference !== "NONE") data.credentials[preference] = { configured: false };
					}
				}
				return route.fulfill({ response, json: data });
			}
			return route.continue();
		});
		async function navigate(view) {
			if (viewport.width < 500) await page.locator("#mobile-nav-toggle").click();
			await page.locator(`#primary-navigation [data-nav="${view}"]`).click();
			await page.locator(`.view-${view}`).waitFor();
		}
		async function readyContacts() {
			await page.waitForFunction(() => document.querySelector(".networking-table") && !document.querySelector("#reload-job-contacts")?.disabled);
		}
		async function screenshot(name) {
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page overflow at the requested viewport.");
			await page.screenshot({ path: join(evidence, `${viewport.width}-${name}.png`), fullPage: true });
		}
		async function waitForResult(mode, text) {
			await page.waitForFunction(({ mode, text }) => {
				const result = document.querySelector(`.discovery-state[data-discovery-mode="${mode}"]`);
				return result?.textContent.includes(text) && !document.querySelector("#cancel-people-search");
			}, { mode, text });
		}
		async function aiAction(action, text) {
			const before = paid.length;
			planned = { mode: "AI_SUPPLEMENT", jobId: software, ...action };
			if (!await page.locator("#find-more-ai").isVisible()) await page.locator(".ai-discovery > summary").click();
			await page.locator("#find-more-ai").click();
			await waitForResult("AI_SUPPLEMENT", text);
			assert.equal(paid.length, before + 1, "Exactly one API action per explicit AI click.");
			assert.equal(await page.locator("#anthropic-expanded-search").isChecked(), false);
		}

		await page.goto(`${origin}/__review/existing`);
		await page.locator(".home-recent-card").first().waitFor();
		assert.ok(await page.locator(".home-recent-card [data-job-network]").count() > 0);
		await navigate("jobs");
		await page.locator('[data-job-layout="list"]').click();
		await page.locator('[data-job-mode="saved"]').click();
		await page.locator(`[data-job-network="${software}"]`).click();
		await readyContacts();
		assert.deepEqual(await page.locator(".networking-table .person-cell strong").allTextContents(), [
			"Fictional Avery", "Fictional Blair", "Fictional Casey", "Fictional Dana", "Fictional Emerson",
		]);
		assert.equal(paid.length, 0);
		const session = await page.evaluate(async () => (await fetch("/api/session")).json());
		const newPeer = structuredClone(session.prospects.find((person) => person.fullName === "Fictional Avery"));
		newPeer.id = "40000000-0000-4000-8000-000000000801";
		newPeer.fullName = "Fictional Morgan";
		newPeer.firstName = "Morgan";
		newPeer.linkedinUrl = newPeer.sourceUrl = "https://www.linkedin.com/in/fictional-local-morgan";
		newPeer.sourceSnippet = "Fictional Morgan is a Junior Software Engineer at Example Software Co.";
		newPeer.discoveryProvider = "ANTHROPIC_GROUNDED";
		await page.locator(".job-contact-priority details").first().locator("summary").click();
		await screenshot("ranked-saved-contacts");
		await page.reload();
		await readyContacts();
		assert.ok(page.url().includes(`contactJob=${software}`));
		assert.equal(paid.length, 0, "Opening and reloading saved contacts never searches.");

		await page.locator("#open-discovery-dialog").click();
		assert.match(await page.locator("#find-form").innerText(), /Search and Retry use Tavily only/);
		assert.doesNotMatch(await page.locator("#find-form").innerText(), /model-token|Anthropic pricing|authorize up to 3/);
		assert.equal(await page.locator("#find-form #anthropic-expanded-search").count(), 0);
		await screenshot("tavily-upfront-costs");
		planned = { mode: "TAVILY", jobId: software, summary: { accepted: 1, duplicates: 1, primaryAccepted: 1, jobQualified: 1 } };
		await page.locator("#find-form button[type=submit]").click();
		await waitForResult("TAVILY", "already tracked");
		assert.equal(paid.length, 1);
		assert.deepEqual(paid.map((call) => call.mode), ["TAVILY"]);
		await page.locator(".ai-discovery > summary").click();
		await page.locator("#anthropic-expanded-search").check();
		await page.locator("#retry-job-discovery").click();
		assert.equal(paid.length, 1, "Ordinary Retry only opens the Tavily form.");
		assert.equal(await page.locator("#anthropic-expanded-search").isChecked(), false);
		planned = { mode: "TAVILY", jobId: software };
		await page.locator("#find-form button[type=submit]").click();
		await waitForResult("TAVILY", "No qualified matches");
		assert.deepEqual(paid.map((call) => call.mode), ["TAVILY", "TAVILY"]);
		assert.match(await page.locator(".ai-search-cost-notice").innerText(), /1 web search/);
		assert.equal(await page.locator("#anthropic-expanded-search").isChecked(), false);
		await screenshot("tavily-results-manual-ai");

		await aiAction({
			prospects: [newPeer],
			summary: { inserted: 1, accepted: 1, fallbackAccepted: 1, fallbackStatus: "SEARCH_LIMITED", fallbackReason: "max_uses_exceeded", jobQualified: 1 },
		}, "1-search limit");
		assert.equal(await page.locator(".networking-table .person-cell").count(), 6);
		assert.equal(await page.locator('.discovery-state[data-discovery-mode="TAVILY"]').count(), 1, "The initial Tavily outcome stays visible.");
		const separation = await page.locator('.discovery-state[data-discovery-mode="AI_SUPPLEMENT"] > div').first().evaluate((element) => {
			const title = element.querySelector("strong").getBoundingClientRect();
			return element.querySelector("span").getBoundingClientRect().top - title.bottom;
		});
		assert.ok(separation >= 4);
		await screenshot("ai-partial-preserved");
		await page.locator(".ai-discovery > summary").click();
		await page.locator("#anthropic-expanded-search").check();
		await aiAction({ budget: 3, summary: { fallbackStatus: "SEARCH_LIMITED", fallbackReason: "max_uses_exceeded" } }, "3-search limit");
		assert.equal(await page.locator(".networking-table .person-cell").count(), 6);
		await aiAction({ summary: { accepted: 1, duplicates: 1, jobQualified: 1 } }, "already tracked");
		await aiAction({}, "No qualified matches");
		await aiAction({ httpStatus: 503 }, "Selected AI provider could not complete");
		assert.equal(await page.locator(".networking-table .person-cell").count(), 6);
		assert.deepEqual(paid.filter((call) => call.mode === "AI_SUPPLEMENT").map((call) => call.budget), [1, 3, 1, 1, 1]);
		assert.equal(paid.filter((call) => call.mode === "TAVILY").length, 2, "AI actions never rerun Tavily.");
		await screenshot("ai-failure-keeps-contacts");

		await navigate("applications");
		await page.locator(`[data-application-edit="${marketing}"]`).click();
		await page.locator("#application-dialog-network").click();
		await readyContacts();
		assert.equal(await page.locator(".networking-table .person-cell strong").first().textContent(), "Fictional Casey");
		assert.equal(paid.length, 7, "Changing the linked job reads only saved contacts.");
		await page.locator("[data-review]").click();
		await page.locator("#draft-dialog").waitFor();
		page.once("dialog", (dialog) => dialog.dismiss());
		await page.locator("#send-draft").click();
		assert.equal(paid.length, 7, "Cancelling final send approval cannot send.");
		await page.getByRole("button", { name: "Close dialog", exact: true }).click();

		await page.locator("#clear-networking-job").click();
		await page.locator("#open-discovery-dialog").click();
		await page.locator("#roles").fill("Software Engineer");
		await page.locator("#companies").fill("Example Software Co");
		planned = { mode: "TAVILY" };
		await page.locator("#find-form button[type=submit]").click();
		await waitForResult("TAVILY", "No new people added");
		const generalPeer = {
			...newPeer, id: "40000000-0000-4000-8000-000000000802", fullName: "Fictional Noel", firstName: "Noel", linkedJobs: [],
			linkedinUrl: "https://www.linkedin.com/in/fictional-local-noel", sourceUrl: "https://www.linkedin.com/in/fictional-local-noel",
			sourceSnippet: "Fictional Noel is a Junior Software Engineer at Example Software Co.",
		};
		await aiAction({ jobId: undefined, prospects: [generalPeer], summary: { inserted: 1, accepted: 1, fallbackAccepted: 1 } }, "1 new person");
		assert.equal(await page.locator(".networking-table .person-cell").count(), 7);
		await screenshot("general-manual-ai");
		await page.reload();
		await page.locator(".networking-table").waitFor();
		assert.equal(await page.locator(".networking-table .person-cell").count(), 7, "Mock-persisted merge survives reload.");

		await navigate("jobs");
		await page.locator(`[data-job-network="${software}"]`).click();
		await readyContacts();
		planned = { mode: "AI_SUPPLEMENT", jobId: software, defer: true };
		await page.locator(".ai-discovery > summary").click();
		await page.locator("#find-more-ai").click();
		await page.locator("#cancel-people-search").waitFor();
		await navigate("settings");
		assert.ok(pendingRoute);
		await pendingRoute.fulfill({ status: 200, json: { userId: owner, prospects: [generalPeer], summary: { mode: "AI_SUPPLEMENT", inserted: 1, accepted: 1 } } });
		pendingRoute = null;
		await page.waitForTimeout(200);
		assert.equal(await page.locator(".view-settings").count(), 1, "Late AI response cannot navigate back or replace another context.");
		assert.equal(paid.length, 10);

		await page.goto(`${origin}/__review/second`);
		await navigate("jobs");
		await page.locator(`[data-job-network="${software}"]`).click();
		await page.getByText("No saved contacts for this job yet.", { exact: false }).waitFor();
		assert.equal(await page.locator(".networking-table .person-cell").count(), 0);
		assert.match(await page.locator(".ai-discovery").textContent(), /AI discovery is disabled/);
		assert.equal(await page.locator("#find-more-ai").isDisabled(), true);
		await page.locator("#open-discovery-dialog").click();
		assert.equal(await page.locator("#find-form button[type=submit]").isDisabled(), true);
		await page.locator("#close-discovery-dialog").click();
		await navigate("settings");
		await page.locator('[data-onboarding-launch="start"], [data-onboarding-launch="replay"]').click();
		await page.locator('[data-tutorial-step="welcome"]').waitFor();
		for (const step of ["tavily", "hunter", "drafting", "search-fallback"]) {
			await page.locator(".tutorial-panel").getByRole("button", { name: "Next", exact: true }).click();
			await page.locator(`[data-tutorial-step="${step}"]`).waitFor();
		}
		assert.match(await page.locator(".tutorial-panel").innerText(), /Only clicking Find more with AI/);
		assert.match(await page.locator(".tutorial-panel").innerText(), /up to 3 per AI request/);
		assert.equal(paid.length, 10, "Account changes and tutorial navigation cannot search.");
		await page.locator(".tutorial-header [data-tutorial-action=pause]").click();

		preference = "OPENAI";
		await page.goto(`${origin}/__review/existing`);
		await navigate("jobs");
		await page.locator(`[data-job-network="${software}"]`).click();
		await readyContacts();
		assert.match(await page.locator(".ai-discovery").textContent(), /No API key is configured for OpenAI/);
		assert.equal(await page.locator("#find-more-ai").isDisabled(), true);
		assert.equal(paid.length, 10);
		assert.deepEqual(external, []);
		assert.deepEqual(errors, []);
		receipts.push({
			viewport, explicitMockRequests: paid, tavilyActions: paid.filter((call) => call.mode === "TAVILY").length,
			aiActions: paid.filter((call) => call.mode === "AI_SUPPLEMENT").length,
			externalRequests: external, realProviderRequests: 0, pageErrors: errors, status: "passed",
		});
		await context.close();
	}
	for (const path of ["/api/discovery", "/api/workspace/init", "/api/resume", "/api/prospects/fictional/send"]) {
		const response = await fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin } });
		assert.equal(response.status, 403);
		assert.equal((await response.json()).error, "REVIEW_ONLY");
	}
	assert.equal((await fetch(`${origin}/auth/google/login`)).status, 403);
	await writeFile(join(evidence, "contacts-browser-receipt.json"), `${JSON.stringify(receipts, null, 2)}\n`);
	console.log("Desktop1440/phone390 Tavily-only and explicit AI flows passed; paid actions mocked, external requests blocked.");
} finally {
	await browser.close();
}
