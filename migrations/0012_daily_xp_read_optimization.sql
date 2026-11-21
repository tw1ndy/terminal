-- Cache the current day's XP total on the existing wallet row so each message
-- does not rescan all of that member's daily ledger entries.
ALTER TABLE xp_wallets ADD COLUMN daily_xp_day TEXT;
ALTER TABLE xp_wallets ADD COLUMN daily_xp_total INTEGER NOT NULL DEFAULT 0 CHECK (daily_xp_total >= 0);

-- Preserve the current Moscow day's cap when this migration is deployed mid-day.
UPDATE xp_wallets
SET daily_xp_day = date('now', '+3 hours'),
    daily_xp_total = (
      SELECT COALESCE(SUM(amount), 0)
      FROM daily_xp_ledger
      WHERE daily_xp_ledger.telegram_id = xp_wallets.telegram_id
        AND daily_xp_ledger.reward_day = date('now', '+3 hours')
    )
WHERE EXISTS (
  SELECT 1
  FROM daily_xp_ledger
  WHERE daily_xp_ledger.telegram_id = xp_wallets.telegram_id
    AND daily_xp_ledger.reward_day = date('now', '+3 hours')
);
