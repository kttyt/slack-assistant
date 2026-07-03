// Менеджер WebSocket-соединения с Slack RTM.
// Пока соединение открыто и мы шлём периодические ping — Slack считает нас активным клиентом (зелёный шарик).
//
// Все зависимости инъектируются через конструктор: slack-клиент, notify, health-экземпляр,
// логгер, тайминги, поведение, реализация WebSocket и (опционально) прокси-agent для ws.
// Никакого доступа к глобальному конфигу — в тестах подставляются фейки и микросекундные тайминги.
import WebSocket from 'ws';
import { log as defaultLog } from './logger.js';
import { isAuthError } from './slack.js';
import { classifyMessage } from './detect.js';

export class PresenceKeeper {
  constructor({
    slack,
    notify,
    health,
    logger = defaultLog,
    timings = {},
    behavior = {},
    identity = {},
    WebSocketImpl = WebSocket,
    wsAgent = null,
    now = () => Date.now(),
  }) {
    this.slack = slack;
    this.notify = notify;
    this.health = health;
    this.log = logger;
    this.WS = WebSocketImpl;
    this.wsAgent = wsAgent; // (wsUrl) => http.Agent | undefined  (для прокси)
    this.now = now;

    // Тайминги (в проде приходят из config; в тестах — крошечные).
    this.pingIntervalMs = timings.pingIntervalMs ?? 20000;
    this.pongTimeoutMs = timings.pongTimeoutMs ?? 60000;
    this.presenceRefreshMs = timings.presenceRefreshMs ?? 120000;
    this.backoffStartMs = timings.backoffStartMs ?? 1000;
    this.backoffMaxMs = timings.backoffMaxMs ?? 60000;

    // Поведение: присутствие.
    this.offHoursMode = behavior.offHoursMode ?? 'release';
    this.clearDnd = behavior.clearDnd ?? false;
    // Поведение: детект входящих (что считать поводом для уведомления).
    this.notifyMentions = behavior.notifyMentions ?? true;
    this.mentionChannelWide = behavior.mentionChannelWide ?? false; // @here/@channel/@everyone
    this.notifyDM = behavior.notifyDM ?? true;
    this.dmChannelPrefixes = behavior.dmChannelPrefixes ?? ['D'];
    this.notifyGroupDm = behavior.notifyGroupDm ?? false; // mpim
    this.notifyKeywords = behavior.notifyKeywords ?? []; // уже в нижнем регистре
    this.notifySelf = behavior.notifySelf ?? false;

    this.ws = null;
    this.pingTimer = null;
    this.presenceTimer = null;
    this.reconnectTimer = null;
    this.msgId = 1;
    this.backoff = this.backoffStartMs; // текущая задержка переподключения, мс
    this.active = false; // хотим ли мы сейчас быть онлайн (управляется планировщиком)
    this.myUserId = identity.userId ?? null; // свой user_id — для детекта упоминаний
    this.teamUrl = identity.teamUrl ?? null; // https://<team>.slack.com/ — для ссылок
    this.lastPongAt = 0; // время последнего pong, мс (для детекта мёртвого соединения)
    this.offHoursApplied = false; // выставили ли уже presence вне рабочих часов
  }

  // Сообщить, от чьего имени работаем (берётся из auth.test).
  setIdentity(userId, teamUrl) {
    this.log.debug(`Идентичность: user_id=${userId}, teamUrl=${teamUrl}`);
    this.myUserId = userId;
    this.teamUrl = teamUrl;
  }

  // Включить присутствие: открыть соединение и держать его.
  async start() {
    if (this.active) {
      this.log.debug('start(): уже активны — ничего не делаю.');
      return;
    }
    this.active = true;
    this.offHoursApplied = false;
    this.health.markActiveIntended(true);
    this.log.info('Включаю присутствие (зелёный)…');
    await this.connect();
  }

  // Выключить присутствие (планировщик, вне рабочих часов): закрыть соединение и,
  // при offHoursMode=away, один раз явно уйти в away. Идемпотентно: away выставляется
  // ровно один раз за период простоя (в т.ч. если процесс СТАРТОВАЛ уже вне расписания).
  async stop() {
    const wasActive = this.active;
    this.active = false;
    this.health.markActiveIntended(false);
    this.teardownSocket();
    if (wasActive) this.log.info('Присутствие выключено.');
    else this.log.debug('stop(): активного соединения не было.');

    if (this.offHoursMode === 'away' && !this.offHoursApplied) {
      this.offHoursApplied = true;
      try {
        await this.slack.setPresence('away');
        this.log.info('Статус выставлен в away (серый).');
      } catch (e) {
        this.offHoursApplied = false; // не удалось — попробуем на следующем тике
        this.log.warn('Не удалось выставить away:', e.message);
      }
    }
  }

  // Корректное завершение работы (SIGTERM/SIGINT). Гасит таймеры/сокет и,
  // при offHoursMode=away, best-effort выставляет away перед выходом.
  async shutdown() {
    this.log.debug('shutdown(): гашу таймеры и сокет.');
    this.active = false;
    this.health.markActiveIntended(false);
    this.teardownSocket();
    if (this.offHoursMode === 'away') {
      try {
        await Promise.race([
          this.slack.setPresence('away'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        this.log.info('Перед выходом выставил away.');
      } catch (e) {
        this.log.warn('Не удалось выставить away при выходе:', e.message);
      }
    }
  }

  async connect() {
    if (!this.active) return;
    this.teardownSocket();
    try {
      const url = await this.slack.rtmConnect();
      this.log.debug('Получен WS URL:', url.slice(0, 60) + '…');
      const opts = { headers: this.slack.wsHeaders() };
      const agent = this.wsAgent ? this.wsAgent(url) : undefined;
      if (agent) {
        opts.agent = agent;
        this.log.debug('WebSocket через прокси-agent.');
      }
      const ws = new this.WS(url, opts);
      this.ws = ws;

      ws.on('open', () => this.onOpen());
      ws.on('message', (raw) => this.onMessage(raw));
      ws.on('close', (code) => this.onClose(code));
      ws.on('error', (err) => this.log.warn('WS ошибка:', err.message));
    } catch (e) {
      this.log.warn('Не удалось подключиться:', e.message);
      if (isAuthError(e.message)) this.health.markInvalid(e.message);
      this.scheduleReconnect();
    }
  }

  async onOpen() {
    this.log.info('WebSocket подключён — аккаунт активен (зелёный).');
    this.backoff = this.backoffStartMs; // сброс backoff после успешного подключения
    this.lastPongAt = this.now(); // считаем момент подключения «живым»
    this.health.markValid(); // успешное подключение = токен рабочий
    this.health.markSocketConnected();
    this.log.debug('Зелёный статус выставлен: токен валиден, сокет подключён.');

    // Подтверждаем авто-присутствие и при необходимости снимаем DND.
    await this.refreshPresence();
    this.presenceTimer = setInterval(() => this.refreshPresence(), this.presenceRefreshMs);

    // Периодический heartbeat: шлём ping и следим, что на него отвечают pong.
    this.pingTimer = setInterval(() => this.heartbeat(), this.pingIntervalMs);
    this.log.debug(`Таймеры запущены: ping=${this.pingIntervalMs}мс, presence=${this.presenceRefreshMs}мс.`);
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log.debug('RTM: не-JSON кадр проигнорирован.');
      return;
    }
    if (msg.type === 'hello') {
      this.log.debug('RTM: hello');
      this.lastPongAt = this.now(); // любой трафик от сервера = соединение живо
    } else if (msg.type === 'pong') {
      this.log.debug('RTM: pong');
      this.lastPongAt = this.now();
      this.health.markPong();
    } else if (msg.type === 'goodbye') {
      this.log.info('RTM: goodbye от сервера, переподключаюсь.');
      this.scheduleReconnect();
    } else if (msg.type === 'message') {
      this.handleMessage(msg).catch((e) => this.log.debug('handleMessage:', e.message));
    } else {
      this.log.debug(`RTM: событие type=${msg.type} — не обрабатывается.`);
    }
  }

  // Анализ входящего сообщения: решение о необходимости уведомления — в чистой classifyMessage;
  // здесь остаётся только оркестрация (резолв имени, permalink, вызов notify).
  async handleMessage(m) {
    const ch = m.channel || '';
    this.log.debug(
      `RTM message: subtype=${m.subtype || '-'} ch=${ch} chType=${m.channel_type || '-'} user=${m.user} text="${String(m.text || '').slice(0, 60)}"`,
    );

    const hit = classifyMessage(m, {
      myUserId: this.myUserId,
      notifySelf: this.notifySelf,
      notifyDM: this.notifyDM,
      dmChannelPrefixes: this.dmChannelPrefixes,
      notifyGroupDm: this.notifyGroupDm,
      notifyMentions: this.notifyMentions,
      mentionChannelWide: this.mentionChannelWide,
      notifyKeywords: this.notifyKeywords,
    });
    if (!hit) return this.log.debug('  -> отфильтровано (не подходит под условия уведомления).');

    const from = await this.slack.userName(m.user);
    const permalink = this.teamUrl
      ? `${this.teamUrl.replace(/\/$/, '')}/archives/${ch}/p${String(m.ts || '').replace('.', '')}`
      : undefined;

    this.log.debug(`  -> уведомление kind=${hit.kind} from=${from}${hit.keyword ? ` keyword=${hit.keyword}` : ''}`);
    await this.notify({
      kind: hit.kind,
      from,
      user: m.user,
      channel: ch,
      channel_type: hit.channelType,
      text: m.text,
      ts: m.ts,
      keyword: hit.keyword,
      permalink,
    });
  }

  onClose(code) {
    this.log.warn(`WebSocket закрыт (код ${code}).`);
    this.scheduleReconnect();
  }

  // Один такт heartbeat: если давно не было pong — соединение молча умерло
  // (типично при засыпании машины/смене сети/NAT-таймауте), переподключаемся.
  // Иначе шлём очередной ping.
  heartbeat() {
    if (!this.ws || this.ws.readyState !== this.WS.OPEN) return;
    const silence = this.now() - this.lastPongAt;
    if (silence > this.pongTimeoutMs) {
      this.log.warn(`Нет ответа (pong) уже ${Math.round(silence / 1000)}с — считаю соединение мёртвым, переподключаюсь.`);
      this.scheduleReconnect();
      return;
    }
    this.log.debug(`heartbeat: тишина ${silence}мс (лимит ${this.pongTimeoutMs}мс) — шлю ping.`);
    this.sendPing();
  }

  sendPing() {
    if (this.ws && this.ws.readyState === this.WS.OPEN) {
      try {
        this.ws.send(JSON.stringify({ id: this.msgId++, type: 'ping' }));
      } catch (e) {
        this.log.warn('Ping не отправлен:', e.message);
      }
    }
  }

  async refreshPresence() {
    try {
      await this.slack.setPresence('auto');
      this.log.debug('presence=auto подтверждён.');
    } catch (e) {
      this.log.warn('setPresence(auto) не удался:', e.message);
      if (isAuthError(e.message)) this.health.markInvalid(e.message);
    }
    if (this.clearDnd) {
      try {
        const info = await this.slack.dndInfo();
        if (info.snooze_enabled) {
          await this.slack.endSnooze();
          this.log.info('Снял режим «Не беспокоить» (убрал Zzz).');
        } else {
          this.log.debug('DND: snooze не активен.');
        }
      } catch (e) {
        this.log.debug('Проверка/снятие DND не удались:', e.message);
      }
    }
  }

  scheduleReconnect() {
    if (!this.active) {
      // Нас выключил планировщик — просто гасим сокет, без переподключения.
      this.teardownSocket();
      return;
    }
    if (this.reconnectTimer) return; // переподключение уже запланировано — не плодим дубли
    this.teardownSocket(); // закрыть текущий сокет и остановить ping/presence-таймеры
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.backoffMaxMs); // экспоненциальный backoff
    this.log.info(`Переподключение через ${Math.round(delay / 1000)}с…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // Аккуратно гасим таймеры и сокет.
  teardownSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.presenceTimer = this.reconnectTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        /* игнорируем */
      }
    }
    this.health.markSocketDisconnected();
  }
}
