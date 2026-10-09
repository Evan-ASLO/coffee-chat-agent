CREATE TABLE bug_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 160),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 4000),
  page TEXT NOT NULL CHECK(page IN ('home','jobs','applications','networking','settings','analytics')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, submission_key)
);
CREATE INDEX bug_reports_status_created ON bug_reports(status, created_at DESC, id DESC);
CREATE INDEX bug_reports_user ON bug_reports(user_id);
CREATE TRIGGER bug_reports_account_deleted AFTER UPDATE OF deleted_at ON users
WHEN NEW.deleted_at IS NOT NULL
BEGIN DELETE FROM bug_reports WHERE user_id=NEW.id; END;
