// Простой логгер с уровнями, без внешних зависимостей.
// Начальный уровень берётся из LOG_LEVEL (чтобы ранние логи до загрузки конфига уже фильтровались);
// index.js после loadConfig вызывает log.setLevel(config.logLevel), применяя значение из ENV/YAML.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}]`;
  (level === 'error' ? console.error : console.log)(line, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  // Сменить порог логирования (debug|info|warn|error). Неизвестное имя игнорируется.
  setLevel: (name) => {
    if (LEVELS[name] !== undefined) threshold = LEVELS[name];
  },
};
