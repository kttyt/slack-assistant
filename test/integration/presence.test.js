import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createSlackClient } from '../../src/slack.js';
import { createHealth } from '../../src/health.js';
import { PresenceKeeper } from '../../src/connection.js';
import { createFakeSlack } from '../helpers/fake-slack.js';
import { waitFor, sleep, makeSilentLogger, FAST_TIMINGS } from '../helpers/util.js';

// Полный стек PresenceKeeper против управляемого фейкового Slack (HTTP + WS).
// Тайминги микросекундные (FAST_TIMINGS), поэтому реконнекты/heartbeat отрабатывают мгновенно.
let fake;
let keeper;
let notified; // перехваченные вызовы notify()

// Собирает keeper со свежим health и slack-клиентом, целящим в фейк.
async function makeKeeper({ behavior = {}, apiBaseOverride } = {}) {
  const { apiBase } = await fake.start();
  const slack = createSlackClient({ apiBase: apiBaseOverride || apiBase, xoxc: 'xoxc-t', xoxd: 'xoxd-c' });
  const health = createHealth({ pongTimeoutMs: FAST_TIMINGS.pongTimeoutMs, logger: makeSilentLogger() });
  const notify = async (p) => {
    notified.push(p);
    return true;
  };
  const k = new PresenceKeeper({
    slack,
    notify,
    health,
    logger: makeSilentLogger(),
    timings: FAST_TIMINGS,
    behavior,
    identity: { userId: 'U_ME', teamUrl: 'https://test.slack.com/' },
  });
  k.health = health; // удобный доступ в тестах
  return k;
}

beforeEach(() => {
  fake = createFakeSlack();
  notified = [];
});

afterEach(async () => {
  if (keeper) await keeper.shutdown().catch(() => {});
  keeper = null;
  await fake.stop();
});

// Кол-во вызовов users.setPresence с конкретным значением.
function presenceCalls(value) {
  return fake.callsFor('users.setPresence').filter((c) => c.params.presence === value).length;
}

describe('Интеграция: подключение и авторизация', () => {
  /**
   * Что: happy path подключения.
   * Вход: валидный токен, keeper.start().
   * Поведение: rtm.connect -> WS открыт -> presence=auto подтверждён.
   * Ожидаем: health.wsConnected=true, tokenValid=true, на сервере зафиксирован presence=auto.
   */
  test('start подключается и держит зелёный', async () => {
    keeper = await makeKeeper();
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'wsConnected' });
    const s = keeper.health.snapshot();
    expect(s.tokenValid).toBe(true);
    await waitFor(() => fake.lastPresence() === 'auto', { label: 'presence auto' });
  });

  /**
   * Что: старт с протухшим токеном.
   * Вход: сервер authOk=false, keeper.start().
   * Поведение: rtm.connect отдаёт invalid_auth -> health помечается невалидным.
   * Ожидаем: tokenValid=false, wsConnected=false.
   */
  test('невалидный токен -> health token_invalid', async () => {
    keeper = await makeKeeper();
    fake.setAuth(false);
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().tokenValid === false, { label: 'tokenValid=false' });
    expect(keeper.health.snapshot().wsConnected).toBe(false);
  });

  /**
   * Что: восстановление после протухания.
   * Вход: старт при authOk=false, затем сервер снова принимает токен.
   * Поведение: backoff-реконнект в итоге проходит.
   * Ожидаем: со временем wsConnected=true и tokenValid=true.
   */
  test('после починки токена keeper сам переподключается', async () => {
    keeper = await makeKeeper();
    fake.setAuth(false);
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().tokenValid === false, { label: 'invalid first' });
    fake.setAuth(true);
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'recovered', timeout: 4000 });
    expect(keeper.health.snapshot().tokenValid).toBe(true);
  });
});

describe('Интеграция: устойчивость соединения', () => {
  /**
   * Что: детект молча умершего сокета.
   * Вход: соединение установлено, затем сервер перестаёт отвечать pong.
   * Поведение: heartbeat видит тишину > pongTimeoutMs и инициирует реконнект.
   * Ожидаем: происходит повторный rtm.connect (счётчик растёт).
   */
  test('нет pong -> heartbeat переподключается', async () => {
    keeper = await makeKeeper();
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'connected' });
    const baseline = fake.callsFor('rtm.connect').length;
    fake.setDropPongs(true);
    await waitFor(() => fake.callsFor('rtm.connect').length > baseline, { label: 'reconnect after dead socket', timeout: 4000 });
  });

  /**
   * Что: реакция на goodbye от сервера.
   * Вход: соединение установлено, сервер шлёт {type:'goodbye'}.
   * Поведение: keeper планирует немедленный реконнект.
   * Ожидаем: повторный rtm.connect.
   */
  test('goodbye -> переподключение', async () => {
    keeper = await makeKeeper();
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'connected' });
    const baseline = fake.callsFor('rtm.connect').length;
    fake.sendGoodbye();
    await waitFor(() => fake.callsFor('rtm.connect').length > baseline, { label: 'reconnect after goodbye', timeout: 4000 });
  });
});

describe('Интеграция: присутствие и расписание', () => {
  /**
   * Что: уход в away вне рабочих часов — ровно один раз.
   * Вход: offHoursMode=away; start, затем stop, затем ещё раз stop.
   * Поведение: away выставляется один раз за период простоя, повторные stop() не дёргают API.
   * Ожидаем: presence='away' и ровно один такой вызов после двух stop().
   */
  test('stop выставляет away один раз', async () => {
    keeper = await makeKeeper({ behavior: { offHoursMode: 'away' } });
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'connected' });
    await keeper.stop();
    await keeper.stop();
    expect(fake.lastPresence()).toBe('away');
    expect(presenceCalls('away')).toBe(1);
  });

  /**
   * Что: старт уже вне рабочих часов (регресс-тест бага).
   * Вход: offHoursMode=away; keeper НИ РАЗУ не был активен, сразу вызывается stop() (как делает планировщик на старте ночью).
   * Поведение: away всё равно выставляется, хотя active никогда не был true.
   * Ожидаем: presence='away'.
   */
  test('старт вне расписания всё равно уводит в away', async () => {
    keeper = await makeKeeper({ behavior: { offHoursMode: 'away' } });
    // Не вызываем start(): эмулируем tick(), который на старте видит «вне расписания».
    await keeper.stop();
    await waitFor(() => fake.lastPresence() === 'away', { label: 'away on startup' });
  });

  /**
   * Что: снятие режима «Не беспокоить».
   * Вход: clearDnd=true, на сервере включён snooze.
   * Поведение: refreshPresence видит snooze_enabled и вызывает dnd.endSnooze.
   * Ожидаем: endSnooze вызван, snooze на сервере снят.
   */
  test('clearDnd снимает snooze при подключении', async () => {
    keeper = await makeKeeper({ behavior: { clearDnd: true } });
    fake.setSnooze(true);
    await keeper.start();
    await waitFor(() => fake.callsFor('dnd.endSnooze').length >= 1, { label: 'endSnooze' });
    expect(fake.state.snooze).toBe(false);
  });

  /**
   * Что: release-режим не трогает presence при stop.
   * Вход: offHoursMode=release (дефолт); start, затем stop.
   * Поведение: вне часов соединение просто отпускается, away не выставляется.
   * Ожидаем: ни одного вызова presence='away'.
   */
  test('release-режим не выставляет away', async () => {
    keeper = await makeKeeper({ behavior: { offHoursMode: 'release' } });
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'connected' });
    await keeper.stop();
    expect(presenceCalls('away')).toBe(0);
  });
});

describe('Интеграция: входящие сообщения -> notify', () => {
  async function connected(behavior = {}) {
    keeper = await makeKeeper({ behavior });
    await keeper.start();
    await waitFor(() => keeper.health.snapshot().wsConnected === true, { label: 'connected' });
  }

  /**
   * Что: прямое упоминание.
   * Вход: сообщение в канале с текстом, содержащим <@U_ME>.
   * Поведение: keeper распознаёт упоминание, резолвит имя автора и зовёт notify.
   * Ожидаем: один вызов notify с kind='mention' и именем автора из профиля.
   */
  test('упоминание -> notify(mention)', async () => {
    await connected();
    fake.setUser('U_OTHER', { display_name: 'Боб' });
    fake.sendMessage({ channel: 'C1', user: 'U_OTHER', text: 'эй <@U_ME> глянь', ts: '111.222' });
    await waitFor(() => notified.length >= 1, { label: 'notify mention' });
    expect(notified[0].kind).toBe('mention');
    expect(notified[0].from).toBe('Боб');
  });

  /**
   * Что: личное сообщение.
   * Вход: сообщение в канале, начинающемся на 'D' (DM).
   * Поведение: DM распознаётся по префиксу канала.
   * Ожидаем: notify с kind='dm'.
   */
  test('DM -> notify(dm)', async () => {
    await connected();
    fake.sendMessage({ channel: 'D9', user: 'U_OTHER', text: 'привет', ts: '111.333' });
    await waitFor(() => notified.length >= 1, { label: 'notify dm' });
    expect(notified[0].kind).toBe('dm');
  });

  /**
   * Что: игнор собственных и служебных сообщений.
   * Вход: своё сообщение (user=U_ME) и сообщение с subtype.
   * Поведение: оба отфильтровываются до notify.
   * Ожидаем: notify не вызывается.
   */
  test('своё сообщение и subtype игнорируются', async () => {
    await connected();
    fake.sendMessage({ channel: 'D9', user: 'U_ME', text: 'моё' });
    fake.sendMessage({ channel: 'C1', user: 'U_OTHER', text: 'правка', subtype: 'message_changed' });
    await sleep(150); // даём шанс ошибочной доставке
    expect(notified.length).toBe(0);
  });
});
