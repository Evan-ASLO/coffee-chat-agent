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
	applicationCompanySearch: "",
	applicationLocationSearch: "",
	applicationSort: "UPDATED_DESC",
	networkingFilter: "ALL",
	networkingSearchText: "",
	networkingQuality: "ALL",
	networkingCompanySearch: "",
	networkingLocationSearch: "",
	mobileNavOpen: false,
	journeyFocus: "journey",
	renderToken: 0,
	networkingJob: null,
	networkingCriteria: null,
	networkingContacts: { status: "idle", prospects: [], message: "", request: 0 },
	anthropicSearchMaxUses: 1,
	discoveryRequest: null,
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
let journeyMountToken = 0;
const compactNavigation = window.matchMedia("(max-width: 1100px)");
const journeyMediaConditions = [
	window.matchMedia("(max-width: 760px)"),
	window.matchMedia("(prefers-reduced-motion: reduce)"),
];
const ownerAdmin = window.OwnerAdmin.create({
	getSession: () => state.session,
	api,
	escapeHtml,
	formatDate,
	icon,
	notify: showToast,
});
const onboarding = window.WorkspaceOnboarding?.create({
	getSession: () => state.session,
	getView: () => state.tab,
	isMenuOpen: () => state.mobileNavOpen,
	navigate,
	api,
	notify: showToast,
	openPreferences: openProfileSettings,
	openDiscovery: openDiscoveryDialog,
	clearPrivateDialogs,
});

document.addEventListener("DOMContentLoaded", load);
document.addEventListener("keydown", handleNavigationKeydown);
compactNavigation.addEventListener("change", () => {
	if (!compactNavigation.matches && state.mobileNavOpen) {
		setMobileNavOpen(false);
	}
});
journeyMediaConditions.forEach((condition) =>
	condition.addEventListener("change", refreshJourneyScene),
);
document.getElementById("save-draft").addEventListener("click", saveDraft);
document.getElementById("send-draft").addEventListener("click", sendDraft);

async function load() {
	try {
		loadJobQueryFromUrl();
		state.session = await api("/api/session");
		ownerAdmin.syncSession();
		state.tab = state.session?.authenticated ? initialView() : "jobs";
		if (!betaLandingRequired()) {
			await Promise.all([
				loadJobData(),
				loadAnalyticsData(),
			]);
			const jobId = new URLSearchParams(location.search).get("contactJob");
			if (state.session.authenticated && jobOutreachLinkingEnabled() && /^[a-f0-9]{64}$/.test(jobId || "")) {
				state.networkingJob = findJob(jobId) || { id: jobId, title: "Loading job...", company: "" };
				await loadNetworkingContacts();
			}
		}
		render();
	} catch (error) {
		renderFailure(error);
	}
}

function render() {
	ownerAdmin.syncSession();
	setMobileNavOpen(false, false);
	onboarding?.beforeRender();
	destroyJourneyScene();
	state.renderToken += 1;
	const authenticated = Boolean(state.session?.authenticated);
	if (betaLandingRequired()) {
		renderBetaLanding();
		onboarding?.sync();
		return;
	}
	const user = state.session?.user;
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
		<div class="app-frame view-${state.tab} ${state.mobileNavOpen ? "nav-open" : ""}">
			<header class="topbar">
				<button class="brand brand-button" data-nav="${authenticated ? "home" : "jobs"}" aria-label="Internship & Coffee Chat home">
					<span class="brand-mark" aria-hidden="true">CC</span>
					<strong>Internship & Coffee Chat</strong>
				</button>
				<button class="mobile-nav-toggle" id="mobile-nav-toggle" aria-expanded="${state.mobileNavOpen}" aria-controls="primary-navigation">
					${icon("menu")}<span class="sr-only">Toggle navigation</span>
				</button>
				<nav class="top-nav" id="primary-navigation" aria-label="Primary navigation">
					<button class="mobile-nav-close" id="mobile-nav-close" aria-label="Close navigation">×</button>
					${navItems
						.map(
							([id, label]) => `<button data-nav="${id}" class="${state.tab === id ? "active" : ""}" ${state.tab === id ? 'aria-current="page"' : ""}>${label}</button>`,
						)
						.join("")}
				</nav>
				<div class="top-actions">
					${
						authenticated
							? `<span class="top-email">${escapeHtml(user.email)}</span><button id="logout" class="sign-out-button" aria-label="Sign out">${icon("logout")}<span>Sign out</span></button>`
							: '<a class="button sign-in-button" href="/auth/google/login">Sign in</a>'
					}
				</div>
			</header>
			<button class="nav-scrim" id="nav-scrim" aria-label="Close navigation"></button>
			<main id="main-content" tabindex="-1">${renderTab()}</main>
			${legalLinks()}
		</div>`;
	document.getElementById("logout")?.addEventListener("click", logout);
	document.querySelectorAll("[data-nav]").forEach((button) =>
		button.addEventListener("click", () => {
			navigate(button.dataset.nav);
		}),
	);
	document.getElementById("mobile-nav-toggle")?.addEventListener("click", () => {
		setMobileNavOpen(!state.mobileNavOpen);
	});
	document.getElementById("mobile-nav-close")?.addEventListener("click", () =>
		setMobileNavOpen(false),
	);
	document.getElementById("nav-scrim")?.addEventListener("click", () =>
		setMobileNavOpen(false),
	);
	wireTab();
	if (authenticated && state.tab === "home") {
		mountJourneyScene(state.renderToken);
	}
	onboarding?.sync();
}

function setMobileNavOpen(open, restoreFocus = true) {
	const wasOpen = state.mobileNavOpen;
	state.mobileNavOpen = Boolean(open && compactNavigation.matches);
	app.querySelector(".app-frame")?.classList.toggle("nav-open", state.mobileNavOpen);
	document.body.classList.toggle("navigation-open", state.mobileNavOpen);
	const toggle = document.getElementById("mobile-nav-toggle");
	const navigation = document.getElementById("primary-navigation");
	toggle?.setAttribute("aria-expanded", String(state.mobileNavOpen));
	app.querySelectorAll("#main-content, .site-footer, .brand-button, .top-actions, .mobile-nav-toggle")
		.forEach((element) => { element.inert = state.mobileNavOpen; });
	if (state.mobileNavOpen) {
		navigation?.setAttribute("role", "dialog");
		navigation?.setAttribute("aria-modal", "true");
		navigation?.querySelector(".mobile-nav-close")?.focus({ preventScroll: true });
	} else {
		navigation?.removeAttribute("role");
		navigation?.removeAttribute("aria-modal");
		if (wasOpen && restoreFocus) {
			const target = toggle?.getClientRects().length
				? toggle
				: navigation?.querySelector('[aria-current="page"]');
			target?.focus({ preventScroll: true });
		}
	}
	onboarding?.refreshLayout?.();
}

function handleNavigationKeydown(event) {
	if (!state.mobileNavOpen) return;
	if (event.key === "Escape") {
		event.preventDefault();
		setMobileNavOpen(false);
		return;
	}
	if (event.key !== "Tab") return;
	const navigation = document.getElementById("primary-navigation");
	const buttons = Array.from(navigation?.querySelectorAll("button:not([disabled])") || []);
	const first = buttons[0];
	const last = buttons[buttons.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last?.focus();
	} else if ((!event.shiftKey && document.activeElement === last) ||
		!navigation?.contains(document.activeElement)) {
		event.preventDefault();
		first?.focus();
	}
}

function renderBetaLanding() {
	const requested =
		new URLSearchParams(location.search).get("access") === "requested";
	app.innerHTML = `
		<section class="beta-landing">
			<div class="beta-landing-brand">
				<span class="brand-mark" aria-hidden="true">CC</span>
				<strong>Internship & Coffee Chat</strong>
				<span>Private Toronto beta</span>
			</div>
			<div class="beta-landing-grid">
				<div class="beta-landing-copy">
					<p class="eyebrow">Opportunities create momentum</p>
					<h1>Build a career you’re proud of.</h1>
					<p>Search Toronto internships, track every application, and build thoughtful professional relationships in one approval-first workspace.</p>
				${
					requested
						? '<p class="notice">Thanks. If this Google account can be considered for the beta, the request has been recorded. This confirmation is intentionally the same for every account.</p>'
						: ""
				}
					<div class="actions beta-actions">
						<a class="button primary" href="/auth/google/login">Sign in with Google</a>
						<a class="button secondary" href="/auth/google/request">Request access</a>
					</div>
					<p class="beta-privacy">Request access verifies your Google email and records only the minimum information needed to review the request. It does not create a normal app account or session unless approved.</p>
				</div>
				<div class="beta-landing-art" aria-hidden="true"></div>
			</div>
			${legalLinks()}
		</section>`;
}

function renderStats() {
	const metrics = journeyMetrics();
	return `<section class="home-reference-stats" data-tour="home-summary" aria-label="Career workspace summary">
		${referenceMetric(state.jobs.pagination.total, "Open internships", "briefcase")}
		${referenceMetric(metrics.saved, "Saved roles", "bookmark")}
		${referenceMetric(metrics.activeApplications, "Active applications", "document")}
		${referenceMetric(metrics.peopleTracked, "People tracked", "people")}
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
		return renderRailPage(renderSettings(), "settings");
	}
	if (state.tab === "analytics" && state.session?.authenticated) {
		return renderRailPage(renderAnalytics(), "analytics");
	}
	return renderJobs();
}

function renderRailPage(content, activeView) {
	const note =
		activeView === "analytics"
			? "Track today. A brighter tomorrow."
			: "Small steps. Big opportunities.";
	return `<div class="rail-page">
		<aside class="dark-side-rail" aria-label="${activeView === "analytics" ? "Analytics" : "Settings"} section navigation">
			<nav>
				${[
					["home", "Home", "home"],
					["jobs", "Jobs", "search"],
					["applications", "Applications", "document"],
					["networking", "Networking", "people"],
					["analytics", "Analytics", "chart"],
					["settings", "Settings", "settings"],
				]
					.map(
						([id, label, iconName]) => `<button data-nav="${id}" class="${activeView === id ? "active" : ""}" ${activeView === id ? 'aria-current="page"' : ""}>${icon(iconName)}<span>${label}</span></button>`,
					)
					.join("")}
			</nav>
			<p>${escapeHtml(note)}<span aria-hidden="true"></span></p>
		</aside>
		<div class="rail-page-content">${content}</div>
	</div>`;
}

function renderHome() {
	const metrics = journeyMetrics();
	const detail = window.CareerJourney.detailFor(state.journeyFocus, metrics);
	const recentJobs = state.jobs.jobs.slice(0, 2);
	return `
		<section class="home-reference-hero">
			<div class="home-reference-copy">
				<p class="eyebrow">Coffee chats. Career growth. <span>Real opportunities.</span></p>
				<h1>Find your next<br /><span>opportunity.</span></h1>
				<p>Discover internships, track your applications, and connect with the people behind them.</p>
				<div class="home-reference-actions">
					<button class="primary" data-nav="jobs">${icon("search")} Browse Jobs</button>
					<button class="secondary" data-nav="applications">My Applications</button>
				</div>
				<p class="home-handwritten">Coffee today.<br />Opportunities tomorrow.<span aria-hidden="true"></span></p>
			</div>
			${renderStats()}
		</section>
		<section class="home-search-row">
			<form id="home-job-search-form" class="home-search-panel">
				<div class="home-search-heading">${icon("search")}<div><h2>Find your next opportunity</h2><p>Search internships, track applications, and connect with the people behind them.</p></div></div>
				<div class="home-search-controls">
					<label class="home-search-input">${icon("search")}<span class="sr-only">Search roles</span><input id="home-job-q" placeholder="Title, company, location, or keyword" /></label>
					<label><span class="sr-only">Company</span><input id="home-job-company" placeholder="Company" /></label>
					<label><span class="sr-only">Location</span><input id="home-job-location" placeholder="Location" /></label>
					<label><span class="sr-only">Career track</span><input id="home-job-category" placeholder="Category" /></label>
					<button type="button" id="clear-home-job-search" class="secondary">Clear</button>
					<button class="primary">Search jobs</button>
				</div>
			</form>
			<aside class="home-coffee-card" aria-label="Networking prompt">
				<div class="home-coffee-art" aria-hidden="true"></div>
				<p>Good<br />People<br />Great<br />Opportunities<span aria-hidden="true"></span></p>
			</aside>
		</section>
		<section class="home-reference-lower">
			<article class="home-recent-panel">
				<header><div>${icon("calendar")}<h2>Recent roles</h2></div><button class="text-button" data-nav="jobs">View all ${icon("chevron-right")}</button></header>
				${recentJobs.length ? `<div class="home-recent-grid">${recentJobs.map(homeRecentJobCard).join("")}</div>` : empty("No current roles are available yet.")}
			</article>
			<article class="home-journey-panel" data-tour="home-journey">
				<header><div>${icon("chart")}<h2>Your journey</h2></div><div><button id="journey-reset" class="text-button">${icon("reset")} Reset</button><button class="text-button" data-nav="analytics">View analytics ${icon("chevron-right")}</button></div></header>
				<div id="journey-canvas" class="journey-canvas" aria-busy="true">
					${renderJourneyFallback(metrics)}
					<button data-journey-target="journey" class="journey-overview-button ${state.journeyFocus === "journey" ? "active" : ""}">${icon("path")}<span>Journey overview</span></button>
				</div>
				<div class="home-journey-milestones" aria-label="Career Journey controls">
					${homeJourneyControl("saved", "Explore", "Find roles", "bookmark")}
					${homeJourneyControl("networking", "Connect", "Have coffee chats", "cup")}
					${homeJourneyControl("applications", "Apply", "Track progress", "document")}
					${homeJourneyControl("progress", "Grow", "Turn conversations into opportunities", "path")}
				</div>
				<section class="home-journey-detail" id="journey-detail" aria-live="polite" aria-label="Selected Career Journey detail">
					${renderJourneyDetail(detail)}
				</section>
			</article>
		</section>
		<div class="home-signoff"><span>Toronto&nbsp;&nbsp;|&nbsp;&nbsp;Est. 2026</span><em>A Brighter You.<i aria-hidden="true"></i></em></div>`;
}

function homeJourneyControl(area, title, subtitle, iconName) {
	return `<button data-journey-target="${area}" class="${state.journeyFocus === area ? "active" : ""}">
		<span class="journey-marker">${icon(iconName)}</span>
		<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span>
	</button>`;
}

function homeRecentJobCard(job) {
	const status = job.userState?.status;
	const posted = job.postedAt
		? `Posted ${formatDateOnly(job.postedAt)}`
		: job.postedText || "Date unavailable";
	return `<article class="home-recent-card">
		<div class="home-recent-title">
			<span class="company-tile company-tone-${companyTone(job.company)}" aria-hidden="true">${escapeHtml(companyInitials(job.company))}</span>
			<div><strong>${escapeHtml(job.company)}</strong><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Location not listed")}</p></div>
		</div>
		<div class="chips"><span class="chip">${escapeHtml(JobSourceUi.sourceLabel(job.source))}</span>${job.industry && job.industry !== "Other" ? `<span class="chip">${escapeHtml(job.industry)}</span>` : ""}<span class="chip">${escapeHtml(posted)}</span></div>
		<div class="home-recent-actions">
			<a class="button primary" href="${escapeAttr(job.url)}" target="_blank" rel="noopener">View posting</a>
			${!status || status === "SAVED" ? `<button data-job-save="${job.id}">${status === "SAVED" ? "Saved" : "Save"}</button>` : ""}
			<button data-job-apply="${job.id}" ${APPLICATION_STATUSES.includes(status) ? "disabled" : ""}>Mark applied</button>
			${jobContactAction(job)}
		</div>
	</article>`;
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
		<p><strong>Career Journey fallback</strong><span>The accessible controls below show the same live data when 3D graphics are unavailable or motion is reduced.</span></p>
	</div>`;
}

function journeyControl(area, objectLabel, productLabel, iconName) {
	return `<button data-journey-target="${area}" class="${state.journeyFocus === area ? "active" : ""}">
		${icon(iconName)}<span><small>${objectLabel}</small><strong>${productLabel}</strong></span>
	</button>`;
}

function renderJourneyDetail(detail) {
	return `<div class="journey-detail-inner">
		<div class="journey-detail-copy">
			<p class="eyebrow">Live workspace data</p>
			<h2>${escapeHtml(detail.title)}</h2>
			<p>${escapeHtml(detail.description)}</p>
		</div>
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
	const locationOptions = Array.from(
		new Set(state.jobs.jobs.map((job) => job.location).filter(Boolean)),
	).slice(0, 1);
	return `
		<section class="reference-hero jobs-reference-hero">
			<div class="reference-hero-copy">
				<p class="eyebrow">Opportunities ahead</p>
				<h1>Browse <span>internships</span></h1>
				<p>Discover roles, save your favourites, and track your progress — all in one place.${linkingEnabled ? " Job-linked networking is available for signed-in users." : ""}</p>
				${state.session?.authenticated ? "" : '<a class="button primary" href="/auth/google/login">Sign in to track progress</a>'}
			</div>
		</section>
		${renderCatalogWarning()}
		<div class="jobs-reference-layout ${state.jobMode === "saved" ? "saved-mode" : ""}">
			<form id="job-filter-form" class="jobs-filter-form">
				<div class="job-search-strip" data-tour="jobs-search">
					<label class="search-field"><span class="sr-only">Search</span>${icon("search")}<input id="job-q" value="${escapeAttr(state.jobQuery.q)}" placeholder="Search by title, company, location, or keyword…" /></label>
					<label><span>Location</span><input id="job-location" value="${escapeAttr(state.jobQuery.location)}" placeholder="Any location" /></label>
					<label><span>Industry</span><select id="job-industry">${facetOptions(state.jobs.facets?.industries, state.jobQuery.industry, "All industries")}</select></label>
					<label><span>Career track</span><input id="job-category" value="${escapeAttr(state.jobQuery.category)}" placeholder="Any role" /></label>
					<label><span>Term</span><select id="job-term">${facetOptions(state.jobs.facets?.terms, state.jobQuery.term, "Any term")}</select></label>
					<button class="primary">Search</button>
				</div>
				${
					state.jobMode === "all"
						? `<aside class="filter-panel" aria-label="Job filters">
								<div class="filter-panel-heading"><strong>Filters</strong><button type="button" id="clear-job-filters" class="text-button">Clear all</button></div>
								<label>Company<input id="job-company" value="${escapeAttr(state.jobQuery.company)}" placeholder="Search companies…" /></label>
								<label>Region<input id="job-region" value="${escapeAttr(state.jobQuery.region)}" placeholder="Canada, Ontario…" /></label>
								<label>Length<select id="job-length">${facetOptions(state.jobs.facets?.lengths, state.jobQuery.length, "Any length")}</select></label>
								${jobQuickFilters("Location", "location", locationOptions.map((value) => ({ value, label: value })), state.jobQuery.location)}
								${jobQuickFilters("Industry", "industry", state.jobs.facets?.industries || [], state.jobQuery.industry, 3)}
								${jobQuickFilters("Term", "term", state.jobs.facets?.terms || [], state.jobQuery.term, 2)}
								<div class="filter-summary">
									<span>${state.jobs.facets?.industries?.length || 0} industries</span>
									<span>${state.jobs.facets?.terms?.length || 0} terms</span>
								</div>
								<button class="secondary full-width">Apply filters</button>
							</aside>`
						: `<aside class="filter-panel saved-filter" aria-label="Saved jobs"><strong>Your shortlist</strong><p>Saved roles stay private to your account.</p></aside>`
				}
			</form>
			<section class="jobs-results-panel" data-tour="jobs-results">
				<div class="results-toolbar">
					<div>
						<div class="collection-tabs" role="group" aria-label="Job collection">
							<button data-job-mode="all" class="${state.jobMode === "all" ? "active" : ""}">All jobs</button>
							${state.session?.authenticated ? `<button data-job-mode="saved" class="${state.jobMode === "saved" ? "active" : ""}">Saved <span>${savedJobs.length}</span></button>` : ""}
						</div>
						<h2>${pagination.total} ${state.jobMode === "saved" ? "saved" : "open"} ${pagination.total === 1 ? "internship" : "internships"}</h2>
					</div>
					<div class="layout-toggle" role="group" aria-label="Job result layout">
						<button data-job-layout="grid" class="${state.jobLayout === "grid" ? "active" : ""}" aria-label="Grid view">${icon("grid")}<span>Grid</span></button>
						<button data-job-layout="list" class="${state.jobLayout === "list" ? "active" : ""}" aria-label="List view">${icon("list")}<span>List</span></button>
					</div>
				</div>
				${jobs.length ? `<div class="job-cards ${state.jobLayout === "list" ? "list-view" : "grid-view"}">${jobs.map(jobCard).join("")}</div>` : empty(state.jobMode === "saved" ? "Save a role from the live catalog to build your shortlist." : "No active jobs match these filters.")}
				${state.jobMode === "all" ? renderPagination(pagination) : ""}
			</section>
			<aside class="jobs-activity-rail" aria-label="Your job activity">
				<div class="rail-art rail-art-jobs" aria-hidden="true"></div>
				<div class="rail-callout"><strong>Track. Apply.<br />Build your future.</strong></div>
				<div class="rail-activity-card">
					<h2>Your activity</h2>
					${miniMetric(state.jobs.pagination.total, "Open internships", "briefcase")}
					${miniMetric(savedJobs.length, "Saved roles", "bookmark")}
					${miniMetric((state.analytics?.applications?.total || 0), "Applications", "document")}
					${miniMetric((state.analytics?.networking?.tracked || state.session?.prospects?.length || 0), "People tracked", "people")}
				</div>
				<div class="rail-activity-card catalog-card">
					<h2>Catalog status</h2>
					<p><strong>${escapeHtml(formatStatus(state.jobs.catalog?.state || "never_imported"))}</strong><span>${state.jobs.catalog?.generatedAt ? `Generated ${formatDate(state.jobs.catalog.generatedAt)}` : "Waiting for the first signed snapshot"}</span></p>
				</div>
			</aside>
		</div>`;
}

function renderApplications() {
	const allJobs = state.trackedJobs.jobs.filter((job) =>
		[...APPLICATION_STATUSES, "ARCHIVED"].includes(job.userState?.status),
	);
	const search = state.applicationSearch.toLowerCase();
	const companySearch = state.applicationCompanySearch.toLowerCase();
	const locationSearch = state.applicationLocationSearch.toLowerCase();
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
		const companyMatches =
			!companySearch || job.company.toLowerCase().includes(companySearch);
		const locationMatches =
			!locationSearch ||
			[job.location, job.region]
				.join(" ")
				.toLowerCase()
				.includes(locationSearch);
		return statusMatches && textMatches && companyMatches && locationMatches;
	});
	jobs.sort((left, right) => {
		if (state.applicationSort === "UPDATED_ASC") {
			return String(left.userState?.updatedAt).localeCompare(
				String(right.userState?.updatedAt),
			);
		}
		if (state.applicationSort === "COMPANY") {
			return left.company.localeCompare(right.company);
		}
		return String(right.userState?.updatedAt).localeCompare(
			String(left.userState?.updatedAt),
		);
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
	const notes = allJobs
		.filter((job) => job.userState?.notes?.trim())
		.sort((left, right) =>
			String(right.userState.updatedAt).localeCompare(
				String(left.userState.updatedAt),
			),
		)
		.slice(0, 3);
	return `
		<section class="reference-hero applications-reference-hero">
			<div class="reference-hero-copy">
				<p class="eyebrow">Your application tracker</p>
				<h1>Turn applications<br />into <span>opportunities.</span></h1>
				<p>Stay organized, track your progress, and keep every private next step in one place.</p>
				<div class="reference-hero-actions">
					<button class="primary" data-nav="jobs">${icon("plus")} Browse jobs</button>
					<button class="secondary" data-open-import>${icon("upload")} Import tracker</button>
				</div>
			</div>
		</section>
		<section class="reference-metrics application-stats" aria-label="Application summary">
			${referenceMetric(applications.total, "Total applications", "document")}
			${referenceMetric(applications.inProgress, "In progress", "progress")}
			${referenceMetric(applications.interviewing, "Interviews", "people")}
			${referenceMetric(applications.offers, "Offers", "spark")}
		</section>
		<div class="tracker-layout applications-layout">
			<aside class="tracker-filters" aria-label="Application filters">
				<div class="tracker-filter-heading"><strong>Filters</strong><button class="text-button" data-application-filter="ALL">Clear all</button></div>
				<fieldset>
					<legend>Application status</legend>
					${applicationFilterButton("ALL", "All", allJobs.length)}
					${applicationFilterButton("APPLIED", "Applied")}
					${applicationFilterButton("INTERVIEWING", "Interview")}
					${applicationFilterButton("OFFER", "Offer")}
					${applicationFilterButton("REJECTED", "Rejected")}
					${applicationFilterButton("ARCHIVED", "Archived")}
				</fieldset>
				<label>Company<input id="application-company-filter" value="${escapeAttr(state.applicationCompanySearch)}" placeholder="Search companies…" /></label>
				<label>Location<input id="application-location-filter" value="${escapeAttr(state.applicationLocationSearch)}" placeholder="Search locations…" /></label>
				<p class="filter-footnote">Dates shown are recorded update dates. The app does not invent deadlines or reminders.</p>
			</aside>
			<section class="tracker-table-panel" data-tour="applications">
				<div class="table-panel-heading">
					<div><h2>Your applications</h2><p>Track and manage every real application in one place.</p></div>
					<form id="application-search-form" class="table-tools">
						<label class="inline-search"><span class="sr-only">Search applications</span>${icon("search")}<input id="application-search" value="${escapeAttr(state.applicationSearch)}" placeholder="Search applications…" /></label>
						<label>Sort by<select id="application-sort">
							<option value="UPDATED_DESC" ${selected(state.applicationSort, "UPDATED_DESC")}>Recently updated</option>
							<option value="UPDATED_ASC" ${selected(state.applicationSort, "UPDATED_ASC")}>Oldest update</option>
							<option value="COMPANY" ${selected(state.applicationSort, "COMPANY")}>Company</option>
						</select></label>
					</form>
				</div>
				${
					jobs.length
						? `<div class="responsive-table-wrap" tabindex="0" role="region" aria-label="Applications table. Scroll to view every column."><table class="data-table applications-table">
								<caption class="sr-only">Your applications and private next steps</caption>
								<thead><tr><th scope="col">Company</th><th scope="col">Role</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Next step</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
								<tbody>${jobs.map(applicationTableRow).join("")}</tbody>
							</table></div>`
						: empty(allJobs.length ? "No applications match this stage and search." : "Mark a job as Applied to start your application pipeline.")
				}
			</section>
			<aside class="tracker-right-rail" aria-label="Application progress">
				<section class="rail-panel">
					<div class="rail-panel-heading"><h2>Application progress</h2><button data-nav="analytics" class="text-button">View analytics →</button></div>
					${renderApplicationDonut(applications)}
				</section>
				<section class="rail-panel notes-rail">
					<div class="rail-panel-heading"><h2>Next-step notes</h2><span>${notes.length}</span></div>
					${
						notes.length
							? `<ul>${notes.map((job) => `<li><strong>${escapeHtml(job.company)}</strong><span>${escapeHtml(truncate(job.userState.notes, 72))}</span></li>`).join("")}</ul>`
							: `<div class="rail-empty">${icon("calendar")}<strong>No notes yet</strong><span>Add a next step when you edit an application.</span></div>`
					}
				</section>
				<div class="rail-art rail-art-applications" aria-hidden="true"></div>
			</aside>
		</div>
		<dialog id="application-dialog" class="editor-dialog" aria-labelledby="application-dialog-title">
			<form method="dialog" class="dialog-card" id="application-editor-form">
				<div class="dialog-head"><div><p class="eyebrow">Application details</p><h2 id="application-dialog-title">Edit application</h2><p id="application-dialog-company"></p></div><button class="icon-button" value="cancel" aria-label="Close application editor">×</button></div>
				<input id="application-dialog-id" type="hidden" />
				<label>Stage<select id="application-dialog-stage">${jobStatusOptions("APPLIED")}</select></label>
				<label>Private next step or notes<textarea id="application-dialog-notes" rows="5" maxlength="4000"></textarea></label>
				<div class="dialog-links"><a id="application-dialog-job-link" class="button" target="_blank" rel="noopener">Open job posting</a><button type="button" id="application-dialog-network" class="secondary">People to contact</button></div>
				<div class="actions"><button type="button" id="application-dialog-remove" class="danger">Remove from tracker</button><button type="button" id="application-dialog-save" class="primary">Save application</button></div>
			</form>
		</dialog>`;
}

function renderNetworking() {
	const linkingEnabled = jobOutreachLinkingEnabled();
	const searching = state.networkingSearch.status === "running";
	const context = linkingEnabled && state.networkingJob
		? `<section class="notice networking-context">
				<div>
					<strong>People to contact for ${escapeHtml(state.networkingJob.title)}</strong>
					<span>${escapeHtml(state.networkingJob.company)} · ${escapeHtml(state.networkingJob.location || state.networkingJob.region || "Location not listed")}</span>
					<p>Priority: entry-level in this function, then internship/new-grad recruiters, then other entry-level employees at this firm. Public evidence can be incomplete; no contact or vacancy ownership is guaranteed.</p>
					<p>Opening this list only reads your saved contacts. A new provider search requires the Search button after reviewing costs.</p>
				</div>
				<div class="actions"><button id="reload-job-contacts" ${state.networkingContacts.status === "loading" ? "disabled" : ""}>Reload saved contacts</button><button id="clear-networking-job" ${searching ? "disabled" : ""}>All networking</button></div>
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
	const profileReady = isDraftProfileReady(state.session.settings);
	const people = networkingPeople();
	const prospects = people
		.filter((person) => {
			const filterMatches =
				state.networkingFilter === "ALL" ||
				(state.networkingFilter === "TO_APPROVE" &&
					["DISCOVERED", "ERROR"].includes(person.status)) ||
				(state.networkingFilter === "DRAFTS" &&
					person.status === "DRAFT_READY") ||
				(state.networkingFilter === "SENT" &&
					["SENDING", "SENT"].includes(person.status)) ||
				(state.networkingFilter === "REPLIED" &&
					person.status === "REPLIED");
			const text = state.networkingSearchText.toLowerCase();
			const company = state.networkingCompanySearch.toLowerCase();
			const location = state.networkingLocationSearch.toLowerCase();
			const searchMatches =
				!text ||
				[
					person.fullName,
					person.title,
					person.company,
					person.location,
					person.email,
				]
					.join(" ")
					.toLowerCase()
					.includes(text);
			const qualityMatches =
				state.networkingQuality === "ALL" ||
				person.matchQuality === state.networkingQuality;
			const companyMatches =
				!company || person.company.toLowerCase().includes(company);
			const locationMatches =
				!location || person.location.toLowerCase().includes(location);
			return (
				filterMatches &&
				searchMatches &&
				qualityMatches &&
				companyMatches &&
				locationMatches
			);
		})
		.sort((left, right) => {
			if (state.networkingJob) {
				const a = jobContactFor(left);
				const b = jobContactFor(right);
				return (a?.tier ?? 4) - (b?.tier ?? 4) ||
					(b?.score || 0) - (a?.score || 0) ||
					left.fullName.localeCompare(right.fullName, "en") ||
					left.id.localeCompare(right.id, "en");
			}
			return String(right.updatedAt).localeCompare(String(left.updatedAt));
		});
	const replies = state.session.prospects
		.filter((person) => person.status === "REPLIED" && person.lastReplyAt)
		.sort((left, right) =>
			String(right.lastReplyAt).localeCompare(String(left.lastReplyAt)),
		)
		.slice(0, 3);
	return `
		<section class="reference-hero networking-reference-hero">
			<div class="reference-hero-copy">
				<p class="eyebrow">People create opportunities</p>
				<h1>Build meaningful<br /><span>connections.</span></h1>
				<p>Find relevant public profiles, approve each person, review every exact draft, and send only when you are ready.</p>
				<div class="reference-hero-actions">
					<button id="open-discovery-dialog" data-tour="networking-find" class="primary">${icon("plus")} Find people</button>
					<button class="secondary" data-nav="settings">${icon("upload")} Import or configure</button>
				</div>
			</div>
		</section>
		<section class="reference-metrics networking-stats" aria-label="Networking summary">
			${referenceMetric(networking.tracked, "People tracked", "people")}
			${referenceMetric(networking.drafts, "Drafts ready", "edit")}
			${referenceMetric(networking.sent, "Emails sent", "send")}
			${referenceMetric(networking.replied, "Replies", "reply")}
		</section>
		${previewNotice}${context}${state.networkingJob ? renderDiscoverySetup() : ""}${renderNetworkingSearchState()}
		${state.networkingJob && state.networkingContacts.status === "loading" ? '<p class="notice" role="status">Loading saved contacts only. No provider search is running.</p>' : ""}
		${state.networkingJob && state.networkingContacts.status === "error" ? `<p class="notice warning" role="alert">${escapeHtml(state.networkingContacts.message)} Use Reload saved contacts to retry without a provider search.</p>` : ""}
		<div class="tracker-layout networking-layout">
			<aside class="tracker-filters" aria-label="Networking filters">
				<div class="tracker-filter-heading"><strong>Filters</strong><button class="text-button" data-network-filter="ALL">Clear all</button></div>
				<fieldset>
					<legend>Workflow stage</legend>
					${networkFilterButton("ALL", "All", people.length)}
					${networkFilterButton("TO_APPROVE", "To approve")}
					${networkFilterButton("DRAFTS", "Drafts")}
					${networkFilterButton("SENT", "Sent")}
					${networkFilterButton("REPLIED", "Replied")}
				</fieldset>
				<fieldset>
					<legend>Match quality</legend>
					<button data-network-quality="ALL" class="${state.networkingQuality === "ALL" ? "active" : ""}">All matches</button>
					<button data-network-quality="STRONG" class="${state.networkingQuality === "STRONG" ? "active" : ""}">Strong</button>
					<button data-network-quality="BROADER_COMPANY" class="${state.networkingQuality === "BROADER_COMPANY" ? "active" : ""}">Broader company</button>
				</fieldset>
				<label>Search people<input id="networking-filter-search" value="${escapeAttr(state.networkingSearchText)}" placeholder="Name, company, role…" /></label>
				<label>Company<input id="networking-company-filter" value="${escapeAttr(state.networkingCompanySearch)}" placeholder="Search companies…" /></label>
				<label>Location<input id="networking-location-filter" value="${escapeAttr(state.networkingLocationSearch)}" placeholder="Search locations…" /></label>
				<p class="filter-footnote">A sent email or reply is not shown as a completed coffee chat unless you record that evidence elsewhere.</p>
			</aside>
			<section class="tracker-table-panel" data-tour="networking-review">
				<div class="table-panel-heading">
					<div><h2>${state.networkingJob ? "Saved contacts for this job" : "Your network"}</h2><p>${state.networkingJob ? "Ranked for this role using saved public evidence. Unconfirmed fits remain separate." : "Keep approval, draft, send, and reply state visible in one compact workflow."}</p></div>
					<div class="table-tools"><button id="open-discovery-dialog-secondary" class="primary">${icon("search")} Find people</button></div>
				</div>
				${
					prospects.length
						? `<div class="responsive-table-wrap" tabindex="0" role="region" aria-label="Networking table. Scroll to view every column."><table class="data-table networking-table">
								<caption class="sr-only">Your network and approval-first outreach workflow</caption>
								<thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Company</th><th scope="col">Status</th><th scope="col">${state.networkingJob ? "Contact priority" : "Match"}</th><th scope="col">Next step</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
								<tbody>${prospects.map((person, index) => `${state.networkingJob && !jobContactFor(person)?.tier && (index === 0 || jobContactFor(prospects[index - 1])?.tier) ? '<tr class="unconfirmed-contacts"><th colspan="7">Unconfirmed fits - not part of the three ranked priorities. Review the public evidence before approaching.</th></tr>' : ""}${networkingTableRow(person, profileReady)}`).join("")}</tbody>
							</table></div>`
						: empty(people.length ? "No people match these filters." : state.networkingJob ? "No saved contacts for this job yet. Choose Find people, review the costs, then explicitly search. Results are not guaranteed." : "Use Find people to search public professional profiles.")
				}
			</section>
			<aside class="tracker-right-rail" aria-label="Networking activity">
				<section class="rail-panel workflow-rail" data-tour="networking-workflow">
					<h2>Approval workflow</h2>
					<ol><li><b>1</b><span>Discover</span></li><li><b>2</b><span>Approve</span></li><li><b>3</b><span>Review draft</span></li><li><b>4</b><span>Send</span></li><li><b>5</b><span>Reply</span></li></ol>
				</section>
				<section class="rail-panel outreach-queue">
					<h2>Outreach queue</h2>
					${miniMetric(networking.discovered, "Waiting for approval", "people")}
					${miniMetric(networking.drafts, "Drafts ready", "edit")}
					${miniMetric(networking.sent, "Messages sent", "send")}
				</section>
				<section class="rail-panel">
					<div class="rail-panel-heading"><h2>Recent replies</h2><span>${replies.length}</span></div>
					${
						replies.length
							? `<ul class="reply-list">${replies.map((person) => `<li><strong>${escapeHtml(person.fullName)}</strong><span>${escapeHtml(truncate(person.replySnippet, 70))}</span><time>${formatDate(person.lastReplyAt)}</time></li>`).join("")}</ul>`
							: `<div class="rail-empty">${icon("reply")}<strong>No replies recorded</strong><span>Replies synced from approved outreach will appear here.</span></div>`
					}
				</section>
				<div class="rail-art rail-art-networking" aria-hidden="true"></div>
			</aside>
		</div>
		<dialog id="discovery-dialog" class="editor-dialog discovery-dialog" aria-labelledby="discovery-title">
			<div class="dialog-card">
				<div class="dialog-head"><div><p class="eyebrow">Public profile discovery</p><h2 id="discovery-title">Find relevant people</h2><p>Search never prepares or sends outreach automatically.</p></div><button class="icon-button" id="close-discovery-dialog" type="button" aria-label="Close people search">×</button></div>
				${renderFind()}
			</div>
		</dialog>`;
}

function renderFind() {
	const ready = state.session.credentials.TAVILY.configured &&
		(!state.networkingJob || state.networkingContacts.status === "ready");
	const job = state.networkingJob;
	const criteria =
		state.networkingCriteria ||
		job?.discoveryCriteria || {
			roles: [],
			industries: [],
			companies: [],
			locations: [],
			keywords: [],
			seniority: [],
			objective: "",
			count: 5,
		};
	const searching = state.networkingSearch.status === "running";
	return `
		<section id="find-people-panel" aria-busy="${searching}">
			${renderDiscoverySetup()}
			<form id="find-form" class="grid">
				${job ? `<div class="full job-search-target"><strong>${escapeHtml(job.title)} at ${escapeHtml(job.company)}</strong><p>The server keeps this job's employer and function fixed. It searches junior role peers, internship/new-grad recruiters, and other junior employees at this firm, in that order.</p><p>Generic recruiters and uncertain seniority are not promoted into a confirmed priority.</p></div>` : `${textarea("roles", "Target roles", criteria.roles.join("\n"))}
				${textarea("industries", "Industries", criteria.industries.join("\n"))}
				${textarea("companies", "Companies", criteria.companies.join("\n"))}
				${textarea("locations", "Locations", criteria.locations.join("\n"))}
				${textarea("keywords", "Keywords", criteria.keywords.join("\n"))}
				${textarea("seniority", "Seniority", criteria.seniority.join("\n"))}`}
				<label class="full">Why you want to meet them
					<textarea id="objective" rows="3">${escapeHtml(criteria.objective)}</textarea>
				</label>
				<label>Number of people
					<input id="count" type="number" min="1" max="20" value="${Number(criteria.count || 5)}" />
				</label>
				<div class="full">${renderSearchCosts()}
					${state.session.settings.peopleSearchFallbackProvider === "ANTHROPIC" ? `<label class="search-budget-choice"><input id="anthropic-expanded-search" type="checkbox" ${state.anthropicSearchMaxUses === 3 ? "checked" : ""} /><span>I authorize up to 3 Anthropic web searches for this search, with additional search and model-token charges to my own API account. Unchecked: at most 1 search.</span></label>` : ""}
				</div>
				<div class="actions full">
					<button type="submit" class="primary" ${ready && !searching ? "" : "disabled"}>
						${searching ? '<span class="inline-spinner" aria-hidden="true"></span> Searching…' : "Search public profiles"}
					</button>
				</div>
			</form>
		</section>`;
}

function renderDiscoverySetup() {
	if (state.session.credentials?.TAVILY?.configured) return "";
	return '<p class="notice warning">Saved contacts are available without a key. To run a new search, add your own Tavily key. <button type="button" class="secondary" data-nav="settings">Set up discovery in Settings</button></p>';
}

function renderSearchCosts() {
	return `<p class="notice search-cost-notice"><strong>Before Search or Retry:</strong> Tavily usage follows <a href="https://docs.tavily.com/documentation/api-credits" target="_blank" rel="noopener">your Tavily API plan</a>. Only your selected fallback/key/model is used if needed. Anthropic can run <strong>up to 3 web searches, plus model-token usage</strong>, only when you authorize the higher budget below; the default is 1. These charges are billed to <strong>your own API account</strong>. Check <a href="https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool" target="_blank" rel="noopener">official Anthropic pricing</a>. More searches may still return fewer or no results. Searching never approves, enriches, drafts or sends outreach.</p>`;
}

function networkingPeople() {
	return state.networkingJob ? state.networkingContacts.prospects : state.session.prospects;
}

function jobContactFor(person) {
	return person?.linkedJobs?.find((job) => job.id === state.networkingJob?.id)?.contactMatch;
}

function renderNetworkingSearchState() {
	const search = state.networkingSearch;
	if (search.status === "idle") return "";
	if (search.status === "running") {
		return `<section class="notice discovery-state" role="status">
			<span class="inline-spinner" aria-hidden="true"></span>
			<div><strong>Searching public professional profiles…</strong><span>Duplicate search actions are disabled. No outreach is prepared or sent. Started provider work may still be billed if you stop waiting.</span></div>
			<button id="cancel-people-search" class="secondary">Stop waiting</button>
		</section>`;
	}
	const className = search.status === "success" ? "notice" : "notice warning";
	return `<section class="${className} discovery-state" role="${search.status === "error" ? "alert" : "status"}">
		<div><strong>${escapeHtml(search.status === "success" ? "People found" : search.status === "partial" ? "Partial results - search incomplete" : search.status === "empty" ? state.networkingJob ? "No qualified matches confirmed" : "No new people added" : "Search could not be completed")}</strong><span>${escapeHtml(search.message)}</span></div>
		${
			["empty", "error", "partial"].includes(search.status)
				? `<div>${renderSearchCosts()}<button id="retry-job-discovery" class="secondary">Review costs & retry</button></div>`
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
			<section class="reference-hero analytics-reference-hero"><div class="reference-hero-copy"><p class="eyebrow">Insights for a brighter tomorrow</p><h1>Track progress.<br /><span>See what’s possible.</span></h1><p>Counts and activity are calculated only from your current application, networking, and audit records.</p></div></section>
			<section class="analytics-loading-panel">
				${state.analyticsError ? `<p class="notice danger">${escapeHtml(state.analyticsError)}</p>` : '<div class="skeleton-stack" aria-label="Loading analytics"><span></span><span></span><span></span></div>'}
			</section>`;
	}
	const { applications, networking, topCompanies, activity } = state.analytics;
	return `
		<section class="reference-hero analytics-reference-hero">
			<div class="reference-hero-copy">
				<p class="eyebrow">Insights for a brighter tomorrow</p>
				<h1>Track progress.<br /><span>See what’s possible.</span></h1>
				<p>Turn your recorded activity into honest insight. No synthetic growth, conversion, chat, or reminder claims.</p>
			</div>
		</section>
		<section class="reference-metrics analytics-stats" aria-label="Analytics summary">
			${referenceMetric(state.jobs.pagination.total, "Open internships", "briefcase")}
			${referenceMetric(applications.saved, "Saved roles", "bookmark")}
			${referenceMetric(applications.inProgress + applications.offers, "Active applications", "document")}
			${referenceMetric(networking.tracked, "People tracked", "people")}
		</section>
		<div class="analytics-reference-grid" data-tour="analytics">
			<section class="analytics-panel funnel-panel">
				<div class="analytics-panel-heading"><div><h2>Application Funnel</h2><p>Current stage counts, not a conversion rate.</p></div></div>
				${window.CareerAnalyticsUi.renderApplicationFunnel(applications)}
			</section>
			<section class="analytics-panel timeline-panel">
				<div class="analytics-panel-heading"><div><h2>Recorded Activity Over Time</h2><p>Audit-backed actions over the last 28 days.</p></div><span>Last 4 weeks</span></div>
				${renderActivityTimeline(activity)}
			</section>
			<section class="analytics-panel status-panel">
				<div class="analytics-panel-heading"><div><h2>Application Status</h2><p>Current application distribution.</p></div></div>
				${renderApplicationDonut(applications)}
			</section>
			<section class="analytics-panel companies-panel">
				<div class="analytics-panel-heading"><div><h2>Top Companies</h2><p>Companies represented in your current tracked roles.</p></div></div>
				${window.CareerAnalyticsUi.renderTopCompanies(topCompanies.slice(0, 5))}
			</section>
			<section class="analytics-panel networking-impact-panel">
				<div class="analytics-panel-heading"><div><h2>Networking Impact</h2><p>Real outreach workflow states.</p></div></div>
				${renderNetworkingImpact(networking)}
			</section>
			<section class="analytics-panel heatmap-panel">
				<div class="analytics-panel-heading"><div><h2>Activity Heatmap</h2><p>Your recorded activity over the last 4 weeks.</p></div></div>
				${window.CareerAnalyticsUi.renderActivityHeatmap(activity)}
			</section>
		</div>
		${renderRecentActivity(8)}`;
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
		<section class="reference-hero settings-reference-hero">
			<div class="reference-hero-copy">
				<p class="eyebrow">Personalize your experience</p>
				<h1>Settings</h1>
				<p>Manage the account, drafting preferences, private data, and real integrations that power Internship & Coffee Chat.</p>
			</div>
		</section>
		<div class="settings-reference-grid">
			<section class="settings-reference-card account-card" data-tour="profile">
				<div class="settings-card-heading"><span>${icon("user")}</span><div><h2>Account Information</h2><p>Your signed-in Google identity and drafting name.</p></div><button id="open-profile-settings" class="secondary">Edit profile</button></div>
				<div class="account-summary"><span class="account-avatar">${escapeHtml(userInitials(state.session.user))}</span><div><strong>${escapeHtml(state.session.user.name || settings.senderName || "Signed-in user")}</strong><span>${escapeHtml(state.session.user.email)}</span></div></div>
				<dl class="compact-definition-grid"><div><dt>Sender name</dt><dd>${escapeHtml(settings.senderName || "Not set")}</dd></div><div><dt>Google</dt><dd>${credentials.GOOGLE.configured ? "Connected" : "Not connected"}</dd></div></dl>
			</section>
			<section class="settings-reference-card preferences-card" data-tour="preferences">
				<div class="settings-card-heading"><span>${icon("settings")}</span><div><h2>Preferences</h2><p>Only controls backed by current product behavior.</p></div><button id="open-profile-settings-secondary" class="secondary">Edit</button></div>
				<ul class="settings-summary-list">
					<li><span>${icon("edit")}<b>Draft provider</b><small>${escapeHtml(formatStatus(settings.draftProvider))}</small></span></li>
					<li><span>${icon("search")}<b>People-search fallback</b><small>${escapeHtml(fallbackProviderLabel(settings.peopleSearchFallbackProvider))}</small></span></li>
					<li><span>${icon("document")}<b>Email word limit</b><small>${settings.emailWordLimit} words</small></span></li>
					<li><span>${icon("reply")}<b>Reply sync</b><small>${settings.replySyncEnabled ? "Enabled" : "Disabled"}</small></span></li>
				</ul>
			</section>
			<section class="settings-reference-card privacy-card" data-tour="private-data">
				<div class="settings-card-heading"><span>${icon("shield")}</span><div><h2>Data & Privacy</h2><p>Encrypted files, import tools, and service policies.</p></div></div>
				<details>
					<summary>${icon("document")}<span><b>Resume</b><small>${resume.configured ? `${escapeHtml(resume.fileName)} · ${formatFileSize(resume.sizeBytes)}` : "No resume stored"}</small></span>${icon("chevron-right")}</summary>
					<form id="resume-form" class="compact-settings-form">
						<label>Resume file<input id="resume-file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required /></label>
						<div class="actions"><button class="primary">Upload & analyze</button><button id="delete-resume" class="danger" type="button" ${resume.configured ? "" : "disabled"}>Delete stored resume</button></div>
					</form>
				</details>
				<details id="legacy-import-details">
					<summary>${icon("upload")}<span><b>Legacy tracker import</b><small>One-time strict JSON import</small></span>${icon("chevron-right")}</summary>
					<form id="legacy-import-form" class="compact-settings-form">
						<label>Legacy export JSON<textarea id="legacy-import-json" rows="6" placeholder='{"schemaVersion":1,"exportedAt":"2026-10-01T12:00:00.000Z","source":"internship-tracker-toronto","savedJobs":[],"applications":[]}'></textarea></label>
						<div class="actions"><button class="primary">Import once</button></div>
					</form>
				</details>
				<a href="/privacy.html" class="settings-row-link">${icon("shield")}<span><b>Privacy policy</b><small>How your data is used</small></span>${icon("chevron-right")}</a>
				<a href="/terms.html" class="settings-row-link">${icon("document")}<span><b>Terms of service</b><small>Service terms</small></span>${icon("chevron-right")}</a>
				<p class="settings-disclosure">Account deletion is handled through the verified contact process described in the Privacy Policy; no in-app deletion endpoint exists.</p>
			</section>
			<section class="settings-reference-card integrations-card">
				<div class="settings-card-heading"><span>${icon("plug")}</span><div><h2>Integrations</h2><p>Connected services and encrypted provider credentials.</p></div></div>
				<div class="integration-google" data-tour="google-connections">
					<div><span class="integration-mark google-mark">G</span><span><b>Google Gmail & Sheets</b><small>${credentials.GOOGLE.configured ? "Connected for approved sends and CRM sync" : "Not connected"}</small></span></div>
					${credentials.GOOGLE.configured ? (settings.spreadsheetId ? `<a class="button" href="https://docs.google.com/spreadsheets/d/${escapeAttr(settings.spreadsheetId)}" target="_blank" rel="noopener">Open CRM</a>` : '<button id="init-workspace" class="secondary">Create CRM</button>') : '<a class="button primary" href="/auth/google/connect">Connect</a>'}
				</div>
				<details class="credentials-details">
					<summary>${icon("key")}<span><b>Provider credentials</b><small>Tavily, Hunter, Gemini, OpenAI, Anthropic</small></span>${icon("chevron-right")}</summary>
					<div class="credentials-list">
						${secretRow("TAVILY", "Tavily", credentials.TAVILY)}
						${secretRow("HUNTER", "Hunter", credentials.HUNTER)}
						${secretRow("GEMINI", "Gemini", credentials.GEMINI)}
						${secretRow("OPENAI", "OpenAI", credentials.OPENAI)}
						${secretRow("ANTHROPIC", "Anthropic", credentials.ANTHROPIC)}
					</div>
				</details>
			</section>
			<section class="settings-reference-card appearance-card">
				<div class="settings-card-heading"><span>${icon("palette")}</span><div><h2>Appearance</h2><p>The warm Toronto workspace theme is fixed for this beta.</p></div></div>
				<dl class="appearance-summary"><div><dt>Theme</dt><dd>Warm workspace</dd></div><div><dt>Motion</dt><dd>Follows your system reduced-motion preference</dd></div></dl>
				<div class="appearance-swatches" role="img" aria-label="Warm workspace theme palette"><span></span><span></span><span></span><span></span><span></span></div>
			</section>
			<section class="settings-reference-card about-card">
				<div class="settings-card-heading"><span>${icon("info")}</span><div><h2>About</h2><p>Version and support information.</p></div></div>
				<div class="about-product"><span class="brand-mark">CC</span><div><strong>Internship & Coffee Chat</strong><span>Private beta · version 0.2.0</span><small>Built for thoughtful, approval-first career progress.</small></div></div>
				<div class="actions"><a class="button" href="mailto:evanastonlowe@gmail.com">${icon("mail")} Get support</a><button id="settings-logout" class="secondary">${icon("logout")} Sign out</button></div>
			</section>
			<div class="settings-notebook-art" aria-hidden="true"></div>
			${window.WorkspaceOnboarding?.settingsHtml(state.session) || ""}
		</div>
		<dialog id="profile-settings-dialog" class="editor-dialog settings-editor-dialog" aria-labelledby="profile-settings-title">
			<form method="dialog" class="dialog-card" id="settings-form">
				<div class="dialog-head"><div><p class="eyebrow">Profile & drafting</p><h2 id="profile-settings-title">Edit real workspace preferences</h2><p>Only factual context you save here is available to drafting.</p></div><button class="icon-button" value="cancel" aria-label="Close profile settings">×</button></div>
				<div class="grid grid-3">
					<label>Your name<input id="sender-name" value="${escapeAttr(settings.senderName)}" /></label>
					<label>Email enrichment<select id="enrichment-provider"><option value="HUNTER" ${selected(settings.enrichmentProvider, "HUNTER")}>Hunter</option><option value="NONE" ${selected(settings.enrichmentProvider, "NONE")}>Manual email entry</option></select></label>
					<label>Draft provider<select id="draft-provider">${providerOptions(settings.draftProvider)}</select></label>
					<label>Gemini model<input id="gemini-model" value="${escapeAttr(settings.geminiModel)}" /></label>
					<label>OpenAI model<input id="openai-model" value="${escapeAttr(settings.openAiModel)}" /></label>
					<label>Anthropic model<input id="anthropic-model" value="${escapeAttr(settings.anthropicModel)}" /></label>
					<label class="full">Cited people-search fallback<select id="people-search-fallback-provider"><option value="NONE" ${selected(settings.peopleSearchFallbackProvider, "NONE")}>Disabled</option><option value="GEMINI" ${selected(settings.peopleSearchFallbackProvider, "GEMINI")}>Gemini Google Search</option><option value="OPENAI" ${selected(settings.peopleSearchFallbackProvider, "OPENAI")}>OpenAI Web Search</option><option value="ANTHROPIC" ${selected(settings.peopleSearchFallbackProvider, "ANTHROPIC")}>Anthropic Web Search</option></select><small>Runs only when Tavily is insufficient. Provider web-search tools may incur charges. Anthropic defaults to 1 search; the search form can authorize up to 3 plus model-token usage, billed to your own API account. Results are not guaranteed. <a href="https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool" target="_blank" rel="noopener">Official Anthropic pricing</a> · <a href="https://docs.tavily.com/documentation/api-credits" target="_blank" rel="noopener">Tavily API plan</a></small></label>
					<label>Email word limit<input id="word-limit" type="number" min="60" max="250" value="${settings.emailWordLimit}" /></label>
					<label class="check-row"><input id="reply-sync-enabled" type="checkbox" ${settings.replySyncEnabled ? "checked" : ""} /><span>Enable scheduled reply sync</span></label>
					<label class="full">Outreach goal<textarea id="outreach-goal" rows="3">${escapeHtml(settings.outreachGoal)}</textarea></label>
					<label class="full">Background summary<textarea id="background" rows="3">${escapeHtml(contextValue("Background summary"))}</textarea></label>
					<label class="full">Current goal<textarea id="current-goal" rows="3">${escapeHtml(contextValue("Current goal"))}</textarea></label>
					<label class="full">Experience to reference<textarea id="experience" rows="3">${escapeHtml(contextValue("Experience to reference"))}</textarea></label>
				</div>
				<div class="actions"><button class="primary">Save settings</button></div>
			</form>
		</dialog>
		${ownerAdmin.render()}`;
}

function wireTab() {
	document
		.getElementById("home-job-search-form")
		?.addEventListener("submit", searchHomeJobs);
	document
		.getElementById("clear-home-job-search")
		?.addEventListener("click", clearHomeJobSearch);
	document.getElementById("job-filter-form")?.addEventListener("submit", filterJobs);
	document.getElementById("clear-job-filters")?.addEventListener("click", clearJobFilters);
	document.querySelectorAll("[data-job-quick-key]").forEach((button) =>
		button.addEventListener("click", () =>
			changeQuickJobFilter(
				button.dataset.jobQuickKey,
				button.dataset.jobQuickValue,
			),
		),
	);
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
			state.applicationSort = value("application-sort") || "UPDATED_DESC";
			state.applicationCompanySearch = value("application-company-filter");
			render();
		});
	document
		.getElementById("application-sort")
		?.addEventListener("change", (event) => {
			state.applicationSort = event.currentTarget.value;
			render();
		});
	document
		.getElementById("application-company-filter")
		?.addEventListener("change", (event) => {
			state.applicationCompanySearch = event.currentTarget.value.trim();
			render();
		});
	document
		.getElementById("application-location-filter")
		?.addEventListener("change", (event) => {
			state.applicationLocationSearch = event.currentTarget.value.trim();
			render();
		});
	document.querySelectorAll("[data-application-edit]").forEach((button) =>
		button.addEventListener("click", () =>
			openApplicationEditor(button.dataset.applicationEdit),
		),
	);
	document
		.getElementById("application-dialog-save")
		?.addEventListener("click", saveApplicationEditor);
	document
		.getElementById("application-dialog-remove")
		?.addEventListener("click", removeApplicationFromEditor);
	document
		.getElementById("application-dialog-network")
		?.addEventListener("click", beginApplicationNetworking);
	document.querySelectorAll("[data-open-import]").forEach((button) =>
		button.addEventListener("click", openLegacyImport),
	);
	document.querySelectorAll("[data-network-filter]").forEach((button) =>
		button.addEventListener("click", () => {
			state.networkingFilter = button.dataset.networkFilter;
			render();
		}),
	);
	document.querySelectorAll("[data-network-quality]").forEach((button) =>
		button.addEventListener("click", () => {
			state.networkingQuality = button.dataset.networkQuality;
			render();
		}),
	);
	document
		.getElementById("networking-filter-search")
		?.addEventListener("change", (event) => {
			state.networkingSearchText = event.currentTarget.value.trim();
			render();
		});
	for (const [id, key] of [
		["networking-company-filter", "networkingCompanySearch"],
		["networking-location-filter", "networkingLocationSearch"],
	]) {
		document.getElementById(id)?.addEventListener("change", (event) => {
			state[key] = event.currentTarget.value.trim();
			render();
		});
	}
	for (const id of [
		"open-discovery-dialog",
		"open-discovery-dialog-secondary",
	]) {
		document.getElementById(id)?.addEventListener("click", openDiscoveryDialog);
	}
	document
		.getElementById("close-discovery-dialog")
		?.addEventListener("click", () =>
			document.getElementById("discovery-dialog")?.close(),
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
	document.getElementById("resume-form")?.addEventListener("submit", uploadResume);
	document.getElementById("delete-resume")?.addEventListener("click", removeResume);
	document.getElementById("init-workspace")?.addEventListener("click", initWorkspace);
	document.getElementById("settings-logout")?.addEventListener("click", logout);
	for (const id of [
		"open-profile-settings",
		"open-profile-settings-secondary",
	]) {
		document.getElementById(id)?.addEventListener("click", openProfileSettings);
	}
	document.getElementById("clear-networking-job")?.addEventListener("click", () => {
		clearNetworkingContext();
		syncViewToUrl();
		render();
	});
	document.getElementById("retry-job-discovery")?.addEventListener("click", openDiscoveryDialog);
	document.getElementById("reload-job-contacts")?.addEventListener("click", async () => {
		await loadNetworkingContacts();
		render();
	});
	document.getElementById("cancel-people-search")?.addEventListener("click", () => {
		state.discoveryRequest?.controller.abort();
		state.discoveryRequest = null;
		state.networkingSearch = {
			status: "partial", summary: null,
			message: "Stopped waiting. Provider work already started may still be billed and may save results. Reload saved contacts before starting another search.",
		};
		render();
	});
	document.getElementById("anthropic-expanded-search")?.addEventListener("change", (event) => {
		state.anthropicSearchMaxUses = event.currentTarget.checked ? 3 : 1;
	});
	document.getElementById("complete-profile")?.addEventListener("click", () => {
		navigate("settings");
		requestAnimationFrame(openProfileSettings);
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
	ownerAdmin.wire();
}

async function searchHomeJobs(event) {
	event.preventDefault();
	state.jobMode = "all";
	state.jobQuery = {
		...state.jobQuery,
		q: value("home-job-q"),
		company: value("home-job-company"),
		location: value("home-job-location"),
		category: value("home-job-category"),
		page: 1,
	};
	syncJobQueryToUrl();
	state.jobs = await fetchJobs();
	navigate("jobs");
}

function clearHomeJobSearch() {
	for (const id of [
		"home-job-q",
		"home-job-company",
		"home-job-location",
		"home-job-category",
	]) {
		const input = document.getElementById(id);
		if (input) input.value = "";
	}
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

async function changeQuickJobFilter(key, entry) {
	if (
		![
			"location",
			"industry",
			"term",
		].includes(key)
	) {
		return;
	}
	state.jobQuery[key] = state.jobQuery[key] === entry ? "" : entry;
	state.jobQuery.page = 1;
	syncJobQueryToUrl();
	await run("Updating job filters…", async () => {
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

function openApplicationEditor(id) {
	const job = findJob(id);
	if (!job?.userState) return;
	document.getElementById("application-dialog-id").value = job.id;
	document.getElementById("application-dialog-title").textContent = job.title;
	document.getElementById("application-dialog-company").textContent =
		`${job.company} · ${[job.location, job.region].filter(Boolean).join(" · ") || "Location not listed"}`;
	document.getElementById("application-dialog-stage").value =
		job.userState.status;
	document.getElementById("application-dialog-notes").value =
		job.userState.notes || "";
	const link = document.getElementById("application-dialog-job-link");
	link.href = job.url;
	const networkingButton = document.getElementById(
		"application-dialog-network",
	);
	networkingButton.disabled =
		!jobOutreachLinkingEnabled() ||
		state.networkingSearch.status === "running";
	networkingButton.hidden = !jobOutreachLinkingEnabled();
	document.getElementById("application-dialog")?.showModal();
}

async function saveApplicationEditor() {
	const id = value("application-dialog-id");
	const status = value("application-dialog-stage");
	const notes =
		document.getElementById("application-dialog-notes")?.value?.trim() || "";
	if (!id) return;
	if (!status) {
		document.getElementById("application-dialog")?.close();
		return removeJobStatus(id);
	}
	await run("Saving application…", async () => {
		await api(`/api/jobs/${id}/state`, {
			method: "PUT",
			body: { status, notes },
		});
		document.getElementById("application-dialog")?.close();
		await Promise.all([loadJobData(), loadAnalyticsData()]);
		render();
	});
}

async function removeApplicationFromEditor() {
	const id = value("application-dialog-id");
	if (!id || !confirm("Remove this job from your application tracker?")) return;
	document.getElementById("application-dialog")?.close();
	await removeJobStatus(id);
}

async function beginApplicationNetworking() {
	const id = value("application-dialog-id");
	if (!id) return;
	document.getElementById("application-dialog")?.close();
	await beginJobNetworking(id);
}

function openLegacyImport() {
	if (state.tab !== "settings") navigate("settings");
	const details = document.getElementById("legacy-import-details");
	if (details) details.open = true;
	document.getElementById("legacy-import-json")?.focus();
}

function openDiscoveryDialog() {
	if (state.networkingSearch.status === "running") return;
	const dialogElement = document.getElementById("discovery-dialog");
	if (!dialogElement || dialogElement.open) return;
	dialogElement.showModal();
	(document.getElementById("roles") || document.getElementById("count"))?.focus();
}

function openProfileSettings() {
	const dialogElement = document.getElementById("profile-settings-dialog");
	if (!dialogElement || dialogElement.open) return;
	dialogElement.showModal();
	document.getElementById("sender-name")?.focus();
}

async function beginJobNetworking(id) {
	if (!state.session?.authenticated) return showToast("Sign in to view your job-linked contacts.", true);
	if (!jobOutreachLinkingEnabled()) {
		return showToast(
			"Job-linked outreach is not enabled yet. Use Networking for an independent search.",
			true,
		);
	}
	if (state.networkingSearch.status === "running") return;
	if (!/^[a-f0-9]{64}$/.test(id)) return showToast("This job could not be opened.", true);
	if (state.networkingJob?.id !== id) clearNetworkingContext();
	const job = findJob(id) || { id, title: "Loading job...", company: "" };
	state.networkingJob = job;
	state.networkingCriteria = job.discoveryCriteria ? structuredClone(job.discoveryCriteria) : null;
	state.networkingFilter = "ALL";
	state.networkingQuality = "ALL";
	state.networkingSearchText = "";
	state.networkingCompanySearch = "";
	state.networkingLocationSearch = "";
	state.tab = "networking";
	syncViewToUrl();
	render();
	await loadNetworkingContacts();
	render();
}

function clearNetworkingContext() {
	state.discoveryRequest?.controller.abort();
	state.discoveryRequest = null;
	state.networkingJob = null;
	state.networkingCriteria = null;
	state.networkingContacts = { status: "idle", prospects: [], message: "", request: state.networkingContacts.request + 1 };
	state.anthropicSearchMaxUses = 1;
	state.networkingSearch = { status: "idle", message: "", summary: null };
}

async function loadNetworkingContacts() {
	const jobId = state.networkingJob?.id;
	const identity = state.session?.user?.id;
	if (!jobId || !identity || !jobOutreachLinkingEnabled()) return;
	const request = state.networkingContacts.request + 1;
	const current = () => state.networkingContacts.request === request &&
		state.networkingJob?.id === jobId && state.session?.user?.id === identity;
	state.networkingContacts = {
		status: "loading",
		prospects: state.networkingContacts.prospects.filter((person) =>
			person.userId === identity && person.linkedJobs?.some((job) => job.id === jobId)),
		message: "", request,
	};
	if (state.tab === "networking") render();
	try {
		const result = await api(`/api/jobs/${jobId}/prospects`);
		if (!current()) return;
		if (result.userId !== identity) throw new Error("The signed-in account changed. Reload the workspace to view its contacts.");
		state.networkingJob = result.job;
		state.networkingCriteria ||= structuredClone(result.job.discoveryCriteria);
		state.networkingContacts = { status: "ready", prospects: result.prospects, message: "", request };
	} catch (error) {
		if (!current()) return;
		state.networkingContacts = {
			...state.networkingContacts, status: "error",
			message: error instanceof Error ? error.message : "Saved contacts could not be loaded. Reload contacts to retry without a paid search.",
		};
	}
}

async function findPeople(event) {
	event.preventDefault();
	await executeDiscovery(readDiscoveryCriteria());
}

async function executeDiscovery(criteria) {
	if (state.discoveryRequest || state.networkingSearch.status === "running" || !criteria) return;
	if (!state.session?.authenticated || !state.session.credentials?.TAVILY?.configured) {
		return showToast("Add your Tavily key in Settings before searching. Opening saved contacts is free of provider calls.", true);
	}
	if (state.networkingJob && state.networkingContacts.status !== "ready") {
		return showToast("Load this job's saved contacts before starting a search.", true);
	}
	const request = {
		identity: state.session.user.id,
		jobId: state.networkingJob?.id,
		controller: new AbortController(),
	};
	state.discoveryRequest = request;
	const current = () => state.discoveryRequest === request &&
		state.session?.user?.id === request.identity &&
		state.networkingJob?.id === request.jobId;
	state.networkingCriteria = {
		...criteria,
		jobId:
			jobOutreachLinkingEnabled() && state.networkingJob
				? state.networkingJob.id
				: undefined,
	};
	const body = { ...state.networkingCriteria, anthropicSearchMaxUses: criteria.anthropicSearchMaxUses === 3 ? 3 : 1 };
	state.networkingSearch = {
		status: "running",
		message: "",
		summary: null,
	};
	state.tab = "networking";
	syncViewToUrl();
	render();
	document.getElementById("find-people-panel")?.scrollIntoView({
		behavior: preferredScrollBehavior(),
		block: "start",
	});
	let completed = false;
	try {
		const result = await api("/api/discovery", {
			method: "POST",
			body,
			signal: request.controller.signal,
		});
		completed = true;
		if (!current()) return;
		const session = await api("/api/session", { signal: request.controller.signal });
		if (!current()) return;
		if (session.user?.id !== request.identity) {
			clearNetworkingContext();
			clearPrivateDialogs();
			await refresh("networking");
			return;
		}
		state.session = session;
		const [jobs, trackedJobs, analytics] = await Promise.all([
			fetchJobs(), fetchTrackedJobs(), api("/api/analytics", { signal: request.controller.signal }),
		]);
		if (!current()) return;
		state.jobs = jobs;
		state.trackedJobs = trackedJobs;
		state.analytics = analytics;
		if (request.jobId) await loadNetworkingContacts();
		if (!current()) return;
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
			fallbackReason: null,
			fallbackModel: "",
			fallbackHttpStatus: null,
			fallbackReturned: 0,
			fallbackAccepted: 0,
			inserted: result.prospects?.length || 0,
			duplicates: 0,
			rejected: 0,
		};
		const status = discoverySearchStatus(summary);
		if (summary.inserted > 0) {
			state.networkingSearch = {
				status,
				message: discoverySuccessMessage(summary),
				summary,
			};
			render();
			showToast(
				`${status === "partial" ? "Partial search: found" : "Found"} ${summary.inserted} new ${summary.inserted === 1 ? "person" : "people"} to review.`,
			);
			document.getElementById("approve-panel")?.scrollIntoView({
				behavior: preferredScrollBehavior(),
				block: "start",
			});
			return;
		}
		state.networkingSearch = {
			status,
			message: discoveryEmptyMessage(summary),
			summary,
		};
		render();
		document.getElementById("find-people-panel")?.scrollIntoView({
			behavior: preferredScrollBehavior(),
			block: "start",
		});
	} catch (error) {
		if (!current()) return;
		state.networkingSearch = {
			status: "error",
			message: completed
				? "The search completed, but saved results could not be refreshed. Reload the workspace before starting another paid search."
				:
				error instanceof Error
					? error.message
					: "The search could not be completed.",
			summary: null,
		};
		render();
	} finally {
		if (state.discoveryRequest === request) state.discoveryRequest = null;
	}
}

function readDiscoveryCriteria() {
	return {
		...(state.networkingJob?.discoveryCriteria || {
			roles: listValue("roles"),
			industries: listValue("industries"),
			companies: listValue("companies"),
			locations: listValue("locations"),
			keywords: listValue("keywords"),
			seniority: listValue("seniority"),
		}),
		objective: value("objective"),
		count: Number(value("count")),
		anthropicSearchMaxUses: document.getElementById("anthropic-expanded-search")?.checked ? 3 : 1,
	};
}

function discoverySearchStatus(summary) {
	if (discoveryFallbackFailureMessage(summary)) {
		return summary.accepted > 0 || summary.inserted > 0 || summary.duplicates > 0
			? "partial"
			: "error";
	}
	if (summary.jobQualified === 0) return "empty";
	return summary.inserted > 0 || summary.jobQualified > 0 ? "success" : "empty";
}

function discoverySuccessMessage(summary) {
	if (summary.jobQualified != null) {
		return `${summary.jobQualified} qualified ${summary.jobQualified === 1 ? "contact" : "contacts"} matched this search's priorities; ${summary.jobUnconfirmed || 0} unconfirmed. ${summary.inserted} new, ${summary.duplicates} already tracked. Saved contacts are ranked for this job, not as confirmed hiring owners.${discoveryFallbackFailureMessage(summary) ? ` ${discoveryFallbackFailureMessage(summary)}` : ""}`;
	}
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
	const fallbackFailure = discoveryFallbackFailureMessage(summary);
	if (summary.jobQualified === 0) {
		return `No qualified matches were confirmed in this search. ${summary.jobUnconfirmed || 0} company contacts have unconfirmed fit and are shown separately. Existing linked contacts remain available. A contact is not guaranteed for every job.${fallbackFailure ? ` ${fallbackFailure}` : ""}`;
	}
	if (summary.duplicates > 0) {
		return `No new people were added. ${summary.duplicates} matching ${summary.duplicates === 1 ? "profile is" : "profiles are"} already tracked.${fallbackFailure ? ` ${fallbackFailure}` : " Edit the criteria to search for different roles."}`;
	}
	if (fallbackFailure) return fallbackFailure;
	if (summary.fallbackStatus === "DISABLED") {
		return "Tavily found no usable public professional profiles. The optional cited provider fallback is disabled in Settings.";
	}
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
	return "No new people matched these criteria. Edit the fields below and retry.";
}

function discoveryFallbackFailureMessage(summary) {
	const provider = fallbackProviderLabel(summary.fallbackProvider);
	let message = "";
	if (summary.fallbackStatus === "MISSING_KEY") {
		message = `The cited ${provider} fallback is selected, but no API key is configured for it. Add your key under Settings or disable the fallback.`;
	} else if (
		summary.fallbackStatus === "SEARCH_LIMITED" ||
		summary.fallbackReason === "max_uses_exceeded"
	) {
		const limit = summary.anthropicSearchMaxUses === 3 ? 3 : 1;
		message = `${provider} reached this request's ${limit}-search limit, not an API quota or key failure. Review the search budget and costs before explicitly retrying; more searches may still return fewer or no results. ${summary.fallbackAccepted > 0 ? "Only cited profiles that passed validation were retained." : "No usable fallback profiles were retained."}`;
	} else if (summary.fallbackReason === "invalid_tool_input") {
		message = `${provider} could not run the search tool because its query input was invalid. Try fewer role, company, or location terms, or choose another fallback provider.`;
	} else if (summary.fallbackReason === "query_too_long") {
		message = `${provider}'s search-tool query was too long. Reduce the role, company, or location terms before retrying.`;
	} else if (summary.fallbackReason === "request_too_large") {
		message = `${provider}'s search-tool request was too large. Search fewer companies at a time to reduce the domain filters, or choose another fallback provider.`;
	} else if (summary.fallbackReason === "too_many_requests") {
		message = `${provider}'s search tool was rate limited. Wait before retrying, or choose another fallback provider.`;
	} else if (summary.fallbackReason === "unavailable") {
		message = `${provider}'s search tool was unavailable. Retry later or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "RATE_LIMITED") {
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
		message = `${provider} denied API access. Check the key's validity and account permissions in Settings, or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "BAD_REQUEST") {
		message = [400, 422].includes(summary.fallbackHttpStatus)
			? `${provider} rejected the API request (HTTP ${summary.fallbackHttpStatus}). Retry with narrower criteria; if it persists, report this request error or choose another fallback provider.`
			: `${provider} could not complete the request or search tool. The available diagnostic does not identify which failed. Try narrower criteria or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "UNSUPPORTED") {
		message = `The configured ${provider} model or account does not support the required web-search tool. Check model support and account capabilities, or choose another fallback provider.${summary.fallbackProvider === "ANTHROPIC" ? " An organization admin can check Web Search at platform.claude.com/settings/capabilities." : ""}`;
	} else if (summary.fallbackStatus === "TIMEOUT") {
		message = `${provider} timed out before returning cited profiles. Retry once later or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "MALFORMED_RESPONSE") {
		message = `${provider} returned an unusable cited-profile response. Retry once or choose another fallback provider.`;
	} else if (summary.fallbackStatus === "PROVIDER_ERROR") {
		message = `${provider} could not complete the cited search. Check the provider's service and web-search availability before retrying.`;
	}
	if (!message) return "";
	const tavilyAccepted =
		(summary.primaryAccepted || 0) + (summary.professionalBioAccepted || 0);
	return `${message} ${tavilyAccepted > 0 ? "Accepted Tavily profiles were preserved." : "No usable Tavily profiles were available."}`;
}

function fallbackProviderLabel(provider) {
	if (provider === "NONE") return "Disabled";
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
	const prospect = networkingPeople().find((item) => item.id === id);
	if (!prospect) return;
	document.getElementById("draft-id").value = prospect.id;
	document.getElementById("draft-version").value = prospect.draftVersion;
	document.getElementById("draft-name").textContent =
		`Review outreach to ${prospect.fullName}`;
	document.getElementById("draft-email").value = prospect.email;
	document.getElementById("draft-subject").value = prospect.subject;
	document.getElementById("draft-body").value = prospect.draftBody;
	document.getElementById("draft-audit").textContent =
		`${prospect.personalizationNotes || "No personalization audit was returned."} Draft v${prospect.draftVersion}${prospect.draftHash ? ` · integrity ${prospect.draftHash.slice(0, 10)}` : ""}.`;
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
		openProfileSettings();
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
	if (event.submitter?.value === "cancel") return;
	event.preventDefault();
	if (event.submitter?.value === "cancel") {
		document.getElementById("profile-settings-dialog")?.close();
		return;
	}
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
				replySyncEnabled: Boolean(
					document.getElementById("reply-sync-enabled")?.checked,
				),
			},
		});
		await refresh("settings");
	});
}

async function saveSecret(provider) {
	const input = document.getElementById(`secret-${provider}`);
	if (!input.value.trim()) return showToast("Enter a key first.", true);
	const identity = state.session?.user?.id;
	const status = document.getElementById(`secret-status-${provider}`);
	status.textContent = "Saving encrypted key…";
	status.dataset.error = "false";
	await run(`Encrypting ${provider} credential…`, async () => {
		try {
			await api(`/api/credentials/${provider}`, {
				method: "PUT",
				body: { value: input.value.trim() },
			});
		} catch (error) {
			status.textContent = `Not saved. ${error.message} Use Save to retry.`;
			status.dataset.error = "true";
			throw error;
		}
		input.value = "";
		status.textContent = "Saved. Not provider-validated.";
		if (state.session?.user?.id !== identity) return;
		try {
			await refresh("settings");
		} catch (error) {
			throw new Error(`Key saved, but the workspace could not refresh. Reload to see its status. ${error.message}`);
		}
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
	onboarding?.dispose();
	ownerAdmin.clear();
	clearNetworkingContext();
	clearPrivateDialogs();
	await run("Signing out…", async () => {
		await api("/logout", { method: "POST" });
		location.reload();
	});
}

function clearPrivateDialogs() {
	ownerAdmin.closeDialog();
	document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
	dialog.close();
	document.getElementById("draft-form").reset();
	document.getElementById("draft-name").textContent = "Review draft";
	document.getElementById("draft-audit").textContent = "";
}

async function refresh(tab = state.tab) {
	const previousIdentity = state.session?.user?.id;
	state.session = await api("/api/session");
	ownerAdmin.syncSession();
	state.tab = state.session.authenticated ? tab : "jobs";
	if (previousIdentity && previousIdentity !== state.session.user?.id) {
		onboarding?.dispose();
		clearPrivateDialogs();
		state.jobs = { ...state.jobs, jobs: [], pagination: { ...state.jobs.pagination, total: 0, totalPages: 0 } };
		state.trackedJobs = { ...state.trackedJobs, jobs: [], pagination: { ...state.trackedJobs.pagination, total: 0, totalPages: 0 } };
		ownerAdmin.clear();
		state.analytics = null;
		state.analyticsError = "";
		clearNetworkingContext();
		syncViewToUrl();
		render();
	}
	if (!betaLandingRequired()) {
		await Promise.all([
			loadJobData(),
			loadAnalyticsData(),
		]);
	} else {
		ownerAdmin.clear();
		state.analytics = null;
	}
	if (state.networkingJob) await loadNetworkingContacts();
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
		if (state.networkingJob) clearNetworkingContext();
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

function navigate(view, options = {}) {
	const allowed =
		state.session?.authenticated && PRIMARY_VIEWS.includes(view)
			? view
			: "jobs";
	state.tab = allowed;
	state.mobileNavOpen = false;
	syncViewToUrl();
	render();
	requestAnimationFrame(() => {
		if (options.tutorial) return;
		document.getElementById("main-content")?.focus({ preventScroll: true });
		window.scrollTo({ top: 0, behavior: "auto" });
	});
}

function syncViewToUrl() {
	const url = new URL(location.href);
	if (state.session?.authenticated && state.networkingJob) url.searchParams.set("contactJob", state.networkingJob.id);
	else url.searchParams.delete("contactJob");
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
	const mountToken = ++journeyMountToken;
	try {
		journeyModulePromise ||= import("/journey-scene.js?v=20261002-layout-1");
		const module = await journeyModulePromise;
		if (
			renderToken !== state.renderToken ||
			mountToken !== journeyMountToken ||
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
		if (renderToken !== state.renderToken || mountToken !== journeyMountToken) return;
		container.setAttribute("aria-busy", "false");
		container.classList.add("webgl-fallback");
	}
}

function destroyJourneyScene() {
	journeyMountToken += 1;
	journeyController?.dispose();
	journeyController = null;
}

function refreshJourneyScene() {
	if (state.tab !== "home" || !state.session?.authenticated) return;
	const container = document.getElementById("journey-canvas");
	if (!container) return;
	destroyJourneyScene();
	container.setAttribute("aria-busy", "true");
	container.classList.remove("webgl-fallback");
	const fallback = document.getElementById("journey-fallback");
	if (fallback) fallback.hidden = false;
	mountJourneyScene(state.renderToken);
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
	const identity = state.session?.user?.id;
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
		signal: options.signal,
	});
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error("The server response could not be read. Retry when connected.");
	}
	if (!response.ok) {
		if (response.status === 401 && state.session?.authenticated && state.session.user?.id === identity) {
			ownerAdmin.clear();
			clearNetworkingContext();
			state.session = { authenticated: false, betaAccessMode: state.session.betaAccessMode };
			onboarding?.dispose();
			clearPrivateDialogs();
			render();
		}
		if (response.status === 403 && path.startsWith("/api/beta/admin/") && state.session?.user?.id === identity) {
			ownerAdmin.clear();
			state.session = { ...state.session, isBetaAdmin: false };
			render();
		}
		const error = new Error(data.message || `Request failed (${response.status}).`);
		error.status = response.status;
		error.code = data.error;
		throw error;
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

function jobContactAction(job) {
	if (!state.session?.authenticated || !jobOutreachLinkingEnabled()) return "";
	return `<button type="button" class="secondary job-contact-action" data-job-network="${job.id}" ${state.networkingSearch.status === "running" ? "disabled" : ""}>${icon("people")} People to contact</button>`;
}

function jobCard(job) {
	const status = job.userState?.status;
	const sourceLabel = JobSourceUi.sourceLabel(job.source);
	const sourceAttribution = JobSourceUi.attributionHtml(job.source);
	const posted = job.postedAt
		? `Posted ${formatDateOnly(job.postedAt)}`
		: job.postedText || "Posting date unavailable";
	const outreach = job.outreachSummary;
	return `<article class="job-card ${job.active ? "" : "inactive-job"}">
		<header class="job-card-heading">
			<div class="company-tile company-tone-${companyTone(job.company)}" aria-hidden="true">${escapeHtml(companyInitials(job.company))}</div>
			<div class="job-card-title">
				<h3>${escapeHtml(job.title)}</h3>
				<p class="job-company">${escapeHtml(job.company)}</p>
			</div>
			<div class="job-card-actions">
				${state.session?.authenticated && (!status || status === "SAVED") ? `<button class="bookmark-button ${status === "SAVED" ? "active" : ""}" data-job-save="${job.id}" aria-label="${status === "SAVED" ? "Remove from saved jobs" : "Save job"}">${icon("bookmark")}</button>` : ""}
				${
					state.session?.authenticated
						? `<details class="job-more">
								<summary aria-label="More tracking actions">${icon("more")}</summary>
								<div class="job-more-menu">
									<button data-job-apply="${job.id}" ${APPLICATION_STATUSES.includes(status) ? "disabled" : ""}>${icon("check")} Mark applied</button>
									<label>Stage<select data-job-status="${job.id}">${jobStatusOptions(status)}</select></label>
									${outreach ? `<p class="outreach-summary">${outreach.total} linked · ${outreach.draftReady} drafts · ${outreach.sent} sent · ${outreach.replied} replies</p>` : ""}
								</div>
							</details>`
						: ""
				}
			</div>
		</header>
		<p class="job-location">${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Location not listed")}</p>
		<div class="job-meta">
			<span>${icon("source")}${escapeHtml(sourceLabel)}</span>
			<span>${icon("calendar")}${escapeHtml(posted)}</span>
		</div>
		<div class="chips job-tags">
			${status ? `<span class="status status-${status.toLowerCase()}">${formatStatus(status)}</span>` : ""}
			${job.lengthLabel ? `<span class="chip">${escapeHtml(job.lengthLabel)}</span>` : ""}
			${job.term?.label ? `<span class="chip">${escapeHtml(job.term.label)}</span>` : ""}
			${(job.industry && job.industry !== "Other" ? [job.industry] : job.categories.slice(0, 1)).map((category) => `<span class="chip">${escapeHtml(category)}</span>`).join("")}
			${job.active ? "" : '<span class="chip chip-warning">No longer active</span>'}
		</div>
		${job.description ? `<p class="job-description">${escapeHtml(truncate(job.description, state.jobLayout === "list" ? 180 : 145))}</p>` : ""}
		${sourceAttribution}
		<div class="job-controls">
			${
				state.session?.authenticated && (!status || status === "SAVED")
					? `<button data-job-save="${job.id}">${icon("bookmark")}${status === "SAVED" ? "Saved" : "Save"}</button>`
					: state.session?.authenticated
						? ""
						: '<a class="button" href="/auth/google/login">Sign in to save</a>'
			}
			<a class="button primary" href="${escapeAttr(job.url)}" target="_blank" rel="noopener">View details</a>
			${jobContactAction(job)}
		</div>
	</article>`;
}

function applicationTableRow(job) {
	const status = job.userState?.status || "";
	return `<tr>
		<td><span class="table-company"><span class="company-tile company-tone-${companyTone(job.company)}" aria-hidden="true">${escapeHtml(companyInitials(job.company))}</span><strong>${escapeHtml(job.company)}</strong></span></td>
		<td><span class="table-role">${escapeHtml(job.title)}</span></td>
		<td>${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Not listed")}</td>
		<td><span class="status status-${status.toLowerCase()}">${formatStatus(status)}</span></td>
		<td><time datetime="${escapeAttr(job.userState.updatedAt)}">${formatDateOnly(job.userState.updatedAt)}</time></td>
		<td><span class="table-note">${escapeHtml(job.userState.notes?.trim() ? truncate(job.userState.notes, 54) : "—")}</span></td>
		<td><div class="table-actions">${jobContactAction(job)}<button class="row-action-button" data-application-edit="${job.id}" aria-label="Edit ${escapeAttr(job.title)} at ${escapeAttr(job.company)}">${icon("more")}</button></div></td>
	</tr>`;
}

function applicationFilterButton(status, label, explicitCount) {
	const count =
		explicitCount ??
		state.trackedJobs.jobs.filter(
			(job) => job.userState?.status === status,
		).length;
	return `<button data-application-filter="${status}" class="${state.applicationFilter === status ? "active" : ""}">${escapeHtml(label)} <span>${count}</span></button>`;
}

function networkFilterButton(filter, label, explicitCount) {
	const prospects = networkingPeople();
	const count =
		explicitCount ??
		prospects.filter((person) => {
			if (filter === "TO_APPROVE") {
				return ["DISCOVERED", "ERROR"].includes(person.status);
			}
			if (filter === "DRAFTS") return person.status === "DRAFT_READY";
			if (filter === "SENT") return ["SENDING", "SENT"].includes(person.status);
			if (filter === "REPLIED") return person.status === "REPLIED";
			return true;
		}).length;
	return `<button data-network-filter="${filter}" class="${state.networkingFilter === filter ? "active" : ""}">${escapeHtml(label)} <span>${count}</span></button>`;
}

function networkingTableRow(person, profileReady) {
	const profileUrl = person.linkedinUrl || person.sourceUrl;
	const profileLabel = person.linkedinUrl ? "LinkedIn profile" : "Public profile";
	const contact = state.networkingJob ? jobContactFor(person) : null;
	const priority = state.networkingJob ? `<div class="job-contact-priority">
		<strong>${escapeHtml(contact?.label || "Unconfirmed fit")}</strong>
		<details><summary>Reason & public evidence</summary><p>${escapeHtml(contact?.reason || "This legacy link has no confirmed job-specific evidence.")}</p>${contact?.evidence ? `<blockquote>${escapeHtml(contact.evidence)}</blockquote>` : ""}${person.sourceUrl ? `<a href="${escapeAttr(person.sourceUrl)}" target="_blank" rel="noopener">Open public source</a>` : ""}</details>
		${person.matchQuality === "BROADER_COMPANY" ? '<small>Broader company match - review role relevance.</small>' : ""}
	</div>` : "";
	let nextStep = "";
	if (["DISCOVERED", "ERROR"].includes(person.status)) {
		nextStep = `<button class="table-action primary" data-prepare="${person.id}" ${profileReady ? "" : "disabled"}>Approve & prepare</button><button class="table-action danger" data-reject="${person.id}">Reject</button>`;
	} else if (person.status === "DRAFT_READY") {
		nextStep = `<button class="table-action primary" data-review="${person.id}">Review draft v${person.draftVersion}</button><button class="table-action" data-regenerate="${person.id}">Regenerate</button>`;
	} else if (person.status === "REPLIED") {
		nextStep = `<span class="reply-preview" title="${escapeAttr(person.replySnippet)}">${escapeHtml(truncate(person.replySnippet || "Reply recorded", 42))}</span>`;
	} else if (["SENDING", "SENT"].includes(person.status)) {
		nextStep = `<span class="table-muted">${person.sentAt ? `Sent ${formatDateOnly(person.sentAt)}` : "Send in progress"}</span>`;
	} else {
		nextStep = `<span class="table-muted">${formatStatus(person.status)}</span>`;
	}
	return `<tr class="${person.matchQuality === "BROADER_COMPANY" ? "broader-match-row" : ""}">
		<td><span class="person-cell"><span class="person-avatar" aria-hidden="true">${escapeHtml(companyInitials(person.fullName))}</span><span><strong>${escapeHtml(person.fullName)}</strong>${person.email ? `<small>${escapeHtml(person.email)}</small>` : '<small>Email needed before send</small>'}</span></span></td>
		<td>${escapeHtml(person.title || "Role not listed")}</td>
		<td>${escapeHtml(person.company || "Company not listed")}</td>
		<td><span class="status status-${person.status.toLowerCase()}">${formatStatus(person.status)}</span></td>
		<td>${priority || (person.matchQuality === "BROADER_COMPANY" ? '<span class="chip chip-warning" title="Matches the company and a broader professional signal; review role relevance.">Broader</span>' : '<span class="chip chip-strong">Strong</span>')}</td>
		<td><div class="table-actions">${nextStep}</div>${person.errorMessage ? `<small class="row-error">${escapeHtml(person.errorMessage)}</small>` : ""}</td>
		<td>${profileUrl ? `<a class="row-action-button" href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener" aria-label="${profileLabel} for ${escapeAttr(person.fullName)}">${icon("external")}</a>` : ""}</td>
	</tr>`;
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
	return `<div class="secret-row" data-tour="credential-${provider}">
		<div>
			<strong>${label}</strong><br />
			<small id="secret-status-${provider}" class="secret-save-status" role="status">${status.configured ? `Saved ${escapeHtml(status.hint)} · not provider-validated` : "Not saved"}</small>
		</div>
		<label class="sr-only" for="secret-${provider}">${escapeHtml(label)} API key</label>
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

function jobQuickFilters(title, key, options, current, limit = 5) {
	const entries = (options || []).slice(0, limit);
	if (!entries.length) return "";
	return `<fieldset class="quick-filter-group">
		<legend>${escapeHtml(title)}</legend>
		${entries
			.map((option) => {
				const value = String(option.value ?? option.label ?? "");
				const label = String(option.label ?? option.value ?? "");
				return `<button type="button" data-job-quick-key="${escapeAttr(key)}" data-job-quick-value="${escapeAttr(value)}" class="${String(current || "") === value ? "active" : ""}"><span aria-hidden="true"></span>${escapeHtml(label)}${option.count === undefined ? "" : `<small>${Number(option.count)}</small>`}</button>`;
			})
			.join("")}
	</fieldset>`;
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

function referenceMetric(entry, label, iconName) {
	return `<article class="reference-metric">
		<span class="reference-metric-icon">${icon(iconName)}</span>
		<div><strong>${Number(entry || 0)}</strong><span>${escapeHtml(label)}</span></div>
	</article>`;
}

function miniMetric(entry, label, iconName) {
	return `<div class="mini-metric"><span>${icon(iconName)}</span><div><strong>${Number(entry || 0)}</strong><small>${escapeHtml(label)}</small></div></div>`;
}

function renderApplicationDonut(applications) {
	const entries = [
		["Applied", Number(applications.applied || 0), "applied"],
		["Interview", Number(applications.interviewing || 0), "interviewing"],
		["Offer", Number(applications.offers || 0), "offer"],
		["Rejected", Number(applications.rejected || 0), "rejected"],
	];
	const total = entries.reduce((sum, entry) => sum + entry[1], 0);
	const circumference = 251.2;
	let offset = 0;
	const segments = entries
		.map(([label, count, className]) => {
			const length = total ? (count / total) * circumference : 0;
			const circle = `<circle class="donut-segment donut-${className}" cx="52" cy="52" r="40" pathLength="${circumference}" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
			offset += length;
			return circle;
		})
		.join("");
	return `<div class="donut-layout">
		<div class="donut-chart" role="img" aria-label="${total} total applications">
			<svg viewBox="0 0 104 104" aria-hidden="true"><circle class="donut-track" cx="52" cy="52" r="40"></circle>${segments}</svg>
			<div><strong>${total}</strong><span>Total</span></div>
		</div>
		<ul class="donut-legend">${entries.map(([label, count, className]) => `<li><span class="legend-dot legend-${className}"></span><span>${label}</span><strong>${count}</strong></li>`).join("")}</ul>
	</div>`;
}

function renderNetworkingImpact(networking) {
	const entries = [
		["To review", Number(networking.discovered || 0), "applied"],
		["Drafts", Number(networking.drafts || 0), "interviewing"],
		["Sent", Number(networking.sent || 0), "offer"],
		["Replies", Number(networking.replied || 0), "rejected"],
	];
	const total = Number(networking.tracked || 0);
	return `<div class="network-impact">
		<div class="impact-ring"><strong>${total}</strong><span>People tracked</span></div>
		<ul>${entries.map(([label, count, className]) => `<li><span class="legend-dot legend-${className}"></span><span>${label}</span><strong>${count}</strong></li>`).join("")}</ul>
	</div>`;
}

function renderActivityTimeline(activity) {
	const days = Array.isArray(activity?.days) ? activity.days : [];
	const width = 520;
	const height = 150;
	const paddingX = 28;
	const paddingY = 22;
	const max = Math.max(1, ...days.map((day) => Number(day.count || 0)));
	const points = days
		.map((day, index) => {
			const x =
				paddingX +
				(index / Math.max(1, days.length - 1)) *
					(width - paddingX * 2);
			const y =
				height -
				paddingY -
				(Number(day.count || 0) / max) * (height - paddingY * 2);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	const first = days[0]?.date || "";
	const last = days[days.length - 1]?.date || "";
	return `<div class="timeline-chart">
		<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded account activity over 28 days">
			<path class="timeline-grid" d="M${paddingX} ${height - paddingY}H${width - paddingX} M${paddingX} ${height / 2}H${width - paddingX} M${paddingX} ${paddingY}H${width - paddingX}"></path>
			${points ? `<polyline class="timeline-line" points="${points}"></polyline>` : ""}
			${days.map((day, index) => {
				const [x, y] = points.split(" ")[index]?.split(",") || [paddingX, height - paddingY];
				return `<circle class="timeline-point" cx="${x}" cy="${y}" r="${Number(day.count || 0) ? 3.5 : 2}"><title>${escapeHtml(day.date)}: ${Number(day.count || 0)} events</title></circle>`;
			}).join("")}
		</svg>
		<div class="timeline-labels"><span>${escapeHtml(first)}</span><span>${escapeHtml(last)}</span></div>
	</div>`;
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
	const source = String(user?.name || user?.email || "CC");
	const words = source.trim().split(/\s+/).filter(Boolean);
	return (words.length > 1
		? `${words[0][0]}${words[words.length - 1][0]}`
		: words[0]?.slice(0, 2) || "CC"
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
		plus: '<circle cx="10" cy="10" r="7.5"/><path d="M10 6v8M6 10h8"/>',
		upload: '<path d="M10 13V3M6 7l4-4 4 4"/><path d="M4 11v5h12v-5"/>',
		user: '<circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.7-4 2.8-6 6.5-6s5.8 2 6.5 6"/>',
		plug: '<path d="M7 2v5M13 2v5M5 7h10v2a5 5 0 0 1-5 5v4M7 18h6"/>',
		key: '<circle cx="7" cy="10" r="3.5"/><path d="m10.5 10 6-6M13 7l2 2M15 5l2 2"/>',
		palette: '<path d="M10 2.5a7.5 7.5 0 0 0 0 15h1.2a1.8 1.8 0 0 0 0-3.6h-.8a1.4 1.4 0 0 1 0-2.8H13a4.5 4.5 0 0 0 0-9H10Z"/><circle cx="6" cy="8" r=".8"/><circle cx="8.5" cy="5.5" r=".8"/><circle cx="12" cy="5.5" r=".8"/>',
		info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2h.01"/>',
		mail: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 6 7 5 7-5"/>',
		more: '<circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/>',
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
