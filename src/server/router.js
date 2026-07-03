// Крошечный роутер для http-сервера без фреймворков.
// Регистрируем маршруты (метод + путь-шаблон с :params), диспетчеризуем запрос:
//   • совпал путь и метод -> вызываем обработчик (req, res, params);
//   • совпал путь, но не метод -> 405;
//   • ничего не совпало -> handle() вернёт false (сервер отдаст 404).
import { sendJson } from './http-util.js';

// Компилирует '/react/:ts' в матчер пути -> { ts } | null. Статические сегменты экранируются.
function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const rx = new RegExp('^' + source + '$');
  return (path) => {
    const m = rx.exec(path);
    if (!m) return null;
    const params = {};
    keys.forEach((k, i) => (params[k] = m[i + 1]));
    return params;
  };
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, match: compile(pattern), handler });

  async function handle(req, res) {
    const path = (req.url || '').split('?')[0];
    let pathMatched = false;
    for (const r of routes) {
      const params = r.match(path);
      if (!params) continue;
      pathMatched = true;
      if (r.method === req.method) {
        await r.handler(req, res, params);
        return true;
      }
    }
    if (pathMatched) {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    return false; // маршрут не найден — пусть решает сервер (404)
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    delete: (p, h) => add('DELETE', p, h),
    handle,
  };
}
