(function (root) {
	"use strict";
	function create({ getOwner }) {
		const positions = new Map();
		let owner = null, frame = 0, observer = null, restoring = false;
		const desktop = () => root.matchMedia("(min-width: 761px)").matches;
		const workspace = () => root.document.querySelector(".job-first-workspace");
		function syncOwner() {
			const current = getOwner() || "";
			if (current !== owner) { positions.clear(); owner = current; }
			return current;
		}
		function capture() {
			syncOwner();
			if (restoring) return;
			const node = workspace();
			if (!node || node.dataset.browseOwner !== owner) return;
			const key = node.dataset.browseQuery;
			const record = positions.get(key) || {};
			const left = node.querySelector(".job-cards"), right = node.querySelector(".job-detail-card");
			if (desktop()) {
				record.left = left?.scrollTop || 0;
				record.documentY = root.scrollY;
				record.right = right?.scrollTop || 0;
				record.detailId = right?.dataset.jobId;
			} else if (node.classList.contains("detail-open")) {
				record.detailY = root.scrollY; record.detailId = right?.dataset.jobId;
			} else {
				record.resultsY = root.scrollY;
			}
			positions.delete(key); positions.set(key, record);
			if (positions.size > 10) positions.delete(positions.keys().next().value);
		}
		function bounds() {
			const node = workspace();
			if (!node || !desktop()) return;
			const headerBottom = root.document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
			const top = Math.max(Math.max(0, headerBottom) + 8, node.getBoundingClientRect().top);
			const height = `${Math.max(240, root.innerHeight - top - 16)}px`;
			if (node.style.getPropertyValue("--job-pane-height") !== height) node.style.setProperty("--job-pane-height", height);
		}
		function scheduleBounds() {
			if (frame) return;
			frame = root.requestAnimationFrame(() => { frame = 0; bounds(); });
		}
		function beforeRender() {
			capture();
			restoring = true;
			if (frame) root.cancelAnimationFrame(frame);
			frame = 0; observer?.disconnect(); observer = null;
		}
		function mount() {
			syncOwner();
			const node = workspace();
			if (!node || node.dataset.browseOwner !== owner) { restoring = false; return; }
			const account = owner, key = node.dataset.browseQuery;
			const record = positions.has(key) ? { ...positions.get(key) } : null;
			const left = node.querySelector(".job-cards"), right = node.querySelector(".job-detail-card");
			left?.addEventListener("scroll", capture, { passive: true });
			right?.addEventListener("scroll", capture, { passive: true });
			frame = root.requestAnimationFrame(() => {
				frame = 0;
				if (account !== syncOwner() || node !== workspace()) { restoring = false; return; }
				if (desktop()) {
					if (record) root.scrollTo({ top: record.documentY || 0, behavior: "instant" });
					bounds();
					if (left) left.scrollTop = record?.left || 0;
					if (right) right.scrollTop = record?.detailId === right.dataset.jobId ? record.right || 0 : 0;
				} else if (node.classList.contains("detail-open")) {
					const sameRole = record?.detailId === right?.dataset.jobId && record?.detailY !== undefined;
					const headerHeight = root.document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
					root.scrollTo({ top: sameRole ? record.detailY : Math.max(0, node.getBoundingClientRect().top + root.scrollY - headerHeight - 8), behavior: "instant" });
				} else if (record?.resultsY !== undefined) {
					root.scrollTo({ top: record.resultsY, behavior: "instant" });
				}
				restoring = false;
				if (root.ResizeObserver) {
					observer = new root.ResizeObserver(scheduleBounds);
					for (const element of root.document.querySelectorAll(".jobs-filter-form, .results-toolbar, .topbar")) observer.observe(element);
				}
			});
		}
		function clear() { positions.clear(); owner = null; restoring = false; observer?.disconnect(); observer = null; if (frame) root.cancelAnimationFrame(frame); frame = 0; }
		root.addEventListener("resize", scheduleBounds);
		root.addEventListener("scroll", () => { capture(); scheduleBounds(); }, { passive: true });
		return { beforeRender, mount, clear, capture };
	}
	root.JobBrowsing = { create };
})(window);
