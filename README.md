# НК Activity

Платформа активности и XP для Telegram-сообщества НК.

## Состав
- Cloudflare Worker + Telegram Webhook
- Cloudflare D1
- Web admin (Cloudflare Pages)
- Cron Triggers
- TypeScript

## Локальная разработка
1. Установить Node.js 20+.
2. Выполнить `npm install`.
3. Скопировать `.dev.vars.example` в `.dev.vars` и заполнить локальные значения.
4. Выполнить `npm run db:local`.
5. Выполнить `npm run dev`.

## Безопасность
Не добавляйте Telegram Bot Token и другие секреты в Git. В Cloudflare используйте Worker Secrets.
Сначала выполните миграции и тесты на отдельной D1-базе. Не подключайте production-группу до прохождения критических тестов.

## Экономика XP
- Lifetime XP — накопленный опыт, определяет уровень и не уменьшается.
- Available XP — доступный баланс, расходуется на покупки и подтверждённые штрафы.
- Season XP — опыт текущего сезона, не уменьшается при покупках.

Часовой пояс: Europe/Moscow. Автоматическое списание XP запрещено.
