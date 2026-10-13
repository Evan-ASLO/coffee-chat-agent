(function attachJobSourceUi(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	root.JobSourceUi = api;
})(typeof globalThis === "object" ? globalThis : this, function createJobSourceUi() {
	const ADZUNA_CANADA_URL = "https://www.adzuna.ca/";

	function normalizeSource(value) {
		return String(value || "").trim().toLowerCase();
	}

	function sourceLabel(value) {
		const source = normalizeSource(value);
		if (source === "adzuna") return "Adzuna";
		if (source === "gcjobs") return "GC Jobs";
		if (source === "oracle") return "Oracle recruiting";
		if (!source) return "Unknown source";
		return source
			.split(/[_\s-]+/)
			.filter(Boolean)
			.map((word) => word[0].toUpperCase() + word.slice(1))
			.join(" ");
	}

	function attributionHtml(value) {
		if (normalizeSource(value) !== "adzuna") return "";
		return `<a class="adzuna-attribution" href="${ADZUNA_CANADA_URL}" target="_blank" rel="noopener sponsored" aria-label="Jobs by Adzuna"><span>Jobs</span><img src="/adzuna_logo.png" width="87" height="23" alt="Adzuna" /></a>`;
	}

	return {
		ADZUNA_CANADA_URL,
		sourceLabel,
		attributionHtml,
	};
});
