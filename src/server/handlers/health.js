// Обработчик GET /health: рендерит снимок состояния (createHealth) в HTTP-ответ.
// 200, если токен валиден и соединение не деградировало; иначе 503.
import { sendJson } from '../http-util.js';

export function healthHandler(health) {
  return (req, res) => {
    const snap = health.snapshot();
    const { ok, ...body } = snap;
    sendJson(res, ok ? 200 : 503, body);
  };
}
