import { createServer } from "node:net";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, ".tutorial-preview");
// Keep SQLite's generated WAL filenames below Windows' native path limit.
const state = join(root, ".d1");
const port = Number(process.env.TUTORIAL_PREVIEW_PORT || 8803);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a valid distinct local preview port.");
try {
	await stat(state);
	throw new Error("This local preview database already exists. Reuse it; do not overwrite a review workspace.");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
await new Promise((resolvePort, rejectPort) => {
	const probe = createServer();
	probe.once("error", rejectPort);
	probe.listen(port, "127.0.0.1", () => probe.close(resolvePort));
});
await mkdir(join(preview, "migrations"), { recursive: true });
const config = {
	name: "onboarding-local-review",
	main: "../test/local-onboarding-preview.ts",
	compatibility_date: "2026-09-28",
	compatibility_flags: ["nodejs_compat"],
	workers_dev: false,
	preview_urls: false,
	assets: {
		directory: "../public", binding: "ASSETS", not_found_handling: "single-page-application",
		run_worker_first: ["/api/*", "/auth/*", "/logout", "/__review/*"],
	},
	vars: {
		APP_ORIGIN: `http://127.0.0.1:${port}`,
		LOCAL_TUTORIAL_PREVIEW: "true",
		BETA_ACCESS_MODE: "ALLOWLIST",
		BETA_ADMIN_EMAILS: "",
		ENABLE_JOB_OUTREACH_LINKING: "true",
		ACTIVE_KEY_VERSION: "1",
		SESSION_DAYS: "7",
		MAX_DISCOVERY_RESULTS: "20",
		MAX_DRAFTS_PER_HOUR: "30",
		MAX_SENDS_PER_DAY: "50",
		GOOGLE_CLIENT_ID: "fake-local-review-client",
		GOOGLE_CLIENT_SECRET: "fake-local-review-client-secret",
		JOBS_INGEST_SECRET: "fake-local-review-ingest",
		MASTER_ENCRYPTION_KEY_V1: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
		SESSION_SIGNING_KEY: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
	},
	d1_databases: [{ binding: "DB", database_name: "onboarding-review", database_id: "00000000-0000-4000-8000-000000000808", migrations_dir: "./migrations" }],
};
await writeFile(join(preview, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
const migrations = (await readdir(join(root, "migrations"))).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
for (const migration of migrations.filter((file) => !file.startsWith("0008"))) {
	await copyFile(join(root, "migrations", migration), join(preview, "migrations", migration));
}

function wrangler(...args) {
	const result = spawnSync(process.execPath, [
		join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args,
		"--config", join(preview, "wrangler.jsonc"), "--local", "--persist-to", state,
	], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(preview, "wrangler.log") } });
	if (result.status !== 0) throw new Error(`Local-only Wrangler failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

const migrationReceipts = [];
migrationReceipts.push(wrangler("d1", "migrations", "apply", "onboarding-review"));
const now = new Date().toISOString();
const legacy = "10000000-0000-4000-8000-000000000808";
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
await writeFile(join(preview, "legacy.sql"), `
INSERT INTO users(id,google_sub,email,name,image,created_at,updated_at)
VALUES('${legacy}','local-tutorial-existing','tutorial-existing@example.test','Fictional existing reviewer','',${sql(now)},${sql(now)});
INSERT INTO user_settings(user_id,sender_name,personal_context_json,created_at,updated_at)
VALUES('${legacy}','Fictional reviewer','[{"category":"Background summary","content":"This is a fictional local review profile, not a real person."}]',${sql(now)},${sql(now)});
`);
wrangler("d1", "execute", "onboarding-review", "--file", join(preview, "legacy.sql"));
await copyFile(join(root, "migrations", "0008_first_login_tutorial.sql"), join(preview, "migrations", "0008_first_login_tutorial.sql"));
migrationReceipts.push(wrangler("d1", "migrations", "apply", "onboarding-review"));

const jobs = [
	["a".repeat(64), "Example Research Co", "Research Intern", "Finance", "APPLIED"],
	["b".repeat(64), "Example Software Co", "Software Engineering Intern", "Technology", "SAVED"],
	["c".repeat(64), "Example Product Co", "Product Design Intern", "Technology", ""],
];
const snapshot = "d".repeat(64);
const importId = "20000000-0000-4000-8000-000000000808";
let seed = `
INSERT INTO job_import_runs(id,schema_version,snapshot_hash,content_hash,generated_at,generated_epoch,received_at,applied_at,status,job_count,upserted_count)
VALUES('${importId}',1,'${snapshot}','${snapshot}',${sql(now)},${Date.now()},${sql(now)},${sql(now)},'APPLIED',3,3);
UPDATE job_catalog_state SET latest_import_run_id='${importId}',snapshot_hash='${snapshot}',generated_at=${sql(now)},generated_epoch=${Date.now()},updated_at=${sql(now)} WHERE singleton=1;
`;
for (const [id, company, title, industry, stage] of jobs) {
	seed += `
INSERT INTO jobs(id,source,company,company_normalized,title,title_normalized,location,region,categories_json,url,canonical_url,posted_at,description,first_seen_at,last_seen_at,latest_import_run_id,created_at,updated_at,industry,duration_min_months,duration_max_months,duration_options_json,term_season,term_year)
VALUES('${id}','local-review',${sql(company)},${sql(company.toLowerCase())},${sql(title)},${sql(title.toLowerCase())},'Toronto','Ontario','["Internship"]','https://example.test/jobs/${id}','https://example.test/jobs/${id}',${sql(now)},'Fictional local review opportunity. No real employer or posting.',${sql(now)},${sql(now)},'${importId}',${sql(now)},${sql(now)},${sql(industry)},4,4,'[4]','Summer',2027);
`;
	if (stage) seed += `INSERT INTO user_job_states(user_id,job_id,status,notes,created_at,updated_at) VALUES('${legacy}','${id}','${stage}','Fictional private next step for local review.',${sql(now)},${sql(now)});\n`;
}
for (const choice of ["new", "existing", "second"]) {
	seed += `INSERT INTO beta_access(email,status,created_at,updated_at) VALUES('tutorial-${choice}@example.test','APPROVED',${sql(now)},${sql(now)});\n`;
}
for (const [suffix, name, status, quality] of [
	["1", "Fictional Avery", "DISCOVERED", "BROADER_COMPANY"],
	["2", "Fictional Blair", "DRAFT_READY", "STRONG"],
	["3", "Fictional Casey", "SENT", "STRONG"],
]) {
	seed += `
INSERT INTO prospects(id,user_id,status,full_name,first_name,title,company,location,discovery_provider,source_url,source_snippet,why_relevant,match_quality,subject,draft_body,draft_provider,draft_model,draft_version,personalization_notes,created_at,updated_at)
VALUES('30000000-0000-4000-8000-00000000080${suffix}','${legacy}','${status}',${sql(name)},${sql(name)},'Fictional reviewer','Example Research Co','Toronto','TAVILY','https://example.test/people/${suffix}','Fictional public-profile fixture.','Fictional local review match.','${quality}','Fictional review subject','This is a fictional review draft. Never send this fixture.','TEMPLATE','template',1,'Fictional facts only.',${sql(now)},${sql(now)});
`;
}
await writeFile(join(preview, "seed.sql"), seed);
wrangler("d1", "execute", "onboarding-review", "--file", join(preview, "seed.sql"));
await writeFile(join(preview, "migrations.log"), migrationReceipts.join("\n"));
await writeFile(join(preview, "receipt.json"), `${JSON.stringify({
	createdAt: now, port, database: "fresh isolated local D1", migrations, legacySeededBefore0008: true,
	fixtures: ["new", "existing", "second", "denied"], externalActionsDisabled: true,
	config: join(preview, "wrangler.jsonc"), state,
}, null, 2)}\n`);
console.log(`Fresh local review prepared at http://127.0.0.1:${port}/__review/new`);
console.log("Existing-account replay: /__review/existing. External/provider/Google/email actions are disabled.");
