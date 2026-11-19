# НК Activity

Платформа активности и XP для Telegram-сообщества НК.

## Технологии
- Cloudflare Workers + Hono
- Cloudflare D1
- Cloudflare Pages (web admin)
- Telegram Bot API / Webhook
- TypeScript

## Команды участника
- `/start`, `/help` — справка
- `/profile`, `/me` — личная статистика
- `/top`, `/rating` — публичный топ-10

## Экономика
- Lifetime XP — суммарно заработанный опыт; определяет уровень и не уменьшается.
- Available XP — доступный баланс; расходуется на покупки и подтверждённые штрафы.
- Season XP — опыт текущего сезона; покупки его не уменьшают.
- За сообщение начисляется 3 XP, общий дневной лимит обычной активности — 200 XP.
- Дневной цикл рассчитывается по часовому поясу Europe/Moscow.
- Автоматическое списание XP запрещено.

## Локальная разработка
1. Установить Node.js 20+.
2. Выполнить `npm install`.
3. Создать новую D1-базу `nk-activity-db` в Cloudflare.
4. В `wrangler.toml` заменить `REPLACE_WITH_NEW_D1_DATABASE_ID` на ID именно этой новой базы.
5. Скопировать `.dev.vars.example` в `.dev.vars` и заполнить локальные секреты.
6. Выполнить `npm run db:local`, затем `npm run dev`.

## Секреты
Не добавляйте Telegram Bot Token, webhook secret или admin secret в Git. Для production задавайте их через Worker Secrets.

## Важно перед запуском
- Включить бота в нужную группу и выдать необходимые права.
- Настроить Telegram Webhook с secret token.
- Применить обе D1-миграции.
- Протестировать повторные Updates, дневной лимит и начисления.
- Не подключать основную группу до прохождения критических тестов.
- Старый проект `telegram-admin-bot` не используется и не изменяется.


## Подключение Cloudflare (перед первым запуском)

1. Создать отдельную D1-базу с именем `nk-activity-db` в Cloudflare.
2. Скопировать её Database ID и заменить `REPLACE_WITH_NEW_D1_DATABASE_ID` в `wrangler.toml`.
3. Создать отдельный Worker `nk-activity` и подключить этот репозиторий через Workers Builds либо выполнить деплой Wrangler из локальной копии.
4. В настройках Worker добавить Secrets:
   - `TELEGRAM_BOT_TOKEN` — новый токен @AKTIVInkBot (не коммитить и не отправлять в чат).
   - `TELEGRAM_WEBHOOK_SECRET` — случайная длинная строка для проверки Telegram webhook.
   - `OWNER_TELEGRAM_ID` — `891419692`.
5. Обычные переменные Worker: `TARGET_CHAT_ID=-1004353159956`, `APP_TIMEZONE=Europe/Moscow`, `APP_ENV=production`.
6. Применить миграции к удалённой D1: `npx wrangler d1 migrations apply nk-activity-db --remote`.
7. После успешного деплоя установить webhook Telegram на URL `https://nk-activity.<твой-subdomain>.workers.dev/webhook`, передав тот же `TELEGRAM_WEBHOOK_SECRET` как `secret_token`.
8. Проверить `/health`, затем отправить `/start`, `/profile` и `/top` в тестовой группе.

**Не подключать основную группу до проверки начисления XP, дневного лимита и повторной доставки webhook.** Токены и секреты не добавлять в GitHub.

Текущие ограничения первой версии: Web-панель пока статическая; магазин, сезоны, достижения, ежедневные бонусы, модераторские действия и антифрод ещё не реализованы. Бот начисляет базовые XP за сообщения и отвечает на базовые команды.
