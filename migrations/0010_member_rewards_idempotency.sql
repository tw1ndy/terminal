-- Monthly prefix/achievement records are awarded by a cron that runs repeatedly.
-- Keep one record per member, reward type, and calendar month.
DELETE FROM member_rewards
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM member_rewards
  GROUP BY telegram_id, reward_type, period_key
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_rewards_period_unique
  ON member_rewards(telegram_id, reward_type, period_key);
