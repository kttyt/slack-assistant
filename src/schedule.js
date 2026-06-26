// Определяет, должны ли мы сейчас держать зелёный статус, исходя из рабочих часов и таймзоны.
// Границы старта/конца «дышат»: каждый день случайно сдвигаются на ±(jitterMin..jitterMax) минут,
// чтобы присутствие не включалось/выключалось ровно по часам как робот.
import { config } from './config.js';

// Текущее время в нужной таймзоне -> { dow, minutes, dateKey }.
function nowInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    dow: dowMap[p.weekday],
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}

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

// Дневной сдвиг в минутах для границы (start/end): знак случаен, модуль в [jitterMin, jitterMax].
function dailyOffset(dateKey, which) {
  const { jitterMin, jitterMax } = config;
  const span = Math.max(0, jitterMax - jitterMin);
  const r1 = seededRandom(`${dateKey}:${which}:mag`);
  const r2 = seededRandom(`${dateKey}:${which}:sign`);
  const magnitude = jitterMin + r1 * span;
  const sign = r2 < 0.5 ? -1 : 1;
  return Math.round(sign * magnitude);
}

// Эффективные (плавающие) границы рабочего окна на конкретный день, в минутах от полуночи.
export function effectiveBounds(dateKey) {
  const clamp = (m) => Math.min(1439, Math.max(0, m));
  return {
    start: clamp(config.workStart + dailyOffset(dateKey, 'start')),
    end: clamp(config.workEnd + dailyOffset(dateKey, 'end')),
  };
}

// True, если текущий момент попадает в (плавающее) рабочее окно.
export function isWithinWorkHours() {
  const { dow, minutes, dateKey } = nowInTz(config.timezone);
  if (!config.workDays.has(dow)) return false;

  const { start, end } = effectiveBounds(dateKey);
  if (start <= end) {
    // Обычное окно в пределах одних суток.
    return minutes >= start && minutes < end;
  }
  // Окно через полночь, например 22:00–06:00.
  return minutes >= start || minutes < end;
}

// Удобно для логов: текущее время + сегодняшние плавающие границы.
export function describeNow() {
  const { dow, minutes, dateKey } = nowInTz(config.timezone);
  const { start, end } = effectiveBounds(dateKey);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `день=${dow} ${hhmm(minutes)} ${config.timezone} (окно сегодня ${hhmm(start)}–${hhmm(end)})`;
}
