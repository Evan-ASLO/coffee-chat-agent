(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.BugReports = api;
})(typeof window === "undefined" ? null : window, function () {
	"use strict";
	const pages = { home: "Home", jobs: "Find jobs", applications: "My jobs", networking: "People", settings: "Setup", analytics: "Analytics" };
	function create(options) {
		const doc = options.document || globalThis.document;
		let dialog = null, owner = "", busy = false, controller = null, requestKey = "", fingerprint = "", page = "home";
		function clear() {
			controller?.abort();
			controller = null;
			busy = false;
			const closing = dialog;
			dialog = null;
			closing?.close();
			closing?.remove();
			owner = requestKey = fingerprint = "";
		}
		function syncSession() {
			const session = options.getSession();
			const identity = session?.authenticated ? session.user.id : "";
			if (owner && owner !== identity) clear();
			return identity;
		}
		function open() {
			const identity = syncSession();
			if (!identity) return options.notify("Sign in to share a bug report with the site owner. Contact is available for signed-out support.", true);
			if (dialog) return dialog.showModal();
			owner = identity;
			page = Object.hasOwn(pages, options.getView()) ? options.getView() : "home";
			dialog = doc.createElement("dialog");
			dialog.id = "bug-report-dialog";
			dialog.className = "editor-dialog";
			dialog.setAttribute("aria-labelledby", "bug-report-title");
			dialog.innerHTML = `<div class="dialog-card"><div class="dialog-head"><h2 id="bug-report-title">Report a bug</h2></div>
				<p>Shared with the site owner with your name and email. Page: ${pages[page]}.</p>
				<p class="small">Do not include API keys, passwords, or private email contents. No search criteria, URL tokens, or outreach content are added automatically.</p>
				<form id="bug-report-form">
					<label>Summary<input id="bug-report-summary" required minlength="3" maxlength="160" /></label>
					<label>What happened?<textarea id="bug-report-description" rows="5" required minlength="10" maxlength="4000"></textarea></label>
					<p id="bug-report-feedback" role="status" aria-live="polite"></p>
					<div class="actions"><button type="button" class="secondary" id="bug-report-cancel">Cancel</button><button type="submit" class="primary" id="bug-report-submit">Submit report</button></div>
				</form></div>`;
			dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
			dialog.addEventListener("close", () => { if (!busy) clear(); });
			doc.body.append(dialog);
			doc.getElementById("bug-report-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
			doc.getElementById("bug-report-cancel").addEventListener("click", clear);
			dialog.showModal();
			doc.getElementById("bug-report-summary").focus();
		}
		async function submit() {
			const identity = syncSession();
			if (!dialog || busy || !identity || identity !== owner) return;
			const summary = doc.getElementById("bug-report-summary").value.trim();
			const description = doc.getElementById("bug-report-description").value.trim();
			const feedback = doc.getElementById("bug-report-feedback");
			if (summary.length < 3 || summary.length > 160 || description.length < 10 || description.length > 4000) {
				feedback.textContent = "Enter a summary (3–160 characters) and description (10–4,000 characters).";
				feedback.setAttribute("role", "alert");
				return;
			}
			const content = JSON.stringify({ summary, description, page });
			if (content !== fingerprint) { requestKey = crypto.randomUUID(); fingerprint = content; }
			busy = true;
			const currentDialog = dialog;
			const request = new AbortController();
			controller = request;
			let timeout;
			const deadline = new Promise((_, reject) => {
				timeout = setTimeout(() => { request.abort(); reject(new Error("Saving the report could not be confirmed.")); }, 15000);
			});
			const current = () => dialog === currentDialog && controller === request && options.getSession()?.user?.id === identity && options.getSession()?.authenticated;
			currentDialog.querySelectorAll("input,textarea,button").forEach((node) => { node.disabled = true; });
			feedback.textContent = "Saving your report...";
			feedback.setAttribute("role", "status");
			try {
				const result = await Promise.race([options.api("/api/bug-reports", {
					method: "POST", signal: request.signal,
					body: { summary, description, page, submissionKey: requestKey, expectedUserId: identity },
				}), deadline]);
				if (!current()) return;
				if (!result.receipt?.id || !result.receipt?.createdAt) throw new Error("Saving the report could not be confirmed.");
				options.notify(`Report saved in the owner's inbox. Receipt: ${result.receipt.id.slice(0, 8)}.`);
				busy = false;
				clear();
			} catch (error) {
				if (!current()) return;
				feedback.textContent = `${error.message} Retry this report to avoid submitting a duplicate.`;
				feedback.setAttribute("role", "alert");
			} finally {
				clearTimeout(timeout);
				if (current()) {
					busy = false;
					controller = null;
					currentDialog.querySelectorAll("input,textarea,button").forEach((node) => { node.disabled = false; });
				}
			}
		}
		function wire() {
			doc.querySelectorAll("[data-report-bug]").forEach((button) => button.addEventListener("click", open));
		}
		return { open, submit, wire, syncSession, clear };
	}
	return { create, pages };
});
