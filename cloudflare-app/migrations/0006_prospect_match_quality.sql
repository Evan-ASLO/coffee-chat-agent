PRAGMA foreign_keys = ON;

ALTER TABLE prospects
  ADD COLUMN match_quality TEXT NOT NULL DEFAULT 'STRONG'
  CHECK(match_quality IN ('STRONG', 'BROADER_COMPANY'));

CREATE INDEX prospects_user_match_quality_idx
  ON prospects(user_id, match_quality, updated_at DESC);
