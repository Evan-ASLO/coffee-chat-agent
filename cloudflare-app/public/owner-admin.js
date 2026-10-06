(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.OwnerAdmin = api;
})(typeof window === "undefined" ? null : window, function () {
	"use strict";

	function initialState() {
		return {
			open: false, section: "activity", days: "28", asOf: "",
			activity: null, activityStatus: "idle", activityError: "", accountCursors: [null],
			events: null, eventsStatus: "idle", eventsError: "", eventCursors: [null],
			userFilter: null, action: "ALL",
			access: null, accessStatus: "idle", accessError: "",
			mutating: false, mutationError: "", result: null, bulk: null,
		};
	}

	function create(options) {
		const doc = options.document || globalThis.document;
		const esc = options.escapeHtml;
		const date = options.formatDate;
		const number = (value) => Number(value).toLocaleString();
		let state = initialState();
		let identity = "";
		let generation = 0;
		let modal = null;
		const requests = new Map();

		function ownerKey() {
			const session = options.getSession();
			return session?.authenticated && session.isBetaAdmin === true
				? `${session.user.id}|${session.user.email}` : "";
		}

		function clear() {
			generation++;
			for (const request of requests.values()) request.abort();
			requests.clear();
			closeDialog(true);
			identity = "";
			state = initialState();
			doc?.getElementById("owner-controls")?.remove();
		}

		function syncSession() {
			const next = ownerKey();
			if (identity !== next) {
				clear();
				identity = next;
			}
			return Boolean(identity);
		}

		async function call(slot, path, init = {}) {
			if (!syncSession()) return null;
			requests.get(slot)?.abort();
			const controller = new AbortController();
			const turn = generation;
			requests.set(slot, controller);
			const current = () => !controller.signal.aborted && turn === generation && ownerKey() === identity &&
				identity && requests.get(slot) === controller;
			try {
				const result = await options.api(path, { ...init, signal: controller.signal });
				return current() ? result : null;
			} catch (error) {
				if (!current() || controller.signal.aborted) return null;
				throw error;
			} finally {
				if (requests.get(slot) === controller) requests.delete(slot);
			}
		}

		function render() {
			if (!syncSession()) return "";
			return `<details id="owner-controls" class="admin-disclosure" ${state.open ? "open" : ""}>
				<summary>${options.icon("shield")}<span><strong>Owner tools</strong><small>Operational activity &amp; private-beta access</small></span>${options.icon("chevron-right")}</summary>
				<div class="admin-settings">
					<nav class="owner-tabs" aria-label="Owner tools">
						<button id="owner-activity-tab" class="secondary" data-owner-section="activity" aria-pressed="${state.section === "activity"}">Activity</button>
						<button id="owner-beta-tab" class="secondary" data-owner-section="beta" aria-pressed="${state.section === "beta"}">Beta access</button>
					</nav>
					<div id="owner-panel">${panelHtml()}</div>
				</div>
			</details>`;
		}

		function wire() {
			const disclosure = doc?.getElementById("owner-controls");
			if (!disclosure || !syncSession()) return;
			disclosure.addEventListener("toggle", () => {
				state.open = disclosure.open;
				if (state.open) ensureLoaded();
			});
			disclosure.querySelectorAll("[data-owner-section]").forEach((button) => {
				button.addEventListener("click", () => {
					state.section = button.dataset.ownerSection;
					disclosure.querySelectorAll("[data-owner-section]").forEach((tab) =>
						tab.setAttribute("aria-pressed", String(tab.dataset.ownerSection === state.section)));
					paint();
					ensureLoaded();
				});
			});
			wirePanel();
			if (state.open) ensureLoaded();
		}

		function ensureLoaded() {
			if (state.section === "activity" && state.activityStatus === "idle") void loadActivity();
			if (state.section === "beta" && state.accessStatus === "idle") void loadAccess();
		}

		function paint() {
			if (!identity || ownerKey() !== identity) return;
			const panel = doc?.getElementById("owner-panel");
			if (!panel) return;
			const focus = panel.contains(doc.activeElement) ? doc.activeElement.id : "";
			panel.innerHTML = panelHtml();
			wirePanel();
			if (focus) doc.getElementById(focus)?.focus({ preventScroll: true });
		}

		function panelHtml() {
			return state.section === "beta" ? betaHtml() : activityHtml();
		}

		function notice(message, error = false) {
			return `<p class="notice ${error ? "warning" : ""}" role="${error ? "alert" : "status"}">${esc(message)}</p>`;
		}

		function activityHtml() {
			const data = state.activity;
			return `<section class="panel owner-activity" aria-labelledby="owner-activity-title">
				<div class="panel-head"><div><p class="eyebrow">Owner only</p><h2 id="owner-activity-title">Recorded account activity</h2>
					<p>Existing operational records, not pageviews or live presence. Background work is not proof that someone was online.</p></div></div>
				<div class="owner-filters">
					<label>Recent period<select id="owner-days"><option value="7" ${state.days === "7" ? "selected" : ""}>Last 7 UTC days</option><option value="28" ${state.days === "28" ? "selected" : ""}>Last 28 UTC days</option></select></label>
					<button id="owner-refresh" class="secondary">Refresh activity</button>
				</div>
				${state.activityError ? notice(state.activityError, true) : ""}
				${state.activityStatus === "loading" ? notice("Loading recorded activity...") : ""}
				${data && state.activityStatus === "ready" ? `
					<p class="owner-period">From ${esc(date(data.period.from))} through ${esc(date(data.period.asOf))}. Refresh explicitly for newer events.</p>
					<div class="owner-metrics">
						${metric("Registered accounts", data.summary.accounts, "Non-deleted accounts as of this snapshot")}
						${metric("Accounts with events", data.summary.accountsWithEvents, "At least one record in this period")}
						${metric("Recorded events", data.summary.total, "Operational actions, not visits")}
						${metric("AI search issues", data.summary.searchIssues, "Recorded limited, unavailable or failed AI searches, including legacy fallback attempts")}
					</div>
					<h3 id="owner-accounts-title">Accounts in this period</h3>
					<p>Counts are recorded actions, not current saved-job or draft totals. Tracker changes include stage changes, removals and imports.</p>
					${data.accounts.length ? `<div class="owner-table-scroll" role="region" aria-labelledby="owner-accounts-title" tabindex="0">
						<table class="owner-accounts-table">
							<thead><tr><th scope="col">Account</th><th scope="col">All events</th><th scope="col">People searches</th><th scope="col">Job saves</th><th scope="col">Tracker changes</th><th scope="col">Draft changes</th><th scope="col">Sends</th><th scope="col">Last recorded event</th><th scope="col">Filter</th></tr></thead>
							<tbody>${data.accounts.map((account) => `<tr>
								<th scope="row"><strong>${esc(account.name || "Registered account")}</strong><small>${esc(account.email)}</small></th>
								${["total", "peopleSearches", "jobSaves", "trackerChanges", "draftChanges", "outreachSends"].map((key) => `<td>${number(account.counts[key])}</td>`).join("")}
								<td>${account.lastRecordedEventAt ? esc(date(account.lastRecordedEventAt)) : "No recorded activity in this period"}</td>
								<td><button class="secondary" data-owner-user="${esc(account.id)}" aria-label="View events for ${esc(account.email)}">Events</button></td>
							</tr>`).join("")}</tbody>
						</table></div>` : notice("No registered accounts in this snapshot.")}
					${pager("accounts", state.accountCursors.length, data.nextCursor, data.pageSize)}
					${eventsHtml()}
				` : ""}
				<p class="owner-privacy-note">Only basic account identifiers, action counts, timestamps and allowlisted search outcomes are shown. No private content, credentials, recipient details, search queries or raw event metadata. Failures not recorded in the audit log are not counted. <a href="/privacy.html">Privacy policy</a></p>
			</section>`;
		}

		function metric(label, value, hint) {
			return `<div class="owner-metric"><span>${esc(label)}</span><strong>${number(value)}</strong><small>${esc(hint)}</small></div>`;
		}

		function eventsHtml() {
			const users = new Map(state.activity.accounts.map((account) => [account.id, account]));
			if (state.userFilter) users.set(state.userFilter.id, state.userFilter);
			return `<section class="owner-events" aria-labelledby="owner-events-title">
				<h3 id="owner-events-title">Recent recorded events</h3>
				<div class="owner-filters">
					<label>Account<select id="owner-user-filter"><option value="">All registered accounts</option>${[...users.values()].map((account) => `<option value="${esc(account.id)}" ${state.userFilter?.id === account.id ? "selected" : ""}>${esc(account.email)}</option>`).join("")}</select><small>Account choices follow the account page above.</small></label>
					<label>Action<select id="owner-action-filter">${state.activity.actions.map((action) => `<option value="${esc(action.value)}" ${state.action === action.value ? "selected" : ""}>${esc(action.label)}</option>`).join("")}</select></label>
					<button id="owner-events-reset" class="secondary">Clear filters</button>
				</div>
				${state.eventsStatus === "loading" ? notice("Loading recent events...") : ""}
				${state.eventsError ? `${notice(state.eventsError, true)}<button id="owner-events-retry" class="secondary">Retry events</button>` : ""}
				${state.eventsStatus === "ready" && state.events ? `
					${state.events.events.length ? `<ol class="owner-event-list">${state.events.events.map((event) => `<li>
						<div><strong>${esc(event.label)}</strong><span>${esc(event.user.name || "Registered account")} &middot; ${esc(event.user.email)}</span>
							${event.searchFallback ? `<small>AI search: ${esc(event.searchFallback.status.toLowerCase().replaceAll("_", " "))}${event.searchFallback.provider ? ` (${esc(event.searchFallback.provider)})` : ""}${event.searchFallback.reason ? ` &middot; ${esc(event.searchFallback.reason.replaceAll("_", " "))}` : ""}</small>` : ""}
						</div><time datetime="${esc(event.recordedAt)}">${esc(date(event.recordedAt))}</time>
					</li>`).join("")}</ol>` : notice("No recorded events match this period and these filters.")}
					${pager("events", state.eventCursors.length, state.events.nextCursor, state.events.pageSize)}
				` : ""}
			</section>`;
		}

		function pager(kind, page, next, size) {
			return `<nav class="owner-pagination" aria-label="${kind === "accounts" ? "Account" : "Event"} pages">
				<button id="owner-${kind}-previous" class="secondary" ${page === 1 ? "disabled" : ""}>Previous</button>
				<span>Page ${page} &middot; up to ${size} ${kind} per page</span>
				<button id="owner-${kind}-next" class="secondary" ${next ? "" : "disabled"}>Next</button>
			</nav>`;
		}

		async function loadActivity(reset = false) {
			if (!syncSession()) return;
			const turn = generation;
			if (reset) {
				state.asOf = "";
				state.accountCursors = [null];
				state.eventCursors = [null];
				state.events = null;
				state.eventsStatus = "idle";
				requests.get("events")?.abort();
			}
			state.activity = null;
			state.activityStatus = "loading";
			state.activityError = "";
			paint();
			const query = new URLSearchParams({ days: state.days });
			if (state.asOf) query.set("asOf", state.asOf);
			if (state.accountCursors.at(-1)) query.set("cursor", state.accountCursors.at(-1));
			try {
				const result = await call("activity", `/api/beta/admin/activity?${query}`);
				if (!result || turn !== generation || ownerKey() !== identity) return;
				state.activity = result;
				state.asOf = result.period.asOf;
				state.activityStatus = "ready";
				paint();
				if (state.eventsStatus === "idle") await loadEvents();
			} catch (error) {
				state.activityStatus = "error";
				state.activityError = error.message;
				paint();
			}
		}

		async function loadEvents() {
			if (!syncSession() || !state.activity) return;
			const turn = generation;
			state.eventsStatus = "loading";
			state.eventsError = "";
			state.events = null;
			paint();
			const query = new URLSearchParams({ days: state.days, asOf: state.asOf, action: state.action });
			if (state.userFilter) query.set("userId", state.userFilter.id);
			if (state.eventCursors.at(-1)) query.set("cursor", state.eventCursors.at(-1));
			try {
				const result = await call("events", `/api/beta/admin/activity/events?${query}`);
				if (!result || turn !== generation || ownerKey() !== identity) return;
				state.events = result;
				state.eventsStatus = "ready";
			} catch (error) {
				state.eventsStatus = "error";
				state.eventsError = error.message;
			}
			paint();
		}

		function betaHtml() {
			const data = state.access;
			const pending = data?.requests.filter((entry) => entry.status === "PENDING") || [];
			const denied = data?.requests.filter((entry) => entry.status === "DENIED") || [];
			const approved = data?.access.filter((entry) => entry.status === "APPROVED") || [];
			const revoked = data?.access.filter((entry) => entry.status === "REVOKED") || [];
			const disabled = state.mutating || state.accessStatus !== "ready";
			const total = data?.pendingTotal;
			const limit = data?.approvalBatchLimit;
			return `<section class="panel" aria-labelledby="owner-beta-title">
				<div class="panel-head"><div><p class="eyebrow">Owner only</p><h2 id="owner-beta-title">Private-beta access</h2><p>These controls grant sign-in and workspace access, not owner permissions or outreach approval. Owner identities come only from the server's <code>BETA_ADMIN_EMAILS</code>.</p></div><button id="owner-access-refresh" class="secondary" ${state.mutating ? "disabled" : ""}>Refresh access</button></div>
				${state.accessStatus === "loading" ? notice("Loading beta access...") : ""}
				${state.accessError ? notice(state.accessError, true) : ""}
				${state.mutationError ? notice(state.mutationError, true) : ""}
				${state.result ? resultHtml(state.result) : ""}
				<form id="beta-approve-email-form" class="beta-invite-form">
					<label>Approve or re-approve an email<input id="beta-approve-email" type="email" maxlength="320" autocomplete="off" required ${disabled ? "disabled" : ""} /></label>
					<button class="primary" ${disabled ? "disabled" : ""}>Approve email</button>
				</form>
				<div class="panel-head owner-pending-heading"><div><h3>Pending requests${total === undefined ? "" : ` (${number(total)})`}</h3><p>Only verified, currently pending requests are eligible. You will review the exact accounts before confirming.</p></div>
					<button id="beta-approve-all" class="primary" ${disabled || !total || state.bulk ? "disabled" : ""}>${total === undefined ? "Approve all pending" : total > limit ? `Review pending batch (${limit} of ${number(total)})` : `Approve all pending (${number(total)})`}</button>
				</div>
				${data ? `<p class="owner-privacy-note">At most ${limit} requests per confirmation. Larger queues need separate, explicitly reviewed batches. Administrative lists show up to ${data.listLimit} records each; the pending count includes every pending request. Showing ${pending.length} of ${number(total)} pending requests below.</p>` : ""}
				${state.accessStatus === "ready" ? `
					${cards(pending.map((entry) => requestCard(entry, disabled)), "No access requests are pending.")}
					<h3>Approved access</h3>${cards(approved.map((entry) => accessCard(entry, disabled)), "No D1 allowlist entries are approved. Configured owners remain authorized separately.")}
					<h3>Revoked and denied</h3><p>Re-approve only after reviewing the original decision. Revocation terminates active sessions for that email.</p>
					${cards([...revoked.map((entry) => accessCard(entry, disabled)), ...denied.map((entry) => requestCard(entry, disabled))], "No revoked or denied entries.")}
				` : ""}
			</section>`;
		}

		function cards(entries, empty) {
			return entries.length ? `<div class="cards owner-access-cards">${entries.join("")}</div>` : notice(empty);
		}

		function requestCard(entry, disabled) {
			return `<article class="card"><h4>${esc(entry.email)}</h4><p>Requested ${esc(date(entry.requestedAt))} &middot; ${esc(entry.status.toLowerCase())}</p><div class="actions">
				${entry.status === "PENDING" ? `<button class="primary" data-beta-approve-request="${esc(entry.id)}" ${disabled ? "disabled" : ""}>Approve</button><button class="danger" data-beta-deny-request="${esc(entry.id)}" ${disabled ? "disabled" : ""}>Deny</button>` : `<button class="secondary" data-beta-approve-email="${esc(entry.email)}" ${disabled ? "disabled" : ""}>Re-approve email</button>`}
			</div></article>`;
		}

		function accessCard(entry, disabled) {
			return `<article class="card"><h4>${esc(entry.email)}</h4><p>Updated ${esc(date(entry.updatedAt))} &middot; ${esc(entry.status.toLowerCase())}</p><div class="actions">
				${entry.status === "APPROVED" ? `<button class="danger" data-beta-revoke-email="${esc(entry.email)}" ${disabled ? "disabled" : ""}>Revoke</button>` : `<button class="secondary" data-beta-approve-email="${esc(entry.email)}" ${disabled ? "disabled" : ""}>Re-approve email</button>`}
			</div></article>`;
		}

		async function loadAccess() {
			if (!syncSession()) return;
			const turn = generation;
			state.accessStatus = "loading";
			state.accessError = "";
			paint();
			try {
				const result = await call("access", "/api/beta/admin/access");
				if (!result || turn !== generation || ownerKey() !== identity) return;
				state.access = result;
				state.accessStatus = "ready";
			} catch (error) {
				state.accessStatus = "error";
				state.accessError = `Could not refresh beta access: ${error.message}`;
			}
			paint();
		}

		async function mutate(path, body, message) {
			if (!syncSession() || state.mutating) return;
			const turn = generation;
			state.mutating = true;
			state.mutationError = "";
			state.result = null;
			paint();
			try {
				const result = await call("mutation", path, { method: "POST", body });
				if (!result || turn !== generation || ownerKey() !== identity) return;
				options.notify(message);
				invalidateActivity();
				await loadAccess();
			} catch (error) {
				state.mutationError = `${error.message} Refresh access before trying again.`;
			} finally {
				if (turn === generation) {
					state.mutating = false;
					paint();
				}
			}
		}

		function invalidateActivity() {
			requests.get("activity")?.abort();
			requests.get("events")?.abort();
			state.activity = state.events = null;
			state.activityStatus = state.eventsStatus = "idle";
			state.asOf = "";
			state.accountCursors = state.eventCursors = [null];
		}

		async function openBulk() {
			if (!syncSession() || state.bulk || state.mutating) return;
			state.bulk = { status: "loading", review: null, error: "" };
			modal = doc.createElement("dialog");
			modal.id = "owner-bulk-dialog";
			modal.className = "owner-bulk-dialog";
			modal.tabIndex = -1;
			modal.setAttribute("aria-labelledby", "owner-bulk-title");
			modal.setAttribute("aria-describedby", "owner-bulk-description");
			modal.addEventListener("cancel", (event) => {
				if (state.bulk?.status === "submitting") event.preventDefault();
			});
			modal.addEventListener("keydown", (event) => {
				if (event.key !== "Tab") return;
				const buttons = [...modal.querySelectorAll("button:not([disabled])")];
				const first = buttons[0];
				const last = buttons.at(-1);
				if (!first || (!event.shiftKey && doc.activeElement === last) ||
					(event.shiftKey && doc.activeElement === first) || doc.activeElement === modal) {
					event.preventDefault();
					(event.shiftKey ? last : first)?.focus();
				}
			});
			const openedModal = modal;
			modal.addEventListener("close", () => { if (modal === openedModal) closeDialog(); });
			doc.body.append(modal);
			paintBulk();
			modal.showModal();
			doc.getElementById("owner-bulk-cancel")?.focus();
			paint();
			try {
				const review = await call("snapshot", "/api/beta/admin/requests/pending");
				if (!review || !state.bulk) return;
				state.bulk.review = review;
				state.bulk.status = "review";
				paintBulk();
			} catch (error) {
				if (!state.bulk) return;
				state.bulk.status = "error";
				state.bulk.error = `${error.message} Close and review pending requests again.`;
				paintBulk();
			}
		}

		function paintBulk() {
			if (!modal || !state.bulk) return;
			const bulk = state.bulk;
			const review = bulk.review;
			const submitting = bulk.status === "submitting";
			const focus = modal.contains(doc.activeElement) ? doc.activeElement.id : "";
			modal.innerHTML = `<div class="dialog-card">
				<div class="dialog-head"><div><p class="eyebrow">Beta access only</p><h2 id="owner-bulk-title">${bulk.status === "complete" ? "Approval results" : "Review pending approvals"}</h2></div></div>
				<p id="owner-bulk-description">Grant private-beta sign-in and workspace access only to the accounts listed here. This does not grant owner permissions, approve outreach, send emails, or approve future applicants.</p>
				${bulk.status === "loading" ? notice("Loading the current pending-request snapshot...") : ""}
				${bulk.error ? notice(bulk.error, true) : ""}
				${bulk.status === "complete" ? resultHtml(state.result) : review ? `
					<strong>${review.requests.length} reviewed of ${number(review.pendingTotal)} pending${review.hasMore ? ` &mdash; this batch is limited to ${review.batchLimit}` : ""}.</strong>
					<p>Requests that arrive later are excluded. Changed or already-handled requests will be skipped. This review expires ${esc(date(review.expiresAt))}.</p>
					${review.requests.length ? `<ul class="owner-approval-list">${review.requests.map((entry) => `<li><strong>${esc(entry.email)}</strong><span>Requested ${esc(date(entry.requestedAt))}</span>${entry.reapplication ? `<strong class="owner-reapplication">${entry.reapplication === "REVOKED_ACCESS" ? "New request after revoked access: this restores beta access." : "New request after an earlier denial: this grants beta access."}</strong>` : ""}</li>`).join("")}</ul>` : notice("No requests are pending. No accounts will be approved.")}
				` : ""}
				${submitting ? notice("Approving only this reviewed set. Please wait for the result.") : ""}
				<div class="actions owner-dialog-actions">
					<button id="owner-bulk-cancel" class="secondary" ${submitting ? "disabled" : ""}>${bulk.status === "complete" ? "Close" : "Cancel"}</button>
					${bulk.status !== "complete" ? `<button id="owner-bulk-confirm" class="primary" ${!review?.requests.length || submitting ? "disabled" : ""}>${submitting ? "Approving..." : bulk.error && review ? `Retry these ${review.requests.length} accounts` : `Approve these ${review?.requests.length || 0} accounts`}</button>` : ""}
				</div>
			</div>`;
			doc.getElementById("owner-bulk-cancel")?.addEventListener("click", () => closeDialog());
			doc.getElementById("owner-bulk-confirm")?.addEventListener("click", submitBulk);
			if (focus) doc.getElementById(focus)?.focus({ preventScroll: true });
			if (submitting) modal.focus({ preventScroll: true });
		}

		async function submitBulk() {
			const bulk = state.bulk;
			if (!syncSession() || !bulk?.review?.requests.length || bulk.status === "submitting" || bulk.status === "complete") return;
			bulk.status = "submitting";
			bulk.error = "";
			state.mutating = true;
			paintBulk();
			paint();
			try {
				const result = await call("mutation", "/api/beta/admin/requests/approve-pending", {
					method: "POST",
					body: { snapshot: bulk.review.snapshot, requestIds: bulk.review.requests.map((entry) => entry.id) },
				});
				if (!result || state.bulk !== bulk) return;
				const emails = new Map(bulk.review.requests.map((entry) => [entry.id, entry.email]));
				state.result = {
					approved: result.approved.length, reviewed: result.reviewed,
					skipped: result.skipped.map((entry) => emails.get(entry.id)),
				};
				bulk.status = "complete";
				state.mutating = false;
				invalidateActivity();
				paintBulk();
				doc.getElementById("owner-bulk-cancel")?.focus();
				await loadAccess();
			} catch (error) {
				if (state.bulk !== bulk) return;
				bulk.status = "review";
				bulk.error = `${error.message} The result was not confirmed. You can retry this same reviewed set; requests already handled will be skipped. An expired review must be closed and reviewed again.`;
				state.mutating = false;
				paintBulk();
			}
			paint();
		}

		function resultHtml(result) {
			return `<div class="owner-approval-result" role="status"><strong>${number(result.approved)} approved; ${number(result.skipped.length)} skipped out of ${number(result.reviewed)} reviewed.</strong>
				${result.skipped.length ? `<p>Skipped because the request or access changed, or was already handled. No new approval was made for:</p><ul>${result.skipped.map((email) => `<li>${esc(email)}</li>`).join("")}</ul>` : "<p>Beta access was granted only to the reviewed pending accounts.</p>"}
			</div>`;
		}

		function closeDialog(force = false) {
			if (!force && state.bulk?.status === "submitting") return;
			requests.get("snapshot")?.abort();
			const previous = modal;
			modal = null;
			state.bulk = null;
			if (previous?.open) previous.close();
			previous?.remove();
			if (!force) {
				paint();
				const opener = doc?.getElementById("beta-approve-all");
				(opener && !opener.disabled ? opener : doc?.getElementById("owner-beta-tab"))?.focus({ preventScroll: true });
			}
		}

		function wirePanel() {
			const on = (id, event, handler) => doc?.getElementById(id)?.addEventListener(event, handler);
			on("owner-days", "change", (event) => {
				state.days = event.target.value;
				void loadActivity(true);
			});
			on("owner-refresh", "click", () => void loadActivity(true));
			on("owner-access-refresh", "click", () => void loadAccess());
			on("owner-events-retry", "click", () => void loadEvents());
			for (const kind of ["accounts", "events"]) {
				on(`owner-${kind}-previous`, "click", () => {
					const cursors = kind === "accounts" ? state.accountCursors : state.eventCursors;
					if (cursors.length > 1) cursors.pop();
					void (kind === "accounts" ? loadActivity() : loadEvents());
				});
				on(`owner-${kind}-next`, "click", () => {
					const cursor = kind === "accounts" ? state.activity?.nextCursor : state.events?.nextCursor;
					if (!cursor) return;
					(kind === "accounts" ? state.accountCursors : state.eventCursors).push(cursor);
					void (kind === "accounts" ? loadActivity() : loadEvents());
				});
			}
			const filterEvents = () => { state.eventCursors = [null]; void loadEvents(); };
			on("owner-user-filter", "change", (event) => {
				state.userFilter = state.activity.accounts.find((account) => account.id === event.target.value) ||
					(state.userFilter?.id === event.target.value ? state.userFilter : null);
				filterEvents();
			});
			on("owner-action-filter", "change", (event) => { state.action = event.target.value; filterEvents(); });
			on("owner-events-reset", "click", () => { state.userFilter = null; state.action = "ALL"; filterEvents(); });
			doc?.querySelectorAll("[data-owner-user]").forEach((button) => button.addEventListener("click", () => {
				state.userFilter = state.activity.accounts.find((account) => account.id === button.dataset.ownerUser);
				filterEvents();
				doc.getElementById("owner-user-filter")?.focus();
			}));
			on("beta-approve-all", "click", openBulk);
			on("beta-approve-email-form", "submit", (event) => {
				event.preventDefault();
				const email = doc.getElementById("beta-approve-email").value.trim();
				if (confirm(`Grant or restore private-beta access for ${email}? This overrides any earlier denial or revocation.`)) {
					void mutate("/api/beta/admin/access/approve", { email }, "Beta access approved.");
				}
			});
			for (const [attribute, action] of [
				["beta-approve-request", "approve"], ["beta-deny-request", "deny"],
				["beta-approve-email", "approve"], ["beta-revoke-email", "revoke"],
			]) {
				doc?.querySelectorAll(`[data-${attribute}]`).forEach((button) => button.addEventListener("click", () => {
					const value = button.getAttribute(`data-${attribute}`);
					const byEmail = attribute.endsWith("email");
					if (action !== "approve" || byEmail) {
						const message = action === "revoke"
							? `Revoke beta access for ${value}? Active sessions will end.`
							: byEmail ? `Restore beta access for ${value}? This overrides the earlier decision.`
								: "Deny this pending beta access request?";
						if (!confirm(message)) return;
					}
					void mutate(byEmail ? `/api/beta/admin/access/${action}` : `/api/beta/admin/requests/${value}/${action}`,
						byEmail ? { email: value } : undefined, "Beta access decision saved.");
				}));
			}
		}

		return { render, wire, syncSession, clear, closeDialog, loadAccess, loadActivity };
	}

	return { create };
});
