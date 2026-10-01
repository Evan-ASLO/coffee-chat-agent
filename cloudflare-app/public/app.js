const APPLICATION_STATUSES = [
	"APPLIED",
	"INTERVIEWING",
	"OFFER",
	"REJECTED",
];

const state = {
	session: null,
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
	tab: "jobs",
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

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save-draft").addEventListener("click", saveDraft);
document.getElementById("send-draft").addEventListener("click", sendDraft);

async function load() {
	try {
		loadJobQueryFromUrl();
		state.session = await api("/api/session");
		if (!betaLandingRequired()) {
			await Promise.all([loadJobData(), loadBetaAdminData()]);
		}
		render();
	} catch (error) {
		renderFailure(error);
	}
}

function render() {
	const authenticated = Boolean(state.session?.authenticated);
	if (betaLandingRequired()) {
		renderBetaLanding();
		return;
	}
	const user = state.session?.user;
	const credentials = state.session?.credentials;
	app.innerHTML = `
		<header class="topbar">
			<div class="brand">
				<div class="brand-mark">CC</div>
				<div>
					<h1>Internship & Coffee Chat</h1>
					<p>Find roles, track applications, and reach the people behind them.</p>
				</div>
			</div>
			<div class="top-actions">
				${
					authenticated
						? `<span>${escapeHtml(user.email)}</span>
							${credentials.GOOGLE.configured ? "" : '<a class="button" href="/auth/google/connect">Connect Gmail & Sheets</a>'}
							<button id="logout">Sign out</button>`
						: '<a class="button primary" href="/auth/google/login">Sign in with Google</a>'
				}
			</div>
		</header>
		<nav class="tabs ${authenticated ? "tabs-authenticated" : "tabs-public"} ${state.session?.isBetaAdmin ? "tabs-admin" : ""}" aria-label="Primary">
			${tabButton("jobs", "Jobs")}
			${
				authenticated
					? `${tabButton("saved", "Saved")}
						${tabButton("applications", "Applications")}
						${tabButton("networking", "Networking")}
						${tabButton("settings", "Settings")}
						${state.session.isBetaAdmin ? tabButton("beta-access", "Beta access") : ""}`
					: ""
			}
		</nav>
		${authenticated ? renderStats() : ""}
		<main>${renderTab()}</main>
		${legalLinks()}`;
	document.getElementById("logout")?.addEventListener("click", logout);
	document.querySelectorAll("[data-tab]").forEach((button) =>
		button.addEventListener("click", () => {
			state.tab = button.dataset.tab;
			render();
		}),
	);
	wireTab();
}

function renderBetaLanding() {
	const requested =
		new URLSearchParams(location.search).get("access") === "requested";
	app.innerHTML = `
		<section class="beta-landing">
			<div class="beta-landing-brand">
				<div class="brand-mark">CC</div>
				<div>
					<strong>Internship & Coffee Chat</strong>
					<span>Private beta</span>
				</div>
			</div>
			<div class="beta-landing-copy">
				<p class="eyebrow">Approved-email beta</p>
				<h1>Find internships and build thoughtful professional connections.</h1>
				<p>The combined internship tracker and approval-first Coffee Chat workspace is currently open to a small private-beta group while catalog reliability, privacy, and operations are validated.</p>
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
			${legalLinks()}
		</section>`;
}

function renderStats() {
	const prospects = state.session.prospects;
	const tracked = state.trackedJobs.jobs;
	const saved = tracked.filter((job) => job.userState?.status === "SAVED").length;
	const activeApplications = tracked.filter((job) =>
		["APPLIED", "INTERVIEWING", "OFFER"].includes(job.userState?.status),
	).length;
	return `<section class="stats">
		${stat(state.jobs.pagination.total, "Open internships")}
		${stat(saved, "Saved roles")}
		${stat(activeApplications, "Active applications")}
		${stat(prospects.length, "People tracked")}
	</section>`;
}

function renderTab() {
	if (state.tab === "saved" && state.session?.authenticated) {
		return renderSaved();
	}
	if (state.tab === "applications" && state.session?.authenticated) {
		return renderApplications();
	}
	if (state.tab === "networking" && state.session?.authenticated) {
		return renderNetworking();
	}
	if (state.tab === "settings" && state.session?.authenticated) {
		return renderSettings();
	}
	if (
		state.tab === "beta-access" &&
		state.session?.authenticated &&
		state.session.isBetaAdmin
	) {
		return renderBetaAccessAdmin();
	}
	return renderJobs();
}

function renderJobs() {
	const { jobs, pagination } = state.jobs;
	const linkingEnabled = jobOutreachLinkingEnabled();
	return `
		<section class="hero-panel">
			<div>
				<p class="eyebrow">Public internship board</p>
				<h2>Find your next opportunity</h2>
				<p>Browse normalized postings without an account. Sign in to save roles and track applications.${linkingEnabled ? " Job-linked outreach is available during this preview." : ""}</p>
			</div>
			${state.session?.authenticated ? "" : '<a class="button primary" href="/auth/google/login">Sign in to track progress</a>'}
		</section>
		${renderCatalogWarning()}
		<section class="panel">
			<form id="job-filter-form" class="job-filters">
				<label class="job-search">Search
					<input id="job-q" value="${escapeAttr(state.jobQuery.q)}" placeholder="Title, company, location, or keyword" />
				</label>
				<label>Company
					<input id="job-company" value="${escapeAttr(state.jobQuery.company)}" />
				</label>
				<label>Location
					<input id="job-location" value="${escapeAttr(state.jobQuery.location)}" />
				</label>
				<label>Region
					<input id="job-region" value="${escapeAttr(state.jobQuery.region)}" />
				</label>
				<label>Career track
					<input id="job-category" value="${escapeAttr(state.jobQuery.category)}" />
				</label>
				<label>Industry
					<select id="job-industry">${facetOptions(state.jobs.facets?.industries, state.jobQuery.industry, "All industries")}</select>
				</label>
				<label>Length
					<select id="job-length">${facetOptions(state.jobs.facets?.lengths, state.jobQuery.length, "All lengths")}</select>
				</label>
				<label>Term
					<select id="job-term">${facetOptions(state.jobs.facets?.terms, state.jobQuery.term, "All terms")}</select>
				</label>
				<div class="actions job-filter-actions">
					<button type="button" id="clear-job-filters">Clear</button>
					<button class="primary">Search jobs</button>
				</div>
			</form>
		</section>
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>${pagination.total} open ${pagination.total === 1 ? "role" : "roles"}</h2>
					<p>Postings are refreshed by the Internship Tracker publisher. Closed or missing roles are automatically removed from public browsing.</p>
				</div>
			</div>
			${jobs.length ? `<div class="cards job-cards">${jobs.map(jobCard).join("")}</div>` : empty("No active jobs match these filters.")}
			${renderPagination(pagination)}
		</section>`;
}

function renderSaved() {
	const jobs = state.trackedJobs.jobs.filter(
		(job) => job.userState?.status === "SAVED",
	);
	return `<section class="panel">
		<div class="panel-head">
			<div>
				<p class="eyebrow">Shortlist</p>
				<h2>Saved jobs</h2>
				<p>Keep promising roles here, then move them into Applications when you apply.</p>
			</div>
		</div>
		${jobs.length ? `<div class="cards job-cards">${jobs.map(jobCard).join("")}</div>` : empty("Save a role from Jobs to build your shortlist.")}
	</section>`;
}

function renderApplications() {
	const jobs = state.trackedJobs.jobs.filter((job) =>
		[...APPLICATION_STATUSES, "ARCHIVED"].includes(job.userState?.status),
	);
	return `<section class="panel">
		<div class="panel-head">
			<div>
				<p class="eyebrow">Application pipeline</p>
				<h2>Applications</h2>
				<p>Update each role as it moves from submitted to interview, offer, or rejection.</p>
			</div>
		</div>
		${jobs.length ? `<div class="cards job-cards">${jobs.map(jobCard).join("")}</div>` : empty("Mark a job as Applied to start your application pipeline.")}
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
	return `${previewNotice}${context}${renderNetworkingSearchState()}${renderFind()}${renderApprove()}${renderOutreach()}`;
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

function renderSettings() {
	const { settings, credentials, resume } = state.session;
	return `
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Private workspace</h2>
					<p>Keys are submitted once, encrypted with AES-256-GCM, and stored in D1. Only masked hints return to the browser.</p>
				</div>
			</div>
			${
				credentials.GOOGLE.configured
					? `<p class="notice">Google is connected. ${settings.spreadsheetId ? `<a href="https://docs.google.com/spreadsheets/d/${escapeAttr(settings.spreadsheetId)}" target="_blank" rel="noopener">Open CRM Sheet</a>` : '<button id="init-workspace" class="secondary">Create CRM Sheet</button>'}</p>`
					: '<p class="notice warning"><a href="/auth/google/connect">Connect Gmail & Sheets</a> before creating the workspace or sending.</p>'
			}
		</section>
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Import Internship Tracker progress</h2>
					<p>Paste one version 1 export from the legacy browser tracker. The import runs once and matches jobs by canonical URL, then company and title.</p>
				</div>
			</div>
			<form id="legacy-import-form">
				<label>Legacy export JSON
					<textarea id="legacy-import-json" rows="8" placeholder='{"schemaVersion":1,"exportedAt":"2026-10-01T12:00:00.000Z","source":"internship-tracker-toronto","savedJobs":[],"applications":[]}'></textarea>
				</label>
				<div class="actions">
					<button class="primary">Import once</button>
				</div>
			</form>
		</section>
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Resume</h2>
					<p>Upload a PDF, DOCX, or TXT resume up to 5 MB. The file is encrypted before storage. AI suggestions fill the profile form for your review and are not saved until you click Save settings.</p>
				</div>
			</div>
			<form id="resume-form" class="resume-row">
				<label>Resume file
					<input id="resume-file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required />
				</label>
				<div class="actions">
					<button class="primary">Upload & analyze</button>
					<button id="delete-resume" class="danger" type="button" ${resume.configured ? "" : "disabled"}>Delete resume</button>
				</div>
			</form>
			${
				resume.configured
					? `<p class="notice resume-status"><strong>${escapeHtml(resume.fileName)}</strong> · ${formatFileSize(resume.sizeBytes)} · uploaded ${formatDate(resume.uploadedAt)}</p>`
					: '<p class="notice warning resume-status">No resume is stored. PDF analysis requires a configured Gemini key; DOCX and TXT can use any configured AI provider.</p>'
			}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Profile and drafting</h2></div></div>
			<form id="settings-form" class="grid grid-3">
				<label>Your name<input id="sender-name" value="${escapeAttr(settings.senderName)}" /></label>
				<label>Email enrichment
					<select id="enrichment-provider">
						<option value="HUNTER" ${selected(settings.enrichmentProvider, "HUNTER")}>Hunter</option>
						<option value="NONE" ${selected(settings.enrichmentProvider, "NONE")}>Manual email entry</option>
					</select>
				</label>
				<label>Draft provider
					<select id="draft-provider">${providerOptions(settings.draftProvider)}</select>
				</label>
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
					<small>Runs only when Tavily cannot find enough usable people. It uses your encrypted key and configured model for the selected provider. Web-search tools may incur provider charges, and model/account support varies.</small>
				</label>
				<label>Email word limit<input id="word-limit" type="number" min="60" max="250" value="${settings.emailWordLimit}" /></label>
				<label class="full">Outreach goal<textarea id="outreach-goal" rows="3">${escapeHtml(settings.outreachGoal)}</textarea></label>
				<label class="full">Background summary<textarea id="background" rows="4">${escapeHtml(contextValue("Background summary"))}</textarea></label>
				<label class="full">Current goal<textarea id="current-goal" rows="3">${escapeHtml(contextValue("Current goal"))}</textarea></label>
				<label class="full">Experience to reference<textarea id="experience" rows="4">${escapeHtml(contextValue("Experience to reference"))}</textarea></label>
				<div class="actions full"><button class="primary">Save settings</button></div>
			</form>
		</section>
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Encrypted credentials</h2>
					<p>Leave a field blank to preserve its current encrypted value.</p>
				</div>
			</div>
			${secretRow("TAVILY", "Tavily", credentials.TAVILY)}
			${secretRow("HUNTER", "Hunter", credentials.HUNTER)}
			${secretRow("GEMINI", "Gemini", credentials.GEMINI)}
			${secretRow("OPENAI", "OpenAI", credentials.OPENAI)}
			${secretRow("ANTHROPIC", "Anthropic", credentials.ANTHROPIC)}
		</section>`;
}

function renderBetaAccessAdmin() {
	const data = state.betaAdmin || { requests: [], access: [] };
	const pending = data.requests.filter((item) => item.status === "PENDING");
	const denied = data.requests.filter((item) => item.status === "DENIED");
	const approved = data.access.filter((item) => item.status === "APPROVED");
	const revoked = data.access.filter((item) => item.status === "REVOKED");
	return `
		<section class="panel">
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
		</section>`;
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
		state.tab = "settings";
		render();
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
		window.scrollTo({ top: 0, behavior: "smooth" });
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
		await loadJobData();
		render();
	});
}

async function removeJobStatus(id) {
	await run("Removing job from your tracker…", async () => {
		await api(`/api/jobs/${id}/state`, { method: "DELETE" });
		await loadJobData();
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
		behavior: "smooth",
		block: "start",
	});
	try {
		const result = await api("/api/discovery", {
			method: "POST",
			body: state.networkingCriteria,
		});
		state.session = await api("/api/session");
		await Promise.all([loadJobData(), loadBetaAdminData()]);
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
				behavior: "smooth",
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
			behavior: "smooth",
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
	return `${summary.inserted} new ${summary.inserted === 1 ? "person is" : "people are"} ready for approval${details.length ? `; ${details.join("; ")}` : ""}.`;
}

function discoveryEmptyMessage(summary) {
	if (summary.fallbackStatus === "DISABLED") {
		return "Tavily found no usable public professional profiles. The optional cited provider fallback is disabled in Settings.";
	}
	if (summary.fallbackStatus === "MISSING_KEY") {
		const provider = fallbackProviderLabel(summary.fallbackProvider);
		return `The cited ${provider} fallback is selected, but no ${provider} API key is configured. Add your key under Settings or disable the fallback.`;
	}
	if (summary.fallbackStatus === "UNSUPPORTED_MODEL") {
		return `The configured ${fallbackProviderLabel(summary.fallbackProvider)} model cannot use the required web-search tool. Choose a search-capable model or disable the fallback. Tavily results were preserved.`;
	}
	if (summary.fallbackStatus === "PROVIDER_ERROR") {
		return `Tavily results were preserved, but the cited ${fallbackProviderLabel(summary.fallbackProvider)} fallback could not complete. Check that web search is enabled for the configured model/account before retrying; searches may incur charges.`;
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
	if (summary.duplicates > 0) {
		return `No new people were added. ${summary.duplicates} matching ${summary.duplicates === 1 ? "profile is" : "profiles are"} already tracked and linked to this job. Edit the criteria to search for different roles.`;
	}
	return "No new people matched these criteria. Edit the fields below and retry.";
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
		await loadJobData();
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
		await Promise.all([loadJobData(), loadBetaAdminData()]);
	} else {
		state.betaAdmin = null;
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

function betaLandingRequired() {
	return (
		!state.session?.authenticated &&
		state.session?.betaAccessMode === "ALLOWLIST"
	);
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
		<div class="card-head">
			<div>
				<p class="job-company">${escapeHtml(job.company)}</p>
				<h3>${escapeHtml(job.title)}</h3>
				<p>${escapeHtml([job.location, job.region].filter(Boolean).join(" · ") || "Location not listed")}</p>
			</div>
			${status ? `<span class="status status-${status.toLowerCase()}">${formatStatus(status)}</span>` : ""}
		</div>
		<div class="chips">
			<span class="chip">${escapeHtml(sourceLabel)}</span>
			<span class="chip">${escapeHtml(posted)}</span>
			${job.industry && job.industry !== "Other" ? `<span class="chip">${escapeHtml(job.industry)}</span>` : ""}
			${job.lengthLabel ? `<span class="chip">${escapeHtml(job.lengthLabel)}</span>` : ""}
			${job.term?.label ? `<span class="chip">${escapeHtml(job.term.label)}</span>` : ""}
			${job.categories.slice(0, 2).map((category) => `<span class="chip">${escapeHtml(category)}</span>`).join("")}
			${job.active ? "" : '<span class="chip chip-warning">No longer active</span>'}
		</div>
		${sourceAttribution}
		${job.description ? `<p>${escapeHtml(truncate(job.description, 300))}</p>` : ""}
		${
			state.session?.authenticated && outreach
				? `<div class="outreach-summary">
						<strong>Outreach</strong>
						<span>${outreach.total} linked</span>
						<span>${outreach.draftReady} drafts</span>
						<span>${outreach.sent} sent</span>
						<span>${outreach.replied} replies</span>
					</div>`
				: ""
		}
		<div class="job-controls">
			<a class="button primary" href="${escapeAttr(job.url)}" target="_blank" rel="noopener">View posting</a>
			${
				state.session?.authenticated
					? `${!status || status === "SAVED" ? `<button data-job-save="${job.id}">${status === "SAVED" ? "Unsave" : "Save"}</button>` : ""}
						<button data-job-apply="${job.id}" ${APPLICATION_STATUSES.includes(status) ? "disabled" : ""}>Mark applied</button>
						${jobOutreachLinkingEnabled() ? `<button class="secondary" data-job-network="${job.id}" ${state.networkingSearch.status === "running" ? "disabled" : ""}>Find people at this company</button>` : ""}
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
			${person.matchQuality === "BROADER_COMPANY" ? '<span class="chip chip-warning">Broader company match</span>' : ""}
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

function tabButton(id, label) {
	return `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`;
}

function stat(entry, label) {
	return `<article class="stat"><strong>${entry}</strong><span>${label}</span></article>`;
}

function textarea(id, label, initialValue) {
	return `<label>${label}<textarea id="${id}" rows="3">${escapeHtml(initialValue)}</textarea></label>`;
}

function empty(message) {
	return `<div class="empty">${escapeHtml(message)}</div>`;
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
