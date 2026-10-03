import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
	baseUrl, evidenceDirectory, assertReviewReady, createMonitor, createReviewContext,
	openView, settleLayout, measure, hasDefects, assertCleanMonitor,
} from "./browser-helpers.mjs";

const baseline = process.argv.includes("--baseline");
const quick = process.argv.includes("--quick");
const label = baseline ? "before" : "after";
const output = evidenceDirectory;
await mkdir(path.join(output, label), { recursive: true });
await assertReviewReady();

const browser = await chromium.launch({
	channel: process.env.LAYOUT_BROWSER_CHANNEL || "msedge",
	headless: true,
	args: ["--disable-webgl"],
});
const views = ["home", "jobs", "saved", "applications", "networking", "analytics", "settings"];
const widths = quick ? [320, 768, 1280, 1536] : [320, 360, 390, 430, 768, 1024, 1280, 1440, 1536, 1920];
const snapshots = [];
const monitor = createMonitor();

async function makeContext(scenario, viewport) {
	const { context, page, login } = await createReviewContext(browser, scenario, viewport, monitor);
	await login();
	return { context, page };
}

async function checkedOpenView(page, view) {
	try {
		await openView(page, view);
	} catch (error) {
		await page.screenshot({ path: path.join(output, label, "navigation-failure.png"), fullPage: true });
		console.error("Navigation failure:", page.url(), await page.locator("body").innerText());
		throw error;
	}
}

async function snapshot(page, scenario, view, width, height = 900, screenshot = false) {
	await page.setViewportSize({ width, height });
	await checkedOpenView(page, view);
	const metrics = await measure(page);
	snapshots.push({ scenario, view, width, height, ...metrics });
	if (screenshot) {
		await page.screenshot({
			path: path.join(output, label, `${scenario}-${view}-${width}x${height}.png`),
			fullPage: true,
			animations: "disabled",
		});
	}
}

try {
	const { context, page } = await makeContext("normal", { width: 1536, height: 900 });
	for (const width of widths) {
		for (const view of views) {
			await snapshot(page, "normal", view, width, 900, [320, 390, 768, 1280, 1536, 1920].includes(width));
		}
	}
	for (const view of views) await snapshot(page, "normal", view, 844, 390, true);
	await page.goto(`${baseUrl}/__review/logout`);
	await page.waitForSelector(".beta-landing");
	for (const width of widths) {
		await page.setViewportSize({ width, height: 900 });
		await settleLayout(page);
		snapshots.push({ scenario: "signed-out", view: "landing", width, height: 900, ...await measure(page) });
		if ([320, 768, 1536].includes(width)) {
			await page.screenshot({ path: path.join(output, label, `landing-${width}.png`), fullPage: true });
		}
	}
	await context.close();
	for (const [scenario, scenarioWidths] of quick ? [] : [["long", [320, 768, 1280, 1536]], ["empty", [390, 1440]]]) {
		const { context: sampleContext, page: samplePage } = await makeContext(scenario, { width: 1536, height: 900 });
		for (const width of scenarioWidths) {
			for (const view of views) await snapshot(samplePage, scenario, view, width, 900, width === scenarioWidths[0]);
		}
		await sampleContext.close();
	}
} catch (error) {
	await writeFile(path.join(output, `${label}-failure-measurements.json`), JSON.stringify({
		snapshots, ...monitor, failure: error.message,
	}, null, 2));
	throw error;
} finally {
	await browser.close();
}

const defects = snapshots.filter(hasDefects);
await writeFile(path.join(output, `${label}-measurements.json`), JSON.stringify({
	baseUrl, label, snapshots, defects, ...monitor,
}, null, 2));
console.log(`${label}: ${snapshots.length} viewports, ${defects.length} layouts with measured defects.`);
for (const entry of defects) {
	console.log(`${entry.scenario} ${entry.view} ${entry.width}px: page overflow ${entry.pageOverflow}px; panels ${entry.overflowPanels.slice(0, 3).map((panel) => `${panel.element} +${panel.extra}px`).join(", ")}; ${entry.heroClipping.length} clipped heroes; ${entry.overlappingControls.length} control collisions; ${entry.searchIcons.filter((icon) => !icon.aligned).length} search icons; ${entry.misalignedMetricIcons.length} metric icons; ${entry.obscuredJourneyControls.length} obscured journey controls`);
}
if (!baseline) {
	assert.equal(defects.length, 0, "Layout defects remain; inspect the recorded viewport measurements.");
	assertCleanMonitor(monitor);
}
