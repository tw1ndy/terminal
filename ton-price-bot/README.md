# TON Price Bot

This bot is isolated in `ton-price-bot/` and uses its own workflow at
`.github/workflows/ton-price-bot.yml`. It does not modify the terminal website
(`index.html`) or the FinTrack project.

## Features

- Sends a TON/RUB summary once per UTC hour.
- Checks the TON/RUB price on each scheduled workflow run.
- Sends an alert when price changes by +20% or -20% relative to the price
  recorded at the previous alert; the alert price becomes the new baseline.
- Supports `/start`, `/help`, `/price`, and `/status`.
- Stores Telegram chat ID, update offset, alert baseline, and hourly marker in
  `ton-price-bot/state.json` using the GitHub Contents API.

## Required setup

1. Revoke any Telegram bot token that has been exposed in a chat or other public
   place. Create a replacement token with @BotFather.
2. In the `tw1ndy/terminal` repository, add the replacement as an Actions
   repository secret named `TELEGRAM_BOT_TOKEN`.
3. Ensure GitHub Actions is enabled for the repository.
4. Open the bot in Telegram and send `/start`.
5. Run the **TON Price Bot** workflow manually once from the Actions tab, or
   wait for the scheduled run.

The workflow uses the built-in `GITHUB_TOKEN` with `contents: write` to persist
its state. Do not add a separate GitHub token.

## Schedule and limitations

GitHub Actions runs this workflow on a five-minute cron schedule. GitHub may
delay scheduled workflows, so this is not a real-time feed and a rapid move can
occur between checks. Hourly summaries are sent once per UTC hour, at the first
successful check in that hour. Price data comes from CoinGecko's public API;
availability and rate limits are controlled by that provider.

The first successful run after `/start` establishes the initial alert baseline.
Each ±20% alert resets the baseline to the alert price.
