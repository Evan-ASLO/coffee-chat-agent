const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../public/owner-admin.js");
const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public", "owner-admin.js"), "utf8");
function fixture(ready = true) {
	const nodes = new Map();
	const node = (id) => {
		const value = { id, handlers: {}, value: "future@example.test", open: false, innerHTML: "",
			addEventListener(event, handler) { this.handlers[event] = handler; }, remove() {}, focus() {}, setAttribute() {},
			contains: () => false, querySelectorAll: () => [] };
		nodes.set(id, value);
		return value;
	};
	const panel = node("owner-panel"), disclosure = node("owner-controls"), tab = node("owner-beta-tab");
	tab.dataset = { ownerSection: "beta" };
	disclosure.querySelectorAll = () => [tab];
	for (const id of ["owner-notify-email", "beta-approve-email-form", "beta-approve-email"]) node(id);
	const f = { session: { authenticated: true, isBetaAdmin: true, user: { id: "owner-a", email: "owner-a@example.test" } }, calls: [], nodes, panel };
	f.access = { gmailConfigured: ready, acceptanceTemplate: { subject: "You're approved for Internship & Coffee Chat", body: "Sign in with the approved Google email. <script>untrusted</script>" },
		access: ["QUEUED", "SENDING", "SENT", "FAILED", "UNCERTAIN"].map((status) => ({
			email: `${status.toLowerCase()}@example.test`, status: "APPROVED", updatedAt: "2026-10-09",
			notification: { id: `${status}-id`, status, senderIsYou: true, failureCode: null, sentAt: status === "SENT" ? "2026-10-09" : null },
		})), requests: [], pendingTotal: 0, approvalBatchLimit: 50, listLimit: 500 };
	f.ui = create({
		getSession: () => f.session, api: async (url, options) => { f.calls.push({ url, options }); return f.access; },
		document: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [] },
		escapeHtml: (value) => String(value || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
		formatDate: (value) => value, icon: () => "", notify() {},
	});
	f.beta = async () => { await f.ui.loadAccess(); f.ui.wire(); tab.handlers.click(); };
	return f;
}
test("owner email consent defaults on only when Gmail is configured; preview and states are escaped and truthful", async () => {
	const ready = fixture();
	await ready.beta();
	assert.match(ready.panel.innerHTML, /id="owner-notify-email"[^>]*checked/);
	assert.match(ready.panel.innerHTML, /Preview acceptance email/);
	assert.match(ready.panel.innerHTML, /&lt;script&gt;/);
	assert.doesNotMatch(ready.panel.innerHTML, /<script>/);
	assert.match(ready.panel.innerHTML, /Delivery is not confirmed/);
	assert.match(ready.panel.innerHTML, /outcome uncertain/);
	assert.equal((ready.panel.innerHTML.match(/data-beta-retry-notice=/g) || []).length, 1);
	const missing = fixture(false);
	await missing.beta();
	assert.match(missing.panel.innerHTML, /id="owner-notify-email"[^>]*disabled/);
	assert.doesNotMatch(missing.panel.innerHTML, /id="owner-notify-email"[^>]*checked/);
	assert.match(missing.panel.innerHTML, /Access approval still works without email/);
});
test("approval confirmation explains queued email and cancel sends no request; opt-out is explicit in the payload", async () => {
	const f = fixture();
	await f.beta();
	const original = globalThis.confirm;
	try {
		let message;
		globalThis.confirm = (text) => { message = text; return false; };
		f.nodes.get("beta-approve-email-form").handlers.submit({ preventDefault() {} });
		assert.match(message, /queues the previewed acceptance email from your Gmail/);
		assert.equal(f.calls.filter((call) => call.options.method === "POST").length, 0);
		f.nodes.get("owner-notify-email").handlers.change({ target: { checked: false } });
		globalThis.confirm = (text) => { message = text; return true; };
		f.nodes.get("beta-approve-email-form").handlers.submit({ preventDefault() {} });
		await new Promise(setImmediate);
		const approval = f.calls.find((call) => call.options.method === "POST");
		assert.equal(approval.options.body.notifyEmail, false);
		assert.match(message, /No acceptance email will be sent/);
	} finally { globalThis.confirm = original; }
});
test("a late owner-access response cannot leak notification identities after account switch", async () => {
	const f = fixture();
	let done;
	const pending = new Promise((resolve) => { done = resolve; });
	const ui = create({
		getSession: () => f.session, api: () => pending,
		document: { getElementById: () => null, querySelectorAll: () => [] },
		escapeHtml: String, formatDate: String, icon: () => "", notify() {},
	});
	const loading = ui.loadAccess();
	f.session = { authenticated: true, isBetaAdmin: true, user: { id: "owner-b", email: "owner-b@example.test" } };
	ui.syncSession(); done(f.access); await loading;
	assert.doesNotMatch(ui.render(), /queued@example\.test|SENT-id/);
});
test("bulk confirmation captures consent; retry is restricted to failed owner-bound notices, not uncertain ones", () => {
	assert.match(source, /notifyEmail: notifyByEmail\(\)/);
	assert.match(source, /notifyEmail: bulk\.notifyEmail/);
	assert.match(source, /n\.status === "FAILED" && n\.senderIsYou/);
	assert.match(source, /Retry the confirmed unsent acceptance email/);
	assert.doesNotMatch(source, /sendGmail|\/api\/discovery|\/api\/prospects/);
});
