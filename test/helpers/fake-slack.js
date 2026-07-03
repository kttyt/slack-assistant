// Управляемый фейковый Slack: HTTP Web API + WebSocket RTM.
// Позволяет проигрывать сценарии (протухший токен, отказ отвечать pong, goodbye,
// входящие сообщения, HTTP-ошибки) и подсматривать, какие вызовы сделал клиент.
//
// rtm.connect отдаёт URL нашего же WS-сервера, поэтому реальный WebSocket-клиент
// приложения естественным образом подключается к фейку — без моков внутри кода.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export function createFakeSlack() {
  const state = {
    authOk: true, // false -> все методы (кроме заданных) отвечают invalid_auth
    user: 'tester',
    userId: 'U_ME',
    team: 'Test Team',
    teamUrl: 'https://test.slack.com/',
    errors: {}, // method -> строка ошибки Slack (data.ok=false)
    httpStatus: {}, // method -> HTTP-статус вместо 200 (для проверки HTTP-ошибок)
    users: {}, // id -> { display_name, real_name }
    presence: null, // последнее значение users.setPresence
    snooze: false, // состояние dnd
    dropPongs: false, // не отвечать на ping (симуляция мёртвого соединения)
    reactions: [], // поставленные реакции { channel, timestamp, name }
  };
  const calls = []; // { method, params } по каждому HTTP-вызову
  const clients = new Set(); // открытые WS-соединения
  let httpServer;
  let wss;
  let wsUrl;

  function handleMethod(method, params) {
    calls.push({ method, params });
    if (state.errors[method]) return { ok: false, error: state.errors[method] };
    if (!state.authOk) return { ok: false, error: 'invalid_auth' };

    switch (method) {
      case 'auth.test':
        return { ok: true, user: state.user, user_id: state.userId, team: state.team, url: state.teamUrl };
      case 'rtm.connect':
        return { ok: true, url: wsUrl, self: { id: state.userId }, team: { url: state.teamUrl } };
      case 'users.setPresence':
        state.presence = params.presence;
        return { ok: true };
      case 'dnd.info':
        return { ok: true, snooze_enabled: state.snooze };
      case 'dnd.endSnooze':
        state.snooze = false;
        return { ok: true, snooze_enabled: false };
      case 'users.info': {
        const u = state.users[params.user] || {};
        return {
          ok: true,
          user: { id: params.user, name: params.user, real_name: u.real_name, profile: { display_name: u.display_name } },
        };
      }
      case 'reactions.add':
        state.reactions.push({ channel: params.channel, timestamp: params.timestamp, name: params.name });
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  function broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const ws of clients) {
      try {
        ws.send(raw);
      } catch {
        /* сокет уже закрыт */
      }
    }
  }

  async function start() {
    // WS-сервер на эфемерном порту.
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((res) => wss.once('listening', res));
    wsUrl = `ws://127.0.0.1:${wss.address().port}`;

    wss.on('connection', (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('message', (raw) => {
        let m;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.type === 'ping' && !state.dropPongs) {
          ws.send(JSON.stringify({ type: 'pong', reply_to: m.id }));
        }
      });
      ws.send(JSON.stringify({ type: 'hello' }));
    });

    // HTTP-сервер Web API на эфемерном порту.
    httpServer = http.createServer((req, res) => {
      const method = req.url.replace(/^\/api\//, '').split('?')[0];
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const status = state.httpStatus[method];
        if (status) {
          calls.push({ method, params: Object.fromEntries(new URLSearchParams(body)) });
          res.writeHead(status);
          res.end('error');
          return;
        }
        const params = Object.fromEntries(new URLSearchParams(body));
        const data = handleMethod(method, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });
    await new Promise((res) => httpServer.listen(0, '127.0.0.1', res));

    return { apiBase: `http://127.0.0.1:${httpServer.address().port}/api`, wsUrl };
  }

  async function stop() {
    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {
        /* уже закрыт */
      }
    }
    clients.clear();
    if (wss) await new Promise((res) => wss.close(res));
    if (httpServer) await new Promise((res) => httpServer.close(res));
  }

  return {
    start,
    stop,
    state,
    calls,
    get clients() {
      return clients;
    },
    // ── Управление сценарием ──
    setAuth(ok) {
      state.authOk = ok;
    },
    setError(method, error) {
      if (error) state.errors[method] = error;
      else delete state.errors[method];
    },
    setHttpStatus(method, status) {
      if (status) state.httpStatus[method] = status;
      else delete state.httpStatus[method];
    },
    setDropPongs(v = true) {
      state.dropPongs = v;
    },
    setSnooze(v = true) {
      state.snooze = v;
    },
    setUser(id, profile) {
      state.users[id] = profile;
    },
    sendGoodbye() {
      broadcast({ type: 'goodbye' });
    },
    sendMessage(msg) {
      broadcast({ type: 'message', ...msg });
    },
    closeSockets() {
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          /* уже закрыт */
        }
      }
    },
    // ── Инспекция ──
    callsFor(method) {
      return calls.filter((c) => c.method === method);
    },
    lastPresence() {
      return state.presence;
    },
    clientCount() {
      return clients.size;
    },
  };
}
