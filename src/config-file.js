// Чтение config.yaml по флагу --config из argv. Вынесено отдельно, чтобы им могли пользоваться
// и CLI сервиса (index.js), и вспомогательные инструменты (tools/grab-token.js), не импортируя
// друг друга. Сам разбор/валидацию значений делает loadConfig (config.js) — сюда приходит уже
// распарсенный YAML-объект.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

// Достаёт путь к YAML-конфигу из argv: поддерживает "--config=path" и "--config path".
export function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--config=')) return a.slice('--config='.length);
    if (a === '--config') return argv[i + 1];
  }
  return undefined;
}

// Читает и парсит config.yaml по пути из --config. Возвращает {} если флаг не задан.
// Отсутствие файла/ошибка парсинга при заданном флаге — фатально (бросает Error).
export function readYamlConfig(argv) {
  const path = parseConfigPath(argv);
  if (!path) return {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`не удалось прочитать --config ${path}: ${e.message}`);
  }
  try {
    return parseYaml(text) || {};
  } catch (e) {
    throw new Error(`не удалось разобрать YAML ${path}: ${e.message}`);
  }
}
