-- Idempotency marker for processing closed-season rewards, including disabled schedules.
CREATE TABLE IF NOT EXISTS season_reward_runs (
  season_id INTEGER PRIMARY KEY REFERENCES seasons(id),
  completed_at INTEGER NOT NULL
);
