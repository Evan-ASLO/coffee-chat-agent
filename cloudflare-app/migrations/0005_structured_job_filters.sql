PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN industry TEXT;
ALTER TABLE jobs ADD COLUMN duration_min_months INTEGER;
ALTER TABLE jobs ADD COLUMN duration_max_months INTEGER;
ALTER TABLE jobs ADD COLUMN duration_options_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN term_season TEXT;
ALTER TABLE jobs ADD COLUMN term_year INTEGER;

ALTER TABLE job_import_stage ADD COLUMN industry TEXT;
ALTER TABLE job_import_stage ADD COLUMN duration_min_months INTEGER;
ALTER TABLE job_import_stage ADD COLUMN duration_max_months INTEGER;
ALTER TABLE job_import_stage ADD COLUMN duration_options_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_import_stage ADD COLUMN term_season TEXT;
ALTER TABLE job_import_stage ADD COLUMN term_year INTEGER;

CREATE INDEX jobs_active_industry_idx
  ON jobs(is_active, industry, id);
CREATE INDEX jobs_active_duration_idx
  ON jobs(is_active, duration_min_months, duration_max_months, id);
CREATE INDEX jobs_active_term_idx
  ON jobs(is_active, term_year, term_season, id);

CREATE UNIQUE INDEX prospects_user_source_url_unique
  ON prospects(user_id, source_url)
  WHERE source_url <> '';
