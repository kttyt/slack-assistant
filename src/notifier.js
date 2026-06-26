// Доставка уведомлений о новых упоминаниях/DM на произвольный webhook (POST JSON).
// Если WEBHOOK_URL не задан — событие только логируется (webhook не вызывается).
import { config } from './config.js';
import { log } from './logger.js';

export async function notify(payload) {
  const head = `${payload.kind === 'mention' ? 'Упоминание' : 'Личное сообщение'} от ${payload.from}`;
  log.info(`🔔 ${head}: ${String(payload.text || '').slice(0, 100)}`);

  if (!config.webhookUrl) {
    log.debug('WEBHOOK_URL не задан — уведомление только в лог.');
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        log.debug(`Webhook доставлен (HTTP ${res.status}).`);
        return;
      }
      log.warn(`Webhook вернул HTTP ${res.status} (попытка ${attempt}).`);
    } catch (e) {
      log.warn(`Webhook ошибка (попытка ${attempt}): ${e.message}`);
    }
  }
  log.warn('Webhook не доставлен после 2 попыток.');
}
