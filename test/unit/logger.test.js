import { describe, test, expect, vi, afterEach } from 'vitest';
import { log } from '../../src/logger.js';

// Перехватываем console, чтобы проверить, какие уровни реально пишутся при разном пороге.
function capture() {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { out, err };
}

afterEach(() => {
  vi.restoreAllMocks();
  log.setLevel('info'); // вернуть дефолт, чтобы не влиять на другие тесты
});

describe('logger.setLevel — порог логирования', () => {
  /**
   * Что: повышение порога до warn.
   * Вход: setLevel('warn'), затем debug/info/warn.
   * Поведение: ниже порога не пишется; warn идёт в console.log (в console.error — только error).
   * Ожидаем: console.log вызван один раз (warn), console.error не вызван.
   */
  test('warn скрывает debug и info', () => {
    const { out, err } = capture();
    log.setLevel('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
  });

  /**
   * Что: понижение порога до debug.
   * Вход: setLevel('debug'), затем debug.
   * Поведение: debug теперь виден.
   * Ожидаем: console.log вызван.
   */
  test('debug показывает отладочные сообщения', () => {
    const { out } = capture();
    log.setLevel('debug');
    log.debug('d');
    expect(out).toHaveBeenCalledTimes(1);
  });

  /**
   * Что: неизвестный уровень игнорируется.
   * Вход: setLevel('nonsense') при текущем info.
   * Поведение: порог не меняется.
   * Ожидаем: info по-прежнему пишется.
   */
  test('неизвестный уровень не меняет порог', () => {
    const { out } = capture();
    log.setLevel('info');
    log.setLevel('nonsense');
    log.info('i');
    expect(out).toHaveBeenCalledTimes(1);
  });
});
