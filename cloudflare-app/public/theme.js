(function (root) {
	"use strict";
	const key = "coffee-chat-theme";
	const valid = (value) => value === "light" || value === "dark";
	let saved;
	try { saved = root.localStorage.getItem(key); }
	catch (error) { root.console.warn("Theme preference could not be read.", error.name); }
	const param = new URLSearchParams(root.location.search).get("scoutTheme");
	function apply(theme) {
		root.document.documentElement.setAttribute("data-theme", theme);
		root.document.querySelectorAll("[data-theme-choice]").forEach((button) =>
			button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme)));
	}
	apply(valid(saved) ? saved : valid(param) ? param : "light");
	root.document.addEventListener("DOMContentLoaded", () => {
		apply(root.document.documentElement.dataset.theme);
	});
	root.WorkspaceTheme = {
		choose(theme) {
			if (!valid(theme)) throw new Error("Invalid theme preference.");
			try { root.localStorage.setItem(key, theme); }
			catch (error) { root.console.warn("Theme preference could not be saved.", error.name); }
			apply(theme);
		},
	};
	root.document.addEventListener("click", (event) => {
		const button = event.target.closest("[data-theme-choice]");
		if (button) root.WorkspaceTheme.choose(button.dataset.themeChoice);
	});
})(window);
