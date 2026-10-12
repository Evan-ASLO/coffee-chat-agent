CREATE TABLE private_jobs (
  id TEXT PRIMARY KEY CHECK(id LIKE 'manual-%'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  identity_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SAVED','APPLIED','INTERVIEWING','OFFER','REJECTED','ARCHIVED')),
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  creation_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(user_id,id)
);
CREATE UNIQUE INDEX private_jobs_owner_identity ON private_jobs(user_id,identity_key) WHERE deleted_at IS NULL;
CREATE INDEX private_jobs_owner_status ON private_jobs(user_id,deleted_at,status,updated_at DESC,id);
CREATE TABLE private_job_prospects (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  prospect_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,job_id,prospect_id),
  FOREIGN KEY(user_id,job_id) REFERENCES private_jobs(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,prospect_id) REFERENCES prospects(user_id,id) ON DELETE CASCADE
);
CREATE VIEW account_job_states AS
  SELECT user_id,job_id,status,notes,created_at,updated_at FROM user_job_states
  UNION ALL SELECT user_id,id,status,notes,created_at,updated_at FROM private_jobs WHERE deleted_at IS NULL;
CREATE TRIGGER private_jobs_account_deleted AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM private_jobs WHERE user_id=NEW.id; END;
