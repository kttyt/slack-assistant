// CLI-помощник: открывает Slack в видимом (headful) браузере, даёт ВАМ войти вручную,
// затем снимает из вашей же сессии токен веб-клиента (xoxc), cookie "d" (xoxd) и User-Agent
// и записывает их в .env (или файл из --env-file), сохраняя остальные строки.
//
// Это автоматизация того, что README и так предлагает делать руками через DevTools, — для
// ВАШЕГО собственного аккаунта. Никаких чужих сессий. Нужны браузеры Playwright:
//   npx playwright install chromium
//
// Логин Slack проходит через НЕСКОЛЬКО вкладок (после ввода кода открывается вторая вкладка
// с выбором воркспейса и «Open in Browser»). Токен появляется в localStorage той вкладки, где
// в итоге загрузился клиент, поэтому grab-token опрашивает ВСЕ вкладки контекста, а не одну.
//
// Использует те же значения конфигурации, что и сервис (ENV -> config.yaml -> дефолт):
//   • TZ                 -> таймзона браузера (timezoneId), чтобы совпадать с сервисом;
//   • HTTP(S)_PROXY      -> вход в Slack идёт через тот же прокси, что и сервис.
// Секреты (xoxc/xoxd) для загрузки конфига НЕ требуются (grab-token их как раз добывает).
//
// Запуск:
//   node tools/grab-token.js [--env-file=.env] [--config=config.yaml]
//                            [--url=https://app.slack.com/] [--timeout=300]
//
// Stealth: прячем автоматизацию (navigator.webdriver, флаги automation), UA НЕ подменяем —
// наоборот, снимаем настоящий, чтобы сервис слал такой же.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { readYamlConfig } from '../src/config-file.js';

function parseArgs(argv) {
  const out = { envFile: '.env', url: 'https://app.slack.com/', timeout: 300, keepOpen: false };
  for (const a of argv) {
    if (a.startsWith('--env-file=')) out.envFile = a.slice('--env-file='.length);
    else if (a.startsWith('--url=')) out.url = a.slice('--url='.length);
    else if (a.startsWith('--timeout=')) out.timeout = parseInt(a.slice('--timeout='.length), 10) || 300;
    else if (a === '--keep-open') out.keepOpen = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (v) => (v && v.length > 14 ? `${v.slice(0, 10)}…${v.slice(-4)}` : '****');

// Обновить/добавить ключи в содержимом env-файла, не трогая прочие строки и комментарии.
function upsertEnv(content, updates) {
  const lines = content.length ? content.split(/\r?\n/) : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Za-z0-9_]+)\s*=/.exec(line);
    if (m && updates[m[2]] !== undefined) {
      seen.add(m[2]);
      return `${m[2]}=${updates[m[2]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  return out.join('\n').replace(/\n*$/, '\n');
}

// Достать xoxc-токен из localStorage веб-клиента (localConfig_v2 -> teams[*].token).
function extractTokenFromLocalConfig(raw) {
  if (!raw) return null;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  const teams = cfg.teams || {};
  const active = cfg.lastActiveTeamId && teams[cfg.lastActiveTeamId];
  if (active?.token?.startsWith('xoxc-')) return active.token;
  for (const t of Object.values(teams)) if (t?.token?.startsWith('xoxc-')) return t.token;
  return null;
}

// Прочитать токен из localStorage конкретной вкладки (страница может быть на любом origin
// или в процессе навигации — тогда evaluate бросит, это ок).
async function readTokenFromPage(page) {
  try {
    const raw = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('localConfig_v2');
      } catch {
        return null;
      }
    });
    return extractTokenFromLocalConfig(raw);
  } catch {
    return null;
  }
}

// Обойти ВСЕ открытые вкладки контекста. Логин Slack уходит в новую вкладку (app.slack.com),
// и токен появляется именно в её localStorage — одной первой вкладки недостаточно.
// Возвращает { token, userAgent } (что удалось снять).
async function scanContext(context) {
  let token = null;
  let userAgent = null;
  for (const page of context.pages()) {
    if (!token) {
      const t = await readTokenFromPage(page);
      if (t) token = t;
    }
    if (!userAgent) userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    if (token && userAgent) break;
  }
  return { token, userAgent };
}

// Прокси-URL -> объект proxy для Playwright (server без кредов + отдельно username/password).
function toPlaywrightProxy(url) {
  const u = new URL(url);
  const proxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Читаем ту же конфигурацию, что и сервис (без требования секретов — их мы и добываем).
  let cfg;
  try {
    const yaml = readYamlConfig(process.argv.slice(2));
    cfg = loadConfig(process.env, yaml, { requireSecrets: false });
  } catch (e) {
    console.error('✖ Ошибка конфигурации:', e.message);
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('✖ Playwright не установлен. Установите браузеры:');
    console.error('    npx playwright install chromium');
    process.exit(1);
  }

  console.log('Открываю браузер. Войдите в свой Slack-воркспейс в открывшемся окне.');
  console.log(`Токен будет сохранён в ${args.envFile}. Жду до ${args.timeout}с…`);

  // Stealth-настройки запуска: убираем automation-признаки, но UA оставляем настоящий.
  const launchOpts = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  // Прокси из конфига (тот же, что использует сервис) — вход в Slack идёт через него.
  const proxyUrl = cfg.httpsProxy || cfg.httpProxy;
  if (proxyUrl) {
    launchOpts.proxy = toPlaywrightProxy(proxyUrl);
    console.log(`Через прокси: ${launchOpts.proxy.server}`);
  }
  const browser = await chromium.launch(launchOpts);

  // Таймзона браузера — из конфига, чтобы совпадать с сервисом.
  const context = await browser.newContext({ viewport: null, timezoneId: cfg.timezone });
  console.log(`Таймзона браузера: ${cfg.timezone}`);
  await context.addInitScript(() => {
    // Прячем самый заметный признак Playwright/headless.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Правдоподобные languages/plugins.
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  // Новые вкладки (логин Slack открывает вторую — выбор воркспейса и «Open in Browser»)
  // автоматически попадают в context.pages(); здесь лишь логируем их для наглядности.
  context.on('page', (p) => {
    console.log('→ Открылась новая вкладка — тоже отслеживаю её.');
    p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  });

  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Поллинг: ждём, пока в ЛЮБОЙ вкладке появится токен (localStorage) и cookie "d"
  // (cookie общий на весь контекст, поэтому не зависит от конкретной вкладки).
  const deadline = Date.now() + args.timeout * 1000;
  let token = null;
  let xoxd = null;
  let userAgent = null;

  while (Date.now() < deadline) {
    const scan = await scanContext(context);
    if (scan.token) token = scan.token;
    if (scan.userAgent) userAgent = scan.userAgent;
    const cookies = await context.cookies();
    const d = cookies.find((c) => c.name === 'd' && /slack\.com$/.test(c.domain.replace(/^\./, '')));
    xoxd = d?.value?.startsWith('xoxd-') ? d.value : null;
    if (token && xoxd) break;
    await sleep(1500);
  }

  if (!token || !xoxd) {
    console.error('✖ Не удалось получить токен/cookie за отведённое время. Убедитесь, что вошли в воркспейс.');
    if (!args.keepOpen) await browser.close();
    process.exit(1);
  }

  const updates = {
    SLACK_XOXC_TOKEN: token,
    SLACK_XOXD_COOKIE: xoxd,
  };
  if (userAgent) updates.USER_AGENT = userAgent;

  const existing = existsSync(args.envFile) ? readFileSync(args.envFile, 'utf8') : '';
  writeFileSync(args.envFile, upsertEnv(existing, updates), 'utf8');

  console.log('✔ Готово. Записано в', args.envFile + ':');
  console.log('   SLACK_XOXC_TOKEN =', mask(token));
  console.log('   SLACK_XOXD_COOKIE =', mask(xoxd));
  if (userAgent) console.log('   USER_AGENT =', userAgent);
  console.log('Секреты не коммитьте: .env в .gitignore, pre-commit hook блокирует токены.');

  if (!args.keepOpen) await browser.close();
}

main().catch((e) => {
  console.error('Ошибка grab-token:', e.message);
  process.exit(1);
});
