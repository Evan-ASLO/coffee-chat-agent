CREATE TABLE encrypted_credentials_apollo (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('OAUTH_REFRESH_TOKEN', 'API_KEY')),
  provider TEXT NOT NULL CHECK(provider IN ('GOOGLE', 'TAVILY', 'HUNTER', 'APOLLO', 'GEMINI', 'OPENAI', 'ANTHROPIC')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, kind, provider)
);
INSERT INTO encrypted_credentials_apollo
  (id, user_id, kind, provider, ciphertext, iv, key_version, key_hint, metadata_json, created_at, updated_at)
SELECT id, user_id, kind, provider, ciphertext, iv, key_version, key_hint, metadata_json, created_at, updated_at
FROM encrypted_credentials;
DROP TABLE encrypted_credentials;
ALTER TABLE encrypted_credentials_apollo RENAME TO encrypted_credentials;
CREATE INDEX encrypted_credentials_user_idx ON encrypted_credentials(user_id);

ALTER TABLE prospects ADD COLUMN preparation_json TEXT NOT NULL
  DEFAULT '{"version":1,"email":null,"research":null}' CHECK(json_valid(preparation_json));
