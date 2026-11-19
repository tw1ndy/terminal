ALTER TABLE reward_purchases ADD COLUMN telegram_update_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_purchases_update_id
  ON reward_purchases(telegram_update_id) WHERE telegram_update_id IS NOT NULL;

ALTER TABLE rewards ADD COLUMN telegram_update_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_telegram_update_id
  ON rewards(telegram_update_id) WHERE telegram_update_id IS NOT NULL;

ALTER TABLE penalties ADD COLUMN telegram_update_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_penalties_telegram_update_id
  ON penalties(telegram_update_id) WHERE telegram_update_id IS NOT NULL;
