PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE encrypted_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('OAUTH_REFRESH_TOKEN', 'API_KEY')),
  provider TEXT NOT NULL CHECK(provider IN ('GOOGLE', 'TAVILY', 'HUNTER', 'GEMINI', 'OPENAI', 'ANTHROPIC')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, kind, provider)
);
CREATE INDEX encrypted_credentials_user_idx ON encrypted_credentials(user_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL DEFAULT '',
  discovery_provider TEXT NOT NULL DEFAULT 'TAVILY',
  enrichment_provider TEXT NOT NULL DEFAULT 'HUNTER',
  draft_provider TEXT NOT NULL DEFAULT 'TEMPLATE',
  gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
  openai_model TEXT NOT NULL DEFAULT 'gpt-5-mini',
  anthropic_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
  outreach_goal TEXT NOT NULL DEFAULT 'Learn from the recipient''s professional experience.',
  email_word_limit INTEGER NOT NULL DEFAULT 140 CHECK(email_word_limit BETWEEN 60 AND 250),
  personal_context_json TEXT NOT NULL DEFAULT '[]',
  spreadsheet_id TEXT,
  reply_sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK(reply_sync_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prospects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK(status IN ('DISCOVERED', 'PREPARING', 'DRAFT_READY', 'SENDING', 'SENT', 'REPLIED', 'REJECTED', 'ERROR')),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  company_domain TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  email_confidence INTEGER NOT NULL DEFAULT 0 CHECK(email_confidence BETWEEN 0 AND 100),
  discovery_provider TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  source_snippet TEXT NOT NULL DEFAULT '',
  why_relevant TEXT NOT NULL DEFAULT '',
  outreach_objective TEXT NOT NULL DEFAULT '',
  relevance_score INTEGER NOT NULL DEFAULT 0 CHECK(relevance_score BETWEEN 0 AND 100),
  subject TEXT NOT NULL DEFAULT '',
  draft_body TEXT NOT NULL DEFAULT '',
  personalization_notes TEXT NOT NULL DEFAULT '',
  draft_provider TEXT NOT NULL DEFAULT '',
  draft_model TEXT NOT NULL DEFAULT '',
  draft_version INTEGER NOT NULL DEFAULT 0,
  draft_hash TEXT NOT NULL DEFAULT '',
  contact_approved_at TEXT,
  draft_approved_at TEXT,
  sent_at TEXT,
  last_reply_at TEXT,
  reply_from TEXT NOT NULL DEFAULT '',
  reply_snippet TEXT NOT NULL DEFAULT '',
  gmail_thread_id TEXT NOT NULL DEFAULT '',
  gmail_message_id TEXT NOT NULL DEFAULT '',
  sheet_row INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX prospects_user_status_idx ON prospects(user_id, status);
CREATE INDEX prospects_sent_idx ON prospects(user_id, sent_at);
CREATE UNIQUE INDEX prospects_user_linkedin_unique
  ON prospects(user_id, linkedin_url)
  WHERE linkedin_url <> '';

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_user_created_idx ON audit_events(user_id, created_at);
CREATE INDEX audit_events_request_idx ON audit_events(request_id);

CREATE TABLE rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id, action, window_start)
);
CREATE INDEX rate_limits_expires_idx ON rate_limits(expires_at);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STARTED' CHECK(status IN ('STARTED', 'COMPLETED', 'FAILED', 'UNCERTAIN')),
  response_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, operation, idempotency_key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);
