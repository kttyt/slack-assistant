// Состояние здоровья сервиса: валидность токена + состояние WebSocket-соединения.
// Это ЧИСТОЕ доменное состояние (без HTTP): рендер в ответ /health живёт в
// src/server/handlers/health.js, а сам сервер — в src/server/index.js.
// Нездоров, если токен протух ИЛИ мы должны быть онлайн (рабочие часы), но соединение
// мертво дольше pongTimeoutMs (то есть это не короткий «дышащий» реконнект).
//
// Фабрика createHealth(): состояние инкапсулировано в экземпляре, никакого модульного
// синглтона — можно поднимать независимые копии в тестах. now инъектируется для детерминизма.
import { log as defaultLog } from './logger.js';

export function createHealth({ pongTimeoutMs, logger = defaultLog, now = () => Date.now() } = {}) {
  const state = {
    tokenValid: null, // null = ещё не проверяли, true/false = результат последней проверки
    lastOkAt: null,
    lastError: null,
    user: null,
    team: null,
    activeIntended: false, // хотим ли мы сейчас держать соединение (по расписанию)
    wsConnected: false, // открыт ли WebSocket прямо сейчас
    lastPongAt: null, // время последнего pong от Slack (ISO)
    socketDownSince: null, // с какого момента сокет лежит, будучи нужным (мс, epoch)
    realPresence: null, // фактический presence по users.getPresence: null=неизвестно | 'active' | 'away'
    realPresenceAt: null, // когда последний раз проверяли реальный presence (ISO)
    dnd: null, // последнее известное состояние DND (снимок значимых полей dnd.info)
    dndAt: null, // когда обновляли состояние DND (ISO)
  };

  let warned = false; // чтобы не спамить лог при каждом провале подряд

  function markValid(info = {}) {
    state.tokenValid = true;
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    if (info.user) state.user = info.user;
    if (info.team) state.team = info.team;
    if (warned) {
      logger.info('Токен снова валиден — авторизация восстановлена.');
      warned = false;
    }
  }

  function markInvalid(error) {
    state.tokenValid = false;
    state.lastError = error;
    if (!warned) {
      warned = true;
      logger.error('========================================================');
      logger.error(`ТОКЕН ПРОТУХ ИЛИ НЕВАЛИДЕН: ${error}`);
      logger.error('Презенс держать не получится. Обновите SLACK_XOXC_TOKEN и');
      logger.error('SLACK_XOXD_COOKIE в .env (см. README) и перезапустите контейнер.');
      logger.error('Контейнер помечен как unhealthy.');
      logger.error('========================================================');
    }
  }

  // Планировщик сообщает, должны ли мы сейчас быть онлайн. Вне рабочих часов «лежащий»
  // сокет — это норма, поэтому сбрасываем счётчик простоя.
  function markActiveIntended(intended) {
    state.activeIntended = intended;
    if (!intended) {
      state.socketDownSince = null;
      // Presence опрашивается только при живом соединении; вне расписания последнее
      // значение мгновенно устаревает — сбрасываем в «неизвестно», чтобы /health не
      // показывал застывший 'active' после выхода из рабочего окна.
      state.realPresence = null;
      state.realPresenceAt = null;
    }
  }

  function markSocketConnected() {
    state.wsConnected = true;
    state.socketDownSince = null;
  }

  // Отсчёт простоя начинаем только когда мы хотели быть онлайн.
  function markSocketDisconnected() {
    state.wsConnected = false;
    if (state.activeIntended && state.socketDownSince === null) {
      state.socketDownSince = now();
    }
  }

  function markPong() {
    state.lastPongAt = new Date().toISOString();
  }

  // Фактический presence из users.getPresence — делает /health честным (а не «ложно-зелёным»).
  function markPresence(presence) {
    state.realPresence = presence;
    state.realPresenceAt = new Date().toISOString();
  }

  // Текущее состояние DND (снимок значимых полей) — для наблюдаемости через /health.
  function markDnd(dnd) {
    state.dnd = dnd;
    state.dndAt = new Date().toISOString();
  }

  // Мы должны быть онлайн, соединение живо, но Slack видит нас 'away' — presence не держится.
  function presenceLost() {
    return state.activeIntended && state.realPresence === 'away';
  }

  // Соединение мертво «слишком долго»: нужно быть онлайн, но сокета нет дольше pongTimeoutMs.
  function socketDegraded() {
    if (!state.activeIntended || state.wsConnected) return false;
    if (state.socketDownSince === null) return false;
    return now() - state.socketDownSince > pongTimeoutMs;
  }

  // Снимок для HTTP-ответа + вычисленные ok/status.
  function snapshot() {
    const degraded = socketDegraded();
    const lostPresence = presenceLost();
    const ok = state.tokenValid === true && !degraded && !lostPresence;
    let status;
    if (state.tokenValid === null) status = 'starting';
    else if (state.tokenValid !== true) status = 'token_invalid';
    else if (degraded) status = 'socket_down';
    else if (lostPresence) status = 'presence_away';
    else status = 'ok';
    return {
      ok,
      status,
      tokenValid: state.tokenValid,
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
      user: state.user,
      team: state.team,
      activeIntended: state.activeIntended,
      wsConnected: state.wsConnected,
      lastPongAt: state.lastPongAt,
      realPresence: state.realPresence,
      realPresenceAt: state.realPresenceAt,
      dnd: state.dnd,
      dndAt: state.dndAt,
    };
  }

  return {
    markValid,
    markInvalid,
    markActiveIntended,
    markSocketConnected,
    markSocketDisconnected,
    markPong,
    markPresence,
    markDnd,
    isTokenValid: () => state.tokenValid === true,
    socketDegraded,
    presenceLost,
    snapshot,
  };
}
