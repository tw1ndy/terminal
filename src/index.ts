import { Hono } from "hono";
import type { Env, TelegramUpdate } from "./types";
import { dailyMessageMilestones, dailyRewardAmount, monthlyRewardTypes, nextDailyClaimStreak, previousDay, validateSeasonRewardSchedule } from "./rewards";
import { getLevelProgress, validateLevelThresholds } from "./levels";

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

function moscowStartOfDay(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / 1000) - 3 * 60 * 60;
}

async function awardMonthlyRankingRewards(env: Env, now: number): Promise<void> {
  const today = moscowDay(now);
  if (!today.endsWith("-01")) return;
  const [year, month] = today.split("-").map(Number);
  const periodStartDate = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const periodKey = periodStartDate.slice(0, 7);
  const periodStart = moscowStartOfDay(periodStartDate);
  const periodEnd = moscowStartOfDay(today);
  const leaders = await env.DB.prepare(`SELECT telegram_id, SUM(amount) AS xp
    FROM xp_transactions
    WHERE amount > 0 AND transaction_type NOT IN ('purchase_refund', 'weekly_reward', 'season_reward')
      AND created_at >= ? AND created_at < ?
    GROUP BY telegram_id ORDER BY xp DESC, telegram_id ASC LIMIT 3`)
    .bind(periodStart, periodEnd).all<{ telegram_id: string; xp: number }>();

  for (const [index, leader] of (leaders.results ?? []).entries()) {
    const title = index === 0
      ? `Победитель месяца · ${periodKey}`
      : index === 1
        ? `Призёр месяца · ${periodKey}`
        : `Топ-3 месяца · ${periodKey}`;

    const rewardTypes = monthlyRewardTypes(index + 1);
    if (rewardTypes.includes("prefix")) {
      await env.DB.prepare(`INSERT OR IGNORE INTO member_rewards
        (telegram_id, reward_type, title, period_key, created_at)
        VALUES (?, 'prefix', ?, ?, ?)`).bind(leader.telegram_id, title, periodKey, now).run();
    }

    if (rewardTypes.includes("achievement")) {
      const achievementId = index === 0
        ? `monthly_winner_${periodKey.replace("-", "_")}`
        : `monthly_top3_${periodKey.replace("-", "_")}`;
      const achievementTitle = index === 0 ? `Победитель месяца · ${periodKey}` : title;
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO achievements
          (id, title, description, icon, rarity, xp_bonus, condition_json, is_active)
          VALUES (?, ?, ?, '🏅', 'rare', 0, ?, 1)`)
          .bind(
            achievementId,
            achievementTitle,
            index === 0 ? "Займи первое место в месячном рейтинге" : "Войди в тройку лидеров месячного рейтинга",
            JSON.stringify({ type: "monthly_rank", value: index === 0 ? 1 : 3, period: periodKey })
          ),
        env.DB.prepare(`INSERT OR IGNORE INTO user_achievements (telegram_id, achievement_id, earned_at)
          SELECT ?, id, ? FROM achievements WHERE id = ?`).bind(leader.telegram_id, now, achievementId),
        env.DB.prepare(`INSERT OR IGNORE INTO member_rewards
          (telegram_id, reward_type, title, period_key, created_at)
          VALUES (?, 'achievement', ?, ?, ?)`).bind(leader.telegram_id, achievementTitle, periodKey, now)
      ]);
    }
  }
}
async function awardWeeklyRankingRewards(env: Env, now: number): Promise<void> {
  const today = moscowDay(now);
  const [year, month, date] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  if (weekday !== 1) return;
  const periodEnd = moscowStartOfDay(today);
  let periodStartDay = today;
  for (let i = 0; i < 7; i++) periodStartDay = previousDay(periodStartDay);
  const periodStart = moscowStartOfDay(periodStartDay);
  const rewards = [300, 200, 150, 75, 75, 30, 30, 30, 30, 30];
  const leaders = await env.DB.prepare(`SELECT telegram_id, SUM(amount) AS xp
    FROM xp_transactions
    WHERE amount > 0 AND transaction_type NOT IN ('purchase_refund', 'weekly_reward', 'season_reward')
      AND created_at >= ? AND created_at < ?
    GROUP BY telegram_id ORDER BY xp DESC, telegram_id ASC LIMIT 10`)
    .bind(periodStart, periodEnd).all<{ telegram_id: string; xp: number }>();
  for (const [index, leader] of (leaders.results ?? []).entries()) {
    const amount = rewards[index] ?? 0;
    if (!amount) continue;
    const sourceId = `week:${periodStartDay}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO xp_transactions
        (telegram_id, amount, transaction_type, source_id, note, created_at, created_by)
        VALUES (?, ?, 'weekly_reward', ?, ?, ?, 'system')`)
        .bind(leader.telegram_id, amount, sourceId, `Недельная награда · место ${index + 1}`, now),
      env.DB.prepare(`UPDATE xp_wallets SET lifetime_xp = lifetime_xp + ?,
        available_xp = available_xp + ?, season_xp = season_xp + ?
        WHERE telegram_id = ? AND changes() = 1`)
        .bind(amount, amount, amount, leader.telegram_id),
      env.DB.prepare(`INSERT INTO season_stats (season_id, telegram_id, season_xp)
        SELECT id, ?, ? FROM seasons WHERE status = 'active' AND changes() = 1
        ON CONFLICT(season_id, telegram_id) DO UPDATE SET season_xp = season_xp + excluded.season_xp`)
        .bind(leader.telegram_id, amount)
    ]);
  }
}

async function awardClosedSeasonRewards(env: Env, now: number): Promise<void> {
  const schedule = await getSetting<Record<string, number>>(env, 'season_reward_schedule', {});
  const closed = await env.DB.prepare("SELECT id FROM seasons WHERE status = 'closed' AND id NOT IN (SELECT season_id FROM season_reward_runs) ORDER BY id ASC").all<{id:number}>();
  for (const season of closed.results ?? []) {
    const results = await env.DB.prepare('SELECT telegram_id, place FROM season_results WHERE season_id = ? ORDER BY place ASC LIMIT 10').bind(season.id).all<{telegram_id:string;place:number}>();
    for (const result of results.results ?? []) {
      const amount = Number(schedule[String(result.place)] ?? 0);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) continue;
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO xp_transactions (telegram_id, amount, transaction_type, source_id, note, created_at, created_by) VALUES (?, ?, 'season_reward', ?, ?, ?, 'system')").bind(result.telegram_id, amount, 'season:' + season.id + ':place:' + result.place, 'Награда за сезон №' + season.id + ' · место ' + result.place, now),
        env.DB.prepare('UPDATE xp_wallets SET lifetime_xp = lifetime_xp + ?, available_xp = available_xp + ? WHERE telegram_id = ? AND changes() = 1').bind(amount, amount, result.telegram_id)
      ]);
    }
    await env.DB.prepare('INSERT OR IGNORE INTO season_reward_runs (season_id, completed_at) VALUES (?, ?)').bind(season.id, now).run();
  }
}
async function ensureActiveSeason(env: Env, now: number): Promise<void> {
  const active = await env.DB.prepare("SELECT id, ends_at FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; ends_at: number }>();
  if (active && active.ends_at > now) { await awardClosedSeasonRewards(env, now); return; }

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
  await awardClosedSeasonRewards(env, now);
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

async function hashMessageText(text: string | undefined): Promise<string | null> {
  const normalized = (text ?? "").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
  if (normalized.length < 12) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function detectFlood(
  env: Env, telegramId: string, chatId: number, now: number, messageHash: string | null
): Promise<void> {
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM message_events
    WHERE telegram_id = ? AND created_at >= ?`).bind(telegramId, now - 10).first<{ count: number }>();
  let eventType: "flood" | "repeated_text" | null = (recent?.count ?? 0) >= 8 ? "flood" : null;
  let repeatedCount = 0;
  if (!eventType && messageHash) {
    const repeated = await env.DB.prepare(`SELECT COUNT(*) AS count FROM message_events
      WHERE telegram_id = ? AND message_hash = ? AND created_at >= ?`)
      .bind(telegramId, messageHash, now - 60).first<{ count: number }>();
    repeatedCount = repeated?.count ?? 0;
    if (repeatedCount >= 5) eventType = "repeated_text";
  }
  if (!eventType) return;

  const cooldown = await env.DB.prepare(`SELECT 1 AS found FROM anti_fraud_events
    WHERE telegram_id = ? AND event_type = ? AND created_at >= ? LIMIT 1`)
    .bind(telegramId, eventType, now - 600).first();
  if (cooldown) return;

  await env.DB.prepare(`INSERT INTO anti_fraud_events
    (telegram_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?)`)
    .bind(telegramId, eventType, JSON.stringify({
      messages_in_10_seconds: recent?.count ?? 0,
      repeated_identical_messages_in_60_seconds: repeatedCount
    }), now).run();

  const warning = eventType === "flood"
    ? "Предупреждение: слишком частые сообщения. Сделай паузу, чтобы не засорять чат."
    : "Предупреждение: обнаружены повторяющиеся сообщения. Не отправляй одинаковый текст многократно.";
  await sendTelegramMessage(env, chatId, warning);
  const admins = await env.DB.prepare("SELECT telegram_id FROM admins WHERE is_active = 1").all<{ telegram_id: string }>();
  for (const admin of admins.results ?? []) {
    await sendTelegramMessage(env, Number(admin.telegram_id),
      `Антифрод: ${eventType === "flood" ? "возможный флуд" : "повторяющийся текст"}. Telegram ID: ${telegramId}. Сообщений за 10 секунд: ${recent?.count ?? 0}; повторов за 60 секунд: ${repeatedCount}. XP автоматически не списывались.`);
  }
}

async function grantAchievement(env: Env, telegramId: string, achievementId: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO user_achievements (telegram_id, achievement_id, earned_at)
    SELECT ?, id, ? FROM achievements WHERE id = ? AND is_active = 1`)
    .bind(telegramId, now, achievementId).run();
}

async function logAdminAction(
  env: Env, actorId: string, action: string, targetId: string | null,
  details: Record<string, unknown>, createdAt: number
): Promise<void> {
  await env.DB.prepare(`INSERT INTO admin_logs (actor_id, action, target_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(actorId, action, targetId, JSON.stringify(details), createdAt).run();
}

async function verifyTelegramWebApp(env: Env, initData: string): Promise<{ id: string; first_name: string; username?: string } | null> {
  if (!env.TELEGRAM_BOT_TOKEN || !initData || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));
    const userJson = params.get("user");
    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !userJson ||
      !Number.isSafeInteger(authDate)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (authDate > now + 60 || now - authDate > 86400) return null;

    const dataCheckString = [...params.entries()]
      .filter(([key]) => key !== "hash" && key !== "signature")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const encoder = new TextEncoder();
    const webAppKey = await crypto.subtle.importKey(
      "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(env.TELEGRAM_BOT_TOKEN));
    const signingKey = await crypto.subtle.importKey(
      "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const digest = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(dataCheckString));
    const calculatedHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    let mismatch = calculatedHash.length ^ receivedHash.length;
    for (let i = 0; i < Math.min(calculatedHash.length, receivedHash.length); i++) {
      mismatch |= calculatedHash.charCodeAt(i) ^ receivedHash.charCodeAt(i);
    }
    if (mismatch !== 0) return null;
    const user = JSON.parse(userJson) as { id?: number; first_name?: string; username?: string };
    if (!Number.isSafeInteger(user.id) || !user.id) return null;
    return { id: String(user.id), first_name: user.first_name ?? "", username: user.username };
  } catch {
    return null;
  }
}

async function authorizeWebAdmin(
  c: import("hono").Context<{ Bindings: Env }>, permission = "panel.access"
): Promise<string | null> {
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("tma ")) return null;
  const user = await verifyTelegramWebApp(c.env, authorization.slice(4));
  if (!user || !(await hasPermission(c.env, user.id, permission))) return null;
  return user.id;
}

async function getAdmin(env: Env, telegramId: string): Promise<{ role: string; permissions_json: string } | null> {
  if (env.OWNER_TELEGRAM_ID && telegramId === env.OWNER_TELEGRAM_ID) {
    return { role: "owner", permissions_json: '["*"]' };
  }
  return env.DB.prepare("SELECT role, permissions_json FROM admins WHERE telegram_id = ? AND is_active = 1")
    .bind(telegramId).first<{ role: string; permissions_json: string }>();
}

async function hasPermission(env: Env, telegramId: string, permission: string): Promise<boolean> {
  const admin = await getAdmin(env, telegramId);
  if (!admin) return false;
  let permissions: string[] = [];
  try { permissions = JSON.parse(admin.permissions_json) as string[]; } catch { permissions = []; }
  if (permissions.includes("*") || permissions.includes(permission)) return true;
  const roleDefaults: Record<string, string[]> = {
    owner: ["*"],
    chief_admin: ["*"],
    admin: ["panel.access", "stats.view", "members.view", "shop.manage", "shop.review", "penalty.propose", "penalty.review", "antifraud.review", "rewards.award"],
    moderator: ["panel.access", "stats.view", "members.view", "penalty.propose", "penalty.review", "antifraud.review"]
  };
  const defaults = roleDefaults[admin.role] ?? [];
  return defaults.includes("*") || defaults.includes(permission);
}

async function isAdmin(env: Env, telegramId: string): Promise<boolean> {
  return Boolean(await getAdmin(env, telegramId));
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
      ? `Магазин НК\n${lines.join("\n")}\nПокупка: /buy ID`
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
      env.DB.prepare(`INSERT OR IGNORE INTO reward_purchases (telegram_id, reward_id, price_xp, status, created_at, telegram_update_id)
        SELECT ?, r.id, r.price_xp, 'pending', ?, ?
        FROM rewards r JOIN xp_wallets w ON w.telegram_id = ?
        WHERE r.id = ? AND r.is_active = 1 AND (r.quantity IS NULL OR r.quantity > 0)
          AND w.available_xp >= r.price_xp`).bind(telegramId, now, update.update_id, telegramId, rewardId),
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
      const existing = await env.DB.prepare("SELECT id FROM reward_purchases WHERE telegram_update_id = ?")
        .bind(update.update_id).first<{ id: number }>();
      await sendTelegramMessage(env, m.chat.id, existing
        ? `Заявка #${existing.id} уже создана для этой команды.`
        : "Не удалось оформить покупку: проверь ID товара, наличие и баланс XP.");
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
        `Новая покупка #${purchaseId}: ${purchase?.title ?? "товар"} за ${purchase?.price_xp ?? "—"} XP. Участник: ${buyer}.\nОдобрить: /approve ${purchaseId}\nОтклонить: /reject ${purchaseId}`);
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
    await sendTelegramMessage(env, m.chat.id, lines.length ? `Твои заявки:\n${lines.join("\n")}` : "У тебя пока нет покупок.");
    return true;
  }

  if (command === "/penalty") {
    if (!(await hasPermission(env, telegramId, "penalty.propose"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const match = args.trim().match(/^(\d+)\s+(\d+)\s*\|\s*(.+)$/);
    if (!match) {
      await sendTelegramMessage(env, m.chat.id, "Формат: /penalty TELEGRAM_ID сумма_XP | причина");
      return true;
    }
    const targetId = match[1];
    const amount = Number(match[2]);
    const reason = match[3].trim();
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000 || reason.length < 3) {
      await sendTelegramMessage(env, m.chat.id, "Проверь сумму (1–10000 XP) и причину.");
      return true;
    }
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO penalties
      (telegram_id, suggested_amount, reason, status, proposed_by, created_at, telegram_update_id)
      SELECT ?, ?, ?, 'pending', ?, ?, ? FROM users WHERE telegram_id = ?`)
      .bind(targetId, amount, reason, telegramId, now, update.update_id, targetId).run();
    const penaltyId = result.meta.changes ? result.meta.last_row_id :
      (await env.DB.prepare("SELECT id FROM penalties WHERE telegram_update_id = ?")
        .bind(update.update_id).first<{ id: number }>())?.id;
    if (!penaltyId) {
      await sendTelegramMessage(env, m.chat.id, "Участник с таким Telegram ID не найден.");
      return true;
    }
    if (result.meta.changes) {
      await logAdminAction(env, telegramId, "penalty_proposed", String(penaltyId), { targetId, amount, reason }, now);
    }
    await sendTelegramMessage(env, m.chat.id, `Штраф #${penaltyId} создан и ожидает подтверждения. XP пока не списаны.`);
    return true;
  }

  if (command === "/pendingpenalties") {
    if (!(await hasPermission(env, telegramId, "penalty.review"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const result = await env.DB.prepare(`SELECT p.id, p.telegram_id, p.suggested_amount, p.reason
      FROM penalties p WHERE p.status = 'pending' ORDER BY p.created_at ASC LIMIT 20`).all<{
        id: number; telegram_id: string; suggested_amount: number; reason: string;
      }>();
    const lines = (result.results ?? []).map(p =>
      `#${p.id} · ID ${p.telegram_id} · ${p.suggested_amount} XP · ${p.reason}`);
    await sendTelegramMessage(env, m.chat.id,
      lines.length ? `Штрафы на подтверждение:\n${lines.join("\n")}\n/approvepenalty ID или /rejectpenalty ID` : "Нет штрафов на подтверждение.");
    return true;
  }

  if (command === "/approvepenalty" || command === "/rejectpenalty") {
    if (!(await hasPermission(env, telegramId, "penalty.review"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const penaltyId = Number(args.trim());
    if (!Number.isSafeInteger(penaltyId) || penaltyId < 1) {
      await sendTelegramMessage(env, m.chat.id, `Формат: ${command} ID`);
      return true;
    }
    if (command === "/rejectpenalty") {
      const result = await env.DB.prepare(`UPDATE penalties SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
        WHERE id = ? AND status = 'pending'`).bind(telegramId, now, penaltyId).run();
      if ((result.meta.changes ?? 0) > 0) {
        await logAdminAction(env, telegramId, "penalty_rejected", String(penaltyId), {}, now);
      }
      await sendTelegramMessage(env, m.chat.id, (result.meta.changes ?? 0) > 0
        ? `Штраф #${penaltyId} отклонён. XP не списывались.` : "Штраф не найден или уже обработан.");
      return true;
    }
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE penalties SET status = 'approved', approved_amount = suggested_amount,
        reviewed_by = ?, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM xp_wallets w WHERE w.telegram_id = penalties.telegram_id
            AND w.available_xp >= penalties.suggested_amount)`).bind(telegramId, now, penaltyId),
      env.DB.prepare(`INSERT INTO xp_transactions
        (telegram_id, amount, transaction_type, source_id, note, created_at)
        SELECT telegram_id, -approved_amount, 'penalty', CAST(id AS TEXT), reason, ?
        FROM penalties WHERE id = ? AND status = 'approved' AND changes() = 1`).bind(now, penaltyId),
      env.DB.prepare(`UPDATE xp_wallets SET available_xp = available_xp +
        (SELECT amount FROM xp_transactions WHERE transaction_type = 'penalty' AND source_id = ?)
        WHERE telegram_id = (SELECT telegram_id FROM penalties WHERE id = ?)
          AND changes() = 1`).bind(String(penaltyId), penaltyId)
    ]);
    if ((results[0]?.meta.changes ?? 0) > 0) {
      await logAdminAction(env, telegramId, "penalty_approved", String(penaltyId), {}, now);
      await sendTelegramMessage(env, m.chat.id, `Штраф #${penaltyId} подтверждён. XP списаны.`);
    } else {
      const pending = await env.DB.prepare("SELECT status FROM penalties WHERE id = ?").bind(penaltyId)
        .first<{ status: string }>();
      await sendTelegramMessage(env, m.chat.id, pending?.status === "pending"
        ? "Недостаточно доступных XP у участника — штраф оставлен на рассмотрении."
        : "Штраф не найден или уже обработан.");
    }
    return true;
  }

  if (command === "/adminstats") {
    if (!(await hasPermission(env, telegramId, "stats.view"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const day = moscowDay(now);
    const [users, messages, xp, pending, season] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE is_active = 1").first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM message_events WHERE event_day = ?").bind(day).first<{ total: number }>(),
      env.DB.prepare("SELECT COALESCE(SUM(lifetime_xp), 0) AS total FROM xp_wallets").first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM reward_purchases WHERE status = 'pending'").first<{ total: number }>(),
      env.DB.prepare("SELECT title, ends_at FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
        .first<{ title: string; ends_at: number }>()
    ]);
    const seasonEnd = season ? new Date(season.ends_at * 1000).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) : "не создан";
    await sendTelegramMessage(env, m.chat.id,
      `Статистика НК Activity\nУчастников: ${users?.total ?? 0}\nСообщений сегодня: ${messages?.total ?? 0}\nLifetime XP в системе: ${xp?.total ?? 0}\nОжидают покупки: ${pending?.total ?? 0}\nСезон: ${season?.title ?? "—"} (до ${seasonEnd})`);
    return true;
  }

  if (command === "/pending") {
    if (!(await hasPermission(env, telegramId, "shop.review"))) {
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
      lines.length ? `Ожидают решения:\n${lines.join("\n")}\n/approve ID или /reject ID` : "Нет ожидающих заявок.");
    return true;
  }

  if (command === "/addreward") {
    if (!(await hasPermission(env, telegramId, "shop.manage"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return true;
    }
    const parts = args.split("|").map(part => part.trim());
    const [category, title, rawPrice, description = "", rawQuantity = ""] = parts;
    const price = Number(rawPrice);
    const quantity = rawQuantity ? Number(rawQuantity) : null;
    if (!category || !title || title.length > 80 || !Number.isSafeInteger(price) || price < 1 ||
      (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1))) {
      await sendTelegramMessage(env, m.chat.id, "Формат: /addreward категория | название | цена_XP | описание | количество (необязательно)");
      return true;
    }
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO rewards
      (title, description, category, price_xp, quantity, is_active, telegram_update_id)
      VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(title, description, category, price, quantity, update.update_id).run();
    const rewardId = result.meta.changes ? result.meta.last_row_id :
      (await env.DB.prepare("SELECT id FROM rewards WHERE telegram_update_id = ?")
        .bind(update.update_id).first<{ id: number }>())?.id;
    if (result.meta.changes) {
      await logAdminAction(env, telegramId, "reward_created", String(rewardId ?? ""), { title, category, price }, now);
    }
    await sendTelegramMessage(env, m.chat.id, rewardId
      ? `Товар добавлен. ID: ${rewardId}` : "Не удалось добавить товар.");
    return true;
  }

  if (command === "/approve" || command === "/reject") {
    if (!(await hasPermission(env, telegramId, "shop.review"))) {
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
      if ((result.meta.changes ?? 0) > 0) {
        await logAdminAction(env, telegramId, "purchase_approved", String(purchaseId), {}, now);
      }
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
    if ((results[0]?.meta.changes ?? 0) > 0) {
      await logAdminAction(env, telegramId, "purchase_rejected", String(purchaseId), {}, now);
    }
    await sendTelegramMessage(env, m.chat.id, (results[0]?.meta.changes ?? 0) > 0
      ? `Заявка #${purchaseId} отклонена, XP возвращены.`
      : "Заявка не найдена или уже обработана.");
    return true;
  }
  return false;
}

async function sendAdminPanelButton(env: Env, chatId: number): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.WEB_ADMIN_URL || !env.WEB_ADMIN_URL.startsWith("https://")) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Панель администратора НК Activity. Доступ проверяется через Telegram.",
      reply_markup: {
        inline_keyboard: [[{ text: "Открыть админ-панель", web_app: { url: env.WEB_ADMIN_URL } }]]
      }
    })
  });
  if (!response.ok) console.error("Telegram admin panel button failed", response.status);
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
      .bind(telegramId, m.from.username ?? null, m.from.first_name ?? "", m.from.last_name ?? null, m.date, m.date),
    env.DB.prepare(`UPDATE users SET username = ?, first_name = ?, last_name = ?, last_seen_at = ?
      WHERE telegram_id = ?`)
      .bind(m.from.username ?? null, m.from.first_name ?? "", m.from.last_name ?? null, m.date, telegramId),
    env.DB.prepare("INSERT OR IGNORE INTO user_stats (telegram_id) VALUES (?)").bind(telegramId),
    env.DB.prepare("INSERT OR IGNORE INTO xp_wallets (telegram_id) VALUES (?)").bind(telegramId)
  ]);

  // Persist the Telegram event first. A retry can resume rewards without double-counting stats.
  const messageHash = await hashMessageText(m.text);
  await env.DB.prepare(`INSERT OR IGNORE INTO message_events
    (telegram_id, chat_id, message_id, event_day, created_at, message_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(telegramId, chatId, messageId, day, m.date, messageHash).run();

  await env.DB.batch([
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
      WHERE telegram_id = ? AND EXISTS (
        SELECT 1 FROM message_events WHERE chat_id = ? AND message_id = ? AND stats_applied = 0
      )`).bind(day, day, day, day, day, telegramId, chatId, messageId),
    env.DB.prepare(`UPDATE message_events SET
      stats_applied = 1,
      message_count_snapshot = (SELECT message_count FROM user_stats WHERE telegram_id = ?),
      streak_snapshot = (SELECT current_streak FROM user_stats WHERE telegram_id = ?)
      WHERE chat_id = ? AND message_id = ? AND stats_applied = 0 AND changes() = 1`)
      .bind(telegramId, telegramId, chatId, messageId)
  ]);
  const eventStats = await env.DB.prepare(`SELECT message_count_snapshot, streak_snapshot
    FROM message_events WHERE chat_id = ? AND message_id = ?`)
    .bind(chatId, messageId).first<{ message_count_snapshot: number | null; streak_snapshot: number | null }>();
  const count = eventStats?.message_count_snapshot ?? 0;
  const streak = eventStats?.streak_snapshot ?? 0;
  await detectFlood(env, telegramId, m.chat.id, m.date, messageHash);

  await awardDailyXp(env, telegramId, day, "message", sourceKey,
    await getSetting(env, "message_xp", DEFAULT_MESSAGE_XP), "XP за сообщение", m.date);

  // Daily activity and message-count milestones share the same 200 XP daily cap.
  await awardDailyXp(env, telegramId, day, "daily_activity", day, 15, "Ежедневная активность", m.date);
  const dailyCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM message_events WHERE telegram_id = ? AND event_day = ?"
  ).bind(telegramId, day).first<{ count: number }>();
  const dailyCount = dailyCountRow?.count ?? 0;
  const milestones = dailyMessageMilestones(dailyCount);
  for (const milestone of milestones) {
    await awardDailyXp(env, telegramId, day, "message_milestone",
      `${milestone.sourceKey}:${day}`, milestone.amount, milestone.note, m.date);
  }
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
    ORDER BY reward_day DESC LIMIT 10000`).bind(telegramId).all<{ reward_day: string }>();
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
    ? `Ежедневная награда: +${granted} XP. День серии: ${streak}.`
    : "Дневной лимит XP уже достигнут. Награда отмечена, но XP сегодня не начислены.";
}

async function awardSpecialXp(
  env: Env,
  targetId: string,
  amount: number,
  transactionType: "event_bonus" | "contest_bonus",
  sourceId: string,
  note: string,
  actorId: string,
  now: number
): Promise<boolean> {
  await ensureActiveSeason(env, now);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO xp_transactions
      (telegram_id, amount, transaction_type, source_id, note, created_at, created_by)
      SELECT telegram_id, ?, ?, ?, ?, ?, ? FROM users WHERE telegram_id = ? AND is_active = 1`)
      .bind(amount, transactionType, sourceId, note, now, actorId, targetId),
    env.DB.prepare(`UPDATE xp_wallets SET lifetime_xp = lifetime_xp + ?,
      available_xp = available_xp + ?, season_xp = season_xp + ?
      WHERE telegram_id = ? AND changes() = 1`)
      .bind(amount, amount, amount, targetId),
    env.DB.prepare(`INSERT INTO season_stats (season_id, telegram_id, season_xp)
      SELECT id, ?, ? FROM seasons WHERE status = 'active' AND changes() = 1
      ON CONFLICT(season_id, telegram_id) DO UPDATE SET season_xp = season_xp + excluded.season_xp`)
      .bind(targetId, amount)
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) return false;
  await logAdminAction(env, actorId, transactionType, targetId, { amount, note, sourceId }, now);
  return true;
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

  if (command === "/eventxp" || command === "/contestxp") {
    if (!(await hasPermission(env, telegramId, "rewards.award"))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return;
    }
    const match = text.match(/^\/((?:eventxp)|(?:contestxp))\s+(\d+)(?:\s*\|\s*(.{3,120}))?$/i);
    if (!match) {
      await sendTelegramMessage(env, m.chat.id,
        "Формат: /eventxp TELEGRAM_ID | причина ( +30 XP ) или /contestxp TELEGRAM_ID | причина ( +100 XP ).");
      return;
    }
    const targetId = match[2];
    const isEvent = command === "/eventxp";
    const amount = isEvent ? 30 : 100;
    const reason = (match[3] ?? (isEvent ? "Участие в событии" : "Победа в конкурсе")).trim();
    const sourceId = `${isEvent ? "event" : "contest"}:${update.update_id}`;
    const granted = await awardSpecialXp(
      env, targetId, amount, isEvent ? "event_bonus" : "contest_bonus",
      sourceId, reason, telegramId, m.date
    );
    if (!granted) {
      const existing = await env.DB.prepare(`SELECT id FROM xp_transactions
        WHERE telegram_id = ? AND transaction_type = ? AND source_id = ?`)
        .bind(targetId, isEvent ? "event_bonus" : "contest_bonus", sourceId)
        .first<{ id: number }>();
      await sendTelegramMessage(env, m.chat.id, existing
        ? "Эта награда уже была обработана."
        : "Участник не найден, неактивен или его профиль ещё не создан.");
      return;
    }
    await sendTelegramMessage(env, m.chat.id,
      `Награда начислена участнику ${targetId}: +${amount} XP. Причина: ${reason}. Дневной лимит обычной активности не затронут.`);
    return;
  }

  if (command === "/adminpanel") {
    if (!(await isAdmin(env, telegramId))) {
      await sendTelegramMessage(env, m.chat.id, "Недостаточно прав.");
      return;
    }
    if (m.chat.type !== "private") {
      await sendTelegramMessage(env, m.chat.id, "Открой личный диалог с ботом и отправь /adminpanel.");
      return;
    }
    if (!env.WEB_ADMIN_URL || !env.WEB_ADMIN_URL.startsWith("https://")) {
      await sendTelegramMessage(env, m.chat.id, "Ссылка на веб-панель ещё не настроена. Добавь WEB_ADMIN_URL в переменные Worker после деплоя.");
      return;
    }
    await sendAdminPanelButton(env, m.chat.id);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, m.chat.id,
      "НК Activity — система активности сообщества.\n/profile — профиль и XP.\n/achievements — твои достижения.\n/daily — ежедневная награда.\n/shop — магазин.\n/buy ID — купить товар.\n/myorders — мои покупки.\n/pending — заявки на проверку (админ).\n/adminstats — статистика (админ).\n/penalty ID сумма | причина — предложить штраф (админ).\n/pendingpenalties — очередь штрафов (админ).\n/approvepenalty ID или /rejectpenalty ID (админ).\n/addreward категория | название | цена | описание | количество (админ).\n/approve ID или /reject ID (админ).\n/top — общий топ-10.\n/topseason — рейтинг сезона.\n/topday, /topweek, /topmonth — рейтинги за периоды.\n/topachievements, /topstreaks — рейтинги достижений и серий.\n/myrewards — история специальных наград.\n/myrank — твоё место в рейтингах.\n/adminpanel — веб-панель (админ).");
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
      lines.length ? `Твои достижения:\n${lines.join("\n")}` : "Пока нет достижений. Продолжай общаться в группе.");
    return;
  }
  if (command === "/myrewards") {
    const result = await env.DB.prepare(`SELECT reward_type, title, period_key, created_at
      FROM member_rewards WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(telegramId).all<{ reward_type: string; title: string; period_key: string; created_at: number }>();
    const lines = (result.results ?? []).map(item =>
      `• ${item.title} · ${item.reward_type === "prefix" ? "префикс" : "достижение"}`);
    await sendTelegramMessage(env, m.chat.id,
      lines.length ? `Твои награды:\n${lines.join("\n")}` : "У тебя пока нет сезонных или месячных наград.");
    return;
  }
  if (command === "/profile" || command === "/me") {
    const row = await env.DB.prepare(`SELECT u.first_name, u.last_name, u.username, s.message_count,
      s.current_streak, s.longest_streak, w.lifetime_xp, w.available_xp, w.season_xp,
      (SELECT COUNT(*) FROM user_achievements a WHERE a.telegram_id = u.telegram_id) AS achievements,
      (SELECT title FROM member_rewards mr WHERE mr.telegram_id = u.telegram_id AND mr.reward_type = 'prefix'
        ORDER BY mr.created_at DESC LIMIT 1) AS prefix_title
      FROM users u JOIN user_stats s ON s.telegram_id = u.telegram_id
      JOIN xp_wallets w ON w.telegram_id = u.telegram_id WHERE u.telegram_id = ?`)
      .bind(telegramId).first<{
        first_name: string; last_name: string | null; username: string | null; message_count: number;
        current_streak: number; longest_streak: number; lifetime_xp: number;
        available_xp: number; season_xp: number; achievements: number; prefix_title: string | null;
      }>();
    if (!row) {
      await sendTelegramMessage(env, m.chat.id, "Профиль пока не создан. Напиши сообщение в основной группе и повтори команду.");
      return;
    }
    const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ") || (row.username ? `@${row.username}` : "Участник");
    const thresholds = validateLevelThresholds(await getSetting<unknown>(env, "level_thresholds", {})) ?? {};
    const level = getLevelProgress(row.lifetime_xp, thresholds);
    const levelLine = level
      ? `Уровень: ${level.level} · ${level.title}${level.xpToNext === null ? "\nМаксимальный настроенный уровень" : `\nДо уровня ${level.nextLevel}: ${level.xpToNext} XP`}`
      : "Уровень: ещё не настроен администратором";
    await sendTelegramMessage(env, m.chat.id,
      `Профиль: ${displayName}\n${levelLine}\nПрефикс: ${row.prefix_title ?? "нет"}\nLifetime XP: ${row.lifetime_xp}\nДоступно: ${row.available_xp} XP\nСезон: ${row.season_xp} XP\nСообщений: ${row.message_count}\nСерия активности: ${row.current_streak} дн. (рекорд: ${row.longest_streak})\nДостижения: ${row.achievements}`);
    return;
  }
  if (command === "/myrank") {
    await ensureActiveSeason(env, m.date);
    const allTime = await env.DB.prepare(`SELECT place FROM (
      SELECT w.telegram_id, ROW_NUMBER() OVER (ORDER BY w.lifetime_xp DESC, u.joined_at ASC) AS place
      FROM xp_wallets w JOIN users u ON u.telegram_id = w.telegram_id
    ) WHERE telegram_id = ?`).bind(telegramId).first<{ place: number }>();
    const season = await env.DB.prepare(`SELECT place FROM (
      SELECT ss.telegram_id, ROW_NUMBER() OVER (ORDER BY ss.season_xp DESC, u.joined_at ASC) AS place
      FROM season_stats ss JOIN users u ON u.telegram_id = ss.telegram_id
      JOIN seasons s ON s.id = ss.season_id WHERE s.status = 'active'
    ) WHERE telegram_id = ?`).bind(telegramId).first<{ place: number }>();
    await sendTelegramMessage(env, m.chat.id,
      `Твоё место в общем рейтинге: ${allTime?.place ? `#${allTime.place}` : "пока нет"}\nТвоё место в сезоне: ${season?.place ? `#${season.place}` : "пока нет"}`);
    return;
  }

  const rankingCommands = ["/top", "/rating", "/topseason", "/topday", "/topweek", "/topmonth", "/topachievements", "/topstreaks"];
  if (rankingCommands.includes(command)) {
    const today = moscowDay(m.date);
    const [year, month, date] = today.split("-").map(Number);
    const dayStart = Math.floor(Date.UTC(year, month - 1, date) / 1000) - 3 * 60 * 60;
    const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const weekStart = dayStart - mondayOffset * 86400;
    const monthStart = Math.floor(Date.UTC(year, month - 1, 1) / 1000) - 3 * 60 * 60;
    let title = "Общий топ НК";
    let suffix = "XP";
    let result: { results?: Array<{ first_name: string; username: string | null; value: number; joined_at?: number }> };
    if (command === "/topseason") {
      await ensureActiveSeason(env, m.date);
      title = "Топ сезона НК";
      const query = await env.DB.prepare(`SELECT u.first_name, u.username, ss.season_xp AS value, u.joined_at
        FROM season_stats ss JOIN users u ON u.telegram_id = ss.telegram_id
        JOIN seasons s ON s.id = ss.season_id WHERE s.status = 'active'
        ORDER BY ss.season_xp DESC, u.joined_at ASC LIMIT 10`).all<{
          first_name: string; username: string | null; value: number; joined_at: number;
        }>();
      result = query;
    } else if (command === "/topday" || command === "/topweek" || command === "/topmonth") {
      const since = command === "/topday" ? dayStart : command === "/topweek" ? weekStart : monthStart;
      title = command === "/topday" ? "Топ за сегодня" : command === "/topweek" ? "Топ за неделю" : "Топ за месяц";
      const query = await env.DB.prepare(`SELECT u.first_name, u.username, SUM(x.amount) AS value, u.joined_at
        FROM xp_transactions x JOIN users u ON u.telegram_id = x.telegram_id
        WHERE x.amount > 0 AND x.transaction_type NOT IN ('purchase_refund', 'weekly_reward', 'season_reward') AND x.created_at >= ?
        GROUP BY x.telegram_id ORDER BY value DESC, u.joined_at ASC LIMIT 10`).bind(since).all<{
          first_name: string; username: string | null; value: number; joined_at: number;
        }>();
      result = query;
    } else if (command === "/topachievements") {
      title = "Топ по достижениям";
      suffix = "ач.";
      const query = await env.DB.prepare(`SELECT u.first_name, u.username, COUNT(ua.achievement_id) AS value, u.joined_at
        FROM users u LEFT JOIN user_achievements ua ON ua.telegram_id = u.telegram_id
        GROUP BY u.telegram_id ORDER BY value DESC, u.joined_at ASC LIMIT 10`).all<{
          first_name: string; username: string | null; value: number; joined_at: number;
        }>();
      result = query;
    } else if (command === "/topstreaks") {
      title = "Топ по сериям активности";
      suffix = "дн.";
      const query = await env.DB.prepare(`SELECT u.first_name, u.username, s.longest_streak AS value, u.joined_at
        FROM user_stats s JOIN users u ON u.telegram_id = s.telegram_id
        ORDER BY s.longest_streak DESC, s.current_streak DESC, u.joined_at ASC LIMIT 10`).all<{
          first_name: string; username: string | null; value: number; joined_at: number;
        }>();
      result = query;
    } else {
      const query = await env.DB.prepare(`SELECT u.first_name, u.username, w.lifetime_xp AS value, u.joined_at
        FROM xp_wallets w JOIN users u ON u.telegram_id = w.telegram_id
        ORDER BY w.lifetime_xp DESC, u.joined_at ASC LIMIT 10`).all<{
          first_name: string; username: string | null; value: number; joined_at: number;
        }>();
      result = query;
    }
    const lines = (result.results ?? []).map((row, i) =>
      `${i + 1}. ${row.first_name || (row.username ? `@${row.username}` : "Участник")} — ${row.value} ${suffix}`);
    await sendTelegramMessage(env, m.chat.id, lines.length ? `${title}\n${lines.join("\n")}` : "Рейтинг пока пуст.");
  }
}

app.get("/api/admin/dashboard", async c => {
  const actorId = await authorizeWebAdmin(c, "stats.view");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  const now = Math.floor(Date.now() / 1000);
  const day = moscowDay(now);
  await ensureActiveSeason(c.env, now);
  const [users, messages, xp, pendingPurchases, pendingPenalties, season, top, purchases, penalties, logs, fraudEvents] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE is_active = 1").first<{ total: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM message_events WHERE event_day = ?").bind(day).first<{ total: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(lifetime_xp), 0) AS total FROM xp_wallets").first<{ total: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM reward_purchases WHERE status = 'pending'").first<{ total: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM penalties WHERE status = 'pending'").first<{ total: number }>(),
    c.env.DB.prepare("SELECT title, starts_at, ends_at FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1")
      .first<{ title: string; starts_at: number; ends_at: number }>(),
    c.env.DB.prepare(`SELECT u.telegram_id, u.first_name, u.username, w.lifetime_xp, w.available_xp
      FROM xp_wallets w JOIN users u ON u.telegram_id = w.telegram_id
      ORDER BY w.lifetime_xp DESC, u.joined_at ASC LIMIT 10`).all<{
        telegram_id: string; first_name: string; username: string | null; lifetime_xp: number; available_xp: number;
      }>(),
    c.env.DB.prepare(`SELECT p.id, p.price_xp, p.created_at, r.title, u.telegram_id, u.first_name, u.username
      FROM reward_purchases p JOIN rewards r ON r.id = p.reward_id
      JOIN users u ON u.telegram_id = p.telegram_id WHERE p.status = 'pending'
      ORDER BY p.created_at ASC LIMIT 20`).all<{
        id: number; price_xp: number; created_at: number; title: string; telegram_id: string;
        first_name: string; username: string | null;
      }>(),
    c.env.DB.prepare(`SELECT p.id, p.suggested_amount, p.reason, p.created_at, u.telegram_id, u.first_name, u.username
      FROM penalties p JOIN users u ON u.telegram_id = p.telegram_id WHERE p.status = 'pending'
      ORDER BY p.created_at ASC LIMIT 20`).all<{
        id: number; suggested_amount: number; reason: string; created_at: number; telegram_id: string;
        first_name: string; username: string | null;
      }>(),
    c.env.DB.prepare(`SELECT actor_id, action, target_id, details_json, created_at
      FROM admin_logs ORDER BY id DESC LIMIT 12`).all<{
        actor_id: string; action: string; target_id: string | null; details_json: string; created_at: number;
      }>(),
    c.env.DB.prepare(`SELECT id, telegram_id, event_type, details_json, created_at
      FROM anti_fraud_events WHERE reviewed_at IS NULL ORDER BY id DESC LIMIT 15`).all<{
        id: number; telegram_id: string; event_type: string; details_json: string; created_at: number;
      }>()
  ]);
  return c.json({
    ok: true,
    stats: {
      users: users?.total ?? 0, messagesToday: messages?.total ?? 0,
      lifetimeXp: xp?.total ?? 0, pendingPurchases: pendingPurchases?.total ?? 0,
      pendingPenalties: pendingPenalties?.total ?? 0
    },
    season: season ?? null,
    top: top.results ?? [],
    purchases: purchases.results ?? [],
    penalties: penalties.results ?? [],
    logs: logs.results ?? [],
    fraudEvents: fraudEvents.results ?? [],
    settings: {
      messageXp: await getSetting(c.env, "message_xp", DEFAULT_MESSAGE_XP),
      dailyXpCap: await getSetting(c.env, "daily_xp_cap", DEFAULT_DAILY_CAP),
      seasonDays: await getSetting(c.env, "season_days", 30),
      levelThresholds: await getSetting(c.env, "level_thresholds", {}),
      seasonRewardSchedule: await getSetting(c.env, "season_reward_schedule", {})
    },
    permissions: {
      shopReview: await hasPermission(c.env, actorId, "shop.review"),
      penaltyReview: await hasPermission(c.env, actorId, "penalty.review"),
      antifraudReview: await hasPermission(c.env, actorId, "antifraud.review"),
      settingsManage: await hasPermission(c.env, actorId, "settings.manage"),
      membersView: await hasPermission(c.env, actorId, "members.view")
    }
  });
});

app.get("/api/admin/members", async c => {
  const actorId = await authorizeWebAdmin(c, "members.view");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  const query = (c.req.query("q") ?? "").trim().slice(0, 64);
  const result = await c.env.DB.prepare(`SELECT u.telegram_id, u.username, u.first_name, u.last_name,
      u.joined_at, u.last_seen_at, u.is_active, s.message_count, s.current_streak, s.longest_streak,
      w.lifetime_xp, w.available_xp, w.season_xp
    FROM users u
    LEFT JOIN user_stats s ON s.telegram_id = u.telegram_id
    LEFT JOIN xp_wallets w ON w.telegram_id = u.telegram_id
    WHERE (? = '' OR instr(lower(u.telegram_id), lower(?)) > 0
      OR instr(lower(COALESCE(u.username, '')), lower(?)) > 0
      OR instr(lower(COALESCE(u.first_name, '')), lower(?)) > 0
      OR instr(lower(COALESCE(u.last_name, '')), lower(?)) > 0)
    ORDER BY u.last_seen_at DESC, u.joined_at DESC LIMIT 30`)
    .bind(query, query, query, query, query).all<{
      telegram_id: string; username: string | null; first_name: string | null; last_name: string | null;
      joined_at: number; last_seen_at: number | null; is_active: number; message_count: number | null;
      current_streak: number | null; longest_streak: number | null; lifetime_xp: number | null;
      available_xp: number | null; season_xp: number | null;
    }>();
  return c.json({ ok: true, members: result.results ?? [], query });
});

app.post("/api/admin/settings", async c => {
  const actorId = await authorizeWebAdmin(c, "settings.manage");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  let body: { messageXp?: number; dailyXpCap?: number; seasonDays?: number; levelThresholds?: unknown; seasonRewardSchedule?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const messageXp = Number(body.messageXp);
  const dailyXpCap = Number(body.dailyXpCap);
  const seasonDays = Number(body.seasonDays);
  const levelThresholds = validateLevelThresholds(body.levelThresholds);
  const seasonRewardSchedule = validateSeasonRewardSchedule(body.seasonRewardSchedule);
  if (!levelThresholds || !seasonRewardSchedule || !Number.isSafeInteger(messageXp) || messageXp < 1 || messageXp > 20 ||
      !Number.isSafeInteger(dailyXpCap) || dailyXpCap < 50 || dailyXpCap > 5000 ||
      !Number.isSafeInteger(seasonDays) || seasonDays < 7 || seasonDays > 90) {
    return c.json({ error: "invalid_settings" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO settings (key, value_json, updated_at, updated_by)
      VALUES ('message_xp', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(messageXp), now, actorId),
    c.env.DB.prepare(`INSERT INTO settings (key, value_json, updated_at, updated_by)
      VALUES ('daily_xp_cap', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(dailyXpCap), now, actorId),
    c.env.DB.prepare(`INSERT INTO settings (key, value_json, updated_at, updated_by)
      VALUES ('season_days', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(seasonDays), now, actorId),
    c.env.DB.prepare(`INSERT INTO settings (key, value_json, updated_at, updated_by)
      VALUES ('level_thresholds', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(levelThresholds), now, actorId),
    c.env.DB.prepare("INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('season_reward_schedule', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(JSON.stringify(seasonRewardSchedule), now, actorId)
  ]);
  await logAdminAction(c.env, actorId, "settings_updated", null,
    { messageXp, dailyXpCap, seasonDays, configuredLevels: Object.keys(levelThresholds).length, seasonRewardPlaces: Object.keys(seasonRewardSchedule).length }, now);
  return c.json({ ok: true });
});

app.post("/api/admin/purchases/:id/:action", async c => {
  const actorId = await authorizeWebAdmin(c, "shop.review");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  const action = c.req.param("action");
  if (!Number.isSafeInteger(id) || id < 1 || !["approve", "reject"].includes(action)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  if (action === "approve") {
    const result = await c.env.DB.prepare("UPDATE reward_purchases SET status = 'approved' WHERE id = ? AND status = 'pending'")
      .bind(id).run();
    if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not_pending" }, 409);
    await logAdminAction(c.env, actorId, "purchase_approved", String(id), { source: "web_admin" }, now);
    return c.json({ ok: true });
  }
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE reward_purchases SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(id),
    c.env.DB.prepare(`INSERT OR IGNORE INTO xp_transactions
      (telegram_id, amount, transaction_type, source_id, note, created_at)
      SELECT telegram_id, price_xp, 'purchase_refund', CAST(id AS TEXT), 'Возврат за отклонённую покупку', ?
      FROM reward_purchases WHERE id = ? AND status = 'rejected' AND changes() = 1`).bind(now, id),
    c.env.DB.prepare(`UPDATE xp_wallets SET available_xp = available_xp +
      (SELECT amount FROM xp_transactions WHERE transaction_type = 'purchase_refund' AND source_id = ?)
      WHERE telegram_id = (SELECT telegram_id FROM reward_purchases WHERE id = ?) AND changes() = 1`).bind(String(id), id),
    c.env.DB.prepare(`UPDATE rewards SET quantity = CASE WHEN quantity IS NULL THEN NULL ELSE quantity + 1 END
      WHERE id = (SELECT reward_id FROM reward_purchases WHERE id = ?) AND changes() = 1`).bind(id)
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) return c.json({ error: "not_pending" }, 409);
  await logAdminAction(c.env, actorId, "purchase_rejected", String(id), { source: "web_admin" }, now);
  return c.json({ ok: true });
});

app.post("/api/admin/antifraud/:id/review", async c => {
  const actorId = await authorizeWebAdmin(c, "antifraud.review");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid_request" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.DB.prepare("UPDATE anti_fraud_events SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL")
    .bind(now, id).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not_pending" }, 409);
  await logAdminAction(c.env, actorId, "antifraud_reviewed", String(id), { source: "web_admin" }, now);
  return c.json({ ok: true });
});

app.post("/api/admin/penalties/:id/:action", async c => {
  const actorId = await authorizeWebAdmin(c, "penalty.review");
  if (!actorId) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  const action = c.req.param("action");
  if (!Number.isSafeInteger(id) || id < 1 || !["approve", "reject"].includes(action)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  if (action === "reject") {
    const result = await c.env.DB.prepare(`UPDATE penalties SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'`).bind(actorId, now, id).run();
    if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not_pending" }, 409);
    await logAdminAction(c.env, actorId, "penalty_rejected", String(id), { source: "web_admin" }, now);
    return c.json({ ok: true });
  }
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE penalties SET status = 'approved', approved_amount = suggested_amount,
      reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM xp_wallets w WHERE w.telegram_id = penalties.telegram_id
          AND w.available_xp >= penalties.suggested_amount)`).bind(actorId, now, id),
    c.env.DB.prepare(`INSERT INTO xp_transactions
      (telegram_id, amount, transaction_type, source_id, note, created_at)
      SELECT telegram_id, -approved_amount, 'penalty', CAST(id AS TEXT), reason, ?
      FROM penalties WHERE id = ? AND status = 'approved' AND changes() = 1`).bind(now, id),
    c.env.DB.prepare(`UPDATE xp_wallets SET available_xp = available_xp +
      (SELECT amount FROM xp_transactions WHERE transaction_type = 'penalty' AND source_id = ?)
      WHERE telegram_id = (SELECT telegram_id FROM penalties WHERE id = ?) AND changes() = 1`).bind(String(id), id)
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const pending = await c.env.DB.prepare("SELECT status FROM penalties WHERE id = ?").bind(id)
      .first<{ status: string }>();
    return c.json({ error: pending?.status === "pending" ? "insufficient_xp" : "not_pending" }, 409);
  }
  await logAdminAction(c.env, actorId, "penalty_approved", String(id), { source: "web_admin" }, now);
  return c.json({ ok: true });
});

app.get("/", c => c.json({ service: "nk-activity", status: "ok", version: "0.4.0" }));
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

app.get("/admin", async c => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));
app.notFound(c => c.env.ASSETS.fetch(c.req.raw));
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const now = Math.floor(Date.now() / 1000);
    await ensureActiveSeason(env, now);
    await awardWeeklyRankingRewards(env, now);
    await awardMonthlyRankingRewards(env, now);
    await env.DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?")
      .bind(now - 14 * 24 * 60 * 60).run();
  }
};
