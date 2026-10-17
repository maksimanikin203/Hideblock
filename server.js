const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ---------- статика ----------
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

// ---------- состояние ----------
const clients = new Map();  // ws -> { id, name, lobbyId }
const lobbies = new Map();  // lobbyId -> lobby

let lobbyCounter = 0;

function makeId(prefix = 'id_') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function makeLobby(hostId, hostName) {
  lobbyCounter++;
  const id = 'lobby_' + lobbyCounter;
  const lobby = {
    id,
    name: 'Лобби ' + lobbyCounter,
    hostId,
    players: [{ id: hostId, name: hostName }],
    settings: {
      mapMode: 'test1',
      hunter: 'random',
      debug: false,
      bots: true,
      playerCount: 4
    },
    state: 'lobby', // 'lobby' | 'game'
    game: null,
    seed: Math.floor(Math.random() * 1e9)
  };
  lobbies.set(id, lobby);
  return lobby;
}

function lobbySummary(l) {
  return {
    id: l.id,
    name: l.name,
    hostId: l.hostId,
    players: l.players.map(p => ({ id: p.id, name: p.name })),
    settings: l.settings,
    state: l.state
  };
}

function broadcastLobbyList() {
  const list = Array.from(lobbies.values()).map(lobbySummary);
  const msg = JSON.stringify({ type: 'lobbyList', lobbies: list });
  for (const [ws, c] of clients) {
    if (c.lobbyId === null && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastToLobby(lobbyId, msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.lobbyId === lobbyId && ws !== exceptWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------- WebSocket ----------
wss.on('connection', (ws) => {
  const client = { id: makeId('p_'), name: 'Игрок', lobbyId: null };
  clients.set(ws, client);

  send(ws, { type: 'welcome', id: client.id });
  send(ws, { type: 'lobbyList', lobbies: Array.from(lobbies.values()).map(lobbySummary) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // ---- вход / выход из лобби ----
      case 'setName': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          client.name = msg.name.trim().slice(0, 20);
        }
        break;
      }

      case 'createLobby': {
        if (client.lobbyId) leaveLobby(ws, client);
        const lobby = makeLobby(client.id, client.name);
        client.lobbyId = lobby.id;
        send(ws, { type: 'lobbyJoined', lobby: lobbySummary(lobby), youId: client.id });
        broadcastLobbyList();
        broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
        break;
      }

      case 'joinLobby': {
        const lobby = lobbies.get(msg.lobbyId);
        if (!lobby) { send(ws, { type: 'error', text: 'Лобби не найдено' }); break; }
        if (lobby.players.length >= lobby.settings.playerCount) {
          send(ws, { type: 'error', text: 'Лобби заполнено' }); break;
        }
        if (client.lobbyId) leaveLobby(ws, client);
        client.lobbyId = lobby.id;
        lobby.players.push({ id: client.id, name: client.name });
        send(ws, { type: 'lobbyJoined', lobby: lobbySummary(lobby), youId: client.id });
        broadcastLobbyList();
        broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
        break;
      }

      case 'leaveLobby': {
        leaveLobby(ws, client);
        send(ws, { type: 'lobbyLeft' });
        break;
      }

      // ---- настройки лобби (только хост) ----
      case 'updateSettings': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id) break;
        const s = msg.settings || {};
        if (typeof s.mapMode === 'string') lobby.settings.mapMode = s.mapMode;
        if (typeof s.hunter === 'string') lobby.settings.hunter = s.hunter;
        if (typeof s.debug === 'boolean') lobby.settings.debug = s.debug;
        if (typeof s.bots === 'boolean') lobby.settings.bots = s.bots;
        if (typeof s.playerCount === 'number') {
          lobby.settings.playerCount = Math.max(1, Math.min(4, Math.floor(s.playerCount)));
        }
        broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
        broadcastLobbyList();
        break;
      }

      // ---- старт игры (только хост) ----
      case 'startGame': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id) break;
        if (lobby.state !== 'lobby') break;

        const n = Math.max(1, Math.min(4, lobby.players.length));
        const settings = lobby.settings;

        let hunterSlot;
        if (settings.hunter === 'random') {
          hunterSlot = 1 + Math.floor(Math.random() * n);
        } else {
          const idx = parseInt(settings.hunter.replace('slot', ''), 10);
          hunterSlot = (idx >= 1 && idx <= n) ? idx : 1;
        }

        // генерация карты (детерминированная по seed)
        const map = generateMap(settings.mapMode, lobby.seed);

        const entities = [];
        for (let i = 0; i < n; i++) {
          const slot = i + 1;
          const player = lobby.players[i];
          entities.push({
            id: player.id,
            isBot: false,
            role: slot === hunterSlot ? 'hunter' : 'hider',
            x: 0,
            y: 40 + i * 30,
            fx: 1, fy: 0,
            disguised: false,
            disguiseColor: null,
            shootCd: 0,
            shootFlash: 0
          });
        }

        // боты-прячущиеся
        if (settings.bots) {
          let botN = 1;
          for (let i = n; i < settings.playerCount; i++) {
            const botId = 'bot_' + botN++;
            const pos = randomFreeSpot(map);
            entities.push({
              id: botId,
              isBot: true,
              role: 'hider',
              x: pos.x,
              y: pos.y,
              fx: 1, fy: 0,
              disguised: false,
              disguiseColor: null,
              shootCd: 0,
              shootFlash: 0,
              // AI
              tx: pos.x, ty: pos.y,
              wanderTimer: 0,
              hideTimer: 0,
              shootTimer: 1.5 + Math.random() * 2
            });
          }
        }

        lobby.state = 'game';
        lobby.game = {
          R: map.R,
          crates: map.crates,
          entities,
          projectiles: [],
          effects: [],
          toasts: [],
          time: 0,
          over: false,
          overTime: 0,
          hunterSlot
        };

        broadcastToLobby(lobby.id, {
          type: 'gameStart',
          game: {
            R: map.R,
            crates: map.crates,
            entities: entities.map(e => ({ ...e })),
            seed: lobby.seed
          },
          youId: null
        });

        // каждому клиенту отправим его собственный id (для удобства)
        for (const [cws, c] of clients) {
          if (c.lobbyId === lobby.id) {
            send(cws, {
              type: 'gameStart',
              game: {
                R: map.R,
                crates: map.crates,
                entities: entities.map(e => ({ ...e })),
                seed: lobby.seed
              },
              youId: c.id
            });
          }
        }

        break;
      }

      // ---- игровое состояние от клиента ----
      case 'input': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent) break;
        // принимаем только позицию и флаги
        if (typeof msg.x === 'number') ent.x = msg.x;
        if (typeof msg.y === 'number') ent.y = msg.y;
        if (typeof msg.fx === 'number') ent.fx = msg.fx;
        if (typeof msg.fy === 'number') ent.fy = msg.fy;
        if (typeof msg.disguised === 'boolean') ent.disguised = msg.disguised;
        if (msg.disguiseColor) ent.disguiseColor = msg.disguiseColor;
        break;
      }

      case 'shoot': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent || ent.role !== 'hunter' || ent.shootCd > 0) break;
        ent.shootCd = 0.3;
        ent.shootFlash = 0.12;
        const dx = msg.dx, dy = msg.dy;
        const len = Math.hypot(dx, dy) || 1;
        lobby.game.projectiles.push({
          x: ent.x + dx / len * 16,
          y: ent.y + dy / len * 16,
          z: 32,
          vx: dx / len * 620,
          vy: dy / len * 620,
          life: 0.95,
          owner: ent.id
        });
        break;
      }

      // ---- отладка: смена роли (только локально на сервере) ----
      case 'debugSetRole': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        if (lobby.hostId !== client.id) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent) break;
        ent.role = msg.role === 'hunter' ? 'hunter' : 'hider';
        ent.disguised = false;
        break;
      }

      case 'leaveGame': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || !lobby.game) break;
        // просто вернём в лобби
        lobby.state = 'lobby';
        lobby.game = null;
        broadcastToLobby(lobby.id, { type: 'backToLobby', lobby: lobbySummary(lobby) });
        broadcastLobbyList();
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveLobby(ws, client);
    clients.delete(ws);
    broadcastLobbyList();
  });
});

function leaveLobby(ws, client) {
  if (!client.lobbyId) return;
  const lobby = lobbies.get(client.lobbyId);
  if (!lobby) { client.lobbyId = null; return; }

  lobby.players = lobby.players.filter(p => p.id !== client.id);

  if (lobby.players.length === 0) {
    lobbies.delete(lobby.id);
  } else {
    if (lobby.hostId === client.id) {
      lobby.hostId = lobby.players[0].id;
    }
    broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
  }

  client.lobbyId = null;
  broadcastLobbyList();
}

// ---------- игровая логика сервера ----------
const CELL = 48;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const BLOCK_COLORS = [
  { top: '#e2695f', side1: '#b34c44', side2: '#8f3b34' },
  { top: '#5f8fe2', side1: '#4470b3', side2: '#34568f' },
  { top: '#6ec06a', side1: '#4f9a4c', side2: '#3d7a3a' },
  { top: '#e8c95a', side1: '#c0a340', side2: '#9a8232' },
  { top: '#a97de0', side1: '#8660b8', side2: '#684a90' },
  { top: '#5fc7c7', side1: '#459f9f', side2: '#337b7b' }
];

function generateMap(mapMode, seed) {
  const rnd = mulberry32(seed);
  const N = 8;
  const crates = [];
  for (let gx = -N; gx <= N; gx++) {
    for (let gy = -N; gy <= N; gy++) {
      if (rnd() < 0.884) continue;
      const x = gx * CELL + (rnd() - 0.5) * 12;
      const y = gy * CELL + (rnd() - 0.5) * 12;
      if (Math.hypot(x, y) < 95) continue;
      const hw = 18 + rnd() * 4;
      const hd = 18 + rnd() * 4;
      const h = 28 + rnd() * 34;
      let ok = true;
      for (const c of crates) {
        if (Math.abs(c.x - x) < c.hw + hw + 4 && Math.abs(c.y - y) < c.hd + hd + 4) { ok = false; break; }
      }
      if (!ok) continue;
      const col = BLOCK_COLORS[Math.floor(rnd() * BLOCK_COLORS.length)];
      crates.push({ x, y, hw, hd, h, top: col.top, side1: col.side1, side2: col.side2 });
    }
  }
  return { R: N * CELL + 66, crates };
}

function randomFreeSpot(map) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 130 + Math.random() * 260;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    let inside = false;
    for (const c of map.crates) {
      if (Math.abs(c.x - x) < c.hw + 16 && Math.abs(c.y - y) < c.hd + 16) { inside = true; break; }
    }
    if (!inside) return { x, y };
  }
  return { x: 0, y: 200 };
}

// ---------- серверный тик ----------
const TICK_MS = 1000 / 30; // 30 Hz

setInterval(() => {
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    if (lobby.state !== 'game' || !lobby.game) continue;
    const g = lobby.game;
    const dt = TICK_MS / 1000;

    if (!g.over) {
      // боты-прячущиеся
      for (const e of g.entities) {
        if (!e.isBot) continue;

        if (e.role === 'hider') {
          if (e.disguised) {
            e.hideTimer -= dt;
            if (e.hideTimer <= 0) {
              e.disguised = false;
              e.disguiseColor = null;
              pickWander(e, g);
            }
          } else {
            botWander(e, g, dt, 0.8);
            // попытка спрятаться рядом с блоком
            const c = findNearCrate(g, e.x, e.y, 70);
            if (c && Math.random() < dt * 0.9) {
              e.disguised = true;
              e.disguiseColor = c.top;
              e.hideTimer = 4 + Math.random() * 6;
            }
          }
        } else {
          // бот-охотник
          botWander(e, g, dt, 0.75);
          e.shootTimer -= dt;
          if (e.shootTimer <= 0) {
            e.shootTimer = 2.6 + Math.random() * 2.8;
            let target = null, bd = 1e9;
            for (const o of g.entities) {
              if (o === e || o.role !== 'hider' || o.disguised) continue;
              const d = Math.hypot(o.x - e.x, o.y - e.y);
              if (d < 260 && d < bd) { bd = d; target = o; }
            }
            let dx, dy;
            if (target && Math.random() < 0.45) {
              dx = target.x - e.x; dy = target.y - e.y;
            } else {
              const a = Math.random() * Math.PI * 2;
              dx = Math.cos(a); dy = Math.sin(a);
            }
            const len = Math.hypot(dx, dy) || 1;
            e.fx = dx / len; e.fy = dy / len;
            g.projectiles.push({
              x: e.x + dx / len * 16,
              y: e.y + dy / len * 16,
              z: 32,
              vx: dx / len * 620,
              vy: dy / len * 620,
              life: 0.95,
              owner: e.id
            });
            e.shootFlash = 0.12;
          }
        }
      }

      // кулдауны
      for (const e of g.entities) {
        if (e.shootCd > 0) e.shootCd -= dt;
        if (e.shootFlash > 0) e.shootFlash -= dt;
      }

      // снаряды
      for (let i = g.projectiles.length - 1; i >= 0; i--) {
        const p = g.projectiles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
        if (p.life <= 0) { g.projectiles.splice(i, 1); continue; }

        let hit = null;
        for (const e of g.entities) {
          if (e.id === p.owner || e.role !== 'hider') continue;
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy < (13 + 9) * (13 + 9)) { hit = e; break; }
        }
        if (hit) {
          hit.role = 'hunter';
          hit.disguised = false;
          hit.disguiseColor = null;
          hit.shootCd = 1.2;
          g.effects.push({ x: hit.x, y: hit.y, z: 34, t: 0, max: 0.5 });
          g.toasts.push({ x: hit.x, y: hit.y, z: 58, text: 'Найден!', life: 1.4, color: '#ff9d94' });
          g.projectiles.splice(i, 1);
        }
      }

      // эффекты
      for (let i = g.effects.length - 1; i >= 0; i--) {
        g.effects[i].t += dt;
        if (g.effects[i].t > g.effects[i].max) g.effects.splice(i, 1);
      }
      for (let i = g.toasts.length - 1; i >= 0; i--) {
        const t = g.toasts[i];
        t.life -= dt;
        t.z += dt * 26;
        if (t.life <= 0) g.toasts.splice(i, 1);
      }

      g.time += dt;

      // победа
      const hiders = g.entities.filter(e => e.role === 'hider').length;
      if (hiders === 0) { g.over = true; g.overTime = 0; }
    } else {
      g.overTime += dt;
    }

    // отправка снапшота
    broadcastToLobby(lobby.id, {
      type: 'state',
      entities: g.entities.map(e => ({
        id: e.id,
        role: e.role,
        x: e.x,
        y: e.y,
        fx: e.fx,
        fy: e.fy,
        disguised: !!e.disguised,
        disguiseColor: e.disguiseColor,
        shootFlash: e.shootFlash
      })),
      projectiles: g.projectiles,
      effects: g.effects,
      toasts: g.toasts,
      time: g.time,
      over: g.over,
      overTime: g.overTime
    });
  }
}, TICK_MS);

function pickWander(e, g) {
  const a = Math.random() * Math.PI * 2;
  const r = 90 + Math.random() * (g.R - 110);
  e.tx = Math.cos(a) * r;
  e.ty = Math.sin(a) * r;
  e.wanderTimer = 4 + Math.random() * 4;
}

function botWander(e, g, dt, speedMul) {
  const d = Math.hypot(e.tx - e.x, e.ty - e.y);
  if (d < 20 || e.wanderTimer <= 0) {
    pickWander(e, g);
  }
  e.wanderTimer -= dt;

  const dx = e.tx - e.x, dy = e.ty - e.y;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    const sp = 140 * speedMul;
    e.x += dx / len * sp * dt;
    e.y += dy / len * sp * dt;
    e.fx = dx / len; e.fy = dy / len;
  }

  // коллизии с блоками
  collideWithCrates(e, g.crates);
  e.x = Math.max(-g.R + 16, Math.min(g.R - 16, e.x));
  e.y = Math.max(-g.R + 16, Math.min(g.R - 16, e.y));
}

function collideWithCrates(p, crates) {
  for (const b of crates) {
    const cx = Math.max(b.x - b.hw, Math.min(p.x, b.x + b.hw));
    const cy = Math.max(b.y - b.hd, Math.min(p.y, b.y + b.hd));
    const dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    const r = 13;
    if (d2 < r * r) {
      if (d2 < 1e-8) {
        p.x = b.x + b.hw + r;
      } else {
        const d = Math.sqrt(d2);
        p.x += dx / d * (r - d);
        p.y += dy / d * (r - d);
      }
    }
  }
}

function findNearCrate(g, x, y, baseReach) {
  let best = null, bd = 1e9;
  for (const c of g.crates) {
    const d = Math.hypot(c.x - x, c.y - y);
    const reach = Math.max(c.hw, c.hd) + baseReach;
    if (d < reach && d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------- старт ----------
server.listen(PORT, () => {
  console.log(`blockhide сервер запущен: http://localhost:${PORT}`);
});