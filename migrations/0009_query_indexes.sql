CREATE INDEX IF NOT EXISTS idx_message_events_user_hash_time
  ON message_events(telegram_id, message_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_transactions_period_type_user
  ON xp_transactions(created_at, transaction_type, telegram_id);
CREATE INDEX IF NOT EXISTS idx_anti_fraud_pending_time
  ON anti_fraud_events(reviewed_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_status_time
  ON reward_purchases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_penalties_pending_time
  ON penalties(status, created_at DESC);
