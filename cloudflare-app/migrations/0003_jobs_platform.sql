PRAGMA foreign_keys = ON;

CREATE TABLE job_import_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  generated_at TEXT NOT NULL,
  generated_epoch INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  status TEXT NOT NULL DEFAULT 'STAGING' CHECK(status IN (
    'STAGING',
    'APPLIED',
    'REJECTED_STALE',
    'FAILED'
  )),
  job_count INTEGER NOT NULL CHECK(job_count BETWEEN 1 AND 1000),
  upserted_count INTEGER NOT NULL DEFAULT 0,
  deactivated_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX job_import_runs_generated_idx
  ON job_import_runs(generated_at DESC);
CREATE INDEX job_import_runs_status_idx
  ON job_import_runs(status, received_at DESC);
CREATE UNIQUE INDEX job_import_runs_snapshot_generated_unique
  ON job_import_runs(snapshot_hash, generated_epoch);

CREATE TABLE job_ingest_replays (
  signature_hash TEXT PRIMARY KEY CHECK(length(signature_hash) = 64),
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX job_ingest_replays_expires_idx
  ON job_ingest_replays(expires_at);

CREATE TABLE job_catalog_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  latest_import_run_id TEXT REFERENCES job_import_runs(id),
  snapshot_hash TEXT,
  generated_at TEXT,
  generated_epoch INTEGER,
  updated_at TEXT NOT NULL
);
INSERT INTO job_catalog_state(singleton, updated_at)
VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK(length(id) = 64),
  external_id TEXT,
  source TEXT NOT NULL,
  company TEXT NOT NULL,
  company_normalized TEXT NOT NULL,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  posted_at TEXT,
  posted_text TEXT,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deactivated_at TEXT,
  latest_import_run_id TEXT NOT NULL REFERENCES job_import_runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_active_posted_idx
  ON jobs(is_active, posted_at DESC, id);
CREATE INDEX jobs_active_company_idx
  ON jobs(is_active, company COLLATE NOCASE, id);
CREATE INDEX jobs_active_location_idx
  ON jobs(is_active, location COLLATE NOCASE, id);
CREATE INDEX jobs_active_region_idx
  ON jobs(is_active, region COLLATE NOCASE, id);
CREATE INDEX jobs_source_url_idx
  ON jobs(source, url);
CREATE INDEX jobs_canonical_url_idx
  ON jobs(canonical_url);
CREATE INDEX jobs_company_title_normalized_idx
  ON jobs(company_normalized, title_normalized);
CREATE UNIQUE INDEX jobs_source_external_unique
  ON jobs(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE job_import_stage (
  import_run_id TEXT NOT NULL REFERENCES job_import_runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL CHECK(length(job_id) = 64),
  external_id TEXT,
  source TEXT NOT NULL,
  company TEXT NOT NULL,
  company_normalized TEXT NOT NULL,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  posted_at TEXT,
  posted_text TEXT,
  description TEXT,
  PRIMARY KEY(import_run_id, job_id)
);
CREATE INDEX job_import_stage_run_idx
  ON job_import_stage(import_run_id);

CREATE TABLE user_job_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN (
    'SAVED',
    'APPLIED',
    'INTERVIEWING',
    'REJECTED',
    'OFFER',
    'ARCHIVED'
  )),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, job_id)
);
CREATE INDEX user_job_states_user_status_idx
  ON user_job_states(user_id, status, updated_at DESC);
CREATE INDEX user_job_states_job_idx
  ON user_job_states(job_id, user_id);

CREATE TABLE user_job_legacy_imports (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  source TEXT NOT NULL CHECK(source = 'internship-tracker-toronto'),
  exported_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  saved_count INTEGER NOT NULL,
  application_count INTEGER NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  matched_count INTEGER NOT NULL,
  imported_count INTEGER NOT NULL,
  skipped_existing_count INTEGER NOT NULL,
  unmatched_json TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX prospects_user_id_id_unique
  ON prospects(user_id, id);

CREATE TABLE job_prospects (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, job_id, prospect_id),
  FOREIGN KEY(user_id, prospect_id)
    REFERENCES prospects(user_id, id)
    ON DELETE CASCADE
);
CREATE INDEX job_prospects_user_prospect_idx
  ON job_prospects(user_id, prospect_id);
CREATE INDEX job_prospects_job_idx
  ON job_prospects(job_id, user_id);
