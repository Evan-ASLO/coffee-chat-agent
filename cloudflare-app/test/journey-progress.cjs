const assert = require("node:assert/strict");
const test = require("node:test");
const journey = require("../public/journey-progress.js");
const analyticsUi = require("../public/analytics-ui.js");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

test("maps only real workspace records into journey progress", () => {
	const metrics = journey.deriveJourneyMetrics({
		trackedJobs: [
			{ userState: { status: "SAVED" } },
			{ userState: { status: "APPLIED" } },
			{ userState: { status: "INTERVIEWING" } },
			{ userState: { status: "OFFER" } },
			{ userState: { status: "REJECTED" } },
		],
		prospects: [
			{ status: "DISCOVERED" },
			{ status: "DRAFT_READY" },
			{ status: "SENT" },
			{ status: "REPLIED" },
		],
	});
	assert.deepEqual(
		{
			saved: metrics.saved,
			activeApplications: metrics.activeApplications,
			totalApplications: metrics.totalApplications,
			interviews: metrics.interviews,
			offers: metrics.offers,
			peopleTracked: metrics.peopleTracked,
			drafts: metrics.drafts,
			sent: metrics.sent,
			replies: metrics.replies,
		},
		{
			saved: 1,
			activeApplications: 3,
			totalApplications: 4,
			interviews: 1,
			offers: 1,
			peopleTracked: 4,
			drafts: 1,
			sent: 2,
			replies: 1,
		},
	);
	assert.equal(metrics.milestones.every((entry) => entry.active), true);
	assert.equal(journey.detailFor("networking", metrics).stats[3][0], 1);
	assert.equal(journey.detailFor("saved", metrics).actionMode, "saved");
});

test("keeps empty journey and analytics states honest", () => {
	const metrics = journey.deriveJourneyMetrics({});
	assert.equal(metrics.saved, 0);
	assert.equal(metrics.totalApplications, 0);
	assert.equal(metrics.peopleTracked, 0);
	assert.equal(metrics.milestones.some((entry) => entry.active), false);
	const chart = analyticsUi.renderApplicationFunnel({});
	assert.match(chart, /No application stages to chart yet/);
	assert.doesNotMatch(chart, /%/);
	const heatmap = analyticsUi.renderActivityHeatmap({
		from: "2026-09-01",
		to: "2026-09-28",
		days: Array.from({ length: 28 }, (_, index) => ({
			date: `2026-09-${String(index + 1).padStart(2, "0")}`,
			count: 0,
		})),
	});
	assert.match(heatmap, /Recent saved-job, application, networking/);
});

test("reduces Three.js quality and animation for constrained clients", () => {
	assert.deepEqual(
		journey.sceneConfig({ mobile: true, reducedMotion: true }),
		{
			dprCap: 1.25,
			antialias: false,
			shadows: false,
			animate: false,
			cameraFollow: false,
			geometryDetail: 0,
		},
	);
	assert.deepEqual(
		journey.sceneConfig({ mobile: false, reducedMotion: false }),
		{
			dprCap: 1.5,
			antialias: true,
			shadows: true,
			animate: true,
			cameraFollow: true,
			geometryDetail: 1,
		},
	);
});

test("Home check-in responds to current records, not inferred milestones or conversations", () => {
	const counts = (extra = {}) => analyticsUi.currentApplicationCounts({ saved: 0, applied: 0, interviewing: 0, offers: 0, rejected: 0, archived: 0, ...extra });
	const detail = (area, extra) => journey.workspaceDetail(area, { applications: counts(extra), networking: { tracked: 8, replied: 2, sent: 7 } });
	assert.match(detail("journey").title, /one role/);
	assert.equal(detail("journey").actionView, "jobs");
	assert.equal(detail("saved", { saved: 5 }).actionView, "applications");
	assert.match(detail("journey", { interviewing: 2 }).title, /interview preparation/);
	assert.match(detail("journey", { offers: 1 }).title, /offer/);
	assert.equal(detail("journey", { archived: 20 }).actionView, "jobs");
	assert.deepEqual(detail("applications", { saved: 5, applied: 3, offers: 1, archived: 4 }).stats, [[3, "Applied"], [0, "Interviewing"], [1, "Offers"], [0, "Rejected"]]);
	const people = detail("networking");
	assert.deepEqual(people.stats, [[2, "Recorded replies, not confirmed coffee chats"]]);
	assert.doesNotMatch(people.description, /have coffee|sent|conversion/i);
	assert.equal(journey.workspaceDetail("applications", {}).stats.length, 0);
	assert.match(journey.workspaceDetail("journey", {}).description, /could not load/);
});

function definition(name) {
	const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(app).index;
	const next = /\n(?:async )?function \w+\(/.exec(app.slice(start + 1));
	return app.slice(start, next ? start + 1 + next.index : app.length);
}
test("Home totals use complete account snapshot, never a partial session/list or old owner's fallback", () => {
	const job = { id: "manual-fixture", manual: true, userState: { status: "SAVED" } };
	const c = { state: { session: { authenticated: true, user: { id: "a" }, prospects: [{ status: "SENDING" }] },
		trackedJobs: { jobs: [job], complete: false, pagination: { total: 101, totalPages: 2 } } }, window: { CareerAnalyticsUi: analyticsUi }, Error };
	vm.createContext(c);
	vm.runInContext(definition("myJobsApplicationSnapshot") + definition("homeJourneySnapshot"), c);
	assert.equal(c.homeJourneySnapshot().applications, null);
	assert.equal(c.homeJourneySnapshot().networking, null);
	c.state.trackedJobs = { jobs: [job], complete: true, owner: "a", pagination: { total: 1, totalPages: 1 } };
	assert.equal(c.homeJourneySnapshot().applications.saved, 1);
	c.state.session.user.id = "b";
	assert.equal(c.homeJourneySnapshot().applications, null);
	c.state.trackedJobs.jobs = [];
	c.state.trackedJobs.pagination.total = 0;
	assert.equal(c.homeJourneySnapshot().applications, null);
	c.state.analytics = { applications: { saved: 50, applied: 20, interviewing: 2, offers: 1, rejected: 3, archived: 4, total: 26 },
		networking: { tracked: 800, replied: 12, sent: 700 } };
	c.state.applicationFilter = "SAVED"; c.state.applicationSearch = "nothing";
	assert.equal(c.homeJourneySnapshot().applications.total, 26);
	assert.equal(c.homeJourneySnapshot().networking.tracked, 800);
	c.state.analytics.networking.replied = 801;
	assert.equal(c.homeJourneySnapshot().networking, null);
	c.state.analytics.applications.total = 500;
	assert.equal(c.homeJourneySnapshot().applications, null);
	assert.match(c.homeJourneySnapshot().error, /inconsistent/);
});

test("Home overview and count controls expose availability without changing records or adding scene/media", () => {
	const c = { state: { journeyFocus: "journey" }, escapeHtml: String };
	vm.createContext(c); vm.runInContext(definition("homeJourneyControl"), c);
	assert.match(c.homeJourneyControl("saved", "Saved roles", null), /Unavailable/);
	assert.doesNotMatch(c.homeJourneyControl("saved", "Saved roles", null), /<strong>0/);
	assert.match(c.homeJourneyControl("saved", "Saved roles", 0), /<strong>0/);
	assert.match(c.homeJourneyControl("saved", "Saved roles", 7), /aria-pressed="false"/);
	const home = definition("renderHome");
	assert.doesNotMatch(home, /journey-canvas|Have coffee chats|homeJourneyControl\("progress"/);
	assert.match(home, /Your jobs and people stay unchanged/);
	assert.match(home, /not a sequence of milestones/);
	assert.match(definition("openJourneyDetail"), /setAttribute\("aria-pressed"/);
});
