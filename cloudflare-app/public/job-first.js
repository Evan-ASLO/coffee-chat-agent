(function (root) {
	"use strict";
	let initialSession = root.fetch("/api/session", {
		headers: { Accept: "application/json" }, credentials: "same-origin",
	}).then((response) => ({ response }), (error) => ({ error }));
	function takeInitialSession() {
		const pending = initialSession;
		initialSession = null;
		return pending;
	}
	const aliases = { "find-jobs": "jobs", "my-jobs": "applications", people: "networking" };
	const hashes = { jobs: "find-jobs", applications: "my-jobs", networking: "people" };
	const providers = {
		TAVILY: ["Tavily", "https://app.tavily.com", "Public profile discovery and approved person research. Search is Tavily-only; navigation never searches."],
		HUNTER: ["Hunter", "https://hunter.io/api-keys", "Optional work-email lookup after person approval. Keep Manual email entry if you do not want lookup requests."],
		GEMINI: ["Gemini", "https://aistudio.google.com/apikey", "A selected drafting model, or separately selected optional AI discovery. API billing is separate from consumer subscriptions."],
		OPENAI: ["OpenAI", "https://platform.openai.com/api-keys", "A selected drafting model, or separately selected optional AI discovery. ChatGPT subscriptions do not include API usage."],
		ANTHROPIC: ["Anthropic", "https://platform.claude.com/settings/keys", "A selected drafting model, or explicit optional AI discovery. Discovery defaults to one web search; fresh consent can permit three, plus token charges."],
	};
	let paused = false;
	let activeScene = null, observer = null, dialogObserver = null, sceneFrame = 0;
	const phases = new Map(), feedbackAnimations = new Set();
	const now = () => root.performance?.now?.() || Date.now();
	function setSceneClock(running) {
		if (!activeScene) return;
		const key = activeScene.dataset.scene || "home";
		const clock = phases.get(key) || { elapsed: 0, started: now(), running: false };
		if (clock.running) clock.elapsed += now() - clock.started;
		clock.started = now(); clock.running = running; phases.set(key, clock);
	}
	function scene(kind = "home") {
		if (kind === "jobs") return jobsScene();
		const reduced = root.matchMedia("(prefers-reduced-motion: reduce)").matches;
		return `<figure class="homepage-scene" data-paused="${paused || reduced}" data-tour="home-illustration">
			<svg class="home-illustration" viewBox="0 0 600 242" width="600" height="242" role="img" aria-label="Find a role, choose a person, review your draft. An illustration, not live activity.">
				<path class="story-route" d="M92 189H508"/>
				<g class="story-move story-signal"><circle class="story-soft" cx="92" cy="189" r="14"/><circle class="story-accent" cx="92" cy="189" r="6"/></g>
				<g transform="translate(18 28)"><g class="story-move story-role">
					<rect class="story-paper-back" x="-4" y="7" width="148" height="132" rx="12"/><rect class="story-paper" width="148" height="132" rx="12"/>
					<rect class="story-soft" x="14" y="14" width="34" height="34" rx="8"/>
					<text class="story-title" x="15" y="77">Your next role</text><text class="story-small" x="15" y="104">Find &amp; save</text>
				</g></g>
				<g transform="translate(226 28)"><g class="story-move story-person">
					<rect class="story-paper-back" x="4" y="7" width="148" height="132" rx="12"/><rect class="story-paper" width="148" height="132" rx="12"/>
					<circle class="story-soft" cx="74" cy="42" r="27"/><circle class="story-accent" cx="74" cy="34" r="9"/><path class="story-accent" d="M56 61c0-10 7-17 18-17s18 7 18 17Z"/>
					<text class="story-title" x="74" y="93" text-anchor="middle">A real person</text><text class="story-small" x="74" y="116" text-anchor="middle">Review evidence</text>
				</g></g>
				<g transform="translate(434 28)"><g class="story-move story-draft">
					<rect class="story-paper-back" x="4" y="7" width="148" height="132" rx="12"/><rect class="story-paper" width="148" height="132" rx="12"/>
					<text class="story-title" x="14" y="32">Your draft</text>
					<rect class="story-line" x="14" y="48" width="116" height="4" rx="2"/><rect class="story-line" x="14" y="65" width="106" height="4" rx="2"/><rect class="story-line" x="14" y="82" width="77" height="4" rx="2"/>
					<rect class="story-soft" x="14" y="101" width="108" height="21" rx="5"/><text class="story-accent" x="68" y="116" text-anchor="middle" font-size="14">Review first</text>
				</g></g>
				<text class="story-label" x="92" y="226" text-anchor="middle">Find a role</text><text class="story-label" x="300" y="226" text-anchor="middle">Choose a person</text><text class="story-label" x="508" y="226" text-anchor="middle">Review your draft</text>
			</svg>
			<figcaption><span>Illustrated flow. Nothing is being sent.</span><button type="button" class="secondary" data-toggle-scene ${reduced ? "disabled" : ""}>${reduced ? "Reduced motion" : paused ? "Play animation" : "Pause animation"}</button></figcaption>
		</figure>`;
	}
	function jobsScene() {
		const reduced = root.matchMedia("(prefers-reduced-motion: reduce)").matches;
		return `<figure class="homepage-scene jobs-shortlist-scene" data-scene="jobs" data-paused="${paused || reduced}" data-active="false">
			<svg class="home-illustration" viewBox="0 0 600 242" width="600" height="242" role="img" aria-label="Fictional example: save a role to your shortlist. No job is being saved.">
				<rect class="story-paper" x="18" y="28" width="202" height="152" rx="12"/>
				<text class="story-title" x="36" y="60">Example role</text>
				<text class="story-small" x="36" y="87">Illustrated internship</text>
				<path class="story-accent jobs-bookmark" d="M184 44h16v25l-8-6-8 6Z"/>
				<rect class="story-soft" x="36" y="119" width="166" height="39" rx="6"/>
				<text class="story-title" x="119" y="144" text-anchor="middle">Save role</text>
				<path class="story-route" d="M235 108H318"/><path class="story-route" d="m305 100 13 8-13 8"/>
				<rect class="story-paper" x="330" y="28" width="252" height="152" rx="12"/>
				<text class="story-title" x="348" y="59">Your shortlist</text>
				<rect class="story-soft jobs-saved-row" x="348" y="76" width="216" height="37" rx="5"/>
				<text class="story-small" x="360" y="100">Example role</text>
				<path class="jobs-saved-check" d="m533 92 6 6 11-13" fill="none" stroke="currentColor" stroke-width="3"/>
				<rect class="story-line" x="348" y="133" width="171" height="4" rx="2"/><rect class="story-line" x="348" y="151" width="125" height="4" rx="2"/>
				<g class="jobs-role-flight"><rect class="story-paper" x="36" y="75" width="166" height="37" rx="5"/><text class="story-small" x="48" y="99">Example role</text></g>
				<text class="story-label" x="119" y="217" text-anchor="middle">Find a role</text><text class="story-label" x="456" y="217" text-anchor="middle">Keep your next step</text>
			</svg>
			<figcaption><span>Fictional illustration. No job is being saved.</span><button type="button" class="secondary" data-toggle-scene aria-pressed="${paused}" ${reduced ? "disabled" : ""}>${reduced ? "Reduced motion" : paused ? "Play animation" : "Pause animation"}</button></figcaption>
		</figure>`;
	}
	function syncScene() {
		if (!activeScene) return;
		const reduced = root.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const box = activeScene.getBoundingClientRect();
		const pausedValue = String(paused || reduced);
		const activeValue = String(!root.document.hidden && box.bottom > 0 && box.top < root.innerHeight && !root.document.querySelector("dialog[open]"));
		setSceneClock(activeValue === "true" && pausedValue === "false");
		if (activeScene.dataset.paused !== pausedValue) activeScene.dataset.paused = pausedValue;
		if (activeScene.dataset.active !== activeValue) activeScene.dataset.active = activeValue;
		const button = activeScene.querySelector("[data-toggle-scene]");
		if (button) {
			button.disabled = reduced; button.setAttribute("aria-pressed", String(paused));
			const label = reduced ? "Reduced motion" : paused ? "Play animation" : "Pause animation";
			if (button.textContent !== label) button.textContent = label;
		}
	}
	function beforeRender() {
		setSceneClock(false);
		if (sceneFrame) root.cancelAnimationFrame?.(sceneFrame);
		sceneFrame = 0;
		observer?.disconnect(); dialogObserver?.disconnect(); observer = dialogObserver = null; activeScene = null;
		for (const animation of feedbackAnimations) animation.cancel();
		feedbackAnimations.clear();
	}
	function mountScene() {
		activeScene = root.document.querySelector(".homepage-scene");
		if (!activeScene) return;
		const clock = phases.get(activeScene.dataset.scene || "home");
		activeScene.style.setProperty("--scene-elapsed", `${-(clock?.elapsed || 0) % 7200}ms`);
		sceneFrame = root.requestAnimationFrame?.(() => { sceneFrame = 0; syncScene(); }) || 0;
		if (root.IntersectionObserver) { observer = new root.IntersectionObserver(syncScene); observer.observe(activeScene); }
		if (root.MutationObserver) { dialogObserver = new root.MutationObserver(syncScene); dialogObserver.observe(root.document.body, { subtree: true, attributes: true, attributeFilter: ["open"] }); }
	}
	function feedback(element, kind) {
		if (!element?.animate || root.document.hidden || root.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const box = element.getBoundingClientRect();
		if (box.bottom < 0 || box.top > root.innerHeight) return;
		const animation = element.animate(kind === "detail" ? [{ transform: "translateX(6px)" }, { transform: "translateX(0)" }] :
			[{ outline: "2px solid var(--cp-clay-strong)", outlineOffset: "0px" }, { outline: "2px solid transparent", outlineOffset: "3px" }],
			{ duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
		feedbackAnimations.add(animation);
		animation.finished.then(() => feedbackAnimations.delete(animation), () => feedbackAnimations.delete(animation));
	}
	root.document.addEventListener?.("visibilitychange", syncScene);
	root.document.addEventListener?.("scroll", syncScene, { passive: true });
	root.addEventListener?.("resize", syncScene);
	root.matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", syncScene);
	function modal(id, title, body) {
		let dialog = root.document.getElementById(id);
		if (!dialog) {
			dialog = root.document.createElement("dialog");
			dialog.id = id;
			dialog.className = "job-first-modal";
			dialog.setAttribute("aria-labelledby", `${id}-title`);
			root.document.body.append(dialog);
		}
		dialog.innerHTML = `<div class="dialog-card"><div class="dialog-head"><h2 id="${id}-title">${title}</h2><button type="button" class="icon-button" aria-label="Close ${title}">×</button></div>${body}</div>`;
		dialog.querySelector("button").addEventListener("click", () => dialog.close());
		dialog.showModal();
		return dialog;
	}
	function openDemo() {
		const dialog = modal("job-first-demo", "A little closer to what's next", `
			<p class="notice">This existing video is a <strong>fictional concept demonstration</strong>, not live jobs, provider results, charges or sent emails. The real workspace uses your own account and requires separate person and exact-draft approvals.</p>
			<video controls playsinline preload="none" poster="/launch/poster.jpg" aria-label="Fictional concept demonstration">
				<source src="/launch/internship-coffee-chat-launch-dynamic.mp4" type="video/mp4"/>
				<track kind="captions" src="/launch/captions.vtt" srclang="en" label="English" default/>
			</video><p><a href="/launch/captions.vtt">Read the demonstration captions</a>. No new video was generated for this release.</p>`);
		dialog.addEventListener("close", () => dialog.querySelector("video")?.pause(), { once: true });
	}
	function openGuide({ navigate, session }) {
		const dialog = modal("job-first-guide", "Your setup guide", `
			<p>Find jobs and track your shortlist without provider keys. Add only the connections you choose for People. A saved key is encrypted, not proof of eligibility or billing.</p>
			<ol class="setup-steps"><li><strong>Start with your profile.</strong> Save your name, goal and genuine experience; do not invent shared connections.</li>
			<li><strong>Choose your tools.</strong> Tavily finds public profiles. Choose one optional email provider and one drafting model, or keep Manual email entry and Template.</li>
			<li><strong>Keep control.</strong> Search does not approve a person. Approving a person prepares research and a draft. Review sources and save edits before separately approving the exact email.</li></ol>
			<div class="setup-provider-grid">${Object.entries(providers).map(([key, [name, link, help]]) => `<details><summary>${name}<small>${session?.credentials?.[key]?.configured ? "Configured, not provider-validated" : "Optional connection"}</small></summary><p>${help}</p><ol><li>Open your own provider dashboard.</li><li>Create or copy a suitably scoped key under its current terms and billing.</li><li>Paste it only into the matching password field in Setup &amp; profile and choose Save.</li></ol><a href="${link}" target="_blank" rel="noopener">Open ${name} dashboard</a></details>`).join("")}</div>
			<p class="notice warning"><strong>Apollo is OFF.</strong> Product and authentication authorization is pending. Do not enter an Apollo key. Partner OAuth may be required; a saved key cannot replace that approval.</p>
			<p>Google sign-in and Gmail/Sheets Connect are separate. Connecting, creating a CRM, uploading a resume or running providers require your explicit actions and may incur usage costs. Never share a key in chat or paste it into a job note.</p>
			<button type="button" class="primary" id="guide-open-settings">${session?.authenticated ? "Open Setup & profile" : "Sign in to open your setup"}</button>`);
		dialog.querySelector("#guide-open-settings").addEventListener("click", () => {
			dialog.close();
			if (session?.authenticated) navigate("settings");
			else root.location.assign("/auth/google/login");
		});
	}
	function wire(context) {
		mountScene();
		root.document.querySelectorAll("[data-open-demo]").forEach((button) => button.addEventListener("click", openDemo));
		root.document.querySelectorAll("[data-open-guide]").forEach((button) => button.addEventListener("click", () => openGuide(context)));
		root.document.querySelectorAll("[data-toggle-scene]").forEach((button) => button.addEventListener("click", () => {
			paused = !paused;
			syncScene();
		}));
	}
	root.JobFirstUI = {
		routeView: (hash) => aliases[hash] || hash || "home",
		routeHash: (view) => hashes[view] || view,
		isJobId: (value) => typeof value === "string" && value.length > 0 && value.length <= 240 &&
			/^[A-Za-z0-9._:-]+$/.test(value) && value !== "." && value !== "..",
		scene, wire, openGuide, takeInitialSession, beforeRender, feedback,
	};
})(window);
