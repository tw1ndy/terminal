PRAGMA foreign_keys = ON;

CREATE TABLE users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE user_stats (
  telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  last_activity_day TEXT
);

CREATE TABLE xp_wallets (
  telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  lifetime_xp INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_xp >= 0),
  available_xp INTEGER NOT NULL DEFAULT 0 CHECK (available_xp >= 0),
  season_xp INTEGER NOT NULL DEFAULT 0 CHECK (season_xp >= 0)
);

CREATE TABLE xp_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  source_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  UNIQUE (telegram_id, transaction_type, source_id)
);

CREATE TABLE message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, message_id)
);

CREATE TABLE levels (
  level INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  required_xp INTEGER NOT NULL UNIQUE CHECK (required_xp >= 0)
);

CREATE TABLE achievements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT,
  rarity TEXT NOT NULL DEFAULT 'common',
  xp_bonus INTEGER NOT NULL DEFAULT 0,
  condition_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE user_achievements (
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  achievement_id TEXT NOT NULL REFERENCES achievements(id),
  earned_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_id, achievement_id)
);

CREATE TABLE daily_rewards (
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  reward_day TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  xp_amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_id, reward_day, reward_type)
);

CREATE TABLE activity_streaks (
  telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
  current_streak INTEGER NOT NULL DEFAULT 0,
  max_streak INTEGER NOT NULL DEFAULT 0,
  last_reward_day TEXT
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','active','closed'))
);

CREATE TABLE season_stats (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  season_xp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, telegram_id)
);

CREATE TABLE season_results (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  place INTEGER NOT NULL,
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, telegram_id)
);

CREATE TABLE rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  price_xp INTEGER NOT NULL CHECK (price_xp >= 0),
  quantity INTEGER,
  conditions TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reward_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  status TEXT NOT NULL CHECK (status IN ('new','review','approved','rejected','issued')),
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reward_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  price_xp INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (telegram_id, reward_id, created_at)
);

CREATE TABLE penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  suggested_amount INTEGER NOT NULL,
  approved_amount INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','reversed')),
  proposed_by TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE anti_fraud_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE admins (
  telegram_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','chief_admin','admin','moderator')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE INDEX idx_users_last_seen ON users(last_seen_at);
CREATE INDEX idx_xp_lifetime ON xp_wallets(lifetime_xp DESC);
CREATE INDEX idx_xp_season ON xp_wallets(season_xp DESC);
CREATE INDEX idx_xp_transactions_user_time ON xp_transactions(telegram_id, created_at DESC);
CREATE INDEX idx_message_events_user_day ON message_events(telegram_id, event_day);
CREATE INDEX idx_season_stats_rank ON season_stats(season_id, season_xp DESC);
CREATE INDEX idx_claims_status_time ON reward_claims(status, created_at);
CREATE INDEX idx_penalties_status_time ON penalties(status, created_at);
