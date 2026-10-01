import { describe, expect, it } from "vitest";
import {
	classifyJobIndustry,
	deriveJobClassification,
	formatDurationMonths,
	formatJobTerm,
	parseInternshipDurationMonths,
	parseInternshipTerm,
} from "../src/lib/job-classification";

describe("job industry classification", () => {
	it("maps known employer aliases case-insensitively", () => {
		expect(
			classifyJobIndustry({
				company: "The Bank of Nova Scotia",
				title: "Data Intern",
				description: null,
			}),
		).toBe("Banking & Financial Services");
		expect(
			classifyJobIndustry({
				company: "D2L",
				title: "Product Intern",
				description: null,
			}),
		).toBe("Technology");
		expect(
			classifyJobIndustry({
				company: "PricewaterhouseCoopers",
				title: "Advisory Intern",
				description: null,
			}),
		).toBe("Consulting & Professional Services");
	});

	it("allows a clear insurance title to override a bank sector", () => {
		expect(
			classifyJobIndustry({
				company: "TD",
				title: "Actuarial Insurance Intern",
				description: "Support an insurance product team.",
			}),
		).toBe("Insurance");
	});

	it("uses conservative keywords and defaults unknown employers to Other", () => {
		expect(
			classifyJobIndustry({
				company: "Maple Clinical Therapeutics",
				title: "Research Intern",
				description: null,
			}),
		).toBe("Healthcare & Life Sciences");
		expect(
			classifyJobIndustry({
				company: "Maple Research Collective",
				title: "Finance Intern",
				description: "Build spreadsheets and presentations.",
			}),
		).toBe("Other");
	});
});

describe("internship duration parsing", () => {
	it("prefers explicit title durations over description values", () => {
		expect(
			parseInternshipDurationMonths(
				"Winter Analyst Intern - 4 Months",
				"Some placements may last 8 months.",
			),
		).toEqual([4]);
	});

	it("parses alternatives, ranges, casing, and hyphenation", () => {
		expect(
			parseInternshipDurationMonths(
				"Consulting Internship - 4 or 8 months",
				null,
			),
		).toEqual([4, 8]);
		expect(
			parseInternshipDurationMonths("Engineering Co-op, 12-16 Months", null),
		).toEqual([12, 16]);
		expect(
			parseInternshipDurationMonths("", "This is an 8-month placement."),
		).toEqual([8]);
	});

	it("leaves implicit or excessively ambiguous durations unknown", () => {
		expect(
			parseInternshipDurationMonths("Summer internship", "Runs May to August."),
		).toEqual([]);
		expect(
			parseInternshipDurationMonths(
				"Internship",
				"Programs may be 2 months, 4 months, 8 months, 12 months, or 16 months.",
			),
		).toEqual([]);
	});
});

describe("internship term parsing", () => {
	it("normalizes seasons and two-digit years", () => {
		expect(parseInternshipTerm("Winter '27 Internship", null)).toEqual({
			season: "WINTER",
			year: 2027,
		});
		expect(parseInternshipTerm("2028 Autumn Co-op", null)).toEqual({
			season: "FALL",
			year: 2028,
		});
	});

	it("uses description only when the title has no term", () => {
		expect(
			parseInternshipTerm(
				"Finance Internship",
				"The placement begins in Spring 2028.",
			),
		).toEqual({ season: "SPRING", year: 2028 });
	});

	it("does not guess when title terms are ambiguous or only dates exist", () => {
		expect(
			parseInternshipTerm("Summer 2027 / Fall 2027 Internship", null),
		).toBeNull();
		expect(
			parseInternshipTerm(
				"Internship posted 2027-01-15",
				"Apply before 2027-02-01.",
			),
		).toBeNull();
	});
});

describe("derived job displays", () => {
	it("returns stable display labels", () => {
		const derived = deriveJobClassification({
			company: "Scotiabank",
			title: "Winter 2027 Intern - 4 or 8 months",
			description: null,
		});
		expect(derived).toMatchObject({
			industry: "Banking & Financial Services",
			durationMonths: [4, 8],
			durationMinMonths: 4,
			durationMaxMonths: 8,
			termSeason: "WINTER",
			termYear: 2027,
		});
		expect(formatDurationMonths([4, 8])).toBe("4 or 8 months");
		expect(formatJobTerm("SUMMER", 2027)).toBe("Summer '27");
	});
});
