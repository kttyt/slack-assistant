import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createHealth } from '../../src/health.js';
import { startServer } from '../../src/server/index.js';
import { makeSilentLogger } from '../helpers/util.js';

// Реальный HTTP-сервер (только /health, без /react) на эфемерном порту, запросы настоящим fetch.
let server;
let health;
let base;

beforeEach(async () => {
  health = createHealth({ pongTimeoutMs: 100, logger: makeSilentLogger() });
  server = startServer({ port: 0, health, logger: makeSilentLogger() });
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((res) => server.close(res));
});

describe('startServer — HTTP /health', () => {
  /**
   * Что: ответ до первой проверки токена.
   * Вход: GET /health на свежем состоянии.
   * Поведение: неизвестная валидность -> 503 status=starting.
   * Ожидаем: HTTP 503, поле status='starting'.
   */
  test('до проверки токена отдаёт 503 starting', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('starting');
  });

  /**
   * Что: здоровое состояние.
   * Вход: markValid, затем GET /health.
   * Поведение: валидный токен без деградации -> 200.
   * Ожидаем: HTTP 200, status='ok', есть поля wsConnected/lastPongAt/activeIntended.
   */
  test('валидный токен -> 200 ok со всеми полями', async () => {
    health.markValid({ user: 'bob', team: 'ACME' });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.user).toBe('bob');
    expect(body).toHaveProperty('wsConnected');
    expect(body).toHaveProperty('lastPongAt');
    expect(body).toHaveProperty('activeIntended');
  });

  /**
   * Что: нездоровое состояние по токену.
   * Вход: markInvalid, затем GET /health.
   * Поведение: протухший токен -> 503.
   * Ожидаем: HTTP 503, status='token_invalid'.
   */
  test('протухший токен -> 503 token_invalid', async () => {
    health.markInvalid('invalid_auth');
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('token_invalid');
  });

  /**
   * Что: неизвестный маршрут.
   * Вход: GET на несуществующий путь.
   * Поведение: роутер не нашёл маршрут -> сервер отдаёт 404.
   * Ожидаем: HTTP 404 с телом { ok:false, error:'not_found' }.
   */
  test('неизвестный путь -> 404 not_found', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  /**
   * Что: /react выключен без react-зависимостей.
   * Вход: POST /react/1.2 на сервер без react.
   * Поведение: маршрут не зарегистрирован -> 404.
   * Ожидаем: HTTP 404.
   */
  test('/react отсутствует, если react не передан', async () => {
    const res = await fetch(`${base}/react/1.2`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
