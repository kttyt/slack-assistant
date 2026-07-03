// Обработчик POST /react/{channel}/{ts}: ставит реакцию на сообщение.
// Канал и ts берутся прямо из пути (Slack идентифицирует сообщение парой channel+ts —
// у сообщений нет глобального ID, ts уникален лишь в пределах канала). Маршрут без состояния.
// Доступ — по общему секрету (token). Тело: { "reactionEmoji": ":eyes:" } (двоеточия срезаются).
// Ответы: 200 ok | 401 unauthorized | 400 bad body | 502 slack error.
import { log as defaultLog } from '../../logger.js';
import { sendJson, readJson, tokenFromReq, safeEqual } from '../http-util.js';

export function reactHandler({ slack, token, logger = defaultLog }) {
  return async (req, res, params) => {
    if (!token || !safeEqual(tokenFromReq(req), token)) {
      logger.warn('/react: неавторизованный запрос отклонён.');
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    const channel = decodeURIComponent(params.channel);
    const ts = decodeURIComponent(params.ts);

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message === 'too_large' ? 'body_too_large' : 'bad_json' });
    }
    const emoji = String(body.reactionEmoji || '').trim().replace(/^:+/, '').replace(/:+$/, '');
    if (!emoji) return sendJson(res, 400, { ok: false, error: 'missing_reactionEmoji' });

    try {
      await slack.reactionsAdd(channel, ts, emoji);
      logger.info(`/react: поставил :${emoji}: на ${ts} в ${channel}.`);
      return sendJson(res, 200, { ok: true, channel, ts, reaction: emoji });
    } catch (e) {
      const err = String(e.message || '').replace(/^.*:\s*/, '');
      if (err === 'already_reacted') {
        // Идемпотентно: реакция уже стоит — считаем успехом.
        return sendJson(res, 200, { ok: true, channel, ts, reaction: emoji, alreadyReacted: true });
      }
      logger.warn(`/react: reactions.add не удался: ${e.message}`);
      return sendJson(res, 502, { ok: false, error: err || 'reactions_add_failed' });
    }
  };
}
