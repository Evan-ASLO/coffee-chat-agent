(function (root) {
	"use strict";
	let modulePromise = null;
	function loadModule() {
		modulePromise ||= new Promise((resolve, reject) => {
			const script = root.document.createElement("script");
			script.src = "/owner-admin.js?v=20261010-lazy-1";
			const timeout = root.setTimeout(() => fail(), 15000);
			const fail = () => { root.clearTimeout(timeout); script.remove(); modulePromise = null; reject(new Error("Owner tools could not load. Retry when connected.")); };
			script.onerror = fail;
			script.onload = () => {
				root.clearTimeout(timeout);
				if (!root.OwnerAdmin?.create || root.OwnerAdmin.create === create) { fail(); return; }
				resolve(root.OwnerAdmin);
			};
			root.document.head.append(script);
		});
		return modulePromise;
	}
	function create(options) {
		let controller = null, status = "idle", error = "", generation = 0, identity = "";
		const owner = () => { const session = options.getSession(); return session?.authenticated && session.isBetaAdmin === true ? `${session.user.id}|${session.user.email}` : ""; };
		function clear() { generation++; controller?.clear(); controller = null; status = "idle"; error = ""; identity = ""; }
		function syncSession() { const next = owner(); if (next !== identity) { clear(); identity = next; } controller?.syncSession(); return Boolean(next); }
		async function load() {
			if (!syncSession() || status === "loading") return;
			const turn = generation, account = identity;
			status = "loading"; error = ""; options.repaint();
			try {
				const module = await loadModule();
				if (turn !== generation || account !== owner()) return;
				controller = module.create(options); status = "ready"; options.repaint();
				const disclosure = root.document.getElementById("owner-controls");
				if (disclosure) disclosure.open = true;
			} catch (failure) {
				if (turn !== generation || account !== owner()) return;
				status = "error"; error = failure.message; options.repaint();
				const disclosure = root.document.getElementById("owner-controls");
				if (disclosure) disclosure.open = true;
			}
		}
		return {
			syncSession, clear, closeDialog: (...args) => controller?.closeDialog(...args),
			render() {
				if (!syncSession()) return "";
				if (controller) return controller.render();
				return `<details id="owner-controls" class="admin-disclosure" ${status !== "idle" ? "open" : ""}><summary>${options.icon("shield")}<span><strong>Owner tools</strong><small>Activity, beta access &amp; bug reports</small></span></summary><div class="admin-settings">${status === "error" ? `<p role="alert">${options.escapeHtml(error)}</p><button id="retry-owner-tools" class="secondary">Retry Owner tools</button>` : '<p role="status">Loading Owner tools…</p>'}</div></details>`;
			},
			wire() {
				if (!syncSession()) return;
				if (controller) { controller.wire(); return; }
				root.document.getElementById("owner-controls")?.addEventListener("toggle", (event) => { if (event.currentTarget.open && status === "idle") void load(); });
				root.document.getElementById("retry-owner-tools")?.addEventListener("click", () => void load());
			},
		};
	}
	root.OwnerAdmin = { create };
})(window);
