# НК Activity

Платформа активности и XP для Telegram-сообщества НК.

## Технологии
- Cloudflare Workers + Hono
- Cloudflare D1
- Cloudflare Workers Static Assets (web admin)
- Telegram Bot API / Webhook
- TypeScript

## Команды участника
- `/start`, `/help` — справка
- `/profile`, `/me` — личная статистика
- `/myrewards` — история специальных наград и префиксов
- `/top`, `/rating` — публичный общий топ-10
- `/topseason` — рейтинг текущего 30-дневного сезона
- `/topday`, `/topweek`, `/topmonth` — рейтинги за день, неделю и месяц
- `/topachievements`, `/topstreaks` — рейтинги по достижениям и рекорду серии
- `/myrank` — личное место в общем и сезонном рейтингах
- `/daily` — ежедневная награда с циклом 10/15/20/25/30/50/100 XP
- `/achievements` — список полученных достижений
- `/shop`, `/buy ID`, `/myorders` — магазин, покупка и история заявок
- `/addreward категория | название | цена_XP | описание | количество (необязательно)` — добавить товар (администратор)
- `/pending`, `/adminstats` — очередь покупок и статистика (администратор)
- `/eventxp TELEGRAM_ID | причина` — выдать +30 XP за событие (администратор)
- `/contestxp TELEGRAM_ID | причина` — выдать +100 XP за победу в конкурсе (администратор)
- `/penalty ID сумма | причина`, `/pendingpenalties`, `/approvepenalty ID`, `/rejectpenalty ID` — штрафы только через подтверждение администратора
- `/approve ID`, `/reject ID` — обработать покупку (администратор)
- `/adminpanel` — открыть веб-панель из личного диалога с ботом (администратор)

## Экономика
- Lifetime XP — суммарно заработанный опыт; определяет уровень и не уменьшается.
- Available XP — доступный баланс; расходуется на покупки и подтверждённые штрафы.
- Season XP — опыт текущего сезона; покупки его не уменьшают.
- За сообщение начисляется 3 XP; ежедневная активность и бонусы за рубежи сообщений/серий используют общий лимит 200 XP в сутки.
- Ежедневная награда имеет цикл 10/15/20/25/30/50/100 XP; после пропуска дня серия начинается заново.
- Дни и лимиты рассчитываются по Europe/Moscow.
- Сезоны автоматически идут по 30 дней; сезонный рейтинг архивируется при закрытии сезона.
- Достижения выдаются за первое сообщение, 100/500/1000/5000 сообщений и серии 7/30 дней.
- Автоматическое списание XP за штрафы запрещено.
- Недельные награды за места 1–10 выдаются автоматически в понедельник: 300/200/150/75/75/30/30/30/30/30 XP; эти призы не расходуют дневной лимит.
- Ежемесячно: 1-е место получает уникальный префикс, 2-е — специальный префикс, 3-е — памятное достижение. Награды сохраняются в истории участника.

## Локальная разработка
1. Установить Node.js 22.12+ и выполнить `npm install`.
2. Скопировать `.dev.vars.example` в `.dev.vars` и заполнить локальные секреты.
3. Выполнить `npm run db:local`, затем `npm run dev`.
4. Для удалённой базы сначала авторизоваться через `npx wrangler login`; её ID уже указан в `wrangler.toml`.

## Секреты
Не добавляйте Telegram Bot Token, webhook secret или admin secret в Git. Для production задавайте их через Worker Secrets.

## Важно перед запуском
- Включить бота в нужную группу и выдать необходимые права.
- Настроить Telegram Webhook с secret token.
- Применить все D1-миграции из папки `migrations` по порядку. Миграция `0010_member_rewards_idempotency.sql` удаляет возможные дубликаты месячных наград и добавляет уникальность по участнику, типу награды и месяцу.
- Протестировать повторные Updates, дневной лимит и начисления.
- Не подключать основную группу до прохождения критических тестов.
- Старый проект `telegram-admin-bot` не используется и не изменяется.


## Подключение Cloudflare (перед первым запуском)

Текущий статус: база `nk-activity-db` создана, её ID прописан в конфигурации. CI-проверки проходят. Миграции ещё не применены, Worker ещё не развёрнут, секреты и webhook ещё не настроены.

1. Отдельная D1-база `nk-activity-db` уже создана. Её Database ID уже прописан в `wrangler.toml`; повторно создавать базу не нужно.
2. В локальном терминале выполнить `npx wrangler login`, затем `npm run db:remote` для применения миграций. Это пока требует авторизации Cloudflare.
3. Выполнить `npm run deploy` для создания/обновления отдельного Worker `nk-activity` из этого репозитория.
4. В BotFather отключить Privacy Mode для `@AKTIVInkBot` (или выдать боту права администратора в группе), чтобы Telegram передавал обычные сообщения для начисления XP. Самому владельцу заранее открыть бота и отправить `/start`, чтобы получать личные уведомления о покупках.
5. В настройках Worker добавить Secrets:
   - `TELEGRAM_BOT_TOKEN` — новый токен @AKTIVInkBot (не коммитить и не отправлять в чат).
   - `TELEGRAM_WEBHOOK_SECRET` — случайная длинная строка для проверки Telegram webhook.
   - `OWNER_TELEGRAM_ID` — `891419692`.
6. Обычные переменные Worker: `TARGET_CHAT_ID=-1004353159956`, `APP_TIMEZONE=Europe/Moscow`, `APP_ENV=production`, `WEB_ADMIN_URL=https://<worker-domain>/admin`.
7. После успешного деплоя установить webhook Telegram на URL `https://nk-activity.<твой-subdomain>.workers.dev/webhook`, передав тот же `TELEGRAM_WEBHOOK_SECRET` как `secret_token`.
9. Проверить `/health`, затем отправить `/start`, `/profile`, `/daily`, `/achievements`, `/shop`, `/top` и `/topseason` в тестовой группе.

**Не подключать основную группу до проверки начисления XP, дневного лимита и повторной доставки webhook.** Токены и секреты не добавлять в GitHub.

Веб-панель `/admin` отдаётся тем же Worker как статические файлы; команда `/adminpanel` в личном диалоге присылает кнопку открытия Telegram Web App. Авторизация проверяется по подписи Telegram и списку администраторов. В панели доступны статистика, топ участников, журнал действий, поиск участников по Telegram ID/username/имени с просмотром балансов и активности, подтверждение покупок и штрафов, просмотр антифрод-сигналов и настройка XP за сообщение, дневного лимита, длительности следующих сезонов и порогов уровней. Права разделены по ролям: владелец/главный администратор — полный доступ, администратор — магазин, модерация и просмотр участников, модератор — модерация и просмотр участников; дополнительные разрешения задаются в `admins.permissions_json`. В магазине пока нет предзаполненного каталога — товары добавляются командой администратора. Антифрод выявляет частый поток и повторяющийся текст по SHA-256-хешам (без хранения текста сообщений), отправляет предупреждения и уведомляет администраторов; XP автоматически не списываются. Пороги уровней задаются владельцем в веб-панели в виде JSON-объекта с XP для каждого уровня подряд; до настройки уровни не отображаются. Недельные, месячные и сезонные награды поддерживаются; сезонные выплаты настраиваются владельцем в веб-панели по местам 1–10 и выдаются однократно после закрытия сезона.


### Season prizes

The owner can configure `season_reward_schedule` in the admin panel as a JSON object mapping final places 1–10 to XP amounts, for example `{ "1": 500, "2": 300, "3": 150 }`. An empty object disables season payouts. After a season closes, configured prizes are credited to Lifetime XP and Available XP exactly once; they do not increase the next season's XP. Migration `0011_season_reward_runs.sql` adds an idempotency marker. Configure the schedule before the season closes; a season processed while payouts are disabled is not paid retroactively.


### Telegram webhook setup

After deploying the Worker and adding `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Cloudflare secrets, set the webhook from a trusted local terminal without placing credentials in source control:

```bash
TELEGRAM_BOT_TOKEN='…' TELEGRAM_WEBHOOK_SECRET='…' WORKER_URL='https://<worker-domain>/webhook' npm run webhook:set
```

The helper preserves pending Telegram updates, only subscribes to message updates, validates HTTPS and the webhook secret format, and never prints the bot token or secret. Do not run it until the Worker is deployed and its D1 migrations are applied.
