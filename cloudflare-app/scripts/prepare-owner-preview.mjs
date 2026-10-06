import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, ".tutorial-preview");
const env = { ...process.env, TUTORIAL_PREVIEW_PORT: "8806", WRANGLER_SEND_METRICS: "false" };
function run(file, args = []) {
	const result = spawnSync(process.execPath, [file, ...args], { cwd: root, env, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Local owner fixture preparation failed:\n${result.stdout}\n${result.stderr}`);
}

// The existing preparer refuses an occupied port or an existing D1 state.
run(join(root, "scripts", "prepare-onboarding-preview.mjs"));
const config = JSON.parse(await readFile(join(preview, "wrangler.jsonc"), "utf8"));
config.name = "owner-activity-local-review";
config.main = "../test/local-owner-preview.ts";
delete config.vars.LOCAL_TUTORIAL_PREVIEW;
config.vars.LOCAL_OWNER_PREVIEW = "true";
config.vars.BETA_ADMIN_EMAILS = "owner-activity@example.test";
config.assets.run_worker_first = true;
await writeFile(join(preview, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
const receipt = JSON.parse(await readFile(join(preview, "receipt.json"), "utf8"));
const owner = "10000000-0000-4000-8000-000000000808";
const member = "10000000-0000-4000-8000-000000000809";
const now = new Date().toISOString();
const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const statements = [
	`UPDATE users SET google_sub='local-owner-primary',email='owner-activity@example.test',name='Fictional Owner',created_at=${sql(old)} WHERE id='${owner}';`,
	`UPDATE user_settings SET reply_sync_enabled=0,enrichment_provider='NONE',people_search_fallback_provider='NONE' WHERE user_id='${owner}';`,
];
const users = [[member, "member-activity@example.test", "Fictional Member"]];
for (let index = 1; index <= 22; index++) {
	users.push([randomUUID(), `fictional-account-${String(index).padStart(2, "0")}@example.test`, `Fictional Account ${index}`]);
}
for (const [id, email, name] of users) {
	statements.push(
		`INSERT INTO users(id,google_sub,email,name,created_at,updated_at,onboarding_status) VALUES('${id}','local-owner-${id}','${email}','${name}',${sql(old)},${sql(now)},'legacy');`,
		`INSERT INTO user_settings(user_id,sender_name,reply_sync_enabled,created_at,updated_at) VALUES('${id}','${name}',0,${sql(now)},${sql(now)});`,
		`INSERT INTO beta_access(email,status,created_at,updated_at) VALUES('${email}','APPROVED',${sql(now)},${sql(now)});`,
	);
}
const actions = ["DISCOVERY_COMPLETED", "JOB_STATE_UPDATED", "DRAFT_PREPARED", "DRAFT_EDITED", "EMAIL_SENT", "SETTINGS_UPDATED"];
for (let index = 0; index < 70; index++) {
	const userId = index % 3 === 0 ? owner : users[index % 10][0];
	const at = new Date(Date.now() - (index % 33) * 86_400_000 - index * 1000).toISOString();
	const metadata = {
		status: index % 2 === 0 ? "SAVED" : "APPLIED",
		fallbackStatus: index % 12 === 0 ? "SEARCH_LIMITED" : "SUCCESS",
		fallbackProvider: "ANTHROPIC",
		fallbackReason: index % 12 === 0 ? "max_uses_exceeded" : null,
		privateText: "FICTIONAL-PRIVATE-CANARY-NOT-FOR-OWNER-RESPONSE",
	};
	statements.push(
		`INSERT INTO audit_events(id,user_id,action,entity_type,entity_id,request_id,metadata_json,created_at) VALUES('${randomUUID()}','${userId}','${actions[index % actions.length]}','fixture','fictional-private-entity','fictional-review',${sql(JSON.stringify(metadata))},${sql(at)});`,
	);
}
for (let index = 1; index <= 5; index++) {
	statements.push(
		`INSERT INTO beta_access_requests(id,email,google_sub,status,requested_at,updated_at) VALUES('${randomUUID()}','fictional-pending-${index}@example.test','local-pending-${index}','PENDING',${sql(now)},${sql(now)});`,
	);
}
statements.push(
	`INSERT INTO beta_access(email,status,created_at,updated_at) VALUES('fictional-pending-2@example.test','REVOKED',${sql(old)},${sql(old)});`,
	`INSERT INTO beta_access_requests(id,email,google_sub,status,requested_at,updated_at) VALUES('${randomUUID()}','fictional-pending-3@example.test','','DENIED',${sql(old)},${sql(old)});`,
);
const seed = join(preview, "owner-seed.sql");
await writeFile(seed, `${statements.join("\n")}\n`);
run(join(root, "node_modules", "wrangler", "bin", "wrangler.js"), [
	"d1", "execute", "onboarding-review", "--config", join(preview, "wrangler.jsonc"),
	"--local", "--persist-to", receipt.state, "--file", seed,
]);
await writeFile(join(preview, "owner-receipt.json"), `${JSON.stringify({
	createdAt: now, port: 8806, accounts: 24, seededEvents: 70, pendingRequests: 5,
	externalActionsBlocked: true, productionEntryUnchanged: true,
	paths: ["/__review/owner", "/__review/member", "/__review/signed-out"],
}, null, 2)}\n`);
console.log("Fictional owner: http://127.0.0.1:8806/__review/owner#settings");
console.log("Fictional non-owner: http://127.0.0.1:8806/__review/member#settings");
console.log("Start with npm run preview:onboarding. Only local beta decisions and logout may mutate.");
