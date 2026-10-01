PRAGMA foreign_keys = ON;

CREATE TABLE user_resumes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type IN (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  )),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 16),
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_resume_chunks (
  user_id TEXT NOT NULL REFERENCES user_resumes(user_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 15),
  ciphertext TEXT NOT NULL,
  PRIMARY KEY(user_id, chunk_index)
);
