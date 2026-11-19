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
