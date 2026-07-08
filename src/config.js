// Чтение и валидация конфигурации.
// Источники значения (в порядке приоритета): переменная окружения -> config.yaml -> дефолт.
// То есть ENV перекрывает YAML — удобно точечно переопределять файл через окружение/CI.
// Секреты (xoxc/xoxd) — ИСКЛЮЧЕНИЕ: читаются только из окружения (см. политику безопасности).
//
// Каждая настройка описана ОДНОЙ строкой в таблице SCHEMA (единый источник правды: и связка
// yaml↔env, и тип, и дефолт, и валидатор). Движок ниже сам мёржит источники, приводит тип и
// валидирует. Добавить настройку = добавить строку в SCHEMA.
//
// Чистый модуль: loadConfig(env, yaml) НЕ трогает процесс, не читает диск и не парсит YAML сам.

// Реалистичный десктопный UA по умолчанию — трафик сервиса «сливается» с обычным веб-клиентом.
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Примитивы парсинга ───────────────────────────────────────────────────────

function parseDays(spec) {
  const days = new Set();
  for (const part of String(spec).split(',')) {
    const range = part.trim().split('-').map((s) => parseInt(s, 10));
    if (range.length === 2 && range.every(Number.isFinite)) {
      for (let d = range[0]; d <= range[1]; d++) days.add(d);
    } else if (range.length === 1 && Number.isFinite(range[0])) {
      days.add(range[0]);
    }
  }
  return days;
}

function parseTime(spec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(spec).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function leafPaths(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

// ── Кастомные валидаторы: (key, value) -> преобразованное значение | throw Error ─────────────
// Возвращают новое (возможно, преобразованное) значение или бросают Error с текстом причины —
// движок ловит его и добавляет к списку ошибок конфигурации.
const httpUrl = (_key, v) => {
  if (v && !isHttpUrl(v)) throw new Error('не валидный http(s) URL');
  return v;
};
const ianaTz = (_key, v) => {
  if (!isValidTimezone(v)) throw new Error('неизвестная таймзона IANA');
  return v;
};
const hhmm = (_key, v) => {
  const t = parseTime(v);
  if (t === null) throw new Error('ожидался формат HH:MM');
  return t; // минуты от полуночи
};
const daysSet = (_key, v) => {
  const set = Array.isArray(v) ? new Set(v.map((d) => parseInt(d, 10))) : parseDays(v);
  if (set.size === 0 || [...set].some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new Error('дни должны быть целыми 1..7 и непустыми');
  }
  return set;
};
const toLower = (_key, arr) => arr.map((k) => String(k).toLowerCase());

// ── Таблица настроек ─────────────────────────────────────────────────────────
// type: str | int | number | bool | enum | list | raw. validate — кастомный валидатор (см. выше).
const SCHEMA = [
  { key: 'apiBase', path: 'slack.apiBase', env: 'SLACK_API_BASE', type: 'str', def: 'https://slack.com/api', validate: httpUrl },
  { key: 'userAgent', path: 'slack.userAgent', env: 'USER_AGENT', type: 'str', def: DEFAULT_USER_AGENT },
  { key: 'timezone', path: 'schedule.timezone', env: 'TZ', type: 'str', def: 'UTC', validate: ianaTz },
  { key: 'workDays', path: 'schedule.workDays', env: 'WORK_DAYS', type: 'raw', def: '1-5', validate: daysSet },
  { key: 'workStart', path: 'schedule.hours.start', env: 'WORK_START', type: 'str', def: '09:00', validate: hhmm },
  { key: 'workEnd', path: 'schedule.hours.end', env: 'WORK_END', type: 'str', def: '19:00', validate: hhmm },
  { key: 'jitterMin', path: 'schedule.jitter.minMinutes', env: 'JITTER_MIN_MINUTES', type: 'number', def: 10, min: 0 },
  { key: 'jitterMax', path: 'schedule.jitter.maxMinutes', env: 'JITTER_MAX_MINUTES', type: 'number', def: 15, min: 0 },
  { key: 'offHoursMode', path: 'presence.offHoursMode', env: 'OFF_HOURS_MODE', type: 'enum', def: 'release', values: ['away', 'release'] },
  { key: 'clearDnd', path: 'presence.clearDnd', env: 'CLEAR_DND', type: 'bool', def: false },
  { key: 'pingIntervalMs', path: 'presence.pingIntervalMs', env: 'PING_INTERVAL_MS', type: 'int', def: 20000, min: 1000 },
  { key: 'tickleIntervalMs', path: 'presence.tickleIntervalMs', env: 'TICKLE_INTERVAL_MS', type: 'int', def: 180000, min: 10000 },
  { key: 'pongTimeoutMs', path: 'presence.pongTimeoutMs', env: 'PONG_TIMEOUT_MS', type: 'int', def: 60000, min: 5000 },
  { key: 'presenceRefreshMs', path: 'presence.presenceRefreshMs', env: 'PRESENCE_REFRESH_MS', type: 'int', def: 120000, min: 10000 },
  { key: 'webhookUrl', path: 'notifications.webhookUrl', env: 'WEBHOOK_URL', type: 'str', def: '', validate: httpUrl },
  { key: 'notifyMentions', path: 'notifications.mentions.enabled', env: 'NOTIFY_MENTIONS', type: 'bool', def: true },
  { key: 'mentionChannelWide', path: 'notifications.mentions.channelWide', env: 'NOTIFY_CHANNEL_WIDE', type: 'bool', def: false },
  { key: 'notifyDM', path: 'notifications.dm.enabled', env: 'NOTIFY_DM', type: 'bool', def: true },
  { key: 'dmChannelPrefixes', path: 'notifications.dm.channelPrefixes', env: 'DM_CHANNEL_PREFIXES', type: 'list', def: ['D'] },
  { key: 'notifyGroupDm', path: 'notifications.dm.groupDm', env: 'NOTIFY_GROUP_DM', type: 'bool', def: false },
  { key: 'notifyKeywords', path: 'notifications.keywords', env: 'NOTIFY_KEYWORDS', type: 'list', def: [], validate: toLower },
  { key: 'notifySelf', path: 'notifications.self', env: 'NOTIFY_SELF', type: 'bool', def: false },
  { key: 'apiPort', path: 'api.port', env: 'API_PORT', type: 'int', def: 3000, min: 1, max: 65535 },
  { key: 'healthCheckMs', path: 'health.checkMs', env: 'HEALTH_CHECK_MS', type: 'int', def: 300000, min: 10000 },
  { key: 'httpProxy', path: 'proxy.http', env: 'HTTP_PROXY', type: 'str', def: '', validate: httpUrl },
  { key: 'httpsProxy', path: 'proxy.https', env: 'HTTPS_PROXY', type: 'str', def: '', validate: httpUrl },
  { key: 'noProxy', path: 'proxy.noProxy', env: 'NO_PROXY', type: 'list', def: [] },
  { key: 'logLevel', path: 'logging.level', env: 'LOG_LEVEL', type: 'enum', def: 'info', values: ['debug', 'info', 'warn', 'error'] },
];
const KNOWN_PATHS = new Set(SCHEMA.map((f) => f.path));

// Приведение типа. При ошибке типа/диапазона добавляет сообщение в errors и возвращает дефолт.
function coerce(f, raw, fmt, errors) {
  if (raw === undefined) return f.def;
  switch (f.type) {
    case 'raw':
      return raw;
    case 'str':
      return String(raw).trim();
    case 'bool':
      return typeof raw === 'boolean' ? raw : ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'list':
      return (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean);
    case 'enum': {
      const v = String(raw).trim().toLowerCase();
      if (!f.values.includes(v)) {
        errors.push(fmt(f, raw, `допустимо одно из: ${f.values.join(', ')}`));
        return f.def;
      }
      return v;
    }
    case 'int':
    case 'number': {
      const n = Number(raw);
      const min = f.min ?? -Infinity;
      const max = f.max ?? Infinity;
      const integer = f.type === 'int';
      if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
        errors.push(fmt(f, raw, `ожидалось число в [${min}, ${max}]${integer ? ' (целое)' : ''}`));
        return f.def;
      }
      return n;
    }
    default:
      return raw;
  }
}

// ── Сборка + валидация ───────────────────────────────────────────────────────

// Строит и валидирует конфиг. env — окружение, yaml — распарсенный config.yaml (или {}).
// onWarn(msg) — предупреждения (неизвестные ключи YAML). requireSecrets=false снимает требование
// токенов xoxc/xoxd (нужно инструментам вроде grab-token). При ошибках бросает Error(CONFIG_INVALID).
export function loadConfig(env = process.env, yaml = {}, { onWarn = () => {}, requireSecrets = true } = {}) {
  const errors = [];
  const y = yaml && typeof yaml === 'object' ? yaml : {};
  const fmt = (f, raw, detail) => `${f.path} (${f.env}=${raw}) — ${detail}`;

  // Нормализуем прокси-переменные: принимаем и UPPER, и lower регистр (это конвенция).
  const E = { ...env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if ((E[k] === undefined || E[k] === '') && E[k.toLowerCase()] !== undefined) E[k] = E[k.toLowerCase()];
  }

  // Предупредить о ключах YAML, которых мы не знаем (частая причина — опечатка).
  for (const path of leafPaths(y)) {
    if (!KNOWN_PATHS.has(path)) onWarn(`config.yaml: неизвестный ключ «${path}» — проигнорирован`);
  }

  // Разрешение значения по приоритету: ENV -> YAML -> (undefined). Секреты сюда не попадают.
  const pick = (yamlPath, envName) => {
    const ev = E[envName];
    if (ev !== undefined && String(ev) !== '') return String(ev).trim(); // ENV — высший приоритет (строка)
    const yv = getPath(y, yamlPath);
    if (yv !== undefined && yv !== null) return yv; // затем YAML — уже типизировано
    return undefined;
  };

  // Прогоняем таблицу: pick -> coerce -> кастомный validate.
  const out = {};
  for (const f of SCHEMA) {
    const raw = pick(f.path, f.env);
    let value = coerce(f, raw, fmt, errors);
    if (f.validate) {
      try {
        value = f.validate(f.key, value);
      } catch (e) {
        errors.push(fmt(f, raw === undefined ? f.def : raw, e.message));
        value = f.def;
      }
    }
    out[f.key] = value;
  }

  // Кросс-полевые проверки (валидатор видит только своё поле, поэтому — отдельно).
  if (out.jitterMax < out.jitterMin) {
    errors.push(`schedule.jitter.maxMinutes (${out.jitterMax}) должен быть >= minMinutes (${out.jitterMin})`);
  }
  if (out.pongTimeoutMs <= out.pingIntervalMs) {
    errors.push(`presence.pongTimeoutMs (${out.pongTimeoutMs}) должен быть больше pingIntervalMs (${out.pingIntervalMs})`);
  }

  // Секреты — ТОЛЬКО из окружения. requireSecrets=false отключает требование (для grab-token).
  const requireSecret = (name) => {
    const v = E[name];
    const t = v === undefined ? '' : String(v).trim();
    if (requireSecrets && !t) errors.push(`${name} обязательна (только через окружение) и не должна быть пустой`);
    return t;
  };
  const xoxc = requireSecret('SLACK_XOXC_TOKEN');
  const xoxd = requireSecret('SLACK_XOXD_COOKIE');
  // Токен управляющего API (/react). Секрет -> только из окружения. Пусто = /react выключен.
  const controlToken = E.CONTROL_TOKEN ? String(E.CONTROL_TOKEN).trim() : '';

  if (errors.length) {
    const err = new Error('Некорректная конфигурация:\n' + errors.map((e) => `  • ${e}`).join('\n'));
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  return { xoxc, xoxd, controlToken, ...out };
}
