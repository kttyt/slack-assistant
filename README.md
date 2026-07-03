# slack-keep-active

Небольшой self-hosted сервис, который держит ваш Slack-аккаунт в статусе **active** (🟢 зелёный шарик)
по расписанию рабочих часов и **уведомляет о входящих** (упоминания, DM, ключевые слова). Работает 24/7
в Docker — ноутбук включать не нужно.

## Как это работает

Slack показывает зелёный шарик, пока у вас есть **подключённый активный клиент**. Через официальный
API «зажечь» зелёный нельзя (`users.setPresence` умеет только `auto`/`away`). Поэтому сервис делает то же,
что делает настоящий веб-клиент Slack:

1. Через `rtm.connect` (с токеном веб-сессии `xoxc` + cookie `d`) получает URL WebSocket реального времени.
2. Держит это соединение открытым и шлёт периодические `ping` — Slack видит активного клиента → 🟢.
3. Периодически подтверждает `presence=auto` и (опционально) снимает режим «Не беспокоить», чтобы не было 💤.
4. **Планировщик** включает всё это только в заданные рабочие часы; вне их — отпускает (естественный серый).

### Индикаторы Slack
| Индикатор | Значение |
|---|---|
| 🟢 зелёный | active — есть активный клиент |
| ⚪️ серый | away — клиентов нет или включён ручной away |
| 🟢💤 зелёный с Zzz | active, но включён режим «Не беспокоить» (DND) |

Чтобы был именно сплошной 🟢 без 💤 — поставьте `CLEAR_DND=true`.

## ⚠️ Важные предупреждения

- **Это серая зона.** Имитация присутствия может нарушать правила вашего workspace и/или ToS Slack.
  Используйте на свой риск.
- Авторизация идёт через **токен веб-сессии** (`xoxc-`) и **cookie `d`** (`xoxd-`). Это
  реверс-инжиниринговый, неофициальный способ — Slack может изменить его в любой момент.
- Эти токен и cookie дают **полный доступ к вашему аккаунту**. Храните `.env` как пароль,
  не коммитьте, не передавайте третьим лицам.
- Токен/cookie со временем протухают (особенно после смены пароля или ре-логина) — тогда нужно обновить `.env`.

## Получение токенов

Нужны два значения: `SLACK_XOXC_TOKEN` (`xoxc-…`) и `SLACK_XOXD_COOKIE` (`xoxd-…`).

### Способ A — автоматически (`grab-token`)

Хелпер открывает Slack в видимом браузере, вы входите руками, а он снимает из вашей же сессии
токен, cookie и `User-Agent` и пишет их в `.env` (сохраняя остальные строки). Нужны браузеры Playwright:

```bash
npx playwright install chromium
npm run grab-token                    # или: node tools/grab-token.js --env-file=.env
```

Хелпер уважает вашу конфигурацию (`--config`, ENV): берёт `TZ` для таймзоны браузера и
`HTTP(S)_PROXY` для входа через тот же прокси, что и сервис. Логин Slack проходит через несколько
вкладок — grab-token следит за всеми. Секреты не печатаются в консоль (маскируются).

### Способ B — вручную через DevTools

1. Откройте Slack в **браузере** (https://app.slack.com) и залогиньтесь в нужный workspace.
2. DevTools (F12) → **Network** → в фильтре `client.boot` (или `api`), обновите страницу (F5).
3. Клик по запросу → **Payload/Request** → параметр `token` со значением `xoxc-…` = `SLACK_XOXC_TOKEN`.
4. **Application → Cookies → https://app.slack.com** → cookie **`d`** (значение `xoxd-…`) = `SLACK_XOXD_COOKIE`.
   Значение может быть URL-кодировано (`xoxd-...%2F...`) — копируйте как есть.

## Запуск

```bash
cp .env.example .env
# заполните SLACK_XOXC_TOKEN, SLACK_XOXD_COOKIE и расписание в .env

docker compose up -d --build
docker compose logs -f      # проверить, что авторизовались и подключились
```

Остановить: `docker compose down`.

> ⚠️ Смотрите логи через `docker compose logs -f`, **а не через `docker compose run`** — `run` создаёт
> одноразовый контейнер с интерактивным TTY и дублирует вывод в терминале (это особенность `run`,
> а не сервиса).

### Без Docker (локально)

```bash
cp .env.example .env   # заполнить
npm install
node --env-file=.env src/index.js
# с YAML-конфигом:
node --env-file=.env src/index.js --config=config.yaml
```

## Конфигурация

Настройки можно задавать через **переменные окружения** (`.env`) и/или **YAML-файл** (`config.yaml`,
передаётся флагом `--config=<path>`). Приоритет источников: **ENV → config.yaml → встроенный дефолт**
(переменная окружения перекрывает значение из YAML). Секреты (`SLACK_XOXC_TOKEN`/`SLACK_XOXD_COOKIE`,
`CONTROL_TOKEN`) — **только из окружения**, в YAML их класть нельзя.

Полный набор с плейсхолдерами — в [`.env.example`](.env.example) и [`config.example.yaml`](config.example.yaml).

### YAML (`config.yaml`)

Несекретные параметры удобно держать в одном файле (передаётся `--config`, в Docker — смонтирован
как volume, см. `docker-compose.yml`). Пример структуры — в `config.example.yaml`:

```yaml
schedule:
  timezone: Europe/Moscow
  workDays: [1, 2, 3, 4, 5]
  hours: { start: "09:00", end: "19:00" }
presence:
  offHoursMode: away
notifications:
  webhookUrl: ""
  mentions: { enabled: true, channelWide: false }
  dm: { enabled: true, groupDm: false }
  keywords: ["deploy", "incident"]
logging:
  level: info
```

### Все переменные

**Авторизация (только ENV, секреты):**

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `SLACK_XOXC_TOKEN` | токен веб-сессии (`xoxc-…`) | — (обязательно) |
| `SLACK_XOXD_COOKIE` | значение cookie `d` (`xoxd-…`) | — (обязательно) |

**Расписание** (`schedule.*`):

| ENV | YAML | Назначение | По умолчанию |
|---|---|---|---|
| `TZ` | `schedule.timezone` | таймзона расписания (IANA) | `UTC` |
| `WORK_DAYS` | `schedule.workDays` | рабочие дни `1`=пн…`7`=вс (`1-5` / `[1,3,5]`) | `1-5` |
| `WORK_START` | `schedule.hours.start` | начало окна `HH:MM` | `09:00` |
| `WORK_END` | `schedule.hours.end` | конец окна `HH:MM` (можно через полночь) | `19:00` |
| `JITTER_MIN_MINUTES` | `schedule.jitter.minMinutes` | мин. сдвиг плавающих границ, мин | `10` |
| `JITTER_MAX_MINUTES` | `schedule.jitter.maxMinutes` | макс. сдвиг (`0/0` — выключить) | `15` |

**Присутствие** (`presence.*`):

| ENV | YAML | Назначение | По умолчанию |
|---|---|---|---|
| `OFF_HOURS_MODE` | `presence.offHoursMode` | вне часов: `release` или `away` | `release` |
| `CLEAR_DND` | `presence.clearDnd` | снимать «Не беспокоить» (убрать 💤) | `false` |
| `PING_INTERVAL_MS` | `presence.pingIntervalMs` | интервал ping в WebSocket | `20000` |
| `PONG_TIMEOUT_MS` | `presence.pongTimeoutMs` | нет `pong` дольше этого → реконнект (> ping) | `60000` |
| `PRESENCE_REFRESH_MS` | `presence.presenceRefreshMs` | как часто подтверждать `presence=auto` | `120000` |

**Уведомления** (`notifications.*`):

| ENV | YAML | Назначение | По умолчанию |
|---|---|---|---|
| `WEBHOOK_URL` | `notifications.webhookUrl` | куда POST'ить уведомления (пусто — только лог) | — |
| `NOTIFY_MENTIONS` | `notifications.mentions.enabled` | уведомлять о прямых `@`-упоминаниях | `true` |
| `NOTIFY_CHANNEL_WIDE` | `notifications.mentions.channelWide` | считать `@here`/`@channel`/`@everyone` упоминанием | `false` |
| `NOTIFY_DM` | `notifications.dm.enabled` | уведомлять о личных сообщениях (1:1) | `true` |
| `DM_CHANNEL_PREFIXES` | `notifications.dm.channelPrefixes` | префиксы id каналов-DM (через запятую / список) | `D` |
| `NOTIFY_GROUP_DM` | `notifications.dm.groupDm` | уведомлять о групповых DM (mpim) | `false` |
| `NOTIFY_KEYWORDS` | `notifications.keywords` | ключевые слова (без учёта регистра; пусто — выкл) | — |
| `NOTIFY_SELF` | `notifications.self` | уведомлять о собственных сообщениях (самопроверка) | `false` |

**HTTP-сервер / API** (`api.*`, `health.*`, `react` секрет):

| ENV | YAML | Назначение | По умолчанию |
|---|---|---|---|
| `API_PORT` | `api.port` | порт HTTP-сервера (`/health` и `/react`) | `3000` |
| `HEALTH_CHECK_MS` | `health.checkMs` | как часто проверять токен через `auth.test` | `300000` |
| `CONTROL_TOKEN` | — (только ENV) | секрет для `POST /react/…` (пусто — маршрут выключен) | — |

**Прочее:**

| ENV | YAML | Назначение | По умолчанию |
|---|---|---|---|
| `USER_AGENT` | `slack.userAgent` | UA для Web API и WebSocket | реалистичный браузерный |
| `HTTP_PROXY` / `HTTPS_PROXY` | `proxy.http` / `proxy.https` | HTTP/S-прокси (см. раздел ниже) | — |
| `NO_PROXY` | `proxy.noProxy` | хосты в обход прокси (список) | — |
| `SLACK_API_BASE` | `slack.apiBase` | база Web API (менять не нужно; для тестов) | `https://slack.com/api` |
| `LOG_LEVEL` | `logging.level` | `debug`/`info`/`warn`/`error` | `info` |

> Совет: `LOG_LEVEL=debug` очень подробен (трейсы Web API, heartbeat). Для повседневной работы —
> `info`; `debug` включайте только при разборе проблем.

## Плавающее расписание

Чтобы присутствие не включалось/выключалось ровно по часам как робот, границы окна каждый
день случайно сдвигаются на `JITTER_MIN_MINUTES…JITTER_MAX_MINUTES` минут (знак тоже случаен).
Сдвиг **детерминирован по дню**: в течение суток он стабилен (нет мерцания на границе), но
меняется день ото дня. В логах видно сегодняшнее окно: `… (окно сегодня 08:46–18:49)`.

## Мониторинг упоминаний, DM и ключевых слов

Пока держится зелёный (в рабочие часы), сервис слушает тот же WebSocket и уведомляет о:

- 🔔 **прямых `@`-упоминаниях** вас (`<@ваш_id>` в тексте);
- 🔔 **канальных упоминаниях** `@here`/`@channel`/`@everyone` — если `NOTIFY_CHANNEL_WIDE=true`;
- 🔔 **личных сообщениях (DM, 1:1)** — префиксы каналов настраиваются `DM_CHANNEL_PREFIXES`;
- 🔔 **групповых DM (mpim)** — если `NOTIFY_GROUP_DM=true`;
- 🔔 **ключевых словах** из `NOTIFY_KEYWORDS` (без учёта регистра).

Собственные сообщения игнорируются (кроме `NOTIFY_SELF=true`). При срабатывании имя отправителя
резолвится через `users.info`, и формируется уведомление. Если задан `WEBHOOK_URL` — на него уходит
`POST` с JSON, иначе событие пишется только в лог (в INFO-строке видны `ch=…` и `ts=…`).

> ⚠️ Мониторинг активен **только в рабочие часы** — вне их соединение отпускается (так выбрано в
> конфигурации), и историю сервис не читает.

### Формат webhook (POST JSON)

```json
{
  "kind": "mention",                 // "mention" | "dm" | "group_dm" | "keyword"
  "from": "Alice Doe",               // имя отправителя
  "user": "U01ABC2DEF",              // его user_id
  "channel": "D01AB2C3D4",           // id канала/DM
  "channel_type": "im",              // "im" | "mpim" | "channel"
  "text": "<@U0MEID> привет",        // текст сообщения
  "ts": "1719267890.123456",         // метка времени Slack = идентификатор сообщения
  "keyword": null,                   // совпавшее ключевое слово (для kind="keyword")
  "permalink": "https://yourteam.slack.com/archives/D01AB2C3D4/p1719267890123456"
}
```

Подойдёт любой приёмник: Discord/Telegram-релей, n8n, свой сервер. Для быстрого теста удобно
взять одноразовый URL на https://webhook.site и вписать его в `WEBHOOK_URL`.

## Управляющий API: реакция на сообщение (`/react`)

Внешний сервис (LLM-обработчик, Discord/TG-бот) может поставить реакцию на сообщение через
HTTP — например, чтобы отметить обработанное уведомление. Маршрут поднимается на том же порту,
что `/health`, и включается **только** при заданном `CONTROL_TOKEN`:

```bash
curl -X POST http://localhost:3000/react/C01AB2C3D4/1719267890.123456 \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reactionEmoji": ":eyes:"}'
```

- Путь — `POST /react/{channel}/{ts}`. Slack идентифицирует сообщение парой **channel + ts**
  (глобального ID у сообщений нет), поэтому оба берутся из пути — их видно в INFO-логе уведомления
  (`ch=… ts=…`) и в webhook-JSON.
- Авторизация: `Authorization: Bearer <token>` или заголовок `X-Control-Token: <token>`.
- Ответы: `200` ok · `401` без/с неверным токеном · `400` кривое тело · `502` ошибка Slack.
  `already_reacted` трактуется как успех.
- Маршрут без состояния (ничего не хранит между запросами).

## HTTP/S-прокси

Весь трафик (Web API + WebSocket) можно направить через прокси: задайте `HTTP_PROXY`/`HTTPS_PROXY`
(и опционально `NO_PROXY`) в ENV или `proxy.*` в YAML. Прокси-поддержка требует **опциональных
пакетов** `undici` и `https-proxy-agent`:

```bash
npm install undici https-proxy-agent
```

В стандартном Docker-образе они **не установлены** (`npm ci --omit=optional`) — если прокси задан,
а пакетов нет, сервис завершится с понятной ошибкой при старте. Нужен прокси в контейнере — соберите
образ без `--omit=optional`.

## Healthcheck (мониторинг протухания токена)

Сервис периодически (`HEALTH_CHECK_MS`) дёргает `auth.test` и поднимает HTTP-эндпоинт `/health`:

- 🟢 токен валиден, соединение живо → `200 {"status":"ok", …}`;
- 🔴 токен протух (`invalid_auth`/`token_revoked`/…) → `503 {"status":"token_invalid", …}` +
  **громкое предупреждение в логах** с инструкцией обновить `.env`;
- 🟠 в рабочие часы соединение мертво дольше `PONG_TIMEOUT_MS` → `503 {"status":"socket_down", …}`.

`Dockerfile` и `docker-compose.yml` содержат `HEALTHCHECK` (через `wget`), поэтому при протухании
контейнер становится **unhealthy**:

```bash
docker inspect --format '{{.State.Health.Status}}' slack-keep-active   # healthy | unhealthy
curl -s http://localhost:3000/health | jq                              # подробности
```

## Разработка

```bash
npm install        # ставит зависимости + активирует git-хук (prepare)
npm test           # тесты (vitest): unit / module / integration
npm run lint       # ESLint
```

Инструкции для AI-агентов и обзор архитектуры — в [`CLAUDE.md`](CLAUDE.md). Ядро построено на
инъекции зависимостей (фабрики + `PresenceKeeper`); HTTP-сервер — в `src/server/`; конфиг —
чистая `loadConfig` с таблицей настроек в `src/config.js`.

### Защита секретов

Двухуровневая: `.gitignore` (`.env`, `config.yaml`, `*.pem`, `*.key`, `.npmrc`, …) и pre-commit hook
(`.githooks/pre-commit`) — он останавливает коммит секретных файлов (в т.ч. через `git add -f`) или
строк, похожих на токен (`xoxc-`/`xoxd-`, приватные ключи и пр.). Активируется автоматически после
`npm install`. Ложное срабатывание можно обойти осознанно: `git commit --no-verify`.

## Если перестало работать

- В логах `auth.test` падает с `invalid_auth`/`not_authed` → токен/cookie протухли, обновите `.env`
  (быстро — через `npm run grab-token`).
- Шарик не зелёный, хотя сервис подключён → проверьте, что в Slack не выставлен **ручной** «Set yourself
  as away», и что сейчас рабочие часы по `TZ`.
- Виден 💤 → включите `CLEAR_DND=true` (учтите: DND-расписание в Slack будет периодически возвращать DND).
- Логи «двоятся» в терминале → вы смотрите через `docker compose run`; используйте `docker compose logs -f`.
