-- Initial achievement catalog. XP bonuses remain zero; progression rewards are configured separately.
INSERT OR IGNORE INTO achievements (id, title, description, icon, rarity, xp_bonus, condition_json) VALUES
  ('first_message', 'Первое сообщение', 'Отправь первое сообщение в основной группе', '💬', 'common', 0, '{"type":"messages","value":1}'),
  ('messages_100', 'Освоился', 'Отправь 100 сообщений', '✉️', 'common', 0, '{"type":"messages","value":100}'),
  ('messages_500', 'Активный участник', 'Отправь 500 сообщений', '📨', 'uncommon', 0, '{"type":"messages","value":500}'),
  ('messages_1000', 'Тысяча сообщений', 'Отправь 1000 сообщений', '🏅', 'rare', 0, '{"type":"messages","value":1000}'),
  ('messages_5000', 'Легенда общения', 'Отправь 5000 сообщений', '🏆', 'legendary', 0, '{"type":"messages","value":5000}'),
  ('streak_7', 'Неделя активности', 'Будь активен 7 дней подряд', '🔥', 'uncommon', 0, '{"type":"streak","value":7}'),
  ('streak_30', 'Месяц активности', 'Будь активен 30 дней подряд', '🌟', 'epic', 0, '{"type":"streak","value":30}');

CREATE INDEX IF NOT EXISTS idx_daily_rewards_user_type_day
  ON daily_rewards(telegram_id, reward_type, reward_day DESC);
