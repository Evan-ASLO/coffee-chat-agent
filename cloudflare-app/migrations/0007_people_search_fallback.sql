PRAGMA foreign_keys = ON;

ALTER TABLE user_settings
  ADD COLUMN people_search_fallback_provider TEXT NOT NULL DEFAULT 'NONE'
  CHECK(people_search_fallback_provider IN (
    'NONE',
    'GEMINI',
    'OPENAI',
    'ANTHROPIC'
  ));
