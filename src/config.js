// Чтение и валидация конфигурации из переменных окружения.
import { log } from './logger.js';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    log.error(`Не задана обязательная переменная окружения: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// Разбор "1-5" или "1,3,5" в множество дней недели (1=пн..7=вс).
function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',')) {
    const range = part.trim().split('-').map((s) => parseInt(s, 10));
    if (range.length === 2 && range.every(Number.isFinite)) {
      for (let d = range[0]; d <= range[1]; d++) days.add(d);
    } else if (range.length === 1 && Number.isFinite(range[0])) {
      days.add(range[0]);
    }
  }
  return days;
}

// "HH:MM" -> минуты от полуночи.
function parseTime(spec, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return fallback;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export const config = {
  xoxc: required('SLACK_XOXC_TOKEN'),
  xoxd: required('SLACK_XOXD_COOKIE'),
  timezone: process.env.TZ || 'UTC',
  workDays: parseDays(process.env.WORK_DAYS || '1-5'),
  workStart: parseTime(process.env.WORK_START || '09:00', 9 * 60),
  workEnd: parseTime(process.env.WORK_END || '19:00', 19 * 60),
  clearDnd: bool('CLEAR_DND', false),
  offHoursMode: (process.env.OFF_HOURS_MODE || 'release').toLowerCase(),
  pingIntervalMs: num('PING_INTERVAL_MS', 20000),
  presenceRefreshMs: num('PRESENCE_REFRESH_MS', 120000),
  // Healthcheck: периодическая проверка валидности токена.
  healthPort: num('HEALTH_PORT', 3000),
  healthCheckMs: num('HEALTH_CHECK_MS', 300000),
  // Плавающее расписание: границы старта/конца сдвигаются на случайные jitterMin..jitterMax минут.
  jitterMin: num('JITTER_MIN_MINUTES', 10),
  jitterMax: num('JITTER_MAX_MINUTES', 15),
  // Мониторинг входящих сообщений (упоминания/DM) -> уведомление на webhook.
  webhookUrl: (process.env.WEBHOOK_URL || '').trim(),
  notifyMentions: bool('NOTIFY_MENTIONS', true),
  notifyDM: bool('NOTIFY_DM', true),
  notifySelf: bool('NOTIFY_SELF', false), // обычно false; true — для самопроверки (уведомлять о своих сообщениях)
};
