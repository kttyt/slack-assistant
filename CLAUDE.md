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
node --env-file=.env src/index.js --config=config.yaml  # + YAML-конфиг (см. config.example.yaml)
npm test                                  # прогон тестов (vitest)
npm run lint                              # проверка ESLint
npm run grab-token                        # снять токен из браузера (нужен Playwright, см. ниже)
```

## Конфигурация

Несекретные параметры можно задавать через `config.yaml` (передаётся флагом `--config=<path>`,
формат — в `config.example.yaml`) и/или через переменные окружения. Приоритет источников:
**ENV → config.yaml → встроенный дефолт** (переменная окружения перекрывает значение из YAML).
Секреты `SLACK_XOXC_TOKEN`/`SLACK_XOXD_COOKIE` — только из окружения, в YAML их не кладут.
Без флага `--config` поведение чисто-ENV (обратная совместимость). Карта «yaml-путь ↔ ENV» —
единый список `FIELDS` в `config.js`; он же служит белым списком (неизвестные ключи YAML → warn).

Настраиваемое: расписание/джиттер, presence (offHoursMode, clearDnd, тайминги ping/pong),
детект входящих (упоминания, `@here/@channel`, DM-префиксы, групповые DM/mpim, ключевые слова),
`User-Agent` (по умолчанию — реалистичный браузерный), HTTP/S-прокси.

**Прокси и grab-token — опциональны и гейтятся через optionalDependencies:**
- Прокси (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` или `proxy.*`) требует `undici` + `https-proxy-agent`.
  Их нет в прод-образе (`npm ci --omit=optional`). Если прокси задан, а пакетов нет — `buildProxy`
  (`src/proxy.js`) бросает `PROXY_DEPS_MISSING` при старте с инструкцией по установке.
- `tools/grab-token.js` (headful Playwright) открывает Slack, даёт войти вручную и пишет
  `SLACK_XOXC_TOKEN`/`SLACK_XOXD_COOKIE`/`USER_AGENT` в `.env` (или `--env-file`). Читает ту же
  конфигурацию, что и сервис (`loadConfig` с `requireSecrets:false`, поддерживает `--config`):
  берёт `TZ` для таймзоны браузера и `HTTP(S)_PROXY` для входа через прокси. Браузеры Playwright
  ставятся отдельно: `npx playwright install chromium`. YAML читается общим `src/config-file.js`.

## Управляющий API (`/react`)

`POST /react/{channel}/{ts}` ставит реакцию на сообщение (для внешних сервисов: LLM-обработчик,
Discord/TG-бот). Маршрут БЕЗ состояния: Slack идентифицирует сообщение парой `channel`+`ts`
(глобального ID у сообщений нет, `ts` уникален лишь в пределах канала), поэтому оба берутся прямо
из пути — их видно в INFO-логе уведомления (`ch=… ts=…`). Живёт на том же порту, что `/health`.
Включается ТОЛЬКО при заданном `CONTROL_TOKEN` (секрет, env-only); запрос обязан нести
`Authorization: Bearer <token>` (или `X-Control-Token`). Тело: `{"reactionEmoji": ":eyes:"}`.
Реакция ставится через `slack.reactionsAdd` (`reactions.add`); `already_reacted` считается успехом.
Порт по умолчанию слушает `127.0.0.1` (см. `docker-compose.yml`) — для внешнего доступа
переопределите привязку осознанно, помня, что эндпоинт действует от имени вашего аккаунта.

## Архитектура (`src/`)

Ядро построено на инъекции зависимостей: компоненты — это **фабрики** (`createSlackClient`,
`createSchedule`, `createNotifier`, `createHealth`) и класс `PresenceKeeper`, которым всё
(конфиг, зависимости, тайминги) передаётся явно через аргументы. Ни один модуль ядра не
читает `process.env` и не хранит глобальный синглтон — единственное место, где читается
окружение, валидируется конфиг и живёт `process.exit`, это CLI-точка `index.js`.

| Файл | Назначение |
|---|---|
| `index.js` | CLI: `loadConfig` → сборка компонентов → health-сервер + проверка токена + планировщик |
| `connection.js` | `PresenceKeeper`: WebSocket keep-alive, heartbeat (ping/pong), reconnect, presence/DND, оркестрация уведомлений |
| `detect.js` | `classifyMessage(m, opts)` — ЧИСТОЕ правило «уведомлять ли и каким видом» (DM/mpim/упоминание/ключевые слова) |
| `slack.js` | `createSlackClient` + `isAuthError`: Web API (`rtm.connect`, `setPresence`, `dnd`, `reactions.add`, …) на `xoxc`+`d` |
| `schedule.js` | `createSchedule`: рабочие часы по `TZ` + плавающие (jitter) границы |
| `health.js` | `createHealth`: чистое состояние токена/сокета (`snapshot()`), без HTTP |
| `notifier.js` | `createNotifier`: доставка уведомлений на `WEBHOOK_URL` (payload содержит `channel`+`ts`; они же в INFO-логе) |
| `config.js` | чистая `loadConfig(env, yaml)` — таблица `SCHEMA` (одна строка на настройку) + движок слияния/валидации; каждая строка может иметь кастомный `validate(key,value)` |
| `proxy.js` | `buildProxy`: HTTP/S-прокси для fetch (undici) и ws (https-proxy-agent), опц. пакеты через динамический import |
| `logger.js` | логи с уровнями |

HTTP-сервер вынесен в `src/server/` (без фреймворков):

| Файл | Назначение |
|---|---|
| `server/index.js` | `startServer({port, health, react})`: собирает роутер, регистрирует маршруты, слушает порт |
| `server/router.js` | `createRouter`: маршруты `:param`, диспетчеризация, 405 при несовпадении метода, 404 по умолчанию |
| `server/http-util.js` | `sendJson`/`readJson`/`tokenFromReq`/`safeEqual` — общие HTTP-помощники |
| `server/handlers/health.js` | `healthHandler(health)` — рендер `snapshot()` в ответ `GET /health` |
| `server/handlers/react.js` | `reactHandler({slack, token})` — `POST /react/{channel}/{ts}` (без состояния), защищён `CONTROL_TOKEN` |

Вне `src/`: `tools/grab-token.js` — headful-Playwright помощник для снятия токена (dev-инструмент).

## Тесты (`test/`)

- Раннер — **vitest** (`npm test`). Слои: `test/unit/` (чистые функции), `test/module/`
  (компонент против реального HTTP/WS), `test/integration/` (весь `PresenceKeeper`).
- `test/helpers/fake-slack.js` — управляемый фейковый Slack (HTTP Web API + WS RTM):
  протухший токен, отказ отвечать pong, `goodbye`, входящие сообщения, HTTP-ошибки.
- Тайминги `PresenceKeeper` инъектируются, поэтому интеграционные тесты гоняют reconnect/
  heartbeat за миллисекунды (см. `FAST_TIMINGS` в `test/helpers/util.js`).
- Каждый тест снабжён шапкой: **что / вход / поведение / ожидаемый результат или side-effect**.

## Конвенции

- Node ≥20, ESM (`"type": "module"`). Рантайм-зависимости минимальны (`ws`, `yaml`) — без
  надобности не добавляй. Прокси-пакеты (`undici`, `https-proxy-agent`) — `optionalDependencies`,
  Playwright ставится вручную; dev-зависимости (`eslint`, `vitest`) и optional в образ не попадают
  (`npm ci --omit=dev --omit=optional`).
- Компоненты ядра — фабрики с инъекцией зависимостей; конфиг не читается из env вне `index.js`.
- Язык общения, комментариев и документации — **русский** (проект русскоязычный).
- Конфигурация только через env (см. `config.js` и `.env.example`) — никаких хардкод-значений.
