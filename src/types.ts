export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  OWNER_TELEGRAM_ID?: string;
  WEB_ADMIN_URL?: string;
  TARGET_CHAT_ID?: string;
  APP_TIMEZONE: string;
  APP_ENV: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
}
