import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const evidence = process.env.TUTORIAL_EVIDENCE_DIR || join(root, ".tutorial-preview", "evidence");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".test-browsers");

export default defineConfig({
	testDir: "./test/browser",
	testMatch: "**/*.e2e.mjs",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90000,
	expect: { timeout: 10000 },
	outputDir: join(evidence, "browser-artifacts"),
	reporter: [["list"], ["json", { outputFile: join(evidence, "browser-results.json") }]],
	use: {
		baseURL: process.env.TUTORIAL_PREVIEW_URL || "http://127.0.0.1:8803",
		channel: process.env.LAYOUT_BROWSER_CHANNEL || "msedge",
		viewport: { width: 1440, height: 1000 },
		reducedMotion: "reduce",
		trace: "off",
		video: "off",
		screenshot: "off",
	},
});
