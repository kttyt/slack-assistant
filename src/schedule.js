// Определяет, должны ли мы сейчас держать зелёный статус, исходя из рабочих часов и таймзоны.
// Границы старта/конца «дышат»: каждый день случайно сдвигаются на ±(jitterMin..jitterMax) минут,
// чтобы присутствие не включалось/выключалось ровно по часам как робот.
//
// Фабрика createSchedule(cfg) захватывает конфиг расписания. Момент времени (date) во всех
// функциях инъектируется — по умолчанию new Date(), в тестах передаётся фиксированный.

// Детерминированный PRNG из строки (mulberry32 + хэш строки).
// Один и тот же сид -> одно и то же число, поэтому в течение суток сдвиг стабилен.
function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// cfg: { timezone, workDays:Set, workStart, workEnd, jitterMin, jitterMax }
export function createSchedule(cfg) {
  // Текущее время в нужной таймзоне -> { dow, minutes, dateKey }.
  function nowInTz(date) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
    const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
      dow: dowMap[p.weekday],
      minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
      dateKey: `${p.year}-${p.month}-${p.day}`,
    };
  }

  // Дневной сдвиг в минутах для границы (start/end): знак случаен, модуль в [jitterMin, jitterMax].
  function dailyOffset(dateKey, which) {
    const span = Math.max(0, cfg.jitterMax - cfg.jitterMin);
    const r1 = seededRandom(`${dateKey}:${which}:mag`);
    const r2 = seededRandom(`${dateKey}:${which}:sign`);
    const magnitude = cfg.jitterMin + r1 * span;
    const sign = r2 < 0.5 ? -1 : 1;
    return Math.round(sign * magnitude);
  }

  // Эффективные (плавающие) границы рабочего окна на конкретный день, в минутах от полуночи.
  function effectiveBounds(dateKey) {
    const clamp = (m) => Math.min(1439, Math.max(0, m));
    return {
      start: clamp(cfg.workStart + dailyOffset(dateKey, 'start')),
      end: clamp(cfg.workEnd + dailyOffset(dateKey, 'end')),
    };
  }

  // True, если переданный момент попадает в (плавающее) рабочее окно.
  function isWithinWorkHours(date = new Date()) {
    const { dow, minutes, dateKey } = nowInTz(date);
    if (!cfg.workDays.has(dow)) return false;

    const { start, end } = effectiveBounds(dateKey);
    if (start <= end) {
      // Обычное окно в пределах одних суток.
      return minutes >= start && minutes < end;
    }
    // Окно через полночь, например 22:00–06:00.
    return minutes >= start || minutes < end;
  }

  // Удобно для логов: текущее время + сегодняшние плавающие границы.
  function describeNow(date = new Date()) {
    const { dow, minutes, dateKey } = nowInTz(date);
    const { start, end } = effectiveBounds(dateKey);
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `день=${dow} ${hhmm(minutes)} ${cfg.timezone} (окно сегодня ${hhmm(start)}–${hhmm(end)})`;
  }

  return { effectiveBounds, isWithinWorkHours, describeNow };
}
