import { Hono } from "hono";
import type { Env, TelegramUpdate } from "./types";

const app = new Hono<{ Bindings: Env }>();
const MESSAGE_XP = 3;
const DAILY_XP_CAP = 200;

function moscowDay(unixSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function recordGroupMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  if (!m?.from || m.from.is_bot || !["group", "supergroup"].includes(m.chat.type)) return;

  const userId = String(m.from.id);
  const chatId = String(m.chat.id);
  const messageId = String(m.message_id);
  const sourceKey = `${chatId}:${messageId}`;
  const day = moscowDay(m.date);

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO users
      (telegram_id, username, first_name, last_name, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(userId, m.from.username ?? null, m.from.first_name ?? "", null, m.date, m.date),
    env.DB.prepare(`UPDATE users SET username = ?, first_name = ?, last_seen_at = ?
      WHERE telegram_id = ?`)
      .bind(m.from.username ?? null, m.from.first_name ?? "", m.date, userId),
    env.DB.prepare("INSERT OR IGNORE INTO user_stats (telegram_id) VALUES (?)").bind(userId),
    env.DB.prepare("INSERT OR IGNORE INTO xp_wallets (telegram_id) VALUES (?)").bind(userId),
    env.DB.prepare(`INSERT OR IGNORE INTO message_events
      (telegram_id, chat_id, message_id, event_day, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(userId, chatId, messageId, day, m.date),
    env.DB.prepare(`INSERT OR IGNORE INTO daily_xp_ledger
      (telegram_id, reward_day, source_type, source_key, amount, created_at)
      SELECT ?, ?, 'message', ?,
        MIN(?, MAX(0, ? - COALESCE(
          (SELECT SUM(amount) FROM daily_xp_ledger WHERE telegram_id = ? AND reward_day = ?), 0
        ))), ?
      WHERE changes() = 1`)
      .bind(userId, day, sourceKey, MESSAGE_XP, DAILY_XP_CAP, userId, day, m.date),
    env.DB.prepare(`UPDATE user_stats SET
      message_count = message_count + 1,
      current_streak = CASE
        WHEN last_activity_day = ? THEN current_streak
        WHEN last_activity_day = date(?, '-1 day') THEN current_streak + 1
        ELSE 1 END,
      longest_streak = MAX(longest_streak, CASE
        WHEN last_activity_day = ? THEN current_streak
        WHEN last_activity_day = date(?, '-1 day') THEN current_streak + 1
        ELSE 1 END),
      last_activity_day = ?
      WHERE telegram_id = ? AND changes() = 1`)
      .bind(day, day, day, day, day, userId),
    env.DB.prepare(`UPDATE xp_wallets SET
      lifetime_xp = lifetime_xp + (SELECT amount FROM daily_xp_ledger WHERE telegram_id = ? AND source_type = 'message' AND source_key = ?),
      available_xp = available_xp + (SELECT amount FROM daily_xp_ledger WHERE telegram_id = ? AND source_type = 'message' AND source_key = ?),
      season_xp = season_xp + (SELECT amount FROM daily_xp_ledger WHERE telegram_id = ? AND source_type = 'message' AND source_key = ?)
      WHERE telegram_id = ? AND changes() = 1`)
      .bind(userId, sourceKey, userId, sourceKey, userId, sourceKey, userId),
    env.DB.prepare(`INSERT INTO xp_transactions
      (telegram_id, amount, transaction_type, source_id, note, created_at)
      SELECT ?, amount, 'message', ?, 'XP за сообщение', ?
      FROM daily_xp_ledger WHERE telegram_id = ? AND source_type = 'message'
        AND source_key = ? AND amount > 0 AND changes() = 1`)
      .bind(userId, sourceKey, m.date, userId, sourceKey)
  ]);
}

async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) console.error("Telegram sendMessage failed", response.status);
}

async function handleCommand(env: Env, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  const text = m?.text?.trim();
  if (!m || !text || !m.from || !["group", "supergroup", "private"].includes(m.chat.type)) return;
  const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  const userId = String(m.from.id);

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, m.chat.id,
      "НК Activity — система активности сообщества.\n/profile — твой профиль и XP.\n/top — топ-10 участников.");
    return;
  }

  if (command === "/profile" || command === "/me") {
    const row = await env.DB.prepare(`SELECT u.first_name, u.username, s.message_count,
      s.current_streak, s.longest_streak, w.lifetime_xp, w.available_xp, w.season_xp
      FROM users u JOIN user_stats s ON s.telegram_id = u.telegram_id
      JOIN xp_wallets w ON w.telegram_id = u.telegram_id WHERE u.telegram_id = ?`)
      .bind(userId).first<{
        first_name: string; username: string | null; message_count: number;
        current_streak: number; longest_streak: number; lifetime_xp: number;
        available_xp: number; season_xp: number;
      }>();
    if (!row) {
      await sendTelegramMessage(env, m.chat.id, "Профиль пока не создан. Напиши сообщение в группе и повтори команду.");
      return;
    }
    const displayName = row.first_name || (row.username ? `@${row.username}` : "Участник");
    await sendTelegramMessage(env, m.chat.id,
      `Профиль: ${displayName}\nУровень XP: ${row.lifetime_xp} Lifetime XP\nДоступно: ${row.available_xp} XP\nСезон: ${row.season_xp} XP\nСообщений: ${row.message_count}\nСерия: ${row.current_streak} дн. (рекорд: ${row.longest_streak})`);
    return;
  }

  if (command === "/top" || command === "/rating") {
    const result = await env.DB.prepare(`SELECT u.first_name, u.username, w.lifetime_xp
      FROM xp_wallets w JOIN users u ON u.telegram_id = w.telegram_id
      ORDER BY w.lifetime_xp DESC, u.joined_at ASC LIMIT 10`).all<{
        first_name: string; username: string | null; lifetime_xp: number;
      }>();
    const lines = (result.results ?? []).map((row, i) =>
      `${i + 1}. ${row.first_name || (row.username ? `@${row.username}` : "Участник")} — ${row.lifetime_xp} XP`);
    await sendTelegramMessage(env, m.chat.id, lines.length ? `Топ-10 НК\n${lines.join("\n")}` : "Рейтинг пока пуст.");
  }
}

app.get("/", c => c.json({ service: "nk-activity", status: "ok", version: "0.2.0" }));
app.get("/health", async c => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, database: "connected" });
  } catch {
    return c.json({ ok: false, database: "unavailable" }, 503);
  }
});

app.post("/webhook", async c => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || c.req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return c.json({ ok: false }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }
  if (!Number.isSafeInteger(update.update_id)) return c.json({ ok: false }, 400);

  try {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)"
    ).bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    await recordGroupMessage(c.env, update);
    return c.json({ ok: true });
  } catch (error) {
    console.error("Webhook processing failed", error);
    return c.json({ ok: false, error: "processing_failed" }, 500);
  }
});

app.notFound(c => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await env.DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?")
      .bind(Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60).run();
  }
};
