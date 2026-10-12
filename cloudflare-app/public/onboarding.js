(function (root, factory) {
	const tutorial = factory();
	if (typeof module === "object" && module.exports) module.exports = tutorial;
	if (root) root.WorkspaceOnboarding = tutorial;
})(typeof window === "undefined" ? null : window, function () {
	"use strict";

	const VERSION = 1;
	const CHAPTERS = ["Set up API keys", "Explore your workspace"];
	const LINKS = {
		TAVILY: ["Tavily", "https://app.tavily.com", "https://docs.tavily.com/documentation/quickstart"],
		HUNTER: ["Hunter", "https://hunter.io/api-keys", "https://hunter.io/api-documentation/v2"],
		GEMINI: ["Gemini", "https://aistudio.google.com/apikey", "https://ai.google.dev/gemini-api/docs/api-key"],
		OPENAI: ["OpenAI", "https://platform.openai.com/api-keys", "https://developers.openai.com/api/docs/quickstart"],
		ANTHROPIC: ["Anthropic", "https://platform.claude.com/settings/keys", "https://platform.claude.com/docs/en/api/overview"],
	};
	const STEPS = [
		{
			id: "welcome", chapter: 0, view: "home", target: "home-summary",
			title: "A small tour. Your own workspace.",
			body: () => `<p>Welcome to <strong>Internship &amp; Coffee Chat</strong>. First, learn which optional connections power networking. Then explore Find jobs, My jobs and People, with setup under your account menu.</p>
				<p>You can browse Jobs, save roles, and track applications <strong>without any API keys</strong>. Nothing in this tutorial searches for people, generates drafts, sends email, or analyzes a resume.</p>
				<p>API keys are private passwords for a service. Use <strong>your own provider accounts</strong>, not the app owner's keys. Any usage costs and quotas belong to your provider account.</p>`,
		},
		{
			id: "tavily", chapter: 0, view: "settings", target: "credential-TAVILY",
			title: "Tavily: public profiles and approved research",
			body: (session) => `<p>A Tavily key powers <strong>Search public profiles</strong> and one targeted public-research search after you separately approve a person for preparation. Search and its ordinary Retry use Tavily only, even with few or no results. Jobs and navigation never research a person.</p>
				<ol><li>Sign in or create your own Tavily account.</li><li>Copy the API key from its dashboard.</li><li>Enter it in the highlighted password field and choose <strong>Save</strong>.</li></ol>
				${keyLinks("TAVILY")}${credentialSummary(session, "TAVILY")}
				<p>Discovery uses publicly indexed profiles. It does not scrape LinkedIn, sign into LinkedIn, or send LinkedIn messages. Check your account's current pricing and quotas.</p>`,
		},
		{
			id: "hunter", chapter: 0, view: "settings", target: "credential-HUNTER",
			title: "Hunter is optional",
			preference: "enrichment-provider", action: "preferences", actionLabel: "Choose email enrichment",
			body: (session) => `<p>Hunter can find a work email after you explicitly approve a person for preparation. Add your own Hunter key only if you want that enrichment.</p>
				${keyLinks("HUNTER")}${credentialSummary(session, "HUNTER")}
				<p>Apollo is a separate optional work-email lookup, not people search. It remains server-disabled unless Apollo authorizes this product and the operator enables the approved authentication model. Per-user keys alone are not authorization; approval may require partner OAuth. Do not enter Apollo keys while authorization is pending. <a href="https://www.apollo.io/terms/api" target="_blank" rel="noopener">Official API terms</a>.</p>
				<p>Prefer no Hunter requests? Open <strong>Preferences</strong>, set <strong>Email enrichment → Manual email entry</strong>, and save. Enter the recipient email in the actual draft-review dialog before sending.</p>
				<p>Current choice: <strong>${escapeHtml(session.settings.enrichmentProvider === "NONE" ? "Manual email entry" : session.settings.enrichmentProvider)}</strong>. Touring, skipping or saving a key never changes it or starts a call.</p>`,
		},
		{
			id: "drafting", chapter: 0, view: "settings", target: "preferences",
			preference: "draft-provider", action: "preferences", actionLabel: "Choose a drafting path",
			body: (session) => `<p>Choose <strong>one</strong> drafting provider in Preferences: Gemini, OpenAI, or Anthropic. Or keep <strong>Template</strong>, the deterministic, key-free path.</p>
				<p>Current choice: <strong>${escapeHtml(session.settings.draftProvider)}</strong>${modelSummary(session)}. Existing model choices are kept until you explicitly save preferences.</p>
				${LINKS[session.settings.draftProvider] ? credentialSummary(session, session.settings.draftProvider) : ""}
				<details class="tutorial-key-options"><summary>Get a key for your chosen AI provider</summary>${["GEMINI", "OPENAI", "ANTHROPIC"].map(keyLinks).join("")}</details>
				<p>Add only that provider's key under Provider credentials. Google AI Studio manages Gemini keys and project billing. <strong>ChatGPT Plus and Claude subscriptions do not automatically include API billing or an API key.</strong></p>
				<p>A saved key is not a verified account, billing plan, or model. This tour never makes a provider test call.</p>`,
		},
		{
			id: "search-fallback", chapter: 0, view: "settings", target: "preferences",
			preference: "people-search-fallback-provider", action: "preferences", actionLabel: "Inspect AI discovery preference",
			body: (session) => `<p><strong>AI discovery is optional and off by default.</strong> Review Tavily's results first. Only clicking <strong>Find more with AI</strong> runs your selected AI provider and saved model. It keeps existing contacts and never reruns Tavily. A shortfall never starts AI automatically.</p>
				<p>Current choice: <strong>${escapeHtml(session.settings.peopleSearchFallbackProvider || "NONE")}</strong>. Saving a key or advancing this tour never enables AI discovery, switches providers, or chains providers.</p>
				<p>Search tools and model tokens may have separate charges. Anthropic defaults to 1 web search; you can explicitly authorize up to 3 per AI request, plus model-token usage, billed to your own API account. Consent resets after each request or context change. More searches may still return duplicates or no results. Review <a href="https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool" target="_blank" rel="noopener">official Anthropic pricing</a> before Find more with AI or Retry with AI. Tavily Search has its own plan notice.</p>`,
		},
		{
			id: "personal-context", chapter: 0, view: "settings", target: "profile",
			preference: "experience", action: "preferences", actionLabel: "Edit factual context",
			body: () => `<p>For personal drafts, save your sender name, outreach goal, background, current goal, and genuine experience under <strong>Edit profile</strong>.</p>
				<p>Use facts you can stand behind. The app must not invent experience, achievements, or shared connections. At least one factual context field is needed before preparing a personal draft, even with Template.</p>
				<p>You do not need a resume upload to finish this tutorial. Entering context manually is enough.</p>`,
		},
		{
			id: "google-connections", chapter: 0, view: "settings", target: "google-connections",
			body: (session) => `<p>Google sign-in opens your private app account. <strong>Gmail &amp; Sheets Connect is separate authorization</strong> for approved Gmail sends, a private CRM, and reply syncing.</p>
				<p>${session.credentials.GOOGLE.configured ? "Google is connected." : "Google is not connected for Gmail & Sheets."} ${session.settings.spreadsheetId ? "Your Open CRM link is available." : "Create CRM becomes available after connecting."}</p>
				<p>Use the real <strong>Connect</strong>, <strong>Create CRM</strong>, or <strong>Open CRM</strong> control only if you want it. Nothing starts automatically. Connecting redirects to Google; this step is already saved so you can return to it.</p>
				<p>Gmail sending still requires a final, explicit approval of the exact email. Scheduled reply sync follows your saved preference.</p>`,
		},
		{
			id: "private-data", chapter: 0, view: "settings", target: "private-data",
			body: () => `<p><strong>Resume upload &amp; analysis is optional</strong> and may call your configured AI provider. It happens only when you choose the actual Upload &amp; analyze workflow, not during the tour.</p>
				<p>Review extracted facts yourself. Attaching a stored resume requires separate consent in each draft. Provider keys and resume files are encrypted; you can delete them from Settings.</p>
				<p>Legacy tracker import is also optional. Your private notes and imports stay in your signed-in account. The privacy policy explains storage and the verified account-deletion contact process.</p>`,
		},
		{
			id: "home-summary", chapter: 1, view: "home", target: "home-summary",
			title: "Home: your live starting point",
			body: () => `<p>Home search shows the total early-career roles in the catalog. Your journey shows your account's saved roles, current applications, and people tracked. Recent roles and search are shortcuts into Find jobs.</p>
				<p>Use the primary navigation for <strong>Find jobs, My jobs and People</strong>. On a phone these remain visible in the bottom bar. Open the account menu for <strong>Setup &amp; profile, Setup guide, Analytics and Home</strong>, or select the coffee brand for Home. No API keys are needed for browsing and tracking.</p>`,
		},
		{
			id: "home-journey", chapter: 1, view: "home", target: "home-journey",
			title: "Your Career Journey",
			body: () => `<p>Select Saved roles, Applications, or People tracked to see a useful next step from your current account records. These counts are not a history of career milestones; unavailable totals are not shown as zero.</p>
				<p>Tab to a count and press Enter or Space, or tap it. Overview restores only the selected view, not your jobs or people. The separate Home illustration is fictional, can be paused, and respects reduced motion.</p>`,
		},
		{
			id: "jobs-search", chapter: 1, view: "jobs", target: "jobs-search",
			title: "Jobs: find a role worth saving",
			body: () => `<p>Search by title or keyword. Combine <strong>Company, Location, Region, Career track, Industry, Length, and Term</strong>, then Search or Apply filters. Clear all removes the filters.</p>
				<p>Switch Grid/List for the same real results. Catalog status and empty states explain freshness or unmatched filters; the tutorial never inserts pretend opportunities.</p>`,
		},
		{
			id: "jobs-actions", chapter: 1, view: "jobs", target: "jobs-results",
			title: "Your shortlist lives in My jobs",
			body: () => `<p>Save a role with its bookmark or Save button; find it in the <strong>Saved</strong> collection or <strong>My jobs</strong>. View details opens the role panel; Open original posting uses a new tab.</p>
				<p>Keep private notes in the role panel or My jobs editor and choose Save. Unsaved notes survive navigation within this account, not logout or reload. Mark applied records a real application without regressing an existing Interview or Offer; use the stage selector for intentional changes. These account-scoped actions do not need provider keys.</p>
				<p>If enabled, <strong>People to contact</strong> opens that job's saved contacts, ordered by entry-level role peers, internship/new-grad recruiters, then other entry-level employees at the firm. Opening the list does not search. Review costs and explicitly choose Search public profiles to run a provider search. If there are no roles, continue safely and return when the catalog has data.</p>`,
		},
		{
			id: "applications", chapter: 1, view: "applications", target: "applications",
			title: "My jobs: record your real next step",
			body: () => `<p>Filter by stage, company, or location, search the table, and sort by update time or company. The row action opens the actual <strong>Edit application</strong> dialog.</p>
				<p>There you can save a stage and private next-step notes, open the job posting, or remove tracking. People to contact, when enabled, opens saved job contacts; only a later, cost-disclosed Search action calls providers.</p>
				<p>No applications yet? Mark a role Applied in Jobs when you have actually applied. Dates are recorded updates, not invented deadlines or reminders.</p>`,
		},
		{
			id: "networking-find", chapter: 1, view: "networking", target: "networking-find",
			title: "Networking: inspect before searching",
			action: "discovery", actionLabel: "Inspect the search form (no search)",
			body: () => `<p><strong>Find people</strong> on this page opens the search form. Set target roles, companies, industries, locations, keywords, seniority, objective, and count.</p>
				<p>Submitting that form calls <strong>Tavily only</strong>. Review the results before deciding whether to click the separate, cost-disclosed <strong>Find more with AI</strong> action. It uses only your selected AI provider, does not rerun Tavily, and keeps your saved contacts. Merely opening the form does not search, prepare, draft, or send.</p>`,
		},
		{
			id: "networking-review", chapter: 1, view: "networking", target: "networking-review",
			title: "First approval: the person",
			body: () => `<p>Review the person's public profile, evidence, and match quality. <strong>Possible/uncertain</strong> matches may have an unknown or different employer or role. Inspect the source before approving; neither this label nor a strong match verifies identity or authorizes sending.</p>
				<p><strong>Approve &amp; prepare</strong> shows costs before at most one selected email lookup, one targeted Tavily research search, and one saved drafting-model request. An authorized Apollo lookup may cost 1 credit for demographics or email even if no email is found; legacy plans differ. No phone, personal-email reveal, waterfall or automatic provider switching is enabled.</p>
				<p>Only identity-associated public professional snippets and your factual saved experience feed the draft. Review sources in <strong>Email &amp; research context</strong>. Missing, unverified or wrong-person email is never guessed; failed/empty research remains labelled as limited context. Completed stages are saved independently.</p>
				<p>The workflow rail remains useful when your network is empty. This tour never approves or prepares a person, and never uses a real contact as a scripted exercise.</p>`,
		},
		{
			id: "networking-send", chapter: 1, view: "networking", target: "networking-workflow",
			title: "Second approval: the exact email",
			body: () => `<p>Open <strong>Review draft</strong> to inspect sources and edit the recipient, subject, and body. Save changes before sending; unsaved or stale versions cannot be approved. Regenerate uses one selected drafting-model request and reuses saved email/research, including recorded failures. It never repeats lookup or research.</p>
				<p>Use the separately cost-disclosed <strong>Retry email &amp; draft</strong> or <strong>Retry research &amp; draft</strong> for a failed stage. Successful earlier stages are kept. Research is public evidence, not a guarantee that a fact or email remains current.</p>
				<p>A resume attachment is off until you explicitly choose it for that email. <strong>Approve and send</strong> and the final confirmation are your consent to send the exact draft through connected Gmail.</p>
				<p>Sent and Replied filters show recorded states, not completed coffee chats. Connected Sheets receives CRM updates; reply syncing follows your preference. Uncertain sends stay locked until you check Gmail Sent.</p>`,
		},
		{
			id: "analytics", chapter: 1, view: "analytics", target: "analytics",
			title: "Analytics: honest activity",
			body: () => `<p>See current application stages, top tracked companies, networking states, and recorded activity over the last 28 days.</p>
				<p>These are your real records, not synthetic conversion rates, growth promises, coffee-chat counts, or future reminders. Empty charts are honest when you have not recorded activity yet.</p>`,
		},
		{
			id: "workspace-settings", chapter: 1, view: "settings", target: "tutorial-entry",
			title: "You're ready to explore",
			body: () => `<p>Settings is where you manage your profile, preferences, encrypted credentials, Gmail &amp; Sheets, optional resume, privacy policy, and tracker import.</p>
				<p><strong>Resume tutorial</strong> keeps your saved place after Continue later. <strong>Replay tutorial</strong> explicitly starts again, even after completion or Skip tutorial.</p>
				<p>Finish saves completion to your account across browsers and devices. It does not enable any provider, authorize Google, require a key, or gate ordinary app access.</p>`,
		},
	];

	function escapeHtml(value) {
		return String(value ?? "").replace(/[&<>"']/g, (character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
		);
	}

	function keyLinks(provider) {
		const [label, dashboard, docs] = LINKS[provider];
		return `<p class="tutorial-provider-links"><a href="${dashboard}" target="_blank" rel="noopener noreferrer">Get a ${label} key <span class="sr-only">(new tab)</span></a><a href="${docs}" target="_blank" rel="noopener noreferrer">Official guide <span class="sr-only">(new tab)</span></a></p>`;
	}

	function credentialSummary(session, provider) {
		const credential = session.credentials[provider];
		return `<p class="tutorial-key-state">${credential?.configured ? `<strong>Saved</strong> <span>${escapeHtml(credential.hint)}</span> · not provider-validated` : "<strong>Not saved</strong> · optional for touring"}</p>`;
	}

	function modelSummary(session) {
		const provider = session.settings.draftProvider;
		const field = { GEMINI: "geminiModel", OPENAI: "openAiModel", ANTHROPIC: "anthropicModel" }[provider];
		return field ? ` · model <strong>${escapeHtml(session.settings[field])}</strong>` : " · no API key or AI provider request";
	}

	function validState(state) {
		return state?.version === VERSION &&
			STEPS.some((step) => step.id === state.step) &&
			["legacy", "invited", "in_progress", "paused", "completed", "skipped"].includes(state.status) &&
			Number.isSafeInteger(state.revision) && state.revision >= 0;
	}

	function settingsHtml(session) {
		const state = session?.onboarding;
		const resumable = validState(state) && ["paused", "in_progress"].includes(state.status);
		const invited = validState(state) && state.status === "invited";
		const description = {
			legacy: "Optional guide available. Your existing workspace is unchanged.",
			invited: "Your optional first-login guide is ready.",
			in_progress: "Tutorial in progress. Resume your saved step or start again.",
			paused: "Saved for later. It will not reopen automatically.",
			completed: "Tutorial completed. Replay whenever you need a refresher.",
			skipped: "Tutorial skipped. It will not reopen unless you choose Replay.",
		}[state?.status] || "The tutorial is unavailable until the workspace is reloaded.";
		return `<section class="settings-reference-card tutorial-entry-card" data-tour="tutorial-entry">
			<div class="settings-card-heading"><span aria-hidden="true">?</span><div><h2>Workspace tutorial</h2><p>Set up API keys · Explore your workspace</p></div></div>
			<p>${escapeHtml(description)}</p><div class="actions">
				${resumable ? '<button class="primary" data-onboarding-launch="resume">Resume tutorial</button>' : ""}
				${validState(state) ? `<button class="${resumable ? "secondary" : "primary"}" data-onboarding-launch="${invited ? "start" : "replay"}">${invited ? "Start tutorial" : "Replay tutorial"}</button>` : ""}
			</div><small>No keys required. Progress is saved privately to your account, not browser storage.</small>
		</section>`;
	}

	function create(options) {
		const root = document.createElement("div");
		root.id = "onboarding-root";
		root.hidden = true;
		document.body.append(root);
		const announcement = document.createElement("div");
		announcement.className = "sr-only";
		announcement.setAttribute("role", "status");
		announcement.setAttribute("aria-live", "polite");
		announcement.setAttribute("aria-atomic", "true");
		document.body.append(announcement);
		const listeners = new AbortController();
		let userId = null;
		let progress = null;
		let visible = false;
		let busy = false;
		let failure = "";
		let pending = null;
		let generation = 0;
		let frame = 0;
		let revealPending = false;
		let returnFocus = null;
		let destroyed = false;
		let waitingForDialog = false;
		let focusPending = null;
		let focusFrame = 0;
		const panelObserver = new ResizeObserver(() => updateContext());

		const currentStep = () => STEPS.find((step) => step.id === progress?.step);
		const clearSecrets = () => {
			document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
		};
		const accountIsCurrent = (identity, turn) =>
			!destroyed && turn === generation && identity === userId &&
			options.getSession()?.authenticated && options.getSession()?.user?.id === identity;

		function clearContext() {
			document.querySelectorAll("[data-tutorial-note]").forEach((note) => note.remove());
			root.querySelector(".tutorial-spotlight")?.setAttribute("hidden", "");
		}

		function beforeRender() {
			clearSecrets();
			clearContext();
		}

		function sync() {
			const session = options.getSession();
			if (!session?.authenticated || !session.user?.id || !validState(session.onboarding)) {
				dispose();
				return;
			}
			const changedAccount = userId !== session.user.id;
			if (changedAccount) {
				dispose();
				userId = session.user.id;
				generation += 1;
				returnFocus = document.activeElement;
				visible = ["invited", "in_progress"].includes(session.onboarding.status);
			}
			progress = { ...session.onboarding };
			if (["completed", "skipped", "legacy", "paused"].includes(progress.status)) visible = false;
			if (!visible) {
				hide();
				return;
			}
			renderPanel(changedAccount);
			if (changedAccount && progress.status === "in_progress") goToStep(true);
			else if (options.getView() === currentStep()?.view) goToStep(changedAccount);
			else updateContext(changedAccount);
		}

		function hide() {
			clearContext();
			root.hidden = true;
			document.body.classList.remove("tutorial-open");
			document.documentElement.style.removeProperty("--tutorial-space");
		}

		function dispose() {
			clearSecrets();
			options.clearPrivateDialogs?.();
			hide();
			userId = null;
			progress = null;
			visible = false;
			busy = false;
			pending = null;
			failure = "";
			waitingForDialog = false;
			focusPending = null;
			cancelAnimationFrame(focusFrame);
			panelObserver.disconnect();
			generation += 1;
			cancelAnimationFrame(frame);
		}

		function restoreFocus() {
			const target = returnFocus?.isConnected &&
				returnFocus.matches("button,a[href],input,select,textarea,[tabindex]")
				? returnFocus : document.getElementById("main-content");
			target?.focus({ preventScroll: true });
		}

		function renderPanel(focus = false) {
			const step = currentStep();
			if (!visible || !step) return hide();
			const previousAction = root.contains(document.activeElement) ? document.activeElement.dataset.tutorialAction : null;
			const previousFocusId = root.contains(document.activeElement) ? document.activeElement.id : null;
			const index = STEPS.indexOf(step);
			const chapterSteps = STEPS.filter((item) => item.chapter === step.chapter);
			const chapterIndex = chapterSteps.indexOf(step);
			const invited = progress.status === "invited";
			const otherPage = options.getView() !== step.view;
			root.hidden = false;
			document.body.classList.add("tutorial-open");
			root.innerHTML = `<div class="tutorial-spotlight" aria-hidden="true" hidden></div>
				<section class="tutorial-panel" data-tutorial-step="${step.id}" data-tutorial-status="${progress.status}" role="dialog" aria-modal="false" aria-labelledby="tutorial-title" aria-describedby="tutorial-progress" aria-busy="${busy}">
					<header class="tutorial-header"><span class="tutorial-mark" aria-hidden="true">CC</span><span>Workspace tutorial</span><button class="icon-button" data-tutorial-action="pause" aria-label="Continue later (save and close tutorial)" ${busy ? "disabled" : ""}>×</button></header>
					<ol class="tutorial-chapters" aria-label="Tutorial chapters">${CHAPTERS.map((chapter, chapterNumber) => `<li ${step.chapter === chapterNumber ? 'aria-current="step"' : ""}><span aria-hidden="true">${chapterNumber + 1}</span>${chapter}</li>`).join("")}</ol>
					<p id="tutorial-progress" class="tutorial-progress">Chapter ${step.chapter + 1} of 2 · Step ${chapterIndex + 1} of ${chapterSteps.length}</p>
					<progress max="${STEPS.length}" value="${index + 1}" aria-label="Overall tutorial progress"></progress>
					<div class="tutorial-content"><h2 id="tutorial-title" tabindex="-1">${escapeHtml(step.title || { "private-data": "Your private data", "google-connections": "Sign-in is not Gmail authorization", "personal-context": "Keep your experience factual", "search-fallback": "AI discovery: your explicit choice", drafting: "One drafting provider, or Template" }[step.id])}</h2>
						${step.body(options.getSession())}
						<p class="tutorial-context-note" ${otherPage ? "" : "hidden"}>You're exploring another page. <button class="text-button" data-tutorial-action="return">Return to this step</button>, or continue the guide from here.</p>
						<p id="tutorial-target-note" class="tutorial-context-note" hidden>This control is not visible in the current layout or empty state. Try <button class="text-button" data-tutorial-action="return">Return to this step</button>, or continue safely.</p>
						${step.action ? `<button class="secondary tutorial-inspect" data-tutorial-action="${step.action}" ${busy ? "disabled" : ""}>${escapeHtml(step.actionLabel)}</button>` : ""}
					</div>
					<div class="tutorial-save-state" role="${failure ? "alert" : "status"}">${failure ? `<p>${escapeHtml(failure)}</p><button class="secondary" data-tutorial-action="retry">Retry saving</button>` : busy ? "Saving to your account…" : invited ? "Optional. Your workspace is already available." : "Progress saved to your account."}</div>
					<div class="tutorial-actions"><button class="secondary" data-tutorial-action="back" ${busy || invited || index === 0 ? "disabled" : ""}>Back</button><button class="primary" data-tutorial-action="${invited ? "start" : index === STEPS.length - 1 ? "complete" : "next"}" ${busy || failure ? "disabled" : ""}>${invited ? "Start tutorial" : index === STEPS.length - 1 ? "Finish tutorial" : "Next"}</button></div>
					<div class="tutorial-dismiss-actions">${invited ? '<button class="text-button" data-tutorial-action="explore">Explore without keys</button>' : step.chapter === 0 && index > 0 ? '<button class="text-button" data-tutorial-action="next">Skip this step for now</button>' : '<button class="text-button" data-tutorial-action="pause">Continue later</button>'}<button class="text-button" data-tutorial-action="skip" ${busy ? "disabled" : ""}>Skip tutorial</button></div>
					<p class="tutorial-footnote">Close or Escape saves your place for Settings → Resume. Skip ends the guide, not access to the app.</p>
				</section>`;
			const panel = root.querySelector(".tutorial-panel");
			panel.hidden = true;
			panelObserver.disconnect();
			panelObserver.observe(panel);
			if (focus) focusPending = "#tutorial-title";
			else if (previousAction) focusPending = `[data-tutorial-action="${previousAction}"]`;
			else if (previousFocusId) focusPending = `#${previousFocusId}`;
			announcement.textContent = `${CHAPTERS[step.chapter]}. Step ${chapterIndex + 1} of ${chapterSteps.length}. ${root.querySelector("#tutorial-title")?.textContent}`;
		}

		async function save(action, stepId) {
			if (busy || !progress || !userId) return;
			if (action === "pause" || action === "skip") clearSecrets();
			const identity = userId;
			const turn = generation;
			const input = { version: VERSION, revision: progress.revision, action, step: stepId };
			busy = true;
			failure = "";
			pending = { action, stepId };
			renderPanel();
			updateContext();
			try {
				const result = await options.api("/api/onboarding", { method: "PUT", body: input });
				if (!accountIsCurrent(identity, turn)) return;
				if (!validState(result.onboarding)) throw new Error("The server did not return saved tutorial progress.");
				applySaved(result.onboarding, action);
			} catch (error) {
				if (!accountIsCurrent(identity, turn)) return;
				if (error.status === 409) {
					try {
						const result = await options.api("/api/onboarding");
						if (!accountIsCurrent(identity, turn)) return;
						if (!validState(result.onboarding)) throw new Error("Saved progress could not be read.");
						const saved = result.onboarding;
						// A lost response is confirmed by a fresh read, never assumed successful.
						if (saved.revision === input.revision + 1 && saved.step === input.step &&
							saved.status === ({ pause: "paused", skip: "skipped", complete: "completed" }[action] || "in_progress")) {
							applySaved(saved, action);
						} else {
							options.getSession().onboarding = saved;
							progress = { ...saved };
							pending = null;
							failure = "";
							visible = saved.status === "in_progress" || saved.status === "invited";
							options.notify("Another window changed the tutorial. Its saved progress is now loaded.", true);
							if (visible) { renderPanel(true); goToStep(true); } else { hide(); restoreFocus(); }
						}
					} catch (readError) {
						if (accountIsCurrent(identity, turn)) failure = `Progress is not confirmed. ${readError.message} Retry when connected.`;
					}
				} else {
					failure = `Progress was not confirmed saved. ${error.message} Your place has not advanced.`;
				}
			} finally {
				if (accountIsCurrent(identity, turn)) {
					busy = false;
					if (visible) { renderPanel(); updateContext(); }
				}
			}
		}

		function applySaved(saved, action) {
			options.getSession().onboarding = { ...saved };
			const entry = document.querySelector(".tutorial-entry-card");
			if (entry) entry.outerHTML = settingsHtml(options.getSession());
			progress = { ...saved };
			pending = null;
			failure = "";
			busy = false;
			clearSecrets();
			visible = saved.status === "in_progress";
			if (visible) {
				renderPanel(true);
				goToStep(true);
			} else {
				hide();
				restoreFocus();
				options.notify(action === "complete" ? "Tutorial completed. Your workspace is ready." : action === "skip" ? "Tutorial skipped. Replay is available in Settings." : "Your place is saved. Resume the tutorial from Settings.");
			}
		}

		function launch(action) {
			const session = options.getSession();
			if (!session?.authenticated || !validState(session.onboarding)) return;
			if (userId !== session.user.id) sync();
			returnFocus = document.activeElement;
			visible = true;
			progress = { ...session.onboarding };
			failure = "";
			if (action === "resume" && progress.status === "in_progress") {
				renderPanel(true);
				goToStep(true);
				return;
			}
			save(action, action === "replay" ? STEPS[0].id : progress.step);
		}

		function goToStep(reveal) {
			const step = currentStep();
			if (!visible || !step) return;
			if (options.getView() !== step.view) options.navigate(step.view, { tutorial: true });
			if (["tavily", "hunter"].includes(step.id)) {
				const details = document.querySelector(".credentials-details");
				if (details) details.open = true;
			}
			updateContext(reveal);
		}

		function visibleElement(element) {
			if (!element?.isConnected || element.closest("[hidden]")) return false;
			if (element.closest("dialog") && !element.closest("dialog").open) return false;
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
		}

		function updateContext(reveal = false) {
			revealPending ||= reveal;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const shouldReveal = revealPending;
				revealPending = false;
				layout(shouldReveal);
			});
		}

		function keepFocusedControlVisible() {
			const target = document.activeElement;
			const panel = root.querySelector(".tutorial-panel");
			if (!visible || root.hidden || panel?.hidden || root.contains(target) ||
				options.isMenuOpen?.() || document.querySelector("dialog:modal") ||
				!target?.matches("button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex='-1'])")) return;
			const rect = target.getBoundingClientRect();
			const coach = panel.getBoundingClientRect();
			const top = window.visualViewport?.offsetTop || 0;
			if (Math.min(rect.right, coach.right) <= Math.max(rect.left, coach.left) ||
				Math.min(rect.bottom, coach.bottom) <= Math.max(rect.top, coach.top) ||
				coach.top - top - 8 < Math.min(44, rect.height)) return;
			window.scrollBy({ top: rect.bottom - coach.top + 8, behavior: "instant" });
		}

		function layout(reveal) {
			if (!visible || !currentStep() || root.hidden) return;
			const panel = root.querySelector(".tutorial-panel");
			if (options.isMenuOpen?.()) {
				cancelAnimationFrame(focusFrame);
				panel.hidden = true;
				root.querySelector(".tutorial-spotlight").hidden = true;
				return;
			}
			const modal = [...document.querySelectorAll("dialog[open]")].find((element) => element.matches(":modal"));
			if (modal) {
				waitingForDialog = true;
				panel.hidden = true;
				root.querySelector(".tutorial-spotlight").hidden = true;
				if (!modal.querySelector("[data-tutorial-note]")) {
					const note = document.createElement("p");
					note.dataset.tutorialNote = "";
					note.className = "tutorial-dialog-note";
					note.textContent = "Tutorial is waiting while you use this dialog. Save or close it to return to the same step; no tour action submits this form.";
					(modal.querySelector(".dialog-head") || modal.firstElementChild)?.after(note);
				}
				return;
			}
			document.querySelectorAll("[data-tutorial-note]").forEach((note) => note.remove());
			panel.hidden = false;
			if (waitingForDialog) {
				waitingForDialog = false;
				focusPending = "#tutorial-title";
			}
			const step = currentStep();
			const otherPage = options.getView() !== step.view;
			const contextNote = root.querySelector(".tutorial-context-note");
			contextNote.hidden = !otherPage;
			const target = otherPage || options.isMenuOpen?.() ? null : document.querySelector(`[data-tour="${step.target}"]`);
			const exists = visibleElement(target);
			const targetNote = root.querySelector("#tutorial-target-note");
			targetNote.hidden = exists || otherPage;
			const viewport = window.visualViewport;
			const insets = getComputedStyle(root);
			const leftEdge = (viewport?.offsetLeft || 0) + parseFloat(insets.paddingLeft);
			const topEdge = (viewport?.offsetTop || 0) + parseFloat(insets.paddingTop);
			const rightEdge = (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth) - parseFloat(insets.paddingRight);
			const bottomEdge = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - parseFloat(insets.paddingBottom);
			const shortViewport = bottomEdge - topEdge <= 500;
			root.style.setProperty("--tutorial-viewport-height", `${bottomEdge - topEdge}px`);
			panel.classList.toggle("tutorial-panel-scroll", shortViewport);
			const width = Math.min(392, rightEdge - leftEdge - 16);
			panel.style.width = `${width}px`;
			const height = panel.getBoundingClientRect().height;
			const gutter = 12;
			const topLimit = topEdge + (shortViewport ? 8 : 80);
			let rect = exists ? target.getBoundingClientRect() : null;
			const onRight = rect && rightEdge - rect.right >= width + gutter * 2;
			const onLeft = rect && rect.left - leftEdge >= width + gutter * 2;
			const beside = rightEdge - leftEdge > 760 && (onRight || onLeft);
			panel.style.left = `${beside ? onRight ? rect.right + gutter : rect.left - width - gutter : rightEdge - width - 8}px`;
			panel.style.top = `${beside ? Math.max(topLimit, Math.min(rect.top, bottomEdge - height - 8)) : Math.max(topEdge + 8, bottomEdge - height - 8)}px`;
			document.documentElement.style.setProperty("--tutorial-space", `${height + 24}px`);
			const usableBottom = beside ? bottomEdge - 8 : bottomEdge - height - 20;
			if (reveal && exists && (rect.top < topLimit || rect.bottom > usableBottom)) {
				const available = Math.max(80, usableBottom - topLimit);
				const desiredTop = rect.height > available ? topLimit : topLimit + (available - rect.height) / 2;
				window.scrollBy({ top: rect.top - desiredTop, behavior: "instant" });
				rect = target.getBoundingClientRect();
				if (beside) panel.style.top = `${Math.max(topLimit, Math.min(rect.top, bottomEdge - height - 8))}px`;
			}
			const ring = root.querySelector(".tutorial-spotlight");
			const top = rect ? Math.max(topLimit - 4, rect.top - 4) : 0;
			const bottom = rect ? Math.min(usableBottom, rect.bottom + 4) : 0;
			ring.hidden = !exists || bottom <= top || rect.right < leftEdge || rect.left >= rightEdge;
			if (!ring.hidden) {
				const left = Math.max(leftEdge + 4, rect.left - 4);
				ring.style.left = `${left}px`;
				ring.style.top = `${top}px`;
				ring.style.width = `${Math.min(rightEdge - 4, rect.right + 4) - left}px`;
				ring.style.height = `${bottom - top}px`;
			}
			if (focusPending) {
				cancelAnimationFrame(focusFrame);
				// Wait for the rebuilt panel's layout before moving focus.
				focusFrame = requestAnimationFrame(() => {
					if (!focusPending || !visible || root.hidden || waitingForDialog || document.querySelector("dialog:modal")) return;
					let target = [...root.querySelectorAll(focusPending)].find((element) =>
						!element.matches(":disabled") && visibleElement(element));
					if (!target) {
						if (busy) return;
						target = root.querySelector(failure ? '[data-tutorial-action="retry"]' : "#tutorial-title");
					}
					if (!visibleElement(target)) return;
					target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
					target.focus({ preventScroll: true });
					if (document.activeElement === target) focusPending = null;
				});
			}
			keepFocusedControlVisible();
		}

		document.addEventListener("click", (event) => {
			const launcher = event.target.closest("[data-onboarding-launch]");
			if (launcher) launch(launcher.dataset.onboardingLaunch);
		}, { signal: listeners.signal });
		root.addEventListener("click", (event) => {
			const button = event.target.closest("[data-tutorial-action]");
			if (!button || button.disabled || busy) return;
			const action = button.dataset.tutorialAction;
			const step = currentStep();
			const index = STEPS.indexOf(step);
			if (action === "retry") { if (pending) save(pending.action, pending.stepId); return; }
			if (action === "return") { goToStep(true); return; }
			if (action === "preferences") {
				if (options.getView() !== "settings") options.navigate("settings", { tutorial: true });
				options.openPreferences();
				document.getElementById(step.preference)?.focus();
				updateContext();
				return;
			}
			if (action === "discovery") {
				if (options.getView() !== "networking") options.navigate("networking", { tutorial: true });
				options.openDiscovery();
				updateContext();
				return;
			}
			if (action === "next" || action === "back") {
				const nextStep = STEPS[index + (action === "next" ? 1 : -1)];
				if (nextStep) save("progress", nextStep.id);
				return;
			}
			save(action, action === "explore" ? "home-summary" : progress.step);
		}, { signal: listeners.signal });
		document.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || !visible || busy || root.hidden ||
				document.querySelector("dialog:modal") || options.isMenuOpen?.()) return;
			event.preventDefault();
			save("pause", progress.step);
		}, { signal: listeners.signal });
		window.addEventListener("resize", () => updateContext(true), { passive: true, signal: listeners.signal });
		window.addEventListener("scroll", () => updateContext(), { passive: true, signal: listeners.signal });
		window.visualViewport?.addEventListener("resize", () => updateContext(true), { passive: true, signal: listeners.signal });
		window.visualViewport?.addEventListener("scroll", () => updateContext(), { passive: true, signal: listeners.signal });
		document.addEventListener("focusin", keepFocusedControlVisible, { signal: listeners.signal });
		document.addEventListener("close", () => updateContext(), { capture: true, signal: listeners.signal });
		const observer = new MutationObserver(() => updateContext());
		observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
		window.addEventListener("pagehide", (event) => {
			dispose();
			destroyed = true;
			listeners.abort();
			observer.disconnect();
			panelObserver.disconnect();
			root.remove();
			announcement.remove();
			if (event.persisted) {
				// A restored page needs fresh authentication and a new, live controller.
				window.addEventListener("pageshow", (shown) => {
					if (shown.persisted) window.location.reload();
				}, { once: true });
			}
		}, { once: true, signal: listeners.signal });

		return Object.freeze({ sync, beforeRender, dispose, refreshLayout: updateContext });
	}

	return Object.freeze({ VERSION, stepIds: Object.freeze(STEPS.map((step) => step.id)), settingsHtml, create });
});
