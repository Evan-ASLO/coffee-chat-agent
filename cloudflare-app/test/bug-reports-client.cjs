const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../public/bug-reports.js");
function fixture() {
	const nodes = new Map();
	for (const id of ["bug-report-form", "bug-report-summary", "bug-report-description", "bug-report-feedback", "bug-report-cancel", "bug-report-submit"]) {
		nodes.set(id, { value: "", textContent: "", disabled: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, setAttribute() {}, focus() {} });
	}
	const session = { authenticated: true, user: { id: "user-a", name: "Fictional member", email: "member@example.test" } };
	const c = { session, nodes, calls: [], messages: [], dialog: null };
	const doc = {
		body: { append() {} }, getElementById: (id) => nodes.get(id), querySelectorAll: () => [],
		createElement: () => {
			const dialog = { events: {}, innerHTML: "", setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn; },
				showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; },
				querySelectorAll: () => [...nodes.values()] };
			c.dialog = dialog;
			return dialog;
		},
	};
	c.ui = create({
		document: doc, getSession: () => c.session, getView: () => "networking",
		notify: (message) => c.messages.push(message),
		api: async (url, options) => { c.calls.push({ url, options }); return { receipt: { id: "saved-receipt", createdAt: "2026-10-09T12:00:00.000Z" } }; },
	});
	c.ui.open();
	nodes.get("bug-report-summary").value = "People link stuck";
	nodes.get("bug-report-description").value = "The selected job's People list did not finish loading.";
	return c;
}
test("cancel and inline invalid input make no report request", async () => {
	const c = fixture();
	c.nodes.get("bug-report-summary").value = "x";
	await c.ui.submit();
	assert.match(c.nodes.get("bug-report-feedback").textContent, /Enter a summary/);
	assert.equal(c.calls.length, 0);
	c.nodes.get("bug-report-cancel").events.click();
	assert.equal(c.calls.length, 0);
	assert.equal(c.dialog.removed, true);
});
test("successful persistence produces a receipt and only safe explicit context", async () => {
	const c = fixture();
	await c.ui.submit();
	assert.equal(c.calls.length, 1);
	assert.equal(c.calls[0].url, "/api/bug-reports");
	assert.deepEqual(Object.keys(c.calls[0].options.body).sort(), ["summary", "description", "page", "submissionKey", "expectedUserId"].sort());
	assert.equal(c.calls[0].options.body.page, "networking");
	assert.match(c.messages[0], /Report saved.*Receipt/);
	assert.equal(c.dialog.removed, true);
});
test("failed submission keeps text and reuses its key on retry", async () => {
	const c = fixture();
	let count = 0, keys = [];
	c.ui = create({
		document: { body: { append() {} }, getElementById: (id) => c.nodes.get(id), querySelectorAll: () => [], createElement: () => c.dialog },
		getSession: () => c.session, getView: () => "home", notify: (message) => c.messages.push(message),
		api: async (_url, options) => { keys.push(options.body.submissionKey); if (++count === 1) throw new Error("Offline"); return { receipt: { id: "saved", createdAt: "now" } }; },
	});
	c.ui.open();
	await c.ui.submit();
	assert.match(c.nodes.get("bug-report-feedback").textContent, /Offline.*avoid submitting a duplicate/);
	assert.equal(c.nodes.get("bug-report-description").value, "The selected job's People list did not finish loading.");
	await c.ui.submit();
	assert.equal(keys[0], keys[1]);
	assert.equal(c.messages.length, 1);
});
test("late report receipt cannot leak after account change", async () => {
	const c = fixture();
	let finish;
	const pending = new Promise((resolve) => { finish = resolve; });
	const original = c.ui;
	c.ui.clear();
	const doc = { body: { append() {} }, getElementById: (id) => c.nodes.get(id), querySelectorAll: () => [], createElement: () => c.dialog };
	c.ui = create({ document: doc, getSession: () => c.session, getView: () => "home", notify: (message) => c.messages.push(message), api: () => pending });
	c.ui.open();
	const sending = c.ui.submit();
	c.session = { authenticated: true, user: { id: "user-b" } };
	c.ui.syncSession();
	finish({ receipt: { id: "OLD-PRIVATE-RECEIPT", createdAt: "now" } });
	await sending;
	assert.equal(c.messages.length, 0);
	assert.equal(c.dialog.removed, true);
	assert.ok(original);
});
