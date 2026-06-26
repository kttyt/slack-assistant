// Тонкая обёртка над Slack Web API с авторизацией токеном веб-клиента (xoxc) и cookie "d" (xoxd).
// Используем именно сессию веб-клиента, потому что современные scoped-приложения (xoxp)
// больше не имеют доступа к RTM WebSocket, а первый-сторонний веб-токен — имеет.
import { config } from './config.js';
import { log } from './logger.js';

const BASE = 'https://slack.com/api';

// Вызов метода Web API. Форма urlencoded — так общается сам веб-клиент.
async function call(method, params = {}) {
  const body = new URLSearchParams({ token: config.xoxc, ...params });
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      // Cookie "d" обязателен — без неё xoxc-токен не принимается.
      // Значение уже URL-кодировано (как в браузере), поэтому НЕ кодируем повторно.
      Cookie: `d=${config.xoxd}`,
      'User-Agent': 'slack-keep-active/1.0',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`${method}: ${data.error || 'unknown_error'}`);
  }
  return data;
}

// Проверка валидности токена/cookie. Возвращает данные пользователя.
export async function authTest() {
  return call('auth.test');
}

// Получить WebSocket-URL реального-времени. Это та же точка входа, что у веб-клиента.
export async function rtmConnect() {
  const data = await call('rtm.connect', { presence_sub: 'false', batch_presence_aware: '1' });
  return data.url;
}

// Установить режим присутствия: 'auto' (Slack решает по активности) или 'away'.
export async function setPresence(presence) {
  return call('users.setPresence', { presence });
}

// Состояние "Не беспокоить" (snooze/dnd).
export async function dndInfo() {
  return call('dnd.info');
}

// Снять ручной снуз ("Не беспокоить"), чтобы убрать значок Zzz.
export async function endSnooze() {
  return call('dnd.endSnooze');
}

// Резолв имени пользователя по id (с кэшем, чтобы не дёргать API на каждое сообщение).
const userCache = new Map();
export async function userName(id) {
  if (!id) return id;
  if (userCache.has(id)) return userCache.get(id);
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

export { call as rawCall };
