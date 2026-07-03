// HTTP-сервер сервиса: собирает роутер, регистрирует обработчики и слушает порт.
// Маршруты: GET /health всегда; POST /react/{ts} — только если передан react (при заданном
// CONTROL_TOKEN). Всё остальное — 404. Единственная точка, знающая про http.createServer.
import http from 'node:http';
import { log as defaultLog } from '../logger.js';
import { createRouter } from './router.js';
import { sendJson } from './http-util.js';
import { healthHandler } from './handlers/health.js';
import { reactHandler } from './handlers/react.js';

// startServer({ port, health, react, logger }):
//   health — экземпляр createHealth (состояние для /health);
//   react  — { slack, token } для /react/{channel}/{ts}, либо null (маршрут выключен).
export function startServer({ port, health, react = null, logger = defaultLog }) {
  const router = createRouter();
  router.get('/health', healthHandler(health));
  if (react) router.post('/react/:channel/:ts', reactHandler({ ...react, logger }));

  const server = http.createServer((req, res) => {
    router
      .handle(req, res)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { ok: false, error: 'not_found' });
      })
      .catch((e) => {
        logger.warn('Ошибка HTTP-обработчика:', e.message);
        try {
          sendJson(res, 500, { ok: false, error: 'internal_error' });
        } catch {
          /* ответ уже начат */
        }
      });
  });

  server.on('error', (e) => logger.warn('HTTP-сервер:', e.message));
  server.listen(port, () => logger.info(`HTTP-сервер (/health${react ? ', /react' : ''}) на порту ${port}.`));
  return server;
}
