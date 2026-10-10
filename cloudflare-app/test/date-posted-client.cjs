const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function definition(name) {
	const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
	assert.ok(match, name);
	const next = /\n(?:async )?function \w+\(/.exec(source.slice(match.index + 1));
	return source.slice(match.index, next ? match.index + 1 + next.index : source.length);
}
function client(search = "?posted=7d&company=Example&page=3#find-jobs") {
	let url = new URL(`https://example.test/${search}`);
	const fields = { "job-q": "Engineer", "job-location": "Toronto", "job-company": "Example", "job-posted": "24h" };
	const c = {
		state: { jobQuery: { q: "", company: "", location: "", region: "", category: "", industry: "", length: "", term: "", posted: "", page: 1, pageSize: 24 },
			session: { authenticated: true, user: { id: "fictional" } }, tab: "jobs", selectedJob: null, networkingJob: null },
		PRIMARY_VIEWS: ["home", "jobs", "networking"],
		URL, URLSearchParams, calls: [], fields,
		value: (key) => fields[key] || "",
		api: async (request) => { c.calls.push(request); return { jobs: [], pagination: { total: 0 } }; },
		run: async (_text, action) => action(), render() {},
		document: { activeElement: { id: "job-posted" }, getElementById: () => ({ focus() {} }) },
		navigationRestore: 0, jobResultsRequest: 0,
		JobFirstUI: { routeHash: (tab) => tab === "networking" ? "people" : "find-jobs", routeView: (hash) => hash === "people" ? "networking" : hash === "find-jobs" ? "jobs" : "home", isJobId: (id) => Boolean(id) },
		history: { replaceState: (_a, _b, next) => { url = new URL(next); }, pushState: (_a, _b, next) => { url = new URL(next); } },
	};
	Object.defineProperty(c, "location", { get: () => ({ href: url.href, search: url.search, hash: url.hash }) });
	c.window = c;
	vm.createContext(c);
	vm.runInContext(["fetchJobs", "applyJobQueryNormalization", "loadJobQueryFromUrl", "syncJobQueryToUrl", "filterJobs", "clearJobFilters", "loadFilteredJobs", "syncViewToUrl", "initialView"].map(definition).join("\n"), c);
	return c;
}
test("a persistent labelled native select exposes all five choices and applies on keyboard/touch change", () => {
	assert.match(source, /<span id="job-posted-label">Date posted<\/span><select id="job-posted" aria-labelledby="job-posted-label" aria-describedby="job-posted-help">/);
	for (const label of ["Any time", "Past 24 hours", "Past 7 days", "Past 30 days", "Date unavailable"]) assert.ok(source.includes(`"${label}"`));
	assert.match(source, /getElementById\("job-posted"\)\?\.addEventListener\("change", filterJobs\)/);
	assert.match(source, /\["company", "region", "category", "industry", "length", "term", "posted"\]\.filter/);
});
test("range selection resets pagination, combines filters and requests server-wide results", async () => {
	const c = client();
	c.loadJobQueryFromUrl();
	assert.equal(c.state.jobQuery.page, 3);
	assert.equal(c.state.jobQuery.posted, "7d");
	await c.filterJobs({ preventDefault() {} });
	assert.equal(c.state.jobQuery.page, 1);
	const request = new URL(c.calls.at(-1), "https://example.test");
	assert.equal(request.searchParams.get("posted"), "24h");
	assert.equal(request.searchParams.get("company"), "Example");
	assert.equal(request.searchParams.get("q"), "Engineer");
	assert.equal(request.searchParams.get("page"), "1");
	assert.equal(new URL(c.location.href).searchParams.get("posted"), "24h");
	assert.equal(new URL(c.location.href).searchParams.has("page"), false);
});
test("Clear all removes the range and pagination from state, API and URL", async () => {
	const c = client();
	c.loadJobQueryFromUrl();
	await c.clearJobFilters();
	assert.equal(c.state.jobQuery.posted, "");
	assert.equal(c.state.jobQuery.page, 1);
	assert.equal(new URL(c.location.href).searchParams.has("posted"), false);
	assert.equal(new URL(c.calls.at(-1), "https://example.test").searchParams.has("posted"), false);
});
test("job/People navigation and URL restoration retain date and combined filters; no-route range opens jobs", () => {
	const c = client();
	c.loadJobQueryFromUrl();
	c.state.selectedJob = { id: "legacy:role" };
	c.syncViewToUrl(true);
	assert.equal(new URL(c.location.href).searchParams.get("posted"), "7d");
	c.state.tab = "networking";
	c.state.networkingJob = c.state.selectedJob;
	c.syncViewToUrl(true);
	assert.equal(new URL(c.location.href).searchParams.get("contactJob"), "legacy:role");
	assert.equal(new URL(c.location.href).searchParams.get("posted"), "7d");
	c.state.jobQuery.posted = "30d";
	c.loadJobQueryFromUrl();
	assert.equal(c.state.jobQuery.posted, "7d");
	assert.equal(c.state.jobQuery.company, "Example");
	assert.equal(client("?posted=24h").initialView(), "jobs");
});
test("late filtered responses cannot replace newer criteria, account or history context", async () => {
	for (const mutate of [
		(c) => { c.state.jobQuery.posted = "30d"; },
		(c) => { c.state.session.user.id = "different-account"; },
		(c) => { c.state.session = { authenticated: false }; },
		(c) => { vm.runInContext("navigationRestore++", c); },
	]) {
		const c = client();
		let resolve;
		c.api = () => new Promise((done) => { resolve = done; });
		c.state.jobs = { jobs: [{ id: "current-result" }] };
		const pending = c.filterJobs({ preventDefault() {} });
		mutate(c);
		resolve({ jobs: [{ id: "stale-result" }] });
		await pending;
		assert.equal(c.state.jobs.jobs[0].id, "current-result");
	}
});
