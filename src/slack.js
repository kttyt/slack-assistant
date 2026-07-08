// Клиент Slack Web API с авторизацией токеном веб-клиента (xoxc) и cookie "d" (xoxd).
// Используем именно сессию веб-клиента, потому что современные scoped-приложения (xoxp)
// больше не имеют доступа к RTM WebSocket, а первый-сторонний веб-токен — имеет.
//
// Фабрика: никакой глобальной конфигурации. Всё (база API, токен, cookie, UA, реализация fetch)
// передаётся явно — это делает клиент тривиально мокаемым и позволяет бить в фейковый сервер.
import { log as defaultLog } from './logger.js';
import { DEFAULT_USER_AGENT } from './config.js';

// Набор ошибок Slack, означающих, что токен/cookie больше не работают.
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

// Строку ошибки Slack ("method: code" или просто "code") относим к протуханию токена.
export function isAuthError(slackError) {
  return AUTH_ERRORS.has(String(slackError || '').replace(/^.*:\s*/, ''));
}

// Создать клиент. fetchImpl инъектируется для тестов/прокси (по умолчанию — глобальный fetch).
export function createSlackClient({
  apiBase = 'https://slack.com/api',
  xoxc,
  xoxd,
  userAgent = DEFAULT_USER_AGENT,
  fetchImpl = fetch,
  logger = defaultLog,
}) {
  const base = apiBase.replace(/\/$/, '');
  const userCache = new Map();

  // Вызов метода Web API. Форма urlencoded — так общается сам веб-клиент.
  async function call(method, params = {}) {
    const body = new URLSearchParams({ token: xoxc, ...params });
    logger.debug(`Slack API -> ${method} (${Object.keys(params).join(',') || 'нет параметров'})`);
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        // Cookie "d" обязателен — без неё xoxc-токен не принимается.
        // Значение уже URL-кодировано (как в браузере), поэтому НЕ кодируем повторно.
        Cookie: `d=${xoxd}`,
        'User-Agent': userAgent,
      },
      body,
    });

    if (!res.ok) {
      logger.debug(`Slack API <- ${method}: HTTP ${res.status}`);
      throw new Error(`${method}: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.ok) {
      logger.debug(`Slack API <- ${method}: ошибка «${data.error || 'unknown_error'}»`);
      throw new Error(`${method}: ${data.error || 'unknown_error'}`);
    }
    logger.debug(`Slack API <- ${method}: ok`);
    return data;
  }

  // Резолв имени пользователя по id (с кэшем, чтобы не дёргать API на каждое сообщение).
  async function userName(id) {
    if (!id) return id;
    if (userCache.has(id)) {
      logger.debug(`userName(${id}): из кэша`);
      return userCache.get(id);
    }
    try {
      const d = await call('users.info', { user: id });
      const p = d.user?.profile || {};
      const name = p.display_name || d.user?.real_name || p.real_name || d.user?.name || id;
      userCache.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  return {
    call,
    // Проверка валидности токена/cookie. Возвращает данные пользователя.
    authTest: () => call('auth.test'),
    // WebSocket-URL реального времени (та же точка входа, что у веб-клиента).
    // presence_sub:true — подписка на события своего presence (нужна для честной верификации).
    rtmConnect: async () => {
      const data = await call('rtm.connect', { presence_sub: 'true', batch_presence_aware: '1' });
      return data.url;
    },
    // Режим присутствия: 'auto' (Slack решает по активности) или 'away'.
    setPresence: (presence) => call('users.setPresence', { presence }),
    // Реальный presence пользователя ('active'/'away'). Для собственного id отдаёт и last_activity.
    getPresence: (user) => call('users.getPresence', { user }),
    // Состояние "Не беспокоить" (snooze/dnd).
    dndInfo: () => call('dnd.info'),
    // Снять ручной снуз ("Не беспокоить"), чтобы убрать значок Zzz.
    endSnooze: () => call('dnd.endSnooze'),
    // Завершить текущую DND-сессию (в т.ч. по расписанию) — снимает scheduled Zzz.
    endDnd: () => call('dnd.endDnd'),
    // Поставить реакцию на сообщение. name — эмодзи БЕЗ двоеточий (напр. "eyes").
    reactionsAdd: (channel, timestamp, name) => call('reactions.add', { channel, timestamp, name }),
    // Корневое сообщение треда (для «шапки» уведомления об ответе в треде).
    // conversations.replies отдаёт сообщения от корня; с limit=1+inclusive это ровно родитель.
    threadRoot: async (channel, ts) => {
      const d = await call('conversations.replies', { channel, ts, limit: '1', inclusive: 'true' });
      return d.messages?.[0] || null;
    },
    userName,
    // Заголовки для WebSocket-рукопожатия: cookie "d" + тот же User-Agent, что и у Web API.
    wsHeaders: () => ({ Cookie: `d=${xoxd}`, 'User-Agent': userAgent }),
  };
}
