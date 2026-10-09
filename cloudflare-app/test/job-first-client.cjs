const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const helper = fs.readFileSync(path.join(root, "public", "job-first.js"), "utf8");
function definition(name) {
	const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
	assert.ok(match, name);
	const next = /\n(?:async )?function \w+\(/.exec(source.slice(match.index + 1));
	return source.slice(match.index, next ? match.index + 1 + next.index : source.length);
}
function client() {
	const c = {
		state: {
			tab: "jobs", session: { authenticated: true, user: { id: "a" } },
			jobNoteDrafts: {}, applicationEditDrafts: {}, selectedJob: null,
			jobs: { jobs: [] }, trackedJobs: { jobs: [] }, networkingJob: null,
		},
		inputs: [], calls: [], historyCalls: [],
		PRIMARY_VIEWS: ["home", "jobs", "applications", "networking", "analytics", "settings"],
		location: { href: "http://127.0.0.1:8807/?q=finance&term=summer#find-jobs", hash: "#find-jobs", search: "?q=finance&term=summer" },
		document: { documentElement: { setAttribute() {} }, getElementById: () => null },
		matchMedia: () => ({ matches: false }), URL, URLSearchParams,
		FormData,
		app: { querySelectorAll: () => c.inputs },
		betaLandingRequired: () => false,
		value: () => "",
		history: {
			pushState: (_a, _b, url) => c.historyCalls.push(["push", url.href]),
			replaceState: (_a, _b, url) => c.historyCalls.push(["replace", url.href]),
		},
		setJobStatus: async (...args) => c.calls.push(args),
		fetch: async (url, options) => {
			c.requests.push({ url, options });
			return { ok: true, json: async () => ({ authenticated: false }) };
		},
		requests: [],
		removeJobStatus: async (...args) => c.calls.push(["remove", ...args]),
		showToast: (...args) => c.calls.push(["toast", ...args]),
	};
	c.window = c;
	vm.createContext(c);
	vm.runInContext(helper, c);
	vm.runInContext(["findJob", "captureJobEdits", "toggleSaved", "markJobApplied", "initialView", "syncViewToUrl", "api"].map(definition).join("\n"), c);
	return c;
}
test("aliases retain legacy routes and default to Find jobs without API calls", () => {
	const c = client();
	for (const [hash, view] of [["find-jobs", "jobs"], ["my-jobs", "applications"], ["people", "networking"], ["jobs", "jobs"], ["settings", "settings"], ["home", "home"], ["", "jobs"]]) {
		c.location.hash = `#${hash}`;
		assert.equal(c.initialView(), view);
	}
	assert.equal(c.calls.length, 0);
});
test("Home is the no-route default while explicit job and People links retain their destination", () => {
	const c = client();
	c.location.hash = "";
	c.location.search = "";
	assert.equal(c.initialView(), "home");
	c.location.search = "?contactJob=legacy:internship-123_a.v1";
	assert.equal(c.initialView(), "networking");
	c.location.search = "?selectedJob=legacy:internship-123_a.v1";
	assert.equal(c.initialView(), "jobs");
	c.location.hash = "#home";
	assert.equal(c.initialView(), "home");
	c.location.hash = "#people";
	assert.equal(c.initialView(), "networking");
	for (const id of ["a".repeat(64), "legacy:internship-123_a.v1", "12345"]) assert.equal(c.JobFirstUI.isJobId(id), true);
	for (const id of ["", "..", "a/b", "job?token=secret", "<script>", "a".repeat(241)]) assert.equal(c.JobFirstUI.isJobId(id), false);
});
test("route/selected-role history preserves filters and uses push for deliberate navigation", () => {
	const c = client();
	c.state.selectedJob = { id: "b".repeat(64) };
	c.syncViewToUrl(true);
	const selected = new URL(c.historyCalls.at(-1)[1]);
	assert.equal(selected.searchParams.get("q"), "finance");
	assert.equal(selected.searchParams.get("selectedJob"), c.state.selectedJob.id);
	assert.equal(selected.hash, "#find-jobs");
	c.state.tab = "networking";
	c.state.networkingJob = c.state.selectedJob;
	c.syncViewToUrl(true);
	const people = new URL(c.historyCalls.at(-1)[1]);
	assert.equal(people.searchParams.get("contactJob"), c.state.selectedJob.id);
	assert.equal(people.searchParams.get("q"), "finance");
	assert.equal(people.searchParams.has("selectedJob"), false);
	assert.equal(people.hash, "#people");
	assert.deepEqual(Array.from(c.historyCalls, (call) => call[0]), ["push", "push"]);
});
test("unsaved notes survive rerender but old-account DOM cannot contaminate a new account", () => {
	const c = client();
	c.state.jobs.jobs = [{ id: "job", userState: { notes: "Saved" } }];
	c.inputs = [{ dataset: { jobNote: "job", noteOwner: "a" }, value: "Unsaved real next step" }];
	c.captureJobEdits();
	assert.equal(c.state.jobNoteDrafts.job, "Unsaved real next step");
	c.state.session.user.id = "b";
	c.state.jobNoteDrafts = {};
	c.captureJobEdits();
	assert.equal(Object.keys(c.state.jobNoteDrafts).length, 0);
	assert.doesNotMatch(source, /localStorage\.setItem\([^)]*(?:note|applicationEdit)/i);
});
test("quick Mark applied and bookmark cannot regress a progressed role", async () => {
	for (const status of ["APPLIED", "INTERVIEWING", "OFFER", "REJECTED", "ARCHIVED"]) {
		const c = client();
		c.state.jobs.jobs = [{ id: "job", userState: { status } }];
		await c.markJobApplied("job");
		await c.toggleSaved("job");
		assert.equal(c.calls.filter((call) => call[0] !== "toast").length, 0, status);
	}
	for (const status of [null, "SAVED"]) {
		const c = client();
		c.state.jobs.jobs = [{ id: "job", userState: status ? { status } : null }];
		await c.markJobApplied("job");
		assert.deepEqual(Array.from(c.calls[0]), ["job", "APPLIED"]);
	}
});
test("off-page selected detail remains usable without inventing a replacement job", () => {
	const c = client();
	c.state.selectedJob = { id: "selected", title: "Real stored role" };
	assert.equal(c.findJob("selected"), c.state.selectedJob);
	assert.equal(c.findJob("missing"), null);
});
test("saved general People ranks stronger matches first, without changing job-priority sorting", () => {
	const inline = definition("renderNetworking").match(/\.sort\((\(left, right\) => \{[\s\S]*?)\n\t\t\}\);/);
	assert.ok(inline);
	const c = client();
	vm.runInContext(`comparePeople = ${inline[1]}\n}`, c);
	const people = [
		{ id: "weak", fullName: "Weak Example", matchQuality: "BROADER_COMPANY", relevanceScore: 90, updatedAt: "2026-10-09" },
		{ id: "strong", fullName: "Strong Example", matchQuality: "STRONG", relevanceScore: 55, updatedAt: "2026-10-01" },
		{ id: "other", fullName: "Other Example", matchQuality: "BROADER_COMPANY", relevanceScore: 20, updatedAt: "2026-10-10" },
	];
	assert.deepEqual(people.sort(c.comparePeople).map((person) => person.id), ["strong", "weak", "other"]);
	c.state.networkingJob = { id: "job" };
	c.jobContactFor = (person) => ({ tier: person.id === "other" ? 1 : null, score: person.relevanceScore });
	assert.equal(people.sort(c.comparePeople)[0].id, "other");
	assert.doesNotMatch(source, /profile matches the employer|Broader company match/);
});
test("guide and self-hosted Demo do not search, collect Apollo keys, autoplay or pretend to be real", () => {
	assert.match(helper, /fictional concept demonstration/);
	assert.match(helper, /<video controls playsinline preload="none"/);
	assert.match(helper, /Apollo is OFF/);
	assert.match(helper, /Partner OAuth may be required/);
	assert.doesNotMatch(helper, /localStorage|autoplay|\/api\/credentials|\/api\/discovery/);
	const c = client();
	assert.deepEqual(c.requests.map(({ url }) => url), ["/api/session"]);
	for (const file of ["internship-coffee-chat-launch-dynamic.mp4", "poster.jpg", "captions.vtt"]) {
		assert.ok(fs.statSync(path.join(root, "public", "launch", file)).size > 0);
	}
});
test("early session read is single-use, same-origin and never caches later account reads", async () => {
	const c = client();
	const pending = c.JobFirstUI.takeInitialSession();
	assert.equal(c.JobFirstUI.takeInitialSession(), null);
	assert.equal((await pending).response.ok, true);
	assert.equal(c.requests.length, 1);
	assert.equal(c.requests[0].options.credentials, "same-origin");
	assert.equal(c.requests[0].options.headers.Accept, "application/json");
	assert.match(source, /api\("\/api\/session", \{ initialSession: true \}\)/);
	assert.match(source, /if \(initial\?\.error\) throw initial\.error/);
});
test("early session network failure remains an explicit load failure without an automatic retry", async () => {
	const c = client();
	const failure = new Error("Network unavailable");
	c.fetch = () => Promise.reject(failure);
	vm.runInContext(helper, c);
	const pending = c.JobFirstUI.takeInitialSession();
	assert.equal((await pending).error, failure);
	assert.equal(c.JobFirstUI.takeInitialSession(), null);
});
test("real API consumes startup once and makes fresh later session reads", async () => {
	const c = client();
	assert.equal((await c.api("/api/session", { initialSession: true })).authenticated, false);
	assert.equal(c.requests.length, 1);
	await c.api("/api/session");
	assert.equal(c.requests.length, 2);
});
test("early HTTP and malformed responses retain normal explicit API errors", async () => {
	for (const malformed of [false, true]) {
		const c = client();
		c.state.session = { authenticated: false };
		c.fetch = async () => ({
			ok: false, status: 503, json: async () => {
				if (malformed) throw new SyntaxError("Not JSON");
				return { error: "UNAVAILABLE", message: "Session temporarily unavailable." };
			},
		});
		vm.runInContext(helper, c);
		await assert.rejects(c.api("/api/session", { initialSession: true }),
			malformed ? /server response could not be read/ : /Session temporarily unavailable/);
		assert.equal(c.JobFirstUI.takeInitialSession(), null);
	}
});
test("phone navigation, theme-first loading and reduced motion remain explicit", () => {
	const css = fs.readFileSync(path.join(root, "public", "job-first.css"), "utf8");
	const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
	assert.ok(index.indexOf('src="/job-first.js') < index.indexOf('src="/app.js'));
	assert.ok(index.indexOf('src="/theme.js') < index.indexOf('rel="stylesheet"'));
	assert.match(css, /visibility: visible; opacity: 1; pointer-events: auto/);
	assert.match(css, /prefers-reduced-motion: reduce/);
	assert.match(css, /\.top-nav \{ position: fixed;[^}]*inset: auto 0 0/);
	assert.match(css, /\.job-detail-open \.jobs-reference-hero/);
	assert.doesNotMatch(source, /mountJourneyScene\(\);/);
});
test("light bootstrap ignores OS dark, preserves explicit choices and shares public reading theme", () => {
	const theme = fs.readFileSync(path.join(root, "public", "theme.js"), "utf8");
	for (const [saved, query, expected] of [[null, "", "light"], ["dark", "", "dark"], ["light", "?scoutTheme=dark", "light"], [null, "?scoutTheme=dark", "dark"], ["invalid", "", "light"]]) {
		const storage = new Map(saved ? [["coffee-chat-theme", saved]] : []);
		const c = {
			location: { search: query }, URLSearchParams, console, events: {},
			document: {
				documentElement: { dataset: {}, setAttribute(_name, value) { this.dataset.theme = value; } },
				querySelectorAll: () => [],
				addEventListener: (name, callback) => { c.events[name] = callback; },
			},
			matchMedia: () => ({ matches: true }),
			localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
		};
		c.window = c;
		vm.runInNewContext(theme, c);
		assert.equal(c.document.documentElement.dataset.theme, expected);
		c.WorkspaceTheme.choose("dark");
		assert.equal(storage.get("coffee-chat-theme"), "dark");
		assert.equal(c.document.documentElement.dataset.theme, "dark");
		assert.throws(() => c.WorkspaceTheme.choose("system"), /Invalid theme/);
	}
	for (const file of ["index.html", "privacy.html", "terms.html"]) {
		const html = fs.readFileSync(path.join(root, "public", file), "utf8");
		assert.ok(html.indexOf('src="/theme.js') < html.indexOf('rel="stylesheet"'));
		assert.match(html, /job-first\.css/);
	}
	assert.doesNotMatch(theme, /\/api\/|fetch\(/);
});
test("mockup composition retains filters context stages and real notes", () => {
	assert.match(source, /page-animated-hero/);
	assert.match(source, /id="more-job-filters"/);
	assert.match(source, /More filters <span>/);
	assert.match(source, /data-job-detail-tab/);
	assert.match(source, /id="return-to-networking-role"/);
	assert.match(source, /Role progress/);
	assert.match(source, /data-note-owner/);
	assert.match(source, /Possible match · review relevance/);
	assert.match(source, /without an identifiable name/);
	assert.doesNotMatch(source, /Broaden the roles or location/);
});
