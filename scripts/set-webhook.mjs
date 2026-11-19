const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const workerUrl = process.env.WORKER_URL;

if (!token || !secret || !workerUrl) {
  console.error("Required environment variables: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WORKER_URL");
  process.exit(1);
}
if (!/^https:\/\//i.test(workerUrl) || !workerUrl.endsWith("/webhook")) {
  console.error("WORKER_URL must be an HTTPS URL ending in /webhook");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET must use only A-Z, a-z, 0-9, _ or - (1–256 chars)");
  process.exit(1);
}

const endpoint = `https://api.telegram.org/bot${token}/setWebhook`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: workerUrl,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false
  })
});
const result = await response.json();
if (!response.ok || !result.ok) {
  console.error("Telegram rejected setWebhook:", result.description || response.status);
  process.exit(1);
}
console.log("Webhook configured successfully.");
console.log("URL:", workerUrl);
console.log("Pending updates preserved:", true);
