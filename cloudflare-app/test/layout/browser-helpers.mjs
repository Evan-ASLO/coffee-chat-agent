import assert from "node:assert/strict";
import path from "node:path";

export const baseUrl = process.env.LAYOUT_BASE_URL || "http://127.0.0.1:8804";
assert.equal(new URL(baseUrl).origin, "http://127.0.0.1:8804", "Use only the isolated local review fixture.");
export const evidenceDirectory = path.resolve(
	process.env.LAYOUT_EVIDENCE_DIR || path.join("..", ".d1", "layout-evidence"),
);
let visit = 0;

export async function assertReviewReady() {
	const response = await fetch(`${baseUrl}/__review/health`);
	assert.equal(response.status, 200, "The isolated review database must be seeded.");
	assert.equal(response.headers.get("x-layout-review"), "seeded-local-only");
	assert.deepEqual(await response.json(), { reviewOnly: true, seeded: true });
}

export function createMonitor() {
	return { consoleErrors: [], networkErrors: [], externalRequests: [], unexpectedMutations: [] };
}

export async function createReviewContext(browser, scenario, viewport, monitor, options = {}) {
	const context = await browser.newContext({ viewport, reducedMotion: "reduce", ...options });
	await context.route("**/*", (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== baseUrl) {
			monitor.externalRequests.push(url.origin);
			return route.abort("blockedbyclient");
		}
		if (!["GET", "HEAD"].includes(request.method())) {
			monitor.unexpectedMutations.push(`${request.method()} ${url.pathname}`);
		}
		return route.continue();
	});
	context.on("page", (page) => {
		page.on("pageerror", (error) => monitor.consoleErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error" ||
				(message.type() === "warning" && /too many active webgl|failed to create.*webgl/i.test(message.text()))) {
				monitor.consoleErrors.push(message.text());
			}
		});
		page.on("response", (response) => {
			if (response.status() >= 400) {
				monitor.networkErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
			}
		});
	});
	const page = await context.newPage();
	return { context, page, login: async () => {
		await page.goto(`${baseUrl}/__review/login?scenario=${scenario}`);
		await page.waitForSelector(".app-frame");
	} };
}

export async function openView(page, view) {
	const fragment = view === "home" ? "" : `#${view === "saved" ? "jobs" : view}`;
	await page.goto(`${baseUrl}/?layout-review=${++visit}-${view}${fragment}`);
	await page.waitForSelector(`.view-${view === "saved" ? "jobs" : view}`, { timeout: 15000 });
	if (view === "saved") await page.locator('[data-job-mode="saved"]').click();
	if (view === "home") {
		await page.waitForFunction(() => document.querySelector("#journey-canvas")?.getAttribute("aria-busy") === "false");
	}
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
	await settleLayout(page);
}

export async function settleLayout(page) {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
}

export async function measure(page) {
	return page.evaluate(() => {
		const viewport = document.documentElement.clientWidth;
		const identify = (element) =>
			`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].slice(0, 3).map((name) => `.${name}`).join("")}`;
		const visible = (element) => {
			const style = getComputedStyle(element);
			for (let parent = element.parentElement; parent; parent = parent.parentElement) {
				if (parent.matches("details:not([open])") &&
					!parent.querySelector(":scope > summary")?.contains(element)) return false;
			}
			return element.getClientRects().length && style.visibility !== "hidden" && style.display !== "none" && !element.closest("[hidden]");
		};
		const surface = document.querySelector("dialog[open], .nav-open #primary-navigation, .job-more[open]") || document;
		const insideTable = (element) => element.closest(".responsive-table-wrap");
		const controls = [...surface.querySelectorAll("button, input, select, textarea, summary, a.button, .site-footer a")].filter(visible);
		const offscreenControls = controls.filter((element) => {
			if (insideTable(element)) return false;
			const rect = element.getBoundingClientRect();
			return rect.left < -1 || rect.right > viewport + 1;
		}).map(identify);
		const panels = surface.querySelectorAll(
			".topbar, .reference-hero-copy, .home-search-panel, .home-search-controls, .home-recent-card, .reference-metric, .job-card, .job-card-heading, .job-search-strip, .filter-panel, .tracker-filters, .table-panel-heading, .table-tools, .settings-reference-card, .secret-row, .analytics-panel, .donut-layout, .network-impact, .home-journey-detail, .home-journey-milestones, .dialog-card, .job-more-menu, .beta-landing-brand, .beta-landing-grid",
		);
		const overflowPanels = [...panels].filter((element) =>
			visible(element) && element.scrollWidth > element.clientWidth + 2,
		).map((element) => ({ element: identify(element), extra: element.scrollWidth - element.clientWidth }));
		const heroClipping = [...surface.querySelectorAll(".reference-hero, .home-reference-hero")].filter((element) => {
			const copy = element.querySelector(".reference-hero-copy, .home-reference-copy");
			return copy && copy.getBoundingClientRect().bottom > element.getBoundingClientRect().bottom + 1;
		}).map(identify);
		const overlappingControls = [];
		for (let index = 0; index < controls.length; index++) {
			const left = controls[index];
			if (insideTable(left)) continue;
			const a = left.getBoundingClientRect();
			for (let next = index + 1; next < controls.length; next++) {
				const right = controls[next];
				if (insideTable(right) || left.contains(right) || right.contains(left)) continue;
				const b = right.getBoundingClientRect();
				if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
					Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
					overlappingControls.push([identify(left), identify(right)]);
				}
			}
		}
		const occludedControls = controls.filter((element) => {
			if (insideTable(element)) return false;
			const rect = element.getBoundingClientRect();
			if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > viewport) return false;
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return hit && !element.contains(hit);
		}).map(identify);
		const touch = matchMedia("(pointer: coarse)").matches || viewport <= 700;
		const undersizedTouchTargets = touch ? controls.filter((element) => {
			const target = element.matches('[type="checkbox"]') ? element.closest("label") : element;
			const rect = target.getBoundingClientRect();
			return rect.width < 43.5 || rect.height < 43.5;
		}).map(identify) : [];
		const smallFormText = touch ? controls.filter((element) =>
			element.matches("input, select, textarea") && parseFloat(getComputedStyle(element).fontSize) < 16,
		).map(identify) : [];
		const searchIcons = [...surface.querySelectorAll(".search-field, .home-search-input")].filter(visible).map((label) => {
			const icon = label.querySelector(".icon")?.getBoundingClientRect();
			const input = label.querySelector("input")?.getBoundingClientRect();
			return {
				element: identify(label),
				aligned: Boolean(icon && input && Math.abs((icon.top + icon.height / 2) - (input.top + input.height / 2)) <= 2),
			};
		});
		const misalignedMetricIcons = [...surface.querySelectorAll(".reference-metric-icon")].filter(visible).filter((element) => {
			const tile = element.getBoundingClientRect();
			const icon = element.querySelector(".icon").getBoundingClientRect();
			return Math.abs((tile.left + tile.width / 2) - (icon.left + icon.width / 2)) > 2 ||
				Math.abs((tile.top + tile.height / 2) - (icon.top + icon.height / 2)) > 2;
		}).map(identify);
		const obscuredJourneyControls = [...surface.querySelectorAll(".home-journey-milestones button")].filter((button) => {
			const detail = surface.querySelector(".home-journey-detail");
			if (!detail) return false;
			const a = button.getBoundingClientRect();
			const b = detail.getBoundingClientRect();
			return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
				Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
		}).map(identify);
		return {
			pageOverflow: document.documentElement.scrollWidth - viewport,
			offscreenControls, overflowPanels, heroClipping, overlappingControls, occludedControls,
			undersizedTouchTargets, smallFormText, searchIcons, misalignedMetricIcons, obscuredJourneyControls,
		};
	});
}

export function hasDefects(entry) {
	return entry.pageOverflow > 1 || [
		"offscreenControls", "overflowPanels", "heroClipping", "overlappingControls", "occludedControls",
		"undersizedTouchTargets", "smallFormText", "misalignedMetricIcons", "obscuredJourneyControls",
	].some((key) => entry[key].length) || entry.searchIcons.some((icon) => !icon.aligned);
}

export function assertCleanMonitor(monitor) {
	for (const [kind, messages] of Object.entries(monitor)) {
		assert.deepEqual(messages, [], `Unexpected browser ${kind}.`);
	}
}
