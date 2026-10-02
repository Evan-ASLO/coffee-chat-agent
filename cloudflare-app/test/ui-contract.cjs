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
	const journey = index.indexOf('src="/journey-progress.js');
	const analytics = index.indexOf('src="/analytics-ui.js');
	const app = index.indexOf('src="/app.js');
	assert.ok(renderer >= 0);
	assert.ok(journey > renderer);
	assert.ok(analytics > journey);
	assert.ok(app > renderer);
	assert.ok(app > analytics);
});

test("preserves Internship & Coffee Chat as the product brand", () => {
	const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	const privacy = fs.readFileSync(
		path.join(root, "public", "privacy.html"),
		"utf8",
	);
	const terms = fs.readFileSync(path.join(root, "public", "terms.html"), "utf8");
	assert.match(index, /<title>Internship &(?:amp;)? Coffee Chat \| Career platform<\/title>/);
	assert.match(
		index,
		/content="Internship &(?:amp;)? Coffee Chat helps you explore jobs/,
	);
	assert.match(app, /<strong>Internship & Coffee Chat<\/strong>/);
	assert.match(app, /aria-label="Internship & Coffee Chat home"/);
	assert.match(app, /<span class="brand-mark" aria-hidden="true">CC<\/span>/);
	assert.match(app, /<p class="eyebrow">Career Journey<\/p>/);
	assert.match(privacy, /Privacy Policy \| Internship &(?:amp;)? Coffee Chat/);
	assert.match(terms, /Terms of Service \| Internship &(?:amp;)? Coffee Chat/);
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
	assert.match(styles, /\.jobs-layout\s*\{[^}]*grid-template-columns:/s);
	assert.match(
		styles,
		/@media \(max-width: 540px\)[\s\S]*\.job-filters\s*\{[\s\S]*grid-template-columns:\s*1fr;/,
	);
	assert.match(app, /data-job-layout="grid"/);
	assert.match(app, /data-job-layout="list"/);
	assert.match(app, /data-job-mode="saved"/);
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
	assert.match(app, /search tools may incur (?:provider )?charges/i);
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

test("uses the six-view product navigation without duplicate saved or admin tabs", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	const styles = fs.readFileSync(
		path.join(root, "public", "styles.css"),
		"utf8",
	);
	for (const view of [
		"home",
		"jobs",
		"applications",
		"networking",
		"analytics",
		"settings",
	]) {
		assert.match(app, new RegExp(`\\["${view}"`));
	}
	assert.doesNotMatch(app, /\["saved",\s*"Saved"/);
	assert.doesNotMatch(app, /\["beta-access"/);
	assert.match(app, /renderBetaAccessAdmin\(\)/);
	assert.match(app, /class="primary-nav"/);
	assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.sidebar\s*\{[\s\S]*position:\s*fixed;/);
	assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.sidebar\s*\{[\s\S]*visibility:\s*hidden;/);
	assert.match(styles, /\.nav-open \.sidebar\s*\{[^}]*transform:\s*translateX\(0\)/s);
	assert.match(styles, /\.nav-open \.sidebar\s*\{[^}]*visibility:\s*visible/s);
	assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.nav-scrim\s*\{[\s\S]*visibility:\s*hidden;/);
	assert.match(styles, /\.nav-open \.nav-scrim\s*\{[^}]*visibility:\s*visible/s);
});

test("renders real application, networking, analytics, and settings surfaces", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	assert.match(app, /function renderApplications\(/);
	assert.match(app, /id="application-search"/);
	assert.match(app, /data-save-job-notes/);
	assert.match(app, /Next step or notes/);
	assert.match(app, /Strong match/);
	assert.match(app, /Broader match/);
	assert.match(app, /LinkedIn profile/);
	assert.match(app, /Public profile/);
	assert.match(app, /function renderAnalytics\(/);
	assert.match(app, /No synthetic growth rates or conversion claims/);
	assert.match(app, /renderActivityHeatmap/);
	assert.match(app, /id="settings-form"/);
	assert.match(app, /id="legacy-import-form"/);
	assert.match(app, /id="resume-form"/);
	assert.match(app, /id="people-search-fallback-provider"/);
	assert.match(app, /secretRow\("TAVILY"/);
	assert.match(app, /secretRow\("HUNTER"/);
	assert.doesNotMatch(app, /Upcoming coffee chats/i);
	assert.doesNotMatch(app, /Completed coffee chats/i);
	assert.doesNotMatch(app, /<blockquote/i);
});

test("self-hosts pinned Three.js with fallback, lifecycle, and mirrored controls", () => {
	const packageJson = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	);
	const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	const scene = fs.readFileSync(
		path.join(root, "public", "journey-scene.js"),
		"utf8",
	);
	assert.equal(packageJson.dependencies.three, "0.180.0");
	assert.ok(
		fs.existsSync(path.join(root, "public", "vendor", "three.module.min.js")),
	);
	assert.ok(
		fs.existsSync(path.join(root, "public", "vendor", "three.core.min.js")),
	);
	assert.ok(
		fs.existsSync(path.join(root, "public", "vendor", "three.LICENSE.txt")),
	);
	assert.match(
		fs.readFileSync(
			path.join(root, "public", "vendor", "three.RECEIPT.txt"),
			"utf8",
		),
		/Version: 0\.180\.0/,
	);
	assert.match(scene, /from "\.\/vendor\/three\.module\.min\.js"/);
	assert.match(scene, /IntersectionObserver/);
	assert.match(scene, /ResizeObserver/);
	assert.match(scene, /visibilitychange/);
	assert.match(scene, /prefers-reduced-motion: reduce/);
	assert.match(scene, /cancelAnimationFrame/);
	assert.match(scene, /forceContextLoss/);
	assert.match(scene, /geometry\?\.dispose/);
	assert.match(app, /renderJourneyFallback/);
	assert.match(
		app,
		/function renderHome\([\s\S]*<section class="home-hero">[\s\S]*id="journey-canvas"[\s\S]*<section class="journey-dock"/,
	);
	assert.doesNotMatch(app, /class="journey-layout"/);
	assert.doesNotMatch(app, /class="journey-card"/);
	assert.match(
		fs.readFileSync(path.join(root, "public", "styles.css"), "utf8"),
		/\.journey-fallback\[hidden\]\s*\{[^}]*display:\s*none/s,
	);
	for (const area of [
		"networking",
		"applications",
		"saved",
		"progress",
		"journey",
	]) {
		assert.match(app, new RegExp(`journeyControl\\("${area}"`));
	}
	assert.match(index, /<noscript>/);
	assert.doesNotMatch(index, /cdn|unpkg|jsdelivr/i);
});

test("keeps beta access and legal links on the redesigned landing", () => {
	const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
	assert.match(app, /<strong>Internship & Coffee Chat<\/strong>/);
	assert.match(app, /Request access/);
	assert.match(app, /\/auth\/google\/request/);
	assert.match(app, /Privacy Policy/);
	assert.match(app, /Terms of Service/);
	assert.match(app, /betaLandingRequired\(\)/);
	assert.match(app, /Private Toronto beta/);
});
