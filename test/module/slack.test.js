import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createSlackClient, isAuthError } from '../../src/slack.js';
import { createFakeSlack } from '../helpers/fake-slack.js';

describe('isAuthError — классификация ошибок Slack', () => {
  /**
   * Что: распознавание протухшего токена.
   * Вход: коды авторизации в чистом виде и в формате "method: code".
   * Поведение: префикс "method:" срезается, код сверяется со списком.
   * Ожидаем: true для auth-кодов, false для прочих/пустых.
   */
  test('узнаёт auth-коды и игнорирует остальные', () => {
    expect(isAuthError('invalid_auth')).toBe(true);
    expect(isAuthError('rtm.connect: token_revoked')).toBe(true);
    expect(isAuthError('users.info: user_not_found')).toBe(false);
    expect(isAuthError('')).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('createSlackClient — Web API поверх фейкового Slack', () => {
  // Каждый тест — свежий фейковый сервер (изолированные счётчики вызовов).
  let fake;
  let slack;

  beforeEach(async () => {
    fake = createFakeSlack();
    const { apiBase } = await fake.start();
    slack = createSlackClient({ apiBase, xoxc: 'xoxc-t', xoxd: 'xoxd-c' });
  });

  afterEach(async () => {
    await fake.stop();
  });

  /**
   * Что: успешная проверка токена.
   * Вход: authTest при authOk=true.
   * Поведение: клиент шлёт POST на /api/auth.test и разбирает ответ.
   * Ожидаем: возвращаются user/user_id/team из фейка.
   */
  test('authTest возвращает данные пользователя', async () => {
    const who = await slack.authTest();
    expect(who.user).toBe('tester');
    expect(who.user_id).toBe('U_ME');
    expect(who.team).toBe('Test Team');
  });

  /**
   * Что: получение WS-URL.
   * Вход: rtmConnect.
   * Поведение: возвращает url из ответа rtm.connect.
   * Ожидаем: ws://-адрес фейкового WS-сервера.
   */
  test('rtmConnect отдаёт ws:// URL', async () => {
    const url = await slack.rtmConnect();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  /**
   * Что: маппинг логической ошибки Slack.
   * Вход: сервер в режиме authOk=false.
   * Поведение: data.ok=false -> клиент бросает Error "method: code".
   * Ожидаем: сообщение содержит invalid_auth.
   */
  test('ошибка Slack превращается в исключение', async () => {
    fake.setAuth(false);
    await expect(slack.authTest()).rejects.toThrow(/invalid_auth/);
  });

  /**
   * Что: маппинг HTTP-ошибки.
   * Вход: сервер отвечает HTTP 500 на auth.test.
   * Поведение: не-2xx -> Error "method: HTTP 500".
   * Ожидаем: сообщение содержит HTTP 500.
   */
  test('HTTP-статус ошибки превращается в исключение', async () => {
    fake.setHttpStatus('auth.test', 500);
    await expect(slack.authTest()).rejects.toThrow(/HTTP 500/);
  });

  /**
   * Что: кэширование имён.
   * Вход: userName для одного id вызывается дважды.
   * Поведение: второй раз берётся из кэша, API не дёргается.
   * Ожидаем: display_name из профиля и ровно один вызов users.info.
   */
  test('userName кэширует и предпочитает display_name', async () => {
    fake.setUser('U1', { display_name: 'Алиса', real_name: 'Alice A.' });
    const a = await slack.userName('U1');
    const b = await slack.userName('U1');
    expect(a).toBe('Алиса');
    expect(b).toBe('Алиса');
    expect(fake.callsFor('users.info').length).toBe(1);
  });

  /**
   * Что: устойчивость резолва имени.
   * Вход: users.info отвечает ошибкой.
   * Поведение: userName не бросает, а возвращает сам id как запасной вариант.
   * Ожидаем: результат равен переданному id.
   */
  test('userName при ошибке возвращает id', async () => {
    fake.setError('users.info', 'user_not_found');
    expect(await slack.userName('U404')).toBe('U404');
  });

  /**
   * Что: заголовки для WebSocket.
   * Вход: wsHeaders().
   * Поведение: cookie "d" из xoxd + тот же User-Agent, что и у Web API.
   * Ожидаем: Cookie="d=xoxd-c" и непустой User-Agent.
   */
  test('wsHeaders отдаёт cookie d и User-Agent', () => {
    const h = slack.wsHeaders();
    expect(h.Cookie).toBe('d=xoxd-c');
    expect(h['User-Agent']).toBeTruthy();
  });
});
