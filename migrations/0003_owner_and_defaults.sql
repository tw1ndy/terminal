-- Initial owner and configurable defaults for the NK Activity deployment.
INSERT OR IGNORE INTO admins (telegram_id, role, permissions_json, is_active)
VALUES ('891419692', 'owner', '["*"]', 1);

INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by) VALUES
  ('timezone', '"Europe/Moscow"', unixepoch(), '891419692'),
  ('target_chat_id', '"-1004353159956"', unixepoch(), '891419692'),
  ('message_xp', '3', unixepoch(), '891419692'),
  ('daily_xp_cap', '200', unixepoch(), '891419692'),
  ('season_days', '30', unixepoch(), '891419692'),
  ('public_ranking_limit', '10', unixepoch(), '891419692');
