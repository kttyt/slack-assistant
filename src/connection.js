// Менеджер WebSocket-соединения с Slack RTM.
// Пока соединение открыто и мы шлём периодические ping — Slack считает нас активным клиентом (зелёный шарик).
import WebSocket from 'ws';
import { config } from './config.js';
import { log } from './logger.js';
import { rtmConnect, setPresence, dndInfo, endSnooze, userName } from './slack.js';
import { markValid, markInvalid, isAuthError } from './health.js';
import { notify } from './notifier.js';

export class PresenceKeeper {
  constructor() {
    this.ws = null;
    this.pingTimer = null;
    this.presenceTimer = null;
    this.reconnectTimer = null;
    this.msgId = 1;
    this.backoff = 1000; // стартовая задержка переподключения, мс
    this.active = false; // хотим ли мы сейчас быть онлайн (управляется планировщиком)
    this.myUserId = null; // свой user_id — для детекта упоминаний и игнора своих сообщений
    this.teamUrl = null; // https://<team>.slack.com/ — для сборки ссылок на сообщения
  }

  // Сообщить, от чьего имени работаем (берётся из auth.test).
  setIdentity(userId, teamUrl) {
    this.myUserId = userId;
    this.teamUrl = teamUrl;
  }

  // Включить присутствие: открыть соединение и держать его.
  async start() {
    if (this.active) return;
    this.active = true;
    log.info('Включаю присутствие (зелёный)…');
    await this.connect();
  }

  // Выключить присутствие: закрыть соединение, при необходимости явно уйти в away.
  async stop() {
    if (!this.active) return;
    this.active = false;
    log.info('Выключаю присутствие…');
    this.teardownSocket();
    if (config.offHoursMode === 'away') {
      try {
        await setPresence('away');
        log.info('Статус выставлен в away (серый).');
      } catch (e) {
        log.warn('Не удалось выставить away:', e.message);
      }
    }
  }

  async connect() {
    if (!this.active) return;
    this.teardownSocket();
    try {
      const url = await rtmConnect();
      log.debug('Получен WS URL:', url.slice(0, 60) + '…');
      const ws = new WebSocket(url, {
        headers: { Cookie: `d=${config.xoxd}` },
      });
      this.ws = ws;

      ws.on('open', () => this.onOpen());
      ws.on('message', (raw) => this.onMessage(raw));
      ws.on('close', (code) => this.onClose(code));
      ws.on('error', (err) => log.warn('WS ошибка:', err.message));
    } catch (e) {
      log.warn('Не удалось подключиться:', e.message);
      if (isAuthError(e.message)) markInvalid(e.message);
      this.scheduleReconnect();
    }
  }

  async onOpen() {
    log.info('WebSocket подключён — аккаунт активен (зелёный).');
    this.backoff = 1000; // сброс backoff после успешного подключения
    markValid(); // успешное подключение = токен рабочий

    // Подтверждаем авто-присутствие и при необходимости снимаем DND.
    await this.refreshPresence();
    this.presenceTimer = setInterval(() => this.refreshPresence(), config.presenceRefreshMs);

    // Периодический ping держит соединение и сигнализирует активность.
    this.pingTimer = setInterval(() => this.sendPing(), config.pingIntervalMs);
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') log.debug('RTM: hello');
    else if (msg.type === 'pong') log.debug('RTM: pong');
    else if (msg.type === 'goodbye') {
      log.info('RTM: goodbye от сервера, переподключаюсь.');
      this.scheduleReconnect();
    } else if (msg.type === 'message') {
      this.handleMessage(msg).catch((e) => log.debug('handleMessage:', e.message));
    }
  }

  // Анализ входящего сообщения: уведомляем при прямом упоминании или личном сообщении.
  async handleMessage(m) {
    log.debug(`RTM message: subtype=${m.subtype || '-'} ch=${m.channel} user=${m.user} text="${String(m.text || '').slice(0, 60)}"`);
    if (m.subtype) return; // правки/удаления/системные/ботовые — пропускаем
    if (!m.user || !m.text) return;
    if (m.user === this.myUserId && !config.notifySelf) return; // своё сообщение — не уведомляем

    const ch = m.channel || '';
    const isDM = ch.startsWith('D');
    const isMention = this.myUserId && m.text.includes(`<@${this.myUserId}>`);

    const wantMention = isMention && config.notifyMentions;
    const wantDM = isDM && config.notifyDM;
    if (!wantMention && !wantDM) return;

    const from = await userName(m.user);
    const permalink = this.teamUrl
      ? `${this.teamUrl.replace(/\/$/, '')}/archives/${ch}/p${String(m.ts || '').replace('.', '')}`
      : undefined;

    await notify({
      kind: wantMention ? 'mention' : 'dm',
      from,
      user: m.user,
      channel: ch,
      channel_type: isDM ? 'im' : 'channel',
      text: m.text,
      ts: m.ts,
      permalink,
    });
  }

  onClose(code) {
    log.warn(`WebSocket закрыт (код ${code}).`);
    this.scheduleReconnect();
  }

  sendPing() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ id: this.msgId++, type: 'ping' }));
      } catch (e) {
        log.warn('Ping не отправлен:', e.message);
      }
    }
  }

  async refreshPresence() {
    try {
      await setPresence('auto');
    } catch (e) {
      log.warn('setPresence(auto) не удался:', e.message);
      if (isAuthError(e.message)) markInvalid(e.message);
    }
    if (config.clearDnd) {
      try {
        const info = await dndInfo();
        if (info.snooze_enabled) {
          await endSnooze();
          log.info('Снял режим «Не беспокоить» (убрал Zzz).');
        }
      } catch (e) {
        log.debug('Проверка/снятие DND не удались:', e.message);
      }
    }
  }

  scheduleReconnect() {
    this.teardownSocket();
    if (!this.active) return; // нас выключил планировщик — не переподключаемся
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60000); // экспоненциальный backoff до 60с
    log.info(`Переподключение через ${Math.round(delay / 1000)}с…`);
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
  }
}
