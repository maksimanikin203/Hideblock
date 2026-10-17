const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));

const clients = new Map();
const lobbies = new Map();
let lobbyCounter = 0;

const TICK_MS = 1000 / 30;
const ROULETTE_MS = 3000;
const PREP_MS = 20000;
const MAIN_MS = 120000;
const POST_GAME_MS = 5000;

const PREP_SPAWN_X = -2700;
const PREP_SPAWN_Y = 400;

function makeId(prefix = 'id_') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function makeLobby(hostId, hostName) {
  lobbyCounter++;
  const id = 'lobby_' + lobbyCounter;
  const lobby = {
    id, name: 'Лобби ' + lobbyCounter, hostId,
    players: [{ id: hostId, name: hostName, x: 450, y: 546, moving: false, hat: 'none', clothes: 'none' }],
    settings: { mapMode: 'test1', hunter: 'random', debug: false, playerCount: 4 },
    state: 'lobby', game: null,
    seed: Math.floor(Math.random() * 1e9)
  };
  lobbies.set(id, lobby);
  return lobby;
}

function lobbySummary(l) {
  return {
    id: l.id, name: l.name, hostId: l.hostId,
    players: l.players.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, moving: p.moving, hat: p.hat, clothes: p.clothes })),
    settings: l.settings, state: l.state
  };
}

function broadcastLobbyList() {
  const list = Array.from(lobbies.values()).map(lobbySummary);
  const msg = JSON.stringify({ type: 'lobbyList', lobbies: list });
  for (const [ws, c] of clients) {
    if (c.lobbyId === null && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToLobby(lobbyId, msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.lobbyId === lobbyId && ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  const client = { id: makeId('p_'), name: 'Игрок', lobbyId: null, cosmetics: { hat: 'none', clothes: 'none' } };
  clients.set(ws, client);
  send(ws, { type: 'welcome', id: client.id });
  send(ws, { type: 'lobbyList', lobbies: Array.from(lobbies.values()).map(lobbySummary) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'setName': {
        if (typeof msg.name === 'string' && msg.name.trim()) client.name = msg.name.trim().slice(0, 20);
        break;
      }
      case 'setCosmetics': {
        if (msg.cosmetics && typeof msg.cosmetics === 'object') {
          if (typeof msg.cosmetics.hat === 'string') client.cosmetics.hat = msg.cosmetics.hat;
          if (typeof msg.cosmetics.clothes === 'string') client.cosmetics.clothes = msg.cosmetics.clothes;
          const lobby = lobbies.get(client.lobbyId);
          if (lobby) {
            const pl = lobby.players.find(p => p.id === client.id);
            if (pl) { pl.hat = client.cosmetics.hat; pl.clothes = client.cosmetics.clothes; }
            broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
          }
        }
        break;
      }
      case 'createLobby': {
        if (client.lobbyId) leaveLobby(ws, client);
        const lobby = makeLobby(client.id, client.name);
        const me = lobby.players[0];
        me.hat = client.cosmetics.hat; me.clothes = client.cosmetics.clothes;
        client.lobbyId = lobby.id;
        send(ws, { type: 'lobbyJoined', lobby: lobbySummary(lobby), youId: client.id });
        broadcastLobbyList();
        broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
        break;
      }
      case 'joinLobby': {
        const lobby = lobbies.get(msg.lobbyId);
        if (!lobby) { send(ws, { type: 'error', text: 'Лобби не найдено' }); break; }
        if (lobby.state !== 'lobby') { send(ws, { type: 'error', text: 'Игра уже идёт' }); break; }
        if (lobby.players.length >= lobby.settings.playerCount) { send(ws, { type: 'error', text: 'Лобби заполнено' }); break; }
        if (client.lobbyId) leaveLobby(ws, client);
        client.lobbyId = lobby.id;
        lobby.players.push({ id: client.id, name: client.name, x: 450, y: 546, moving: false, hat: client.cosmetics.hat, clothes: client.cosmetics.clothes });
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
      case 'lobbyMove': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'lobby') break;
        const pl = lobby.players.find(p => p.id === client.id);
        if (!pl) break;
        if (typeof msg.x === 'number') pl.x = msg.x;
        if (typeof msg.y === 'number') pl.y = msg.y;
        if (typeof msg.moving === 'boolean') pl.moving = msg.moving;
        broadcastToLobby(lobby.id, { type: 'lobbyPositions',
          positions: lobby.players.map(p => ({ id: p.id, x: p.x, y: p.y, moving: p.moving })) }, ws);
        break;
      }
      case 'updateSettings': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id || lobby.state !== 'lobby') break;
        const s = msg.settings || {};
        if (typeof s.mapMode === 'string') lobby.settings.mapMode = s.mapMode;
        if (typeof s.hunter === 'string') lobby.settings.hunter = s.hunter;
        if (typeof s.debug === 'boolean') lobby.settings.debug = s.debug;
        if (typeof s.playerCount === 'number') lobby.settings.playerCount = Math.max(1, Math.min(4, Math.floor(s.playerCount)));
        broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
        broadcastLobbyList();
        break;
      }
      case 'startGame': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id || lobby.state !== 'lobby') break;
        const n = lobby.players.length;
        if (n < 2) { send(ws, { type: 'error', text: 'Нужно минимум 2 игрока' }); break; }

        let hunterSlot;
        if (lobby.settings.hunter === 'random') hunterSlot = 1 + Math.floor(Math.random() * n);
        else {
          const idx = parseInt(lobby.settings.hunter.replace('slot', ''), 10);
          hunterSlot = (idx >= 1 && idx <= n) ? idx : 1;
        }
        const hunterId = lobby.players[hunterSlot - 1].id;
        lobby.state = 'starting';

        broadcastToLobby(lobby.id, { type: 'roulette',
          names: lobby.players.map(p => p.name),
          ids: lobby.players.map(p => p.id),
          hunterId, duration: ROULETTE_MS });

        setTimeout(() => {
          const l = lobbies.get(lobby.id);
          if (!l || l.state !== 'starting') return;
          const map = generateMap(l.settings.mapMode, l.seed);
          const entities = l.players.map((p, i) => {
            const isHunter = (i + 1) === hunterSlot;
            let px, py;
            if (isHunter) { px = PREP_SPAWN_X; py = PREP_SPAWN_Y; }
            else {
              const pos = randomFreeSpot({ crates: map.crates, R: map.R });
              px = pos.x; py = pos.y;
            }
            return {
              id: p.id, role: isHunter ? 'hunter' : 'hider',
              x: px, y: py, fx: 1, fy: 0,
              disguised: false, disguiseColor: null,
              shootCd: 0, shootFlash: 0,
              hat: p.hat || 'none', clothes: p.clothes || 'none',
            };
          });
          l.state = 'game';
          l.game = {
            R: map.R, crates: map.crates, entities,
            projectiles: [], effects: [], toasts: [],
            time: 0, over: false, overTime: 0,
            phase: 'prep',
            prepEndsAt: Date.now() + PREP_MS,
            mainEndsAt: 0,
            winners: [],
            transitioning: false,
          };
          for (const [cws, c] of clients) {
            if (c.lobbyId === l.id) {
              send(cws, { type: 'gameStart',
                game: {
                  R: map.R, crates: map.crates,
                  entities: entities.map(e => ({ ...e })),
                  phase: 'prep',
                  prepEndsAt: l.game.prepEndsAt,
                },
                youId: c.id });
            }
          }
          broadcastLobbyList();
        }, ROULETTE_MS);
        break;
      }
      case 'input': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent) break;
        if (typeof msg.x === 'number') ent.x = msg.x;
        if (typeof msg.y === 'number') ent.y = msg.y;
        if (typeof msg.fx === 'number') ent.fx = msg.fx;
        if (typeof msg.fy === 'number') ent.fy = msg.fy;
        if (typeof msg.disguised === 'boolean') ent.disguised = msg.disguised;
        if (msg.disguiseColor !== undefined) ent.disguiseColor = msg.disguiseColor;
        break;
      }
      case 'shoot': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        if (lobby.game.phase !== 'main' || lobby.game.over) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent || ent.role !== 'hunter' || ent.shootCd > 0) break;
        ent.shootCd = 0.3; ent.shootFlash = 0.12;
        const dx = msg.dx, dy = msg.dy;
        const len = Math.hypot(dx, dy) || 1;
        lobby.game.projectiles.push({
          x: ent.x + dx / len * 16, y: ent.y + dy / len * 16, z: 32,
          vx: dx / len * 620, vy: dy / len * 620, life: 0.95, owner: ent.id
        });
        break;
      }
      case 'debugSetRole': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game || lobby.hostId !== client.id) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent) break;
        ent.role = msg.role === 'hunter' ? 'hunter' : 'hider';
        ent.disguised = false; ent.disguiseColor = null;
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
  if (lobby.game) {
    lobby.game.entities = lobby.game.entities.filter(e => e.id !== client.id);
    if (!lobby.game.over) {
      const hiders = lobby.game.entities.filter(e => e.role === 'hider').length;
      if (hiders === 0) {
        lobby.game.over = true;
        lobby.game.overTime = 0;
        lobby.game.winners = lobby.game.entities.filter(e => e.role === 'hunter').map(e => e.id);
        broadcastToLobby(lobby.id, { type: 'matchEnd', winners: lobby.game.winners });
      }
    }
  }
  if (lobby.players.length === 0) lobbies.delete(lobby.id);
  else {
    if (lobby.hostId === client.id) lobby.hostId = lobby.players[0].id;
    broadcastToLobby(lobby.id, { type: 'lobbyUpdate', lobby: lobbySummary(lobby) });
  }
  client.lobbyId = null;
  broadcastLobbyList();
}

setInterval(() => {
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    if (lobby.state !== 'game' || !lobby.game) continue;
    const g = lobby.game;
    const dt = TICK_MS / 1000;

    // prep → main
    if (g.phase === 'prep' && now >= g.prepEndsAt) {
      for (const e of g.entities) {
        if (e.role === 'hunter') {
          const pos = randomFreeSpot({ crates: g.crates, R: g.R });
          e.x = pos.x; e.y = pos.y;
        }
      }
      g.phase = 'main';
      g.mainEndsAt = Date.now() + MAIN_MS;
      broadcastToLobby(lobby.id, { type: 'phaseChange', phase: 'main' });
    }

    if (g.phase === 'main' && !g.over) {
      // timer → hiders win
      if (Date.now() >= g.mainEndsAt) {
        g.over = true; g.overTime = 0;
        g.winners = g.entities.filter(e => e.role === 'hider').map(e => e.id);
        if (g.winners.length === 0) g.winners = g.entities.map(e => e.id);
        broadcastToLobby(lobby.id, { type: 'matchEnd', winners: g.winners });
      } else {
        // cooldowns, projectiles, effects, toasts
        for (const e of g.entities) {
          if (e.shootCd > 0) e.shootCd -= dt;
          if (e.shootFlash > 0) e.shootFlash -= dt;
        }
        for (let i = g.projectiles.length - 1; i >= 0; i--) {
          const p = g.projectiles[i];
          p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
          if (p.life <= 0) { g.projectiles.splice(i, 1); continue; }
          let hit = null;
          for (const e of g.entities) {
            if (e.id === p.owner || e.role !== 'hider') continue;
            const dx = e.x - p.x, dy = e.y - p.y;
            if (dx * dx + dy * dy < (13 + 9) * (13 + 9)) { hit = e; break; }
          }
          if (hit) {
            hit.role = 'hunter'; hit.disguised = false; hit.disguiseColor = null; hit.shootCd = 1.2;
            g.effects.push({ x: hit.x, y: hit.y, z: 34, t: 0, max: 0.5 });
            g.toasts.push({ x: hit.x, y: hit.y, z: 58, text: 'Найден!', life: 1.4, color: '#ff9d94' });
            g.projectiles.splice(i, 1);
          }
        }
        for (let i = g.effects.length - 1; i >= 0; i--) {
          g.effects[i].t += dt;
          if (g.effects[i].t > g.effects[i].max) g.effects.splice(i, 1);
        }
        for (let i = g.toasts.length - 1; i >= 0; i--) {
          const t = g.toasts[i]; t.life -= dt; t.z += dt * 26;
          if (t.life <= 0) g.toasts.splice(i, 1);
        }
        g.time += dt;
        const hiders = g.entities.filter(e => e.role === 'hider').length;
        if (hiders === 0) {
          g.over = true; g.overTime = 0;
          g.winners = g.entities.filter(e => e.role === 'hunter').map(e => e.id);
          broadcastToLobby(lobby.id, { type: 'matchEnd', winners: g.winners });
        }
      }
    } else if (g.over) {
      g.overTime += dt;
      if (g.overTime > POST_GAME_MS / 1000 && !g.transitioning) {
        g.transitioning = true;
        lobby.state = 'lobby';
        lobby.game = null;
        for (const p of lobby.players) {
          p.x = 450 + (Math.random() - 0.5) * 120;
          p.y = 546 + (Math.random() - 0.5) * 120;
          p.moving = false;
        }
        broadcastToLobby(lobby.id, { type: 'backToLobby', lobby: lobbySummary(lobby) });
        broadcastLobbyList();
        continue;
      }
    }

    broadcastToLobby(lobby.id, {
      type: 'state', phase: g.phase,
      entities: g.entities.map(e => ({
        id: e.id, role: e.role, x: e.x, y: e.y, fx: e.fx, fy: e.fy,
        disguised: !!e.disguised, disguiseColor: e.disguiseColor, shootFlash: e.shootFlash,
        hat: e.hat || 'none', clothes: e.clothes || 'none',
      })),
      projectiles: g.projectiles, effects: g.effects, toasts: g.toasts,
      time: g.time, over: g.over, overTime: g.overTime,
    });
  }
}, TICK_MS);

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
  { top:'#e2695f', side1:'#b34c44', side2:'#8f3b34' },
  { top:'#5f8fe2', side1:'#4470b3', side2:'#34568f' },
  { top:'#6ec06a', side1:'#4f9a4c', side2:'#3d7a3a' },
  { top:'#e8c95a', side1:'#c0a340', side2:'#9a8232' },
  { top:'#a97de0', side1:'#8660b8', side2:'#684a90' },
  { top:'#5fc7c7', side1:'#459f9f', side2:'#337b7b' },
];
function generateMap(mapMode, seed) {
  const rnd = mulberry32(seed);
  const N = 8, crates = [];
  for (let gx = -N; gx <= N; gx++) for (let gy = -N; gy <= N; gy++) {
    if (rnd() < 0.884) continue;
    const x = gx * CELL + (rnd() - 0.5) * 12;
    const y = gy * CELL + (rnd() - 0.5) * 12;
    if (Math.hypot(x, y) < 95) continue;
    const hw = 18 + rnd() * 4, hd = 18 + rnd() * 4, h = 28 + rnd() * 34;
    let ok = true;
    for (const c of crates) {
      if (Math.abs(c.x - x) < c.hw + hw + 4 && Math.abs(c.y - y) < c.hd + hd + 4) { ok = false; break; }
    }
    if (!ok) continue;
    const col = BLOCK_COLORS[Math.floor(rnd() * BLOCK_COLORS.length)];
    crates.push({ x, y, hw, hd, h, top: col.top, side1: col.side1, side2: col.side2 });
  }
  return { R: N * CELL + 66, crates };
}
function randomFreeSpot(map) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 130 + Math.random() * 260;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    let inside = false;
    for (const c of map.crates) {
      if (Math.abs(c.x - x) < c.hw + 16 && Math.abs(c.y - y) < c.hd + 16) { inside = true; break; }
    }
    if (!inside) return { x, y };
  }
  return { x: 0, y: 200 };
}

server.listen(PORT, () => console.log(`blockhide сервер: http://localhost:${PORT}`));
