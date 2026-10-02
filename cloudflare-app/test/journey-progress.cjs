const assert = require("node:assert/strict");
const test = require("node:test");
const journey = require("../public/journey-progress.js");
const analyticsUi = require("../public/analytics-ui.js");

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
