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

	return {
		bucketLevel,
		renderActivityHeatmap,
		renderApplicationFunnel,
		renderTopCompanies,
	};
});
