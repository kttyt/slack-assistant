// Мелкие помощники для тестов.

// Ждёт, пока predicate() не станет истинным (поллинг), либо бросает по таймауту.
// Нужен для интеграционных тестов, где реакция наступает асинхронно (реконнект, доставка).
export async function waitFor(predicate, { timeout = 3000, interval = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await sleep(interval);
  }
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Логгер-заглушка: молчит, но копит записи по уровням (для проверки, что что-то залогировали).
export function makeSilentLogger() {
  const records = { debug: [], info: [], warn: [], error: [] };
  const push = (lvl) => (...a) => records[lvl].push(a.join(' '));
  return {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

// Быстрые тайминги для интеграционных тестов PresenceKeeper (миллисекунды вместо секунд).
export const FAST_TIMINGS = {
  pingIntervalMs: 20,
  pongTimeoutMs: 80,
  presenceRefreshMs: 10000, // достаточно большой, чтобы не спамить в коротком тесте
  backoffStartMs: 10,
  backoffMaxMs: 40,
};
