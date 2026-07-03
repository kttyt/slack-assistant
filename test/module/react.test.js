import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createSlackClient } from '../../src/slack.js';
import { createHealth } from '../../src/health.js';
import { startServer } from '../../src/server/index.js';
import { createFakeSlack } from '../helpers/fake-slack.js';
import { makeSilentLogger } from '../helpers/util.js';

// Реальный HTTP-сервер (/health + /react) + реальный slack-клиент против фейкового Slack.
// Маршрут без состояния: channel и ts приходят прямо в пути.
const TOKEN = 'sekret-123';
let fake;
let slack;
let health;
let server;
let base;

beforeEach(async () => {
  fake = createFakeSlack();
  const { apiBase } = await fake.start();
  slack = createSlackClient({ apiBase, xoxc: 'xoxc-t', xoxd: 'xoxd-c', logger: makeSilentLogger() });
  health = createHealth({ pongTimeoutMs: 100, logger: makeSilentLogger() });
  server = startServer({ port: 0, health, react: { slack, token: TOKEN }, logger: makeSilentLogger() });
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((res) => server.close(res));
  await fake.stop();
});

function react(channel, ts, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/react/${channel}/${ts}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

describe('POST /react/{channel}/{ts} — постановка реакции', () => {
  /**
   * Что: успешная реакция.
   * Вход: валидный токен, channel+ts в пути, {reactionEmoji: ':eyes:'}.
   * Поведение: двоеточия срезаются, зовётся reactions.add с channel и ts из пути.
   * Ожидаем: 200 ok; на сервере реакция {channel:'C1', timestamp:'111.222', name:'eyes'}.
   */
  test('валидный запрос ставит реакцию', async () => {
    const res = await react('C1', '111.222', { token: TOKEN, body: { reactionEmoji: ':eyes:' } });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(fake.state.reactions).toContainEqual({ channel: 'C1', timestamp: '111.222', name: 'eyes' });
  });

  /**
   * Что: аутентификация обязательна.
   * Вход: без токена и с неверным токеном.
   * Поведение: отклоняется до обращения к Slack.
   * Ожидаем: 401 в обоих случаях; реакций не поставлено.
   */
  test('без токена / с неверным токеном -> 401', async () => {
    expect((await react('C1', '111.222', { body: { reactionEmoji: ':eyes:' } })).status).toBe(401);
    expect((await react('C1', '111.222', { token: 'wrong', body: { reactionEmoji: ':eyes:' } })).status).toBe(401);
    expect(fake.state.reactions).toHaveLength(0);
  });

  /**
   * Что: заголовок X-Control-Token тоже принимается.
   * Вход: секрет в X-Control-Token вместо Authorization.
   * Поведение: обе схемы передачи токена валидны.
   * Ожидаем: 200.
   */
  test('X-Control-Token принимается', async () => {
    const res = await fetch(`${base}/react/C1/111.222`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Control-Token': TOKEN },
      body: JSON.stringify({ reactionEmoji: 'eyes' }),
    });
    expect(res.status).toBe(200);
  });

  /**
   * Что: отсутствует эмодзи.
   * Вход: пустое тело.
   * Поведение: валидация тела до Slack.
   * Ожидаем: 400 missing_reactionEmoji.
   */
  test('без reactionEmoji -> 400', async () => {
    const res = await react('C1', '111.222', { token: TOKEN, body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing_reactionEmoji');
  });

  /**
   * Что: неполный путь (без ts).
   * Вход: POST /react/C1 (один сегмент).
   * Поведение: маршрут требует и channel, и ts.
   * Ожидаем: 404 not_found.
   */
  test('без сегмента ts -> 404', async () => {
    const res = await fetch(`${base}/react/C1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  /**
   * Что: идемпотентность при already_reacted.
   * Вход: Slack отвечает ошибкой already_reacted.
   * Поведение: считаем успехом (реакция уже стоит).
   * Ожидаем: 200 с флагом alreadyReacted.
   */
  test('already_reacted трактуется как успех', async () => {
    fake.setError('reactions.add', 'already_reacted');
    const res = await react('C1', '111.222', { token: TOKEN, body: { reactionEmoji: ':eyes:' } });
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyReacted).toBe(true);
  });

  /**
   * Что: прочие ошибки Slack.
   * Вход: Slack отвечает invalid_name.
   * Поведение: пробрасываем как ошибку шлюза.
   * Ожидаем: 502 с кодом ошибки.
   */
  test('ошибка Slack -> 502', async () => {
    fake.setError('reactions.add', 'invalid_name');
    const res = await react('C1', '111.222', { token: TOKEN, body: { reactionEmoji: ':nope:' } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('invalid_name');
  });

  /**
   * Что: неверный HTTP-метод.
   * Вход: GET на /react/{channel}/{ts}.
   * Поведение: маршрут только POST.
   * Ожидаем: 405.
   */
  test('GET /react -> 405', async () => {
    const res = await fetch(`${base}/react/C1/111.222`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });

  /**
   * Что: сосуществование с /health.
   * Вход: GET /health на том же сервере.
   * Поведение: роутер отдаёт /health как обычно.
   * Ожидаем: /health отвечает (503 starting до проверки токена).
   */
  test('/health продолжает работать рядом с /react', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('starting');
  });
});
