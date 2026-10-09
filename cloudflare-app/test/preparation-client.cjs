const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function definition(name) {
	const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
	assert.ok(match, `Real client function ${name} exists`);
	const tail = source.slice(match.index + 1);
	const next = /\n(?:async )?function \w+\(/.exec(tail);
	return source.slice(match.index, next ? match.index + 1 + next.index : source.length);
}
function client() {
	const person = { id: "person-a", userId: "user-a", status: "DRAFT_READY", contactApprovedAt: "approved", draftVersion: 1, fullName: "Fictional Alex", email: "alex@review-company.com", subject: "Saved subject", draftBody: "Saved body." };
	const nodes = new Map(Object.entries({
		"draft-id": { value: person.id }, "draft-version": { value: "1" },
		"draft-email": { value: person.email }, "draft-subject": { value: person.subject },
		"draft-body": { value: person.draftBody }, "attach-resume": { checked: false },
		"send-draft": {}, "save-draft": {}, "draft-save-state": {},
	}));
	const c = {
		state: {
			tab: "networking", networkingJob: null, preparationRequest: null, networkingContacts: { status: "ready", prospects: [person] },
			session: { authenticated: true, user: { id: "user-a" }, prospects: [person],
				settings: { draftProvider: "OPENAI", enrichmentProvider: "APOLLO" },
				features: { apolloEnrichment: true },
				credentials: { APOLLO: { configured: true }, TAVILY: { configured: true } } },
			draftReview: { id: person.id, userId: person.userId, jobId: null, version: 1,
				email: person.email, subject: person.subject, body: person.draftBody },
		},
		nodes, calls: [], toasts: [], confirmations: [], renders: 0, reloads: 0,
		document: { getElementById: (id) => nodes.get(id) || null },
		dialog: { close: () => { c.state.draftReview = null; } },
		AbortController, crypto: { randomUUID: () => "fake-idempotency" },
		networkingPeople: () => c.state.session?.prospects || [],
		value: (id) => nodes.get(id)?.value || "",
		confirm: (message) => { c.confirmations.push(message); return true; },
		render: () => { c.renders += 1; },
		showToast: (message, error) => c.toasts.push({ message, error }),
		refresh: async () => { c.reloads += 1; c.state.preparationRequest = null; },
		loadNetworkingContacts: async () => {},
		loadAnalyticsData: async () => { c.analyticsReloads = (c.analyticsReloads || 0) + 1; },
		api: async (url, options) => {
			c.calls.push({ url, options });
			return url === "/api/session" ? structuredClone(c.state.session) : { userId: "user-a", prospect: person };
		},
		escapeHtml: (value) => String(value).replaceAll("<", "&lt;"),
		escapeAttr: (value) => String(value).replaceAll('"', "&quot;"),
		formatDate: (value) => value,
		formatDateOnly: (value) => value, formatStatus: (value) => value,
		companyInitials: () => "FA", icon: () => "", truncate: (value, length) => String(value).slice(0, length),
		jobContactFor: () => null, linkedJobChips: () => "",
	};
	vm.createContext(c);
	vm.runInContext([
		"cancelPreparation", "currentProspectAction", "applyPersonRemoval", "runProspectAction", "validDraftReview", "draftHasUnsavedChanges",
		"syncDraftControls", "saveDraft", "sendDraft", "prepare", "regenerate", "retryPreparation",
		"preparationBudget", "renderPreparationCosts", "preparationStatus", "renderPreparationContext",
		"reject", "networkingPeople", "removePersonAction", "networkingTableRow", "networkFilterButton",
	].map(definition).join("\n"), c);
	return c;
}

test("failed approved and unapproved people have Remove even with an incomplete writing profile", () => {
	for (const approved of [null, "approved"]) {
		const c = client();
		const person = { ...c.state.session.prospects[0], status: "ERROR", contactApprovedAt: approved };
		const html = c.networkingTableRow(person, false);
		assert.match(html, /data-reject="person-a"/);
		assert.match(html, /aria-label="Remove Fictional Alex from active queues"/);
		assert.match(html, />Remove<\/button>/);
		assert.doesNotMatch(c.removePersonAction(person), /disabled/);
		assert.match(html, approved ? /Retry draft/ : /Approve & prepare/);
		c.state.networkingJob = { id: "job-a" };
		assert.match(c.networkingTableRow(person, false), />Remove<\/button>/);
	}
	const c = client();
	for (const status of ["PREPARING", "SENDING", "SENT", "REPLIED", "REJECTED"]) {
		assert.equal(c.removePersonAction({ ...c.state.session.prospects[0], status }), "");
	}
});

test("removal confirmation cancellation performs no API calls", async () => {
	const c = client();
	c.confirm = (message) => { c.confirmations.push(message); return false; };
	await c.reject("person-a");
	assert.equal(c.calls.length, 0);
	assert.match(c.confirmations[0], /Remove Fictional Alex from the active approval and outreach queues/);
	assert.match(c.confirmations[0], /record and history are kept/);
	assert.match(c.confirmations[0], /does not permanently delete/);
});

test("confirmed removal closes stale draft review and updates active counts in general and linked contexts", async () => {
	for (const job of [null, { id: "job-a" }]) {
		const c = client();
		c.state.networkingJob = job;
		c.api = async (url, options) => {
			c.calls.push({ url, options });
			return url === "/api/session" ? structuredClone(c.state.session) : { ok: true };
		};
		await c.reject("person-a");
		assert.match(c.calls[0].url, /\/person-a\/reject$/);
		assert.equal(c.networkingPeople().length, 0);
		assert.match(c.networkFilterButton("TO_APPROVE", "To approve"), /<span>0<\/span>/);
		assert.equal(c.state.draftReview, null);
		assert.equal(c.analyticsReloads, 1);
		assert.equal(c.toasts.at(-1).message, "Removed from active approval and outreach queues.");
		assert.equal(c.state.session.prospects[0].status, "REJECTED");
		await c.sendDraft();
		assert.equal(c.calls.filter((call) => call.url.endsWith("/send")).length, 0);
	}
});

test("blocked removal retains the person and reports the backend failure", async () => {
	const c = client();
	c.api = async (url) => {
		if (url === "/api/session") return structuredClone(c.state.session);
		throw new Error("This person is being prepared. Reload.");
	};
	await c.reject("person-a");
	assert.equal(c.networkingPeople().length, 1);
	assert.equal(c.toasts.at(-1).error, true);
	assert.match(c.toasts.at(-1).message, /being prepared/);
});

test("a confirmed removal stays inactive even if its saved-state refresh fails", async () => {
	const c = client();
	c.api = async (url) => {
		if (url === "/api/session") throw new Error("Offline");
		return { ok: true };
	};
	await c.reject("person-a");
	assert.equal(c.networkingPeople().length, 0);
	assert.equal(c.state.draftReview, null);
	assert.match(c.toasts.at(-1).message, /could not be refreshed/);
	assert.equal(c.toasts.at(-1).error, true);
});

test("a stale session refresh cannot restore a person whose removal was confirmed", async () => {
	const c = client();
	const stale = structuredClone(c.state.session);
	c.api = async (url) => url === "/api/session" ? stale : { ok: true };
	await c.reject("person-a");
	assert.equal(c.networkingPeople().length, 0);
	assert.equal(c.state.draftReview, null);
});

for (const change of ["account", "job", "logout", "navigation"]) {
	test(`a late removal response cannot repopulate changed ${change} state`, async () => {
		const c = client();
		let finish;
		c.api = async () => new Promise((resolve) => { finish = resolve; });
		const pending = c.reject("person-a");
		c.cancelPreparation();
		if (change === "account") c.state.session = { authenticated: true, user: { id: "user-b" }, prospects: [] };
		if (change === "job") c.state.networkingJob = { id: "job-b" };
		if (change === "logout") c.state.session = { authenticated: false };
		if (change === "navigation") c.state.tab = "settings";
		const state = JSON.stringify(c.state);
		finish({ ok: true });
		await pending;
		assert.equal(JSON.stringify(c.state), state);
	});
}

test("preparation duplicate clicks authorize one action with explicit budgets", async () => {
	const c = client();
	c.state.session.prospects[0].email = "";
	let finish;
	c.api = async (url) => {
		c.calls.push(url);
		if (url === "/api/session") return structuredClone(c.state.session);
		return new Promise((resolve) => { finish = resolve; });
	};
	const first = c.prepare("person-a");
	await c.prepare("person-a");
	assert.equal(c.calls.length, 1);
	assert.equal(c.confirmations.length, 1);
	assert.match(c.confirmations[0], /1 credit.*even with no email/);
	assert.match(c.confirmations[0], /1 basic Tavily/);
	finish({ userId: "user-a", prospect: c.state.session.prospects[0] });
	await first;
	assert.equal(c.state.preparationRequest, null);
});

for (const change of ["account", "job", "logout", "navigation", "cancel"]) {
	test(`an abort-ignoring old preparation response cannot repopulate ${change} state`, async () => {
		const c = client();
		let finish;
		c.api = async () => new Promise((resolve) => { finish = resolve; });
		const first = c.prepare("person-a");
		c.cancelPreparation();
		if (change === "account") c.state.session = { authenticated: true, user: { id: "user-b" }, prospects: [] };
		if (change === "job") c.state.networkingJob = { id: "job-b" };
		if (change === "logout") c.state.session = { authenticated: false };
		if (change === "navigation") c.state.tab = "settings";
		const before = JSON.stringify(c.state);
		const renders = c.renders;
		finish({ userId: "user-a", prospect: { id: "person-a", userId: "user-a", email: "private-old@company.com" } });
		await first;
		assert.equal(JSON.stringify(c.state), before);
		assert.equal(c.renders, renders);
		assert.doesNotMatch(JSON.stringify(c.toasts), /private-old/);
	});
}

test("a changed authenticated session is reloaded instead of applying the old contact", async () => {
	const c = client();
	c.api = async (url) => url === "/api/session"
		? { authenticated: true, user: { id: "user-b" }, prospects: [] }
		: { userId: "user-a", prospect: c.state.session.prospects[0] };
	await c.prepare("person-a");
	assert.equal(c.reloads, 1);
	assert.equal(c.state.preparationRequest, null);
});

test("a failed stage refreshes its persisted result without dropping successful stages", async () => {
	const c = client();
	const saved = structuredClone(c.state.session);
	saved.prospects[0].preparation = { email: { status: "MATCHED" }, research: { status: "SOURCED" } };
	c.api = async (url) => {
		if (url === "/api/session") return saved;
		throw new Error("Draft preparation failed. Saved email and research were kept.");
	};
	await c.prepare("person-a");
	assert.equal(c.state.session.prospects[0].email, saved.prospects[0].email);
	assert.equal(c.state.session.prospects[0].preparation.research.status, "SOURCED");
	assert.equal(c.toasts.at(-1).error, true);
});

test("draft regeneration and explicit single-stage retries cannot imply extra searches", async () => {
	const c = client();
	await c.regenerate("person-a");
	assert.equal(c.calls[0].url, "/api/prospects/person-a/regenerate");
	assert.match(c.confirmations[0], /no new Tavily call/);
	assert.doesNotMatch(c.confirmations[0], /ordinary Apollo/);
	c.calls = [];
	await c.retryPreparation("person-a", "RESEARCH");
	assert.equal(c.calls[0].url, "/api/prospects/person-a/preparation/retry");
	assert.equal(c.calls[0].options.body.stage, "RESEARCH");
	assert.equal(c.calls[0].options.body.expectedVersion, 1);
});

test("unsaved edits and stale versions cannot be approved; final cancellation makes zero send requests", async () => {
	const c = client();
	c.nodes.get("draft-body").value = "Unsaved new body.";
	c.syncDraftControls();
	assert.equal(c.nodes.get("send-draft").disabled, true);
	await c.sendDraft();
	assert.equal(c.calls.length, 0);
	assert.equal(c.confirmations.length, 0);
	c.nodes.get("draft-body").value = "Saved body.";
	c.confirm = (message) => { c.confirmations.push(message); return false; };
	await c.sendDraft();
	assert.match(c.confirmations[0], /exact email.*alex@review-company.com/);
	assert.equal(c.calls.length, 0);
	c.state.session.prospects[0].draftVersion = 2;
	c.syncDraftControls();
	assert.equal(c.nodes.get("send-draft").disabled, true);
	await c.sendDraft();
	assert.equal(c.confirmations.length, 1);
});

test("saving a recipient edit binds the saved version and does not send", async () => {
	const c = client();
	c.nodes.get("draft-email").value = "reviewed@review-company.com";
	await c.saveDraft();
	assert.equal(c.calls[0].options.method, "PATCH");
	assert.equal(c.calls[0].options.body.expectedVersion, 1);
	assert.equal(c.calls[0].options.body.email, "reviewed@review-company.com");
	assert.ok(c.calls.every((call) => !call.url.endsWith("/send")));
});

test("pending Apollo authorization and limited research are explicit, not successful empty states", () => {
	const c = client();
	c.state.session.features.apolloEnrichment = false;
	assert.match(c.preparationBudget(), /server-disabled pending authorization: no Apollo call/);
	const person = c.state.session.prospects[0];
	person.preparation = { email: { provider: "APOLLO", status: "INTEGRATION_DISABLED" }, research: { status: "IRRELEVANT", sources: [] } };
	const html = c.renderPreparationContext(person);
	assert.match(html, /unavailable pending authorization/);
	assert.match(html, /limited context/);
	assert.match(html, /unrelated results were excluded/);
	assert.match(html, /must not pretend new research succeeded/);
	assert.doesNotMatch(html, /Identity-associated public professional sources saved/);
});
