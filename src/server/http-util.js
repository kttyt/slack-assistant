// Мелкие помощники для HTTP-обработчиков: единый ответ JSON, чтение тела, извлечение и
// безопасное сравнение токена. Держим их отдельно, чтобы обработчики оставались короткими.
import { timingSafeEqual } from 'node:crypto';

// Ответ JSON одним вызовом.
export function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Прочитать JSON-тело запроса с лимитом размера. Бросает Error('too_large' | 'bad_json').
export function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

// Достать bearer-токен из Authorization или X-Control-Token.
export function tokenFromReq(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-control-token'];
  return x ? String(x).trim() : '';
}

// Сравнение секретов за постоянное время (защита от тайминг-атак).
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
