// Доставка уведомлений о новых упоминаниях/DM на произвольный webhook (POST JSON).
// Если webhookUrl пуст — событие только логируется (webhook не вызывается).
//
// Фабрика: webhookUrl, реализация fetch, логгер и параметры ретраев инъектируются.
import { log as defaultLog } from './logger.js';

export function createNotifier({
  webhookUrl = '',
  fetchImpl = fetch,
  logger = defaultLog,
  timeoutMs = 5000,
  retries = 2,
} = {}) {
  const LABELS = {
    mention: 'Упоминание',
    dm: 'Личное сообщение',
    group_dm: 'Групповой чат',
    keyword: 'Ключевое слово',
  };

  return async function notify(payload) {
    const label = LABELS[payload.kind] || 'Сообщение';
    const suffix = payload.kind === 'keyword' && payload.keyword ? ` [${payload.keyword}]` : '';
    const head = `${label}${suffix} от ${payload.from}`;
    // channel+ts в INFO — по ним удобно дёргать POST /react/{channel}/{ts}.
    const chTag = payload.channel ? ` ch=${payload.channel}` : '';
    const tsTag = payload.ts ? ` ts=${payload.ts}` : '';
    logger.info(`🔔 ${head}${chTag}${tsTag}: ${String(payload.text || '').slice(0, 100)}`);

    if (!webhookUrl) {
      logger.debug('WEBHOOK_URL не задан — уведомление только в лог.');
      return false;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          });
          if (res.ok) {
            logger.debug(`Webhook доставлен (HTTP ${res.status}).`);
            return true;
          }
          logger.warn(`Webhook вернул HTTP ${res.status} (попытка ${attempt}).`);
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        logger.warn(`Webhook ошибка (попытка ${attempt}): ${e.message}`);
      }
    }
    logger.warn(`Webhook не доставлен после ${retries} попыток.`);
    return false;
  };
}
