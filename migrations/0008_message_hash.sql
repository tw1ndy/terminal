ALTER TABLE message_events ADD COLUMN message_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_message_events_hash_time
  ON message_events(message_hash, created_at);
