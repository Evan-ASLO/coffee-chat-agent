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

test("matches the warm job-first navigation and account setup contract", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	for (const [view, label] of [["jobs", "Find jobs"], ["applications", "My jobs"], ["networking", "People"]]) {
		assert.match(app, new RegExp(`\\["${view}",\\s*"${label}"`, "m"));
	}
	assert.match(app, /class="top-nav"/);
	assert.match(app, /<strong>Internship & Coffee Chat<small>/);
	assert.match(app, /class="account-menu"/);
	assert.match(app, /data-nav="settings">Setup & profile/);
	assert.match(app, /data-nav="analytics">Analytics/);
	assert.doesNotMatch(app, /class="dark-side-rail"/);
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
	assert.match(app, /<div class="home-journey-milestones"/);
	assert.match(app, /window\.JobFirstUI\.scene\(\)/);
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
	const openJob = app.slice(app.indexOf("async function beginJobNetworking"), app.indexOf("async function findPeople"));
	assert.match(openJob, /await loadNetworkingContacts\(\)/);
	assert.doesNotMatch(openJob, /executeDiscovery\(/);
	assert.match(app, /addEventListener\("click", openDiscoveryDialog\)/);
	assert.match(app, /I authorize up to 3 Anthropic web searches/);
	assert.match(app, /People to contact/);
	assert.match(app, /Reason & public evidence/);
	assert.match(app, /Unconfirmed fits - not part of the three ranked priorities/);
	assert.match(read("public/styles.css"), /\.discovery-state > div > strong,\s*\.discovery-state > div > span\s*\{\s*display: block;/);
	assert.match(app, /searching public professional profiles/);
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
		state: {
			session: { authenticated: true, user: { id: "fake-user" }, prospects: [],
				settings: { peopleSearchFallbackProvider: "ANTHROPIC", anthropicModel: "saved-model" },
				credentials: { TAVILY: { configured: true }, ANTHROPIC: { configured: true } } },
			networkingSearch: { status: "idle", mode: "TAVILY" }, networkingJob: null,
			tavilySearch: null, tab: "networking",
			networkingContacts: { status: "idle", prospects: [], request: 0 },
		},
		toasts: [],
		api: async (url, options) => {
			if (url === "/api/discovery") return { userId: "fake-user", prospects: [], summary: { mode: options.body.mode, ...summary } };
			if (url === "/api/session") return client.state.session;
			if (url === "/api/analytics") return {};
			throw new Error(`Unexpected API path: ${url}`);
		},
		jobOutreachLinkingEnabled: () => false,
		render: () => {},
		document: { getElementById: () => null },
		dialog: { open: false },
		loadJobData: async () => {},
		loadBetaAdminData: async () => {},
		loadAnalyticsData: async () => {},
		fetchJobs: async () => ({}),
		fetchTrackedJobs: async () => ({}),
		syncViewToUrl: () => {},
		PRIMARY_VIEWS: ["home", "jobs", "applications", "networking", "analytics", "settings"],
		navigationRestore: 0,
		requestAnimationFrame: (callback) => callback(),
		window: { scrollTo: () => {}, JobFirstUI: { routeView: (view) => view } },
		AbortController,
		structuredClone,
		showToast: (message) => client.toasts.push(message),
		escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
	};
	vm.runInNewContext(
		source.slice(source.indexOf("async function executeDiscovery("), source.indexOf("\nfunction readDiscoveryCriteria(")) +
		source.slice(source.indexOf("function discoverySearchStatus("), source.indexOf("\nasync function prepare(")) +
		source.slice(source.indexOf("function renderNetworkingSearchState("), source.indexOf("\nfunction renderApprove(")),
		client,
	);
	vm.runInNewContext(
		source.slice(source.indexOf("function renderSearchCosts("), source.indexOf("\nfunction networkingPeople(")) +
		source.slice(source.indexOf("async function beginJobNetworking("), source.indexOf("\nasync function findPeople(")) +
		source.slice(source.indexOf("function navigate("), source.indexOf("\nfunction syncViewToUrl(")),
		client,
	);
	vm.runInNewContext(
		source.slice(source.indexOf("function cancelPreparation("), source.indexOf("\nfunction currentProspectAction(")),
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
			mode: "AI_SUPPLEMENT", fallbackProvider: "ANTHROPIC", fallbackStatus: "SEARCH_LIMITED",
			fallbackReason: "max_uses_exceeded", fallbackHttpStatus: null,
			providerReturned: 0, ...fixture,
		};
		const client = discoveryClient(summary);
		await client.executeDiscovery({ count: 3 }, "AI_SUPPLEMENT");
		assert.equal(client.state.networkingSearch.status, fixture.status);
		const html = client.renderNetworkingSearchState() + client.renderAiDiscovery();
		assert.doesNotMatch(html, /No people found|Verify the configured model/);
		if (summary.fallbackStatus === "SEARCH_LIMITED") {
			assert.match(html, /1-search limit, not an API quota or key failure/);
			assert.match(html, /notice warning/);
			assert.match(html, /find-more-ai/);
			assert.match(html, fixture.status === "error" ? /Search could not be completed/ : /Partial results - search incomplete/);
			assert.match(html, /Existing saved contacts and Tavily results were kept/);
			assert.doesNotMatch(html, /No usable Tavily profiles were available/);
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

test("job opening and missing keys perform only an owned saved-contact read", async () => {
	const client = discoveryClient({});
	const job = { id: "a".repeat(64), title: "Software Intern", company: "Example Firm", discoveryCriteria: { count: 5 } };
	client.findJob = () => job;
	client.jobOutreachLinkingEnabled = () => true;
	client.state.session.credentials.TAVILY.configured = false;
	const calls = [];
	client.api = async (url) => {
		calls.push(url);
		assert.equal(url, `/api/jobs/${job.id}/prospects`);
		return { job, userId: "fake-user", prospects: [] };
	};
	await client.beginJobNetworking(job.id);
	assert.deepEqual(calls, [`/api/jobs/${job.id}/prospects`]);
	assert.equal(client.state.networkingJob.id, job.id);
	assert.equal(client.state.networkingContacts.status, "ready");
	await client.executeDiscovery({ count: 3, anthropicSearchMaxUses: 3 });
	assert.equal(calls.length, 1);
	assert.match(client.toasts.at(-1), /Add your Tavily key/);
});

test("both discovery modes suppress duplicate clicks and discard stale job/account/criteria/logout/navigation responses", async () => {
	for (const mode of ["TAVILY", "AI_SUPPLEMENT"]) {
	for (const stale of [false, "job", "account", "criteria", "logout", "navigation"]) {
		const client = discoveryClient({ inserted: 1, accepted: 1 });
		let resolve;
		let calls = 0;
		client.api = async (url) => {
			if (url === "/api/discovery") {
				calls++;
				return new Promise((done) => { resolve = done; });
			}
			if (url === "/api/session") return client.state.session;
			if (url === "/api/analytics") return {};
			throw new Error(`Unexpected path ${url}`);
		};
		const pending = client.executeDiscovery({ count: 3 }, mode, 3);
		await client.executeDiscovery({ count: 3 }, mode, 3);
		assert.equal(calls, 1);
		if (stale) {
			if (stale === "criteria") client.updateDiscoveryCriteria({ count: 7 });
			else if (stale === "navigation") client.navigate("jobs");
			else {
				client.clearNetworkingContext();
				if (stale === "job") client.state.networkingJob = { id: "b".repeat(64) };
				else if (stale === "logout") client.state.session = { authenticated: false };
				else client.state.session.user.id = "second-user";
			}
		}
		resolve({ userId: "fake-user", summary: { mode, inserted: 1, accepted: 1 } });
		await pending;
		assert.equal(client.state.networkingSearch.status, stale === "navigation" ? "partial" : stale ? "idle" : "success");
		assert.equal(client.state.discoveryRequest, null);
	}
	}
});

test("three-search errors name the actual request limit and keep costs beside explicit retry", () => {
	const client = discoveryClient({});
	client.state.networkingSearch = {
		status: "error", mode: "AI_SUPPLEMENT",
		message: client.discoveryFallbackFailureMessage({
			mode: "AI_SUPPLEMENT", fallbackProvider: "ANTHROPIC", fallbackStatus: "SEARCH_LIMITED", anthropicSearchMaxUses: 3,
		}),
	};
	client.state.networkingCriteria = { count: 3 };
	const html = client.renderNetworkingSearchState() + client.renderAiDiscovery();
	assert.match(html, /3-search limit, not an API quota or key failure/);
	assert.match(html, /official Anthropic pricing/);
	assert.match(html, /your own API account/);
	assert.match(html, /Retry with AI/);
	assert.doesNotMatch(html, /one-search limit|1-search limit/);
});

test("saved-contact reads discard late responses for another job or signed-in account", async () => {
	for (const changed of ["job", "account"]) {
		const client = discoveryClient({});
		client.jobOutreachLinkingEnabled = () => true;
		const firstJob = { id: "a".repeat(64), discoveryCriteria: { count: 5 } };
		client.state.networkingJob = firstJob;
		let finish;
		client.api = () => new Promise((resolve) => { finish = resolve; });
		const pending = client.loadNetworkingContacts();
		client.clearNetworkingContext();
		if (changed === "job") client.state.networkingJob = { id: "b".repeat(64) };
		else client.state.session.user.id = "second-user";
		finish({ job: firstJob, userId: "fake-user", prospects: [{ id: "old-account-contact" }] });
		await pending;
		assert.equal(client.state.networkingContacts.prospects.length, 0);
		assert.equal(client.state.networkingContacts.status, "idle");
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
			mode: "AI_SUPPLEMENT", fallbackProvider: "ANTHROPIC", fallbackStatus: status,
			fallbackReason: reason, fallbackHttpStatus: http, inserted: 0,
		};
		const message = client.discoveryFallbackFailureMessage(summary);
		assert.match(message, expected);
		assert.doesNotMatch(message, /PRIVATE PROMPT|SECRET-DO-NOT-STORE|Verify the configured model/);
		assert.equal(client.discoverySearchStatus(summary), "error");
		assert.equal(client.discoverySearchStatus({ ...summary, inserted: 1 }), "partial");
	}
});

test("Tavily outcomes ignore optional-provider problems and ordinary Retry cannot opt in to AI", async () => {
	const client = discoveryClient({
		inserted: 1, accepted: 1, fallbackProvider: "ANTHROPIC",
		fallbackStatus: "MISSING_KEY",
	});
	const calls = [];
	const api = client.api;
	client.api = async (url, options) => { calls.push({ url, body: options?.body }); return api(url, options); };
	await client.executeDiscovery({ count: 3, anthropicSearchMaxUses: 3 });
	await client.executeDiscovery(client.state.networkingCriteria);
	assert.equal(client.state.networkingSearch.status, "success");
	assert.equal(client.discoveryFallbackFailureMessage({ mode: "TAVILY", fallbackStatus: "MISSING_KEY" }), "");
	assert.deepEqual(calls.filter(({ url }) => url === "/api/discovery").map(({ body }) => [body.mode, body.anthropicSearchMaxUses]), [
		["TAVILY", 1], ["TAVILY", 1],
	]);
	assert.match(client.renderSearchCosts(), /Search and Retry use Tavily only/);
	assert.doesNotMatch(client.renderSearchCosts(), /model-token|Anthropic pricing|authorize up to 3/);
});

test("AI consent is per action, defaults back to one, and does not require a Tavily key", async () => {
	const client = discoveryClient({ inserted: 0, accepted: 0, fallbackStatus: "SUCCESS" });
	client.state.session.credentials.TAVILY.configured = false;
	const checkbox = { checked: true };
	client.document.getElementById = (id) => id === "anthropic-expanded-search" ? checkbox : null;
	const calls = [];
	const api = client.api;
	client.api = async (url, options) => { if (url === "/api/discovery") calls.push(options.body); return api(url, options); };
	await client.executeDiscovery({ count: 3 }, "AI_SUPPLEMENT", 3);
	assert.equal(checkbox.checked, false);
	await client.executeDiscovery(client.state.networkingCriteria, "AI_SUPPLEMENT");
	assert.deepEqual(calls.map((body) => [body.mode, body.anthropicSearchMaxUses]), [["AI_SUPPLEMENT", 3], ["AI_SUPPLEMENT", 1]]);
	checkbox.checked = true;
	client.updateDiscoveryCriteria({ count: 4 });
	assert.equal(checkbox.checked, false);
	checkbox.checked = true;
	client.navigate("settings");
	assert.equal(checkbox.checked, false);
	checkbox.checked = true;
	client.clearNetworkingContext();
	assert.equal(checkbox.checked, false);
});

test("AI failure/empty/duplicates and partial refreshes keep existing owned contacts in both entry surfaces", async () => {
	for (const jobLinked of [false, true]) {
		for (const outcome of ["failed", "empty", "duplicate", "partial", "added"]) {
			const client = discoveryClient({});
			const job = { id: "a".repeat(64), discoveryCriteria: { count: 3 } };
			const old = { id: "old", userId: "fake-user", fullName: "Saved Tavily", linkedJobs: [{ id: job.id }], discoveryProvider: "TAVILY" };
			const added = { id: "new", userId: "fake-user", fullName: "New cited AI", linkedJobs: [{ id: job.id }], discoveryProvider: "ANTHROPIC_GROUNDED" };
			client.state.session.prospects = [old];
			if (jobLinked) {
				client.jobOutreachLinkingEnabled = () => true;
				client.state.networkingJob = job;
				client.state.networkingContacts = { status: "ready", prospects: [old], request: 0 };
			}
			client.state.tavilySearch = { status: "success", mode: "TAVILY", message: "Saved Tavily phase", summary: {} };
			const newPeople = ["added", "partial"].includes(outcome) ? [added] : [];
			client.api = async (url) => {
				if (url === "/api/discovery") {
					if (outcome === "failed") throw new Error("AI request failed.");
					return { userId: "fake-user", prospects: newPeople, summary: {
						mode: "AI_SUPPLEMENT", fallbackProvider: "ANTHROPIC",
						fallbackStatus: outcome === "partial" ? "SEARCH_LIMITED" : "SUCCESS",
						accepted: outcome === "duplicate" ? 1 : newPeople.length,
						inserted: newPeople.length, duplicates: outcome === "duplicate" ? 1 : 0,
					} };
				}
				if (url === "/api/session") return { ...client.state.session, prospects: newPeople };
				if (url === "/api/analytics") return {};
				if (url === `/api/jobs/${job.id}/prospects`) return { userId: "fake-user", job, prospects: newPeople };
				throw new Error(`Unexpected request: ${url}`);
			};
			await client.executeDiscovery({ count: 3 }, "AI_SUPPLEMENT");
			assert.deepEqual(Array.from(client.state.session.prospects, (person) => person.id), ["old", ...newPeople.map((person) => person.id)]);
			if (jobLinked) assert.deepEqual(Array.from(client.state.networkingContacts.prospects, (person) => person.id), ["old", ...newPeople.map((person) => person.id)]);
			assert.match(client.renderNetworkingSearchState(), /Saved Tavily phase/);
			assert.equal(client.state.networkingSearch.status, outcome === "failed" ? "error" : outcome === "partial" ? "partial" : outcome === "added" ? "success" : "empty");
		}
	}
});

test("disabled/missing AI guidance cannot issue discovery and never changes saved preferences", async () => {
	for (const provider of ["NONE", "ANTHROPIC", "GEMINI", "OPENAI"]) {
		const client = discoveryClient({});
		client.state.session.settings.peopleSearchFallbackProvider = provider;
		client.state.session.credentials = {};
		client.state.networkingCriteria = { count: 3 };
		client.state.networkingSearch.status = "empty";
		client.api = () => { throw new Error("No provider call authorized."); };
		const html = client.renderAiDiscovery();
		assert.match(html, /id="find-more-ai"[^>]*disabled/);
		assert.match(html, provider === "NONE" ? /AI discovery is disabled/ : /No API key is configured/);
		await client.executeDiscovery(client.state.networkingCriteria, "AI_SUPPLEMENT", 3);
		assert.equal(client.state.session.settings.peopleSearchFallbackProvider, provider);
		assert.match(client.toasts.at(-1), /Settings/);
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
	assert.match(app, /state\.journeyFocus = "journey"/);
});

test("matches the approved warm home with real metrics and lightweight animation", () => {
	const app = read("public/app.js");
	const styles = read("public/styles.css");
	assert.match(app, /A little closer to<br \/>what's next\./);
	assert.match(app, /class="home-reference-stats"/);
	assert.match(app, /id="home-job-search-form"/);
	assert.match(app, /window\.JobFirstUI\.scene\(\)/);
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
