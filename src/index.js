// Точка входа: проверяет токены, поднимает health-сервер, затем по таймеру
// включает/выключает присутствие согласно (плавающему) расписанию.
import { config } from './config.js';
import { log } from './logger.js';
import { authTest } from './slack.js';
import { isWithinWorkHours, describeNow } from './schedule.js';
import { PresenceKeeper } from './connection.js';
import { startHealthServer, markValid, markInvalid, isAuthError } from './health.js';

const SCHEDULE_TICK_MS = 30000; // как часто сверяемся с расписанием

// Одна проверка валидности токена через auth.test -> обновляет health-состояние.
async function checkToken(keeper) {
  try {
    const who = await authTest();
    markValid({ user: who.user, team: who.team });
    if (keeper) keeper.setIdentity(who.user_id, who.url);
    return who;
  } catch (e) {
    // Ошибки авторизации = протухший токен; прочие (сеть) — временные, не паникуем.
    if (isAuthError(e.message)) markInvalid(e.message);
    else log.warn('auth.test временно не прошёл (вероятно, сеть):', e.message);
    return null;
  }
}

async function main() {
  log.info('slack-keep-active запускается…');
  startHealthServer();

  const keeper = new PresenceKeeper();

  // Стартовая проверка: без валидного токена работать смысла нет.
  const who = await checkToken(keeper);
  if (who) log.info(`Авторизован как @${who.user} в workspace «${who.team}».`);
  else log.error('Старт без валидной авторизации — жду исправления токена в .env.');
  if (config.webhookUrl) log.info('Мониторинг упоминаний/DM включён, уведомления на webhook.');
  else log.info('Мониторинг упоминаний/DM включён (только в лог — WEBHOOK_URL не задан).');

  // Периодический healthcheck токена (заодно обновляет identity у keeper).
  const healthTimer = setInterval(() => checkToken(keeper), config.healthCheckMs);

  // Сверка с расписанием: включаем в рабочие часы, отпускаем вне их.
  let lastState = null;
  async function tick() {
    const want = isWithinWorkHours();
    if (want !== lastState) {
      log.info(`Расписание: ${describeNow()} → ${want ? 'рабочее время' : 'вне расписания'}.`);
      lastState = want;
    }
    if (want) await keeper.start();
    else await keeper.stop();
  }

  await tick();
  const schedTimer = setInterval(tick, SCHEDULE_TICK_MS);

  // Корректное завершение по сигналам (важно для Docker stop).
  async function shutdown(sig) {
    log.info(`Получен ${sig}, завершаюсь…`);
    clearInterval(schedTimer);
    clearInterval(healthTimer);
    keeper.active = false;
    keeper.teardownSocket();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('Фатальная ошибка:', e);
  process.exit(1);
});
