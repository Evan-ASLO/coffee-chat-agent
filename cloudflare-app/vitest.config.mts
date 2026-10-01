import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationStatements = [
	"0001_initial.sql",
	"0002_user_resumes.sql",
	"0003_jobs_platform.sql",
	"0004_beta_access.sql",
	"0005_structured_job_filters.sql",
	"0006_prospect_match_quality.sql",
]
	.flatMap((fileName) =>
		readFileSync(resolve(`migrations/${fileName}`), "utf8")
			.replace(/\r/g, "")
			.split(/;\s*(?:\n|$)/)
			.map((statement) => statement.trim())
			.filter(
				(statement) =>
					statement && !statement.startsWith("PRAGMA foreign_keys"),
			),
	);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					GOOGLE_CLIENT_ID: "test-client",
					GOOGLE_CLIENT_SECRET: "test-secret",
					MASTER_ENCRYPTION_KEY_V1:
						"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
					SESSION_SIGNING_KEY:
						"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
					JOBS_INGEST_SECRET: "test-jobs-ingest-secret",
					MIGRATION_STATEMENTS: JSON.stringify(migrationStatements),
				},
				d1Databases: ["DB"],
			},
		}),
	],
});
