import { describe, test, expect } from 'vitest';
import { buildProxy } from '../../src/proxy.js';

// Фейковые классы вместо реальных undici/https-proxy-agent — importer инъектируется.
class FakeProxyAgent {
  constructor(url) {
    this.url = url;
  }
}
class FakeHttpsProxyAgent {
  constructor(url) {
    this.url = url;
  }
}
const fakeImporter = async (mod) => {
  if (mod === 'undici') return { ProxyAgent: FakeProxyAgent };
  if (mod === 'https-proxy-agent') return { HttpsProxyAgent: FakeHttpsProxyAgent };
  throw new Error(`unexpected import ${mod}`);
};

describe('buildProxy — сборка прокси-обёрток', () => {
  /**
   * Что: прокси не задан.
   * Вход: конфиг без httpProxy/httpsProxy.
   * Поведение: возвращаются пустышки — используются дефолтные fetch/ws без прокси.
   * Ожидаем: enabled=false, fetchImpl/wsAgent undefined.
   */
  test('без прокси -> disabled', async () => {
    const p = await buildProxy({ httpProxy: '', httpsProxy: '', noProxy: [] }, { importer: fakeImporter });
    expect(p.enabled).toBe(false);
    expect(p.fetchImpl).toBeUndefined();
    expect(p.wsAgent).toBeUndefined();
  });

  /**
   * Что: прокси задан, пакеты доступны.
   * Вход: httpsProxy + importer, отдающий фейковые агенты.
   * Поведение: собирается обёртка fetch (с dispatcher) и резолвер ws-agent.
   * Ожидаем: enabled=true; fetchImpl зовёт fetchImpl с dispatcher; wsAgent(url) отдаёт agent.
   */
  test('с прокси и пакетами -> обёртки собраны', async () => {
    const calls = [];
    const innerFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };
    const p = await buildProxy(
      { httpsProxy: 'http://proxy.local:8080', noProxy: [] },
      { importer: fakeImporter, fetchImpl: innerFetch },
    );
    expect(p.enabled).toBe(true);
    await p.fetchImpl('https://slack.com/api/auth.test', { method: 'POST' });
    expect(calls[0].opts.dispatcher).toBeInstanceOf(FakeProxyAgent);
    expect(p.wsAgent('wss://wss-primary.slack.com/link')).toBeInstanceOf(FakeHttpsProxyAgent);
  });

  /**
   * Что: прокси задан, но пакеты не установлены.
   * Вход: importer, бросающий при import (эмуляция отсутствия undici).
   * Поведение: сборка падает с понятной ошибкой и кодом PROXY_DEPS_MISSING.
   * Ожидаем: throw с code=PROXY_DEPS_MISSING и упоминанием npm install.
   */
  test('прокси задан, пакеты отсутствуют -> PROXY_DEPS_MISSING', async () => {
    const badImporter = async () => {
      throw new Error('Cannot find module');
    };
    await expect(
      buildProxy({ httpsProxy: 'http://proxy.local:8080', noProxy: [] }, { importer: badImporter }),
    ).rejects.toMatchObject({ code: 'PROXY_DEPS_MISSING' });
  });

  /**
   * Что: обход прокси по NO_PROXY.
   * Вход: NO_PROXY содержит slack.com; запрос идёт на slack.com.
   * Поведение: для хоста из списка прокси не применяется (fetch без dispatcher, ws-agent undefined).
   * Ожидаем: dispatcher отсутствует для slack.com; wsAgent(slack) -> undefined.
   */
  test('NO_PROXY обходит прокси для указанного хоста', async () => {
    const calls = [];
    const innerFetch = async (url, opts) => {
      calls.push(opts);
      return { ok: true, status: 200 };
    };
    const p = await buildProxy(
      { httpsProxy: 'http://proxy.local:8080', noProxy: ['slack.com'] },
      { importer: fakeImporter, fetchImpl: innerFetch },
    );
    await p.fetchImpl('https://slack.com/api/auth.test', {});
    expect(calls[0].dispatcher).toBeUndefined(); // slack.com в NO_PROXY -> напрямую
    expect(p.wsAgent('wss://wss-primary.slack.com/link')).toBeUndefined();
  });
});
