# TON Price Bot

Hourly TON/RUB price messages and ±20% alerts relative to the last alert baseline.

## Required GitHub Actions secret
Add repository secret `TELEGRAM_BOT_TOKEN`. Never commit the bot token.

## Activate
1. Enable GitHub Actions for the repository.
2. Add `TELEGRAM_BOT_TOKEN` under Settings → Secrets and variables → Actions.
3. Run the workflow once manually or wait for its scheduled run.
4. Open the bot in Telegram and send `/start`.

The workflow polls every five minutes (GitHub Actions cron is not real-time and may be delayed). Hourly summaries are sent once per UTC hour. Price source: CoinGecko public API. The first successful run establishes the baseline; each ±20% alert resets it to the alert price.

The bot persists its chat ID, update offset, baseline and hourly-send marker in `ton-price-bot/state.json` via the repository Contents API.
