import { z } from "zod";
import type { AppBindings } from "../types";
import {
	AuthenticationError,
	ClientInputError,
	ConflictError,
	PayloadTooLargeError,
} from "./errors";
import { bufferSource, safeEqual, utf8 } from "./encoding";
import {
	JOB_INDUSTRIES,
	JOB_TERM_SEASONS,
	deriveJobClassification,
	formatDurationMonths,
	formatJobTerm,
	type JobIndustry,
	type JobTermSeason,
} from "./job-classification";
import {
	deriveJobDiscoveryCriteria,
	type JobDiscoveryCriteria,
} from "./job-discovery";

export const MAX_JOB_INGEST_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_JOBS = 1000;
export const INGEST_REPLAY_WINDOW_SECONDS = 300;
export const JOB_CATALOG_STALE_SECONDS = 2 * 60 * 60;

export const JOB_STATES = [
	"SAVED",
	"APPLIED",
	"INTERVIEWING",
	"REJECTED",
	"OFFER",
	"ARCHIVED",
] as const;

export type JobState = (typeof JOB_STATES)[number];

const isoUtc = z
	.string()
	.max(40)
	.refine(
		(value) => value.endsWith("Z") && Number.isFinite(Date.parse(value)),
		"Use an ISO-8601 UTC timestamp.",
	);
const lowercaseSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonBlank = (maximum: number) =>
	z
		.string()
		.min(1)
		.max(maximum)
		.refine((value) => value.trim() === value, "Values must not have outer whitespace.");
const httpUrl = z
	.string()
	.max(2048)
	.url()
	.refine((value) => {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	}, "Use an absolute HTTP or HTTPS URL.");

export const normalizedJobSchema = z
	.object({
		id: lowercaseSha256,
		externalId: z.string().min(1).max(240).nullable(),
		source: nonBlank(80),
		company: nonBlank(200),
		title: nonBlank(240),
		location: z.string().max(240),
		region: z.string().max(120),
		categories: z
			.array(nonBlank(80))
			.max(24)
			.refine(
				(values) => new Set(values).size === values.length,
				"Job categories must be unique.",
			),
		url: httpUrl,
		postedAt: isoUtc.nullable(),
		postedText: z.string().max(240).nullable(),
		description: z.string().max(12000).nullable(),
	})
	.strict();

export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

export const jobSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		generatedAt: isoUtc,
		snapshotHash: lowercaseSha256,
		jobs: z
			.array(normalizedJobSchema)
			.min(1)
			.max(MAX_SNAPSHOT_JOBS)
			.refine(
				(jobs) => new Set(jobs.map((job) => job.id)).size === jobs.length,
				"Job IDs must be unique within a snapshot.",
			),
	})
	.strict();

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

const legacyJobReferenceSchema = z
	.object({
		url: httpUrl.nullable(),
		company: nonBlank(200),
		title: nonBlank(240),
	})
	.strict();

export const legacyJobImportSchema = z
	.object({
		schemaVersion: z.literal(1),
		exportedAt: isoUtc,
		source: z.literal("internship-tracker-toronto"),
		savedJobs: z.array(legacyJobReferenceSchema).max(500),
		applications: z
			.array(
				legacyJobReferenceSchema
					.extend({
						status: z.enum(["applied", "interview", "offer", "rejected"]),
					})
					.strict(),
			)
			.max(500),
	})
	.strict()
	.refine(
		(value) => value.savedJobs.length + value.applications.length <= 500,
		"Legacy imports are limited to 500 total jobs.",
	);

export type LegacyJobImport = z.infer<typeof legacyJobImportSchema>;

export const jobListQuerySchema = z
	.object({
		q: z.string().trim().max(100).default(""),
		company: z.string().trim().max(200).default(""),
		location: z.string().trim().max(240).default(""),
		region: z.string().trim().max(120).default(""),
		category: z.string().trim().max(80).default(""),
		industry: z.union([z.literal(""), z.enum(JOB_INDUSTRIES)]).default(""),
		length: z
			.union([
				z.literal(""),
				z.literal("UNSPECIFIED"),
				z.coerce.number().int().min(1).max(24),
			])
			.default(""),
		term: z
			.union([
				z.literal(""),
				z.literal("UNSPECIFIED"),
				z.string().regex(/^(WINTER|SPRING|SUMMER|FALL)-20\d{2}$/),
			])
			.default(""),
		posted: z.enum(["", "24h", "7d", "30d", "UNAVAILABLE"]).default(""),
		page: z.coerce.number().int().min(1).max(100).default(1),
		pageSize: z.coerce.number().int().min(1).max(50).default(24),
	})
	.strict();

export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobStateInputSchema = z
	.object({
		status: z.enum(JOB_STATES),
		notes: z.string().trim().max(4000).default(""),
	})
	.strict();

export interface JobUserState {
	status: JobState;
	notes: string;
	updatedAt: string;
}

export interface OutreachSummary {
	total: number;
	draftReady: number;
	sent: number;
	replied: number;
}

export interface JobRecord extends NormalizedJob {
	industry: JobIndustry | null;
	lengthMonths: number[];
	lengthLabel: string | null;
	term: {
		season: JobTermSeason;
		year: number;
		label: string;
	} | null;
	discoveryCriteria: JobDiscoveryCriteria;
	active: boolean;
	firstSeenAt: string;
	lastSeenAt: string;
	deactivatedAt: string | null;
	userState: JobUserState | null;
	outreachSummary: OutreachSummary | null;
}

interface JobRow {
	id: string;
	external_id: string | null;
	source: string;
	company: string;
	title: string;
	location: string;
	region: string;
	categories_json: string;
	url: string;
	posted_at: string | null;
	posted_text: string | null;
	description: string | null;
	industry: JobIndustry | null;
	duration_min_months: number | null;
	duration_max_months: number | null;
	duration_options_json: string;
	term_season: JobTermSeason | null;
	term_year: number | null;
	is_active: number;
	first_seen_at: string;
	last_seen_at: string;
	deactivated_at: string | null;
	user_status: JobState | null;
	user_notes: string | null;
	user_updated_at: string | null;
	outreach_total: number | null;
	outreach_draft_ready: number | null;
	outreach_sent: number | null;
	outreach_replied: number | null;
}

export interface JobFacetOption<T extends string | number> {
	value: T;
	label: string;
	count: number;
}

export interface JobFacets {
	industries: JobFacetOption<JobIndustry>[];
	lengths: JobFacetOption<number | "UNSPECIFIED">[];
	terms: JobFacetOption<string>[];
}

interface VerifiedSnapshot {
	payload: JobSnapshot;
	contentHash: string;
}

interface ExistingImportRun {
	id: string;
	status: string;
	generated_epoch: number;
	job_count: number;
	upserted_count: number;
	deactivated_count: number;
}

interface CatalogImportState {
	latest_import_run_id: string | null;
	snapshot_hash: string | null;
	generated_at: string | null;
	generated_epoch: number | null;
	run_status: string | null;
	applied_at: string | null;
	job_count: number | null;
	upserted_count: number | null;
	deactivated_count: number | null;
}

export interface JobIngestResult {
	importRunId: string;
	snapshotHash: string;
	idempotent: boolean;
	activeCount: number;
	upsertedCount: number;
	deactivatedCount: number;
}

export interface JobCatalogFreshness {
	state: "never-imported" | "fresh" | "stale";
	generatedAt: string | null;
	importedAt: string | null;
	ageSeconds: number | null;
	staleAfterSeconds: number;
}

export interface LegacyUnmatchedReference {
	kind: "saved" | "application";
	index: number;
	url: string | null;
	company: string;
	title: string;
	status?: "applied" | "interview" | "offer" | "rejected";
}

export interface LegacyJobImportResult {
	completed: boolean;
	idempotent: boolean;
	imported: number;
	matched: number;
	unmatched: number;
	skippedExisting: number;
	unmatchedReferences: LegacyUnmatchedReference[];
}

interface LegacyReference extends LegacyUnmatchedReference {
	key: string;
	canonicalUrl: string | null;
	identityKey: string;
	companyNormalized: string;
	titleNormalized: string;
}

interface LegacyImportRow {
	request_hash: string;
	matched_count: number;
	imported_count: number;
	skipped_existing_count: number;
	unmatched_json: string;
}

export async function verifyJobSnapshotRequest(
	env: AppBindings,
	request: Request,
): Promise<VerifiedSnapshot> {
	if (!env.JOBS_INGEST_SECRET) {
		throw new Error("JOBS_INGEST_SECRET is not configured.");
	}
	const contentType = request.headers
		.get("Content-Type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (contentType !== "application/json") {
		throw new ClientInputError("Content-Type must be application/json.");
	}
	const timestampHeader = request.headers.get("X-Ingest-Timestamp") || "";
	const signature = request.headers.get("X-Ingest-Signature") || "";
	if (!/^\d{1,13}$/.test(timestampHeader) || !/^[a-f0-9]{64}$/.test(signature)) {
		throw new AuthenticationError("Ingest authentication headers are invalid.");
	}
	const timestampSeconds = Number(timestampHeader);
	if (
		!Number.isSafeInteger(timestampSeconds) ||
		Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) >
			INGEST_REPLAY_WINDOW_SECONDS
	) {
		throw new AuthenticationError("Ingest timestamp is outside the replay window.");
	}

	const rawBytes = await readBoundedBody(request, MAX_JOB_INGEST_BYTES);
	const signedBytes = concatBytes(utf8(`${timestampHeader}.`), rawBytes);
	const expectedSignature = await hmacSha256Hex(
		env.JOBS_INGEST_SECRET,
		signedBytes,
	);
	if (!safeEqual(signature, expectedSignature)) {
		throw new AuthenticationError("Ingest signature validation failed.");
	}

	let rawBody: string;
	try {
		rawBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
	} catch {
		throw new ClientInputError("Request body must be valid UTF-8 JSON.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		throw new ClientInputError("Request body must be valid JSON.");
	}
	const payload = jobSnapshotSchema.parse(parsed);
	const contentHash = await snapshotHash(payload.jobs);
	if (!safeEqual(payload.snapshotHash, contentHash)) {
		throw new ClientInputError(
			"snapshotHash does not match the canonical normalized jobs.",
		);
	}

	const now = new Date();
	const signatureHash = await sha256Hex(signature);
	const replayExpiresAt = new Date(
		(timestampSeconds + INGEST_REPLAY_WINDOW_SECONDS + 1) * 1000,
	).toISOString();
	const replayResults = await env.DB.batch([
		env.DB.prepare("DELETE FROM job_ingest_replays WHERE expires_at < ?").bind(
			now.toISOString(),
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO job_ingest_replays(
			   signature_hash, received_at, expires_at
			 ) VALUES (?, ?, ?)`,
		).bind(
			signatureHash,
			now.toISOString(),
			replayExpiresAt,
		),
	]);
	if (replayResults[1]?.meta.changes !== 1) {
		throw new ConflictError("This signed ingest request has already been used.");
	}
	return { payload, contentHash };
}

export async function ingestJobSnapshot(
	env: AppBindings,
	verified: VerifiedSnapshot,
): Promise<JobIngestResult> {
	const { payload, contentHash } = verified;
	const generatedEpoch = Date.parse(payload.generatedAt);
	const catalog = await getCatalogImportState(env);
	if (
		catalog.generated_epoch !== null &&
		generatedEpoch < catalog.generated_epoch
	) {
		throw new ConflictError(
			"A newer job snapshot is already active.",
		);
	}
	if (
		catalog.generated_epoch !== null &&
		generatedEpoch === catalog.generated_epoch
	) {
		if (
			catalog.snapshot_hash === payload.snapshotHash &&
			catalog.run_status === "APPLIED"
		) {
			return activeCatalogResult(payload.snapshotHash, catalog);
		}
		throw new ConflictError(
			"A different snapshot with this generatedAt is already active.",
		);
	}

	const existing = await findImportRun(
		env,
		payload.snapshotHash,
		generatedEpoch,
	);
	if (existing) {
		return resolveExistingImportRun(env, payload.snapshotHash, existing);
	}

	const runId = crypto.randomUUID();
	const receivedAt = new Date().toISOString();
	try {
		await env.DB.prepare(
			`INSERT INTO job_import_runs(
			   id, schema_version, snapshot_hash, content_hash, generated_at,
			   generated_epoch, received_at, status, job_count
			 ) VALUES (?, 1, ?, ?, ?, ?, ?, 'STAGING', ?)`,
		)
			.bind(
				runId,
				payload.snapshotHash,
				contentHash,
				payload.generatedAt,
				generatedEpoch,
				receivedAt,
				payload.jobs.length,
			)
			.run();
	} catch (error) {
		const raced = await findImportRun(
			env,
			payload.snapshotHash,
			generatedEpoch,
		);
		if (raced) {
			return resolveExistingImportRun(env, payload.snapshotHash, raced);
		}
		throw error;
	}

	try {
		for (let index = 0; index < payload.jobs.length; index += 100) {
			const statements = payload.jobs
				.slice(index, index + 100)
				.map((job) => {
					const derived = deriveJobClassification(job);
					return env.DB.prepare(
						`INSERT INTO job_import_stage(
						   import_run_id, job_id, external_id, source, company,
						   company_normalized, title, title_normalized, location,
						   region, categories_json, url, canonical_url, posted_at,
						   posted_text, description, industry, duration_min_months,
						   duration_max_months, duration_options_json, term_season,
						   term_year
						 ) VALUES (
						   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
						   ?, ?, ?, ?, ?, ?
						 )`,
					).bind(
						runId,
						job.id,
						job.externalId,
						job.source,
						job.company,
						normalizeIdentity(job.company),
						job.title,
						normalizeIdentity(job.title),
						job.location,
						job.region,
						JSON.stringify(job.categories),
						job.url,
						canonicalizeJobUrl(job.url),
						job.postedAt,
						job.postedText,
						job.description,
						derived.industry,
						derived.durationMinMonths,
						derived.durationMaxMonths,
						JSON.stringify(derived.durationMonths),
						derived.termSeason,
						derived.termYear,
					);
				});
			await env.DB.batch(statements);
		}

		const deactivationCandidate = await env.DB.prepare(
			`SELECT COUNT(*) AS count
			   FROM jobs j
			  WHERE j.is_active = 1
			    AND NOT EXISTS (
			      SELECT 1 FROM job_import_stage s
			       WHERE s.import_run_id = ? AND s.job_id = j.id
			    )`,
		)
			.bind(runId)
			.first<{ count: number }>();
		const deactivatedCount = Number(deactivationCandidate?.count || 0);
		const appliedAt = new Date().toISOString();
		const results = await env.DB.batch([
			env.DB.prepare(
				`UPDATE job_catalog_state
				    SET latest_import_run_id = ?, snapshot_hash = ?,
				        generated_at = ?, generated_epoch = ?, updated_at = ?
				  WHERE singleton = 1
				    AND (generated_epoch IS NULL OR generated_epoch < ?)`,
			).bind(
				runId,
				payload.snapshotHash,
				payload.generatedAt,
				generatedEpoch,
				appliedAt,
				generatedEpoch,
			),
			env.DB.prepare(
				`INSERT INTO jobs(
				   id, external_id, source, company, company_normalized, title,
				   title_normalized, location, region, categories_json, url,
				   canonical_url, posted_at, posted_text, description, industry,
				   duration_min_months, duration_max_months,
				   duration_options_json, term_season, term_year, is_active,
				   first_seen_at, last_seen_at, deactivated_at,
				   latest_import_run_id, created_at, updated_at
				 )
				 SELECT s.job_id, s.external_id, s.source, s.company,
				        s.company_normalized, s.title, s.title_normalized,
				        s.location, s.region, s.categories_json, s.url,
				        s.canonical_url, s.posted_at, s.posted_text, s.description,
				        s.industry, s.duration_min_months,
				        s.duration_max_months, s.duration_options_json,
				        s.term_season, s.term_year, 1, ?, ?, NULL, ?, ?, ?
				   FROM job_import_stage s
				  WHERE s.import_run_id = ?
				    AND EXISTS (
				      SELECT 1 FROM job_catalog_state
				       WHERE singleton = 1 AND latest_import_run_id = ?
				    )
				  ON CONFLICT(id) DO UPDATE SET
				    external_id = excluded.external_id,
				    source = excluded.source,
				    company = excluded.company,
				    company_normalized = excluded.company_normalized,
				    title = excluded.title,
				    title_normalized = excluded.title_normalized,
				    location = excluded.location,
				    region = excluded.region,
				    categories_json = excluded.categories_json,
				    url = excluded.url,
				    canonical_url = excluded.canonical_url,
				    posted_at = excluded.posted_at,
				    posted_text = excluded.posted_text,
				    description = excluded.description,
				    industry = excluded.industry,
				    duration_min_months = excluded.duration_min_months,
				    duration_max_months = excluded.duration_max_months,
				    duration_options_json = excluded.duration_options_json,
				    term_season = excluded.term_season,
				    term_year = excluded.term_year,
				    is_active = 1,
				    last_seen_at = excluded.last_seen_at,
				    deactivated_at = NULL,
				    latest_import_run_id = excluded.latest_import_run_id,
				    updated_at = excluded.updated_at`,
			).bind(
				appliedAt,
				appliedAt,
				runId,
				appliedAt,
				appliedAt,
				runId,
				runId,
			),
			env.DB.prepare(
				`UPDATE jobs
				    SET is_active = 0, deactivated_at = ?, updated_at = ?
				  WHERE is_active = 1
				    AND NOT EXISTS (
				      SELECT 1 FROM job_import_stage s
				       WHERE s.import_run_id = ? AND s.job_id = jobs.id
				    )
				    AND EXISTS (
				      SELECT 1 FROM job_catalog_state
				       WHERE singleton = 1 AND latest_import_run_id = ?
				    )`,
			).bind(appliedAt, appliedAt, runId, runId),
			env.DB.prepare(
				`UPDATE job_import_runs
				    SET status = 'APPLIED', applied_at = ?,
				        upserted_count = ?, deactivated_count = ?
				  WHERE id = ?
				    AND EXISTS (
				      SELECT 1 FROM job_catalog_state
				       WHERE singleton = 1 AND latest_import_run_id = ?
				    )`,
			).bind(
				appliedAt,
				payload.jobs.length,
				deactivatedCount,
				runId,
				runId,
			),
		]);
		if (results[0]?.meta.changes !== 1) {
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE job_import_runs
					    SET status = 'REJECTED_STALE', error_code = 'STALE_SNAPSHOT'
					  WHERE id = ?`,
				).bind(runId),
				env.DB.prepare(
					"DELETE FROM job_import_stage WHERE import_run_id = ?",
				).bind(runId),
			]);
			throw new ConflictError(
				"A newer or equal-dated job snapshot is already active.",
			);
		}
		await env.DB.prepare(
			"DELETE FROM job_import_stage WHERE import_run_id = ?",
		)
			.bind(runId)
			.run();
		return {
			importRunId: runId,
			snapshotHash: payload.snapshotHash,
			idempotent: false,
			activeCount: payload.jobs.length,
			upsertedCount: payload.jobs.length,
			deactivatedCount,
		};
	} catch (error) {
		if (!(error instanceof ConflictError)) {
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE job_import_runs
					    SET status = 'FAILED', error_code = 'IMPORT_FAILED'
					  WHERE id = ? AND status = 'STAGING'`,
				).bind(runId),
				env.DB.prepare(
					"DELETE FROM job_import_stage WHERE import_run_id = ?",
				).bind(runId),
			]);
		}
		throw error;
	}
}

export async function listJobs(
	env: AppBindings,
	query: JobListQuery,
	userId?: string,
): Promise<{
	jobs: JobRecord[];
	pagination: { page: number; pageSize: number; total: number; totalPages: number };
	catalog: JobCatalogFreshness;
	facets: JobFacets;
}> {
	const now = Date.now();
	const filter = buildJobFilter(query, now);
	const selection = jobSelection(userId);
	const offset = (query.page - 1) * query.pageSize;
	const [result, count, catalog, facets] = await Promise.all([
		env.DB.prepare(
			`${selection.sql}
			  WHERE ${filter.clause}
			  ORDER BY COALESCE(j.posted_at, j.last_seen_at) DESC, j.id
			  LIMIT ? OFFSET ?`,
		)
			.bind(
				...selection.bindings,
				...filter.bindings,
				query.pageSize,
				offset,
			)
			.all<JobRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM jobs j WHERE ${filter.clause}`,
		)
			.bind(...filter.bindings)
			.first<{ count: number }>(),
		getCatalogFreshness(env),
		getJobFacets(env, query, now),
	]);
	const total = Number(count?.count || 0);
	return {
		jobs: result.results.map(mapJob),
		pagination: {
			page: query.page,
			pageSize: query.pageSize,
			total,
			totalPages: Math.ceil(total / query.pageSize),
		},
		catalog,
		facets,
	};
}

async function getJobFacets(
	env: AppBindings,
	query: JobListQuery,
	now: number,
): Promise<JobFacets> {
	const industryFilter = buildJobFilter(query, now, "industry");
	const lengthFilter = buildJobFilter(query, now, "length");
	const termFilter = buildJobFilter(query, now, "term");
	const [
		industryRows,
		lengthRows,
		unspecifiedLength,
		termRows,
		unspecifiedTerm,
	] = await Promise.all([
		env.DB.prepare(
			`SELECT j.industry AS value, COUNT(*) AS count
			   FROM jobs j
			  WHERE ${industryFilter.clause} AND j.industry IS NOT NULL
			  GROUP BY j.industry
			  ORDER BY j.industry`,
		)
			.bind(...industryFilter.bindings)
			.all<{ value: JobIndustry; count: number }>(),
		env.DB.prepare(
			`SELECT CAST(d.value AS INTEGER) AS value,
			        COUNT(DISTINCT j.id) AS count
			   FROM jobs j
			   JOIN json_each(j.duration_options_json) d
			  WHERE ${lengthFilter.clause}
			  GROUP BY CAST(d.value AS INTEGER)
			  ORDER BY CAST(d.value AS INTEGER)`,
		)
			.bind(...lengthFilter.bindings)
			.all<{ value: number; count: number }>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM jobs j
			  WHERE ${lengthFilter.clause}
			    AND json_array_length(j.duration_options_json) = 0`,
		)
			.bind(...lengthFilter.bindings)
			.first<{ count: number }>(),
		env.DB.prepare(
			`SELECT j.term_season, j.term_year, COUNT(*) AS count
			   FROM jobs j
			  WHERE ${termFilter.clause}
			    AND j.term_season IS NOT NULL AND j.term_year IS NOT NULL
			  GROUP BY j.term_season, j.term_year
			  ORDER BY j.term_year, CASE j.term_season
			    WHEN 'WINTER' THEN 1
			    WHEN 'SPRING' THEN 2
			    WHEN 'SUMMER' THEN 3
			    ELSE 4 END`,
		)
			.bind(...termFilter.bindings)
			.all<{
				term_season: JobTermSeason;
				term_year: number;
				count: number;
			}>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM jobs j
			  WHERE ${termFilter.clause}
			    AND (j.term_season IS NULL OR j.term_year IS NULL)`,
		)
			.bind(...termFilter.bindings)
			.first<{ count: number }>(),
	]);

	const lengths: JobFacetOption<number | "UNSPECIFIED">[] =
		lengthRows.results.map((row) => ({
			value: Number(row.value),
			label: `${row.value} months`,
			count: Number(row.count),
		}));
	if (Number(unspecifiedLength?.count || 0) > 0) {
		lengths.push({
			value: "UNSPECIFIED",
			label: "Unspecified",
			count: Number(unspecifiedLength!.count),
		});
	}
	const terms: JobFacetOption<string>[] = termRows.results.map((row) => ({
		value: `${row.term_season}-${row.term_year}`,
		label: formatJobTerm(row.term_season, row.term_year),
		count: Number(row.count),
	}));
	if (Number(unspecifiedTerm?.count || 0) > 0) {
		terms.push({
			value: "UNSPECIFIED",
			label: "Unspecified",
			count: Number(unspecifiedTerm!.count),
		});
	}
	return {
		industries: industryRows.results.map((row) => ({
			value: row.value,
			label: row.value,
			count: Number(row.count),
		})),
		lengths,
		terms,
	};
}

export async function getCatalogFreshness(
	env: AppBindings,
	now = Date.now(),
): Promise<JobCatalogFreshness> {
	const catalog = await getCatalogImportState(env);
	if (
		!catalog.latest_import_run_id ||
		!catalog.generated_at ||
		catalog.run_status !== "APPLIED"
	) {
		return {
			state: "never-imported",
			generatedAt: null,
			importedAt: null,
			ageSeconds: null,
			staleAfterSeconds: JOB_CATALOG_STALE_SECONDS,
		};
	}
	const generatedTime = Date.parse(catalog.generated_at);
	if (!Number.isFinite(generatedTime)) {
		return {
			state: "never-imported",
			generatedAt: null,
			importedAt: catalog.applied_at,
			ageSeconds: null,
			staleAfterSeconds: JOB_CATALOG_STALE_SECONDS,
		};
	}
	const ageSeconds = Math.max(0, Math.floor((now - generatedTime) / 1000));
	return {
		state:
			ageSeconds > JOB_CATALOG_STALE_SECONDS
				? "stale"
				: "fresh",
		generatedAt: catalog.generated_at,
		importedAt: catalog.applied_at,
		ageSeconds,
		staleAfterSeconds: JOB_CATALOG_STALE_SECONDS,
	};
}

export async function getJob(
	env: AppBindings,
	jobId: string,
	userId?: string,
	includeInactive = false,
): Promise<JobRecord | null> {
	const selection = jobSelection(userId);
	const row = await env.DB.prepare(
		`${selection.sql}
		  WHERE j.id = ? ${includeInactive ? "" : "AND j.is_active = 1"}`,
	)
		.bind(...selection.bindings, jobId)
		.first<JobRow>();
	return row ? mapJob(row) : null;
}

export async function listUserJobStates(
	env: AppBindings,
	userId: string,
	input: {
		statuses?: JobState[];
		page: number;
		pageSize: number;
	},
): Promise<{
	jobs: JobRecord[];
	pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
	const selection = jobSelection(userId);
	const where = ["ujs.user_id = ?"];
	const bindings: unknown[] = [userId];
	if (input.statuses?.length) {
		where.push(`ujs.status IN (${input.statuses.map(() => "?").join(", ")})`);
		bindings.push(...input.statuses);
	}
	const clause = where.join(" AND ");
	const offset = (input.page - 1) * input.pageSize;
	const [result, count] = await Promise.all([
		env.DB.prepare(
			`${selection.sql}
			  WHERE ${clause}
			  ORDER BY ujs.updated_at DESC, j.id
			  LIMIT ? OFFSET ?`,
		)
			.bind(
				...selection.bindings,
				...bindings,
				input.pageSize,
				offset,
			)
			.all<JobRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM user_job_states ujs WHERE ${clause}`,
		)
			.bind(...bindings)
			.first<{ count: number }>(),
	]);
	const total = Number(count?.count || 0);
	return {
		jobs: result.results.map(mapJob),
		pagination: {
			page: input.page,
			pageSize: input.pageSize,
			total,
			totalPages: Math.ceil(total / input.pageSize),
		},
	};
}

export async function putJobState(
	env: AppBindings,
	userId: string,
	jobId: string,
	input: { status: JobState; notes: string },
): Promise<JobRecord> {
	const now = new Date().toISOString();
	const result = await env.DB.prepare(
		`INSERT INTO user_job_states(
		   user_id, job_id, status, notes, created_at, updated_at
		 )
		 SELECT ?, id, ?, ?, ?, ? FROM jobs WHERE id = ?
		 ON CONFLICT(user_id, job_id) DO UPDATE SET
		   status = excluded.status,
		   notes = excluded.notes,
		   updated_at = excluded.updated_at`,
	)
		.bind(userId, input.status, input.notes, now, now, jobId)
		.run();
	if (result.meta.changes !== 1) {
		throw new ClientInputError("Job was not found.");
	}
	const job = await getJob(env, jobId, userId, true);
	if (!job) throw new ClientInputError("Job was not found.");
	return job;
}

export async function deleteJobState(
	env: AppBindings,
	userId: string,
	jobId: string,
): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM user_job_states WHERE user_id = ? AND job_id = ?",
	)
		.bind(userId, jobId)
		.run();
}

export async function importLegacyJobState(
	env: AppBindings,
	userId: string,
	payload: LegacyJobImport,
): Promise<LegacyJobImportResult> {
	const requestHash = await sha256Hex(canonicalJson(payload));
	const existing = await getLegacyImport(env, userId);
	if (existing) {
		if (existing.request_hash === requestHash) {
			return legacyImportResultFromRow(existing, true);
		}
		throw new ConflictError("Legacy job state has already been imported.");
	}

	const references = legacyReferences(payload);
	const matches = await resolveLegacyReferences(env, references);
	const resolved = new Map<string, JobState>();
	const unmatchedReferences: LegacyUnmatchedReference[] = [];
	for (const reference of references) {
		const jobId = matches.get(reference.key);
		if (!jobId) {
			unmatchedReferences.push(toUnmatchedReference(reference));
			continue;
		}
		if (reference.kind === "saved") {
			if (!resolved.has(jobId)) resolved.set(jobId, "SAVED");
		} else {
			resolved.set(jobId, applicationStatus(reference.status!));
		}
	}
	if (!resolved.size) {
		return {
			completed: false,
			idempotent: false,
			imported: 0,
			matched: 0,
			unmatched: unmatchedReferences.length,
			skippedExisting: 0,
			unmatchedReferences,
		};
	}

	const importedAt = new Date().toISOString();
	const serializedStates = JSON.stringify(
		Array.from(resolved, ([jobId, status]) => ({ jobId, status })),
	);
	const unmatchedJson = JSON.stringify(unmatchedReferences);
	let results: D1Result<unknown>[];
	try {
		results = await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO user_job_states(
				   user_id, job_id, status, notes, created_at, updated_at
				 )
				 SELECT ?, json_extract(value, '$.jobId'),
				        json_extract(value, '$.status'), '', ?, ?
				   FROM json_each(?)
				  WHERE 1
				 ON CONFLICT(user_id, job_id) DO NOTHING`,
			).bind(userId, importedAt, importedAt, serializedStates),
			env.DB.prepare(
				`INSERT INTO user_job_legacy_imports(
				   user_id, schema_version, source, exported_at, imported_at,
				   saved_count, application_count, request_hash, matched_count,
				   imported_count, skipped_existing_count, unmatched_json
				 ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, changes(), ? - changes(), ?)`,
			).bind(
				userId,
				payload.source,
				payload.exportedAt,
				importedAt,
				payload.savedJobs.length,
				payload.applications.length,
				requestHash,
				resolved.size,
				resolved.size,
				unmatchedJson,
			),
		]);
	} catch (error) {
		const raced = await getLegacyImport(env, userId);
		if (raced) {
			if (raced.request_hash === requestHash) {
				return legacyImportResultFromRow(raced, true);
			}
			throw new ConflictError("Legacy job state has already been imported.");
		}
		throw error;
	}
	const imported = Number(results[0]?.meta.changes || 0);
	return {
		completed: true,
		idempotent: false,
		imported,
		matched: resolved.size,
		unmatched: unmatchedReferences.length,
		skippedExisting: resolved.size - imported,
		unmatchedReferences,
	};
}

export async function linkProspectToJob(
	env: AppBindings,
	userId: string,
	jobId: string,
	prospectId: string,
): Promise<void> {
	const result = await env.DB.prepare(
		`INSERT OR IGNORE INTO job_prospects(user_id, job_id, prospect_id, created_at)
		 SELECT ?, j.id, p.id, ?
		   FROM jobs j
		   JOIN prospects p ON p.id = ? AND p.user_id = ?
		  WHERE j.id = ?`,
	)
		.bind(userId, new Date().toISOString(), prospectId, userId, jobId)
		.run();
	if (result.meta.changes === 1) return;
	const existing = await env.DB.prepare(
		`SELECT 1 AS found FROM job_prospects
		  WHERE user_id = ? AND job_id = ? AND prospect_id = ?`,
	)
		.bind(userId, jobId, prospectId)
		.first<{ found: number }>();
	if (!existing) {
		throw new ClientInputError("Job or prospect was not found.");
	}
}

export async function linkProspectsToJob(
	env: AppBindings,
	userId: string,
	jobId: string,
	prospectIds: string[],
): Promise<void> {
	for (const prospectId of prospectIds) {
		await linkProspectToJob(env, userId, jobId, prospectId);
	}
}

export async function unlinkProspectFromJob(
	env: AppBindings,
	userId: string,
	jobId: string,
	prospectId: string,
): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM job_prospects
		  WHERE user_id = ? AND job_id = ? AND prospect_id = ?`,
	)
		.bind(userId, jobId, prospectId)
		.run();
}

export async function prospectJobLinks(
	env: AppBindings,
	userId: string,
): Promise<Map<string, Array<{ id: string; title: string; company: string }>>> {
	const result = await env.DB.prepare(
		`SELECT jp.prospect_id, j.id, j.title, j.company
		   FROM job_prospects jp
		   JOIN jobs j ON j.id = jp.job_id
		   JOIN prospects p ON p.id = jp.prospect_id AND p.user_id = jp.user_id
		  WHERE jp.user_id = ?
		  ORDER BY jp.created_at DESC`,
	)
		.bind(userId)
		.all<{
			prospect_id: string;
			id: string;
			title: string;
			company: string;
		}>();
	const links = new Map<
		string,
		Array<{ id: string; title: string; company: string }>
	>();
	for (const row of result.results) {
		const current = links.get(row.prospect_id) ?? [];
		current.push({ id: row.id, title: row.title, company: row.company });
		links.set(row.prospect_id, current);
	}
	return links;
}

export async function snapshotHash(jobs: NormalizedJob[]): Promise<string> {
	return sha256Hex(
		canonicalJson([...jobs].sort((left, right) => left.id.localeCompare(right.id))),
	);
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

export function canonicalizeJobUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	url.hostname = url.hostname.toLowerCase();
	if (
		(url.protocol === "https:" && url.port === "443") ||
		(url.protocol === "http:" && url.port === "80")
	) {
		url.port = "";
	}
	const ignored = new Set([
		"fbclid",
		"gclid",
		"mc_cid",
		"mc_eid",
	]);
	const entries = Array.from(url.searchParams.entries())
		.filter(([key]) => !key.toLowerCase().startsWith("utm_"))
		.filter(([key]) => !ignored.has(key.toLowerCase()))
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);
	url.search = "";
	for (const [key, entryValue] of entries) {
		url.searchParams.append(key, entryValue);
	}
	if (url.pathname !== "/") {
		url.pathname = url.pathname.replace(/\/+$/, "");
	}
	return url.toString();
}

export function normalizeIdentity(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export async function sha256Hex(
	value: string | Uint8Array,
): Promise<string> {
	const bytes = typeof value === "string" ? utf8(value) : value;
	return bytesToHex(
		await crypto.subtle.digest("SHA-256", bufferSource(bytes)),
	);
}

export async function hmacSha256Hex(
	secret: string,
	value: string | Uint8Array,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		bufferSource(utf8(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = typeof value === "string" ? utf8(value) : value;
	return bytesToHex(
		await crypto.subtle.sign("HMAC", key, bufferSource(bytes)),
	);
}

function jobSelection(userId?: string): {
	sql: string;
	bindings: unknown[];
} {
	if (!userId) {
		return {
			sql: `SELECT j.*,
			             NULL AS user_status,
			             NULL AS user_notes,
			             NULL AS user_updated_at,
			             NULL AS outreach_total,
			             NULL AS outreach_draft_ready,
			             NULL AS outreach_sent,
			             NULL AS outreach_replied
			        FROM jobs j`,
			bindings: [],
		};
	}

	return {
		sql: `SELECT j.*,
		             ujs.status AS user_status,
		             ujs.notes AS user_notes,
		             ujs.updated_at AS user_updated_at,
		             COALESCE(outreach.total, 0) AS outreach_total,
		             COALESCE(outreach.draft_ready, 0) AS outreach_draft_ready,
		             COALESCE(outreach.sent, 0) AS outreach_sent,
		             COALESCE(outreach.replied, 0) AS outreach_replied
		        FROM jobs j
		        LEFT JOIN user_job_states ujs
		          ON ujs.job_id = j.id AND ujs.user_id = ?
		        LEFT JOIN (
		          SELECT jp.job_id,
		                 COUNT(*) AS total,
		                 SUM(CASE WHEN p.status = 'DRAFT_READY' THEN 1 ELSE 0 END)
		                   AS draft_ready,
		                 SUM(CASE WHEN p.status IN ('SENDING', 'SENT', 'REPLIED')
		                          THEN 1 ELSE 0 END) AS sent,
		                 SUM(CASE WHEN p.status = 'REPLIED' THEN 1 ELSE 0 END)
		                   AS replied
		            FROM job_prospects jp
		            JOIN prospects p
		              ON p.id = jp.prospect_id AND p.user_id = jp.user_id
		           WHERE jp.user_id = ?
		           GROUP BY jp.job_id
		        ) outreach ON outreach.job_id = j.id`,
		bindings: [userId, userId],
	};
}

async function getCatalogImportState(
	env: AppBindings,
): Promise<CatalogImportState> {
	const state = await env.DB.prepare(
		`SELECT s.latest_import_run_id, s.snapshot_hash, s.generated_at,
		        s.generated_epoch, r.status AS run_status, r.applied_at,
		        r.job_count, r.upserted_count,
		        r.deactivated_count
		   FROM job_catalog_state s
		   LEFT JOIN job_import_runs r ON r.id = s.latest_import_run_id
		  WHERE s.singleton = 1`,
	).first<CatalogImportState>();
	return {
		latest_import_run_id: state?.latest_import_run_id ?? null,
		snapshot_hash: state?.snapshot_hash ?? null,
		generated_at: state?.generated_at ?? null,
		generated_epoch: state?.generated_epoch ?? null,
		run_status: state?.run_status ?? null,
		applied_at: state?.applied_at ?? null,
		job_count: state?.job_count ?? null,
		upserted_count: state?.upserted_count ?? null,
		deactivated_count: state?.deactivated_count ?? null,
	};
}

async function findImportRun(
	env: AppBindings,
	snapshotHashValue: string,
	generatedEpoch: number,
): Promise<ExistingImportRun | null> {
	return env.DB.prepare(
		`SELECT id, status, generated_epoch, job_count, upserted_count,
		        deactivated_count
		   FROM job_import_runs
		  WHERE snapshot_hash = ? AND generated_epoch = ?`,
	)
		.bind(snapshotHashValue, generatedEpoch)
		.first<ExistingImportRun>();
}

async function resolveExistingImportRun(
	env: AppBindings,
	snapshotHashValue: string,
	existing: ExistingImportRun,
): Promise<JobIngestResult> {
	const catalog = await getCatalogImportState(env);
	if (
		catalog.latest_import_run_id === existing.id &&
		catalog.snapshot_hash === snapshotHashValue &&
		catalog.run_status === "APPLIED"
	) {
		return activeCatalogResult(snapshotHashValue, catalog);
	}
	if (existing.status === "STAGING") {
		throw new ConflictError("This snapshot is already being processed.");
	}
	throw new ConflictError(
		"This exact snapshot is historical and is not the active catalog.",
	);
}

function activeCatalogResult(
	snapshotHashValue: string,
	catalog: CatalogImportState,
): JobIngestResult {
	if (!catalog.latest_import_run_id || catalog.run_status !== "APPLIED") {
		throw new ConflictError("The active job catalog is not ready.");
	}
	return {
		importRunId: catalog.latest_import_run_id,
		snapshotHash: snapshotHashValue,
		idempotent: true,
		activeCount: Number(catalog.job_count || 0),
		upsertedCount: Number(catalog.upserted_count || 0),
		deactivatedCount: Number(catalog.deactivated_count || 0),
	};
}

function reliablePostedAt(value: string | null): string | null {
	if (!value) return null;
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,19}))?Z$/.exec(value);
	if (!match) return null;
	const normalized = `${match[1]}.${(match[2] || "").slice(0, 3).padEnd(3, "0")}Z`;
	const timestamp = Date.parse(normalized);
	if (!Number.isFinite(timestamp) || timestamp > Date.now()) return null;
	const canonical = new Date(timestamp).toISOString();
	return normalized === canonical ? canonical : null;
}

function mapJob(row: JobRow): JobRecord {
	let categories: string[] = [];
	let lengthMonths: number[] = [];
	try {
		const parsed = JSON.parse(row.categories_json);
		if (Array.isArray(parsed)) {
			categories = parsed.filter(
				(value): value is string => typeof value === "string",
			);
		}
	} catch {
		categories = [];
	}
	try {
		const parsed = JSON.parse(row.duration_options_json);
		if (Array.isArray(parsed)) {
			lengthMonths = Array.from(
				new Set(
					parsed.filter(
						(value): value is number =>
							Number.isInteger(value) && value >= 1 && value <= 24,
					),
				),
			).sort((left, right) => left - right);
		}
	} catch {
		lengthMonths = [];
	}
	const hasPrivateData = row.user_status !== null || row.outreach_total !== null;
	return {
		id: row.id,
		externalId: row.external_id,
		source: row.source,
		company: row.company,
		title: row.title,
		location: row.location,
		region: row.region,
		categories,
		url: row.url,
		postedAt: reliablePostedAt(row.posted_at),
		postedText: row.posted_text,
		description: row.description,
		industry: row.industry,
		lengthMonths,
		lengthLabel: formatDurationMonths(lengthMonths),
		term:
			row.term_season && row.term_year
				? {
						season: row.term_season,
						year: row.term_year,
						label: formatJobTerm(row.term_season, row.term_year),
					}
				: null,
		discoveryCriteria: deriveJobDiscoveryCriteria({
			company: row.company,
			title: row.title,
			location: row.location,
			region: row.region,
			industry: row.industry,
		}),
		active: row.is_active === 1,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		deactivatedAt: row.deactivated_at,
		userState: row.user_status
			? {
					status: row.user_status,
					notes: row.user_notes || "",
					updatedAt: row.user_updated_at || "",
				}
			: null,
		outreachSummary: hasPrivateData
			? {
					total: Number(row.outreach_total || 0),
					draftReady: Number(row.outreach_draft_ready || 0),
					sent: Number(row.outreach_sent || 0),
					replied: Number(row.outreach_replied || 0),
				}
			: null,
	};
}

async function getLegacyImport(
	env: AppBindings,
	userId: string,
): Promise<LegacyImportRow | null> {
	return env.DB.prepare(
		`SELECT request_hash, matched_count, imported_count,
		        skipped_existing_count, unmatched_json
		   FROM user_job_legacy_imports WHERE user_id = ?`,
	)
		.bind(userId)
		.first<LegacyImportRow>();
}

function legacyImportResultFromRow(
	row: LegacyImportRow,
	idempotent: boolean,
): LegacyJobImportResult {
	let unmatchedReferences: LegacyUnmatchedReference[] = [];
	try {
		const parsed = JSON.parse(row.unmatched_json);
		if (Array.isArray(parsed)) {
			unmatchedReferences = parsed.filter(isLegacyUnmatchedReference);
		}
	} catch {
		unmatchedReferences = [];
	}
	return {
		completed: true,
		idempotent,
		imported: row.imported_count,
		matched: row.matched_count,
		unmatched: unmatchedReferences.length,
		skippedExisting: row.skipped_existing_count,
		unmatchedReferences,
	};
}

function legacyReferences(payload: LegacyJobImport): LegacyReference[] {
	const saved = payload.savedJobs.map((reference, index) =>
		makeLegacyReference("saved", index, reference),
	);
	const applications = payload.applications.map((reference, index) =>
		makeLegacyReference("application", index, reference),
	);
	return [...saved, ...applications];
}

function makeLegacyReference(
	kind: "saved" | "application",
	index: number,
	reference: LegacyJobImport["savedJobs"][number] |
		LegacyJobImport["applications"][number],
): LegacyReference {
	const companyNormalized = normalizeIdentity(reference.company);
	const titleNormalized = normalizeIdentity(reference.title);
	return {
		kind,
		index,
		url: reference.url,
		company: reference.company,
		title: reference.title,
		...("status" in reference ? { status: reference.status } : {}),
		key: `${kind}:${index}`,
		canonicalUrl: reference.url ? canonicalizeJobUrl(reference.url) : null,
		identityKey: `${companyNormalized}\u0000${titleNormalized}`,
		companyNormalized,
		titleNormalized,
	};
}

async function resolveLegacyReferences(
	env: AppBindings,
	references: LegacyReference[],
): Promise<Map<string, string>> {
	const matches = new Map<string, string>();
	const urls = Array.from(
		new Set(
			references
				.map((reference) => reference.canonicalUrl)
				.filter((value): value is string => Boolean(value)),
		),
	);
	const jobsByUrl = new Map<string, string>();
	for (const urlChunk of chunkValues(urls, 80)) {
		const result = await env.DB.prepare(
			`SELECT canonical_url, id FROM jobs
			  WHERE canonical_url IN (${urlChunk.map(() => "?").join(", ")})
			  ORDER BY is_active DESC, last_seen_at DESC, id`,
		)
			.bind(...urlChunk)
			.all<{ canonical_url: string; id: string }>();
		for (const row of result.results) {
			if (!jobsByUrl.has(row.canonical_url)) {
				jobsByUrl.set(row.canonical_url, row.id);
			}
		}
	}
	for (const reference of references) {
		if (!reference.canonicalUrl) continue;
		const jobId = jobsByUrl.get(reference.canonicalUrl);
		if (jobId) matches.set(reference.key, jobId);
	}

	const identities = new Map<
		string,
		{ companyNormalized: string; titleNormalized: string }
	>();
	for (const reference of references) {
		if (matches.has(reference.key)) continue;
		identities.set(reference.identityKey, {
			companyNormalized: reference.companyNormalized,
			titleNormalized: reference.titleNormalized,
		});
	}
	const jobsByIdentity = new Map<string, string>();
	for (const identityChunk of chunkValues([...identities.entries()], 40)) {
		const clauses = identityChunk.map(
			() => "(company_normalized = ? AND title_normalized = ?)",
		);
		const bindings = identityChunk.flatMap(([, identity]) => [
			identity.companyNormalized,
			identity.titleNormalized,
		]);
		const result = await env.DB.prepare(
			`SELECT company_normalized, title_normalized, id FROM jobs
			  WHERE ${clauses.join(" OR ")}
			  ORDER BY is_active DESC, last_seen_at DESC, id`,
		)
			.bind(...bindings)
			.all<{
				company_normalized: string;
				title_normalized: string;
				id: string;
			}>();
		for (const row of result.results) {
			const identityKey =
				`${row.company_normalized}\u0000${row.title_normalized}`;
			if (!jobsByIdentity.has(identityKey)) {
				jobsByIdentity.set(identityKey, row.id);
			}
		}
	}
	for (const reference of references) {
		if (matches.has(reference.key)) continue;
		const jobId = jobsByIdentity.get(reference.identityKey);
		if (jobId) matches.set(reference.key, jobId);
	}
	return matches;
}

function toUnmatchedReference(
	reference: LegacyReference,
): LegacyUnmatchedReference {
	return {
		kind: reference.kind,
		index: reference.index,
		url: reference.url,
		company: reference.company,
		title: reference.title,
		...(reference.status ? { status: reference.status } : {}),
	};
}

function applicationStatus(
	status: "applied" | "interview" | "offer" | "rejected",
): JobState {
	return {
		applied: "APPLIED",
		interview: "INTERVIEWING",
		offer: "OFFER",
		rejected: "REJECTED",
	}[status] as JobState;
}

function isLegacyUnmatchedReference(
	value: unknown,
): value is LegacyUnmatchedReference {
	if (!value || typeof value !== "object") return false;
	const reference = value as Partial<LegacyUnmatchedReference>;
	return (
		(reference.kind === "saved" || reference.kind === "application") &&
		typeof reference.index === "number" &&
		(reference.url === null || typeof reference.url === "string") &&
		typeof reference.company === "string" &&
		typeof reference.title === "string"
	);
}

function chunkValues<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function buildJobFilter(
	query: JobListQuery,
	now: number,
	omit?: "industry" | "length" | "term",
): { clause: string; bindings: unknown[] } {
	const where = ["j.is_active = 1"];
	const bindings: unknown[] = [];
	if (query.q) {
		const value = containsPattern(query.q);
		where.push(
			`(
			  j.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR
			  j.company LIKE ? ESCAPE '\\' COLLATE NOCASE OR
			  j.location LIKE ? ESCAPE '\\' COLLATE NOCASE OR
			  j.region LIKE ? ESCAPE '\\' COLLATE NOCASE OR
			  COALESCE(j.description, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
			)`,
		);
		bindings.push(value, value, value, value, value);
	}
	addExactFilter(where, bindings, "j.company", query.company);
	addExactFilter(where, bindings, "j.location", query.location);
	addExactFilter(where, bindings, "j.region", query.region);
	if (query.category) {
		where.push("j.categories_json LIKE ? ESCAPE '\\' COLLATE NOCASE");
		bindings.push(`%\"${escapeLike(query.category)}\"%`);
	}
	if (omit !== "industry" && query.industry) {
		where.push("j.industry = ?");
		bindings.push(query.industry);
	}
	if (omit !== "length" && query.length !== "") {
		if (query.length === "UNSPECIFIED") {
			where.push("json_array_length(j.duration_options_json) = 0");
		} else {
			where.push(
				`EXISTS (
				  SELECT 1 FROM json_each(j.duration_options_json) duration
				   WHERE CAST(duration.value AS INTEGER) = ?
				)`,
			);
			bindings.push(query.length);
		}
	}
	if (omit !== "term" && query.term) {
		if (query.term === "UNSPECIFIED") {
			where.push("(j.term_season IS NULL OR j.term_year IS NULL)");
		} else {
			const [season, year] = query.term.split("-");
			where.push("j.term_season = ? AND j.term_year = ?");
			bindings.push(season, Number(year));
		}
	}
	if (query.posted) {
		// Match JS millisecond precision before SQLite can round longer fractions or parse invalid calendars.
		const normalized = `(CASE
			WHEN length(j.posted_at)=20 AND substr(j.posted_at,20,1)='Z'
				THEN substr(j.posted_at,1,19)||'.000Z'
			WHEN length(j.posted_at) BETWEEN 22 AND 40 AND substr(j.posted_at,20,1)='.'
				AND substr(j.posted_at,-1)='Z'
				AND substr(j.posted_at,21,length(j.posted_at)-21) NOT GLOB '*[^0-9]*'
				THEN substr(j.posted_at,1,19)||'.'||substr(substr(j.posted_at,21,length(j.posted_at)-21)||'000',1,3)||'Z'
			ELSE NULL END)`;
		const reliable = `COALESCE((
			strftime('%Y-%m-%dT%H:%M:%fZ', ${normalized}) = ${normalized}
			AND substr(${normalized}, 12, 2) BETWEEN '00' AND '23'
			AND julianday(${normalized}) <= julianday(?)
		), 0)`;
		where.push(query.posted === "UNAVAILABLE" ? `NOT (${reliable})` : reliable);
		bindings.push(new Date(now).toISOString());
		if (query.posted !== "UNAVAILABLE") {
			const hours = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 }[query.posted];
			where.push(`julianday(${normalized}) >= julianday(?)`);
			bindings.push(new Date(now - hours * 60 * 60 * 1000).toISOString());
		}
	}
	return { clause: where.join(" AND "), bindings };
}

function addExactFilter(
	where: string[],
	bindings: unknown[],
	column: string,
	value: string,
): void {
	if (!value) return;
	where.push(`${column} = ? COLLATE NOCASE`);
	bindings.push(value);
}

function containsPattern(value: string): string {
	return `%${escapeLike(value)}%`;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array> {
	const contentLength = Number(request.headers.get("Content-Length") || 0);
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new PayloadTooLargeError(
			`Job snapshots must be ${maxBytes} bytes or smaller.`,
		);
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new PayloadTooLargeError(
				`Job snapshots must be ${maxBytes} bytes or smaller.`,
			);
		}
		chunks.push(value);
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const output = new Uint8Array(left.byteLength + right.byteLength);
	output.set(left, 0);
	output.set(right, left.byteLength);
	return output;
}

function bytesToHex(value: ArrayBuffer): string {
	return Array.from(new Uint8Array(value), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
