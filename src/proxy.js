// Поддержка HTTP/S-прокси для двух разных транспортов:
//   • Web API (глобальный fetch/undici) — через dispatcher из undici.ProxyAgent;
//   • WebSocket (ws) — через Node http.Agent из https-proxy-agent.
//
// Пакеты undici и https-proxy-agent — ОПЦИОНАЛЬНЫЕ (optionalDependencies) и в прод-образ
// по умолчанию не попадают. Если прокси задан в конфиге/окружении, но пакеты не установлены,
// сборка рантайма падает с понятной ошибкой (см. index.js) — это осознанный «feature flag».
//
// buildProxy() асинхронна из-за динамического import(). importer инъектируется для тестов.

// Простой матчер NO_PROXY: хост совпадает точно или является поддоменом записи (с ведущей точкой
// или без). "*" отключает прокси для всех хостов.
function isBypassed(host, noProxy) {
  if (!host) return false;
  for (const entryRaw of noProxy) {
    const entry = entryRaw.replace(/^\./, '').toLowerCase();
    if (entry === '*') return true;
    if (!entry) continue;
    const h = host.toLowerCase();
    if (h === entry || h.endsWith('.' + entry)) return true;
  }
  return false;
}

function hostOf(url) {
  try {
    return new URL(url).host.split(':')[0];
  } catch {
    return '';
  }
}

// Собирает прокси-обёртки из config. Возвращает { enabled, fetchImpl, wsAgent }.
// Если прокси не задан — enabled=false и обёртки undefined (используются дефолты: обычный fetch, без agent).
// Если задан, но пакеты не установлены — бросает Error(code=PROXY_DEPS_MISSING).
export async function buildProxy(config, { importer = (m) => import(m), fetchImpl = fetch } = {}) {
  const proxyUrl = config.httpsProxy || config.httpProxy;
  if (!proxyUrl) return { enabled: false, fetchImpl: undefined, wsAgent: undefined };

  let ProxyAgent;
  let HttpsProxyAgent;
  try {
    ({ ProxyAgent } = await importer('undici'));
    ({ HttpsProxyAgent } = await importer('https-proxy-agent'));
  } catch (e) {
    const err = new Error(
      `Прокси задан (${proxyUrl}), но опциональные пакеты не установлены. ` +
        `Установите их: npm install undici https-proxy-agent  (${e.message})`,
    );
    err.code = 'PROXY_DEPS_MISSING';
    throw err;
  }

  const noProxy = config.noProxy || [];
  const dispatcher = new ProxyAgent(proxyUrl);
  const wsAgent = new HttpsProxyAgent(proxyUrl);

  // fetch через прокси, но с уважением к NO_PROXY (для хостов из списка — напрямую).
  const proxiedFetch = (url, opts = {}) => {
    const host = hostOf(typeof url === 'string' ? url : url?.url || '');
    if (isBypassed(host, noProxy)) return fetchImpl(url, opts);
    return fetchImpl(url, { ...opts, dispatcher });
  };

  return {
    enabled: true,
    proxyUrl,
    fetchImpl: proxiedFetch,
    // Для ws: агент нужен только если хост не в NO_PROXY. Хост WS известен на момент connect,
    // поэтому отдаём функцию-резолвер И готовый agent; connection.js берёт agent как есть
    // (весь трафик идёт на slack.com — при необходимости bypass настраивается на уровне NO_PROXY).
    wsAgent: (wsUrl) => (isBypassed(hostOf(wsUrl), noProxy) ? undefined : wsAgent),
  };
}
