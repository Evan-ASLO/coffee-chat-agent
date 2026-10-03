import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2];
const reviewState = path.resolve(import.meta.dirname, "..", "..", "..", ".d1");
const relativeOutput = output ? path.relative(reviewState, path.resolve(output)) : "";
if (!relativeOutput || path.isAbsolute(relativeOutput) ||
	relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`)) {
	throw new Error("Provide an SQL output path inside this checkout's .d1 directory.");
}
const now = new Date();
const timestamp = now.toISOString();
const atDay = (day) => new Date(now.valueOf() - day * 86400000).toISOString();
const hash = (text, encoding = "hex") => createHash("sha256").update(text).digest(encoding);
const quote = (value) =>
	value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const statements = ["PRAGMA foreign_keys = ON;"];
function insert(table, row) {
	statements.push(
		`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(quote).join(",")});`,
	);
}

const scenarios = [
	["normal", "Alex Morgan", "alex@review.example.test"],
	["empty", "Sam Chen", "sam@review.example.test"],
	[
		"long",
		"Alexandra Montgomery-Wellington",
		"alexandra.montgomery.wellington.career.workspace@review.example.test",
	],
];
for (const [index, [scenario, name, email]] of scenarios.entries()) {
	const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
	insert("users", {
		id, google_sub: `layout-review-${scenario}`, email, name,
		created_at: timestamp, updated_at: timestamp,
	});
	insert("beta_access", {
		email, status: "APPROVED", created_at: timestamp, updated_at: timestamp,
	});
	insert("sessions", {
		id: `layout-session-${scenario}`, user_id: id,
		token_hash: hash(`layout-review-${scenario}`, "base64url"),
		csrf_hash: hash("layout-review-csrf", "base64url"), expires_at: "2100-01-01T00:00:00.000Z",
		last_seen_at: timestamp, created_at: timestamp,
	});
	insert("user_settings", {
		user_id: id, sender_name: name, reply_sync_enabled: 0,
		personal_context_json: JSON.stringify([
			{ category: "Background summary", content: "Synthetic review account: a Toronto student exploring internships." },
			{ category: "Current goal", content: "Learn about public-interest technology and thoughtful professional networking." },
		]),
		created_at: timestamp, updated_at: timestamp,
	});
	if (scenario !== "empty") {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32), iv);
		cipher.setAAD(Buffer.from(`coffee-chat-agent|${id}|API_KEY|TAVILY`));
		const encrypted = Buffer.concat([
			cipher.update("fake-layout-review-key-not-a-provider-secret"), cipher.final(), cipher.getAuthTag(),
		]);
		insert("encrypted_credentials", {
			id: `layout-credential-${scenario}`, user_id: id, kind: "API_KEY", provider: "TAVILY",
			ciphertext: encrypted.toString("base64url"), iv: iv.toString("base64url"),
			key_version: "1", key_hint: "fake", created_at: timestamp, updated_at: timestamp,
		});
	}
}

const importId = "layout-review-import";
insert("job_import_runs", {
	id: importId, schema_version: 1, snapshot_hash: hash("layout-fixture"),
	content_hash: hash("layout-fixture"), generated_at: timestamp,
	generated_epoch: Math.floor(now.valueOf() / 1000), received_at: timestamp,
	applied_at: timestamp, status: "APPLIED", job_count: 18, upserted_count: 18,
});
statements.push(
	`UPDATE job_catalog_state SET latest_import_run_id = ${quote(importId)}, snapshot_hash = ${quote(hash("layout-fixture"))}, generated_at = ${quote(timestamp)}, generated_epoch = ${Math.floor(now.valueOf() / 1000)}, updated_at = ${quote(timestamp)} WHERE singleton = 1;`,
);
const companies = [
	"Northstar Analytics", "Harbour Systems", "Maple Design Studio",
	"Toronto Civic Technology Lab", "Boreal Research", "Lakeview Financial",
];
const titles = [
	"Software Engineering Intern", "Business Operations Co-op",
	"Product Design Intern", "Data and Public-Interest Technology Intern",
	"Machine Learning Research Co-op", "Investment Analytics Intern",
	"Cloud Platform Reliability and Developer Experience Internship",
	"Strategy and Sustainable Infrastructure Partnerships Intern",
];
const industries = ["Technology", "Finance", "Design", "Consulting"];
const statuses = ["SAVED", "SAVED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED", "ARCHIVED"];
const jobIds = [];
for (let index = 0; index < 18; index++) {
	const id = hash(`layout-job-${index}`);
	jobIds.push(id);
	const company = companies[index % companies.length];
	const title = titles[index % titles.length];
	const url = `https://jobs.example.test/internships/${index + 1}`;
	insert("jobs", {
		id, external_id: `review-${index}`, source: index % 4 === 0 ? "adzuna" : "workday",
		company, company_normalized: company.toLowerCase(), title, title_normalized: title.toLowerCase(),
		location: index % 3 === 0 ? "Toronto, Ontario (Hybrid)" : "Toronto, Ontario",
		region: "Canada", categories_json: '["Internship"]', url, canonical_url: url,
		posted_at: atDay(index), posted_text: `${index + 1} days ago`,
		description: "Synthetic review role. Work with a small cross-functional team on practical projects and learn from experienced colleagues.",
		first_seen_at: timestamp, last_seen_at: timestamp, latest_import_run_id: importId,
		created_at: timestamp, updated_at: timestamp, industry: industries[index % industries.length],
		duration_min_months: 4, duration_max_months: 8, duration_options_json: "[4,8]",
		term_season: "WINTER", term_year: 2027,
	});
	for (const account of [1, 3]) {
		insert("user_job_states", {
			user_id: `00000000-0000-4000-8000-${String(account).padStart(12, "0")}`, job_id: id,
			status: statuses[index % statuses.length],
			notes: account === 3
				? "Discuss the cross-functional research and sustainable infrastructure project, then confirm the application timeline. " + "AveryLongUnbrokenReferenceForLayoutReflow".repeat(3)
				: index % 2 ? "Review the role requirements and prepare a focused project example." : "",
			created_at: atDay(index), updated_at: atDay(index),
		});
	}
}

const people = [
	["Maya Patel", "DISCOVERED", "Product Manager"],
	["Jordan Lewis", "DRAFT_READY", "Software Engineer"],
	["Robin Taylor", "SENT", "Research Lead"],
	["Casey Wu", "REPLIED", "Design Operations Manager"],
	["Jamie Nguyen", "ERROR", "Public-Interest Technology Partnerships Lead"],
	["Avery Singh", "SENDING", "Platform Engineering Lead"],
];
for (const account of [1, 3]) {
	const userId = `00000000-0000-4000-8000-${String(account).padStart(12, "0")}`;
	for (const [index, [name, status, title]] of people.entries()) {
		const id = `00000000-0000-4000-8000-${String(account * 100 + index).padStart(12, "0")}`;
		const long = account === 3;
		insert("prospects", {
			id, user_id: userId, full_name: long ? `${name} Montgomery-Wellington` : name,
			first_name: name.split(" ")[0], last_name: name.split(" ")[1],
			title: long ? `${title}, Sustainable Infrastructure and Cross-Functional Research` : title,
			company: companies[index], status, location: "Toronto, Ontario, Canada",
			email: long ? `avery.long.synthetic.address.for.layout.review.${index}@people.example.test` : `person${index}@people.example.test`,
			email_confidence: 90, discovery_provider: "TAVILY", source_url: `https://profiles.example.test/${account}/${index}`,
			source_snippet: "Synthetic public-profile fixture, not a real person or provider result.",
			why_relevant: "Recorded public-profile review fixture.", relevance_score: 80,
			match_quality: index % 2 ? "BROADER_COMPANY" : "STRONG",
			subject: "Learning about your work in Toronto",
			draft_body: "Hi Jordan,\n\nThis is a synthetic local review draft, not a message intended for delivery. I am exploring internship opportunities and would appreciate learning about your team's work.\n\nThank you,\nAlex",
			draft_provider: "TEMPLATE", draft_version: 1, draft_hash: hash("synthetic-review-draft"),
			sent_at: ["SENT", "REPLIED"].includes(status) ? atDay(3) : null,
			last_reply_at: status === "REPLIED" ? atDay(1) : null,
			reply_snippet: status === "REPLIED" ? "Synthetic reply: happy to share more about our project work." : "",
			error_code: status === "ERROR" ? "PROVIDER_ERROR" : "",
			error_message: status === "ERROR" ? "Synthetic review error. Retry only after reviewing the public profile." : "",
			created_at: atDay(index + 1), updated_at: atDay(index),
		});
	}
	for (let day = 0; day < 28; day++) {
		insert("audit_events", {
			id: `layout-audit-${account}-${day}`, user_id: userId,
			action: day % 2 ? "JOB_STATE_UPDATED" : "SETTINGS_UPDATED",
			entity_type: day % 2 ? "job" : "settings", entity_id: day % 2 ? jobIds[day % jobIds.length] : userId,
			request_id: "layout-review-only", created_at: atDay(day),
		});
	}
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, statements.join("\n") + "\n");
console.log(`Generated synthetic normal, empty and long-content fixtures: ${output}`);
