// Менеджер WebSocket-соединения с Slack RTM.
// Зелёный статус держит НЕ ping/pong (это лишь транспортный keep-alive) и НЕ setPresence('auto'),
// а периодический прикладной кадр активности {"type":"tickle"} — только он сбрасывает away-таймер
// presence-сервера Slack (Flannel), который иначе через ~10 минут переводит аккаунт в away.
// Реальный presence проверяем через users.getPresence и отражаем в health (без «ложно-зелёного»).
//
// Все зависимости инъектируются через конструктор: slack-клиент, notify, health-экземпляр,
// логгер, тайминги, поведение, реализация WebSocket и (опционально) прокси-agent для ws.
// Никакого доступа к глобальному конфигу — в тестах подставляются фейки и микросекундные тайминги.
import WebSocket from 'ws';
import { log as defaultLog } from './logger.js';
import { isAuthError } from './slack.js';
import { classifyMessage } from './detect.js';

// Человекочитаемое описание состояния DND для логов. active — реально ли «Не беспокоить»
// прямо сейчас (снуз или время внутри окна расписания), а не просто факт наличия расписания.
function describeDnd(d) {
  const parts = [`активен=${d.active ? 'да' : 'нет'}`];
  if (d.snooze) parts.push(`ручной снуз${d.snooze_endtime ? ` до ${new Date(d.snooze_endtime * 1000).toISOString()}` : ''}`);
  if (d.scheduledActive) parts.push(`по расписанию до ${new Date((d.windowEnd || 0) * 1000).toISOString()}`);
  if (!d.active && d.scheduleConfigured) parts.push('расписание настроено (сейчас вне окна)');
  return parts.join(', ');
}

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
    this.tickleIntervalMs = timings.tickleIntervalMs ?? 180000; // кадр активности (< 10-мин окна away)
    this.pongTimeoutMs = timings.pongTimeoutMs ?? 60000;
    this.presenceRefreshMs = timings.presenceRefreshMs ?? 120000;
    this.backoffStartMs = timings.backoffStartMs ?? 1000;
    this.backoffMaxMs = timings.backoffMaxMs ?? 60000;

    // Поведение: присутствие.
    this.offHoursMode = behavior.offHoursMode ?? 'release';
    this.clearDnd = behavior.clearDnd ?? false; // снимать ручной снуз ("Pause notifications")
    this.clearScheduledDnd = behavior.clearScheduledDnd ?? false; // снимать DND по расписанию (opt-in)
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
    this.tickleTimer = null;
    this.presenceTimer = null;
    this.reconnectTimer = null;
    this.msgId = 1;
    this.backoff = this.backoffStartMs; // текущая задержка переподключения, мс
    this.active = false; // хотим ли мы сейчас быть онлайн (управляется планировщиком)
    this.myUserId = identity.userId ?? null; // свой user_id — для детекта упоминаний
    this.teamUrl = identity.teamUrl ?? null; // https://<team>.slack.com/ — для ссылок
    this.lastPongAt = 0; // время последнего pong, мс (для детекта мёртвого соединения)
    this.offHoursApplied = false; // выставили ли уже presence вне рабочих часов
    this.dndState = null; // последний снимок состояния DND (для детекта изменений)
    this.dndKey = null; // сериализованный снимок DND (быстрое сравнение)
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

    // Кадр активности: именно tickle (а не ping/setPresence) держит нас active в глазах Flannel.
    // Шлём сразу при подключении и затем периодически, с запасом внутри 10-минутного окна away.
    this.sendTickle();
    this.tickleTimer = setInterval(() => this.sendTickle(), this.tickleIntervalMs);
    this.log.debug(`Таймеры запущены: ping=${this.pingIntervalMs}мс, tickle=${this.tickleIntervalMs}мс, presence=${this.presenceRefreshMs}мс.`);
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

    // Ответ в треде: m.thread_ts указывает на корень. У самого корневого сообщения
    // thread_ts либо отсутствует, либо равен ts — такое за «ответ в треде» не считаем.
    const threadTs = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;

    let permalink;
    if (this.teamUrl) {
      const link = `${this.teamUrl.replace(/\/$/, '')}/archives/${ch}/p${String(m.ts || '').replace('.', '')}`;
      // Для ответа в треде добавляем thread_ts+cid, чтобы ссылка вела прямо в тред.
      permalink = threadTs ? `${link}?thread_ts=${threadTs}&cid=${ch}` : link;
    }

    // «Шапка» треда: текст и автор корневого сообщения (тянем только для ответов в треде).
    let threadRootText;
    let threadRootFrom;
    if (threadTs) {
      try {
        const root = await this.slack.threadRoot(ch, threadTs);
        if (root) {
          threadRootText = root.text;
          threadRootFrom = root.user ? await this.slack.userName(root.user) : undefined;
        }
      } catch (e) {
        this.log.debug(`threadRoot(${ch}, ${threadTs}) не удалось: ${e.message}`);
      }
    }

    this.log.debug(
      `  -> уведомление kind=${hit.kind} from=${from}${hit.keyword ? ` keyword=${hit.keyword}` : ''}${threadTs ? ' (ответ в треде)' : ''}`,
    );
    await this.notify({
      kind: hit.kind,
      from,
      user: m.user,
      channel: ch,
      channel_type: hit.channelType,
      text: m.text,
      ts: m.ts,
      thread_ts: threadTs || undefined,
      thread_root_text: threadRootText,
      thread_root_from: threadRootFrom,
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

  // Кадр активности для presence-сервера Slack. id — последовательный (как у ping).
  sendTickle() {
    if (this.ws && this.ws.readyState === this.WS.OPEN) {
      try {
        this.ws.send(JSON.stringify({ id: this.msgId++, type: 'tickle' }));
        this.log.debug('tickle отправлен (сигнал активности).');
      } catch (e) {
        this.log.warn('tickle не отправлен:', e.message);
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

    // Верификация: спрашиваем Slack, какой у нас РЕАЛЬНЫЙ presence. Делает health честным
    // и сразу показывает, работает ли tickle (иначе увидим 'away' при живом соединении).
    if (this.myUserId && this.slack.getPresence) {
      try {
        const p = await this.slack.getPresence(this.myUserId);
        this.health.markPresence(p.presence);
        if (p.presence === 'away') {
          this.log.warn('Slack видит нас AWAY при живом соединении — presence не держится (tickle не сработал?).');
        } else {
          this.log.debug(`Реальный presence: ${p.presence}.`);
        }
      } catch (e) {
        this.log.debug('users.getPresence не удался:', e.message);
      }
    }

    // Состояние DND читаем ВСЕГДА (для наблюдаемости), логируем изменения, сохраняем в health.
    // Снятие (endSnooze/endDnd) — только по включённым опциям.
    try {
      const info = await this.slack.dndInfo();
      const dnd = this.trackDnd(info);

      if (this.clearDnd && dnd.snooze) {
        // Ручной снуз ("Pause notifications на N минут/до завтра").
        await this.slack.endSnooze();
        this.log.info('Снял ручной снуз «Не беспокоить» (убрал Zzz).');
        this.applyDndCleared({ snooze: false, snooze_endtime: 0 });
      } else if (this.clearScheduledDnd && dnd.scheduledActive && this.slack.endDnd) {
        // DND по расписанию активен ПРЯМО СЕЙЧАС: endSnooze его не берёт — завершаем сессию.
        await this.slack.endDnd();
        this.log.info('Завершил DND-сессию по расписанию (убрал Zzz).');
        this.applyDndCleared({ scheduledActive: false, windowEnd: 0 });
      }
    } catch (e) {
      this.log.debug('Проверка/снятие DND не удались:', e.message);
    }
  }

  // Снимок состояния DND; логируем при любом изменении, сохраняем в health. Возвращает snap.
  // Ключевое: dnd_enabled из API = «расписание настроено», а не «активно сейчас». Реальную
  // активность (виден ли коллегам Zzz) вычисляем: снуз ИЛИ текущее время внутри окна расписания.
  trackDnd(info) {
    const now = Math.floor(this.now() / 1000);
    const scheduledActive =
      !!info.dnd_enabled && !!info.next_dnd_start_ts && !!info.next_dnd_end_ts && now >= info.next_dnd_start_ts && now < info.next_dnd_end_ts;
    const snap = {
      active: !!info.snooze_enabled || scheduledActive, // реально ли «Не беспокоить» сейчас (Zzz)
      snooze: !!info.snooze_enabled, // ручной снуз активен
      scheduledActive, // активен по расписанию прямо сейчас
      scheduleConfigured: !!info.dnd_enabled, // расписание в принципе настроено
      snooze_endtime: info.snooze_enabled ? info.snooze_endtime || 0 : 0,
      windowEnd: scheduledActive ? info.next_dnd_end_ts || 0 : 0,
    };
    const key = JSON.stringify(snap);
    if (this.dndKey === null) {
      this.log.info(`DND исходное состояние: ${describeDnd(snap)}.`);
    } else if (key !== this.dndKey) {
      this.log.info(`DND изменился: ${describeDnd(this.dndState)} → ${describeDnd(snap)}.`);
    }
    this.dndState = snap;
    this.dndKey = key;
    this.health.markDnd(snap);
    return snap;
  }

  // Отразить в сохранённом состоянии наше собственное снятие DND, чтобы на следующем цикле
  // оно не залогировалось повторно как «изменение» (мы его уже отдельно залогировали).
  applyDndCleared(patch) {
    const s = { ...this.dndState, ...patch };
    s.active = s.snooze || s.scheduledActive; // пересчитываем итоговую активность
    this.dndState = s;
    this.dndKey = JSON.stringify(s);
    this.health.markDnd(s);
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
    if (this.tickleTimer) clearInterval(this.tickleTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.tickleTimer = this.presenceTimer = this.reconnectTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.removeAllListeners();
        // terminate() на ещё-подключающемся сокете асинхронно эмитит 'error'; без обработчика
        // он всплывает как unhandled. Ставим no-op, чтобы аккуратно его проглотить.
        ws.on('error', () => {});
        ws.terminate();
      } catch {
        /* игнорируем */
      }
    }
    this.health.markSocketDisconnected();
  }
}
