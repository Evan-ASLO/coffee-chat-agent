(function attachAnalyticsUi(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.CareerAnalyticsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
	function renderApplicationFunnel(applications) {
		const rows = [
			["Saved", Number(applications?.saved || 0)],
			["Applied", Number(applications?.applied || 0)],
			["Interview", Number(applications?.interviewing || 0)],
			["Offer", Number(applications?.offers || 0)],
		];
		const max = Math.max(0, ...rows.map((row) => row[1]));
		if (max === 0) {
			return empty(
				"No application stages to chart yet. Save a role or mark one as applied.",
			);
		}
		return `<div class="metric-bars" role="img" aria-label="Current application stage counts">
			${rows
				.map(
					([label, count]) => `<div class="metric-bar-row">
						<div class="metric-bar-label"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>
						<div class="metric-bar-track"><span class="metric-bar-fill metric-level-${bucketLevel(count, max, 10)}"></span></div>
					</div>`,
				)
				.join("")}
		</div>`;
	}

	function renderTopCompanies(companies) {
		if (!Array.isArray(companies) || companies.length === 0) {
			return empty("Tracked applications will surface company concentration here.");
		}
		const max = Math.max(...companies.map((entry) => Number(entry.count || 0)));
		return `<ol class="company-ranking">
			${companies
				.map(
					(entry) => `<li>
						<div><span>${escapeHtml(entry.company)}</span><strong>${Number(entry.count || 0)}</strong></div>
						<div class="metric-bar-track"><span class="metric-bar-fill metric-level-${bucketLevel(entry.count, max, 10)}"></span></div>
					</li>`,
				)
				.join("")}
		</ol>`;
	}

	function renderActivityHeatmap(activity) {
		const days = Array.isArray(activity?.days) ? activity.days : [];
		if (days.length === 0 || days.every((day) => Number(day.count || 0) === 0)) {
			return empty(
				"Recent saved-job, application, networking, and settings activity will appear here.",
			);
		}
		const max = Math.max(...days.map((day) => Number(day.count || 0)));
		return `<div class="activity-heatmap" role="img" aria-label="Account activity during the last 28 days">
			${days
				.map((day) => {
					const count = Number(day.count || 0);
					return `<span class="activity-cell activity-level-${bucketLevel(count, max, 4)}" title="${escapeAttr(day.date)}: ${count} ${count === 1 ? "event" : "events"}"><span class="sr-only">${escapeHtml(day.date)}: ${count} ${count === 1 ? "event" : "events"}</span></span>`;
				})
				.join("")}
		</div>
		<div class="activity-legend"><span>${escapeHtml(activity.from || "")}</span><span>${escapeHtml(activity.to || "")}</span></div>`;
	}

	function bucketLevel(value, maximum, levels) {
		const count = Number(value || 0);
		const max = Number(maximum || 0);
		if (count <= 0 || max <= 0) return 0;
		return Math.max(1, Math.min(levels, Math.ceil((count / max) * levels)));
	}

	function empty(message) {
		return `<div class="chart-empty">${escapeHtml(message)}</div>`;
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

	const applicationStatusFields = { SAVED: "saved", APPLIED: "applied", INTERVIEWING: "interviewing", OFFER: "offers", REJECTED: "rejected", ARCHIVED: "archived" };
	function currentApplicationCounts(input) {
		if (!input || Object.values(applicationStatusFields).some((key) => !Number.isSafeInteger(input[key]) || input[key] < 0)) {
			throw new Error("Current application status counts are unavailable.");
		}
		const result = Object.fromEntries(Object.values(applicationStatusFields).map((key) => [key, input[key]]));
		result.total = result.applied + result.interviewing + result.offers + result.rejected;
		result.inProgress = result.applied + result.interviewing;
		result.tracked = result.saved + result.total + result.archived;
		if (!Number.isSafeInteger(result.tracked) || (input.total !== undefined && input.total !== result.total)) {
			throw new Error("Current application status totals are inconsistent.");
		}
		return result;
	}
	function countTrackedApplications(jobs) {
		if (!Array.isArray(jobs)) throw new Error("Tracked job states could not be read.");
		const counts = Object.fromEntries(Object.values(applicationStatusFields).map((key) => [key, 0]));
		const ids = new Set();
		for (const job of jobs) {
			const field = applicationStatusFields[job.userState?.status];
			if (!job.id || ids.has(job.id) || !field) throw new Error("Tracked job states were duplicated or invalid.");
			ids.add(job.id); counts[field]++;
		}
		return currentApplicationCounts(counts);
	}
	function applicationSankeyModel(input) {
		const counts = currentApplicationCounts(input);
		const statuses = [["saved", "Saved"], ["applied", "Applied"], ["interviewing", "Interviewing"], ["offers", "Offer"], ["rejected", "Rejected"], ["archived", "Archived"]];
		const scale = counts.tracked ? 180 / counts.tracked : 0;
		let source = (330 - 180) / 2, target = 15;
		const flows = statuses.map(([key, label], index) => {
			const value = counts[key], width = value * scale, from = source + width / 2;
			const targetY = target + width / 2;
			source += width; target += width + 24;
			return { key, label, value, width, sourceY: from, targetY };
		});
		return { counts, flows };
	}
	function renderApplicationSankey(input, error = "") {
		if (error) return `<p class="notice warning" role="alert">${escapeHtml(error)}</p>`;
		let model;
		try { model = applicationSankeyModel(input); }
		catch (failure) { return `<p class="notice warning" role="alert">${escapeHtml(failure.message)} Reload the workspace to retry.</p>`; }
		const { counts, flows } = model;
		const explanation = "Current statuses across your account, not transition history. Each tracked job is counted once. Saved and Archived are not applications.";
		if (!counts.tracked) return `<p class="sankey-explanation">${explanation}</p>${empty("No tracked jobs yet. Save a role to start your snapshot.")}`;
		return `<figure class="application-sankey">
			<figcaption><strong>${counts.tracked.toLocaleString()} tracked ${counts.tracked === 1 ? "job" : "jobs"}</strong><p class="sankey-explanation">${explanation}</p></figcaption>
			<svg viewBox="0 0 460 330" class="application-sankey-svg" aria-hidden="true" focusable="false">
				<rect class="sankey-root" x="72" y="75" width="14" height="180"/>
				${flows.filter((flow) => flow.value).map((flow) => `<path class="sankey-flow sankey-${flow.key}" data-count="${flow.value}" data-width="${flow.width}" d="M86 ${flow.sourceY} C164 ${flow.sourceY} 182 ${flow.targetY} 260 ${flow.targetY}" stroke-width="${flow.width}"/>
					<rect class="sankey-node sankey-${flow.key}" x="260" y="${flow.targetY - flow.width / 2}" width="14" height="${flow.width}"/>
					<text class="sankey-label" x="288" y="${flow.targetY + 5}">${flow.label} ${flow.value.toLocaleString()}</text>`).join("")}
			</svg>
			<dl class="sankey-counts">${flows.map((flow) => `<div><dt><span class="sankey-key sankey-${flow.key}" aria-hidden="true"></span>${flow.label}</dt><dd>${flow.value.toLocaleString()}</dd></div>`).join("")}</dl>
		</figure>`;
	}

	return {
		currentApplicationCounts,
		countTrackedApplications,
		applicationSankeyModel,
		renderApplicationSankey,
		bucketLevel,
		renderActivityHeatmap,
		renderApplicationFunnel,
		renderTopCompanies,
	};
});
