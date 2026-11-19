import { Hono } from "hono";
import type { Env, TelegramUpdate } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ service: "nk-activity", status: "ok", version: "0.1.0" }));
app.get("/health", (c) => c.json({ ok: true }));

app.post("/webhook", async (c) => {
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!expected || supplied !== expected) return c.json({ ok: false }, 401);

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  if (!Number.isSafeInteger(update.update_id)) return c.json({ ok: false }, 400);

  // Durable processing is implemented in the next module milestone.
  // Until then, acknowledge only after recording the update idempotently.
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)"
  ).bind(update.update_id, Math.floor(Date.now() / 1000)).run();

  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Cron jobs are added in the corresponding implementation stage.
    await env.DB.prepare("SELECT 1").run();
  }
};
