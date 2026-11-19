CREATE TABLE IF NOT EXISTS member_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('prefix','achievement')),
  title TEXT NOT NULL,
  period_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (telegram_id, reward_type, period_key)
);
CREATE INDEX IF NOT EXISTS idx_member_rewards_user ON member_rewards(telegram_id, created_at DESC);
