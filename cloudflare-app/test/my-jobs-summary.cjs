const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
test("only My jobs summary defaults open using native declarative details", () => {
	assert.match(source, /<details class="workspace-insights" open><summary>Summary, progress & next-step notes<\/summary>/);
	assert.match(source, /<details class="workspace-insights"><summary>Summary, approval workflow & activity<\/summary>/);
	assert.equal((source.match(/<details class="workspace-insights" open>/g) || []).length, 1);
});
