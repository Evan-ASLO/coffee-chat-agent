const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const definitions = source.slice(source.indexOf("const dateFormatters ="), source.indexOf("function formatFileSize"));
function formatterFixture(locale, timeZone) {
	let constructions = 0;
	const c = {
		Intl: { DateTimeFormat: function (_locale, options) {
			constructions++;
			return new Intl.DateTimeFormat(locale, { ...options, timeZone });
		} },
		Date,
	};
	vm.createContext(c); vm.runInContext(definitions, c);
	return { c, constructions: () => constructions };
}
test("formatter configurations are created lazily once per shape, never once per row or account", () => {
	const fixture = formatterFixture("en-CA", "America/Toronto");
	assert.equal(fixture.constructions(), 0);
	for (let index = 0; index < 100; index++) {
		fixture.c.formatDateOnly(new Date(Date.UTC(2026, 9, index + 1)).toISOString());
		fixture.c.formatDate(new Date(Date.UTC(2026, 9, index + 1)).toISOString());
	}
	assert.equal(fixture.constructions(), 2);
	assert.doesNotMatch(definitions, /localStorage|sessionStorage|state\.|Map|entry\s*=/);
});
test("all values keep native locale/time-zone date and time output across DST, dates, null and epoch inputs", () => {
	for (const locale of ["en-CA", "fr-CA", "de-DE", "ja-JP"]) {
		for (const timeZone of ["UTC", "America/Toronto", "Asia/Tokyo"]) {
			const { c } = formatterFixture(locale, timeZone);
			for (const value of ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T06:00:00Z",
				"2026-10-09T12:00:00.761000Z", "2026-10-09T12:00:00.761Z", 0, null]) {
				assert.equal(c.formatDate(value), new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)));
				assert.equal(c.formatDateOnly(value), new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium" }).format(new Date(value)));
			}
		}
	}
});
test("invalid dates still throw rather than returning a fabricated successful value", () => {
	const { c } = formatterFixture("en-CA", "UTC");
	for (const value of ["not-a-date", undefined, NaN]) {
		assert.throws(() => c.formatDate(value), RangeError);
		assert.throws(() => c.formatDateOnly(value), RangeError);
	}
	assert.equal(c.formatDateOnly("2026-10-10T00:00:00Z"), "Oct 10, 2026");
});
