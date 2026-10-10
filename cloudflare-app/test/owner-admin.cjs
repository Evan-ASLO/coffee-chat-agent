const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { create } = require("../public/owner-admin.js");

const owner = (id = "owner-a") => ({
	authenticated: true, isBetaAdmin: true, user: { id, email: `${id}@example.test` },
});
const counts = { total: 3, peopleSearches: 1, jobSaves: 1, trackerChanges: 1, draftChanges: 0, outreachSends: 0, searchIssues: 0 };
function activity(name = "Fictional private account") {
	return {
		period: { days: 28, from: "2026-09-09T00:00:00.000Z", asOf: "2026-10-06T12:00:00.000Z" },
		summary: { ...counts, accounts: 2, accountsWithEvents: 1 },
		accounts: [
			{ id: "member-a", name, email: "member-a@example.test", counts, lastRecordedEventAt: "2026-10-05T12:00:00.000Z" },
			{ id: "member-b", name: "Fictional empty account", email: "member-b@example.test", counts: { ...counts, total: 0 }, lastRecordedEventAt: null },
		],
		pageSize: 20, nextCursor: null, actions: [{ value: "ALL", label: "All recorded actions" }],
	};
}

function roster() {
	return {
		fetchedAt: "2026-10-09T12:00:00.000Z", mode: "ALLOWLIST",
		summary: { namedGrants: 14, registeredEntries: 7, noCurrentAccountEntries: 7, deletedAccountEntries: 0, approvedEmailEntries: 14, configuredOwners: 1 },
		entries: Array.from({ length: 14 }, (_, i) => ({
			email: `entry-${i}@example.test`, name: i < 7 ? `Fictional registered ${i}` : null,
			userId: i < 7 ? `member-${i}` : null, registration: i < 7 ? "REGISTERED" : "NOT_REGISTERED",
			source: i === 0 ? "OWNER_AND_APPROVAL" : "APPROVAL",
		})),
		pageSize: 20, nextCursor: null,
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(handler, session = owner()) {
	const calls = [];
	const controller = { session, calls };
	controller.ui = create({
		getSession: () => controller.session,
		api: async (url, options) => {
			calls.push({ url, options });
			if (url.includes("/events?")) return { events: [], pageSize: 25, nextCursor: null };
			return handler(url, options);
		},
		document: { getElementById: () => null, querySelectorAll: () => [] },
		escapeHtml: (text) => String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
		formatDate: (text) => text,
		icon: () => "",
		notify: () => {},
	});
	return controller;
}

test("owner controls are lazy and non-owners make no owner requests", async () => {
	const signedOut = fixture(() => assert.fail("Unexpected request"), { authenticated: false });
	assert.equal(signedOut.ui.render(), "");
	await signedOut.ui.loadActivity();
	await signedOut.ui.loadAccess();
	await signedOut.ui.loadRoster();
	assert.equal(signedOut.calls.length, 0);
	const member = fixture(() => assert.fail("Unexpected request"), { ...owner(), isBetaAdmin: false });
	assert.equal(member.ui.render(), "");
	await member.ui.loadActivity();
	await member.ui.loadRoster();
	assert.equal(member.calls.length, 0);
	const admin = fixture(() => assert.fail("Rendering should not fetch"));
	assert.match(admin.ui.render(), /Owner tools/);
	assert.equal(admin.calls.length, 0);
});

test("owner roster separates named access from account registration without inventing events actions", async () => {
	const client = fixture((url) => url.includes("/activity/access") ? roster() : activity());
	await client.ui.loadActivity();
	await client.ui.loadRoster();
	const html = client.ui.render();
	assert.match(html, /Named access grants/);
	assert.match(html, /Registered entries/);
	assert.match(html, /No current registered account/);
	assert.match(html, /separate from the activity period/);
	const section = html.slice(html.indexOf('<section class="owner-roster"'), html.indexOf("</section>", html.indexOf('<section class="owner-roster"')));
	assert.doesNotMatch(section, /data-owner-user|Last recorded event|last online|never logged/i);
	assert.equal((section.match(/@example.test/g) || []).length, 14);
	assert.match(html, /Registered accounts in this snapshot/);
});

test("open access and revoked recorded accounts are labelled without claiming a finite total of site access", async () => {
	const current = roster();
	current.mode = "OPEN";
	const records = activity();
	records.accounts[0].currentAccess = { status: "OPEN", approvalStatus: "REVOKED" };
	const client = fixture((url) => url.includes("/activity/access") ? current : records);
	await client.ui.loadActivity();
	await client.ui.loadRoster();
	assert.match(client.ui.render(), /named entries are not a count of everyone who can access/);
	assert.match(client.ui.render(), /Open mode · approval revoked/);
});

test("roster errors are explicit and recoverable without hiding valid recorded activity", async () => {
	const client = fixture((url) => {
		if (url.includes("/activity/access")) throw new Error("Roster offline");
		return activity();
	});

	test("malformed roster responses do not become zero grants or invalid count success", async () => {
		const client = fixture(() => ({}));
		await client.ui.loadRoster();
		const html = client.ui.render();
		assert.match(html, /Current access roster could not be read/);
		assert.doesNotMatch(html, /No current named access grants|NaN/);
	});
	await client.ui.loadActivity();
	await client.ui.loadRoster();
	const html = client.ui.render();
	assert.match(html, /Roster offline/);
	assert.match(html, /Refresh access roster/);
	assert.match(html, /Registered accounts/);
});

for (const change of ["logout", "account", "role"]) {
	test(`late access roster cannot leak after owner ${change}`, async () => {
		const pending = deferred();
		const client = fixture(() => pending.promise);
		const loading = client.ui.loadRoster();
		if (change === "logout") client.session = { authenticated: false };
		if (change === "account") client.session = owner("owner-b");
		if (change === "role") client.session = { ...client.session, isBetaAdmin: false };
		client.ui.syncSession();
		const data = roster();
		data.entries[0].email = "PRIVATE-OLD-OWNER@example.test";
		pending.resolve(data);
		await loading;
		assert.doesNotMatch(client.ui.render(), /PRIVATE-OLD-OWNER/);
		client.session = owner();
		client.ui.syncSession();
		assert.doesNotMatch(client.ui.render(), /PRIVATE-OLD-OWNER|entry-0@example.test/);
	});
}

test("activity renders honest counts, non-presence labels, empty-period copy and escaped identities", async () => {
	const client = fixture(() => activity('<script>alert("identity")</script>'));
	await client.ui.loadActivity();
	const html = client.ui.render();
	assert.match(html, /No recorded activity in this period/);
	assert.match(html, /Last recorded event/);
	assert.match(html, /not pageviews or live presence/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>|last seen|last login|never used/i);
	assert.equal(client.calls.length, 2);
	assert.match(client.calls[0].url, /days=28/);
	assert.match(client.calls[1].url, /asOf=/);
	assert.ok(client.calls.every((entry) => !entry.options.method || entry.options.method === "GET"));
});

test("failed activity is an explicit recoverable error, not an empty or success-shaped result", async () => {
	const client = fixture(() => { throw new Error("Fictional offline error"); });
	await client.ui.loadActivity();
	const html = client.ui.render();
	assert.match(html, /Fictional offline error/);
	assert.match(html, /role="alert"/);
	assert.match(html, /Refresh activity/);
	assert.doesNotMatch(html, /No registered accounts|owner-metrics/);
});

for (const change of ["logout", "account", "role"]) {
	test(`owner ${change} clears state and discards even an abort-ignoring late response`, async () => {
		const pending = deferred();
		const client = fixture(() => pending.promise);
		const loading = client.ui.loadActivity();
		assert.match(client.ui.render(), /Loading recorded activity/);
		if (change === "logout") {
			client.ui.clear();
			client.session = { authenticated: false };
		} else if (change === "account") {
			client.session = owner("owner-b");
		} else {
			client.session = { ...client.session, isBetaAdmin: false };
		}
		client.ui.syncSession();
		assert.equal(client.calls[0].options.signal.aborted, true);
		pending.resolve(activity("SHOULD-NOT-REAPPEAR"));
		await loading;
		assert.doesNotMatch(client.ui.render(), /SHOULD-NOT-REAPPEAR|member-a@example.test/);
		client.session = owner();
		client.ui.syncSession();
		assert.doesNotMatch(client.ui.render(), /SHOULD-NOT-REAPPEAR|member-a@example.test|owner-metrics/);
	});
}

test("a same-owner clear cannot be undone by a pending response after remount", async () => {
	const pending = deferred();
	const client = fixture(() => pending.promise);
	const loading = client.ui.loadActivity();
	client.ui.clear();
	client.ui.render();
	pending.resolve(activity("OLD-OWNER-CACHE"));
	await loading;
	assert.doesNotMatch(client.ui.render(), /OLD-OWNER-CACHE|owner-metrics/);
});

test("superseded activity responses never overwrite the latest result", async () => {
	const earlier = deferred();
	let count = 0;
	const client = fixture(() => ++count === 1 ? earlier.promise : activity("LATEST-RESULT"));
	const first = client.ui.loadActivity();
	await client.ui.loadActivity(true);
	assert.match(client.ui.render(), /LATEST-RESULT/);
	earlier.resolve(activity("STALE-RESULT"));
	await first;
	assert.match(client.ui.render(), /LATEST-RESULT/);
	assert.doesNotMatch(client.ui.render(), /STALE-RESULT/);
});

test("app wires owner cleanup on session refresh, logout, 401 and 403 without tracking or exports", () => {
	const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
	const ui = fs.readFileSync(path.join(__dirname, "../public/owner-admin.js"), "utf8");
	const index = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
	assert.match(source, /async function logout\(\)[\s\S]*?ownerAdmin\.clear\(\)/);
	assert.match(source, /async function refresh\([\s\S]*?ownerAdmin\.syncSession\(\)/);
	assert.match(source, /response\.status === 401[\s\S]*?ownerAdmin\.clear\(\)/);
	assert.match(source, /response\.status === 403 && path\.startsWith\("\/api\/beta\/admin\/"\)[\s\S]*?ownerAdmin\.clear\(\)/);
	assert.ok(index.indexOf('src="/owner-loader.js') >= 0 && index.indexOf('src="/owner-loader.js') < index.indexOf('src="/app.js'));
	assert.ok(!index.includes('src="/owner-admin.js'));
	assert.doesNotMatch(ui, /localStorage|sessionStorage|setInterval|metadata_json|sendBeacon/);
	assert.match(ui, /snapshot: bulk\.review\.snapshot, requestIds: bulk\.review\.requests/);
	assert.match(ui, /Review pending batch/);
});
