import { describe, test, expect } from 'vitest';
import { createHealth } from '../../src/health.js';
import { makeSilentLogger } from '../helpers/util.js';

// Health с управляемыми часами: now() возвращает значение переменной clock,
// что делает логику «сокет мёртв дольше pongTimeoutMs» полностью детерминированной.
function makeHealth(pongTimeoutMs = 100) {
  let clock = 1000;
  const health = createHealth({
    pongTimeoutMs,
    logger: makeSilentLogger(),
    now: () => clock,
  });
  return { health, tick: (ms) => (clock += ms), setClock: (v) => (clock = v) };
}

describe('createHealth — состояние токена', () => {
  /**
   * Что: стартовое состояние.
   * Вход: свежий health, проверок ещё не было.
   * Поведение: статус 'starting', ok=false.
   * Ожидаем: tokenValid=null, status='starting'.
   */
  test('до первой проверки — starting и не ok', () => {
    const { health } = makeHealth();
    const s = health.snapshot();
    expect(s.tokenValid).toBe(null);
    expect(s.status).toBe('starting');
    expect(s.ok).toBe(false);
  });

  /**
   * Что: успешная авторизация.
   * Вход: markValid с user/team.
   * Поведение: фиксируется валидность и опознавательные данные.
   * Ожидаем: ok=true, status='ok', user/team проставлены.
   */
  test('markValid делает состояние ok', () => {
    const { health } = makeHealth();
    health.markValid({ user: 'alice', team: 'ACME' });
    const s = health.snapshot();
    expect(s.ok).toBe(true);
    expect(s.status).toBe('ok');
    expect(s.user).toBe('alice');
    expect(s.team).toBe('ACME');
  });

  /**
   * Что: протухание токена.
   * Вход: markInvalid с текстом ошибки.
   * Поведение: состояние переходит в невалидное, ошибка сохраняется.
   * Ожидаем: ok=false, status='token_invalid', lastError проставлен.
   */
  test('markInvalid делает состояние token_invalid', () => {
    const { health } = makeHealth();
    health.markInvalid('invalid_auth');
    const s = health.snapshot();
    expect(s.ok).toBe(false);
    expect(s.status).toBe('token_invalid');
    expect(s.lastError).toBe('invalid_auth');
  });
});

describe('createHealth — деградация соединения', () => {
  /**
   * Что: «лежащий» сокет вне рабочих часов — это норма.
   * Вход: токен валиден, activeIntended=false, сокета нет.
   * Поведение: отсутствие соединения не считается деградацией, если мы и не хотим быть онлайн.
   * Ожидаем: ok=true, не degraded.
   */
  test('вне рабочих часов отсутствие сокета не деградация', () => {
    const { health } = makeHealth();
    health.markValid();
    health.markActiveIntended(false);
    health.markSocketDisconnected();
    expect(health.socketDegraded()).toBe(false);
    expect(health.snapshot().ok).toBe(true);
  });

  /**
   * Что: короткий «дышащий» реконнект не роняет health.
   * Вход: activeIntended=true, сокет отвалился, прошло МЕНЬШЕ pongTimeoutMs.
   * Поведение: в пределах таймаута деградация не объявляется (иначе Docker бы рестартил на каждый реконнект).
   * Ожидаем: ok=true, не degraded.
   */
  test('кратковременная потеря сокета в пределах таймаута — не деградация', () => {
    const { health, tick } = makeHealth(100);
    health.markValid();
    health.markActiveIntended(true);
    health.markSocketDisconnected();
    tick(50); // < pongTimeoutMs
    expect(health.socketDegraded()).toBe(false);
    expect(health.snapshot().ok).toBe(true);
  });

  /**
   * Что: затяжной обрыв во время рабочих часов.
   * Вход: activeIntended=true, сокета нет дольше pongTimeoutMs.
   * Поведение: считаем контейнер нездоровым.
   * Ожидаем: degraded=true, ok=false, status='socket_down'.
   */
  test('обрыв дольше pongTimeoutMs -> socket_down и 503', () => {
    const { health, tick } = makeHealth(100);
    health.markValid();
    health.markActiveIntended(true);
    health.markSocketDisconnected();
    tick(150); // > pongTimeoutMs
    expect(health.socketDegraded()).toBe(true);
    const s = health.snapshot();
    expect(s.ok).toBe(false);
    expect(s.status).toBe('socket_down');
  });

  /**
   * Что: восстановление соединения снимает деградацию.
   * Вход: сокет был мёртв дольше таймаута, затем markSocketConnected.
   * Поведение: успешное подключение сбрасывает счётчик простоя.
   * Ожидаем: снова ok=true, не degraded.
   */
  test('переподключение снимает socket_down', () => {
    const { health, tick } = makeHealth(100);
    health.markValid();
    health.markActiveIntended(true);
    health.markSocketDisconnected();
    tick(150);
    expect(health.socketDegraded()).toBe(true);
    health.markSocketConnected();
    expect(health.socketDegraded()).toBe(false);
    expect(health.snapshot().wsConnected).toBe(true);
  });

  /**
   * Что: pong обновляет отметку живости.
   * Вход: markPong.
   * Поведение: снимок отражает время последнего pong.
   * Ожидаем: lastPongAt перестаёт быть null.
   */
  test('markPong проставляет lastPongAt', () => {
    const { health } = makeHealth();
    expect(health.snapshot().lastPongAt).toBe(null);
    health.markPong();
    expect(health.snapshot().lastPongAt).not.toBe(null);
  });
});
