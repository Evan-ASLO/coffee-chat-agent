import { createCipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, ".tutorial-preview");
const env = { ...process.env, TUTORIAL_PREVIEW_PORT: process.env.CONTACTS_PREVIEW_PORT || "8805", WRANGLER_SEND_METRICS: "false" };
function run(file, args = []) {
	const result = spawnSync(process.execPath, [file, ...args], { cwd: root, env, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Local fixture preparation failed:\n${result.stdout}\n${result.stderr}`);
}

// Reuse the existing isolated migration, synthetic-account and port-safety setup.
run(join(root, "scripts", "prepare-onboarding-preview.mjs"));
const config = JSON.parse(await readFile(join(preview, "wrangler.jsonc"), "utf8"));
config.name = "contacts-local-review";
config.main = "../test/local-contacts-preview.ts";
config.vars.LOCAL_CONTACTS_PREVIEW = "true";
config.assets.run_worker_first = true;
await writeFile(join(preview, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
const receipt = JSON.parse(await readFile(join(preview, "receipt.json"), "utf8"));
const owner = "10000000-0000-4000-8000-000000000808";
const now = new Date().toISOString();
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const statements = [
	`UPDATE user_settings SET people_search_fallback_provider='ANTHROPIC', enrichment_provider='NONE',reply_sync_enabled=0 WHERE user_id='${owner}';`,
	`UPDATE jobs SET company='Example Software Co',company_normalized='example software co',title='Marketing Intern',title_normalized='marketing intern' WHERE id='${"a".repeat(64)}';`,
];
const people = [
	["1", "Fictional Avery", "Junior Software Engineer", "DISCOVERED"],
	["2", "Fictional Blair", "Senior Campus Recruiter", "DRAFT_READY"],
	["3", "Fictional Casey", "Junior Marketing Specialist", "DISCOVERED"],
	["4", "Fictional Dana", "Senior Software Engineer", "DISCOVERED"],
	["5", "Fictional Emerson", "Software Engineer", "DISCOVERED"],
];
for (const [suffix, name, title, status] of people) {
	const id = `30000000-0000-4000-8000-00000000080${suffix}`;
	const source = `https://www.linkedin.com/in/fictional-local-review-${suffix}`;
	const evidence = `${name} is a ${title} at Example Software Co.`;
	statements.push(
		`INSERT OR IGNORE INTO prospects(id,user_id,status,full_name,discovery_provider,created_at,updated_at) VALUES('${id}','${owner}','${status}',${sql(name)},'TAVILY',${sql(now)},${sql(now)});`,
		`UPDATE prospects SET full_name=${sql(name)},first_name=${sql(name.split(" ")[1])},title=${sql(title)},company='Example Software Co',status='${status}',source_url='${source}',linkedin_url='${source}',source_snippet=${sql(evidence)},why_relevant='Fictional saved public evidence for review only.',match_quality='${suffix === "1" ? "STRONG" : "BROADER_COMPANY"}',email='${suffix === "2" ? "fictional-blair@example.test" : ""}',draft_version=${suffix === "2" ? 1 : 0},relevance_score=90 WHERE id='${id}';`,
	);
	for (const job of ["a".repeat(64), "b".repeat(64)]) {
		statements.push(`INSERT INTO job_prospects(user_id,job_id,prospect_id,created_at) VALUES('${owner}','${job}','${id}',${sql(now)});`);
	}
}
for (const provider of ["TAVILY", "ANTHROPIC"]) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.vars.MASTER_ENCRYPTION_KEY_V1, "base64url"), iv);
	cipher.setAAD(Buffer.from(`coffee-chat-agent|${owner}|API_KEY|${provider}`));
	const encrypted = Buffer.concat([cipher.update("FAKE-LOCAL-CONTACTS-KEY-NOT-VALID"), cipher.final(), cipher.getAuthTag()]);
	statements.push(
		`INSERT INTO encrypted_credentials(id,user_id,kind,provider,ciphertext,iv,key_version,key_hint,created_at,updated_at) VALUES('contacts-review-${provider}','${owner}','API_KEY','${provider}','${encrypted.toString("base64url")}','${iv.toString("base64url")}','1','fake',${sql(now)},${sql(now)});`,
	);
}
const seed = join(preview, "contacts-seed.sql");
await writeFile(seed, `${statements.join("\n")}\n`);
run(join(root, "node_modules", "wrangler", "bin", "wrangler.js"), [
	"d1", "execute", "onboarding-review", "--config", join(preview, "wrangler.jsonc"),
	"--local", "--persist-to", receipt.state, "--file", seed,
]);
console.log(`Seeded contacts review: ${config.vars.APP_ORIGIN}/__review/existing`);
console.log("Start with npm run preview:onboarding. External actions and real credentials are blocked.");
