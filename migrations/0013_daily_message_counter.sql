-- Keep daily message milestones off the per-message COUNT(*) scan.
ALTER TABLE user_stats ADD COLUMN daily_message_day TEXT;
ALTER TABLE user_stats ADD COLUMN daily_message_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_message_count >= 0);
ALTER TABLE message_events ADD COLUMN daily_message_count_snapshot INTEGER;

CREATE INDEX IF NOT EXISTS idx_message_events_user_day
  ON message_events(telegram_id, event_day);

-- Preserve progress for the current Moscow day when the migration is applied.
UPDATE user_stats
SET daily_message_day = date('now', '+3 hours'),
    daily_message_count = (
      SELECT COUNT(*)
      FROM message_events
      WHERE message_events.telegram_id = user_stats.telegram_id
        AND message_events.event_day = date('now', '+3 hours')
    )
WHERE EXISTS (
  SELECT 1 FROM message_events
  WHERE message_events.telegram_id = user_stats.telegram_id
    AND message_events.event_day = date('now', '+3 hours')
);
