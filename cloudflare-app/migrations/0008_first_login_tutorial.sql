ALTER TABLE users ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK(onboarding_status IN ('legacy', 'invited', 'in_progress', 'paused', 'completed', 'skipped'));
ALTER TABLE users ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'welcome'
  CHECK(length(onboarding_step) BETWEEN 1 AND 64);
ALTER TABLE users ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 1
  CHECK(onboarding_version > 0);
ALTER TABLE users ADD COLUMN onboarding_revision INTEGER NOT NULL DEFAULT 0
  CHECK(onboarding_revision >= 0);
ALTER TABLE users ADD COLUMN onboarding_updated_at TEXT;
