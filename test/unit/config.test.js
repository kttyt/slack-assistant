import { describe, test, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

// Полностью валидное окружение — база, к которой тесты добавляют/портят отдельные поля.
const VALID = {
  SLACK_XOXC_TOKEN: 'xoxc-abc',
  SLACK_XOXD_COOKIE: 'xoxd-def',
  TZ: 'Europe/Moscow',
};

describe('loadConfig — валидация и парсинг конфигурации', () => {
  /**
   * Что: дефолты при минимальном валидном окружении.
   * Вход: только обязательные токены + TZ.
   * Поведение: незаданные параметры берут значения по умолчанию.
   * Ожидаем: рабочие дни Пн–Пт, окно 09:00–19:00, apiBase = прод, offHoursMode=release.
   */
  test('минимальное окружение даёт разумные дефолты', () => {
    const c = loadConfig(VALID);
    expect([...c.workDays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.workStart).toBe(9 * 60);
    expect(c.workEnd).toBe(19 * 60);
    expect(c.apiBase).toBe('https://slack.com/api');
    expect(c.offHoursMode).toBe('release');
    expect(c.pingIntervalMs).toBe(20000);
    expect(c.pongTimeoutMs).toBe(60000);
  });

  /**
   * Что: отсутствие обязательных секретов.
   * Вход: пустое окружение.
   * Поведение: валидация собирает все ошибки и бросает исключение.
   * Ожидаем: throw с code=CONFIG_INVALID и упоминанием обоих токенов.
   */
  test('без токенов бросает CONFIG_INVALID с обоими именами', () => {
    try {
      loadConfig({});
      throw new Error('должно было бросить');
    } catch (e) {
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.message).toContain('SLACK_XOXC_TOKEN');
      expect(e.message).toContain('SLACK_XOXD_COOKIE');
    }
  });

  /**
   * Что: агрегирование ошибок.
   * Вход: сразу несколько невалидных значений.
   * Поведение: сообщение перечисляет ВСЕ проблемы, а не первую.
   * Ожидаем: в тексте присутствуют все испорченные ключи.
   */
  test('перечисляет все ошибки разом', () => {
    let msg = '';
    try {
      loadConfig({ ...VALID, TZ: 'Mars/Phobos', WORK_START: '25:00', OFF_HOURS_MODE: 'sleep', API_PORT: '99999' });
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toContain('TZ=Mars/Phobos');
    expect(msg).toContain('WORK_START');
    expect(msg).toContain('OFF_HOURS_MODE');
    expect(msg).toContain('API_PORT');
  });

  /**
   * Что: диапазоны дней недели.
   * Вход: WORK_DAYS в форматах диапазона и списка.
   * Поведение: parseDays раскрывает "1-3" и "1,3,5".
   * Ожидаем: соответствующие множества дней.
   */
  test('WORK_DAYS понимает диапазоны и списки', () => {
    expect([...loadConfig({ ...VALID, WORK_DAYS: '1-3' }).workDays]).toEqual([1, 2, 3]);
    expect([...loadConfig({ ...VALID, WORK_DAYS: '1,3,5' }).workDays]).toEqual([1, 3, 5]);
  });

  /**
   * Что: связь ping/pong.
   * Вход: PONG_TIMEOUT_MS <= PING_INTERVAL_MS.
   * Поведение: бессмысленная настройка (pong-таймаут не больше интервала пинга) отвергается.
   * Ожидаем: throw с упоминанием PONG_TIMEOUT_MS.
   */
  test('PONG_TIMEOUT_MS должен быть больше PING_INTERVAL_MS', () => {
    expect(() => loadConfig({ ...VALID, PING_INTERVAL_MS: '20000', PONG_TIMEOUT_MS: '10000' })).toThrow(/pongTimeoutMs/);
  });

  /**
   * Что: соотношение джиттера.
   * Вход: JITTER_MAX < JITTER_MIN.
   * Поведение: отвергается как противоречивое.
   * Ожидаем: throw с упоминанием JITTER_MAX_MINUTES.
   */
  test('JITTER_MAX должен быть >= JITTER_MIN', () => {
    expect(() => loadConfig({ ...VALID, JITTER_MIN_MINUTES: '20', JITTER_MAX_MINUTES: '5' })).toThrow(/maxMinutes/);
  });

  /**
   * Что: числовые границы.
   * Вход: отрицательный интервал пинга и порт вне диапазона.
   * Поведение: значения вне [min,max] — ошибка, а не тихий фолбэк.
   * Ожидаем: throw в обоих случаях.
   */
  test('числа вне допустимого диапазона отвергаются', () => {
    expect(() => loadConfig({ ...VALID, PING_INTERVAL_MS: '-5' })).toThrow(/PING_INTERVAL_MS/);
    expect(() => loadConfig({ ...VALID, API_PORT: '0' })).toThrow(/API_PORT/);
  });

  /**
   * Что: валидация webhook и apiBase как URL.
   * Вход: не-http значения.
   * Поведение: оба поля обязаны быть http(s) URL (webhook — только если задан).
   * Ожидаем: throw для ftp-webhook и для мусорного apiBase.
   */
  test('WEBHOOK_URL и SLACK_API_BASE должны быть http(s) URL', () => {
    expect(() => loadConfig({ ...VALID, WEBHOOK_URL: 'ftp://x' })).toThrow(/WEBHOOK_URL/);
    expect(() => loadConfig({ ...VALID, SLACK_API_BASE: 'not a url' })).toThrow(/SLACK_API_BASE/);
  });

  /**
   * Что: переопределение базы API.
   * Вход: SLACK_API_BASE на localhost.
   * Поведение: значение принимается и попадает в конфиг (нужно тестам).
   * Ожидаем: apiBase равен переданному.
   */
  test('SLACK_API_BASE переопределяется валидным URL', () => {
    const c = loadConfig({ ...VALID, SLACK_API_BASE: 'http://127.0.0.1:8080/api' });
    expect(c.apiBase).toBe('http://127.0.0.1:8080/api');
  });

  /**
   * Что: булевы флаги.
   * Вход: разные написания истины/лжи.
   * Поведение: '1'/'true'/'yes'/'on' -> true, прочее -> false.
   * Ожидаем: корректный разбор CLEAR_DND и NOTIFY_DM.
   */
  test('булевы переменные разбираются гибко', () => {
    expect(loadConfig({ ...VALID, CLEAR_DND: 'yes' }).clearDnd).toBe(true);
    expect(loadConfig({ ...VALID, CLEAR_DND: 'off' }).clearDnd).toBe(false);
    expect(loadConfig({ ...VALID, NOTIFY_DM: '0' }).notifyDM).toBe(false);
  });

  /**
   * Что: уровень логирования.
   * Вход: дефолт, валидное и невалидное значение LOG_LEVEL.
   * Поведение: enum-настройка с дефолтом 'info'; мусор отвергается.
   * Ожидаем: дефолт info; 'debug' принимается; 'loud' бросает.
   */
  test('logLevel: дефолт, валидное значение и отказ на мусоре', () => {
    expect(loadConfig(VALID).logLevel).toBe('info');
    expect(loadConfig({ ...VALID, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...VALID, LOG_LEVEL: 'loud' })).toThrow(/logging\.level/);
  });
});

// Только секреты в окружении — всё остальное приходит из YAML.
const SECRETS = { SLACK_XOXC_TOKEN: 'xoxc-abc', SLACK_XOXD_COOKIE: 'xoxd-def' };

describe('loadConfig — YAML + фолбэк на ENV', () => {
  /**
   * Что: приоритет ENV над YAML.
   * Вход: одно и то же значение задано и в YAML, и в ENV.
   * Поведение: переменная окружения перекрывает config.yaml (ENV -> YAML -> дефолт).
   * Ожидаем: применяется ENV-значение.
   */
  test('значение из ENV перекрывает YAML', () => {
    const c = loadConfig(
      { ...SECRETS, TZ: 'UTC', OFF_HOURS_MODE: 'release' },
      { schedule: { timezone: 'Europe/Moscow' }, presence: { offHoursMode: 'away' } },
    );
    expect(c.timezone).toBe('UTC'); // из ENV, несмотря на YAML
    expect(c.offHoursMode).toBe('release'); // из ENV, несмотря на YAML
  });

  /**
   * Что: фолбэк на ENV.
   * Вход: ключа нет в YAML, но есть переменная окружения.
   * Поведение: при отсутствии в YAML берётся ENV.
   * Ожидаем: применяется ENV-значение.
   */
  test('при отсутствии в YAML берётся ENV', () => {
    const c = loadConfig({ ...SECRETS, TZ: 'Asia/Tokyo' }, { presence: { clearDnd: true } });
    expect(c.timezone).toBe('Asia/Tokyo'); // из ENV
    expect(c.clearDnd).toBe(true); // из YAML
  });

  /**
   * Что: дефолт, когда нет ни YAML, ни ENV.
   * Вход: только секреты.
   * Поведение: незаданное поле берёт встроенный дефолт.
   * Ожидаем: timezone=UTC, offHoursMode=release.
   */
  test('без YAML и ENV применяется дефолт', () => {
    const c = loadConfig(SECRETS, {});
    expect(c.timezone).toBe('UTC');
    expect(c.offHoursMode).toBe('release');
  });

  /**
   * Что: секреты только из окружения.
   * Вход: токены заданы в YAML, но НЕ в окружении.
   * Поведение: YAML для секретов игнорируется — валидация падает.
   * Ожидаем: throw про обязательные SLACK_XOXC_TOKEN/SLACK_XOXD_COOKIE.
   */
  test('токены из YAML игнорируются (секреты только из ENV)', () => {
    expect(() =>
      loadConfig({ TZ: 'UTC' }, { slack: { xoxc: 'xoxc-inyaml', xoxd: 'xoxd-inyaml' } }),
    ).toThrow(/SLACK_XOXC_TOKEN/);
  });

  /**
   * Что: нативные типы YAML.
   * Вход: workDays списком чисел, булев/числовые поля нативными типами.
   * Поведение: массивы и числа/булевы из YAML принимаются без строкового парсинга.
   * Ожидаем: корректные workDays, числа и булевы.
   */
  test('нативные типы YAML: массивы, числа, булевы', () => {
    const c = loadConfig(SECRETS, {
      schedule: { workDays: [1, 3, 5], jitter: { minMinutes: 0, maxMinutes: 0 } },
      presence: { pingIntervalMs: 5000, pongTimeoutMs: 15000 },
      notifications: { mentions: { enabled: false } },
    });
    expect([...c.workDays]).toEqual([1, 3, 5]);
    expect(c.pingIntervalMs).toBe(5000);
    expect(c.jitterMin).toBe(0);
    expect(c.notifyMentions).toBe(false);
  });

  /**
   * Что: строковые формы в YAML тоже валидны.
   * Вход: workDays как строка-диапазон, время как строки.
   * Поведение: строковые значения парсятся так же, как из ENV.
   * Ожидаем: рабочие дни Пн–Пт, окно 08:30–17:45.
   */
  test('строковые формы в YAML разбираются', () => {
    const c = loadConfig(SECRETS, {
      schedule: { workDays: '1-5', hours: { start: '08:30', end: '17:45' } },
    });
    expect([...c.workDays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.workStart).toBe(8 * 60 + 30);
    expect(c.workEnd).toBe(17 * 60 + 45);
  });

  /**
   * Что: предупреждение о неизвестных ключах.
   * Вход: YAML с опечаткой в пути.
   * Поведение: неизвестный ключ не валит конфиг, но вызывает onWarn.
   * Ожидаем: onWarn получил сообщение с именем ключа; конфиг собран.
   */
  test('неизвестный ключ YAML -> предупреждение, а не ошибка', () => {
    const warnings = [];
    const c = loadConfig(SECRETS, { schedule: { timezoneee: 'UTC' } }, { onWarn: (m) => warnings.push(m) });
    expect(c.timezone).toBe('UTC'); // дефолт, ключ-опечатка проигнорирован
    expect(warnings.some((w) => w.includes('schedule.timezoneee'))).toBe(true);
  });

  /**
   * Что: валидация значений из YAML.
   * Вход: некорректное значение задано именно в YAML.
   * Поведение: валидация работает независимо от источника.
   * Ожидаем: throw с указанием yaml-пути.
   */
  test('невалидное YAML-значение отвергается с указанием пути', () => {
    expect(() =>
      loadConfig(SECRETS, { presence: { pingIntervalMs: 20000, pongTimeoutMs: 10000 } }),
    ).toThrow(/pongTimeoutMs/);
  });
});

describe('loadConfig — UA, детект входящих, прокси', () => {
  /**
   * Что: User-Agent по умолчанию и переопределение.
   * Вход: без настройки и с USER_AGENT.
   * Поведение: дефолт — реалистичный браузерный UA; ENV/YAML переопределяют.
   * Ожидаем: дефолт похож на браузер (Mozilla/…), переопределение применяется.
   */
  test('userAgent: браузерный дефолт и переопределение', () => {
    expect(loadConfig(SECRETS).userAgent).toMatch(/^Mozilla\/5\.0/);
    expect(loadConfig({ ...SECRETS, USER_AGENT: 'my-ua/2.0' }).userAgent).toBe('my-ua/2.0');
  });

  /**
   * Что: настройки детекта DM/упоминаний/ключевых слов.
   * Вход: YAML с префиксами DM, групповыми DM, канальными упоминаниями и ключевыми словами.
   * Поведение: значения разбираются, ключевые слова приводятся к нижнему регистру.
   * Ожидаем: соответствующие поля конфига.
   */
  test('детект: префиксы, mpim, channelWide, keywords', () => {
    const c = loadConfig(SECRETS, {
      notifications: {
        dm: { channelPrefixes: ['D', 'C0'], groupDm: true },
        mentions: { channelWide: true },
        keywords: ['Deploy', 'Incident'],
      },
    });
    expect(c.dmChannelPrefixes).toEqual(['D', 'C0']);
    expect(c.notifyGroupDm).toBe(true);
    expect(c.mentionChannelWide).toBe(true);
    expect(c.notifyKeywords).toEqual(['deploy', 'incident']); // нижний регистр
  });

  /**
   * Что: списки из ENV — строкой через запятую.
   * Вход: DM_CHANNEL_PREFIXES и NOTIFY_KEYWORDS как CSV.
   * Поведение: строка разбивается по запятым, тримится.
   * Ожидаем: массивы значений.
   */
  test('списочные ENV разбираются как CSV', () => {
    const c = loadConfig({ ...SECRETS, DM_CHANNEL_PREFIXES: 'D, G ', NOTIFY_KEYWORDS: 'oncall,pager' });
    expect(c.dmChannelPrefixes).toEqual(['D', 'G']);
    expect(c.notifyKeywords).toEqual(['oncall', 'pager']);
  });

  /**
   * Что: прокси из ENV (в т.ч. нижний регистр).
   * Вход: https_proxy строчными буквами.
   * Поведение: принимаются и UPPER, и lower варианты; валидируется как URL.
   * Ожидаем: httpsProxy проставлен.
   */
  test('прокси читается из ENV любого регистра', () => {
    const c = loadConfig({ ...SECRETS, https_proxy: 'http://proxy.local:8080' });
    expect(c.httpsProxy).toBe('http://proxy.local:8080');
  });

  /**
   * Что: валидация прокси-URL и NO_PROXY.
   * Вход: мусорный HTTP_PROXY и список NO_PROXY.
   * Поведение: не-URL отвергается; NO_PROXY парсится в список.
   * Ожидаем: throw на плохой прокси; список noProxy разобран.
   */
  test('плохой прокси-URL отвергается, NO_PROXY -> список', () => {
    expect(() => loadConfig({ ...SECRETS, HTTP_PROXY: 'not-a-url' })).toThrow(/proxy\.http/);
    const c = loadConfig({ ...SECRETS, NO_PROXY: 'slack.com, localhost' });
    expect(c.noProxy).toEqual(['slack.com', 'localhost']);
  });
});

describe('loadConfig — requireSecrets=false (для инструментов)', () => {
  /**
   * Что: загрузка конфига без секретов.
   * Вход: окружение без токенов, requireSecrets=false (как в grab-token).
   * Поведение: отсутствие xoxc/xoxd не ошибка; остальные значения читаются как обычно.
   * Ожидаем: не бросает; timezone/прокси проставлены; секреты — пустые строки.
   */
  test('без токенов не бросает и отдаёт остальные значения', () => {
    const c = loadConfig({ TZ: 'Asia/Tokyo', HTTPS_PROXY: 'http://p.local:8080' }, {}, { requireSecrets: false });
    expect(c.timezone).toBe('Asia/Tokyo');
    expect(c.httpsProxy).toBe('http://p.local:8080');
    expect(c.xoxc).toBe('');
    expect(c.xoxd).toBe('');
  });

  /**
   * Что: прочая валидация не ослабляется.
   * Вход: невалидная таймзона при requireSecrets=false.
   * Поведение: снимается только требование секретов; остальные проверки работают.
   * Ожидаем: throw про timezone.
   */
  test('прочая валидация работает и без секретов', () => {
    expect(() => loadConfig({ TZ: 'Nope/Zone' }, {}, { requireSecrets: false })).toThrow(/timezone/);
  });
});
