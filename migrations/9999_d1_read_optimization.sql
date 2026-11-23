-- Reduce D1 rows scanned by high-frequency webhook and scheduled queries.
-- Safe to apply to existing databases; no table data is modified.
CREATE INDEX IF NOT EXISTS idx_message_events_user_day_created
  ON message_events(telegram_id, event_day, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_events_user_hash_day_created
  ON message_events(telegram_id, message_hash, event_day, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_anti_fraud_user_type_created
  ON anti_fraud_events(telegram_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_processed_updates_processed_at
  ON processed_updates(processed_at);

CREATE INDEX IF NOT EXISTS idx_xp_transactions_created_at
  ON xp_transactions(created_at DESC);
