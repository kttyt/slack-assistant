import { describe, test, expect } from 'vitest';
import { createSchedule } from '../../src/schedule.js';

// База: UTC, чтобы момент Date напрямую = стенным часам; джиттер выключен (0/0) —
// границы окна точны и предсказуемы. Отдельный блок ниже включает джиттер.
function scheduleNoJitter(over = {}) {
  return createSchedule({
    timezone: 'UTC',
    workDays: new Set([1, 2, 3, 4, 5]),
    workStart: 9 * 60,
    workEnd: 19 * 60,
    jitterMin: 0,
    jitterMax: 0,
    ...over,
  });
}

// Известные даты (UTC): 2024-01-01 — понедельник, 2024-01-06 — суббота.
const MON_10 = new Date('2024-01-01T10:00:00Z');
const MON_08 = new Date('2024-01-01T08:00:00Z');
const MON_19 = new Date('2024-01-01T19:00:00Z');
const SAT_10 = new Date('2024-01-06T10:00:00Z');

describe('createSchedule — рабочее окно', () => {
  /**
   * Что: попадание в обычное дневное окно.
   * Вход: понедельник 10:00 UTC, окно 09:00–19:00 без джиттера.
   * Поведение: время внутри [start, end).
   * Ожидаем: true.
   */
  test('внутри окна в рабочий день -> true', () => {
    expect(scheduleNoJitter().isWithinWorkHours(MON_10)).toBe(true);
  });

  /**
   * Что: границы окна.
   * Вход: 08:00 (до старта) и ровно 19:00 (конец, исключается).
   * Поведение: конец окна не включается (>= start && < end).
   * Ожидаем: обе точки — вне окна.
   */
  test('до старта и ровно на конце -> false', () => {
    expect(scheduleNoJitter().isWithinWorkHours(MON_08)).toBe(false);
    expect(scheduleNoJitter().isWithinWorkHours(MON_19)).toBe(false);
  });

  /**
   * Что: фильтр по дням недели.
   * Вход: суббота 10:00, рабочие дни Пн–Пт.
   * Поведение: нерабочий день исключается независимо от времени.
   * Ожидаем: false.
   */
  test('нерабочий день -> false даже в рабочее время', () => {
    expect(scheduleNoJitter().isWithinWorkHours(SAT_10)).toBe(false);
  });

  /**
   * Что: окно через полночь.
   * Вход: окно 22:00–06:00; проверяем 23:00, 03:00 и 12:00.
   * Поведение: при start>end окно = [start..24) ∪ [0..end).
   * Ожидаем: 23:00 и 03:00 внутри, 12:00 снаружи.
   */
  test('окно через полночь охватывает ночь, но не день', () => {
    const s = scheduleNoJitter({ workStart: 22 * 60, workEnd: 6 * 60, workDays: new Set([1, 2, 3, 4, 5, 6, 7]) });
    expect(s.isWithinWorkHours(new Date('2024-01-01T23:00:00Z'))).toBe(true);
    expect(s.isWithinWorkHours(new Date('2024-01-01T03:00:00Z'))).toBe(true);
    expect(s.isWithinWorkHours(new Date('2024-01-01T12:00:00Z'))).toBe(false);
  });
});

describe('createSchedule — плавающие границы (джиттер)', () => {
  const jittered = createSchedule({
    timezone: 'UTC',
    workDays: new Set([1, 2, 3, 4, 5]),
    workStart: 9 * 60,
    workEnd: 19 * 60,
    jitterMin: 10,
    jitterMax: 15,
  });

  /**
   * Что: детерминизм сдвига в течение суток.
   * Вход: один и тот же dateKey.
   * Поведение: сид зависит только от даты, поэтому границы стабильны в пределах дня.
   * Ожидаем: два вызова effectiveBounds для одной даты идентичны.
   */
  test('границы стабильны в течение одних суток', () => {
    const a = jittered.effectiveBounds('2024-01-01');
    const b = jittered.effectiveBounds('2024-01-01');
    expect(a).toEqual(b);
  });

  /**
   * Что: величина сдвига в заданных рамках.
   * Вход: база 09:00/19:00, джиттер 10..15 минут.
   * Поведение: |смещение| в [jitterMin, jitterMax].
   * Ожидаем: start и end отклоняются от базы на 10..15 минут.
   */
  test('сдвиг границ лежит в [jitterMin, jitterMax]', () => {
    const { start, end } = jittered.effectiveBounds('2024-01-02');
    const dStart = Math.abs(start - 9 * 60);
    const dEnd = Math.abs(end - 19 * 60);
    expect(dStart).toBeGreaterThanOrEqual(10);
    expect(dStart).toBeLessThanOrEqual(15);
    expect(dEnd).toBeGreaterThanOrEqual(10);
    expect(dEnd).toBeLessThanOrEqual(15);
  });

  /**
   * Что: сдвиг меняется день ото дня.
   * Вход: две разные даты.
   * Поведение: разные сиды -> (как правило) разные границы.
   * Ожидаем: хотя бы одна из границ отличается.
   */
  test('разные дни дают разные границы', () => {
    const a = jittered.effectiveBounds('2024-01-01');
    const b = jittered.effectiveBounds('2024-01-15');
    expect(a.start !== b.start || a.end !== b.end).toBe(true);
  });

  /**
   * Что: человекочитаемое описание.
   * Вход: понедельник 10:00.
   * Поведение: describeNow включает день недели, время и границы.
   * Ожидаем: строка содержит "день=1" и таймзону.
   */
  test('describeNow описывает текущий момент и окно', () => {
    const line = jittered.describeNow(MON_10);
    expect(line).toContain('день=1');
    expect(line).toContain('UTC');
  });
});
