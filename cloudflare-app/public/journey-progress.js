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

	function workspaceDetail(area, { applications: jobs, networking: people } = {}) {
		const review = { actionView: "applications", actionLabel: "Open My jobs", stats: [] };
		if (area === "saved") return {
			...review,
			title: jobs ? jobs.saved ? "A shortlist worth a closer look." : "Leave room for a good opportunity." : "Your shortlist is still yours.",
			description: jobs ? jobs.saved ? "Compare your saved roles and keep a private note about the next step. Roles you added yourself belong here too." : "Save a role from Find jobs, or add one you found elsewhere in My jobs." : "The full saved-role count could not be loaded. Open My jobs to revisit your roles.",
			...(jobs?.saved === 0 ? { actionView: "jobs", actionLabel: "Find a role" } : {}),
		};
		if (area === "networking") return {
			actionView: "networking", actionLabel: people?.tracked ? "Revisit your people" : "Open People",
			title: people?.tracked ? "Put a person behind the opportunity." : "One thoughtful introduction at a time.",
			description: people ? people.tracked ? "Revisit a saved contact, review your context, and decide what to say. Outreach always stays behind your approval." : "Start with an employer or role you care about. Opening People does not start a paid search or send an email." : "The account-wide people count could not be loaded. Your saved contacts can still be opened in People.",
			stats: people ? [[people.replied, "Recorded replies, not confirmed coffee chats"]] : [],
		};
		if (area === "applications") return {
			...review,
			title: jobs?.total ? "Keep the next step within reach." : "A place for every application.",
			description: jobs ? jobs.total ? "Review your current stages and leave yourself a useful next-step note. Saved and Archived roles are not counted as applications." : "Mark a role as applied when you have applied, then keep its stage and notes together in My jobs." : "Application totals could not be loaded. Open My jobs to review your records.",
			stats: jobs ? [[jobs.applied, "Applied"], [jobs.interviewing, "Interviewing"], [jobs.offers, "Offers"], [jobs.rejected, "Rejected"]] : [],
		};
		if (!jobs) return { ...review, title: "Your workspace, without the guesswork.", description: "We could not load your complete job snapshot. Your records have not been reset; open My jobs or reload to retry." };
		if (jobs.offers) return { ...review, title: "An offer deserves a closer look.", description: "You have roles currently at Offer. Keep the details and your next decision together in My jobs." };
		if (jobs.interviewing) return { ...review, title: "Make space for interview preparation.", description: "You have roles currently at Interviewing. Keep your questions and next-step notes beside each role." };
		if (jobs.total) return { ...review, title: "Your next step has a home.", description: "Your applications are gathered in My jobs. Revisit a role and leave one clear note for the next time you sit down." };
		if (jobs.saved) return { ...review, title: "Something worth coming back to.", description: "Your shortlist is taking shape. Compare a saved role and decide whether it belongs in your next application session." };
		if (jobs.archived) return { ...review, title: "Room for your next opportunity.", description: "Your archived roles are still in My jobs. Save a new role when something catches your eye.", actionView: "jobs", actionLabel: "Find a role" };
		return { ...review, title: "Start with one role, not a whole career.", description: "Save a role that catches your eye. Found it somewhere else? Add it privately in My jobs and keep your next step beside it.", actionView: "jobs", actionLabel: "Find your first role" };
	}

	return {
		AREAS,
		deriveJourneyMetrics,
		detailFor,
		sceneConfig,
		workspaceDetail,
	};
});
