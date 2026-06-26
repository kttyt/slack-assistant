# CLAUDE.md

Инструкции для Claude Code и AI-агентов, работающих в этом репозитории.
Подробный контекст проекта — в [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) и [README.md](README.md).

## Что это

`slack-keep-active` — self-hosted Node.js-сервис: держит Slack-аккаунт в статусе **active**
(🟢) по расписанию рабочих часов и уведомляет о входящих упоминаниях/DM. Авторизация — через
сессию веб-клиента Slack (`xoxc`-токен + cookie `d`/`xoxd`), realtime через WebSocket.

## Безопасность — КРИТИЧНО

- **Никогда не коммить секреты.** Реальные токены живут только в `.env` (он в `.gitignore`).
  В репозиторий — только `.env.example` с плейсхолдерами.
- `SLACK_XOXC_TOKEN` (`xoxc-…`) и `SLACK_XOXD_COOKIE` (`xoxd-…`) = **полный доступ к аккаунту**.
  Не вставляй их значения в код, логи, README, PROJECT_CONTEXT, сообщения коммитов или вывод.
- Меняешь набор переменных — синхронно обнови `.env.example` (только плейсхолдеры).
- Действует pre-commit hook `.githooks/pre-commit` (блокирует секретные файлы и токены).
  Не обходи его через `--no-verify` без явной причины.

## Команды

```bash
npm install                              # ставит зависимости + активирует git-хук (prepare)
cp .env.example .env                      # затем вписать свои токены/расписание
docker compose up -d --build              # запуск 24/7 (рекомендуется)
docker compose logs -f                    # логи
node --env-file=.env src/index.js         # локальный запуск без Docker
```

## Архитектура (`src/`)

| Файл | Назначение |
|---|---|
| `index.js` | точка входа: health-сервер + проверка токена + планировщик |
| `connection.js` | WebSocket keep-alive, reconnect, presence/DND, разбор входящих |
| `slack.js` | Web API (`rtm.connect`, `setPresence`, `dnd`, `users.info`) на `xoxc`+`d` |
| `schedule.js` | рабочие часы по `TZ` + плавающие (jitter) границы |
| `health.js` | состояние валидности токена + HTTP `/health` |
| `notifier.js` | доставка уведомлений на `WEBHOOK_URL` |
| `config.js` | чтение/валидация env |
| `logger.js` | логи с уровнями |

## Конвенции

- Node ≥20, ESM (`"type": "module"`). Зависимости минимальны (только `ws`) — без надобности не добавляй.
- Язык общения, комментариев и документации — **русский** (проект русскоязычный).
- Конфигурация только через env (см. `config.js` и `.env.example`) — никаких хардкод-значений.
