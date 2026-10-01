PRAGMA foreign_keys = ON;

CREATE TABLE beta_access (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('APPROVED', 'REVOKED')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX beta_access_status_updated_idx
  ON beta_access(status, updated_at DESC);

CREATE TABLE beta_access_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN (
    'PENDING',
    'APPROVED',
    'DENIED'
  )),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX beta_access_requests_pending_email_unique
  ON beta_access_requests(email)
  WHERE status = 'PENDING';
CREATE UNIQUE INDEX beta_access_requests_pending_google_sub_unique
  ON beta_access_requests(google_sub)
  WHERE status = 'PENDING';
CREATE INDEX beta_access_requests_status_updated_idx
  ON beta_access_requests(status, updated_at DESC);
