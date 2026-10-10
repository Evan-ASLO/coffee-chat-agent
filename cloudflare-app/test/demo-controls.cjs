const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "job-first.js"), "utf8");
test("Demo keeps native controls and existing media/captions while adding only speed choices", () => {
	assert.match(source, /<video controls playsinline preload="none"/);
	assert.doesNotMatch(source, /data-demo-seek|Rewind 5|Forward 5|currentTime\s*=/);
	assert.match(source, /\[0\.5, 0\.75, 1, 1\.25, 1\.5, 2\]/);
	assert.match(source, /video\.addEventListener\("ratechange"/);
	assert.match(source, /"emptied", "error"/);
	assert.match(source, /"close", \(\) => video\.pause\(\), \{ once: true \}/);
	assert.doesNotMatch(source, /autoplay|video\.play\(|localStorage|\/api\/discovery/);
});
