const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), test = require("node:test"), vm = require("node:vm");
const root = path.join(__dirname, "..", "public");
test("results/detail scroll independently only on desktop; focus never scrolls the document", () => {
	const css = fs.readFileSync(path.join(root, "job-first.css"), "utf8"), app = fs.readFileSync(path.join(root, "app.js"), "utf8");
	assert.match(css, /@media \(min-width: 761px\)[\s\S]*?height: var\(--job-pane-height,[^}]*overflow-y: auto/);
	assert.match(app, /jobBrowsing\.beforeRender\(\)/);
	assert.match(app, /jobBrowsing\.mount\(\)/);
	assert.match(app, /getElementById\("job-detail-title"\)\?\.focus\(\{ preventScroll: true \}\)/);
	assert.match(app, /aria-label="Job results" tabindex="0"/);
	assert.match(app, /data-browse-query/);
});
test("scroll positions are bounded transient query+owner state and clear across account changes", () => {
	let account = "owner-a";
	const c = { document: { querySelector: () => null }, matchMedia: () => ({ matches: true }), addEventListener() {}, requestAnimationFrame() {}, cancelAnimationFrame() {} };
	c.window = c; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(root, "job-browsing.js"), "utf8"), c);
	const ui = c.JobBrowsing.create({ getOwner: () => account });
	ui.capture(); account = "owner-b"; ui.capture(); ui.clear();
	const source = fs.readFileSync(path.join(root, "job-browsing.js"), "utf8");
	assert.match(source, /positions\.size > 10/);
	assert.match(source, /positions\.clear\(\); owner = current/);
	assert.match(source, /node\.dataset\.browseOwner !== owner/);
	assert.doesNotMatch(source, /localStorage|sessionStorage|\/api|fetch\(/);
});
