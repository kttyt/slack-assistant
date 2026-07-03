# slack-keep-active — контекст проекта (handoff для команды)

> Документ для передачи контекста команде. **Секретов здесь нет** — токены живут только
> в `.env` (он в `.gitignore`). Не коммитьте `.env` и не вставляйте токены в этот файл.

## Что это и зачем

Небольшой self-hosted сервис, который:
1. Держит Slack-аккаунт в статусе **active** (🟢 зелёный шарик) по расписанию рабочих часов.
2. **Уведомляет о входящих** — упоминания, DM, групповые DM, ключевые слова.
3. Отдаёт **управляющий API** (`POST /react/{channel}/{ts}`) для реакции на сообщение из внешних сервисов.

Цель — выглядеть «на связи» в рабочие часы и не пропускать обращения.

## ⚠️ Статус и правовые оговорки

- **Серая зона.** Имитация присутствия может нарушать правила workspace и/или ToS Slack.
  Используется на свой риск, по личному решению владельца аккаунта.
- Авторизация — через **сессию веб-клиента** (`xoxc-` токен + cookie `d` / `xoxd-`), а не
  через официальное OAuth-приложение. Это **неофициальный, реверс-инжиниринговый** способ;
  Slack может сломать его в любой момент.
- Токен/cookie = **полный доступ к аккаунту**. Хранить как пароль, не шарить, не коммитить.
  Протухают после ре-логина/смены пароля — тогда обновить `.env` (быстро — `npm run grab-token`).

## Ключевое техническое решение (почему именно так)

Зелёный шарик нельзя «зажечь» через официальный API — `users.setPresence` умеет только
`auto`/`away`. Зелёный держится, **пока есть подключённый активный клиент**.

При этом **современные scoped-приложения (`xoxp`) лишены доступа к RTM WebSocket** (legacy RTM
отключён для них). Доступ к realtime-сокету остался только у **первого-стороннего веб-клиента**,
т.е. у сессии `xoxc` + cookie `d`. Поэтому сервис авторизуется именно как веб-клиент и делает
то же, что браузерный Slack:

1. `rtm.connect` → получает URL WebSocket.
2. Держит сокет открытым + периодический `ping`; heartbeat следит за `pong` (нет ответа дольше
   `PONG_TIMEOUT_MS` → соединение считается мёртвым → реконнект с backoff).
3. Периодически подтверждает `presence=auto`, опционально снимает DND (чтобы не было 💤).
4. По тому же сокету приходят события `message` → детект упоминаний/DM/ключевых слов.

Проверено эмпирически: и Web API, и WebSocket требуют **и** `xoxc`, **и** cookie `d`
(по отдельности — `invalid_auth`).

## Индикаторы Slack

| Индикатор | Значение |
|---|---|
| 🟢 зелёный | active — есть активный клиент |
| ⚪️ серый | away — клиентов нет или ручной away |
| 🟢💤 зелёный + Zzz | active, но включён режим «Не беспокоить» (DND) |

Для сплошного 🟢 без 💤 — `CLEAR_DND=true`.

## Возможности

- **Presence по расписанию** — рабочие дни/часы по таймзоне; окно через полночь; вне часов
  отпускает соединение (или явный `away` при `OFF_HOURS_MODE=away`).
- **Плавающее расписание** — границы окна каждый день случайно сдвигаются на
  ±(`JITTER_MIN`..`JITTER_MAX`) мин; детерминировано по дню (стабильно в течение суток).
- **Устойчивое соединение** — heartbeat по `pong`, реконнект с экспоненциальным backoff.
- **Мониторинг входящих** — упоминания (`<@me>` и, опц., `@here`/`@channel`), DM, групповые DM
  (mpim), ключевые слова. Настраивается тонко. `POST` JSON на `WEBHOOK_URL` или только в лог
  (в INFO видно `ch=… ts=…`). Работает только в рабочие часы, историю не читает.
- **Управляющий API `/react`** — `POST /react/{channel}/{ts}` ставит реакцию (`reactions.add`),
  защищён `CONTROL_TOKEN`. Без состояния.
- **Healthcheck** — `auth.test` + HTTP `/health` (200 / 503 `token_invalid` / 503 `socket_down`),
  Docker помечает контейнер `unhealthy`.
- **Конфиг: ENV и/или YAML** — `--config=config.yaml`; приоритет ENV → YAML → дефолт. Секреты
  только в ENV.
- **User-Agent** — мимикрия под браузер (реалистичный дефолт, переопределяется).
- **HTTP/S-прокси** — весь трафик через прокси (опциональные пакеты `undici`/`https-proxy-agent`).
- **`grab-token`** — headful-Playwright хелпер снимает токен/cookie/UA из браузера в `.env`.

## Защита секретов (важно для команды)

Два уровня защиты — **ничего секретного в git не попадает**:

1. **`.gitignore`** игнорирует `.env`, `.env.*` (кроме `.env.example`), `config.yaml`, `*.pem`,
   `*.key`, `.npmrc` и пр.
2. **pre-commit hook** (`.githooks/pre-commit`) блокирует коммит секретных файлов и строк,
   похожих на токены (`xoxc-`/`xoxd-`, приватные ключи). Активируется автоматически после
   `npm install` (script `prepare` → `git config core.hooksPath .githooks`).

Онбординг: `git clone` → `npm install` (включит хук) → `cp .env.example .env` → вписать **свои**
токены (или `npm run grab-token`). Меняете набор переменных — обновите `.env.example` и/или
`config.example.yaml`. Осознанный обход ложного срабатывания: `git commit --no-verify`.

## Архитектура (файлы)

Ядро на инъекции зависимостей: компоненты — фабрики (`createSlackClient`, `createSchedule`,
`createNotifier`, `createHealth`, `buildProxy`) и класс `PresenceKeeper`; всё передаётся явно.
Единственное место, читающее env и живущее с `process.exit`, — CLI-точка `index.js`.

```
src/index.js       — CLI: loadConfig → сборка компонентов → HTTP-сервер + проверка токена + планировщик
src/config.js      — чистая loadConfig(env, yaml): таблица настроек SCHEMA + движок слияния/валидации
src/config-file.js — чтение config.yaml по флагу --config
src/connection.js  — PresenceKeeper: WebSocket keep-alive, heartbeat, reconnect, presence/DND, оркестрация
src/detect.js      — чистая classifyMessage(): решает, уведомлять ли и каким видом
src/slack.js       — createSlackClient + isAuthError: Web API (rtm.connect, setPresence, dnd, reactions.add, …)
src/schedule.js    — createSchedule: рабочие часы по TZ + плавающие (jitter) границы
src/notifier.js    — createNotifier: доставка уведомлений на webhook
src/health.js      — createHealth: состояние токена/сокета (чистое, без HTTP)
src/proxy.js       — buildProxy: HTTP/S-прокси для fetch/ws (опциональные пакеты)
src/logger.js      — логи с уровнями (+ setLevel из конфига)
src/server/        — HTTP-сервер: index.js (startServer+router), router.js, http-util.js, handlers/{health,react}.js
tools/grab-token.js — headful-Playwright: снять токен из браузера
test/              — vitest: unit / module / integration + управляемый фейковый Slack-сервер
Dockerfile · docker-compose.yml · .env.example · config.example.yaml · README.md · CLAUDE.md
```

## Конфигурация

Источники: **ENV → config.yaml (`--config`) → дефолт**. Полный список — в `.env.example`,
`config.example.yaml` и таблицах в `README.md`. Обязательны (только ENV): `SLACK_XOXC_TOKEN`,
`SLACK_XOXD_COOKIE`. Часто задают: `TZ`, `WORK_DAYS`, `WORK_START/END`, `WEBHOOK_URL`,
`OFF_HOURS_MODE`, `CLEAR_DND`, `CONTROL_TOKEN` (для `/react`).

## Запуск и разработка

**Docker (рекомендуется для 24/7):**
```bash
cp .env.example .env   # заполнить токены и расписание
docker compose up -d --build
docker compose logs -f          # НЕ через `docker compose run` — он дублирует вывод в TTY
```

**Локально:** `node --env-file=.env src/index.js [--config=config.yaml]`.

**Тесты/линт:** `npm test` (vitest), `npm run lint` (ESLint).

## Состояние

- Сервис собран, покрыт тестами (unit/module/integration, ~100+ кейсов), запускается в Docker и
  локально. Логика детекта и конфиг — чистые функции с тестами; сеть/сокеты — интеграционные тесты
  против фейкового Slack.

## Открытые вопросы / TODO

- [ ] Решить, нужен ли **мониторинг 24/7** (сейчас только в рабочие часы). Для 24/7 надо развязать
      WebSocket и presence: сокет держать всегда, 🟢/⚪️ регулировать через `setPresence`.
- [ ] Опционально: персистентный журнал уведомлений (`mentions.jsonl` в volume).
- [ ] `playwright` сейчас в `dependencies` → попадает в прод-образ; логичнее перенести в
      `devDependencies` (в контейнере хелпер не запускается).
- [ ] Безопасность: при ужесточении требований — перелогиниться в браузерном Slack (инвалидирует
      старую сессию) и обновить `.env`.
