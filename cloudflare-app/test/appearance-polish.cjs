const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const root = path.join(__dirname, "..", "public");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "job-first.css"), "utf8");
test("Appearance contains only its heading and shared Light/Dark choices; obsolete markup/styles are removed", () => {
	const block = app.match(/<section class="settings-reference-card appearance-card">([\s\S]*?)<\/section>/)[1];
	assert.equal(block.trim().replace(/\s+/g, " "), "<h2>Appearance</h2> ${themeChoices()}");
	for (const file of ["app.js", "styles.css", "job-first.css"]) assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /appearance-summary|appearance-swatches/);
	assert.doesNotMatch(app, /workspace follows your device's light or dark preference/);
});
test("menu keeps routes and guide, uses bounded disclosure scrolling and scoped leading-edge typography", () => {
	for (const route of ["settings", "analytics", "home"]) assert.ok(app.includes(`data-nav="${route}"`));
	assert.match(app, /data-open-guide/);
	assert.match(app, /id="logout"/);
	assert.match(css, /\.account-menu-panel button \{[^}]*justify-content: flex-start;[^}]*min-height: 44px;[^}]*font-weight: 400;/);
	assert.match(css, /\.account-menu-panel \{[^}]*max-height:[^}]*overflow-y: auto/);
	assert.match(app, /accountMenu\.open = false;[\s\S]*?accountMenu\.querySelector\("summary"\)\?\.focus/);
	assert.doesNotMatch(app, /class="account-menu"[^>]*role="menu"/);
});
