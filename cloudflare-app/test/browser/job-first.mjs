import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const origin = "http://127.0.0.1:8807";
const evidence = resolve(process.env.JOB_FIRST_EVIDENCE_DIR || ".tutorial-preview\\job-first-evidence");
const health = await fetch(`${origin}/__review/preparation/health`);
assert.deepEqual(await health.json(), { reviewOnly: true, mockOnly: true, seeded: true });
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const jobId = "b".repeat(64);
const receipts = [];
let activePage;
try {
	for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
		const context = await browser.newContext({ viewport, reducedMotion: "reduce", isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
		const page = await context.newPage();
		activePage = page;
		const errors = [], forbidden = [], screenshots = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", (route) => {
			const request = route.request(), url = new URL(request.url());
			if (url.origin !== origin || /\/api\/(?:discovery|credentials|resume|workspace)|\/auth\/|\/api\/prospects\//.test(url.pathname)) {
				forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
				return route.abort();
			}
			return route.continue();
		});
		async function shot(name) {
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} must not overflow.`);
			const filename = `${viewport.width}-${name}.png`;
			await page.screenshot({ path: join(evidence, filename), fullPage: true });
			screenshots.push(filename);
		}
		async function navigate(view) {
			if (["settings", "analytics", "home"].includes(view)) {
				await page.locator(".account-menu > summary").click();
				await page.locator(`.account-menu [data-nav="${view}"]`).click();
			} else await page.locator(`#primary-navigation [data-nav="${view}"]`).click();
			await page.locator(`.view-${view}`).waitFor();
		}
		async function stage() {
			return page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}`)).json()).job.userState, jobId);
		}
		await page.goto(`${origin}/__review/preparation`);
		await page.locator(".app-frame").waitFor();
		await page.evaluate(async (id) => {
			const csrf = /(?:^|;\s*)cc_csrf=([^;]+)/.exec(document.cookie)?.[1];
			const response = await fetch(`/api/jobs/${id}/state`, {
				method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
				body: JSON.stringify({ status: "SAVED", notes: "Fictional review: saved next step" }),
			});
			if (!response.ok) throw new Error(`Fixture job tracking failed: ${response.status}`);
		}, jobId);
		await page.goto(`${origin}/?q=Fictional#find-jobs`);
		await page.locator(".view-jobs").waitFor();
		assert.equal(await page.locator("#primary-navigation a").count(), 3);
		await page.locator("#job-term").selectOption("");
		await page.locator("#job-filter-form").evaluate((form) => form.requestSubmit());
		await page.locator(`.job-card [data-job-detail="${jobId}"]`).waitFor();
		await shot("find-jobs");
		await page.locator(`.job-card [data-job-detail="${jobId}"]`).click();
		await page.locator(`#job-notes-${jobId}`).fill("Fictional review: unsaved notes survive navigation");
		const detailUrl = page.url();
		await navigate("applications");
		await page.goBack();
		await page.locator(".view-jobs").waitFor();
		assert.equal(page.url(), detailUrl);
		await page.waitForFunction((id) => document.getElementById(`job-notes-${id}`)?.value === "Fictional review: unsaved notes survive navigation", jobId);
		await page.locator("[data-save-job-notes]").click();
		await page.waitForFunction((id) => !Object.hasOwn(state.jobNoteDrafts, id), jobId);
		assert.equal((await stage()).notes, "Fictional review: unsaved notes survive navigation");
		await page.reload();
		await page.locator(`#job-notes-${jobId}`).waitFor();
		assert.equal(await page.locator(`#job-notes-${jobId}`).inputValue(), "Fictional review: unsaved notes survive navigation");
		await page.locator(`.job-detail-card [data-job-apply="${jobId}"]`).click();
		await page.waitForFunction(() => document.querySelector(".job-detail-card select")?.value === "APPLIED");
		await page.locator(".job-detail-card [data-job-status]").selectOption("INTERVIEWING");
		await page.waitForFunction(() => document.querySelector(".job-detail-card select")?.value === "INTERVIEWING");
		assert.equal(await page.locator(".job-detail-card [data-job-apply]").isDisabled(), true);
		assert.equal((await stage()).status, "INTERVIEWING");
		await page.locator(".job-detail-card .status-interviewing").waitFor();
		await shot("role-notes-interview");
		const filters = new URL(page.url()).searchParams.get("q");
		await page.locator(".job-detail-card [data-job-network]").click();
		await page.locator(".view-networking .networking-context").waitFor();
		assert.equal(new URL(page.url()).searchParams.get("q"), filters);
		assert.equal(new URL(page.url()).searchParams.get("contactJob"), jobId);
		await shot("linked-people");
		await page.goBack();
		await page.locator(".view-jobs").waitFor();
		await navigate("applications");
		await page.locator(`[data-application-edit="${jobId}"]`).click();
		await page.locator("#application-dialog-notes").fill("Fictional review: editor draft survives");
		await page.locator("#application-dialog button[value=cancel]").click();
		await navigate("jobs");
		await navigate("applications");
		await page.locator(`[data-application-edit="${jobId}"]`).click();
		assert.equal(await page.locator("#application-dialog-notes").inputValue(), "Fictional review: editor draft survives");
		await page.locator("#application-dialog-save").click();
		await page.waitForFunction(() => !document.getElementById("application-dialog")?.open);
		assert.equal((await stage()).notes, "Fictional review: editor draft survives");
		await shot("my-jobs");
		await page.locator(".account-menu > summary").click();
		await page.locator(".account-menu [data-open-guide]").click();
		await page.locator("#job-first-guide").waitFor();
		assert.match(await page.locator("#job-first-guide").innerText(), /Apollo is OFF/);
		await page.locator("#guide-open-settings").click();
		await page.locator(".view-settings").waitFor();
		await shot("setup-profile");
		await page.locator(".top-actions [data-open-demo]").click();
		await page.locator("#job-first-demo").waitFor();
		assert.match(await page.locator("#job-first-demo").innerText(), /fictional concept demonstration/);
		assert.equal(await page.locator("#job-first-demo video").evaluate((video) => video.paused), true);
		const duration = await page.locator("#job-first-demo video").evaluate((video) => new Promise((resolve, reject) => {
			video.addEventListener("loadedmetadata", () => resolve(video.duration), { once: true });
			video.addEventListener("error", () => reject(new Error("Existing Demo media failed to load.")), { once: true });
			video.load();
		}));
		assert.ok(Number.isFinite(duration) && duration > 0, "Self-hosted Demo is playable, without autoplay.");
		await page.keyboard.press("Escape");
		await navigate("home");
		await shot("home");
		await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
		await page.reload();
		await page.locator(".view-home").waitFor();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		assert.equal(await page.locator(".home-reference-stats").evaluate((node) => getComputedStyle(node).position), "static");
		await shot("home-dark");
		await navigate("settings");
		await shot("setup-profile-dark");
		await page.goto(`${origin}/__review/preparation-second`);
		await page.locator(".app-frame").waitFor();
		await navigate("jobs");
		await page.locator(`.job-card [data-job-detail="${jobId}"]`).click();
		assert.equal(await page.locator(`#job-notes-${jobId}`).count(), 0, "Second account has no first-account tracking notes.");
		assert.doesNotMatch(await page.locator("body").innerText(), /editor draft survives/);
		assert.deepEqual(errors, []);
		assert.deepEqual(forbidden, []);
		receipts.push({ viewport, persistedNotes: true, interviewNotRegressed: true, linkedFiltersPreserved: true, history: true, accountIsolated: true, screenshots, errors, forbidden });
		await context.close();
	}
	await writeFile(join(evidence, "receipt.json"), JSON.stringify({ mockOnly: true, realProviderCalls: 0, outreachSends: 0, cases: receipts }, null, 2));
	console.log(JSON.stringify({ mockOnly: true, viewports: receipts.map((receipt) => receipt.viewport.width), evidence }));
} catch (error) {
	if (activePage && !activePage.isClosed()) {
		await activePage.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
		console.error(await activePage.evaluate(() => ({
			url: location.href, notes: state.jobNoteDrafts,
			selected: state.selectedJob?.userState,
			jobs: state.jobs.jobs.map((job) => ({ id: job.id, userState: job.userState })),
			domNotes: document.querySelector("[data-job-note]")?.value,
		})));
	}
	throw error;
} finally { await browser.close(); }
