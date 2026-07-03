// CLI-точка входа: единственное место, которое читает окружение, валидирует конфиг и
// решает судьбу процесса. Здесь собирается граф зависимостей и передаётся в компоненты —
// само ядро (slack/schedule/notifier/health/connection) не знает про env и process.
import { loadConfig } from './config.js';
import { readYamlConfig } from './config-file.js';
import { log } from './logger.js';
import { createSlackClient, isAuthError } from './slack.js';
import { createSchedule } from './schedule.js';
import { createNotifier } from './notifier.js';
import { createHealth } from './health.js';
import { startServer } from './server/index.js';
import { PresenceKeeper } from './connection.js';
import { buildProxy } from './proxy.js';

const SCHEDULE_TICK_MS = 30000; // как часто сверяемся с расписанием

// Одна проверка валидности токена через auth.test -> обновляет health-состояние.
async function checkToken({ slack, health, keeper }) {
  try {
    const who = await slack.authTest();
    health.markValid({ user: who.user, team: who.team });
    if (keeper) keeper.setIdentity(who.user_id, who.url);
    return who;
  } catch (e) {
    // Ошибки авторизации = протухший токен; прочие (сеть) — временные, не паникуем.
    if (isAuthError(e.message)) health.markInvalid(e.message);
    else log.warn('auth.test временно не прошёл (вероятно, сеть):', e.message);
    return null;
  }
}

async function main() {
  log.info('slack-keep-active запускается…');

  // Чтение и валидация конфига + сборка прокси — единственное место с process.exit при ошибке.
  // Источники значений: переменные окружения -> config.yaml (--config) -> дефолты.
  // Если прокси задан, но опциональные пакеты не установлены — buildProxy бросит понятную ошибку.
  let config;
  let proxy;
  try {
    const yaml = readYamlConfig(process.argv.slice(2));
    config = loadConfig(process.env, yaml, { onWarn: (m) => log.warn(m) });
    proxy = await buildProxy(config);
  } catch (e) {
    log.error(e.message);
    process.exit(1);
  }

  log.setLevel(config.logLevel); // применяем уровень логов из конфига (ENV -> YAML -> дефолт)
  log.debug(`Конфиг собран: tz=${config.timezone}, offHours=${config.offHoursMode}, logLevel=${config.logLevel}, UA="${config.userAgent.slice(0, 40)}…"`);
  if (proxy.enabled) log.info(`HTTP/S-прокси включён: ${proxy.proxyUrl}`);

  // Сборка компонентов из конфига. fetchImpl прокидывает прокси-dispatcher (если включён).
  const slack = createSlackClient({
    apiBase: config.apiBase,
    xoxc: config.xoxc,
    xoxd: config.xoxd,
    userAgent: config.userAgent,
    fetchImpl: proxy.fetchImpl,
  });
  const schedule = createSchedule(config);
  const health = createHealth({ pongTimeoutMs: config.pongTimeoutMs });
  const notify = createNotifier({ webhookUrl: config.webhookUrl, fetchImpl: proxy.fetchImpl });

  // Маршрут /react включается только при заданном CONTROL_TOKEN. Он без состояния:
  // канал и ts берутся прямо из пути (channel+ts — идентификатор сообщения в Slack).
  const react = config.controlToken ? { slack, token: config.controlToken } : null;
  startServer({ port: config.apiPort, health, react });
  if (react) log.info('Маршрут POST /react/{channel}/{ts} включён (защищён CONTROL_TOKEN).');
  else log.debug('Маршрут /react выключен (CONTROL_TOKEN не задан).');

  const keeper = new PresenceKeeper({
    slack,
    notify,
    health,
    wsAgent: proxy.wsAgent,
    timings: {
      pingIntervalMs: config.pingIntervalMs,
      pongTimeoutMs: config.pongTimeoutMs,
      presenceRefreshMs: config.presenceRefreshMs,
    },
    behavior: {
      offHoursMode: config.offHoursMode,
      clearDnd: config.clearDnd,
      notifyMentions: config.notifyMentions,
      mentionChannelWide: config.mentionChannelWide,
      notifyDM: config.notifyDM,
      dmChannelPrefixes: config.dmChannelPrefixes,
      notifyGroupDm: config.notifyGroupDm,
      notifyKeywords: config.notifyKeywords,
      notifySelf: config.notifySelf,
    },
  });

  // Стартовая проверка: без валидного токена работать смысла нет.
  const who = await checkToken({ slack, health, keeper });
  if (who) log.info(`Авторизован как @${who.user} в workspace «${who.team}».`);
  else log.error('Старт без валидной авторизации — жду исправления токена в .env.');
  if (config.webhookUrl) log.info('Мониторинг упоминаний/DM включён, уведомления на webhook.');
  else log.info('Мониторинг упоминаний/DM включён (только в лог — WEBHOOK_URL не задан).');

  // Периодический healthcheck токена (заодно обновляет identity у keeper).
  const healthTimer = setInterval(() => checkToken({ slack, health, keeper }), config.healthCheckMs);

  // Сверка с расписанием: включаем в рабочие часы, отпускаем вне их.
  let lastState = null;
  async function tick() {
    const want = schedule.isWithinWorkHours();
    if (want !== lastState) {
      log.info(`Расписание: ${schedule.describeNow()} → ${want ? 'рабочее время' : 'вне расписания'}.`);
      lastState = want;
    }
    if (want) await keeper.start();
    else await keeper.stop();
  }

  await tick();
  const schedTimer = setInterval(tick, SCHEDULE_TICK_MS);

  // Корректное завершение по сигналам (важно для Docker stop). Повторный сигнал —
  // не запускаем shutdown дважды.
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Получен ${sig}, завершаюсь…`);
    clearInterval(schedTimer);
    clearInterval(healthTimer);
    await keeper.shutdown();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('Фатальная ошибка:', e);
  process.exit(1);
});
