import { describe, test, expect } from 'vitest';
import { createNotifier } from '../../src/notifier.js';
import { makeSilentLogger } from '../helpers/util.js';

// Мок fetch: отдаёт заранее заданную очередь ответов и считает вызовы.
function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { ok: next.ok, status: next.status };
  };
  fn.calls = calls;
  return fn;
}

const PAYLOAD = { kind: 'mention', from: 'Alice', text: 'привет @me' };

describe('createNotifier — доставка уведомлений', () => {
  /**
   * Что: режим без webhook.
   * Вход: webhookUrl пуст.
   * Поведение: событие только логируется, HTTP не дёргается.
   * Ожидаем: возврат false, fetch не вызван, есть info-запись.
   */
  test('без webhookUrl только логирует и не шлёт HTTP', async () => {
    const fetchImpl = mockFetch([{ ok: true, status: 200 }]);
    const logger = makeSilentLogger();
    const notify = createNotifier({ webhookUrl: '', fetchImpl, logger });

    const delivered = await notify(PAYLOAD);
    expect(delivered).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
    expect(logger.records.info.some((l) => l.includes('Alice'))).toBe(true);
  });

  /**
   * Что: успешная доставка.
   * Вход: webhook отвечает 200 с первого раза.
   * Поведение: одна попытка, payload уходит POST'ом JSON.
   * Ожидаем: возврат true, ровно 1 вызов, тело — сериализованный payload.
   */
  test('успешный webhook -> одна попытка и true', async () => {
    const fetchImpl = mockFetch([{ ok: true, status: 200 }]);
    const notify = createNotifier({ webhookUrl: 'http://hook.local', fetchImpl, logger: makeSilentLogger() });

    const delivered = await notify(PAYLOAD);
    expect(delivered).toBe(true);
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].opts.method).toBe('POST');
    expect(JSON.parse(fetchImpl.calls[0].opts.body).from).toBe('Alice');
  });

  /**
   * Что: ретраи на ошибке сервера.
   * Вход: webhook всегда отвечает 500, retries=2.
   * Поведение: делаем ровно retries попыток, затем сдаёмся.
   * Ожидаем: возврат false и 2 вызова fetch.
   */
  test('5xx -> ретраи до предела и false', async () => {
    const fetchImpl = mockFetch([{ ok: false, status: 500 }]);
    const notify = createNotifier({ webhookUrl: 'http://hook.local', fetchImpl, logger: makeSilentLogger(), retries: 2 });

    const delivered = await notify(PAYLOAD);
    expect(delivered).toBe(false);
    expect(fetchImpl.calls.length).toBe(2);
  });

  /**
   * Что: восстановление после первой неудачи.
   * Вход: первый ответ 500, второй 200.
   * Поведение: вторая попытка успешна.
   * Ожидаем: возврат true и 2 вызова.
   */
  test('5xx затем 200 -> доставлено со второй попытки', async () => {
    const fetchImpl = mockFetch([{ ok: false, status: 500 }, { ok: true, status: 200 }]);
    const notify = createNotifier({ webhookUrl: 'http://hook.local', fetchImpl, logger: makeSilentLogger(), retries: 2 });

    const delivered = await notify(PAYLOAD);
    expect(delivered).toBe(true);
    expect(fetchImpl.calls.length).toBe(2);
  });

  /**
   * Что: сетевые сбои (throw).
   * Вход: fetch бросает исключение на каждой попытке.
   * Поведение: исключение ловится, идут ретраи, затем false.
   * Ожидаем: возврат false и retries вызовов.
   */
  test('исключение fetch -> ретраи и false', async () => {
    const fetchImpl = mockFetch([new Error('ECONNREFUSED')]);
    const notify = createNotifier({ webhookUrl: 'http://hook.local', fetchImpl, logger: makeSilentLogger(), retries: 2 });

    const delivered = await notify(PAYLOAD);
    expect(delivered).toBe(false);
    expect(fetchImpl.calls.length).toBe(2);
  });
});
