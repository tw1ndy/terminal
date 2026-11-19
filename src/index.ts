import { Hono } from "hono";
import type { Env, TelegramUpdate } from "./types";
import { dailyMessageMilestone, dailyRewardAmount, nextDailyClaimStreak, previousDay } from "./rewards";

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

async function detectFlood(env: Env, telegramId: string, chatId: number, now: number): Promise<void> {
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM message_events
    WHERE telegram_id = ? AND created_at >= ?`).bind(telegramId, now - 10).first<{ count: number }>();
  if ((recent?.count ?? 0) < 8) return;

  const cooldown = await env.DB.prepare(`SELECT 1 AS found FROM anti_fraud_events
    WHERE telegram_id = ? AND event_type = 'flood' AND created_at >= ? LIMIT 1`)
    .bind(telegramId, now - 600).first();
  if (cooldown) return;

  await env.DB.prepare(`INSERT INTO anti_fraud_events
    (telegram_id, event_type, details_json, created_at)
    VALUES (?, 'flood', ?, ?)`)
    .bind(telegramId, JSON.stringify({ messages_in_10_seconds: recent?.count ?? 0 }), now).run();

  await sendTelegramMessage(env, chatId,
    "Предупреждение: слишком частые сообщения. Сделай паузу, чтобы не засорять чат.");
  const admins = await env.DB.prepare("SELECT telegram_id FROM admins WHERE is_active = 1").all<{ telegram_id: string }>();
  for (const admin of admins.results ?? []) {
    await sendTelegramMessage(env, Number(admin.telegram_id),
      `Антифрод: возможный флуд. Telegram ID: ${telegramId}; сообщений за 10 секунд: ${recent?.count ?? 0}. XP автоматически не списывались.`);
  }
}

async function grantAchievement(env: Env, telegramId: string, achievementId: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO user_achievements (telegram_id, achievement_id, earned_at)
    SELECT ?, id, ? FROM achievements WHERE id = ? AND is_active = 1`)
    .bind(telegramId, now, achievementId).run();
}

async function isAdmin(env: Env, telegramId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS allowed FROM admins WHERE telegram_id = ? AND is_active = 1")
    .bind(telegramId).first();
  return Boolean(row);
}

async function handleShopCommand(env: Env, update: TelegramUpdate, command: string, args: string): Promise<boolean> {
  const m = update.message;
  if (!m?.from) return false;
  const telegramId = String(m.from.id);
  const now = m.date;

  if (command === "/shop") {
    const result = await env.DB.prepare(`SELECT id, title, description, category, price_xp, quantity
      FROM rewards WHERE is_active = 1 AND (quantity IS NULL OR quantity > 0)
      ORDER BY category, price_xp ASC LIMIT 20`).all<{
        id: number; title: string; description: string; category: string; price_xp: number; quantity: number | null;
      }>();
    const lines = (result.results ?? []).map(item =>
      `#${item.id} · ${item.title} — ${item.price_xp} XP [${item.category}]${item.quantity === null ? "" : ` · осталось: ${item.quantity}`}`);
    await sendTelegramMessage(env, m.chat.id, lines.length
      ? `Магазин НК\\n${lines.join("\\n")}\\nПокупка: /buy ID`
      : "Магазин пока пуст.");
    return true;
  }

  if (command === "/buy") {
    const rewardId = Number(args.trim());
    if (!Number.isSafeInteger(rewardId) || rewardId < 1) {
      await sendTelegramMessage(env, m.chat.id, "Формат: /buy ID");
      return true;
    }
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO reward_purchases (telegram_id, reward_id, price_xp, status, created_at)
        SELECT ?, r.id, r.price_xp, 'pending', ?
        FROM rewards r JOIN xp_wallets w ON w.telegram_id = ?
        WHERE r.id = ? AND r.is_active = 1 AND (r.quantity IS NULL OR r.quantity > 0)
          AND w.available_xp >= r.price_xp`).bind(telegramId, now, telegramId, rewardId),
      env.DB.prepare(`UPDATE xp_wallets SET available_xp = available_xp -
        (SELECT price_xp FROM reward_purchases WHERE id = last_insert_rowid())
        WHERE telegram_id = ? AND changes() = 1`).bind(telegramId),
      env.DB.prepare(`UPDATE rewards SET quantity = CASE WHEN quantity IS NULL THEN NULL ELSE quantity - 1 END
        WHERE id = ? AND (quantity IS NULL OR quantity > 0) AND changes() = 1`).bind(rewardId),
      env.DB.prepare(`INSERT INTO xp_transactions
        (telegram_id, amount, transaction_type, source_id, note, created_at)
        SELECT telegram_id, -price_xp, 'purchase', CAST(last_insert_rowid() AS TEXT), 'Покупка в магазине', ?
        FROM reward_purchases WHERE id = last_insert_rowid() AND changes() = 1`).bind(now)
    ]);
    const purchaseId = results[0]?.meta.last_row_id;
    if ((results[0]?.meta.changes ?? 0) === 0 || !purchaseId) {
      await sendTelegramMessage(env, m.chat.id, "Не удалось оформить покупку: проверь ID товара, наличие и баланс XP.");
      return true;
    }
    const purchase = await env.DB.prepare(`SELECT p.price_xp, r.title, u.first_name, u.username
      FROM reward_purchases p JOIN rewards r ON r.id = p.reward_id
      JOIN users u ON u.telegram_id = p.telegram_id WHERE p.id = ?`)
      .bind(purchaseId).first<{ price_xp: number; title: string; first_name: string; username: string | null }>();
    await sendTelegramMessage(env, m.chat.id,
      `Заявка #${purchaseId} оформлена: ${purchase?.title ?? "товар"} · списано ${purchase?.price_xp ?? "—"} XP. Ожидай подтверждения администрации.`);
    const admins = await env.DB.prepare("SELECT telegram_id FROM admins WHERE is_active = 1").all<{ telegram_id: string }>();
    const buyer = purchase?.username ? `@${purchase.username}` : (purchase?.first_name ?? telegramId);
    for (const admin of admins.results ?? []) {
      await sendTelegramMessage(env, Number(admin.telegram_id),
        `Новая покупка #${purchaseId}: ${purchase?.title ?? "товар"} за ${purchase?.price_xp ?? "—"} XP. Участник: ${buyer}.\\nОдобрить: /approve ${purchaseId}\\nОтклонить: /reject ${purchaseId}`);
    }
    return true;
  }

  if (command === "/myorders") {
    const result = await env.DB.prepare(`SELECT p.id, r.title, p.price_xp, p.status, p.created_at
      FROM reward_purchases p JOIN rewards r ON r.id = p.reward_id
      WHERE p.telegram_id = ? ORDER BY p.created_at DESC LIMIT 10`).bind(telegramId).all<{
        id: number; title: string; price_xp: number; status: string; created_at: number;
      }>();
    const lines = (result.results ?? []).map(p => `#${p.id} · ${p.title} — ${p.price_xp} XP · ${p.status}`);
    await sendTelegramMessage(env, m.chat.id, lines.length ? `Твои заявки:\\n${lines.join("\\n")}` : "У тебя пока нет покупок.");
    return true;
  }

  if (command === "/pending") {
    if (!(await isAdmin(env, telegramId))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const result = await env.DB.prepare(`SELECT p.id, p.price_xp, r.title, u.first_name, u.username
      FROM reward_purchases p JOIN rewards r ON r.id = p.reward_id
      JOIN users u ON u.telegram_id = p.telegram_id
      WHERE p.status = 'pending' ORDER BY p.created_at ASC LIMIT 20`).all<{
        id: number; price_xp: number; title: string; first_name: string; username: string | null;
      }>();
    const lines = (result.results ?? []).map(p =>
      `#${p.id} · ${p.title} · ${p.price_xp} XP · ${p.username ? `@${p.username}` : p.first_name}`);
    await sendTelegramMessage(env, m.chat.id,
      lines.length ? `Ожидают решения:\\n${lines.join("\\n")}\\n/approve ID или /reject ID` : "Нет ожидающих заявок.");
    return true;
  }

  if (command === "/addreward") {
    if (!(await isAdmin(env, telegramId))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const parts = args.split("|").map(part => part.trim());
    const [category, title, rawPrice, description = ""] = parts;
    const price = Number(rawPrice);
    if (!category || !title || title.length > 80 || !Number.isSafeInteger(price) || price < 1) {
      await sendTelegramMessage(env, m.chat.id, "Формат: /addreward категория | название | цена_XP | описание");
      return true;
    }
    const result = await env.DB.prepare(`INSERT INTO rewards
      (title, description, category, price_xp, quantity, is_active)
      VALUES (?, ?, ?, ?, NULL, 1)`).bind(title, description, category, price).run();
    await sendTelegramMessage(env, m.chat.id, `Товар добавлен. ID: ${result.meta.last_row_id}`);
    return true;
  }

  if (command === "/approve" || command === "/reject") {
    if (!(await isAdmin(env, telegramId))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const purchaseId = Number(args.trim());
    if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) {
      await sendTelegramMessage(env, m.chat.id, `Формат: ${command} ID_заявки`);
      return true;
    }
    if (command === "/approve") {
      const result = await env.DB.prepare(`UPDATE reward_purchases SET status = 'approved'
        WHERE id = ? AND status = 'pending'`).bind(purchaseId).run();
      await sendTelegramMessage(env, m.chat.id, (result.meta.changes ?? 0) > 0
        ? `Заявка #${purchaseId} одобрена.` : "Заявка не найдена или уже обработана.");
      return true;
    }
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE reward_purchases SET status = 'rejected' WHERE id = ? AND status = 'pending'")
        .bind(purchaseId),
      env.DB.prepare(`INSERT OR IGNORE INTO xp_transactions
        (telegram_id, amount, transaction_type, source_id, note, created_at)
        SELECT telegram_id, price_xp, 'purchase_refund', CAST(id AS TEXT), 'Возврат за отклонённую покупку', ?
        FROM reward_purchases WHERE id = ? AND status = 'rejected' AND changes() = 1`)
        .bind(now, purchaseId),
      env.DB.prepare(`UPDATE xp_wallets SET available_xp = available_xp +
        (SELECT amount FROM xp_transactions WHERE transaction_type = 'purchase_refund' AND source_id = ?)
        WHERE telegram_id = (SELECT telegram_id FROM reward_purchases WHERE id = ?)
          AND changes() = 1`).bind(String(purchaseId), purchaseId),
      env.DB.prepare(`UPDATE rewards SET quantity = CASE WHEN quantity IS NULL THEN NULL ELSE quantity + 1 END
        WHERE id = (SELECT reward_id FROM reward_purchases WHERE id = ?)
          AND changes() = 1`).bind(purchaseId)
    ]);
    await sendTelegramMessage(env, m.chat.id, (results[0]?.meta.changes ?? 0) > 0
      ? `Заявка #${purchaseId} отклонена, XP возвращены.`
      : "Заявка не найдена или уже обработана.");
    return true;
  }
  return false;
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
  await detectFlood(env, telegramId, m.chat.id, m.date);

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
  const milestone = dailyMessageMilestone(dailyCount);
  if (milestone) await awardDailyXp(env, telegramId, day, "message_milestone",
    `${milestone.sourceKey}:${day}`, milestone.amount, milestone.note, m.date);
  if (streak === 7) await awardDailyXp(env, telegramId, day, "streak_milestone", `7:${day}`, 50, "Серия 7 дней", m.date);
  if (streak === 30) await awardDailyXp(env, telegramId, day, "streak_milestone", `30:${day}`, 200, "Серия 30 дней", m.date);

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

  const recentClaims = await env.DB.prepare(`SELECT reward_day FROM daily_rewards
    WHERE telegram_id = ? AND reward_type = 'daily_claim'
    ORDER BY reward_day DESC LIMIT 7`).bind(telegramId).all<{ reward_day: string }>();
  const claimDays = (recentClaims.results ?? []).map(row => row.reward_day);
  if (claimDays[0] === day) {
    // Recover safely if a previous request stored the claim but was interrupted before XP credit.
    const saved = await env.DB.prepare(`SELECT xp_amount FROM daily_rewards
      WHERE telegram_id = ? AND reward_day = ? AND reward_type = 'daily_claim'`)
      .bind(telegramId, day).first<{ xp_amount: number }>();
    const recovered = await awardDailyXp(env, telegramId, day, "daily_claim", day,
      saved?.xp_amount ?? 0, "Ежедневная награда", now);
    return recovered > 0 ? `Награда восстановлена: +${recovered} XP.` : "Ежедневная награда уже получена сегодня.";
  }

  const streak = nextDailyClaimStreak(day, claimDays);
  const amount = dailyRewardAmount(streak);
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

  const handledShop = await handleShopCommand(env, update, command, text.slice(text.indexOf(" ") + 1));
  if (handledShop) return;

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, m.chat.id,
      "НК Activity — система активности сообщества.\n/profile — профиль и XP.\n/achievements — твои достижения.\n/daily — ежедневная награда.\n/shop — магазин.\n/buy ID — купить товар.\n/myorders — мои покупки.\n/pending — заявки на проверку (админ).\n/top — общий топ-10.\n/topseason — рейтинг текущего сезона.");
    return;
  }
  if (command === "/daily") {
    await sendTelegramMessage(env, m.chat.id, await claimDailyReward(env, telegramId, m.date));
    return;
  }
  if (command === "/achievements") {
    const result = await env.DB.prepare(`SELECT a.title, a.description, ua.earned_at
      FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
      WHERE ua.telegram_id = ? ORDER BY ua.earned_at ASC`).bind(telegramId).all<{
        title: string; description: string; earned_at: number;
      }>();
    const lines = (result.results ?? []).map((row, i) => `${i + 1}. ${row.title} — ${row.description}`);
    await sendTelegramMessage(env, m.chat.id,
      lines.length ? `Твои достижения:\\n${lines.join("\\n")}` : "Пока нет достижений. Продолжай общаться в группе.");
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
