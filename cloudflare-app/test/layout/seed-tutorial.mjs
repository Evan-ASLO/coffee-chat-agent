import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2];
const reviewState = path.resolve(import.meta.dirname, "..", "..", "..", ".d1");
const relative = output ? path.relative(reviewState, path.resolve(output)) : "";
if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
	throw new Error("Provide an SQL output path inside this checkout's .d1 directory.");
}
const timestamp = new Date().toISOString();
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const legacy = "10000000-0000-4000-8000-000000000808";
const statements = [
	"PRAGMA foreign_keys = ON;",
	`INSERT OR IGNORE INTO users (id,google_sub,email,name,created_at,updated_at,onboarding_status)
	 VALUES ('${legacy}','local-tutorial-existing','tutorial-existing@example.test',
	 'Fictional existing reviewer',${quote(timestamp)},${quote(timestamp)},'legacy');`,
	`INSERT OR IGNORE INTO user_settings (user_id,sender_name,personal_context_json,created_at,updated_at)
	 VALUES ('${legacy}','Fictional reviewer',
	 '[{"category":"Background summary","content":"Fictional local review context, not a real person."}]',
	 ${quote(timestamp)},${quote(timestamp)});`,
	`INSERT OR IGNORE INTO user_job_states (user_id,job_id,status,notes,created_at,updated_at)
	 SELECT '${legacy}',job_id,status,'Fictional local review next step.',created_at,updated_at
	 FROM user_job_states WHERE user_id='00000000-0000-4000-8000-000000000001'
	 AND status IN ('APPLIED','SAVED');`,
];
for (const choice of ["new", "existing", "second"]) {
	statements.push(`INSERT OR IGNORE INTO beta_access (email,status,created_at,updated_at)
	 VALUES ('tutorial-${choice}@example.test','APPROVED',${quote(timestamp)},${quote(timestamp)});`);
}
for (const [index, name, status, quality] of [
	[1, "Fictional Avery", "DISCOVERED", "BROADER_COMPANY"],
	[2, "Fictional Blair", "DRAFT_READY", "STRONG"],
	[3, "Fictional Casey", "SENT", "STRONG"],
]) {
	statements.push(`INSERT OR IGNORE INTO prospects
	 (id,user_id,status,full_name,first_name,title,company,location,discovery_provider,
	 source_url,source_snippet,why_relevant,match_quality,subject,draft_body,draft_provider,
	 draft_model,draft_version,personalization_notes,created_at,updated_at)
	 VALUES ('30000000-0000-4000-8000-00000000080${index}','${legacy}',${quote(status)},
	 ${quote(name)},${quote(name)},'Fictional reviewer','Example Research Co','Toronto','TAVILY',
	 'https://people.example.test/${index}','Fictional public profile, not a real contact.',
	 'Fictional local review match.',${quote(quality)},'Fictional review subject',
	 'Fictional review draft. Never send this fixture.','TEMPLATE','template',1,
	 'Fictional facts only.',${quote(timestamp)},${quote(timestamp)});`);
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, statements.join("\n") + "\n");
console.log(`Generated isolated synthetic tutorial fixtures: ${output}`);
