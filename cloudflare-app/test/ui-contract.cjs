const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const jobSource = require("../public/job-source.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("renders compliant Adzuna attribution", () => {
	const html = jobSource.attributionHtml("adzuna");
	assert.equal(jobSource.sourceLabel("ADZUNA"), "Adzuna");
	assert.match(html, /href="https:\/\/www\.adzuna\.ca\/"/);
	assert.match(html, /src="\/adzuna_logo\.png"/);
	assert.match(html, /aria-label="Jobs by Adzuna"/);
	assert.match(html, /width="87"/);
	assert.match(html, /height="23"/);
	assert.equal(jobSource.attributionHtml("workday"), "");
});

test("self-hosts required attribution and reference-derived art crops", () => {
	const png = fs.readFileSync(path.join(root, "public", "adzuna_logo.png"));
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const styles = read("public/styles.css");
	assert.match(styles, /\.adzuna-attribution\s*\{[^}]*min-width:\s*116px;/s);
	assert.match(styles, /\.adzuna-attribution\s*\{[^}]*min-height:\s*23px;/s);

	const receipt = JSON.parse(read("public/art/reference-art-receipt.json"));
	for (const asset of [
		"home-hero.webp",
		"home-coffee.webp",
		"jobs-hero.webp",
		"applications-hero.webp",
		"networking-hero.webp",
		"analytics-hero.webp",
		"settings-hero.webp",
	]) {
		assert.ok(fs.existsSync(path.join(root, "public", "art", asset)));
		assert.ok(receipt[asset].width < 1536 || receipt[asset].height < 834);
		assert.ok(receipt[asset].bytes < 50000);
	}
	assert.equal(fs.existsSync(path.join(root, "public", "art", "jobs.png")), false);
	assert.equal(
		fs.existsSync(path.join(root, "public", "art", "applications.png")),
		false,
	);
});

test("loads local helpers and the SPA in dependency order", () => {
	const index = read("public/index.html");
	const source = index.indexOf('src="/job-source.js');
	const journey = index.indexOf('src="/journey-progress.js');
	const analytics = index.indexOf('src="/analytics-ui.js');
	const app = index.indexOf('src="/app.js');
	assert.ok(source >= 0);
	assert.ok(journey > source);
	assert.ok(analytics > journey);
	assert.ok(app > analytics);
	assert.match(index, /Internship & Coffee Chat \| Toronto career workspace/);
	assert.match(index, /<noscript>/);
	assert.doesNotMatch(index, /cdn|unpkg|jsdelivr/i);
});

test("matches the compact horizontal product navigation contract", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	for (const view of [
		"home",
		"jobs",
		"applications",
		"networking",
		"analytics",
		"settings",
	]) {
		assert.match(app, new RegExp(`\\["${view}",\\s*"`, "m"));
	}
	assert.match(app, /class="top-nav"/);
	assert.match(app, /<strong>Internship & Coffee Chat<\/strong>/);
	assert.match(app, /class="dark-side-rail"/);
	assert.match(styles, /\.app-frame\.view-analytics,/);
	assert.match(styles, /\.app-frame\.view-settings\s*\{[^}]*--content-width:/s);
	assert.match(styles, /#main-content\s*\{[^}]*width:\s*min\(var\(--content-width\), 100%\)/s);
	assert.match(
		styles,
		/@media \(max-width: 1100px\)[\s\S]*\.top-nav\s*\{[\s\S]*position:\s*fixed;/,
	);
	assert.match(styles, /\.nav-open \.top-nav\s*\{[^}]*visibility:\s*visible/s);
});

test("reflows shared controls without hiding filters or losing navigation focus", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	assert.match(app, /function setMobileNavOpen/);
	assert.match(app, /function handleNavigationKeydown/);
	assert.match(app, /event\.key === "Escape"/);
	assert.match(app, /element\.inert = state\.mobileNavOpen/);
	assert.match(app, /id="mobile-nav-close"/);
	assert.doesNotMatch(app, /state\.mobileNavOpen = !state\.mobileNavOpen;[\s\n]*render\(\)/);
	assert.match(styles, /@container \(max-width: 920px\)/);
	assert.doesNotMatch(styles, /label:nth-of-type\(\d+\)\s*\{\s*display:\s*none/);
	assert.match(styles, /\.reference-metric div > strong,\s*\.reference-metric div > span/);
	assert.match(styles, /\.job-card-heading\s*\{[^}]*minmax\(0, 1fr\) auto;/s);
	assert.match(styles, /@media \(pointer: coarse\), \(max-width: 700px\)/);
	assert.match(styles, /--touch-target-size:\s*44px/);
	assert.match(styles, /\.settings-card-heading button\s*\{[^}]*min-height:\s*max\(34px, var\(--touch-target-size/s);
	assert.match(read("public/index.html"), /viewport-fit=cover/);
});

test("bounds accessible tables and native dialogs instead of clipping their actions", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	assert.match(app, /class="responsive-table-wrap" tabindex="0" role="region"/);
	assert.match(app, /<th scope="col">/);
	assert.match(app, /aria-labelledby="application-dialog-title"/);
	assert.match(app, /aria-labelledby="discovery-title"/);
	assert.match(app, /aria-labelledby="profile-settings-title"/);
	assert.match(app, /async function saveSettings\(event\)\s*\{\s*if \(event\.submitter\?\.value === "cancel"\) return;/);
	assert.match(read("public/index.html"), /aria-labelledby="draft-name"/);
	assert.match(styles, /\.responsive-table-wrap\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;/s);
	assert.match(styles, /max-height:\s*calc\(100dvh - env\(safe-area-inset-top\)/);
	assert.doesNotMatch(styles, /\.data-table thead\s*\{\s*display:\s*none/);
	assert.doesNotMatch(styles, /\.applications-layout \.tracker-table-panel\s*\{[^}]*height:\s*451px/s);
});

test("keeps journey controls outside the rendered world and handles direct taps", () => {
	const app = read("public/app.js");
	const scene = read("public/journey-scene.js");
	const styles = read("public/styles.css");
	assert.match(app, /<\/div>\s*<div class="home-journey-milestones"/);
	assert.match(app, /journeyMediaConditions/);
	assert.match(app, /mountToken !== journeyMountToken/);
	assert.match(scene, /function handleClick\(event\)[\s\S]*const area = areaAtPointer\(event\)/);
	assert.match(styles, /\.home-journey-milestones\s*\{\s*display:\s*grid/);
	assert.doesNotMatch(styles, /\.home-journey-milestones button:nth-child/);
});

test("renders the native-density Jobs composition and every real filter", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	for (const id of [
		"job-q",
		"job-company",
		"job-location",
		"job-region",
		"job-category",
		"job-industry",
		"job-length",
		"job-term",
	]) {
		assert.match(app, new RegExp(`id="${id}"`));
	}
	assert.match(app, /class="job-search-strip"/);
	assert.match(app, /class="jobs-reference-layout/);
	assert.match(app, /class="jobs-activity-rail"/);
	assert.match(app, /data-job-layout="grid"/);
	assert.match(app, /data-job-layout="list"/);
	assert.match(app, /class="job-more"/);
	assert.match(app, /data-job-status/);
	assert.match(app, /data-job-network/);
	assert.match(styles, /\.job-cards\.grid-view\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
	assert.match(styles, /\.jobs-reference-layout\s*\{[^}]*208px;/s);
});

test("uses compact Applications table editing without invented reminders", () => {
	const app = read("public/app.js");
	assert.match(app, /class="data-table applications-table"/);
	assert.match(app, /id="application-dialog"/);
	assert.match(app, /id="application-dialog-stage"/);
	assert.match(app, /id="application-dialog-notes"/);
	assert.match(app, /data-application-edit/);
	assert.match(app, /Next-step notes/);
	assert.match(app, /Dates shown are recorded update dates/);
	assert.match(app, /id="legacy-import-details"/);
	assert.doesNotMatch(app, /upcoming interview|reminder due|next interview/i);
});

test("keeps networking approval-first in a compact table and discovery dialog", () => {
	const app = read("public/app.js");
	assert.match(app, /class="data-table networking-table"/);
	assert.match(app, /id="discovery-dialog"/);
	assert.match(app, /Search never prepares or sends outreach automatically/);
	assert.match(app, /data-prepare/);
	assert.match(app, /data-review/);
	assert.match(app, /data-regenerate/);
	assert.match(app, /Approve & prepare/);
	assert.match(app, /Broader company/);
	assert.match(app, /Email needed before send/);
	assert.match(app, /LinkedIn profile/);
	assert.match(app, /Public profile/);
	assert.match(app, /Uncertain sends are locked/);
	assert.doesNotMatch(app, /Upcoming coffee chats|Coffee chats completed/i);
});

test("preserves discovery recovery and cited-search provider safety", () => {
	const app = read("public/app.js");
	assert.match(
		app,
		/async function beginJobNetworking[\s\S]*await executeDiscovery\(state\.networkingCriteria\)/,
	);
	assert.match(app, /Searching public professional profiles/);
	assert.match(app, /retry-job-discovery/);
	assert.match(app, /summary\.strongAccepted/);
	assert.match(app, /summary\.broaderAccepted/);
	assert.match(app, /fallbackStatus === "RATE_LIMITED"/);
	assert.match(app, /fallbackStatus === "AUTH"/);
	assert.match(app, /fallbackStatus === "UNSUPPORTED"/);
	assert.match(app, /Gemini Search quota or rate limit was reached/);
	assert.match(app, /id="people-search-fallback-provider"/);
	assert.match(app, /Provider web-search tools may incur charges/);
	assert.doesNotMatch(app, /raw model/i);
});

function discoveryClient(summary) {
	const source = read("public/app.js");
	const client = {
		state: { networkingSearch: { status: "idle" } },
		toasts: [],
		api: async (url) => {
			if (url === "/api/discovery") return { summary };
			if (url === "/api/session") return {};
			throw new Error(`Unexpected API path: ${url}`);
		},
		jobOutreachLinkingEnabled: () => false,
		render: () => {},
		document: { getElementById: () => null },
		loadJobData: async () => {},
		loadBetaAdminData: async () => {},
		loadAnalyticsData: async () => {},
		showToast: (message) => client.toasts.push(message),
		escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
	};
	vm.runInNewContext(
		source.slice(source.indexOf("async function executeDiscovery("), source.indexOf("\nfunction readDiscoveryCriteria(")) +
		source.slice(source.indexOf("function discoverySearchStatus("), source.indexOf("\nasync function prepare(")) +
		source.slice(source.indexOf("function renderNetworkingSearchState("), source.indexOf("\nfunction renderApprove(")),
		client,
	);
	return client;
}

test("discovery renders failed, partial, duplicate, and completed outcomes honestly", async () => {
	for (const fixture of [
		{ inserted: 0, accepted: 0, primaryAccepted: 0, fallbackAccepted: 0, duplicates: 0, status: "error" },
		{ inserted: 2, accepted: 2, primaryAccepted: 1, fallbackAccepted: 1, duplicates: 0, status: "partial" },
		{ inserted: 0, accepted: 1, primaryAccepted: 1, fallbackAccepted: 0, duplicates: 1, status: "partial" },
		{ inserted: 0, accepted: 0, duplicates: 0, fallbackStatus: "SUCCESS", fallbackReason: null, status: "empty" },
		{ inserted: 1, accepted: 1, duplicates: 0, fallbackStatus: "SUCCESS", fallbackReason: null, status: "success" },
	]) {
		const summary = {
			fallbackProvider: "ANTHROPIC", fallbackStatus: "SEARCH_LIMITED",
			fallbackReason: "max_uses_exceeded", fallbackHttpStatus: null,
			providerReturned: 0, ...fixture,
		};
		const client = discoveryClient(summary);
		await client.executeDiscovery({ count: 3 });
		assert.equal(client.state.networkingSearch.status, fixture.status);
		const html = client.renderNetworkingSearchState();
		assert.doesNotMatch(html, /No people found|Verify the configured model/);
		if (summary.fallbackStatus === "SEARCH_LIMITED") {
			assert.match(html, /one-search limit, not an API quota or key failure/);
			assert.match(html, /notice warning/);
			assert.match(html, /retry-job-discovery/);
			assert.match(html, fixture.status === "error" ? /Search could not be completed/ : /Partial results - search incomplete/);
			assert.match(html, fixture.primaryAccepted ? /Accepted Tavily profiles were preserved/ : /No usable Tavily profiles were available/);
		}
		if (fixture.inserted > 0 && fixture.status === "partial") {
			assert.match(client.toasts[0], /^Partial search:/);
			assert.match(html, /Only cited profiles that passed validation were retained/);
		}
		if (fixture.duplicates) assert.match(html, /already tracked/);
		if (fixture.status === "empty") assert.match(html, /No new people added/);
		if (fixture.status === "success") assert.match(html, /People found/);
	}
});

test("discovery distinguishes safe tool reasons from HTTP and account errors", () => {
	const client = discoveryClient({});
	for (const [status, reason, http, expected] of [
		["BAD_REQUEST", "invalid_tool_input", null, /query input was invalid/],
		["BAD_REQUEST", "query_too_long", null, /search-tool query was too long/],
		["BAD_REQUEST", "request_too_large", null, /search-tool request was too large/],
		["BAD_REQUEST", null, 400, /API request \(HTTP 400\)/],
		["BAD_REQUEST", null, 422, /API request \(HTTP 422\)/],
		["BAD_REQUEST", null, null, /diagnostic does not identify which failed/],
		["RATE_LIMITED", "too_many_requests", null, /search tool was rate limited/],
		["RATE_LIMITED", null, 429, /quota or rate limit was reached/],
		["AUTH", null, 401, /denied API access/],
		["UNSUPPORTED", null, 400, /platform\.claude\.com\/settings\/capabilities/],
		["TIMEOUT", null, null, /timed out/],
		["MALFORMED_RESPONSE", null, null, /unusable cited-profile response/],
		["PROVIDER_ERROR", "unavailable", null, /search tool was unavailable/],
		["PROVIDER_ERROR", "PRIVATE PROMPT SECRET-DO-NOT-STORE", null, /could not complete the cited search/],
		["MISSING_KEY", null, null, /no API key is configured/],
	]) {
		const summary = {
			fallbackProvider: "ANTHROPIC", fallbackStatus: status,
			fallbackReason: reason, fallbackHttpStatus: http, inserted: 0,
		};
		const message = client.discoveryFallbackFailureMessage(summary);
		assert.match(message, expected);
		assert.doesNotMatch(message, /PRIVATE PROMPT|SECRET-DO-NOT-STORE|Verify the configured model/);
		assert.equal(client.discoverySearchStatus(summary), "error");
		assert.equal(client.discoverySearchStatus({ ...summary, inserted: 1 }), "partial");
	}
});

test("renders dense honest Analytics geometry and bounded route use", () => {
	const app = read("public/app.js");
	const worker = read("src/index.ts");
	const analytics = read("src/lib/analytics.ts");
	assert.match(worker, /app\.get\("\/api\/analytics", requireUser/);
	assert.match(analytics, /WHERE user_id = \?/);
	assert.match(analytics, /LIMIT 30/);
	assert.match(app, /class="analytics-reference-grid"/);
	assert.match(app, /Application Funnel/);
	assert.match(app, /Recorded Activity Over Time/);
	assert.match(app, /Application Status/);
	assert.match(app, /Top Companies/);
	assert.match(app, /Networking Impact/);
	assert.match(app, /Activity Heatmap/);
	assert.match(app, /No synthetic growth, conversion, chat, or reminder claims/);
	assert.doesNotMatch(app, /\+\s*\d+%|conversion rate:\s*\d/i);
});

test("Settings exposes only real integrations, privacy, and preferences", () => {
	const app = read("public/app.js");
	assert.match(app, /Account Information/);
	assert.match(app, /Provider credentials/);
	assert.match(app, /id="resume-form"/);
	assert.match(app, /id="legacy-import-form"/);
	assert.match(app, /id="settings-form"/);
	assert.match(app, /id="reply-sync-enabled"/);
	assert.match(app, /secretRow\("TAVILY"/);
	assert.match(app, /secretRow\("HUNTER"/);
	assert.match(app, /Google Gmail & Sheets/);
	assert.match(app, /no in-app deletion endpoint exists/i);
	assert.doesNotMatch(app, /LinkedIn\s*<\/|Outlook\s*<\/|Email notifications|Application reminders/);
});

test("self-hosts pinned Three.js with full lifecycle and accessible fallback", () => {
	const packageJson = JSON.parse(read("package.json"));
	const app = read("public/app.js");
	const scene = read("public/journey-scene.js");
	const styles = read("public/styles.css");
	assert.equal(packageJson.dependencies.three, "0.180.0");
	for (const file of [
		"three.module.min.js",
		"three.core.min.js",
		"three.LICENSE.txt",
		"three.RECEIPT.txt",
	]) {
		assert.ok(fs.existsSync(path.join(root, "public", "vendor", file)));
	}
	assert.match(scene, /from "\.\/vendor\/three\.module\.min\.js"/);
	assert.match(scene, /createCareerLandscape/);
	assert.match(scene, /IntersectionObserver/);
	assert.match(scene, /ResizeObserver/);
	assert.match(scene, /visibilitychange/);
	assert.match(scene, /cancelAnimationFrame/);
	assert.match(scene, /forceContextLoss/);
	assert.match(scene, /geometry\?\.dispose/);
	assert.match(app, /renderJourneyFallback/);
	assert.match(styles, /\.journey-fallback\[hidden\]\s*\{[^}]*display:\s*none/s);
	for (const area of [
		"networking",
		"applications",
		"saved",
		"progress",
	]) {
		assert.match(app, new RegExp(`homeJourneyControl\\("${area}"`));
	}
	assert.match(app, /data-journey-target="journey"/);
});

test("matches the new Home opportunity reference composition", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	assert.match(app, /Find your next<br \/><span>opportunity\.<\/span>/);
	assert.match(app, /Coffee today\.<br \/>Opportunities tomorrow\./);
	assert.match(app, /class="home-reference-stats"/);
	assert.match(app, /id="home-job-search-form"/);
	assert.match(app, /Good<br \/>People<br \/>Great<br \/>Opportunities/);
	assert.match(app, /Recent roles/);
	assert.match(app, /class="home-recent-grid"/);
	assert.match(app, /class="home-journey-panel"/);
	assert.match(app, /Your journey/);
	assert.match(styles, /url\("\/art\/home-hero\.webp"\)/);
	assert.match(styles, /\.home-reference-lower\s*\{[^}]*grid-template-columns:/s);
	assert.doesNotMatch(app, /Welcome back,/);
});

test("retains beta access and legal paths without exposing job data", () => {
	const app = read("public/app.js");
	assert.match(app, /\/auth\/google\/request/);
	assert.match(app, /Request access/);
	assert.match(app, /Privacy Policy/);
	assert.match(app, /Terms of Service/);
	assert.match(app, /betaLandingRequired\(\)/);
	assert.match(app, /Private Toronto beta/);
});
