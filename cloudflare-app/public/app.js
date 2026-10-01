const state = {
	session: null,
	tab: "find",
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
		state.session = await api("/api/session");
		render();
	} catch (error) {
		renderFailure(error);
	}
}

function render() {
	if (!state.session?.authenticated) {
		app.innerHTML = `
			<section class="center-card">
				<div class="brand-mark">CC</div>
				<p class="eyebrow">Secure Cloudflare edition</p>
				<h1>Coffee Chat Agent</h1>
				<p>Sign in with Google. Your provider keys and Google refresh token are encrypted before storage and never returned to this browser.</p>
				<div class="actions">
					<a class="button primary" href="/auth/google/login">Sign in with Google</a>
				</div>
				${legalLinks()}
			</section>`;
		return;
	}
	const { user, prospects, settings, credentials } = state.session;
	app.innerHTML = `
		<header class="topbar">
			<div class="brand">
				<div class="brand-mark">CC</div>
				<div><h1>Coffee Chat Agent</h1><p>Encrypted, approval-first outreach</p></div>
			</div>
			<div class="top-actions">
				<span>${escapeHtml(user.email)}</span>
				${credentials.GOOGLE.configured ? "" : '<a class="button" href="/auth/google/connect">Connect Gmail & Sheets</a>'}
				<button id="logout">Sign out</button>
			</div>
		</header>
		<nav class="tabs">
			${tabButton("find", "Find people")}
			${tabButton("approve", "Approve")}
			${tabButton("outreach", "Outreach")}
			${tabButton("settings", "Settings")}
		</nav>
		${renderStats(prospects)}
		<main>${renderTab()}</main>
		${legalLinks()}`;
	document.getElementById("logout").addEventListener("click", logout);
	document.querySelectorAll("[data-tab]").forEach((button) =>
		button.addEventListener("click", () => {
			state.tab = button.dataset.tab;
			render();
		}),
	);
	wireTab();
}

function renderStats(prospects) {
	const drafts = prospects.filter((item) => item.status === "DRAFT_READY").length;
	const sent = prospects.filter((item) => item.status === "SENT").length;
	const replied = prospects.filter((item) => item.status === "REPLIED").length;
	return `<section class="stats">
		${stat(prospects.length, "People tracked")}
		${stat(drafts, "Drafts to review")}
		${stat(sent, "Awaiting reply")}
		${stat(replied, "Replies")}
	</section>`;
}

function renderTab() {
	if (state.tab === "approve") return renderApprove();
	if (state.tab === "outreach") return renderOutreach();
	if (state.tab === "settings") return renderSettings();
	return renderFind();
}

function renderFind() {
	const ready = state.session.credentials.TAVILY.configured;
	return `
		<section class="panel">
			<div class="panel-head"><div><h2>Find relevant people</h2><p>Searches public professional profile results. Nothing is enriched or drafted until you approve a person.</p></div></div>
			${ready ? "" : '<p class="notice warning">Add a Tavily key under Settings before searching.</p>'}
			<form id="find-form" class="grid">
				${textarea("roles", "Target roles", "Venture Capital Analyst")}
				${textarea("industries", "Industries", "Venture Capital")}
				${textarea("companies", "Companies", "")}
				${textarea("locations", "Locations", "Toronto")}
				${textarea("keywords", "Keywords", "")}
				${textarea("seniority", "Seniority", "")}
				<label class="full">Why you want to meet them<textarea id="objective" rows="3"></textarea></label>
				<label>Number of people<input id="count" type="number" min="1" max="20" value="5" /></label>
				<div class="actions full"><button class="primary" ${ready ? "" : "disabled"}>Find people</button></div>
			</form>
		</section>`;
}

function renderApprove() {
	const people = state.session.prospects.filter((item) =>
		["DISCOVERED", "ERROR"].includes(item.status),
	);
	const profileReady = isDraftProfileReady(state.session.settings);
	return `<section class="panel">
		<div class="panel-head"><div><h2>Approve people</h2><p>The first approval may use Hunter and your selected drafting provider. It never sends email.</p></div></div>
		${profileReady ? "" : '<p class="notice warning">Add at least one factual detail about your background, current goal, or experience before preparing a personalized draft. <button id="complete-profile" class="secondary">Complete profile</button></p>'}
		${people.length ? `<div class="cards">${people.map((person) => prospectCard(person, profileReady)).join("")}</div>` : empty("No people are waiting for approval.")}
	</section>`;
}

function renderOutreach() {
	const drafts = state.session.prospects.filter((item) => item.status === "DRAFT_READY");
	const pipeline = state.session.prospects.filter((item) =>
		["SENDING", "SENT", "REPLIED"].includes(item.status),
	);
	return `
		<section class="panel">
			<div class="panel-head"><div><h2>Drafts awaiting approval</h2><p>Review the exact recipient, subject, and body. Sending uses a server-side idempotency key and cannot be bulk-triggered.</p></div></div>
			${drafts.length ? `<div class="cards">${drafts.map(draftCard).join("")}</div>` : empty("No drafts are ready.")}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Sent and replied</h2><p>Uncertain sends are locked until you check Gmail Sent.</p></div></div>
			${pipeline.length ? `<div class="cards">${pipeline.map(pipelineCard).join("")}</div>` : empty("No messages have been sent.")}
		</section>`;
}

function renderSettings() {
	const { settings, credentials, resume } = state.session;
	return `
		<section class="panel">
			<div class="panel-head"><div><h2>Private workspace</h2><p>Keys are submitted once, encrypted with AES-256-GCM, and stored in D1. Only masked hints return to the browser.</p></div></div>
			${credentials.GOOGLE.configured
				? `<p class="notice">Google is connected. ${settings.spreadsheetId ? `<a href="https://docs.google.com/spreadsheets/d/${escapeAttr(settings.spreadsheetId)}" target="_blank" rel="noopener">Open CRM Sheet</a>` : '<button id="init-workspace" class="secondary">Create CRM Sheet</button>'}</p>`
				: '<p class="notice warning"><a href="/auth/google/connect">Connect Gmail & Sheets</a> before creating the workspace or sending.</p>'}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Resume</h2><p>Upload a PDF, DOCX, or TXT resume up to 5 MB. The file is encrypted before storage. AI suggestions fill the profile form for your review and are not saved until you click Save settings.</p></div></div>
			<form id="resume-form" class="resume-row">
				<label>Resume file<input id="resume-file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required /></label>
				<div class="actions">
					<button class="primary">Upload & analyze</button>
					<button id="delete-resume" class="danger" type="button" ${resume.configured ? "" : "disabled"}>Delete resume</button>
				</div>
			</form>
			${resume.configured
				? `<p class="notice resume-status"><strong>${escapeHtml(resume.fileName)}</strong> · ${formatFileSize(resume.sizeBytes)} · uploaded ${formatDate(resume.uploadedAt)}</p>`
				: '<p class="notice warning resume-status">No resume is stored. PDF analysis requires a configured Gemini key; DOCX and TXT can use any configured AI provider.</p>'}
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Profile and drafting</h2></div></div>
			<form id="settings-form" class="grid grid-3">
				<label>Your name<input id="sender-name" value="${escapeAttr(settings.senderName)}" /></label>
				<label>Email enrichment<select id="enrichment-provider"><option value="HUNTER" ${selected(settings.enrichmentProvider, "HUNTER")}>Hunter</option><option value="NONE" ${selected(settings.enrichmentProvider, "NONE")}>Manual email entry</option></select></label>
				<label>Draft provider<select id="draft-provider">${providerOptions(settings.draftProvider)}</select></label>
				<label>Gemini model<input id="gemini-model" value="${escapeAttr(settings.geminiModel)}" /></label>
				<label>OpenAI model<input id="openai-model" value="${escapeAttr(settings.openAiModel)}" /></label>
				<label>Anthropic model<input id="anthropic-model" value="${escapeAttr(settings.anthropicModel)}" /></label>
				<label>Email word limit<input id="word-limit" type="number" min="60" max="250" value="${settings.emailWordLimit}" /></label>
				<label class="full">Outreach goal<textarea id="outreach-goal" rows="3">${escapeHtml(settings.outreachGoal)}</textarea></label>
				<label class="full">Background summary<textarea id="background" rows="4">${escapeHtml(contextValue("Background summary"))}</textarea></label>
				<label class="full">Current goal<textarea id="current-goal" rows="3">${escapeHtml(contextValue("Current goal"))}</textarea></label>
				<label class="full">Experience to reference<textarea id="experience" rows="4">${escapeHtml(contextValue("Experience to reference"))}</textarea></label>
				<div class="actions full"><button class="primary">Save settings</button></div>
			</form>
		</section>
		<section class="panel">
			<div class="panel-head"><div><h2>Encrypted credentials</h2><p>Leave a field blank to preserve its current encrypted value.</p></div></div>
			${secretRow("TAVILY", "Tavily", credentials.TAVILY)}
			${secretRow("HUNTER", "Hunter", credentials.HUNTER)}
			${secretRow("GEMINI", "Gemini", credentials.GEMINI)}
			${secretRow("OPENAI", "OpenAI", credentials.OPENAI)}
			${secretRow("ANTHROPIC", "Anthropic", credentials.ANTHROPIC)}
		</section>`;
}

function wireTab() {
	document.getElementById("find-form")?.addEventListener("submit", findPeople);
	document.getElementById("settings-form")?.addEventListener("submit", saveSettings);
	document.getElementById("resume-form")?.addEventListener("submit", uploadResume);
	document.getElementById("delete-resume")?.addEventListener("click", removeResume);
	document.getElementById("init-workspace")?.addEventListener("click", initWorkspace);
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
}

async function findPeople(event) {
	event.preventDefault();
	await run("Searching public profiles…", async () => {
		await api("/api/discovery", {
			method: "POST",
			body: {
				roles: listValue("roles"),
				industries: listValue("industries"),
				companies: listValue("companies"),
				locations: listValue("locations"),
				keywords: listValue("keywords"),
				seniority: listValue("seniority"),
				objective: value("objective"),
				count: Number(value("count")),
			},
		});
		await refresh("approve");
	});
}

async function prepare(id) {
	await run("Preparing encrypted enrichment and draft…", async () => {
		await api(`/api/prospects/${id}/prepare`, { method: "POST" });
		await refresh("outreach");
	});
}

async function reject(id) {
	if (!confirm("Reject this person?")) return;
	await run("Updating prospect…", async () => {
		await api(`/api/prospects/${id}/reject`, { method: "POST" });
		await refresh("approve");
	});
}

async function regenerate(id) {
	if (!confirm("Replace the current draft? No email will be sent.")) return;
	await run("Regenerating recipient-focused draft…", async () => {
		await api(`/api/prospects/${id}/regenerate`, { method: "POST" });
		await refresh("outreach");
	});
}

function openDraft(id) {
	const prospect = state.session.prospects.find((item) => item.id === id);
	if (!prospect) return;
	document.getElementById("draft-id").value = prospect.id;
	document.getElementById("draft-version").value = prospect.draftVersion;
	document.getElementById("draft-name").textContent = `Review outreach to ${prospect.fullName}`;
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
		await refresh("outreach");
	});
}

async function sendDraft() {
	const id = value("draft-id");
	const email = value("draft-email");
	const attachResume = Boolean(document.getElementById("attach-resume")?.checked);
	if (!email) return showToast("A verified recipient email is required.", true);
	if (!confirm(`Send this exact email${attachResume ? " with your resume attached" : ""} now to ${email}?`)) return;
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
		await refresh("outreach");
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
		showToast("Resume analyzed. Review the filled fields, then click Save settings.");
	} catch (error) {
		showToast(error.message, true);
	}
}

async function removeResume() {
	if (!confirm("Delete the encrypted resume? Existing profile fields will remain.")) return;
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
				outreachGoal: value("outreach-goal"),
				emailWordLimit: Number(value("word-limit")),
				personalContext: [
					{ category: "Background summary", content: value("background") },
					{ category: "Current goal", content: value("current-goal") },
					{ category: "Experience to reference", content: value("experience") },
					{ category: "Tone", content: "Warm, concise, curious, and respectful." },
					{ category: "Avoid", content: "Never invent facts or shared connections." },
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
	state.tab = tab;
	render();
}

async function run(message, callback) {
	showToast(message);
	try {
		await callback();
		showToast("Done.");
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
	if (!response.ok) throw new Error(data.message || `Request failed (${response.status}).`);
	return data;
}

function prospectCard(person, profileReady) {
	return `<article class="card">
		<div class="card-head"><div><h3>${escapeHtml(person.fullName)}</h3><p>${escapeHtml([person.title, person.company].filter(Boolean).join(" at ") || "Professional profile")}</p></div><span class="status status-${person.status.toLowerCase()}">${formatStatus(person.status)}</span></div>
		<div class="chips"><span class="chip">Relevance ${person.relevanceScore}/100</span>${person.email ? '<span class="chip">Email found</span>' : ""}</div>
		<p>${escapeHtml(person.whyRelevant || person.sourceSnippet)}</p>
		${person.errorMessage ? `<p class="notice danger">${escapeHtml(person.errorMessage)}</p>` : ""}
		<div class="actions">
			<button class="secondary" data-prepare="${person.id}" ${profileReady ? "" : "disabled"}>Approve & prepare</button>
			<button class="danger" data-reject="${person.id}">Reject</button>
			${person.linkedinUrl ? `<a class="button" href="${escapeAttr(person.linkedinUrl)}" target="_blank" rel="noopener">Profile</a>` : ""}
		</div>
	</article>`;
}

function draftCard(person) {
	return `<article class="card">
		<div class="card-head"><div><h3>${escapeHtml(person.fullName)}</h3><p>${escapeHtml([person.title, person.company].filter(Boolean).join(" at "))}</p></div><span class="status status-draft_ready">Draft ready</span></div>
		<div class="chips"><span class="chip">${person.email ? escapeHtml(person.email) : "Email needed"}</span><span class="chip">v${person.draftVersion}</span><span class="chip">${escapeHtml(person.draftProvider)}</span></div>
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
		<div class="card-head"><div><h3>${escapeHtml(person.fullName)}</h3><p>${escapeHtml(person.email)}</p></div><span class="status status-${person.status.toLowerCase()}">${formatStatus(person.status)}</span></div>
		${person.sentAt ? `<p>Sent ${formatDate(person.sentAt)}</p>` : ""}
		${person.lastReplyAt ? `<p class="notice">Reply ${formatDate(person.lastReplyAt)}: ${escapeHtml(person.replySnippet)}</p>` : ""}
		${person.errorMessage ? `<p class="notice danger">${escapeHtml(person.errorMessage)}</p>` : ""}
	</article>`;
}

function secretRow(provider, label, status) {
	return `<div class="secret-row">
		<div><strong>${label}</strong><br /><small>${status.configured ? `Configured ${escapeHtml(status.hint)}` : "Not configured"}</small></div>
		<input id="secret-${provider}" type="password" autocomplete="off" placeholder="${status.configured ? "Leave blank to keep current key" : "Enter API key"}" />
		<div class="actions">
			<button data-save-secret="${provider}">Save</button>
			<button class="danger" data-delete-secret="${provider}" ${status.configured ? "" : "disabled"}>Delete</button>
		</div>
	</div>`;
}

function contextValue(category) {
	return state.session.settings.personalContext.find((item) => item.category === category)?.content || "";
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
	return Boolean(settings.senderName?.trim()) && settings.personalContext.some((item) =>
		item.content?.trim() && !["tone", "avoid"].includes(item.category?.trim().toLowerCase()),
	);
}

function providerOptions(selectedProvider) {
	return [
		["TEMPLATE", "Built-in template"],
		["GEMINI", "Google Gemini"],
		["OPENAI", "OpenAI"],
		["ANTHROPIC", "Anthropic Claude"],
	].map(([value, label]) => `<option value="${value}" ${selected(selectedProvider, value)}>${label}</option>`).join("");
}

function tabButton(id, label) {
	return `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`;
}

function stat(value, label) {
	return `<article class="stat"><strong>${value}</strong><span>${label}</span></article>`;
}

function textarea(id, label, placeholder) {
	return `<label>${label}<textarea id="${id}" rows="3" placeholder="${escapeAttr(placeholder)}">${escapeHtml(placeholder)}</textarea></label>`;
}

function empty(message) {
	return `<div class="empty">${escapeHtml(message)}</div>`;
}

function listValue(id) {
	return value(id).split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function value(id) {
	return document.getElementById(id)?.value?.trim() || "";
}

function cookie(name) {
	return document.cookie
		.split("; ")
		.find((part) => part.startsWith(`${name}=`))
		?.split("=")
		.slice(1)
		.join("=") || "";
}

function showToast(message, error = false) {
	toast.textContent = message;
	toast.classList.toggle("error", error);
	toast.classList.add("visible");
	clearTimeout(state.toastTimer);
	state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 4500);
}

function renderFailure(error) {
	app.innerHTML = `<section class="center-card"><h1>Unable to load</h1><p>${escapeHtml(error.message)}</p><button class="primary" onclick="location.reload()">Try again</button></section>`;
}

function selected(value, expected) {
	return value === expected ? "selected" : "";
}

function formatStatus(value) {
	return String(value).toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function formatDate(value) {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatFileSize(value) {
	const bytes = Number(value || 0);
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(value, length) {
	const text = String(value || "");
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function escapeAttr(value) {
	return escapeHtml(value);
}
