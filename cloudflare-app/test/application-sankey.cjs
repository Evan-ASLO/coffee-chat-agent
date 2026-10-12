const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ui = require("../public/analytics-ui.js");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const counts = (values = {}) => ({ saved: 0, applied: 0, interviewing: 0, offers: 0, rejected: 0, archived: 0, ...values });
const statuses = ["SAVED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED", "ARCHIVED"];
function definition(name) {
	const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
	const next = /\n(?:async )?function \w+\(/.exec(source.slice(match.index + 1));
	return source.slice(match.index, next ? match.index + 1 + next.index : source.length);
}
test("Sankey current status counts conserve tracked/jobs and exclude Saved/Archived from applications", () => {
	const model = ui.applicationSankeyModel(counts({ saved: 7, applied: 9, interviewing: 3, offers: 2, rejected: 4, archived: 5 }));
	assert.equal(model.counts.total, 18); assert.equal(model.counts.tracked, 30); assert.equal(model.counts.inProgress, 12);
	assert.equal(model.flows.reduce((n, flow) => n + flow.value, 0), 30);
	assert.ok(Math.abs(model.flows.reduce((n, flow) => n + flow.width, 0) - 180) < 1e-9);
	for (const flow of model.flows) assert.equal(flow.width / flow.value, 6);
	const html = ui.renderApplicationSankey(model.counts);
	assert.match(html, /not transition history/); assert.match(html, /Saved and Archived are not applications/);
	assert.equal((html.match(/<dt>/g) || []).length, 6);
});
test("empty, one, sparse and huge distributions have honest counts and proportional bounded flows", () => {
	assert.match(ui.renderApplicationSankey(counts()), /No tracked jobs yet/);
	assert.doesNotMatch(ui.renderApplicationSankey(counts()), /<svg/);
	for (const distribution of [counts({ offers: 1 }), counts({ archived: 1000 }), counts({ saved: 999999, offers: 1 }), counts({ interviewing: 6, rejected: 8 })]) {
		const model = ui.applicationSankeyModel(distribution);
		for (const flow of model.flows) {
			assert.equal(flow.width, 180 * flow.value / model.counts.tracked);
			assert.ok(flow.targetY - flow.width / 2 >= 0 && flow.targetY + flow.width / 2 <= 330);
		}
		const html = ui.renderApplicationSankey(distribution);
		assert.equal((html.match(/class="sankey-flow /g) || []).length, model.flows.filter((flow) => flow.value).length);
	}
});
test("invalid/missing/inconsistent counts never become success-shaped empty or padded minimum flows", () => {
	for (const input of [null, {}, counts({ offers: -1 }), counts({ saved: 1.5 }), counts({ applied: NaN }), { ...counts({ applied: 2 }), total: 9 }]) {
		assert.throws(() => ui.currentApplicationCounts(input));
		assert.match(ui.renderApplicationSankey(input), /role="alert"/);
		assert.doesNotMatch(ui.renderApplicationSankey(input), /No tracked jobs yet|<svg/);
	}
	assert.throws(() => ui.countTrackedApplications([{ id: "same", userState: { status: "APPLIED" } }, { id: "same", userState: { status: "OFFER" } }]));
});
function client() {
	const c = { state: { session: { authenticated: true, user: { id: "a" } }, analytics: null, analyticsError: "", applicationSnapshot: null, trackedJobs: { jobs: [], pagination: { total: 0, totalPages: 0 } } },
		CareerAnalyticsUi: ui, Error, analyticsRequest: 0, api: async () => { throw Error("No fixture response"); } };
	c.window = c; vm.createContext(c);
	vm.runInContext(["loadAnalyticsData", "loadCompleteApplicationSnapshot", "myJobsApplicationSnapshot"].map(definition).join("\n"), c);
	return c;
}
const row = (i) => ({ id: `job${i}`, userState: { status: statuses[i % 6] } });
test("analytics failure loads complete current tracked pages, not merely the first100 or active list filter", async () => {
	const c = client(), calls = [];
	c.state.applicationFilter = "OFFER"; c.state.applicationSearch = "no match";
	c.api = async (url) => {
		calls.push(url);
		if (url === "/api/analytics") throw Error("Fixture analytics offline");
		const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
		return { jobs: Array.from({ length: page === 1 ? 100 : 5 }, (_, i) => row((page - 1) * 100 + i)),
			pagination: { page, pageSize: 100, total: 105, totalPages: 2 } };
	};
	await c.loadAnalyticsData();
	assert.equal(c.state.applicationSnapshot.owner, "a"); assert.equal(c.state.applicationSnapshot.counts.tracked, 105);
	assert.equal(c.myJobsApplicationSnapshot().counts.tracked, 105); assert.match(c.state.analyticsError, /offline/);
	assert.equal(calls.length, 3);
});
test("incomplete/changing/duplicate fallback pages report error and never a complete105-job chart", async () => {
	for (const kind of ["missing", "changing", "duplicate"]) {
		const c = client();
		c.state.trackedJobs = { jobs: [row(0)], pagination: { total: 105, totalPages: 2 } };
		c.api = async (url) => {
			if (url === "/api/analytics") throw Error("Offline");
			const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
			return { jobs: Array.from({ length: page === 1 ? 100 : kind === "missing" ? 0 : 5 }, (_, i) => row(kind === "duplicate" ? i : (page - 1) * 100 + i)),
				pagination: { page, pageSize: 100, total: kind === "changing" && page === 2 ? 106 : 105, totalPages: 2 } };
		};
		await c.loadAnalyticsData();
		assert.equal(c.state.applicationSnapshot, null); assert.ok(c.myJobsApplicationSnapshot().error);
		assert.match(c.state.analyticsError, /could not be loaded/);
	}
});
test("late analytics or fallback cannot cross account/logout or supersede newer refresh", async () => {
	for (const phase of ["analytics", "fallback"]) for (const action of ["account", "logout", "newer"]) {
		const c = client(); let resolve;
		c.api = (url) => url === "/api/analytics" && phase === "fallback" ? Promise.reject(Error("Offline")) : new Promise((done) => { resolve = done; });
		const pending = c.loadAnalyticsData(); await new Promise(setImmediate);
		if (action === "account") c.state.session.user.id = "b";
		if (action === "logout") c.state.session = { authenticated: false };
		if (action === "newer") vm.runInContext("analyticsRequest++", c);
		resolve(phase === "analytics" ? { applications: counts({ offers: 9 }) } : { jobs: [row(0)], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } });
		await pending;
		assert.equal(c.state.analytics, null); assert.equal(c.state.applicationSnapshot, null);
	}
});
test("valid current analytics takes precedence and needs no fallback requests; complete local fallback counts all6states", async () => {
	const c = client(); let calls = 0;
	c.api = async () => { calls++; return { applications: { ...counts({ saved: 2, applied: 3, archived: 5 }), total: 3 } }; };
	await c.loadAnalyticsData(); assert.equal(calls, 1); assert.equal(c.myJobsApplicationSnapshot().counts.tracked, 10);
	c.state.analytics = null; c.state.trackedJobs = { jobs: statuses.map((_, i) => row(i)), pagination: { total: 6, totalPages: 1 } };
	assert.equal(c.myJobsApplicationSnapshot().counts.tracked, 6);
	assert.equal(c.myJobsApplicationSnapshot().counts.total, 4);
});
