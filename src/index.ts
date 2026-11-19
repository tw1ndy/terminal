import { Hono } from "hono";
import type { Env, TelegramUpdate } from "./types";

const app = new Hono<{ Bindings: Env }>();
const DEFAULT_MESSAGE_XP = 3;
const DEFAULT_DAILY_CAP = 200;

function moscowDay(unixSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function previousDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, date - 1));
  return d.toISOString().slice(0, 10);
}

async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key)
    .first<{ value_json: string }>();
  if (!row) return fallback;
  try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
}

async function ensureActiveSeason(env: Env, now: number): Promise<void> {
  const active = await env.DB.prepare("SELECT id, ends_at FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; ends_at: number }>();
  if (active && active.ends_at > now) return;

  const seasonDays = await getSetting(env, "season_days", 30);
  const duration = Math.max(1, Math.min(90, Number(seasonDays) || 30)) * 86400;
  await env.DB.batch([
    env.DB.prepare("UPDATE seasons SET status = 'closed' WHERE status = 'active' AND ends_at <= ?").bind(now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO season_results (season_id, telegram_id, place, xp_awarded, archived_at)
      SELECT season_id, telegram_id, place, season_xp, ?
      FROM (
        SELECT ss.season_id, ss.telegram_id, ss.season_xp,
          ROW_NUMBER() OVER (PARTITION BY ss.season_id ORDER BY ss.season_xp DESC, ss.telegram_id ASC) AS place
        FROM season_stats ss JOIN seasons s ON s.id = ss.season_id
        WHERE s.status = 'closed' AND s.ends_at <= ?
      )
      WHERE place <= 10
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO seasons (title, starts_at, ends_at, status)
      SELECT 'Сезон ' || (COALESCE(MAX(id), 0) + 1), ?, ?, 'active'
      FROM seasons
      WHERE NOT EXISTS (SELECT 1 FROM seasons WHERE status = 'active')
    `).bind(now, now + duration),
    env.DB.prepare("UPDATE xp_wallets SET season_xp = 0 WHERE changes() = 1")
  ]);
}

/** Grants XP once per source and applies the shared daily cap atomically in SQL. */
async function awardDailyXp(
  env: Env, telegramId: string, day: string, sourceType: string,
  sourceKey: string, requestedAmount: number, note: string, createdAt: number
): Promise<number> {
  if (requestedAmount <= 0) return 0;
  await ensureActiveSeason(env, createdAt);
  const cap = await getSetting(env, "daily_xp_cap", DEFAULT_DAILY_CAP);
  // Keep ledger insertion, transaction creation and wallet credit in one D1 batch.
  // The unique transaction key makes retries safe; changes() gates the wallet increment.
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO daily_xp_ledger
        (telegram_id, reward_day, source_type, source_key, amount, created_at)
      SELECT ?, ?, ?, ?, MIN(?, MAX(0, ? - COALESCE(
        (SELECT SUM(amount) FROM daily_xp_ledger WHERE telegram_id = ? AND reward_day = ?), 0
      ))), ?
    `).bind(telegramId, day, sourceType, sourceKey, requestedAmount, cap, telegramId, day, createdAt),
    env.DB.prepare(`
      INSERT OR IGNORE INTO xp_transactions
        (telegram_id, amount, transaction_type, source_id, note, created_at)
      SELECT ?, amount, ?, ?, ?, ?
      FROM daily_xp_ledger
      WHERE telegram_id = ? AND reward_day = ? AND source_type = ? AND source_key = ? AND amount > 0
    `).bind(telegramId, sourceType, sourceKey, note, createdAt, telegramId, day, sourceType, sourceKey),
    env.DB.prepare(`
      UPDATE xp_wallets SET
        lifetime_xp = lifetime_xp + (SELECT amount FROM xp_transactions WHERE telegram_id = ? AND transaction_type = ? AND source_id = ?),
        available_xp = available_xp + (SELECT amount FROM xp_transactions WHERE telegram_id = ? AND transaction_type = ? AND source_id = ?),
        season_xp = season_xp + (SELECT amount FROM xp_transactions WHERE telegram_id = ? AND transaction_type = ? AND source_id = ?)
      WHERE telegram_id = ? AND changes() = 1
    `).bind(telegramId, sourceType, sourceKey, telegramId, sourceType, sourceKey,
      telegramId, sourceType, sourceKey, telegramId),
    env.DB.prepare(`
      INSERT INTO season_stats (season_id, telegram_id, season_xp)
      SELECT id, ?, (SELECT amount FROM xp_transactions WHERE telegram_id = ? AND transaction_type = ? AND source_id = ?)
      FROM seasons
      WHERE status = 'active' AND changes() = 1
      ON CONFLICT(season_id, telegram_id) DO UPDATE SET season_xp = season_xp + excluded.season_xp
    `).bind(telegramId, telegramId, sourceType, sourceKey)
  ]);
  const transactionCreated = results[1]?.meta.changes ?? 0;
  if (transactionCreated === 0) return 0;
  const row = await env.DB.prepare(
    "SELECT amount FROM daily_xp_ledger WHERE telegram_id = ? AND reward_day = ? AND source_type = ? AND source_key = ?"
  ).bind(telegramId, day, sourceType, sourceKey).first<{ amount: number }>();
  return row?.amount ?? 0;
}

async function grantAchievement(env: Env, telegramId: string, achievementId: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO user_achievements (telegram_id, achievement_id, earned_at)
    SELECT ?, id, ? FROM achievements WHERE id = ? AND is_active = 1`)
    .bind(telegramId, now, achievementId).run();
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

async function recordGroupMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  if (!m?.from || m.from.is_bot || !["group", "supergroup"].includes(m.chat.type)) return;
  if (env.TARGET_CHAT_ID && String(m.chat.id) !== env.TARGET_CHAT_ID) return;

  const telegramId = String(m.from.id);
  const chatId = String(m.chat.id);
  const messageId = String(m.message_id);
  const sourceKey = `${chatId}:${messageId}`;
  const day = moscowDay(m.date);

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO users
      (telegram_id, username, first_name, last_name, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(telegramId, m.from.username ?? null, m.from.first_name ?? "", null, m.date, m.date),
    env.DB.prepare(`UPDATE users SET username = ?, first_name = ?, last_seen_at = ?
      WHERE telegram_id = ?`)
      .bind(m.from.username ?? null, m.from.first_name ?? "", m.date, telegramId),
    env.DB.prepare("INSERT OR IGNORE INTO user_stats (telegram_id) VALUES (?)").bind(telegramId),
    env.DB.prepare("INSERT OR IGNORE INTO xp_wallets (telegram_id) VALUES (?)").bind(telegramId)
  ]);

  // The event insert is the idempotency boundary for message rewards and counters.
  const event = await env.DB.prepare(`INSERT OR IGNORE INTO message_events
    (telegram_id, chat_id, message_id, event_day, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(telegramId, chatId, messageId, day, m.date).run();
  if ((event.meta.changes ?? 0) === 0) return;

  const stats = await env.DB.prepare("SELECT message_count, current_streak, last_activity_day FROM user_stats WHERE telegram_id = ?")
    .bind(telegramId).first<{ message_count: number; current_streak: number; last_activity_day: string | null }>();
  const previous = stats?.last_activity_day ?? null;
  const streak = previous === day ? (stats?.current_streak ?? 0)
    : previous === previousDay(day) ? (stats?.current_streak ?? 0) + 1 : 1;

  await env.DB.prepare(`UPDATE user_stats SET message_count = message_count + 1,
    current_streak = ?, longest_streak = MAX(longest_streak, ?), last_activity_day = ?
    WHERE telegram_id = ?`).bind(streak, streak, day, telegramId).run();

  await awardDailyXp(env, telegramId, day, "message", sourceKey,
    await getSetting(env, "message_xp", DEFAULT_MESSAGE_XP), "XP за сообщение", m.date);

  // Daily activity and message-count milestones share the same 200 XP daily cap.
  await awardDailyXp(env, telegramId, day, "daily_activity", day, 15, "Ежедневная активность", m.date);
  const count = (stats?.message_count ?? 0) + 1;
  const dailyCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM message_events WHERE telegram_id = ? AND event_day = ?"
  ).bind(telegramId, day).first<{ count: number }>();
  const dailyCount = dailyCountRow?.count ?? 0;
  if (dailyCount === 50) await awardDailyXp(env, telegramId, day, "message_milestone", "50", 20, "50 сообщений за день", m.date);
  if (dailyCount === 100) await awardDailyXp(env, telegramId, day, "message_milestone", "100", 35, "100 сообщений за день", m.date);
  if (streak === 7) await awardDailyXp(env, telegramId, day, "streak_milestone", "7", 50, "Серия 7 дней", m.date);
  if (streak === 30) await awardDailyXp(env, telegramId, day, "streak_milestone", "30", 200, "Серия 30 дней", m.date);

  if (count === 1) await grantAchievement(env, telegramId, "first_message", m.date);
  if (count >= 100) await grantAchievement(env, telegramId, "messages_100", m.date);
  if (count >= 500) await grantAchievement(env, telegramId, "messages_500", m.date);
  if (count >= 1000) await grantAchievement(env, telegramId, "messages_1000", m.date);
  if (count >= 5000) await grantAchievement(env, telegramId, "messages_5000", m.date);
  if (streak >= 7) await grantAchievement(env, telegramId, "streak_7", m.date);
  if (streak >= 30) await grantAchievement(env, telegramId, "streak_30", m.date);
}

async function claimDailyReward(env: Env, telegramId: string, now: number): Promise<string> {
  const day = moscowDay(now);
  const existing = await env.DB.prepare("SELECT 1 AS found FROM users WHERE telegram_id = ?")
    .bind(telegramId).first();
  if (!existing) return "Сначала напиши сообщение в основной группе, чтобы создать профиль.";

  const last = await env.DB.prepare(`SELECT reward_day FROM daily_rewards
    WHERE telegram_id = ? AND reward_type = 'daily_claim' ORDER BY reward_day DESC LIMIT 1`)
    .bind(telegramId).first<{ reward_day: string }>();
  const yesterday = previousDay(day);
  let streak = last?.reward_day === yesterday ? 1 : 0;
  if (streak) {
    const prior = await env.DB.prepare(`SELECT COUNT(*) AS days FROM daily_rewards
      WHERE telegram_id = ? AND reward_type = 'daily_claim' AND reward_day >= date(?, '-6 day') AND reward_day <= ?`)
      .bind(telegramId, yesterday, yesterday).first<{ days: number }>();
    streak = Math.min((prior?.days ?? 0) + 1, 7);
  } else if (last?.reward_day === day) {
    return "Ежедневная награда уже получена сегодня.";
  } else {
    streak = 1;
  }
  if (last?.reward_day === day) {
    // Recover safely if a previous request stored the claim but was interrupted before XP credit.
    const saved = await env.DB.prepare(`SELECT xp_amount FROM daily_rewards
      WHERE telegram_id = ? AND reward_day = ? AND reward_type = 'daily_claim'`)
      .bind(telegramId, day).first<{ xp_amount: number }>();
    const recovered = await awardDailyXp(env, telegramId, day, "daily_claim", day,
      saved?.xp_amount ?? 0, "Ежедневная награда", now);
    return recovered > 0 ? `Награда восстановлена: +${recovered} XP.` : "Ежедневная награда уже получена сегодня.";
  }

  const amounts = [10, 15, 20, 25, 30, 50, 100];
  const amount = amounts[streak - 1] ?? 10;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO daily_rewards
    (telegram_id, reward_day, reward_type, xp_amount, created_at)
    VALUES (?, ?, 'daily_claim', ?, ?)`).bind(telegramId, day, amount, now).run();
  if ((inserted.meta.changes ?? 0) === 0) return "Ежедневная награда уже получена сегодня.";

  const granted = await awardDailyXp(env, telegramId, day, "daily_claim", day, amount, "Ежедневная награда", now);
  return granted > 0
    ? `Ежедневная награда: +${granted} XP. День серии: ${streak}/7.`
    : "Дневной лимит XP уже достигнут. Награда отмечена, но XP сегодня не начислены.";
}

async function handleCommand(env: Env, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  const text = m?.text?.trim();
  if (!m || !text || !m.from || !["group", "supergroup", "private"].includes(m.chat.type)) return;
  if (m.chat.type !== "private" && env.TARGET_CHAT_ID && String(m.chat.id) !== env.TARGET_CHAT_ID) return;
  const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  const telegramId = String(m.from.id);

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, m.chat.id,
      "НК Activity — система активности сообщества.\n/profile — профиль и XP.\n/daily — ежедневная награда.\n/top — общий топ-10.\n/topseason — рейтинг текущего сезона.");
    return;
  }
  if (command === "/daily") {
    await sendTelegramMessage(env, m.chat.id, await claimDailyReward(env, telegramId, m.date));
    return;
  }
  if (command === "/profile" || command === "/me") {
    const row = await env.DB.prepare(`SELECT u.first_name, u.username, s.message_count,
      s.current_streak, s.longest_streak, w.lifetime_xp, w.available_xp, w.season_xp,
      (SELECT COUNT(*) FROM user_achievements a WHERE a.telegram_id = u.telegram_id) AS achievements
      FROM users u JOIN user_stats s ON s.telegram_id = u.telegram_id
      JOIN xp_wallets w ON w.telegram_id = u.telegram_id WHERE u.telegram_id = ?`)
      .bind(telegramId).first<{
        first_name: string; username: string | null; message_count: number;
        current_streak: number; longest_streak: number; lifetime_xp: number;
        available_xp: number; season_xp: number; achievements: number;
      }>();
    if (!row) {
      await sendTelegramMessage(env, m.chat.id, "Профиль пока не создан. Напиши сообщение в основной группе и повтори команду.");
      return;
    }
    const displayName = row.first_name || (row.username ? `@${row.username}` : "Участник");
    await sendTelegramMessage(env, m.chat.id,
      `Профиль: ${displayName}\nLifetime XP: ${row.lifetime_xp}\nДоступно: ${row.available_xp} XP\nСезон: ${row.season_xp} XP\nСообщений: ${row.message_count}\nСерия активности: ${row.current_streak} дн. (рекорд: ${row.longest_streak})\nДостижения: ${row.achievements}`);
    return;
  }
  if (command === "/top" || command === "/rating" || command === "/topseason") {
    const seasonOnly = command === "/topseason";
    if (seasonOnly) await ensureActiveSeason(env, m.date);
    const result = seasonOnly
      ? await env.DB.prepare(`SELECT u.first_name, u.username, ss.season_xp AS xp
          FROM season_stats ss JOIN users u ON u.telegram_id = ss.telegram_id
          JOIN seasons s ON s.id = ss.season_id
          WHERE s.status = 'active'
          ORDER BY ss.season_xp DESC, u.joined_at ASC LIMIT 10`).all<{
            first_name: string; username: string | null; xp: number;
          }>()
      : await env.DB.prepare(`SELECT u.first_name, u.username, w.lifetime_xp AS xp
          FROM xp_wallets w JOIN users u ON u.telegram_id = w.telegram_id
          ORDER BY w.lifetime_xp DESC, u.joined_at ASC LIMIT 10`).all<{
            first_name: string; username: string | null; xp: number;
          }>();
    const lines = (result.results ?? []).map((row, i) =>
      `${i + 1}. ${row.first_name || (row.username ? `@${row.username}` : "Участник")} — ${row.xp} XP`);
    const title = seasonOnly ? "Топ сезона НК" : "Топ-10 НК";
    await sendTelegramMessage(env, m.chat.id, lines.length ? `${title}\n${lines.join("\n")}` : "Рейтинг пока пуст.");
  }
}

app.get("/", c => c.json({ service: "nk-activity", status: "ok", version: "0.3.0" }));
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
  try { update = await c.req.json<TelegramUpdate>(); }
  catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
  if (!Number.isSafeInteger(update.update_id)) return c.json({ ok: false }, 400);

  try {
    const inserted = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)"
    ).bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    if ((inserted.meta.changes ?? 0) === 0) return c.json({ ok: true, duplicate: true });
    try {
      await recordGroupMessage(c.env, update);
      await handleCommand(c.env, update);
    } catch (processingError) {
      await c.env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?")
        .bind(update.update_id).run();
      throw processingError;
    }
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
