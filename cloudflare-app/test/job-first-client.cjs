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
		app: { querySelectorAll: () => c.inputs },
		betaLandingRequired: () => false,
		value: () => "",
		history: {
			pushState: (_a, _b, url) => c.historyCalls.push(["push", url.href]),
			replaceState: (_a, _b, url) => c.historyCalls.push(["replace", url.href]),
		},
		setJobStatus: async (...args) => c.calls.push(args),
		removeJobStatus: async (...args) => c.calls.push(["remove", ...args]),
		showToast: (...args) => c.calls.push(["toast", ...args]),
	};
	c.window = c;
	vm.createContext(c);
	vm.runInContext(helper, c);
	vm.runInContext(["findJob", "captureJobEdits", "toggleSaved", "markJobApplied", "initialView", "syncViewToUrl"].map(definition).join("\n"), c);
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
test("guide and self-hosted Demo do not search, collect Apollo keys, autoplay or pretend to be real", () => {
	assert.match(helper, /fictional concept demonstration/);
	assert.match(helper, /<video controls playsinline preload="none"/);
	assert.match(helper, /Apollo is OFF/);
	assert.match(helper, /Partner OAuth may be required/);
	assert.doesNotMatch(helper, /\bfetch\(|localStorage|autoplay|\/api\/credentials/);
	for (const file of ["internship-coffee-chat-launch-dynamic.mp4", "poster.jpg", "captions.vtt"]) {
		assert.ok(fs.statSync(path.join(root, "public", "launch", file)).size > 0);
	}
});
test("phone navigation, theme-first loading and reduced motion remain explicit", () => {
	const css = fs.readFileSync(path.join(root, "public", "job-first.css"), "utf8");
	const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
	assert.ok(index.indexOf('src="/job-first.js') < index.indexOf('src="/app.js'));
	assert.match(css, /visibility: visible; opacity: 1; pointer-events: auto/);
	assert.match(css, /prefers-reduced-motion: reduce/);
	assert.match(css, /\.top-nav \{ position: fixed;[^}]*inset: auto 0 0/);
	assert.match(css, /\.job-detail-open \.jobs-reference-hero/);
	assert.doesNotMatch(source, /mountJourneyScene\(\);/);
});
