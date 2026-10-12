const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "..", "public"), source = fs.readFileSync(path.join(root, "app.js"), "utf8");
function fixture(api) {
	const nodes = new Map();
	for (const id of ["form", "company", "title", "url", "location", "status", "notes", "feedback", "close", "cancel", "submit"]) {
		nodes.set(`private-job-${id}`, { value: "", textContent: "", disabled: false, events: {}, setAttribute() {}, focus() {}, addEventListener(name, fn) { this.events[name] = fn; } });
	}
	const f = { session: { authenticated: true, user: { id: "11111111-1111-4111-8111-111111111111" } }, calls: [], messages: [], saved: [], nodes };
	const c = { AbortController, URL, Error, setTimeout, clearTimeout, crypto: require("node:crypto").webcrypto,
		document: { body: { append() {} }, querySelectorAll: () => [], createElement: () => {
			f.dialog = { open: false, events: {}, setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn; }, showModal() { this.open = true; },
				close() { this.open = false; }, remove() { this.removed = true; }, querySelector: (selector) => nodes.get(selector.slice(1)),
				querySelectorAll: () => [...nodes.values()] };
			return f.dialog;
		} } };
	c.window = c; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(root, "private-jobs.js"), "utf8"), c);
	f.ui = c.PrivateJobs.create({ getSession: () => f.session, escapeHtml: String, statusOptions: String,
		notify: (m) => f.messages.push(m), onSaved: (job) => f.saved.push(job),
		api: async (url, options) => { f.calls.push({ url, options }); return api ? api(url, options) : { job: { id: "manual-fixture", manual: true } }; } });
	f.ui.open(); nodes.get("private-job-company").value = "Fictional Firm"; nodes.get("private-job-title").value = "Engineer Intern"; nodes.get("private-job-status").value = "SAVED";
	f.submit = () => nodes.get("private-job-form").events.submit({ preventDefault() {} });
	return f;
}
test("private form cancel/invalid URLs/blank required fields never save or fetch a posting", async () => {
	const f = fixture();
	f.nodes.get("private-job-company").value = ""; await f.submit(); assert.equal(f.calls.length, 0);
	f.nodes.get("private-job-company").value = "Firm"; f.nodes.get("private-job-url").value = "javascript:alert(1)";
	await f.submit(); assert.equal(f.calls.length, 0); assert.match(f.nodes.get("private-job-feedback").textContent, /HTTP/);
	f.nodes.get("private-job-cancel").events.click(); assert.ok(f.dialog.removed);
});
test("a failed save retains fields and unchanged retry key; changing fields authorizes a new submission key", async () => {
	let attempt = 0;
	const f = fixture(async () => { if (++attempt < 3) throw Error("Offline"); return { job: { id: "manual-fixture", manual: true } }; });
	await f.submit(); assert.equal(f.nodes.get("private-job-title").value, "Engineer Intern"); assert.match(f.nodes.get("private-job-feedback").textContent, /Offline/);
	await f.submit(); assert.equal(f.calls[0].options.body.submissionKey, f.calls[1].options.body.submissionKey);
	f.nodes.get("private-job-title").value = "Civil Engineer Intern";
	await f.submit(); assert.notEqual(f.calls[2].options.body.submissionKey, f.calls[1].options.body.submissionKey);
	assert.equal(f.calls[2].url, "/api/private-jobs"); assert.equal(f.saved.length, 1); assert.equal(f.messages.length, 1);
});
test("duplicate clicks authorize one save and abort-ignoring late receipt cannot cross account/logout", async () => {
	for (const logout of [false, true]) {
		let resolve; const f = fixture(() => new Promise((done) => { resolve = done; }));
		const pending = f.submit(); await f.submit(); assert.equal(f.calls.length, 1);
		f.session = logout ? { authenticated: false } : { authenticated: true, user: { id: "22222222-2222-4222-8222-222222222222" } };
		f.ui.syncSession(); resolve({ job: { id: "OLD-PRIVATE-JOB", manual: true } }); await pending;
		assert.equal(f.messages.length, 0); assert.equal(f.saved.length, 0); assert.ok(f.dialog.removed);
	}
});
test("manual presentation has optional URL guards, private labels and stable existing state/link actions", () => {
	assert.match(source, /data-add-private-job>Add job/);
	assert.match(source, /if \(job.manual\) \{ privateJobs.open\(privateJobForEditor\(id\)\); return; \}/);
	assert.match(source, /job.url \? `<a class="button primary"/);
	assert.match(source, /Not catalog-verified; availability and posting date are unknown/);
	assert.match(source, /data-remove-private-job/);
	assert.match(source, /Private, user added/);
	assert.match(source, /privateJobs\.clear\(\)/);
});
function definition(name) {
	const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
	const next = /\n(?:async )?function \w+\(/.exec(source.slice(match.index + 1));
	return source.slice(match.index, next ? match.index + 1 + next.index : source.length);
}
test("tracked loader includes all mixed pages for full filtering/sorting/summary, rejects partial and stale accounts", async () => {
	for (const scenario of ["complete", "partial", "account"]) {
		const c = { state: { session: { user: { id: "a" } } }, Error,
			api: async (url) => {
				const second = url.includes("page=2");
				if (second && scenario === "account") c.state.session.user.id = "b";
				return { jobs: Array.from({ length: second ? scenario === "partial" ? 0 : 1 : 100 }, (_, i) => ({ id: `job${second ? 100 : i}` })),
					pagination: { page: second ? 2 : 1, total: 101, totalPages: 2 } };
			} };
		vm.createContext(c); vm.runInContext(definition("fetchTrackedJobs"), c);
		if (scenario === "complete") { const result = await c.fetchTrackedJobs(); assert.equal(result.jobs.length, 101); assert.equal(result.complete, true); }
		else await assert.rejects(c.fetchTrackedJobs());
	}
});
