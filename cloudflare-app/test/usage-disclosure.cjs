const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
test("upfront entry notice links to the one usage section without introducing consent controls or tracking", () => {
	assert.match(read("app.js"), /Configured owners can view limited account-linked activity/);
	assert.match(read("app.js"), /href="\/privacy#usage-analytics">Usage analytics and privacy/);
	assert.match(read("privacy.html"), /id="usage-analytics">Usage analytics and account activity/);
	assert.doesNotMatch(read("privacy.html"), /Restricted owner operational activity/);
});
test("disclosure retains account identity, private-data restrictions and truthful retention/deletion limits", () => {
	const privacy = read("privacy.html");
	for (const text of ["your name and email address", "account-scoped counts", "Audit records do not currently have a fixed",
		"automatic expiry", "not deletion schedules", "no pageview tracking", "no separate in-app opt-out",
		"within 30 days unless retention", "search queries, raw provider responses"]) assert.ok(privacy.includes(text), text);
	assert.match(read("terms.html"), /href="\/privacy#usage-analytics"/);
	assert.match(privacy, /Effective October 10, 2026/);
});
