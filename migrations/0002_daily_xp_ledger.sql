CREATE TABLE daily_xp_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  reward_day TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (telegram_id, reward_day, source_type, source_key)
);
CREATE INDEX idx_daily_xp_user_day ON daily_xp_ledger(telegram_id, reward_day);
