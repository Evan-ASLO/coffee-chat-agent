const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ui = require("../public/job-source.js");

const root = path.resolve(__dirname, "..");

test("renders compliant Adzuna attribution", () => {
	const html = ui.attributionHtml("adzuna");
	assert.equal(ui.sourceLabel("ADZUNA"), "Adzuna");
	assert.match(html, />Jobs</);
	assert.match(html, /href="https:\/\/www\.adzuna\.ca\/"/);
	assert.match(html, /src="\/adzuna_logo\.png"/);
	assert.match(html, /aria-label="Jobs by Adzuna"/);
	assert.match(html, /alt="Adzuna"/);
	assert.match(html, /width="87"/);
	assert.match(html, /height="23"/);
	assert.equal(ui.attributionHtml("workday"), "");
});

test("self-hosts the official PNG and enforces the minimum badge size", () => {
	const png = fs.readFileSync(path.join(root, "public", "adzuna_logo.png"));
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(png.readUInt32BE(16), 256);
	assert.equal(png.readUInt32BE(20), 68);

	const styles = fs.readFileSync(
		path.join(root, "public", "styles.css"),
		"utf8",
	);
	assert.match(styles, /\.adzuna-attribution\s*\{[^}]*min-width:\s*116px;/s);
	assert.match(styles, /\.adzuna-attribution\s*\{[^}]*min-height:\s*23px;/s);
});

test("loads the attribution renderer before the SPA", () => {
	const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
	const renderer = index.indexOf('src="/job-source.js');
	const app = index.indexOf('src="/app.js');
	assert.ok(renderer >= 0);
	assert.ok(app > renderer);
});

test("renders responsive structured job filter controls", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	const styles = fs.readFileSync(
		path.join(root, "public", "styles.css"),
		"utf8",
	);
	for (const id of [
		"job-industry",
		"job-length",
		"job-term",
		"job-category",
	]) {
		assert.match(app, new RegExp(`id="${id}"`));
	}
	assert.match(app, /Career track/);
	assert.match(app, /loadJobQueryFromUrl\(\)/);
	assert.match(app, /syncJobQueryToUrl\(\)/);
	assert.match(app, /job\.industry/);
	assert.match(app, /job\.lengthLabel/);
	assert.match(app, /job\.term\?\.label/);
	assert.match(styles, /\.job-filters\s*\{[^}]*grid-template-columns:/s);
	assert.match(
		styles,
		/@media \(max-width: 560px\)[\s\S]*\.job-filters,[\s\S]*grid-template-columns:\s*1fr;/,
	);
});

test("auto-starts job discovery with explicit progress and recovery states", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	const styles = fs.readFileSync(
		path.join(root, "public", "styles.css"),
		"utf8",
	);
	assert.match(
		app,
		/async function beginJobNetworking[\s\S]*await executeDiscovery\(state\.networkingCriteria\)/,
	);
	assert.match(app, /status:\s*"running"/);
	assert.match(app, /Searching public professional profiles/);
	assert.match(app, /No people found/);
	assert.match(app, /retry-job-discovery/);
	assert.match(app, /summary\.providerReturned === 0/);
	assert.match(app, /summary\.duplicates > 0/);
	assert.match(app, /summary\.insufficientMatchRejected > 0/);
	assert.match(app, /did not match both the requested company/);
	assert.match(app, /summary\.strongAccepted/);
	assert.match(app, /summary\.broaderAccepted/);
	assert.match(app, /Broader company match — review role relevance/);
	assert.match(app, /usable public professional profiles/);
	assert.match(app, /professionalBioProviderReturned/);
	assert.match(app, /showToast\(\s*`Found \$\{summary\.inserted\}/);
	assert.match(app, /person\.linkedinUrl \|\| person\.sourceUrl/);
	assert.match(app, /LinkedIn profile/);
	assert.match(app, /Public profile/);
	assert.match(styles, /\.inline-spinner\s*\{/);
	assert.match(styles, /\.discovery-state\s*\{/);
});

test("renders one explicit cited-search provider selector and safe statuses", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	assert.match(app, /id="people-search-fallback-provider"/);
	assert.match(app, /value="NONE"/);
	assert.match(app, /value="GEMINI"/);
	assert.match(app, /value="OPENAI"/);
	assert.match(app, /value="ANTHROPIC"/);
	assert.match(app, /Web-search tools may incur provider charges/);
	assert.match(app, /peopleSearchFallbackProvider/);
	assert.match(app, /fallbackStatus === "DISABLED"/);
	assert.match(app, /fallbackStatus === "MISSING_KEY"/);
	assert.match(app, /fallbackStatus === "RATE_LIMITED"/);
	assert.match(app, /fallbackStatus === "AUTH"/);
	assert.match(app, /fallbackStatus === "BAD_REQUEST"/);
	assert.match(app, /fallbackStatus === "UNSUPPORTED"/);
	assert.match(app, /fallbackStatus === "TIMEOUT"/);
	assert.match(app, /fallbackStatus === "MALFORMED_RESPONSE"/);
	assert.match(app, /fallbackStatus === "PROVIDER_ERROR"/);
	assert.match(
		app,
		/Gemini Search quota or rate limit was reached\. Check the API project's billing and Search grounding quota/,
	);
	assert.match(
		app,
		/discoverySuccessMessage[\s\S]*discoveryFallbackFailureMessage\(summary\)/,
	);
	assert.doesNotMatch(app, /raw model/i);
});
