import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, ".tutorial-preview");
const receipt = JSON.parse(await readFile(join(preview, "receipt.json"), "utf8"));
const configPath = join(preview, "wrangler.jsonc");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (receipt.state !== join(root, ".d1") || config.vars.APP_ORIGIN !== `http://127.0.0.1:${receipt.port}` ||
	config.vars.LOCAL_CONTACTS_PREVIEW !== "true" ||
	!["../test/local-contacts-preview.ts", "../test/local-preparation-preview.ts"].includes(config.main) ||
	config.d1_databases?.[0]?.database_id !== "00000000-0000-4000-8000-000000000808") {
	throw new Error("Only the existing isolated fictional contacts review can be upgraded.");
}
await new Promise((done, reject) => {
	const probe = createServer();
	probe.once("error", reject);
	probe.listen(receipt.port, "127.0.0.1", () => probe.close(done));
});
function wrangler(...args) {
	const result = spawnSync(process.execPath, [
		join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args,
		"--config", configPath, "--local", "--persist-to", receipt.state,
	], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
	if (result.status !== 0) throw new Error(`Local preparation fixture failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}
await copyFile(join(root, "migrations", "0009_approved_preparation.sql"), join(preview, "migrations", "0009_approved_preparation.sql"));
const migration = wrangler("d1", "migrations", "apply", "onboarding-review");
config.main = "../test/local-preparation-preview.ts";
config.vars.LOCAL_PREPARATION_PREVIEW = "true";
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = new Date().toISOString();
const statements = [
	"CREATE TABLE IF NOT EXISTS local_preparation_review(user_id TEXT PRIMARY KEY, scenario TEXT NOT NULL DEFAULT 'success');",
	"CREATE TABLE IF NOT EXISTS local_preparation_calls(user_id TEXT NOT NULL,provider TEXT NOT NULL,created_at TEXT NOT NULL);",
];
for (const suffix of ["909", "910"]) {
	const userId = `10000000-0000-4000-8000-000000000${suffix}`;
	const personId = `30000000-0000-4000-8000-000000000${suffix}`;
	const name = suffix === "909" ? "Fictional Alex" : "Fictional Rowan";
	const email = `preparation-${suffix}@example.test`;
	const profile = `https://www.linkedin.com/in/fictional-preparation-${suffix}`;
	statements.push(
		`INSERT OR IGNORE INTO users(id,google_sub,email,name,image,created_at,updated_at,onboarding_status,onboarding_updated_at) VALUES('${userId}','local-preparation-${suffix}','${email}','Fictional preparation reviewer','','${now}','${now}','legacy','${now}');`,
		`INSERT OR IGNORE INTO beta_access(email,status,created_at,updated_at) VALUES('${email}','APPROVED','${now}','${now}');`,
		`INSERT OR IGNORE INTO user_settings(user_id,sender_name,enrichment_provider,draft_provider,people_search_fallback_provider,personal_context_json,reply_sync_enabled,created_at,updated_at) VALUES('${userId}','Fictional sender','APOLLO','OPENAI','NONE','[{"category":"Experience","content":"My coursework includes a genuine accessibility project."}]',0,'${now}','${now}');`,
		`INSERT OR IGNORE INTO local_preparation_review(user_id) VALUES('${userId}');`,
		`INSERT OR IGNORE INTO prospects(id,user_id,full_name,first_name,last_name,title,company,company_domain,location,discovery_provider,linkedin_url,source_url,source_snippet,match_quality,created_at,updated_at) VALUES('${personId}','${userId}',${sql(name)},'Fictional',${sql(name.split(" ")[1])},'Junior Software Engineer','Example Software Co','example-software-review.com','Toronto','TAVILY','${profile}','${profile}',${sql(`${name} is a Junior Software Engineer at Example Software Co, working on accessible developer tools.`)},'STRONG','${now}','${now}');`,
		`INSERT OR IGNORE INTO job_prospects(user_id,job_id,prospect_id,created_at) VALUES('${userId}','${"b".repeat(64)}','${personId}','${now}');`,
	);
	for (const provider of ["APOLLO", "TAVILY", "OPENAI"]) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.vars.MASTER_ENCRYPTION_KEY_V1, "base64url"), iv);
		cipher.setAAD(Buffer.from(`coffee-chat-agent|${userId}|API_KEY|${provider}`));
		const encrypted = Buffer.concat([cipher.update(`FAKE-PREPARATION-${provider}-${userId}`), cipher.final(), cipher.getAuthTag()]);
		statements.push(`INSERT OR IGNORE INTO encrypted_credentials(id,user_id,kind,provider,ciphertext,iv,key_version,key_hint,created_at,updated_at) VALUES('preparation-${suffix}-${provider}','${userId}','API_KEY','${provider}','${encrypted.toString("base64url")}','${iv.toString("base64url")}','1','fake','${now}','${now}');`);
	}
}
const seed = join(preview, "preparation-seed.sql");
await writeFile(seed, `${statements.join("\n")}\n`);
wrangler("d1", "execute", "onboarding-review", "--file", seed);
await writeFile(join(preview, "preparation-migration.log"), migration);
console.log(`Mock-only persisted preparation review ready to serve: ${config.vars.APP_ORIGIN}/__review/preparation`);
console.log("No real credentials, external provider calls or sends are enabled. Existing contacts fixtures were preserved.");
