const APPLICATION_STATUSES = [
	"APPLIED",
	"INTERVIEWING",
	"OFFER",
	"REJECTED",
];
const PRIMARY_VIEWS = [
	"home",
	"jobs",
	"applications",
	"networking",
	"analytics",
	"settings",
];

const state = {
	session: null,
	analytics: null,
	analyticsError: "",
	jobs: {
		jobs: [],
		pagination: { page: 1, pageSize: 24, total: 0, totalPages: 0 },
		catalog: {
			state: "never-imported",
			generatedAt: null,
			importedAt: null,
			ageSeconds: null,
			staleAfterSeconds: 7200,
		},
		facets: { industries: [], lengths: [], terms: [] },
		features: { jobOutreachLinking: false },
	},
	trackedJobs: {
		jobs: [],
		pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
	},
	betaAdmin: null,
	jobQuery: {
		q: "",
		company: "",
		location: "",
		region: "",
		category: "",
		industry: "",
		length: "",
		term: "",
		page: 1,
		pageSize: 24,
	},
	tab: "home",
	jobMode: "all",
	jobLayout: "grid",
	applicationFilter: "ALL",
	applicationSearch: "",
	railCollapsed: false,
	mobileNavOpen: false,
	journeyFocus: "journey",
	renderToken: 0,
	networkingJob: null,
	networkingCriteria: null,
	networkingSearch: {
		status: "idle",
		message: "",
		summary: null,
	},
	toastTimer: null,
};

const app = document.getElementById("app");
const toast = document.getElementById("toast");
const dialog = document.getElementById("draft-dialog");
let journeyController = null;
let journeyModulePromise = null;

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save-draft").addEventListener("click", saveDraft);
document.getElementById("send-draft").addEventListener("click", sendDraft);

async function load() {
	try {
		loadJobQueryFromUrl();
		state.session = await api("/api/session");
		state.tab = state.session?.authenticated ? initialView() : "jobs";
		if (!betaLandingRequired()) {
			await Promise.all([
				loadJobData(),
				loadBetaAdminData(),
				loadAnalyticsData(),
			]);
		}
		render();
	} catch (error) {
		renderFailure(error);
	}
}

function render() {
	destroyJourneyScene();
	state.renderToken += 1;
	const authenticated = Boolean(state.session?.authenticated);
	if (betaLandingRequired()) {
		renderBetaLanding();
		return;
	}
	const user = state.session?.user;
	const credentials = state.session?.credentials;
	const navItems = authenticated
		? [
				["home", "Home", "home"],
				["jobs", "Jobs", "briefcase"],
				["applications", "Applications", "layers"],
				["networking", "Networking", "people"],
				["analytics", "Analytics", "chart"],
				["settings", "Settings", "settings"],
			]
		: [["jobs", "Jobs", "briefcase"]];
	app.innerHTML = `
		<a class="skip-link" href="#main-content">Skip to main content</a>
		<header class="topbar">
			<button class="mobile-nav-toggle" id="mobile-nav-toggle" aria-expanded="${state.mobileNavOpen}" aria-controls="primary-navigation">
				${icon("menu")}<span class="sr-only">Toggle navigation</span>
			</button>
			<button class="brand brand-button" data-nav="${authenticated ? "home" : "jobs"}" aria-label="Career Journey home">
				<span class="brand-mark" aria-hidden="true">CJ</span>
				<span>
					<strong>Career Journey</strong>
					<small>Toronto career workspace</small>
				</span>
			</button>
			<div class="top-actions">
				${
					authenticated
						? `${credentials.GOOGLE.configured ? "" : '<a class="button button-on-dark" href="/auth/google/connect">Connect Google</a>'}
							<span class="user-pill"><span class="user-avatar" aria-hidden="true">${escapeHtml(userInitials(user))}</span><span><strong>${escapeHtml(user.name || user.email)}</strong><small>${escapeHtml(user.email)}</small></span></span>
							<button id="logout" class="button-on-dark">Sign out</button>`
						: '<a class="button primary" href="/auth/google/login">Sign in with Google</a>'
				}
			</div>
		</header>
		<div class="workspace-shell ${state.railCollapsed ? "rail-collapsed" : ""} ${state.mobileNavOpen ? "nav-open" : ""}">
			<aside class="sidebar" id="primary-navigation" aria-label="Workspace navigation">
				<nav class="primary-nav" aria-label="Primary">
					${navItems
						.map(
							([id, label, iconName]) => `<button data-nav="${id}" class="${state.tab === id ? "active" : ""}" ${state.tab === id ? 'aria-current="page"' : ""}>
								${icon(iconName)}<span>${label}</span>
							</button>`,
						)
						.join("")}
				</nav>
				${
					authenticated
						? `<div class="sidebar-progress">
								<p class="eyebrow">Your workspace</p>
								<strong>${state.analytics?.applications?.inProgress || 0} in-progress ${Number(state.analytics?.applications?.inProgress || 0) === 1 ? "application" : "applications"}</strong>
								<span>${state.analytics?.networking?.drafts || 0} outreach ${Number(state.analytics?.networking?.drafts || 0) === 1 ? "draft" : "drafts"} ready</span>
							</div>
							<button id="rail-toggle" class="rail-toggle">${icon(state.railCollapsed ? "chevron-right" : "chevron-left")}<span>${state.railCollapsed ? "Expand" : "Collapse"} navigation</span></button>`
						: ""
				}
			</aside>
			<button class="nav-scrim" id="nav-scrim" aria-label="Close navigation"></button>
			<div class="content-shell">
				<main id="main-content" tabindex="-1">${renderTab()}</main>
				${legalLinks()}
			</div>
		</div>`;
	document.getElementById("logout")?.addEventListener("click", logout);
	document.querySelectorAll("[data-nav]").forEach((button) =>
		button.addEventListener("click", () => {
			navigate(button.dataset.nav);
		}),
	);
	document.getElementById("mobile-nav-toggle")?.addEventListener("click", () => {
		state.mobileNavOpen = !state.mobileNavOpen;
		render();
	});
	document.getElementById("nav-scrim")?.addEventListener("click", () => {
		state.mobileNavOpen = false;
		render();
	});
	document.getElementById("rail-toggle")?.addEventListener("click", () => {
		state.railCollapsed = !state.railCollapsed;
		render();
	});
	wireTab();
	if (authenticated && state.tab === "home") {
		mountJourneyScene(state.renderToken);
	}
}

function renderBetaLanding() {
	const requested =
		new URLSearchParams(location.search).get("access") === "requested";
	app.innerHTML = `
		<section class="beta-landing">
			<div class="beta-landing-brand">
				<div class="brand-mark">CJ</div>
				<div>
					<strong>Career Journey</strong>
					<span>Private Toronto beta</span>
				</div>
			</div>
			<div class="beta-landing-grid">
				<div class="beta-landing-copy">
					<p class="eyebrow">One calm career workspace</p>
					<h1>Move from opportunity to conversation to offer.</h1>
					<p>Career Journey brings internship search, application tracking, and approval-first professional outreach into one secure private-beta workspace.</p>
				${
					requested
						? '<p class="notice">Thanks. If this Google account can be considered for the beta, the request has been recorded. This confirmation is intentionally the same for every account.</p>'
						: ""
				}
					<div class="actions beta-actions">
						<a class="button primary" href="/auth/google/login">Sign in with Google</a>
						<a class="button" href="/auth/google/request">Request access</a>
					</div>
					<p class="beta-privacy">Request access verifies your Google email and records only the minimum information needed to review the request. It does not create a normal app account or session unless approved.</p>
				</div>
				<div class="landing-illustration" aria-hidden="true">
					<div class="landing-skyline"></div>
					<div class="landing-desk">
						<span class="landing-cup"></span>
						<span class="landing-laptop"></span>
						<span class="landing-notebook"></span>
						<span class="landing-plant"></span>
					</div>
				</div>
			</div>
			${legalLinks()}
		</section>`;
}

function renderStats() {
	const metrics = journeyMetrics();
	return `<section class="stats" aria-label="Career workspace summary">
		${stat(state.jobs.pagination.total, "Open roles", "briefcase")}
		${stat(metrics.saved, "Saved roles", "bookmark")}
		${stat(metrics.activeApplications, "Active applications", "layers")}
		${stat(metrics.peopleTracked, "People tracked", "people")}
	</section>`;
}

function renderTab() {
	if (state.tab === "home" && state.session?.authenticated) return renderHome();
	if (state.tab === "applications" && state.session?.authenticated) {
		return renderApplications();
	}
	if (state.tab === "networking" && state.session?.authenticated) {
		return renderNetworking();
	}
	if (state.tab === "settings" && state.session?.authenticated) {
		return renderSettings();
	}
	if (state.tab === "analytics" && state.session?.authenticated) {
		return renderAnalytics();
	}
	return renderJobs();
}

function renderHome() {
	const metrics = journeyMetrics();
	const detail = window.CareerJourney.detailFor(state.journeyFocus, metrics);
	const firstName = String(state.session.user.name || "")
		.trim()
		.split(/\s+/)[0];
	return `
		<section class="home-hero">
			<div class="home-hero-copy">
				<p class="eyebrow">Your Toronto career journey</p>
				<h1>${firstName ? `Welcome back, ${escapeHtml(firstName)}.` : "Welcome back."}</h1>
				<p>Build momentum across opportunities, applications, and relationships. Every object on the desk reflects your current workspace data.</p>
				<div class="actions hero-actions">
					<button class="primary" data-nav="jobs">Explore jobs</button>
					<button class="button-on-hero" data-nav="networking">Grow your network</button>
				</div>
			</div>
			<div class="hero-orbit hero-orbit-one" aria-hidden="true"></div>
			<div class="hero-orbit hero-orbit-two" aria-hidden="true"></div>
		</section>
		${renderStats()}
		<section class="journey-layout">
			<article class="journey-card">
				<div class="section-heading journey-heading">
					<div>
						<p class="eyebrow">Interactive workspace</p>
						<h2>Your career desk</h2>
						<p>Hover or tap an object, or use the mirrored controls below.</p>
					</div>
					<button id="journey-reset" class="icon-text-button">${icon("reset")} Reset view</button>
				</div>
				<div id="journey-canvas" class="journey-canvas" aria-busy="true">
					${renderJourneyFallback(metrics)}
				</div>
				<div class="journey-controls" aria-label="Career journey objects">
					${journeyControl("networking", "Coffee cup", "Networking", "cup")}
					${journeyControl("applications", "Laptop", "Applications", "laptop")}
					${journeyControl("saved", "Notebook", "Saved roles", "notebook")}
					${journeyControl("progress", "Plant", "Overall progress", "plant")}
					${journeyControl("journey", "Path", "Milestones", "path")}
				</div>
			</article>
			<section class="journey-detail" id="journey-detail" aria-live="polite" aria-label="Selected career journey detail">
				${renderJourneyDetail(detail)}
			</section>
		</section>
		<section class="home-grid">
			${renderHomeNextStep(metrics)}
			${renderRecentActivity(5)}
		</section>`;
}

function renderJourneyFallback(metrics) {
	return `<div class="journey-fallback" id="journey-fallback">
		<div class="fallback-skyline" aria-hidden="true"></div>
		<div class="fallback-desk" aria-hidden="true">
			<span class="fallback-path path-level-${metrics.pathLevel}"></span>
			<span class="fallback-cup"></span>
			<span class="fallback-laptop ${metrics.activeApplications ? "active" : ""}"></span>
			<span class="fallback-notebook"><b>${metrics.saved}</b></span>
			<span class="fallback-plant plant-level-${metrics.plantLevel}"></span>
		</div>
		<p><strong>Career desk overview</strong><span>The accessible controls below show the same live data when 3D graphics are unavailable or motion is reduced.</span></p>
	</div>`;
}

function journeyControl(area, objectLabel, productLabel, iconName) {
	return `<button data-journey-target="${area}" class="${state.journeyFocus === area ? "active" : ""}">
		${icon(iconName)}<span><small>${objectLabel}</small><strong>${productLabel}</strong></span>
	</button>`;
}

function renderJourneyDetail(detail) {
	return `<div class="journey-detail-inner">
		<p class="eyebrow">Live workspace data</p>
		<h2>${escapeHtml(detail.title)}</h2>
		<p>${escapeHtml(detail.description)}</p>
		<div class="journey-detail-stats">
			${detail.stats
				.map(
					([entry, label]) =>
						`<div><strong>${Number(entry || 0)}</strong><span>${escapeHtml(label)}</span></div>`,
				)
				.join("")}
		</div>
		<button class="primary" data-journey-action="${detail.actionView}" ${detail.actionMode ? `data-journey-mode="${detail.actionMode}"` : ""}>${escapeHtml(detail.actionLabel)}</button>
	</div>`;
}

function renderHomeNextStep(metrics) {
	let title = "Explore opportunities";
	let copy = "Start with the live job catalog and save roles worth a closer look.";
	let view = "jobs";
	let mode = "all";
	if (metrics.drafts > 0) {
		title = "Review outreach drafts";
		copy = `${metrics.drafts} ${metrics.drafts === 1 ? "draft is" : "drafts are"} waiting for your explicit approval.`;
		view = "networking";
	} else if (metrics.saved > 0 && metrics.totalApplications === 0) {
		title = "Turn a saved role into an application";
		copy = `${metrics.saved} saved ${metrics.saved === 1 ? "role is" : "roles are"} ready for review.`;
		mode = "saved";
	} else if (metrics.activeApplications > 0 && metrics.peopleTracked === 0) {
		title = "Add people context";
		copy =
			"Your application pipeline is active. Use job-linked or independent discovery to find relevant public professional profiles.";
		view = "networking";
	} else if (metrics.activeApplications > 0 || metrics.peopleTracked > 0) {
		title = "Review your momentum";
		copy =
			"Use Analytics to see your current application distribution and recorded workspace activity.";
		view = "analytics";
	}
	return `<article class="feature-card next-step-card">
		<span class="feature-icon">${icon("compass")}</span>
		<p class="eyebrow">Useful next step</p>
		<h2>${escapeHtml(title)}</h2>
		<p>${escapeHtml(copy)}</p>
		<button class="secondary" data-home-next="${view}" data-home-mode="${mode}">Continue</button>
	</article>`;
}

function renderJobs() {
	const catalogJobs = state.jobs.jobs;
	const savedJobs = state.trackedJobs.jobs.filter(
		(job) => job.userState?.status === "SAVED",
	);
	const jobs = state.jobMode === "saved" ? savedJobs : catalogJobs;
	const pagination =
		state.jobMode === "saved"
			? {
					page: 1,
					pageSize: savedJobs.length,
					total: savedJobs.length,
					totalPages: savedJobs.length ? 1 : 0,
				}
			: state.jobs.pagination;
	const linkingEnabled = jobOutreachLinkingEnabled();
	return `
		<section class="page-hero jobs-hero">
			<div>
				<p class="eyebrow">Curated opportunity board</p>
				<h1>Find work that moves you forward.</h1>
				<p>Search current normalized postings, build a shortlist, and move roles into your application pipeline.${linkingEnabled ? " Job-linked networking is available for signed-in users." : ""}</p>
			</div>
			${state.session?.authenticated ? "" : '<a class="button primary" href="/auth/google/login">Sign in to track progress</a>'}
		</section>
		${renderCatalogWarning()}
		<div class="view-switcher" role="group" aria-label="Job collection">
			<button data-job-mode="all" class="${state.jobMode === "all" ? "active" : ""}">All jobs <span>${state.jobs.pagination.total}</span></button>
			${
				state.session?.authenticated
					? `<button data-job-mode="saved" class="${state.jobMode === "saved" ? "active" : ""}">Saved <span>${savedJobs.length}</span></button>`
					: ""
			}
		</div>
		<div class="jobs-layout ${state.jobMode === "saved" ? "saved-layout" : ""}">
			${
				state.jobMode === "all"
					? `<aside class="filter-panel" aria-label="Job filters">
							<div class="filter-panel-heading">
								<div>${icon("filter")}<span><strong>Filters</strong><small>Refine current roles</small></span></div>
								<button type="button" id="clear-job-filters" class="text-button">Clear all</button>
							</div>
							<form id="job-filter-form" class="job-filters">
								<label class="job-search">Search
									<input id="job-q" value="${escapeAttr(state.jobQuery.q)}" placeholder="Title, company, location, or keyword" />
								</label>
								<label>Company<input id="job-company" value="${escapeAttr(state.jobQuery.company)}" /></label>
								<label>Location<input id="job-location" value="${escapeAttr(state.jobQuery.location)}" /></label>
								<label>Region<input id="job-region" value="${escapeAttr(state.jobQuery.region)}" /></label>
								<label>Career track<input id="job-category" value="${escapeAttr(state.jobQuery.category)}" /></label>
								<label>Industry<select id="job-industry">${facetOptions(state.jobs.facets?.industries, state.jobQuery.industry, "All industries")}</select></label>
								<label>Length<select id="job-length">${facetOptions(state.jobs.facets?.lengths, state.jobQuery.length, "All lengths")}</select></label>
								<label>Term<select id="job-term">${facetOptions(state.jobs.facets?.terms, state.jobQuery.term, "All terms")}</select></label>
								<button class="primary full-width">Apply filters</button>
							</form>
						</aside>`
					: ""
			}
			<section class="panel job-results">
				<div class="results-toolbar">
					<div>
						<p class="eyebrow">${state.jobMode === "saved" ? "Your shortlist" : "Live catalog"}</p>
						<h2>${pagination.total} ${state.jobMode === "saved" ? "saved" : "open"} ${pagination.total === 1 ? "role" : "roles"}</h2>
						<p>${state.jobMode === "saved" ? "Compare promising roles, then mark one as applied when you submit." : "Source, term, duration, industry, and application controls stay attached to every role."}</p>
					</div>
					<div class="layout-toggle" role="group" aria-label="Job result layout">
						<button data-job-layout="grid" class="${state.jobLayout === "grid" ? "active" : ""}" aria-label="Grid view">${icon("grid")}</button>
						<button data-job-layout="list" class="${state.jobLayout === "list" ? "active" : ""}" aria-label="List view">${icon("list")}</button>
					</div>
				</div>
				${jobs.length ? `<div class="job-cards ${state.jobLayout === "list" ? "list-view" : "grid-view"}">${jobs.map(jobCard).join("")}</div>` : empty(state.jobMode === "saved" ? "Save a role from the live catalog to build your shortlist." : "No active jobs match these filters.")}
				${state.jobMode === "all" ? renderPagination(pagination) : ""}
			</section>
		</div>`;
}

function renderApplications() {
	const allJobs = state.trackedJobs.jobs.filter((job) =>
		[...APPLICATION_STATUSES, "ARCHIVED"].includes(job.userState?.status),
	);
	const search = state.applicationSearch.toLowerCase();
	const jobs = allJobs.filter((job) => {
		const statusMatches =
			state.applicationFilter === "ALL" ||
			job.userState?.status === state.applicationFilter;
		const textMatches =
			!search ||
			[job.title, job.company, job.location, job.region]
				.join(" ")
				.toLowerCase()
				.includes(search);
		return statusMatches && textMatches;
	});
	const applications = state.analytics?.applications || {
		total: allJobs.length,
		inProgress: allJobs.filter((job) =>
			["APPLIED", "INTERVIEWING"].includes(job.userState?.status),
		).length,
		interviewing: allJobs.filter(
			(job) => job.userState?.status === "INTERVIEWING",
		).length,
		offers: allJobs.filter((job) => job.userState?.status === "OFFER").length,
	};
	return `
		${pageHeader("Application pipeline", "Applications", "Track the current stage and private notes for every real application. No invented dates or reminders.", "")}
		<section class="stats application-stats">
			${stat(applications.total, "Total applications", "layers")}
			${stat(applications.inProgress, "In progress", "progress")}
			${stat(applications.interviewing, "Interviews", "calendar")}
			${stat(applications.offers, "Offers", "spark")}
		</section>
		<section class="panel applications-panel">
			<h2 class="sr-only">Tracked applications</h2>
			<div class="application-toolbar">
				<div class="stage-filters" role="group" aria-label="Application stage">
					${applicationFilterButton("ALL", "All", allJobs.length)}
					${applicationFilterButton("APPLIED", "Applied")}
					${applicationFilterButton("INTERVIEWING", "Interviewing")}
					${applicationFilterButton("OFFER", "Offers")}
					${applicationFilterButton("REJECTED", "Rejected")}
					${applicationFilterButton("ARCHIVED", "Archived")}
				</div>
				<form id="application-search-form" class="inline-search">
					<label class="sr-only" for="application-search">Search applications</label>
					${icon("search")}
					<input id="application-search" value="${escapeAttr(state.applicationSearch)}" placeholder="Search company or role" />
				</form>
			</div>
			${jobs.length ? `<div class="application-list">${jobs.map(applicationCard).join("")}</div>` : empty(allJobs.length ? "No applications match this stage and search." : "Mark a job as Applied to start your application pipeline.")}
		</section>`;
}

function renderNetworking() {
	const linkingEnabled = jobOutreachLinkingEnabled();
	const searching = state.networkingSearch.status === "running";
	const context = linkingEnabled && state.networkingJob
		? `<section class="notice networking-context">
				<div>
					<strong>${searching ? "Finding people" : "Networking"} for ${escapeHtml(state.networkingJob.title)}</strong>
					<span>${escapeHtml(state.networkingJob.company)} · ${escapeHtml(state.networkingJob.location || state.networkingJob.region || "Location not listed")}</span>
				</div>
				<button id="clear-networking-job" ${searching ? "disabled" : ""}>Clear job context</button>
			</section>`
		: "";
	const previewNotice = linkingEnabled
		? ""
		: '<section class="notice warning">Job-linked outreach is paused until the internship catalog passes the preview stability criteria. Independent Coffee Chat search, drafting, and sending remain available.</section>';
	const networking = state.analytics?.networking || {
		tracked: state.session.prospects.length,
		drafts: state.session.prospects.filter(
			(person) => person.status === "DRAFT_READY",
		).length,
		sent: state.session.prospects.filter((person) =>
			["SENDING", "SENT", "REPLIED"].includes(person.status),
		).length,
		replied: state.session.prospects.filter(
			(person) => person.status === "REPLIED",
		).length,
	};
	return `
		${pageHeader("Relationship building", "Networking", "Discover relevant public professional profiles, approve each person, review every draft, and send only when you are ready.", "")}
		<section class="stats networking-stats">
			${stat(networking.tracked, "People tracked", "people")}
			${stat(networking.drafts, "Drafts ready", "edit")}
			${stat(networking.sent, "Sent", "send")}
			${stat(networking.replied, "Replies", "reply")}
		</section>
		${previewNotice}${context}${renderNetworkingSearchState()}
		<div class="workflow-strip" aria-label="Networking workflow">
			<span class="active"><b>1</b> Discover</span><span><b>2</b> Approve</span><span><b>3</b> Review draft</span><span><b>4</b> Send</span><span><b>5</b> Reply</span>
		</div>
		${renderFind()}${renderApprove()}${renderOutreach()}`;
}

function renderFind() {
	const ready = state.session.credentials.TAVILY.configured;
	const job = state.networkingJob;
	const criteria =
		state.networkingCriteria ||
		job?.discoveryCriteria || {
			roles: ["Venture Capital Analyst"],
			industries: [],
			companies: [],
			locations: ["Toronto"],
			keywords: [],
			seniority: [],
			objective: "",
			count: 5,
		};
	const searching = state.networkingSearch.status === "running";
	return `
		<section class="panel" id="find-people-panel" aria-busy="${searching}">
			<div class="panel-head">
				<div>
					<h2>Find relevant people</h2>
					<p>Search public professional profiles. When started from a job, the company, title, location, and outreach context stay linked to every new prospect.</p>
				</div>
			</div>
			${ready ? "" : '<p class="notice warning">Add a Tavily key under Settings before searching.</p>'}
			<form id="find-form" class="grid">
				${textarea("roles", "Target roles", criteria.roles.join("\n"))}
				${textarea("industries", "Industries", criteria.industries.join("\n"))}
				${textarea("companies", "Companies", criteria.companies.join("\n"))}
				${textarea("locations", "Locations", criteria.locations.join("\n"))}
				${textarea("keywords", "Keywords", criteria.keywords.join("\n"))}
				${textarea("seniority", "Seniority", criteria.seniority.join("\n"))}
				<label class="full">Why you want to meet them
					<textarea id="objective" rows="3">${escapeHtml(criteria.objective)}</textarea>
				</label>
				<label>Number of people
					<input id="count" type="number" min="1" max="20" value="${Number(criteria.count || 5)}" />
				</label>
				<div class="actions full">
					<button class="primary" ${ready && !searching ? "" : "disabled"}>
						${searching ? '<span class="inline-spinner" aria-hidden="true"></span> Searching…' : "Find people"}
					</button>
				</div>
			</form>
		</section>`;
}

function renderNetworkingSearchState() {
	const search = state.networkingSearch;
	if (search.status === "idle") return "";
	if (search.status === "running") {
		return `<section class="notice discovery-state" role="status">
			<span class="inline-spinner" aria-hidden="true"></span>
			<div><strong>Searching public professional profiles…</strong><span>This normally takes a few seconds. Duplicate actions are disabled.</span></div>
		</section>`;
	}
	const className = search.status === "success" ? "notice" : "notice warning";
	return `<section class="${className} discovery-state" role="${search.status === "error" ? "alert" : "status"}">
		<div><strong>${escapeHtml(search.status === "success" ? "People found" : search.status === "empty" ? "No people found" : "Search could not be completed")}</strong><span>${escapeHtml(search.message)}</span></div>
		${
			search.status === "empty" || search.status === "error"
				? '<button id="retry-job-discovery" class="secondary">Retry search</button>'
				: ""
		}
	</section>`;
}

function renderApprove() {
	const people = state.session.prospects.filter((item) =>
		["DISCOVERED", "ERROR"].includes(item.status),
	);
	const profileReady = isDraftProfileReady(state.session.settings);
	return `<section class="panel" id="approve-panel">
		<div class="panel-head">
			<div>
				<h2>Approve people</h2>
				<p>The first approval may use Hunter and your selected drafting provider. It never sends email.</p>
			</div>
		</div>
		${profileReady ? "" : '<p class="notice warning">Add at least one factual detail about your background, current goal, or experience before preparing a personalized draft. <button id="complete-profile" class="secondary">Complete profile</button></p>'}
		${people.length ? `<div class="cards">${people.map((person) => prospectCard(person, profileReady)).join("")}</div>` : empty("No people are waiting for approval.")}
	</section>`;
}

function renderOutreach() {
	const drafts = state.session.prospects.filter(
		(item) => item.status === "DRAFT_READY",
	);
	const pipeline = state.session.prospects.filter((item) =>
		["SENDING", "SENT", "REPLIED"].includes(item.status),
	);
	return `
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Drafts awaiting approval</h2>
					<p>Review the exact recipient, subject, and body. Sending uses a server-side idempotency key and cannot be bulk-triggered.</p>
				</div>
			</div>
			${drafts.length ? `<div class="cards">${drafts.map(draftCard).join("")}</div>` : empty("No drafts are ready.")}
		</section>
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Sent and replied</h2>
					<p>Uncertain sends are locked until you check Gmail Sent.</p>
				</div>
			</div>
			${pipeline.length ? `<div class="cards">${pipeline.map(pipelineCard).join("")}</div>` : empty("No messages have been sent.")}
		</section>`;
}

function renderAnalytics() {
	if (!state.analytics) {
		return `
			${pageHeader("Workspace signals", "Analytics", "Counts and activity are calculated only from your current application, networking, and audit records.", "")}
			<section class="panel">
				${state.analyticsError ? `<p class="notice danger">${escapeHtml(state.analyticsError)}</p>` : '<div class="skeleton-stack" aria-label="Loading analytics"><span></span><span></span><span></span></div>'}
			</section>`;
	}
	const { applications, networking, topCompanies, activity } = state.analytics;
	return `
		${pageHeader("Workspace signals", "Analytics", "A factual view of your current pipeline and recorded activity. No synthetic growth rates or conversion claims.", "")}
		<section class="stats analytics-stats">
			${stat(applications.saved, "Saved roles", "bookmark")}
			${stat(applications.inProgress, "In progress", "progress")}
			${stat(applications.interviewing, "Interviews", "calendar")}
			${stat(applications.offers, "Offers", "spark")}
		</section>
		<div class="analytics-grid">
			<section class="panel analytics-card analytics-card-wide">
				<div class="panel-head">
					<div>
						<p class="eyebrow">Current status</p>
						<h2>Application journey</h2>
						<p>Each bar is the current count in that stage, not a conversion rate.</p>
					</div>
				</div>
				${window.CareerAnalyticsUi.renderApplicationFunnel(applications)}
			</section>
			<section class="panel analytics-card">
				<div class="panel-head"><div><p class="eyebrow">Concentration</p><h2>Top companies</h2><p>Current non-archived tracked roles.</p></div></div>
				${window.CareerAnalyticsUi.renderTopCompanies(topCompanies)}
			</section>
			<section class="panel analytics-card">
				<div class="panel-head"><div><p class="eyebrow">Outreach workflow</p><h2>Networking</h2><p>Real prospects and message states in your account.</p></div></div>
				<div class="analytics-count-grid">
					<div><strong>${networking.tracked}</strong><span>Tracked</span></div>
					<div><strong>${networking.discovered}</strong><span>To review</span></div>
					<div><strong>${networking.drafts}</strong><span>Drafts</span></div>
					<div><strong>${networking.sent}</strong><span>Sent</span></div>
					<div><strong>${networking.replied}</strong><span>Replies</span></div>
					<div><strong>${networking.errors}</strong><span>Errors</span></div>
				</div>
			</section>
			<section class="panel analytics-card analytics-card-wide">
				<div class="panel-head"><div><p class="eyebrow">Last 28 days</p><h2>Recorded activity</h2><p>Audit events generated by actions in this workspace.</p></div></div>
				${window.CareerAnalyticsUi.renderActivityHeatmap(activity)}
			</section>
		</div>
		${renderRecentActivity(12)}`;
}

function renderRecentActivity(limit) {
	const entries = state.analytics?.recentActivity?.slice(0, limit) || [];
	return `<section class="panel activity-panel">
		<div class="panel-head">
			<div>
				<p class="eyebrow">Audit-backed</p>
				<h2>Recent activity</h2>
				<p>Only recorded account actions are shown.</p>
			</div>
		</div>
		${
			entries.length
				? `<ol class="activity-list">${entries
						.map(
							(entry) => `<li>
								<span class="activity-marker" aria-hidden="true">${icon(activityIcon(entry.action))}</span>
								<div><strong>${escapeHtml(entry.label)}</strong>${entry.context ? `<span>${escapeHtml(entry.context)}</span>` : ""}</div>
								<time datetime="${escapeAttr(entry.createdAt)}">${formatDate(entry.createdAt)}</time>
							</li>`,
						)
						.join("")}</ol>`
				: empty("No recorded activity yet.")
		}
	</section>`;
}

function renderSettings() {
	const { settings, credentials, resume } = state.session;
	return `
		${pageHeader("Workspace preferences", "Settings", "Manage the real services and private data already connected to your career workspace.", "")}
		<div class="settings-grid">
			<section class="panel settings-card">
				<div class="settings-card-icon">${icon("google")}</div>
				<div class="panel-head">
					<div>
						<p class="eyebrow">Google workspace</p>
						<h2>Gmail & Sheets</h2>
						<p>Google access is used only for approved sends, reply sync, and your private CRM Sheet.</p>
					</div>
				</div>
				${
					credentials.GOOGLE.configured
						? `<p class="notice">Google is connected. ${settings.spreadsheetId ? `<a href="https://docs.google.com/spreadsheets/d/${escapeAttr(settings.spreadsheetId)}" target="_blank" rel="noopener">Open CRM Sheet</a>` : '<button id="init-workspace" class="secondary">Create CRM Sheet</button>'}</p>`
						: '<p class="notice warning"><a href="/auth/google/connect">Connect Gmail & Sheets</a> before creating the workspace or sending.</p>'
				}
			</section>
			<section class="panel settings-card">
				<div class="settings-card-icon">${icon("document")}</div>
				<div class="panel-head">
					<div>
						<p class="eyebrow">Private document</p>
						<h2>Resume</h2>
						<p>Upload a PDF, DOCX, or TXT file up to 5 MB. It is encrypted before storage.</p>
					</div>
				</div>
				<form id="resume-form" class="resume-row">
					<label>Resume file
						<input id="resume-file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required />
					</label>
					<div class="actions">
						<button class="primary">Upload & analyze</button>
						<button id="delete-resume" class="danger" type="button" ${resume.configured ? "" : "disabled"}>Delete</button>
					</div>
				</form>
				${
					resume.configured
						? `<p class="notice resume-status"><strong>${escapeHtml(resume.fileName)}</strong> · ${formatFileSize(resume.sizeBytes)} · uploaded ${formatDate(resume.uploadedAt)}</p>`
						: '<p class="notice warning resume-status">No resume is stored. PDF analysis requires a configured Gemini key; DOCX and TXT can use any configured AI provider.</p>'
				}
			</section>
			<section class="panel settings-card settings-card-wide">
				<div class="panel-head">
					<div>
						<p class="eyebrow">Drafting context</p>
						<h2>Profile and drafting</h2>
						<p>Only factual context you save here is available to the drafting workflow.</p>
					</div>
				</div>
				<form id="settings-form" class="grid grid-3">
					<label>Your name<input id="sender-name" value="${escapeAttr(settings.senderName)}" /></label>
					<label>Email enrichment
						<select id="enrichment-provider">
							<option value="HUNTER" ${selected(settings.enrichmentProvider, "HUNTER")}>Hunter</option>
							<option value="NONE" ${selected(settings.enrichmentProvider, "NONE")}>Manual email entry</option>
						</select>
					</label>
					<label>Draft provider<select id="draft-provider">${providerOptions(settings.draftProvider)}</select></label>
					<label>Gemini model<input id="gemini-model" value="${escapeAttr(settings.geminiModel)}" /></label>
					<label>OpenAI model<input id="openai-model" value="${escapeAttr(settings.openAiModel)}" /></label>
					<label>Anthropic model<input id="anthropic-model" value="${escapeAttr(settings.anthropicModel)}" /></label>
					<label class="full">Cited people-search fallback
						<select id="people-search-fallback-provider">
							<option value="NONE" ${selected(settings.peopleSearchFallbackProvider, "NONE")}>Disabled</option>
							<option value="GEMINI" ${selected(settings.peopleSearchFallbackProvider, "GEMINI")}>Gemini Google Search</option>
							<option value="OPENAI" ${selected(settings.peopleSearchFallbackProvider, "OPENAI")}>OpenAI Web Search</option>
							<option value="ANTHROPIC" ${selected(settings.peopleSearchFallbackProvider, "ANTHROPIC")}>Anthropic Web Search</option>
						</select>
						<small>Runs only after Tavily returns too few usable profiles. It uses your encrypted key and configured model for one selected provider. Provider search tools may incur charges.</small>
					</label>
					<label>Email word limit<input id="word-limit" type="number" min="60" max="250" value="${settings.emailWordLimit}" /></label>
					<label class="full">Outreach goal<textarea id="outreach-goal" rows="3">${escapeHtml(settings.outreachGoal)}</textarea></label>
					<label class="full">Background summary<textarea id="background" rows="4">${escapeHtml(contextValue("Background summary"))}</textarea></label>
					<label class="full">Current goal<textarea id="current-goal" rows="3">${escapeHtml(contextValue("Current goal"))}</textarea></label>
					<label class="full">Experience to reference<textarea id="experience" rows="4">${escapeHtml(contextValue("Experience to reference"))}</textarea></label>
					<div class="actions full"><button class="primary">Save profile settings</button></div>
				</form>
			</section>
			<section class="panel settings-card settings-card-wide">
				<div class="panel-head">
					<div>
						<p class="eyebrow">Encrypted at rest</p>
						<h2>Provider credentials</h2>
						<p>Keys are submitted once and stored with AES-256-GCM. Only masked hints return to this page.</p>
					</div>
				</div>
				${secretRow("TAVILY", "Tavily", credentials.TAVILY)}
				${secretRow("HUNTER", "Hunter", credentials.HUNTER)}
				${secretRow("GEMINI", "Gemini", credentials.GEMINI)}
				${secretRow("OPENAI", "OpenAI", credentials.OPENAI)}
				${secretRow("ANTHROPIC", "Anthropic", credentials.ANTHROPIC)}
			</section>
			<section class="panel settings-card">
				<div class="panel-head">
					<div>
						<p class="eyebrow">One-time migration</p>
						<h2>Legacy tracker import</h2>
						<p>Paste one version 1 export. Matching uses canonical URL, then company and title.</p>
					</div>
				</div>
				<form id="legacy-import-form">
					<label>Legacy export JSON
						<textarea id="legacy-import-json" rows="8" placeholder='{"schemaVersion":1,"exportedAt":"2026-10-01T12:00:00.000Z","source":"internship-tracker-toronto","savedJobs":[],"applications":[]}'></textarea>
					</label>
					<div class="actions"><button class="primary">Import once</button></div>
				</form>
			</section>
			<section class="panel settings-card">
				<div class="panel-head">
					<div>
						<p class="eyebrow">Account & privacy</p>
						<h2>Your controls</h2>
						<p>Review the service policies, revoke Google permissions, or sign out of this browser.</p>
					</div>
				</div>
				<div class="settings-links">
					<a href="/privacy.html">${icon("shield")} Privacy Policy</a>
					<a href="/terms.html">${icon("document")} Terms of Service</a>
					<a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">${icon("external")} Google permissions</a>
					<button id="settings-logout">${icon("logout")} Sign out</button>
				</div>
			</section>
		</div>
		${state.session.isBetaAdmin ? `<details class="admin-disclosure"><summary>${icon("shield")} <span><strong>Beta access administration</strong><small>Owner-only allowlist controls</small></span>${icon("chevron-down")}</summary>${renderBetaAccessAdmin()}</details>` : ""}`;
}

function renderBetaAccessAdmin() {
	const data = state.betaAdmin || { requests: [], access: [] };
	const pending = data.requests.filter((item) => item.status === "PENDING");
	const denied = data.requests.filter((item) => item.status === "DENIED");
	const approved = data.access.filter((item) => item.status === "APPROVED");
	const revoked = data.access.filter((item) => item.status === "REVOKED");
	return `
		<div class="admin-settings">
		<section class="panel admin-panel">
			<div class="panel-head">
				<div>
					<p class="eyebrow">Owner controls</p>
					<h2>Private-beta access</h2>
					<p>Authorization is enforced server-side from <code>BETA_ADMIN_EMAILS</code>. Changes take effect immediately; revocation terminates active sessions for that email.</p>
				</div>
			</div>
			<form id="beta-approve-email-form" class="beta-invite-form">
				<label>Approve or re-approve an email
					<input id="beta-approve-email" type="email" maxlength="320" autocomplete="off" required />
				</label>
				<button class="primary">Approve email</button>
			</form>
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Pending requests</h2><p>Requests come only from verified Google identities.</p></div></div>
			${pending.length ? `<div class="cards">${pending.map(betaRequestCard).join("")}</div>` : empty("No access requests are pending.")}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Approved access</h2></div></div>
			${approved.length ? `<div class="cards">${approved.map(betaAccessCard).join("")}</div>` : empty("No D1 allowlist entries are approved. Environment admins remain authorized separately.")}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Revoked and denied</h2><p>Re-approve only after reviewing the original decision.</p></div></div>
			${
				revoked.length || denied.length
					? `<div class="cards">
							${revoked.map(betaAccessCard).join("")}
							${denied.map(betaRequestCard).join("")}
						</div>`
					: empty("No revoked or denied entries.")
			}
		</section>
		</div>`;
}

function betaRequestCard(request) {
	return `<article class="card">
		<div class="card-head">
			<div>
				<h3>${escapeHtml(request.email)}</h3>
				<p>Requested ${formatDate(request.requestedAt)}</p>
			</div>
			<span class="status status-${request.status.toLowerCase()}">${formatStatus(request.status)}</span>
		</div>
		<div class="actions">
			<button class="primary" data-beta-approve-request="${request.id}">Approve</button>
			${request.status === "PENDING" ? `<button class="danger" data-beta-deny-request="${request.id}">Deny</button>` : ""}
		</div>
	</article>`;
}

function betaAccessCard(access) {
	return `<article class="card">
		<div class="card-head">
			<div>
				<h3>${escapeHtml(access.email)}</h3>
				<p>Updated ${formatDate(access.updatedAt)}</p>
			</div>
			<span class="status status-${access.status.toLowerCase()}">${formatStatus(access.status)}</span>
		</div>
		<div class="actions">
			${
				access.status === "APPROVED"
					? `<button class="danger" data-beta-revoke-email="${escapeAttr(access.email)}">Revoke</button>`
					: `<button class="primary" data-beta-approve-email="${escapeAttr(access.email)}">Re-approve</button>`
			}
		</div>
	</article>`;
}

function wireTab() {
	document.getElementById("job-filter-form")?.addEventListener("submit", filterJobs);
	document.getElementById("clear-job-filters")?.addEventListener("click", clearJobFilters);
	document.querySelectorAll("[data-job-mode]").forEach((button) =>
		button.addEventListener("click", () => {
			state.jobMode = button.dataset.jobMode;
			render();
		}),
	);
	document.querySelectorAll("[data-job-layout]").forEach((button) =>
		button.addEventListener("click", () => {
			state.jobLayout = button.dataset.jobLayout;
			render();
		}),
	);
	document.querySelectorAll("[data-application-filter]").forEach((button) =>
		button.addEventListener("click", () => {
			state.applicationFilter = button.dataset.applicationFilter;
			render();
		}),
	);
	document
		.getElementById("application-search-form")
		?.addEventListener("submit", (event) => {
			event.preventDefault();
			state.applicationSearch = value("application-search");
			render();
		});
	document.querySelectorAll("[data-save-job-notes]").forEach((button) =>
		button.addEventListener("click", () =>
			saveJobNotes(button.dataset.saveJobNotes),
		),
	);
	document.querySelectorAll("[data-journey-target]").forEach((button) =>
		button.addEventListener("click", () =>
			openJourneyDetail(button.dataset.journeyTarget, true),
		),
	);
	document.getElementById("journey-reset")?.addEventListener("click", () => {
		state.journeyFocus = "journey";
		journeyController?.reset();
		openJourneyDetail("journey", false);
	});
	document.querySelectorAll("[data-journey-action]").forEach((button) =>
		button.addEventListener("click", () => {
			if (button.dataset.journeyMode) {
				state.jobMode = button.dataset.journeyMode;
			}
			navigate(button.dataset.journeyAction);
		}),
	);
	document.querySelectorAll("[data-home-next]").forEach((button) =>
		button.addEventListener("click", () => {
			if (button.dataset.homeMode) state.jobMode = button.dataset.homeMode;
			navigate(button.dataset.homeNext);
		}),
	);
	document.querySelectorAll("[data-page]").forEach((button) =>
		button.addEventListener("click", () => changeJobPage(Number(button.dataset.page))),
	);
	document.querySelectorAll("[data-job-save]").forEach((button) =>
		button.addEventListener("click", () => toggleSaved(button.dataset.jobSave)),
	);
	document.querySelectorAll("[data-job-apply]").forEach((button) =>
		button.addEventListener("click", () => setJobStatus(button.dataset.jobApply, "APPLIED")),
	);
	document.querySelectorAll("[data-job-network]").forEach((button) =>
		button.addEventListener("click", () => beginJobNetworking(button.dataset.jobNetwork)),
	);
	document.querySelectorAll("[data-job-status]").forEach((selectElement) =>
		selectElement.addEventListener("change", () =>
			updateJobStatusFromSelect(selectElement.dataset.jobStatus, selectElement.value),
		),
	);
	document.getElementById("find-form")?.addEventListener("submit", findPeople);
	document.getElementById("settings-form")?.addEventListener("submit", saveSettings);
	document.getElementById("legacy-import-form")?.addEventListener("submit", importLegacyState);
	document.getElementById("beta-approve-email-form")?.addEventListener("submit", approveBetaEmailForm);
	document.getElementById("resume-form")?.addEventListener("submit", uploadResume);
	document.getElementById("delete-resume")?.addEventListener("click", removeResume);
	document.getElementById("init-workspace")?.addEventListener("click", initWorkspace);
	document.getElementById("settings-logout")?.addEventListener("click", logout);
	document.getElementById("clear-networking-job")?.addEventListener("click", () => {
		state.networkingJob = null;
		state.networkingCriteria = null;
		state.networkingSearch = { status: "idle", message: "", summary: null };
		render();
	});
	document.getElementById("retry-job-discovery")?.addEventListener("click", () => {
		executeDiscovery(readDiscoveryCriteria());
	});
	document.getElementById("complete-profile")?.addEventListener("click", () => {
		navigate("settings");
		document.getElementById("background")?.focus();
	});
	document.querySelectorAll("[data-prepare]").forEach((button) =>
		button.addEventListener("click", () => prepare(button.dataset.prepare)),
	);
	document.querySelectorAll("[data-reject]").forEach((button) =>
		button.addEventListener("click", () => reject(button.dataset.reject)),
	);
	document.querySelectorAll("[data-review]").forEach((button) =>
		button.addEventListener("click", () => openDraft(button.dataset.review)),
	);
	document.querySelectorAll("[data-regenerate]").forEach((button) =>
		button.addEventListener("click", () => regenerate(button.dataset.regenerate)),
	);
	document.querySelectorAll("[data-save-secret]").forEach((button) =>
		button.addEventListener("click", () => saveSecret(button.dataset.saveSecret)),
	);
	document.querySelectorAll("[data-delete-secret]").forEach((button) =>
		button.addEventListener("click", () => deleteSecret(button.dataset.deleteSecret)),
	);
	document.querySelectorAll("[data-beta-approve-request]").forEach((button) =>
		button.addEventListener("click", () => approveBetaRequest(button.dataset.betaApproveRequest)),
	);
	document.querySelectorAll("[data-beta-deny-request]").forEach((button) =>
		button.addEventListener("click", () => denyBetaRequest(button.dataset.betaDenyRequest)),
	);
	document.querySelectorAll("[data-beta-revoke-email]").forEach((button) =>
		button.addEventListener("click", () => revokeBetaAccess(button.dataset.betaRevokeEmail)),
	);
	document.querySelectorAll("[data-beta-approve-email]").forEach((button) =>
		button.addEventListener("click", () => approveBetaAccess(button.dataset.betaApproveEmail)),
	);
}

async function approveBetaEmailForm(event) {
	event.preventDefault();
	const email = value("beta-approve-email");
	if (!email) return;
	await approveBetaAccess(email);
}

async function approveBetaRequest(id) {
	await run("Approving beta request…", async () => {
		await api(`/api/beta/admin/requests/${id}/approve`, { method: "POST" });
		await loadBetaAdminData();
		render();
	});
}

async function denyBetaRequest(id) {
	if (!confirm("Deny this beta access request?")) return;
	await run("Denying beta request…", async () => {
		await api(`/api/beta/admin/requests/${id}/deny`, { method: "POST" });
		await loadBetaAdminData();
		render();
	});
}

async function approveBetaAccess(email) {
	await run("Approving beta access…", async () => {
		await api("/api/beta/admin/access/approve", {
			method: "POST",
			body: { email },
		});
		await loadBetaAdminData();
		render();
	});
}

async function revokeBetaAccess(email) {
	if (!confirm(`Revoke beta access for ${email}? Active sessions will end.`)) {
		return;
	}
	await run("Revoking beta access…", async () => {
		await api("/api/beta/admin/access/revoke", {
			method: "POST",
			body: { email },
		});
		await loadBetaAdminData();
		render();
	});
}

async function filterJobs(event) {
	event.preventDefault();
	state.jobQuery = {
		...state.jobQuery,
		q: value("job-q"),
		company: value("job-company"),
		location: value("job-location"),
		region: value("job-region"),
		category: value("job-category"),
		industry: value("job-industry"),
		length: value("job-length"),
		term: value("job-term"),
		page: 1,
	};
	syncJobQueryToUrl();
	await run("Searching jobs…", async () => {
		state.jobs = await fetchJobs();
		render();
	});
}

async function clearJobFilters() {
	state.jobQuery = {
		...state.jobQuery,
		q: "",
		company: "",
		location: "",
		region: "",
		category: "",
		industry: "",
		length: "",
		term: "",
		page: 1,
	};
	syncJobQueryToUrl();
	await run("Clearing filters…", async () => {
		state.jobs = await fetchJobs();
		render();
	});
}

async function changeJobPage(page) {
	if (!Number.isInteger(page) || page < 1) return;
	state.jobQuery.page = page;
	syncJobQueryToUrl();
	await run("Loading jobs…", async () => {
		state.jobs = await fetchJobs();
		render();
		window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
	});
}

async function toggleSaved(id) {
	const job = findJob(id);
	if (job?.userState?.status === "SAVED") {
		return removeJobStatus(id);
	}
	return setJobStatus(id, "SAVED");
}

async function updateJobStatusFromSelect(id, status) {
	if (!status) return removeJobStatus(id);
	return setJobStatus(id, status);
}

async function setJobStatus(id, status) {
	await run(`Saving ${formatStatus(status).toLowerCase()} status…`, async () => {
		await api(`/api/jobs/${id}/state`, {
			method: "PUT",
			body: { status, notes: findJob(id)?.userState?.notes || "" },
		});
		await Promise.all([loadJobData(), loadAnalyticsData()]);
		render();
	});
}

async function removeJobStatus(id) {
	await run("Removing job from your tracker…", async () => {
		await api(`/api/jobs/${id}/state`, { method: "DELETE" });
		await Promise.all([loadJobData(), loadAnalyticsData()]);
		render();
	});
}

async function saveJobNotes(id) {
	const job = findJob(id);
	const status = job?.userState?.status;
	if (!job || !status) return;
	const notes = document.getElementById(`job-notes-${id}`)?.value?.trim() || "";
	await run("Saving application notes…", async () => {
		await api(`/api/jobs/${id}/state`, {
			method: "PUT",
			body: { status, notes },
		});
		await Promise.all([loadJobData(), loadAnalyticsData()]);
		render();
	});
}

async function beginJobNetworking(id) {
	if (!jobOutreachLinkingEnabled()) {
		return showToast(
			"Job-linked outreach is not enabled yet. Use Networking for an independent search.",
			true,
		);
	}
	if (state.networkingSearch.status === "running") return;
	const job = findJob(id);
	if (!job) return;
	state.networkingJob = job;
	state.networkingCriteria = structuredClone(job.discoveryCriteria);
	state.networkingSearch = { status: "idle", message: "", summary: null };
	state.tab = "networking";
	syncViewToUrl();
	await executeDiscovery(state.networkingCriteria);
}

async function findPeople(event) {
	event.preventDefault();
	await executeDiscovery(readDiscoveryCriteria());
}

async function executeDiscovery(criteria) {
	if (state.networkingSearch.status === "running" || !criteria) return;
	state.networkingCriteria = {
		...criteria,
		jobId:
			jobOutreachLinkingEnabled() && state.networkingJob
				? state.networkingJob.id
				: undefined,
	};
	state.networkingSearch = {
		status: "running",
		message: "",
		summary: null,
	};
	state.tab = "networking";
	render();
	document.getElementById("find-people-panel")?.scrollIntoView({
		behavior: preferredScrollBehavior(),
		block: "start",
	});
	try {
		const result = await api("/api/discovery", {
			method: "POST",
			body: state.networkingCriteria,
		});
		state.session = await api("/api/session");
		await Promise.all([
			loadJobData(),
			loadBetaAdminData(),
			loadAnalyticsData(),
		]);
		const summary = result.summary || {
			providerReturned: 0,
			accepted: 0,
			primaryProviderReturned: 0,
			primaryAccepted: 0,
			professionalBioProviderReturned: 0,
			professionalBioAccepted: 0,
			insufficientMatchRejected: 0,
			strongAccepted: 0,
			broaderAccepted: 0,
			fallbackProvider: "NONE",
			fallbackAttempted: false,
			fallbackStatus: "NOT_NEEDED",
			fallbackModel: "",
			fallbackHttpStatus: null,
			fallbackReturned: 0,
			fallbackAccepted: 0,
			inserted: result.prospects?.length || 0,
			duplicates: 0,
			rejected: 0,
		};
		if (summary.inserted > 0) {
			state.networkingSearch = {
				status: "success",
				message: discoverySuccessMessage(summary),
				summary,
			};
			render();
			showToast(
				`Found ${summary.inserted} new ${summary.inserted === 1 ? "person" : "people"} to review.`,
			);
			document.getElementById("approve-panel")?.scrollIntoView({
				behavior: preferredScrollBehavior(),
				block: "start",
			});
			return;
		}
		state.networkingSearch = {
			status: "empty",
			message: discoveryEmptyMessage(summary),
			summary,
		};
		render();
		document.getElementById("find-people-panel")?.scrollIntoView({
			behavior: preferredScrollBehavior(),
			block: "start",
		});
	} catch (error) {
		state.networkingSearch = {
			status: "error",
			message:
				error instanceof Error
					? error.message
					: "The search could not be completed.",
			summary: null,
		};
		render();
	}
}

function readDiscoveryCriteria() {
	return {
		roles: listValue("roles"),
		industries: listValue("industries"),
		companies: listValue("companies"),
		locations: listValue("locations"),
		keywords: listValue("keywords"),
		seniority: listValue("seniority"),
		objective: value("objective"),
		count: Number(value("count")),
	};
}

function discoverySuccessMessage(summary) {
	const details = [];
	if (summary.strongAccepted) {
		details.push(
			`${summary.strongAccepted} strong ${summary.strongAccepted === 1 ? "match" : "matches"}`,
		);
	}
	if (summary.broaderAccepted) {
		details.push(
			`${summary.broaderAccepted} broader company ${summary.broaderAccepted === 1 ? "match" : "matches"} requiring role review`,
		);
	}
	if (summary.fallbackAccepted) {
		details.push(
			`${summary.fallbackAccepted} cited ${fallbackProviderLabel(summary.fallbackProvider)} ${summary.fallbackAccepted === 1 ? "match" : "matches"}`,
		);
	}
	if (summary.duplicates) {
		details.push(
			`${summary.duplicates} already ${summary.duplicates === 1 ? "was" : "were"} tracked`,
		);
	}
	if (summary.rejected) {
		details.push(
			`${summary.rejected} ${summary.rejected === 1 ? "result was" : "results were"} not a usable public professional profile`,
		);
	}
	const fallbackFailure = discoveryFallbackFailureMessage(summary);
	return `${summary.inserted} new ${summary.inserted === 1 ? "person is" : "people are"} ready for approval${details.length ? `; ${details.join("; ")}` : ""}.${fallbackFailure ? ` ${fallbackFailure}` : ""}`;
}

function discoveryEmptyMessage(summary) {
	if (summary.fallbackStatus === "DISABLED") {
		return "Tavily found no usable public professional profiles. The optional cited provider fallback is disabled in Settings.";
	}
	if (summary.fallbackStatus === "MISSING_KEY") {
		const provider = fallbackProviderLabel(summary.fallbackProvider);
		return `The cited ${provider} fallback is selected, but no ${provider} API key is configured. Add your key under Settings or disable the fallback.`;
	}
	const fallbackFailure = discoveryFallbackFailureMessage(summary);
	if (fallbackFailure) return fallbackFailure;
	if (summary.providerReturned === 0) {
		return "The search provider returned no profiles. Edit the roles, company, or location below and retry.";
	}
	if (summary.insufficientMatchRejected > 0) {
		return `${summary.insufficientMatchRejected} ${summary.insufficientMatchRejected === 1 ? "candidate was" : "candidates were"} rejected because the profile did not match both the requested company and a professional role/topic. Edit the role terms or location and retry.`;
	}
	if (summary.accepted === 0 && summary.rejected > 0) {
		const stages = [];
		if (summary.primaryProviderReturned) {
			stages.push(
				`${summary.primaryProviderReturned} LinkedIn-focused ${summary.primaryProviderReturned === 1 ? "candidate" : "candidates"}`,
			);
		}
		if (summary.professionalBioProviderReturned) {
			stages.push(
				`${summary.professionalBioProviderReturned} public-bio ${summary.professionalBioProviderReturned === 1 ? "candidate" : "candidates"}`,
			);
		}
		return `The search returned ${stages.length ? stages.join(" and ") : `${summary.providerReturned} candidate results`}, but none were usable public professional profiles. Broaden the roles or location and retry.`;
	}
	if (summary.duplicates > 0) {
		return `No new people were added. ${summary.duplicates} matching ${summary.duplicates === 1 ? "profile is" : "profiles are"} already tracked and linked to this job. Edit the criteria to search for different roles.`;
	}
	return "No new people matched these criteria. Edit the fields below and retry.";
}

function discoveryFallbackFailureMessage(summary) {
	const provider = fallbackProviderLabel(summary.fallbackProvider);
	let message = "";
	if (summary.fallbackStatus === "RATE_LIMITED") {
		if (summary.fallbackProvider === "GEMINI") {
			message =
				"Gemini Search quota or rate limit was reached. Check the API project's billing and Search grounding quota, wait for reset, or choose another fallback provider.";
		} else if (summary.fallbackProvider === "OPENAI") {
			message =
				"OpenAI Web Search quota or rate limit was reached. Check the API project's billing and Web Search limits, wait for reset, or choose another fallback provider.";
		} else if (summary.fallbackProvider === "ANTHROPIC") {
			message =
				"Anthropic Web Search quota or rate limit was reached. Check the API account's billing and Web Search limits, wait for reset, or choose another fallback provider.";
		}
	} else if (summary.fallbackStatus === "AUTH") {
		message = `${provider} rejected the configured API key. Update the key in Settings or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "BAD_REQUEST") {
		message = `${provider} rejected the search request. Verify the configured model and web-search settings, or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "UNSUPPORTED") {
		message = `The configured ${provider} model or account does not support the required web-search tool. Choose a search-capable model or another fallback provider.`;
	} else if (summary.fallbackStatus === "TIMEOUT") {
		message = `${provider} timed out before returning cited profiles. Retry once later or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "MALFORMED_RESPONSE") {
		message = `${provider} returned an unusable cited-profile response. Retry once or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "PROVIDER_ERROR") {
		message = `${provider} could not complete the cited search. Check the provider's service and web-search availability before retrying.`;
	}
	return message ? `${message} Tavily results were preserved.` : "";
}

function fallbackProviderLabel(provider) {
	return (
		{
			GEMINI: "Gemini Google Search",
			OPENAI: "OpenAI Web Search",
			ANTHROPIC: "Anthropic Web Search",
		}[provider] || "provider search"
	);
}

async function prepare(id) {
	await run("Preparing encrypted enrichment and draft…", async () => {
		await api(`/api/prospects/${id}/prepare`, { method: "POST" });
		await refresh("networking");
	});
}

async function reject(id) {
	if (!confirm("Reject this person?")) return;
	await run("Updating prospect…", async () => {
		await api(`/api/prospects/${id}/reject`, { method: "POST" });
		await refresh("networking");
	});
}

async function regenerate(id) {
	if (!confirm("Replace the current draft? No email will be sent.")) return;
	await run("Regenerating recipient-focused draft…", async () => {
		await api(`/api/prospects/${id}/regenerate`, { method: "POST" });
		await refresh("networking");
	});
}

function openDraft(id) {
	const prospect = state.session.prospects.find((item) => item.id === id);
	if (!prospect) return;
	document.getElementById("draft-id").value = prospect.id;
	document.getElementById("draft-version").value = prospect.draftVersion;
	document.getElementById("draft-name").textContent =
		`Review outreach to ${prospect.fullName}`;
	document.getElementById("draft-email").value = prospect.email;
	document.getElementById("draft-subject").value = prospect.subject;
	document.getElementById("draft-body").value = prospect.draftBody;
	document.getElementById("draft-audit").textContent =
		prospect.personalizationNotes || "No personalization audit was returned.";
	const attachmentRow = document.getElementById("resume-attachment-row");
	const attachmentInput = document.getElementById("attach-resume");
	const attachmentLabel = document.getElementById("resume-attachment-label");
	const hasResume = Boolean(state.session.resume?.configured);
	attachmentRow.hidden = !hasResume;
	attachmentInput.checked = false;
	attachmentInput.disabled = !hasResume;
	attachmentLabel.textContent = hasResume
		? `Attach ${state.session.resume.fileName}`
		: "Attach resume";
	dialog.showModal();
}

async function saveDraft() {
	const id = value("draft-id");
	await run("Saving draft…", async () => {
		await api(`/api/prospects/${id}/draft`, {
			method: "PATCH",
			body: {
				email: value("draft-email"),
				subject: value("draft-subject"),
				body: value("draft-body"),
			},
		});
		dialog.close();
		await refresh("networking");
	});
}

async function sendDraft() {
	const id = value("draft-id");
	const email = value("draft-email");
	const attachResume = Boolean(
		document.getElementById("attach-resume")?.checked,
	);
	if (!email) return showToast("A verified recipient email is required.", true);
	if (
		!confirm(
			`Send this exact email${attachResume ? " with your resume attached" : ""} now to ${email}?`,
		)
	) {
		return;
	}
	await run("Sending through your Gmail account…", async () => {
		await api(`/api/prospects/${id}/send`, {
			method: "POST",
			body: {
				expectedVersion: Number(value("draft-version")),
				idempotencyKey: crypto.randomUUID(),
				attachResume,
			},
		});
		dialog.close();
		await refresh("networking");
	});
}

async function importLegacyState(event) {
	event.preventDefault();
	let payload;
	try {
		payload = JSON.parse(value("legacy-import-json"));
	} catch {
		return showToast("Paste a valid Internship Tracker JSON export.", true);
	}
	await run("Importing saved jobs and applications…", async () => {
		const result = await api("/api/job-states/import-legacy", {
			method: "POST",
			body: payload,
		});
		await Promise.all([loadJobData(), loadAnalyticsData()]);
		render();
		if (!result.completed) {
			return showToast(
				`No jobs matched yet. The import remains available to retry after the catalog refreshes.`,
				true,
			);
		}
		showToast(
			`${result.idempotent ? "Previously imported" : "Imported"} ${result.imported} jobs. ${result.unmatched} could not be matched.`,
			result.unmatched > 0,
		);
	});
}

async function uploadResume(event) {
	event.preventDefault();
	const input = document.getElementById("resume-file");
	const file = input.files?.[0];
	if (!file) return showToast("Choose a resume file first.", true);
	if (file.size > 5 * 1024 * 1024) {
		return showToast("Resume files must be 5 MB or smaller.", true);
	}
	const formData = new FormData();
	formData.append("resume", file);
	showToast("Encrypting and analyzing your resume…");
	try {
		const result = await api("/api/resume", {
			method: "POST",
			body: formData,
		});
		state.session.resume = result.resume;
		await loadAnalyticsData();
		render();
		fillResumeSuggestions(result.suggestions);
		showToast(
			"Resume analyzed. Review the filled fields, then click Save settings.",
		);
	} catch (error) {
		showToast(error.message, true);
	}
}

async function removeResume() {
	if (
		!confirm(
			"Delete the encrypted resume? Existing profile fields will remain.",
		)
	) {
		return;
	}
	await run("Deleting encrypted resume…", async () => {
		await api("/api/resume", { method: "DELETE" });
		await refresh("settings");
	});
}

function fillResumeSuggestions(suggestions) {
	const values = [
		["sender-name", suggestions.senderName],
		["background", suggestions.backgroundSummary],
		["current-goal", suggestions.currentGoal],
		["experience", suggestions.experienceToReference],
	];
	for (const [id, suggestion] of values) {
		if (suggestion) document.getElementById(id).value = suggestion;
	}
	document.getElementById("background")?.focus();
}

async function saveSettings(event) {
	event.preventDefault();
	await run("Saving settings…", async () => {
		await api("/api/settings", {
			method: "PUT",
			body: {
				senderName: value("sender-name"),
				discoveryProvider: "TAVILY",
				enrichmentProvider: value("enrichment-provider"),
				draftProvider: value("draft-provider"),
				geminiModel: value("gemini-model"),
				openAiModel: value("openai-model"),
				anthropicModel: value("anthropic-model"),
				peopleSearchFallbackProvider: value(
					"people-search-fallback-provider",
				),
				outreachGoal: value("outreach-goal"),
				emailWordLimit: Number(value("word-limit")),
				personalContext: [
					{ category: "Background summary", content: value("background") },
					{ category: "Current goal", content: value("current-goal") },
					{
						category: "Experience to reference",
						content: value("experience"),
					},
					{
						category: "Tone",
						content: "Warm, concise, curious, and respectful.",
					},
					{
						category: "Avoid",
						content: "Never invent facts or shared connections.",
					},
				],
				replySyncEnabled: true,
			},
		});
		await refresh("settings");
	});
}

async function saveSecret(provider) {
	const input = document.getElementById(`secret-${provider}`);
	if (!input.value.trim()) return showToast("Enter a key first.", true);
	await run(`Encrypting ${provider} credential…`, async () => {
		await api(`/api/credentials/${provider}`, {
			method: "PUT",
			body: { value: input.value.trim() },
		});
		input.value = "";
		await refresh("settings");
	});
}

async function deleteSecret(provider) {
	if (!confirm(`Delete the encrypted ${provider} credential?`)) return;
	await run(`Deleting ${provider} credential…`, async () => {
		await api(`/api/credentials/${provider}`, { method: "DELETE" });
		await refresh("settings");
	});
}

async function initWorkspace() {
	await run("Creating your Google Sheet CRM…", async () => {
		await api("/api/workspace/init", { method: "POST" });
		await refresh("settings");
	});
}

async function logout() {
	await api("/logout", { method: "POST" });
	location.reload();
}

async function refresh(tab = state.tab) {
	state.session = await api("/api/session");
	state.tab = state.session.authenticated ? tab : "jobs";
	if (!betaLandingRequired()) {
		await Promise.all([
			loadJobData(),
			loadBetaAdminData(),
			loadAnalyticsData(),
		]);
	} else {
		state.betaAdmin = null;
		state.analytics = null;
	}
	render();
}

async function loadJobData() {
	const requests = [fetchJobs()];
	if (state.session?.authenticated) requests.push(fetchTrackedJobs());
	const [jobs, trackedJobs] = await Promise.all(requests);
	state.jobs = jobs;
	state.trackedJobs = trackedJobs || {
		jobs: [],
		pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
	};
	if (!jobOutreachLinkingEnabled()) {
		state.networkingJob = null;
	}
	if (state.networkingJob) {
		state.networkingJob =
			findJob(state.networkingJob.id) || state.networkingJob;
	}
}

async function fetchJobs() {
	const query = new URLSearchParams();
	for (const [key, entry] of Object.entries(state.jobQuery)) {
		if (entry !== "") query.set(key, String(entry));
	}
	return api(`/api/jobs?${query}`);
}

async function fetchTrackedJobs() {
	return api("/api/job-states?page=1&pageSize=100");
}

function loadJobQueryFromUrl() {
	const params = new URLSearchParams(location.search);
	for (const key of [
		"q",
		"company",
		"location",
		"region",
		"category",
		"industry",
		"length",
		"term",
	]) {
		state.jobQuery[key] = params.get(key) || "";
	}
	const page = Number(params.get("page") || 1);
	state.jobQuery.page =
		Number.isInteger(page) && page >= 1 && page <= 100 ? page : 1;
}

function syncJobQueryToUrl() {
	const url = new URL(location.href);
	for (const key of [
		"q",
		"company",
		"location",
		"region",
		"category",
		"industry",
		"length",
		"term",
		"page",
	]) {
		url.searchParams.delete(key);
	}
	for (const key of [
		"q",
		"company",
		"location",
		"region",
		"category",
		"industry",
		"length",
		"term",
	]) {
		if (state.jobQuery[key]) {
			url.searchParams.set(key, state.jobQuery[key]);
		}
	}
	if (state.jobQuery.page > 1) {
		url.searchParams.set("page", String(state.jobQuery.page));
	}
	history.replaceState(null, "", url);
}

async function loadBetaAdminData() {
	if (!state.session?.authenticated || !state.session.isBetaAdmin) {
		state.betaAdmin = null;
		return;
	}
	state.betaAdmin = await api("/api/beta/admin/access");
}

async function loadAnalyticsData() {
	if (!state.session?.authenticated) {
		state.analytics = null;
		state.analyticsError = "";
		return;
	}
	try {
		state.analytics = await api("/api/analytics");
		state.analyticsError = "";
	} catch (error) {
		state.analytics = null;
		state.analyticsError =
			error instanceof Error
				? error.message
				: "Analytics could not be loaded.";
	}
}

function betaLandingRequired() {
	return (
		!state.session?.authenticated &&
		state.session?.betaAccessMode === "ALLOWLIST"
	);
}

function initialView() {
	const requested = location.hash.replace(/^#/, "");
	if (PRIMARY_VIEWS.includes(requested)) return requested;
	const hasJobQuery = [
		"q",
		"company",
		"location",
		"region",
		"category",
		"industry",
		"length",
		"term",
		"page",
	].some((key) => new URLSearchParams(location.search).has(key));
	return hasJobQuery ? "jobs" : "home";
}

function navigate(view) {
	const allowed =
		state.session?.authenticated && PRIMARY_VIEWS.includes(view)
			? view
			: "jobs";
	state.tab = allowed;
	state.mobileNavOpen = false;
	syncViewToUrl();
	render();
	requestAnimationFrame(() => {
		document.getElementById("main-content")?.focus({ preventScroll: true });
		window.scrollTo({ top: 0, behavior: "auto" });
	});
}

function syncViewToUrl() {
	const url = new URL(location.href);
	url.hash = state.tab === "home" ? "" : state.tab;
	history.replaceState(null, "", url);
}

function journeyMetrics() {
	return window.CareerJourney.deriveJourneyMetrics({
		trackedJobs: state.trackedJobs.jobs,
		prospects: state.session?.prospects || [],
	});
}

async function mountJourneyScene(renderToken) {
	const container = document.getElementById("journey-canvas");
	if (!container) return;
	try {
		journeyModulePromise ||= import("/journey-scene.js?v=20261001-1");
		const module = await journeyModulePromise;
		if (
			renderToken !== state.renderToken ||
			state.tab !== "home" ||
			container !== document.getElementById("journey-canvas")
		) {
			return;
		}
		journeyController = module.createJourneyScene({
			container,
			metrics: journeyMetrics(),
			onFocus: (area) => openJourneyDetail(area, false),
			onHover: highlightJourneyControl,
			onReady: () => {
				container.setAttribute("aria-busy", "false");
				const fallback = document.getElementById("journey-fallback");
				if (fallback) fallback.hidden = true;
			},
			onError: () => {
				container.setAttribute("aria-busy", "false");
				container.classList.add("webgl-fallback");
			},
		});
		if (state.journeyFocus !== "journey") {
			journeyController.focus(state.journeyFocus);
		}
	} catch {
		if (renderToken !== state.renderToken) return;
		container.setAttribute("aria-busy", "false");
		container.classList.add("webgl-fallback");
	}
}

function destroyJourneyScene() {
	journeyController?.dispose();
	journeyController = null;
}

function openJourneyDetail(area, focusScene) {
	if (!window.CareerJourney.AREAS.includes(area)) return;
	state.journeyFocus = area;
	const detail = window.CareerJourney.detailFor(area, journeyMetrics());
	const container = document.getElementById("journey-detail");
	if (container) {
		container.innerHTML = renderJourneyDetail(detail);
		wireJourneyAction();
	}
	document.querySelectorAll("[data-journey-target]").forEach((button) => {
		button.classList.toggle("active", button.dataset.journeyTarget === area);
	});
	if (focusScene) journeyController?.focus(area);
}

function wireJourneyAction() {
	const button = document.querySelector("[data-journey-action]");
	button?.addEventListener("click", () => {
		if (button.dataset.journeyMode) {
			state.jobMode = button.dataset.journeyMode;
		}
		navigate(button.dataset.journeyAction);
	});
}

function highlightJourneyControl(area) {
	document.querySelectorAll("[data-journey-target]").forEach((button) => {
		button.classList.toggle("hovered", button.dataset.journeyTarget === area);
	});
}

async function run(message, callback) {
	showToast(message);
	try {
		await callback();
		if (toast.textContent === message) showToast("Done.");
	} catch (error) {
		showToast(error.message, true);
	}
}

async function api(path, options = {}) {
	const headers = { Accept: "application/json" };
	const method = options.method || "GET";
	const isFormData = options.body instanceof FormData;
	if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
		headers["X-CSRF-Token"] = cookie(state.session?.csrfCookieName);
	}
	if (options.body !== undefined && !isFormData) {
		headers["Content-Type"] = "application/json";
	}
	const response = await fetch(path, {
		method,
		headers,
		body:
			options.body === undefined
				? undefined
				: isFormData
					? options.body
					: JSON.stringify(options.body),
		credentials: "same-origin",
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.message || `Request failed (${response.status}).`);
	}
	return data;
}

function renderCatalogWarning() {
	const catalog = state.jobs.catalog;
	if (!catalog || catalog.state === "fresh") return "";
	if (catalog.state === "never-imported") {
		return `<section class="notice warning catalog-warning">
			<strong>Internship catalog has not refreshed yet.</strong>
			<span>Browsing remains available, but there may be no current postings until the first signed snapshot is imported.</span>
		</section>`;
	}
	const ageHours = Math.max(0, Number(catalog.ageSeconds || 0) / 3600);
	return `<section class="notice warning catalog-warning">
		<strong>Internship listings may be out of date.</strong>
		<span>The latest snapshot was generated ${escapeHtml(formatDate(catalog.generatedAt))} (${ageHours.toFixed(1)} hours ago). You can continue browsing while the publisher is checked.</span>
	</section>`;
}

function jobOutreachLinkingEnabled() {
	return state.jobs.features?.jobOutreachLinking === true;
}

function jobCard(job) {
	const status = job.userState?.status;
	const sourceLabel = JobSourceUi.sourceLabel(job.source);
	const sourceAttribution = JobSourceUi.attributionHtml(job.source);
	const posted = job.postedAt
		? `Posted ${formatDateOnly(job.postedAt)}`
		: job.postedText || "Posting date unavailable";
	const outreach = job.outreachSummary;
	return `<article class="card job-card ${job.active ? "" : "inactive-job"}">
		<div class="job-card-heading">
			<div class="company-tile company-tone-${companyTone(job.company)}" aria-hidden="true">${escapeHtml(companyInitials(job.company))}</div>
			<div class="job-card-title">
				<p class="job-company">${escapeHtml(job.company)}</p>
				<h3>${escapeHtml(job.title)}</h3>
				<p>${icon("pin")}${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Location not listed")}</p>
			</div>
			${status ? `<span class="status status-${status.toLowerCase()}">${formatStatus(status)}</span>` : ""}
		</div>
		<div class="job-meta">
			<span>${icon("source")}${escapeHtml(sourceLabel)}</span>
			<span>${icon("calendar")}${escapeHtml(posted)}</span>
		</div>
		<div class="chips job-tags">
			${job.industry && job.industry !== "Other" ? `<span class="chip">${escapeHtml(job.industry)}</span>` : ""}
			${job.lengthLabel ? `<span class="chip">${escapeHtml(job.lengthLabel)}</span>` : ""}
			${job.term?.label ? `<span class="chip">${escapeHtml(job.term.label)}</span>` : ""}
			${job.categories.slice(0, 2).map((category) => `<span class="chip">${escapeHtml(category)}</span>`).join("")}
			${job.active ? "" : '<span class="chip chip-warning">No longer active</span>'}
		</div>
		${job.description ? `<p class="job-description">${escapeHtml(truncate(job.description, state.jobLayout === "list" ? 220 : 300))}</p>` : ""}
		${
			state.session?.authenticated && outreach
				? `<div class="outreach-summary">
						<strong>${icon("people")} Outreach</strong>
						<span>${outreach.total} linked</span>
						<span>${outreach.draftReady} drafts</span>
						<span>${outreach.sent} sent</span>
						<span>${outreach.replied} replies</span>
					</div>`
				: ""
		}
		${sourceAttribution}
		<div class="job-controls">
			<a class="button primary" href="${escapeAttr(job.url)}" target="_blank" rel="noopener">View posting ${icon("external")}</a>
			${
				state.session?.authenticated
					? `${!status || status === "SAVED" ? `<button data-job-save="${job.id}">${icon("bookmark")}${status === "SAVED" ? "Unsave" : "Save"}</button>` : ""}
						<button data-job-apply="${job.id}" ${APPLICATION_STATUSES.includes(status) ? "disabled" : ""}>${icon("check")} Mark applied</button>
						${jobOutreachLinkingEnabled() ? `<button class="secondary" data-job-network="${job.id}" ${state.networkingSearch.status === "running" ? "disabled" : ""}>${icon("people")} Find people</button>` : ""}
						<label class="job-stage">Stage
							<select data-job-status="${job.id}">
								${jobStatusOptions(status)}
							</select>
						</label>`
					: '<a class="button" href="/auth/google/login">Sign in to save</a>'
			}
		</div>
	</article>`;
}

function applicationCard(job) {
	const status = job.userState?.status || "";
	const outreach = job.outreachSummary;
	return `<article class="application-card">
		<div class="application-main">
			<div class="company-tile company-tone-${companyTone(job.company)}" aria-hidden="true">${escapeHtml(companyInitials(job.company))}</div>
			<div>
				<p class="job-company">${escapeHtml(job.company)}</p>
				<h3>${escapeHtml(job.title)}</h3>
				<p class="application-meta">${icon("pin")}${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Location not listed")}<span>Updated ${formatDate(job.userState.updatedAt)}</span></p>
			</div>
		</div>
		<div class="application-stage-cell">
			<span class="status status-${status.toLowerCase()}">${formatStatus(status)}</span>
			<label>Stage
				<select data-job-status="${job.id}">${jobStatusOptions(status)}</select>
			</label>
		</div>
		<div class="application-notes">
			<label for="job-notes-${job.id}">Next step or notes
				<textarea id="job-notes-${job.id}" rows="3" placeholder="Add a private note">${escapeHtml(job.userState.notes || "")}</textarea>
			</label>
			<button data-save-job-notes="${job.id}">${icon("save")} Save notes</button>
		</div>
		<div class="application-actions">
			<a class="button" href="${escapeAttr(job.url)}" target="_blank" rel="noopener">Job ${icon("external")}</a>
			${jobOutreachLinkingEnabled() ? `<button class="secondary" data-job-network="${job.id}">${icon("people")} Find people</button>` : ""}
			${outreach ? `<span class="application-outreach">${outreach.total} linked · ${outreach.replied} ${outreach.replied === 1 ? "reply" : "replies"}</span>` : ""}
		</div>
	</article>`;
}

function applicationFilterButton(status, label, explicitCount) {
	const count =
		explicitCount ??
		state.trackedJobs.jobs.filter(
			(job) => job.userState?.status === status,
		).length;
	return `<button data-application-filter="${status}" class="${state.applicationFilter === status ? "active" : ""}">${escapeHtml(label)} <span>${count}</span></button>`;
}

function prospectCard(person, profileReady) {
	const profileUrl = person.linkedinUrl || person.sourceUrl;
	const profileLabel = person.linkedinUrl ? "LinkedIn profile" : "Public profile";
	return `<article class="card">
		<div class="card-head">
			<div>
				<h3>${escapeHtml(person.fullName)}</h3>
				<p>${escapeHtml([person.title, person.company].filter(Boolean).join(" at ") || "Professional profile")}</p>
			</div>
			<span class="status status-${person.status.toLowerCase()}">${formatStatus(person.status)}</span>
		</div>
		<div class="chips">
			<span class="chip">Relevance ${person.relevanceScore}/100</span>
			${person.email ? '<span class="chip">Email found</span>' : ""}
			${person.matchQuality === "STRONG" ? '<span class="chip chip-strong">Strong match</span>' : ""}
			${person.matchQuality === "BROADER_COMPANY" ? '<span class="chip chip-warning">Broader match</span>' : ""}
			${linkedJobChips(person)}
		</div>
		${person.matchQuality === "BROADER_COMPANY" ? '<p class="notice warning"><strong>Broader company match — review role relevance.</strong> The profile matches the employer and a professional/location or hiring signal, but not the exact target role/topic.</p>' : ""}
		<p>${escapeHtml(person.whyRelevant || person.sourceSnippet)}</p>
		${person.errorMessage ? `<p class="notice danger">${escapeHtml(person.errorMessage)}</p>` : ""}
		<div class="actions">
			<button class="secondary" data-prepare="${person.id}" ${profileReady ? "" : "disabled"}>Approve & prepare</button>
			<button class="danger" data-reject="${person.id}">Reject</button>
			${profileUrl ? `<a class="button" href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener">${profileLabel}</a>` : ""}
		</div>
	</article>`;
}

function draftCard(person) {
	return `<article class="card">
		<div class="card-head">
			<div>
				<h3>${escapeHtml(person.fullName)}</h3>
				<p>${escapeHtml([person.title, person.company].filter(Boolean).join(" at "))}</p>
			</div>
			<span class="status status-draft_ready">Draft ready</span>
		</div>
		<div class="chips">
			<span class="chip">${person.email ? escapeHtml(person.email) : "Email needed"}</span>
			<span class="chip">v${person.draftVersion}</span>
			<span class="chip">${escapeHtml(person.draftProvider)}</span>
			${linkedJobChips(person)}
		</div>
		<p><strong>${escapeHtml(person.subject)}</strong></p>
		<p>${escapeHtml(truncate(person.draftBody, 220))}</p>
		${person.errorMessage ? `<p class="notice danger">${escapeHtml(person.errorMessage)}</p>` : ""}
		<div class="actions">
			<button class="primary" data-review="${person.id}">Review</button>
			<button data-regenerate="${person.id}">Regenerate</button>
		</div>
	</article>`;
}

function pipelineCard(person) {
	return `<article class="card">
		<div class="card-head">
			<div>
				<h3>${escapeHtml(person.fullName)}</h3>
				<p>${escapeHtml(person.email)}</p>
			</div>
			<span class="status status-${person.status.toLowerCase()}">${formatStatus(person.status)}</span>
		</div>
		<div class="chips">${linkedJobChips(person)}</div>
		${person.sentAt ? `<p>Sent ${formatDate(person.sentAt)}</p>` : ""}
		${person.lastReplyAt ? `<p class="notice">Reply ${formatDate(person.lastReplyAt)}: ${escapeHtml(person.replySnippet)}</p>` : ""}
		${person.errorMessage ? `<p class="notice danger">${escapeHtml(person.errorMessage)}</p>` : ""}
	</article>`;
}

function linkedJobChips(person) {
	return (person.linkedJobs || [])
		.map(
			(job) =>
				`<span class="chip">From ${escapeHtml(job.title)} at ${escapeHtml(job.company)}</span>`,
		)
		.join("");
}

function secretRow(provider, label, status) {
	return `<div class="secret-row">
		<div>
			<strong>${label}</strong><br />
			<small>${status.configured ? `Configured ${escapeHtml(status.hint)}` : "Not configured"}</small>
		</div>
		<input id="secret-${provider}" type="password" autocomplete="off" placeholder="${status.configured ? "Leave blank to keep current key" : "Enter API key"}" />
		<div class="actions">
			<button data-save-secret="${provider}">Save</button>
			<button class="danger" data-delete-secret="${provider}" ${status.configured ? "" : "disabled"}>Delete</button>
		</div>
	</div>`;
}

function renderPagination(pagination) {
	if (pagination.totalPages <= 1) return "";
	return `<nav class="pagination" aria-label="Job results pages">
		<button data-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Previous</button>
		<span>Page ${pagination.page} of ${pagination.totalPages}</span>
		<button data-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Next</button>
	</nav>`;
}

function jobStatusOptions(current) {
	const options = [
		["", "Not tracked"],
		["SAVED", "Saved"],
		["APPLIED", "Applied"],
		["INTERVIEWING", "Interviewing"],
		["OFFER", "Offer"],
		["REJECTED", "Rejected"],
		["ARCHIVED", "Archived"],
	];
	return options
		.map(
			([entry, label]) =>
				`<option value="${entry}" ${selected(current || "", entry)}>${label}</option>`,
		)
		.join("");
}

function facetOptions(options, current, emptyLabel) {
	const normalized = (options || []).map((option) => ({
		...option,
		value: String(option.value),
	}));
	const selectedValue = String(current || "");
	if (
		selectedValue &&
		!normalized.some((option) => option.value === selectedValue)
	) {
		normalized.push({
			value: selectedValue,
			label: selectedValue,
			count: 0,
		});
	}
	return [
		`<option value="">${escapeHtml(emptyLabel)}</option>`,
		...normalized.map(
			(option) =>
				`<option value="${escapeAttr(option.value)}" ${selected(selectedValue, option.value)}>${escapeHtml(option.label)} (${Number(option.count || 0)})</option>`,
		),
	].join("");
}

function findJob(id) {
	return (
		state.jobs.jobs.find((job) => job.id === id) ||
		state.trackedJobs.jobs.find((job) => job.id === id) ||
		null
	);
}

function contextValue(category) {
	return (
		state.session.settings.personalContext.find(
			(item) => item.category === category,
		)?.content || ""
	);
}

function legalLinks() {
	return `<footer class="site-footer">
		<a href="/privacy.html">Privacy Policy</a>
		<span aria-hidden="true">·</span>
		<a href="/terms.html">Terms of Service</a>
		<span aria-hidden="true">·</span>
		<a href="mailto:evanastonlowe@gmail.com">Contact</a>
	</footer>`;
}

function isDraftProfileReady(settings) {
	return (
		Boolean(settings.senderName?.trim()) &&
		settings.personalContext.some(
			(item) =>
				item.content?.trim() &&
				!["tone", "avoid"].includes(item.category?.trim().toLowerCase()),
		)
	);
}

function providerOptions(selectedProvider) {
	return [
		["TEMPLATE", "Built-in template"],
		["GEMINI", "Google Gemini"],
		["OPENAI", "OpenAI"],
		["ANTHROPIC", "Anthropic Claude"],
	]
		.map(
			([entry, label]) =>
				`<option value="${entry}" ${selected(selectedProvider, entry)}>${label}</option>`,
		)
		.join("");
}

function pageHeader(eyebrow, title, description, actions) {
	return `<section class="page-heading">
		<div>
			<p class="eyebrow">${escapeHtml(eyebrow)}</p>
			<h1>${escapeHtml(title)}</h1>
			<p>${escapeHtml(description)}</p>
		</div>
		${actions || ""}
	</section>`;
}

function stat(entry, label, iconName = "spark") {
	return `<article class="stat"><span class="stat-icon" aria-hidden="true">${icon(iconName)}</span><div><strong>${Number(entry || 0)}</strong><span>${escapeHtml(label)}</span></div></article>`;
}

function textarea(id, label, initialValue) {
	return `<label>${label}<textarea id="${id}" rows="3">${escapeHtml(initialValue)}</textarea></label>`;
}

function empty(message) {
	return `<div class="empty">${icon("compass")}<strong>Nothing to show yet</strong><span>${escapeHtml(message)}</span></div>`;
}

function companyInitials(company) {
	const words = String(company || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return "—";
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function companyTone(company) {
	return (
		Array.from(String(company || "")).reduce(
			(total, character) => total + character.charCodeAt(0),
			0,
		) % 6
	);
}

function userInitials(user) {
	const source = String(user?.name || user?.email || "CJ");
	const words = source.trim().split(/\s+/).filter(Boolean);
	return (words.length > 1
		? `${words[0][0]}${words[words.length - 1][0]}`
		: words[0]?.slice(0, 2) || "CJ"
	).toUpperCase();
}

function activityIcon(action) {
	if (String(action).startsWith("JOB_")) return "briefcase";
	if (String(action).includes("DRAFT")) return "edit";
	if (String(action).includes("EMAIL")) return "send";
	if (String(action).includes("DISCOVERY")) return "search";
	if (String(action).includes("RESUME")) return "document";
	if (String(action).includes("SETTING")) return "settings";
	return "spark";
}

function icon(name) {
	const paths = {
		home: '<path d="M3 10.5 10 4l7 6.5v6.2a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 16.7Z"/><path d="M7.5 18v-5h5v5"/>',
		briefcase: '<rect x="2.5" y="6" width="15" height="10.5" rx="2"/><path d="M7 6V4.5h6V6M2.5 10.5h15M8 10.5v2h4v-2"/>',
		layers: '<path d="m10 3 7 4-7 4-7-4 7-4Z"/><path d="m3 11 7 4 7-4M3 15l7 4 7-4"/>',
		people: '<circle cx="7" cy="7" r="3"/><path d="M1.8 17c.5-3 2.2-4.5 5.2-4.5s4.7 1.5 5.2 4.5M13 4.5a3 3 0 0 1 0 5.8M14.3 12.8c2.2.3 3.5 1.7 3.9 4.2"/>',
		chart: '<path d="M3 17V9M8 17V5M13 17v-7M18 17V3"/><path d="M2 17.5h17"/>',
		settings: '<circle cx="10" cy="10" r="2.6"/><path d="M16.7 11.2v-2.4l-2-.5-.6-1.4 1-1.8-1.7-1.7-1.8 1-1.4-.6-.5-2H7.3l-.5 2-1.4.6-1.8-1-1.7 1.7 1 1.8-.6 1.4-2 .5v2.4l2 .5.6 1.4-1 1.8 1.7 1.7 1.8-1 1.4.6.5 2h2.4l.5-2 1.4-.6 1.8 1 1.7-1.7-1-1.8.6-1.4 2-.5Z"/>',
		menu: '<path d="M3 5h14M3 10h14M3 15h14"/>',
		"chevron-left": '<path d="m12.5 4-6 6 6 6"/>',
		"chevron-right": '<path d="m7.5 4 6 6-6 6"/>',
		"chevron-down": '<path d="m4 7 6 6 6-6"/>',
		bookmark: '<path d="M5 3.5h10v14l-5-3-5 3v-14Z"/>',
		progress: '<path d="M10 2.5a7.5 7.5 0 1 0 7.5 7.5H10V2.5Z"/><path d="M13 3.2a7.5 7.5 0 0 1 3.8 3.8H13V3.2Z"/>',
		calendar: '<rect x="2.5" y="4.5" width="15" height="13" rx="2"/><path d="M6 2.5v4M14 2.5v4M2.5 8.5h15"/>',
		spark: '<path d="m10 2 1.5 5.2L17 9l-5.5 1.8L10 16l-1.5-5.2L3 9l5.5-1.8L10 2Z"/>',
		cup: '<path d="M4 6h10v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6Z"/><path d="M14 8h1.5a2.5 2.5 0 0 1 0 5H14M6 3.5c0 1 1 1 1 2M10 3.5c0 1 1 1 1 2"/>',
		laptop: '<rect x="4" y="3" width="12" height="9" rx="1"/><path d="M2 15h16l-1 2H3l-1-2Z"/>',
		notebook: '<rect x="5" y="2.5" width="11" height="15" rx="1.5"/><path d="M8 2.5v15M3.5 5h3M3.5 9h3M3.5 13h3"/>',
		plant: '<path d="M10 18v-8M10 12c-3.5 0-5.5-2-5.5-5.5 3.5 0 5.5 2 5.5 5.5ZM10 10c0-3.5 2-5.5 5.5-5.5 0 3.5-2 5.5-5.5 5.5ZM6 18h8l-1 2H7l-1-2Z"/>',
		path: '<path d="M3 17c2-5 5-2 7-7s5-2 7-7"/><circle cx="3" cy="17" r="1.3"/><circle cx="10" cy="10" r="1.3"/><path d="M17 3v5M17 3h3l-1 2 1 2h-3"/>',
		reset: '<path d="M4 7V3m0 0h4M4 3l3 3a6 6 0 1 1-1.2 8.9"/>',
		compass: '<circle cx="10" cy="10" r="8"/><path d="m13.5 6.5-2 5-5 2 2-5 5-2Z"/>',
		filter: '<path d="M3 4h14l-5.5 6v5l-3 1.5V10L3 4Z"/>',
		grid: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
		list: '<path d="M7 5h10M7 10h10M7 15h10"/><circle cx="3.5" cy="5" r=".8"/><circle cx="3.5" cy="10" r=".8"/><circle cx="3.5" cy="15" r=".8"/>',
		search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
		edit: '<path d="m4 14.5-.5 3 3-.5L16 7.5 13.5 5 4 14.5Z"/><path d="m12 6.5 2.5 2.5"/>',
		send: '<path d="m2.5 3 15 7-15 7 2-6.5L13 10 4.5 9.5 2.5 3Z"/>',
		reply: '<path d="m8 5-5 5 5 5v-3c4 0 6.5 1.2 9 4-1-6-4-8-9-8V5Z"/>',
		google: '<circle cx="10" cy="10" r="7"/><path d="M17 10h-7v3h4.2"/>',
		document: '<path d="M5 2.5h7l3 3v12H5v-15Z"/><path d="M12 2.5v3h3M7.5 10h5M7.5 13h5"/>',
		shield: '<path d="M10 2.5 17 5v4.5c0 4.2-2.7 6.8-7 8.5-4.3-1.7-7-4.3-7-8.5V5l7-2.5Z"/><path d="m7 10 2 2 4-4"/>',
		external: '<path d="M11 3h6v6M17 3l-8 8"/><path d="M15 11v5H4V5h5"/>',
		logout: '<path d="M8 3H4v14h4M12 6l4 4-4 4M7 10h9"/>',
		source: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z"/>',
		pin: '<path d="M10 18s5-4.7 5-10a5 5 0 1 0-10 0c0 5.3 5 10 5 10Z"/><circle cx="10" cy="8" r="1.8"/>',
		check: '<path d="m3.5 10.5 4 4 9-9"/>',
		save: '<path d="M4 3h10l2 2v12H4V3Z"/><path d="M7 3v5h6V3M7 17v-5h6v5"/>',
	};
	const body = paths[name] || paths.spark;
	return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${body}</svg>`;
}

function listValue(id) {
	return value(id)
		.split(/[\n,;]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function value(id) {
	return document.getElementById(id)?.value?.trim() || "";
}

function cookie(name) {
	if (!name) return "";
	return (
		document.cookie
			.split("; ")
			.find((part) => part.startsWith(`${name}=`))
			?.split("=")
			.slice(1)
			.join("=") || ""
	);
}

function showToast(message, error = false) {
	toast.textContent = message;
	toast.classList.toggle("error", error);
	toast.classList.add("visible");
	clearTimeout(state.toastTimer);
	state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 4500);
}

function renderFailure(error) {
	app.innerHTML = `<section class="center-card">
		<h1>Unable to load</h1>
		<p>${escapeHtml(error.message)}</p>
		<button class="primary" id="retry-load">Try again</button>
	</section>`;
	document.getElementById("retry-load")?.addEventListener("click", () => {
		location.reload();
	});
}

function selected(entry, expected) {
	return entry === expected ? "selected" : "";
}

function formatStatus(entry) {
	return String(entry)
		.toLowerCase()
		.split("_")
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function preferredScrollBehavior() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches
		? "auto"
		: "smooth";
}

function formatDate(entry) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(entry));
}

function formatDateOnly(entry) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
	}).format(new Date(entry));
}

function formatFileSize(entry) {
	const bytes = Number(entry || 0);
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(entry, length) {
	const text = String(entry || "");
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function escapeHtml(entry) {
	return String(entry ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function escapeAttr(entry) {
	return escapeHtml(entry);
}
