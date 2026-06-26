// Отслеживает валидность токена и отдаёт состояние по HTTP для Docker HEALTHCHECK.
// Эндпоинты: GET /health -> 200 (ok) / 503 (token_invalid или ещё не проверено).
import http from 'node:http';
import { config } from './config.js';
import { log } from './logger.js';

const state = {
  tokenValid: null, // null = ещё не проверяли, true/false = результат последней проверки
  lastOkAt: null,
  lastError: null,
  user: null,
  team: null,
};

let warned = false; // чтобы не спамить лог при каждом провале подряд

// Зафиксировать успешную авторизацию.
export function markValid(info = {}) {
  state.tokenValid = true;
  state.lastOkAt = new Date().toISOString();
  state.lastError = null;
  if (info.user) state.user = info.user;
  if (info.team) state.team = info.team;
  if (warned) {
    log.info('Токен снова валиден — авторизация восстановлена.');
    warned = false;
  }
}

// Зафиксировать протухание/невалидность токена. Громко предупреждаем один раз.
export function markInvalid(error) {
  state.tokenValid = false;
  state.lastError = error;
  if (!warned) {
    warned = true;
    log.error('========================================================');
    log.error(`ТОКЕН ПРОТУХ ИЛИ НЕВАЛИДЕН: ${error}`);
    log.error('Презенс держать не получится. Обновите SLACK_XOXC_TOKEN и');
    log.error('SLACK_XOXD_COOKIE в .env (см. README) и перезапустите контейнер.');
    log.error('Контейнер помечен как unhealthy.');
    log.error('========================================================');
  }
}

export function isTokenValid() {
  return state.tokenValid === true;
}

// Набор ошибок Slack, означающих, что токен/cookie больше не работают.
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
]);

export function isAuthError(slackError) {
  return AUTH_ERRORS.has(String(slackError || '').replace(/^.*:\s*/, ''));
}

// Поднять HTTP-сервер для healthcheck.
export function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const ok = state.tokenValid === true;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: state.tokenValid === null ? 'starting' : ok ? 'ok' : 'token_invalid',
          tokenValid: state.tokenValid,
          lastOkAt: state.lastOkAt,
          lastError: state.lastError,
          user: state.user,
          team: state.team,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (e) => log.warn('Health-сервер:', e.message));
  server.listen(config.healthPort, () => log.info(`Health-сервер на порту ${config.healthPort}.`));
  return server;
}
