ALTER TABLE beta_access ADD COLUMN approval_revision TEXT;

CREATE TABLE beta_acceptance_notifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES beta_access(email) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','SENDING','SENT','FAILED','UNCERTAIN','CANCELLED')),
  failure_code TEXT,
  gmail_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(email, grant_revision)
);
CREATE INDEX beta_acceptance_status ON beta_acceptance_notifications(status, created_at);

CREATE TRIGGER beta_access_legacy_revision AFTER UPDATE ON beta_access WHEN NEW.approval_revision IS OLD.approval_revision AND (NEW.status != OLD.status OR NEW.updated_at != OLD.updated_at) BEGIN UPDATE beta_access SET approval_revision=NULL WHERE email=NEW.email; END;
CREATE TRIGGER beta_acceptance_sender_deleted AFTER UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN UPDATE beta_acceptance_notifications SET status=CASE WHEN status='SENDING' THEN 'UNCERTAIN' ELSE 'CANCELLED' END,failure_code='SENDER_UNAVAILABLE',updated_at=NEW.deleted_at WHERE sender_user_id=NEW.id AND status IN ('QUEUED','SENDING','FAILED'); END;
