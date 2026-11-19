ALTER TABLE message_events ADD COLUMN stats_applied INTEGER NOT NULL DEFAULT 0 CHECK (stats_applied IN (0,1));
ALTER TABLE message_events ADD COLUMN message_count_snapshot INTEGER;
ALTER TABLE message_events ADD COLUMN streak_snapshot INTEGER;
