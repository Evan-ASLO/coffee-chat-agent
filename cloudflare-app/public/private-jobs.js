(function (root) {
	"use strict";
	function create(options) {
		let dialog = null, generation = 0, owner = "", pending = null;
		const identity = () => options.getSession()?.authenticated ? options.getSession().user.id : "";
		function clear() {
			generation++; pending?.abort(); pending = null; dialog?.close(); dialog?.remove(); dialog = null; owner = "";
		}
		function syncSession() { if (owner && owner !== identity()) clear(); }
		function open(job = null) {
			syncSession();
			if (!identity()) return;
			clear(); owner = identity();
			const turn = generation, esc = options.escapeHtml;
			const fields = { company: job?.company || "", title: job?.title || "", url: job?.url || "", location: job?.location || "",
				status: job?.userState?.status || "SAVED", notes: job?.userState?.notes || "" };
			dialog = root.document.createElement("dialog"); dialog.id = "private-job-dialog"; dialog.className = "editor-dialog";
			dialog.setAttribute("aria-labelledby", "private-job-heading");
			dialog.innerHTML = `<form class="dialog-card" id="private-job-form"><div class="dialog-head"><h2 id="private-job-heading">${job ? "Edit private job" : "Add job"}</h2><button type="button" id="private-job-close" class="icon-button" aria-label="Close ${job ? "Edit private job" : "Add job"}">×</button></div>
				<p>Private to your account. User-added jobs are not catalog-verified; availability and posting dates are unknown. Pasting a URL never starts a search.</p>
				<label for="private-job-company">Company</label><input id="private-job-company" required maxlength="200" value="${esc(fields.company)}" />
				<label for="private-job-title">Job title</label><input id="private-job-title" required maxlength="240" value="${esc(fields.title)}" />
				<label for="private-job-url">Posting URL (optional)</label><input id="private-job-url" type="url" maxlength="2048" value="${esc(fields.url)}" placeholder="https://…" />
				<label for="private-job-location">Location (optional)</label><input id="private-job-location" maxlength="240" value="${esc(fields.location)}" />
				<label for="private-job-status">Stage</label><select id="private-job-status">${options.statusOptions(fields.status)}</select>
				<label for="private-job-notes">Private notes & next step</label><textarea id="private-job-notes" maxlength="4000" rows="4">${esc(fields.notes)}</textarea>
				<p id="private-job-feedback" role="status"></p><div class="actions"><button type="button" id="private-job-cancel" class="secondary">Cancel</button><button type="submit" id="private-job-submit" class="primary">Save job</button></div></form>`;
			root.document.body.append(dialog); const panel = dialog;
			let submissionKey = root.crypto.randomUUID(), lastBody = "", busy = false;
			const current = () => turn === generation && panel === dialog && owner === identity();
			const feedback = panel.querySelector("#private-job-feedback");
			const cancel = () => { if (!busy) clear(); };
			panel.querySelector("#private-job-close").addEventListener("click", cancel);
			panel.querySelector("#private-job-cancel").addEventListener("click", cancel);
			panel.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
			panel.addEventListener("close", () => { if (current() && !busy) clear(); });
			panel.querySelector("#private-job-form").addEventListener("submit", async (event) => {
				event.preventDefault();
				if (!current() || busy) return;
				const value = (key) => panel.querySelector(`#private-job-${key}`).value.trim();
				const body = { company: value("company"), title: value("title"), url: value("url"), location: value("location"), status: value("status"), notes: value("notes"), expectedUserId: owner };
				if (!body.company || !body.title) { feedback.setAttribute("role", "alert"); feedback.textContent = "Enter both a company and job title."; return; }
				if (body.url) {
					try { const url = new URL(body.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
					catch { feedback.setAttribute("role", "alert"); feedback.textContent = "Use an HTTP or HTTPS posting URL without credentials, or leave it blank."; return; }
				}
				const fingerprint = JSON.stringify(body);
				if (lastBody && lastBody !== fingerprint) submissionKey = root.crypto.randomUUID();
				lastBody = fingerprint;
				busy = true; panel.querySelectorAll("input,select,textarea,button").forEach((e) => { e.disabled = true; });
				feedback.setAttribute("role", "status"); feedback.textContent = "Saving private job…";
				const controller = new AbortController(); pending = controller;
				let timeout;
				try {
					const request = options.api(job ? `/api/private-jobs/${encodeURIComponent(job.id)}` : "/api/private-jobs",
						{ method: job ? "PUT" : "POST", body: { ...body, ...(job ? { expectedVersion: job.manualVersion } : { submissionKey }) }, signal: controller.signal });
					const result = await Promise.race([request, new Promise((_, reject) => { timeout = root.setTimeout(() => { controller.abort(); reject(new Error("Save took too long. Retry unchanged fields to check the same submission.")); }, 15000); })]);
					if (!current()) return;
					if (!result.job?.manual || !result.job.id) throw new Error("The saved private job receipt could not be read. Retry unchanged fields.");
					busy = false; clear();
					options.notify("Private job saved.");
					await options.onSaved(result.job, body.expectedUserId);
				} catch (failure) {
					if (!current()) return;
					feedback.setAttribute("role", "alert"); feedback.textContent = failure.message || "The job could not be saved. Retry when connected.";
				} finally {
					root.clearTimeout(timeout);
					if (current()) { busy = false; pending = null; panel.querySelectorAll("input,select,textarea,button").forEach((e) => { e.disabled = false; }); }
				}
			});
			panel.showModal(); panel.querySelector("#private-job-company").focus();
		}
		function wire() {
			root.document.querySelectorAll("[data-add-private-job]").forEach((button) => button.addEventListener("click", () => open()));
			root.document.querySelectorAll("[data-edit-private-job]").forEach((button) => button.addEventListener("click", () => { const job = options.getJob(button.dataset.editPrivateJob); if (job?.manual) open(job); }));
		}
		return { open, clear, syncSession, wire };
	}
	root.PrivateJobs = { create };
})(window);
