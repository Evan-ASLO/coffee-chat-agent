const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const onboarding = require("../public/onboarding.js");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("client and server agree on stable tutorial steps and version", () => {
	const server = read("src/lib/onboarding.ts");
	const list = server.match(/ONBOARDING_STEPS = \[([\s\S]+?)\] as const/)[1];
	assert.deepEqual(onboarding.stepIds, [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
	assert.equal(onboarding.VERSION, 1);
	assert.equal(new Set(onboarding.stepIds).size, onboarding.stepIds.length);
});

test("legacy users can replay and paused users can resume without a browser progress store", () => {
	for (const status of ["legacy", "completed", "skipped", "paused", "in_progress", "invited"]) {
		const html = onboarding.settingsHtml({ onboarding: { version: 1, revision: 0, status, step: "welcome" } });
		assert.match(html, /Workspace tutorial/);
		assert.match(html, /Set up API keys/);
		assert.match(html, /Explore your workspace/);
		assert.match(html, /data-onboarding-launch=/);
		if (["paused", "in_progress"].includes(status)) assert.match(html, /Resume tutorial/);
	}
	assert.doesNotMatch(read("public/onboarding.js"), /localStorage|sessionStorage|document\.cookie|console\.log/);
});

test("tour is an optional, labelled non-modal coach with safe official links", () => {
	const client = read("public/onboarding.js");
	assert.match(client, /aria-modal="false"/);
	assert.match(client, /aria-labelledby="tutorial-title"/);
	assert.match(client, /aria-live.*polite/);
	assert.match(client, /MutationObserver/);
	assert.match(client, /listeners\.abort/);
	assert.match(client, /observer\.disconnect/);
	for (const host of ["app.tavily.com", "hunter.io/api-keys", "aistudio.google.com/apikey", "platform.openai.com/api-keys", "platform.claude.com/settings/keys"]) {
		assert.ok(client.includes(host));
	}
	assert.match(client, /rel="noopener noreferrer"/);
	assert.doesNotMatch(client, /api\/(discovery|credentials|resume|workspace)|api\/prospects|auth\/google\/connect/);
	assert.match(read("public/onboarding.css"), /prefers-reduced-motion/);
});
