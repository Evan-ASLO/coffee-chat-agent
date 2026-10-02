(function attachJourneyProgress(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.CareerJourney = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
	const AREAS = ["networking", "applications", "saved", "progress", "journey"];

	function deriveJourneyMetrics(input = {}) {
		const trackedJobs = Array.isArray(input.trackedJobs)
			? input.trackedJobs
			: [];
		const prospects = Array.isArray(input.prospects) ? input.prospects : [];
		const countJobs = (statuses) =>
			trackedJobs.filter((job) =>
				statuses.includes(job?.userState?.status),
			).length;
		const countPeople = (statuses) =>
			prospects.filter((person) => statuses.includes(person?.status)).length;
		const saved = countJobs(["SAVED"]);
		const applied = countJobs(["APPLIED"]);
		const interviews = countJobs(["INTERVIEWING"]);
		const offers = countJobs(["OFFER"]);
		const rejected = countJobs(["REJECTED"]);
		const archived = countJobs(["ARCHIVED"]);
		const activeApplications = applied + interviews + offers;
		const drafts = countPeople(["DRAFT_READY"]);
		const sent = countPeople(["SENDING", "SENT", "REPLIED"]);
		const replies = countPeople(["REPLIED"]);
		const peopleTracked = prospects.length;
		const reachedSignals = [
			saved > 0,
			activeApplications > 0,
			interviews > 0,
			offers > 0,
			peopleTracked > 0,
		].filter(Boolean).length;

		return {
			saved,
			applied,
			interviews,
			offers,
			rejected,
			archived,
			activeApplications,
			totalApplications: applied + interviews + offers + rejected,
			peopleTracked,
			drafts,
			sent,
			replies,
			plantLevel: 1 + reachedSignals,
			leafCount: Math.min(
				14,
				3 + saved + activeApplications + Math.min(peopleTracked, 4),
			),
			pathLevel: [
				saved > 0,
				activeApplications > 0,
				interviews > 0,
				offers > 0,
			].filter(Boolean).length,
			laptopGlow: Math.min(1, activeApplications / 4),
			cupLevel: Math.min(5, sent + replies),
			notebookPages: Math.max(1, Math.min(6, saved)),
			milestones: [
				{ id: "saved", label: "Saved", count: saved, active: saved > 0 },
				{
					id: "applied",
					label: "Applied",
					count: activeApplications,
					active: activeApplications > 0,
				},
				{
					id: "interview",
					label: "Interview",
					count: interviews,
					active: interviews > 0,
				},
				{ id: "offer", label: "Offer", count: offers, active: offers > 0 },
			],
		};
	}

	function detailFor(area, metrics) {
		const details = {
			networking: {
				title: "Networking",
				description:
					"Public-profile discovery, draft approvals, sends, and recorded replies.",
				stats: [
					[metrics.peopleTracked, "People tracked"],
					[metrics.drafts, "Drafts ready"],
					[metrics.sent, "Sent"],
					[metrics.replies, "Replies"],
				],
				actionView: "networking",
				actionLabel: "Open Networking",
			},
			applications: {
				title: "Applications",
				description:
					"Your current application stages, without invented dates or reminders.",
				stats: [
					[metrics.totalApplications, "Total"],
					[metrics.activeApplications, "In progress"],
					[metrics.interviews, "Interviews"],
					[metrics.offers, "Offers"],
				],
				actionView: "applications",
				actionLabel: "Open Applications",
			},
			saved: {
				title: "Saved opportunities",
				description:
					"Roles on your real shortlist, ready to compare or move into the pipeline.",
				stats: [
					[metrics.saved, "Saved roles"],
					[metrics.activeApplications, "Active applications"],
				],
				actionView: "jobs",
				actionLabel: "View saved jobs",
				actionMode: "saved",
			},
			progress: {
				title: "Overall progress",
				description:
					"The plant grows only as your saved roles, applications, interviews, offers, and network expand.",
				stats: [
					[metrics.saved, "Saved"],
					[metrics.totalApplications, "Applications"],
					[metrics.peopleTracked, "People tracked"],
					[metrics.replies, "Replies"],
				],
				actionView: "analytics",
				actionLabel: "Open Analytics",
			},
			journey: {
				title: "Career journey",
				description:
					"The desk path reflects the stages you have actually reached: Saved, Applied, Interview, and Offer.",
				stats: metrics.milestones.map((milestone) => [
					milestone.count,
					milestone.label,
				]),
				actionView: "analytics",
				actionLabel: "Review your journey",
			},
		};
		return details[area] || details.journey;
	}

	function sceneConfig(input = {}) {
		const mobile = Boolean(input.mobile);
		const reducedMotion = Boolean(input.reducedMotion);
		return {
			dprCap: mobile ? 1.25 : 1.5,
			antialias: !mobile,
			shadows: !mobile,
			animate: !reducedMotion,
			cameraFollow: !reducedMotion && !mobile,
			geometryDetail: mobile ? 0 : 1,
		};
	}

	return {
		AREAS,
		deriveJourneyMetrics,
		detailFor,
		sceneConfig,
	};
});
