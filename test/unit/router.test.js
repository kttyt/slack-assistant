import { describe, test, expect } from 'vitest';
import { createRouter } from '../../src/server/router.js';

// Мок res: копит статус и тело, отданные через sendJson (writeHead + end).
function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

describe('createRouter — сопоставление и диспетчеризация', () => {
  /**
   * Что: совпадение статического маршрута.
   * Вход: GET /health зарегистрирован, приходит GET /health.
   * Поведение: вызывается обработчик, handle() возвращает true.
   * Ожидаем: обработчик вызван один раз, handled=true.
   */
  test('статический маршрут вызывает обработчик', async () => {
    const router = createRouter();
    let hit = 0;
    router.get('/health', () => hit++);
    const handled = await router.handle({ method: 'GET', url: '/health' }, mockRes());
    expect(handled).toBe(true);
    expect(hit).toBe(1);
  });

  /**
   * Что: извлечение параметра пути.
   * Вход: POST /react/:ts, приходит /react/111.222 (с точкой).
   * Поведение: :ts матчится как один сегмент, точка допустима.
   * Ожидаем: params.ts = '111.222'.
   */
  test('параметр пути извлекается (в т.ч. с точкой)', async () => {
    const router = createRouter();
    let seen = null;
    router.post('/react/:ts', (req, res, params) => (seen = params.ts));
    await router.handle({ method: 'POST', url: '/react/111.222?x=1' }, mockRes());
    expect(seen).toBe('111.222');
  });

  /**
   * Что: путь совпал, метод — нет.
   * Вход: маршрут POST /react/:ts, приходит GET на тот же путь.
   * Поведение: 405, handle() возвращает true (ответ отдан).
   * Ожидаем: statusCode=405, error='method_not_allowed'.
   */
  test('несовпадение метода -> 405', async () => {
    const router = createRouter();
    router.post('/react/:ts', () => {});
    const res = mockRes();
    const handled = await router.handle({ method: 'GET', url: '/react/1.2' }, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toBe('method_not_allowed');
  });

  /**
   * Что: маршрут не найден.
   * Вход: запрос на незарегистрированный путь.
   * Поведение: handle() возвращает false (сервер сам отдаст 404), обработчик не вызван.
   * Ожидаем: handled=false, ответ не тронут.
   */
  test('нет маршрута -> handle() = false', async () => {
    const router = createRouter();
    router.get('/health', () => {});
    const res = mockRes();
    const handled = await router.handle({ method: 'GET', url: '/nope' }, res);
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(null);
  });
});
