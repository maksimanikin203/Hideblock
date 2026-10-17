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

const CELL = 48;
const TICK_MS = 1000 / 30;
const ROULETTE_MS = 3000;
const PREP_MS = 20000;
const MAIN_MS = 120000;
const POST_GAME_MS = 5000;

/* ===== object definitions ===== */
const OBJECT_DEFS = {
  block_red:    { w:1, d:1, h:30, solid:true, disguise:true },
  block_blue:   { w:1, d:1, h:30, solid:true, disguise:true },
  block_green:  { w:1, d:1, h:30, solid:true, disguise:true },
  block_yellow: { w:1, d:1, h:30, solid:true, disguise:true },
  block_purple: { w:1, d:1, h:30, solid:true, disguise:true },
  block_cyan:   { w:1, d:1, h:30, solid:true, disguise:true },
  barrel:  { w:1, d:1, h:42, solid:true,  disguise:true },
  box:     { w:1, d:1, h:32, solid:true,  disguise:true },
  stone:   { w:1, d:1, h:72, solid:true,  disguise:true },
  glass:   { w:1, d:1, h:52, solid:true,  disguise:true, transparent:true },
  wood:    { w:2, d:2, h:120, solid:false, disguise:false },
  grass:   { w:1, d:1, h:16, solid:false, disguise:false },
  pumpkin: { w:1, d:1, h:26, solid:false, disguise:true },
  fence:   { w:1, d:1, h:42, solid:true,  disguise:true },
  house:   { w:3, d:3, h:120, solid:true,  disguise:false },
  truck:   { w:3, d:2, h:60, solid:true,  disguise:false },
  car:     { w:2, d:2, h:44, solid:true,  disguise:false },
  stump:   { w:1, d:1, h:18, solid:false, disguise:true },
};

/* ===== map registry ===== */
function makeLasertag() {
  const rnd = mulberry32(2024);
  const W = 30, H = 30;
  const objects = [];
  const blockTypes = ['block_red', 'block_blue', 'block_green', 'block_yellow', 'block_purple', 'block_cyan'];
  for (let x = 2; x < W - 2; x += 3) {
    for (let y = 2; y < H - 2; y += 3) {
      if (rnd() < 0.55) continue;
      if (Math.abs(x - 15) < 4 && Math.abs(y - 15) < 4) continue;
      const t = blockTypes[Math.floor(rnd() * blockTypes.length)];
      objects.push({ x, y, type: t });
    }
  }
  for (let i = 0; i < 20; i++) {
    const x = 3 + Math.floor(rnd() * (W - 6));
    const y = 3 + Math.floor(rnd() * (H - 6));
    if (objects.some(o => o.x === x && o.y === y)) continue;
    objects.push({ x, y, type: 'barrel' });
  }
  return { name: 'Лазертаг', width: W, height: H, theme: 'black', objects };
}

const MAPS = {
  lasertag: makeLasertag(),
  village: {
    name: 'Деревня', width: 30, height: 30, theme: 'grass',
    objects: [{"x":8,"y":16,"type":"barrel"},{"x":8,"y":15,"type":"box"},{"x":8,"y":14,"type":"box"},{"x":9,"y":14,"type":"box"},{"x":8,"y":13,"type":"stone"},{"x":9,"y":13,"type":"stone"},{"x":13,"y":17,"type":"wood"},{"x":14,"y":16,"type":"grass"},{"x":13,"y":15,"type":"grass"},{"x":14,"y":15,"type":"grass"},{"x":20,"y":10,"type":"pumpkin"},{"x":20,"y":12,"type":"pumpkin"},{"x":18,"y":12,"type":"pumpkin"},{"x":18,"y":11,"type":"pumpkin"},{"x":20,"y":11,"type":"pumpkin"},{"x":17,"y":12,"type":"box"},{"x":16,"y":12,"type":"box"},{"x":15,"y":12,"type":"box"},{"x":15,"y":11,"type":"box"},{"x":15,"y":10,"type":"box"},{"x":16,"y":10,"type":"box"},{"x":16,"y":11,"type":"box"},{"x":17,"y":11,"type":"box"},{"x":16,"y":9,"type":"stone"},{"x":17,"y":9,"type":"stone"},{"x":15,"y":9,"type":"stone"},{"x":21,"y":17,"type":"wood"},{"x":15,"y":23,"type":"wood"},{"x":14,"y":19,"type":"wood"},{"x":17,"y":20,"type":"wood"},{"x":17,"y":17,"type":"wood"},{"x":20,"y":20,"type":"wood"},{"x":19,"y":24,"type":"wood"},{"x":8,"y":17,"type":"barrel"},{"x":16,"y":21,"type":"grass"},{"x":15,"y":21,"type":"grass"},{"x":15,"y":22,"type":"grass"},{"x":16,"y":22,"type":"grass"},{"x":20,"y":18,"type":"grass"},{"x":19,"y":18,"type":"grass"},{"x":8,"y":12,"type":"fence"},{"x":9,"y":12,"type":"fence"},{"x":17,"y":8,"type":"fence"},{"x":16,"y":8,"type":"fence"},{"x":15,"y":8,"type":"fence"},{"x":14,"y":8,"type":"fence"},{"x":3,"y":4,"type":"wood"},{"x":5,"y":4,"type":"wood"},{"x":3,"y":7,"type":"wood"},{"x":5,"y":6,"type":"wood"},{"x":7,"y":5,"type":"wood"},{"x":5,"y":8,"type":"wood"},{"x":1,"y":8,"type":"wood"},{"x":3,"y":9,"type":"wood"},{"x":6,"y":10,"type":"wood"},{"x":7,"y":8,"type":"wood"},{"x":10,"y":13,"type":"pumpkin"},{"x":2,"y":17,"type":"stone"},{"x":2,"y":18,"type":"stone"},{"x":2,"y":19,"type":"stone"},{"x":3,"y":20,"type":"pumpkin"},{"x":4,"y":20,"type":"pumpkin"},{"x":5,"y":18,"type":"pumpkin"},{"x":4,"y":19,"type":"grass"},{"x":3,"y":19,"type":"grass"},{"x":3,"y":18,"type":"grass"},{"x":4,"y":18,"type":"grass"},{"x":3,"y":17,"type":"grass"},{"x":4,"y":17,"type":"grass"},{"x":19,"y":4,"type":"wood"},{"x":21,"y":4,"type":"wood"},{"x":22,"y":6,"type":"wood"},{"x":5,"y":23,"type":"fence"},{"x":6,"y":23,"type":"fence"},{"x":7,"y":23,"type":"fence"},{"x":26,"y":11,"type":"wood"},{"x":26,"y":13,"type":"wood"},{"x":28,"y":11,"type":"wood"},{"x":11,"y":6,"type":"stone"},{"x":11,"y":5,"type":"stone"},{"x":12,"y":5,"type":"box"},{"x":25,"y":3,"type":"box"},{"x":25,"y":2,"type":"box"},{"x":26,"y":2,"type":"stone"},{"x":2,"y":16,"type":"box"},{"x":2,"y":20,"type":"box"},{"x":11,"y":25,"type":"wood"},{"x":8,"y":26,"type":"wood"},{"x":3,"y":26,"type":"wood"},{"x":1,"y":23,"type":"wood"},{"x":10,"y":20,"type":"wood"},{"x":4,"y":12,"type":"wood"},{"x":12,"y":23,"type":"wood"},{"x":14,"y":26,"type":"wood"},{"x":17,"y":25,"type":"wood"},{"x":6,"y":27,"type":"grass"},{"x":4,"y":25,"type":"grass"},{"x":3,"y":24,"type":"grass"},{"x":1,"y":25,"type":"grass"},{"x":2,"y":26,"type":"grass"},{"x":4,"y":28,"type":"grass"},{"x":8,"y":28,"type":"grass"},{"x":9,"y":28,"type":"grass"},{"x":10,"y":27,"type":"grass"},{"x":9,"y":25,"type":"grass"},{"x":9,"y":24,"type":"grass"},{"x":9,"y":22,"type":"grass"},{"x":7,"y":20,"type":"grass"},{"x":6,"y":19,"type":"grass"},{"x":7,"y":16,"type":"grass"},{"x":2,"y":11,"type":"grass"},{"x":2,"y":10,"type":"grass"},{"x":4,"y":11,"type":"grass"},{"x":10,"y":10,"type":"grass"},{"x":13,"y":11,"type":"grass"},{"x":14,"y":13,"type":"grass"},{"x":5,"y":14,"type":"grass"},{"x":3,"y":16,"type":"grass"},{"x":1,"y":14,"type":"grass"},{"x":2,"y":13,"type":"grass"},{"x":9,"y":4,"type":"grass"},{"x":13,"y":4,"type":"grass"},{"x":15,"y":5,"type":"grass"},{"x":14,"y":6,"type":"grass"},{"x":10,"y":7,"type":"grass"},{"x":7,"y":2,"type":"grass"},{"x":5,"y":1,"type":"grass"},{"x":4,"y":1,"type":"grass"},{"x":3,"y":1,"type":"grass"},{"x":1,"y":3,"type":"grass"},{"x":1,"y":4,"type":"grass"},{"x":6,"y":0,"type":"grass"},{"x":9,"y":2,"type":"grass"},{"x":11,"y":3,"type":"grass"},{"x":16,"y":3,"type":"grass"},{"x":18,"y":5,"type":"grass"},{"x":19,"y":6,"type":"grass"},{"x":23,"y":10,"type":"grass"},{"x":23,"y":12,"type":"grass"},{"x":25,"y":16,"type":"grass"},{"x":25,"y":18,"type":"grass"},{"x":28,"y":22,"type":"grass"},{"x":27,"y":23,"type":"grass"},{"x":22,"y":25,"type":"grass"},{"x":24,"y":28,"type":"grass"},{"x":23,"y":28,"type":"grass"},{"x":26,"y":27,"type":"grass"},{"x":24,"y":23,"type":"grass"},{"x":26,"y":19,"type":"grass"},{"x":28,"y":18,"type":"grass"},{"x":28,"y":13,"type":"grass"},{"x":29,"y":10,"type":"grass"},{"x":27,"y":5,"type":"grass"},{"x":24,"y":7,"type":"grass"},{"x":23,"y":13,"type":"grass"},{"x":22,"y":14,"type":"grass"},{"x":20,"y":13,"type":"grass"},{"x":18,"y":14,"type":"grass"},{"x":17,"y":14,"type":"grass"},{"x":21,"y":1,"type":"grass"},{"x":16,"y":2,"type":"grass"},{"x":15,"y":3,"type":"grass"},{"x":23,"y":4,"type":"grass"},{"x":27,"y":6,"type":"grass"},{"x":28,"y":6,"type":"grass"},{"x":29,"y":1,"type":"grass"},{"x":27,"y":1,"type":"grass"},{"x":22,"y":1,"type":"grass"},{"x":19,"y":0,"type":"grass"},{"x":15,"y":0,"type":"grass"},{"x":13,"y":1,"type":"grass"},{"x":11,"y":1,"type":"grass"},{"x":8,"y":0,"type":"grass"},{"x":7,"y":0,"type":"grass"},{"x":7,"y":1,"type":"grass"},{"x":8,"y":2,"type":"grass"},{"x":7,"y":3,"type":"grass"},{"x":9,"y":5,"type":"grass"},{"x":9,"y":6,"type":"grass"},{"x":9,"y":7,"type":"grass"},{"x":9,"y":8,"type":"grass"},{"x":10,"y":8,"type":"grass"}]
  },
  ice: {
    name: 'Ледов', width: 30, height: 30, theme: 'ice',
    objects: [{"x":10,"y":5,"type":"glass"},{"x":11,"y":5,"type":"glass"},{"x":12,"y":5,"type":"glass"},{"x":12,"y":4,"type":"glass"},{"x":13,"y":4,"type":"glass"},{"x":11,"y":4,"type":"glass"},{"x":7,"y":9,"type":"truck"},{"x":13,"y":11,"type":"car"},{"x":6,"y":14,"type":"car"},{"x":3,"y":8,"type":"block_cyan"},{"x":3,"y":9,"type":"block_cyan"},{"x":4,"y":8,"type":"block_cyan"},{"x":3,"y":7,"type":"block_cyan"},{"x":19,"y":11,"type":"stone"},{"x":19,"y":12,"type":"stone"},{"x":20,"y":10,"type":"stone"},{"x":19,"y":10,"type":"stone"},{"x":20,"y":11,"type":"glass"},{"x":8,"y":22,"type":"block_blue"},{"x":9,"y":22,"type":"block_blue"},{"x":9,"y":23,"type":"block_blue"},{"x":10,"y":22,"type":"block_cyan"},{"x":9,"y":21,"type":"block_cyan"},{"x":10,"y":21,"type":"block_cyan"},{"x":22,"y":21,"type":"block_cyan"},{"x":22,"y":19,"type":"block_cyan"},{"x":22,"y":20,"type":"block_cyan"},{"x":23,"y":20,"type":"block_cyan"},{"x":14,"y":21,"type":"block_blue"},{"x":14,"y":20,"type":"block_blue"},{"x":15,"y":19,"type":"block_blue"},{"x":14,"y":18,"type":"block_blue"},{"x":14,"y":19,"type":"block_blue"},{"x":15,"y":18,"type":"block_blue"},{"x":14,"y":17,"type":"block_blue"},{"x":26,"y":7,"type":"block_cyan"},{"x":25,"y":5,"type":"block_cyan"},{"x":24,"y":3,"type":"block_cyan"},{"x":25,"y":6,"type":"block_blue"},{"x":24,"y":4,"type":"block_blue"},{"x":26,"y":8,"type":"block_blue"},{"x":24,"y":2,"type":"block_blue"},{"x":26,"y":9,"type":"block_cyan"},{"x":4,"y":9,"type":"glass"},{"x":4,"y":7,"type":"glass"},{"x":2,"y":7,"type":"glass"},{"x":1,"y":8,"type":"glass"},{"x":1,"y":7,"type":"glass"},{"x":2,"y":8,"type":"glass"},{"x":14,"y":24,"type":"glass"},{"x":15,"y":24,"type":"glass"},{"x":15,"y":25,"type":"glass"},{"x":13,"y":25,"type":"glass"},{"x":14,"y":25,"type":"glass"},{"x":17,"y":25,"type":"glass"},{"x":16,"y":25,"type":"glass"},{"x":12,"y":15,"type":"stone"},{"x":11,"y":15,"type":"stone"},{"x":10,"y":14,"type":"stone"},{"x":10,"y":15,"type":"stone"},{"x":3,"y":19,"type":"block_blue"},{"x":3,"y":20,"type":"block_blue"},{"x":4,"y":23,"type":"block_cyan"},{"x":6,"y":25,"type":"block_cyan"},{"x":5,"y":24,"type":"block_cyan"},{"x":4,"y":24,"type":"block_cyan"},{"x":26,"y":19,"type":"stone"},{"x":26,"y":20,"type":"stone"},{"x":22,"y":26,"type":"grass"},{"x":4,"y":3,"type":"grass"},{"x":5,"y":3,"type":"grass"},{"x":26,"y":13,"type":"grass"},{"x":24,"y":12,"type":"grass"},{"x":23,"y":8,"type":"grass"},{"x":10,"y":17,"type":"grass"},{"x":7,"y":17,"type":"grass"},{"x":6,"y":18,"type":"grass"},{"x":3,"y":15,"type":"grass"},{"x":3,"y":13,"type":"grass"},{"x":3,"y":12,"type":"grass"},{"x":6,"y":11,"type":"grass"},{"x":16,"y":14,"type":"grass"},{"x":17,"y":14,"type":"grass"},{"x":19,"y":18,"type":"grass"},{"x":17,"y":20,"type":"grass"},{"x":11,"y":22,"type":"grass"},{"x":12,"y":19,"type":"grass"},{"x":8,"y":25,"type":"grass"},{"x":6,"y":22,"type":"grass"},{"x":3,"y":26,"type":"grass"},{"x":17,"y":18,"type":"pumpkin"},{"x":16,"y":5,"type":"pumpkin"},{"x":7,"y":5,"type":"pumpkin"},{"x":8,"y":18,"type":"pumpkin"},{"x":3,"y":17,"type":"pumpkin"},{"x":24,"y":14,"type":"pumpkin"},{"x":21,"y":23,"type":"pumpkin"},{"x":10,"y":26,"type":"pumpkin"},{"x":5,"y":19,"type":"pumpkin"},{"x":1,"y":25,"type":"pumpkin"},{"x":20,"y":4,"type":"pumpkin"},{"x":16,"y":1,"type":"pumpkin"},{"x":28,"y":4,"type":"pumpkin"},{"x":26,"y":6,"type":"grass"},{"x":26,"y":5,"type":"grass"},{"x":25,"y":4,"type":"grass"},{"x":25,"y":3,"type":"grass"},{"x":19,"y":15,"type":"grass"},{"x":22,"y":16,"type":"grass"},{"x":15,"y":8,"type":"grass"},{"x":12,"y":8,"type":"grass"},{"x":11,"y":8,"type":"grass"},{"x":25,"y":23,"type":"truck"},{"x":10,"y":16,"type":"barrel"},{"x":11,"y":16,"type":"barrel"},{"x":11,"y":6,"type":"barrel"},{"x":12,"y":6,"type":"barrel"},{"x":24,"y":5,"type":"barrel"},{"x":24,"y":6,"type":"barrel"},{"x":14,"y":26,"type":"barrel"},{"x":15,"y":27,"type":"barrel"},{"x":14,"y":27,"type":"barrel"},{"x":23,"y":21,"type":"barrel"},{"x":21,"y":19,"type":"barrel"},{"x":21,"y":20,"type":"barrel"}]
  }
};

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function buildCrates(mapId, removePercent) {
  const map = MAPS[mapId] || MAPS.lasertag;
  let objects = map.objects.slice();
  if (removePercent > 0 && objects.length > 0) {
    const toRemove = Math.floor(objects.length * removePercent / 100);
    for (let i = objects.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [objects[i], objects[j]] = [objects[j], objects[i]];
    }
    objects = objects.slice(toRemove);
  }
  const crates = [];
  for (const o of objects) {
    const def = OBJECT_DEFS[o.type];
    if (!def) continue;
    crates.push({
      type: o.type,
      x: o.x * CELL + def.w * CELL / 2,
      y: o.y * CELL + def.d * CELL / 2,
      hw: def.w * CELL / 2,
      hd: def.d * CELL / 2,
      h: def.h,
      solid: !!def.solid,
      transparent: !!def.transparent,
      disguise: !!def.disguise,
    });
  }
  return {
    crates,
    width: map.width,
    height: map.height,
    theme: map.theme,
    name: map.name,
  };
}

function randomFreeSpot(mapW, mapH, crates) {
  const W = mapW * CELL, H = mapH * CELL;
  for (let i = 0; i < 100; i++) {
    const x = CELL + Math.random() * (W - 2 * CELL);
    const y = CELL + Math.random() * (H - 2 * CELL);
    let free = true;
    for (const c of crates) {
      if (!c.solid) continue;
      if (Math.abs(x - c.x) < c.hw + 16 && Math.abs(y - c.y) < c.hd + 16) {
        free = false; break;
      }
    }
    if (free) return { x, y };
  }
  return { x: W / 2, y: H / 2 };
}

function makeId(prefix = 'id_') { return prefix + crypto.randomBytes(6).toString('hex'); }

function makeLobby(hostId, hostName) {
  lobbyCounter++;
  const id = 'lobby_' + lobbyCounter;
  const lobby = {
    id, name: 'Лобби ' + lobbyCounter, hostId,
    players: [{ id: hostId, name: hostName, x: 450, y: 546, moving: false, hat: 'none', clothes: 'none' }],
    settings: {
      mapMode: 'lasertag',
      hunter: 'random',
      debug: false,
      playerCount: 4,
      fovPlayer: 0.75,
      fovHunter: 0.8,
      removePercent: 0,
    },
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

function send(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

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
        lobby.players[0].hat = client.cosmetics.hat;
        lobby.players[0].clothes = client.cosmetics.clothes;
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
        if (typeof s.mapMode === 'string' && MAPS[s.mapMode]) lobby.settings.mapMode = s.mapMode;
        if (typeof s.hunter === 'string') lobby.settings.hunter = s.hunter;
        if (typeof s.debug === 'boolean') lobby.settings.debug = s.debug;
        if (typeof s.playerCount === 'number') lobby.settings.playerCount = Math.max(1, Math.min(4, Math.floor(s.playerCount)));
        if (typeof s.fovPlayer === 'number') lobby.settings.fovPlayer = Math.max(0.5, Math.min(1.0, s.fovPlayer));
        if (typeof s.fovHunter === 'number') lobby.settings.fovHunter = Math.max(0.5, Math.min(1.0, s.fovHunter));
        if (typeof s.removePercent === 'number') lobby.settings.removePercent = Math.max(0, Math.min(50, Math.floor(s.removePercent)));
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
          const mapData = buildCrates(l.settings.mapMode, l.settings.removePercent);
          const mapW = mapData.width, mapH = mapData.height;
          const W = mapW * CELL, H = mapH * CELL;

          const entities = l.players.map((p, i) => {
            const isHunter = (i + 1) === hunterSlot;
            let px, py;
            if (isHunter) { px = 0; py = 0; }
            else {
              const pos = randomFreeSpot(mapW, mapH, mapData.crates);
              px = pos.x; py = pos.y;
            }
            return {
              id: p.id, role: isHunter ? 'hunter' : 'hider',
              x: px, y: py, fx: 1, fy: 0,
              disguised: false, disguiseType: null,
              shootCd: 0, shootFlash: 0,
              hat: p.hat || 'none', clothes: p.clothes || 'none',
            };
          });
          l.state = 'game';
          l.game = {
            mapW, mapH, theme: mapData.theme,
            crates: mapData.crates,
            entities,
            projectiles: [], effects: [], toasts: [],
            time: 0, over: false, overTime: 0,
            phase: 'prep',
            prepEndsAt: Date.now() + PREP_MS,
            mainEndsAt: 0,
            winners: [],
            transitioning: false,
            fovPlayer: l.settings.fovPlayer,
            fovHunter: l.settings.fovHunter,
          };
          for (const [cws, c] of clients) {
            if (c.lobbyId === l.id) {
              send(cws, {
                type: 'gameStart',
                game: {
                  mapW, mapH, theme: mapData.theme,
                  crates: mapData.crates.map(c => ({
                    type: c.type, x: c.x, y: c.y, hw: c.hw, hd: c.hd, h: c.h,
                    solid: c.solid, transparent: c.transparent, disguise: c.disguise,
                  })),
                  entities: entities.map(e => ({ ...e })),
                  phase: 'prep',
                  prepEndsAt: l.game.prepEndsAt,
                  fovPlayer: l.game.fovPlayer,
                  fovHunter: l.game.fovHunter,
                },
                youId: c.id
              });
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
        if (msg.disguiseType !== undefined) ent.disguiseType = msg.disguiseType;
        break;
      }
      case 'shoot': {
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'game' || !lobby.game) break;
        if (lobby.game.phase !== 'main' || lobby.game.over) break;
        const ent = lobby.game.entities.find(e => e.id === client.id);
        if (!ent || ent.role !== 'hunter' || ent.shootCd > 0) break;
        ent.shootCd = 5;
        ent.shootFlash = 0.15;
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
        ent.disguised = false; ent.disguiseType = null;
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
        lobby.game.over = true; lobby.game.overTime = 0;
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

    if (g.phase === 'prep' && now >= g.prepEndsAt) {
      for (const e of g.entities) {
        if (e.role === 'hunter') {
          const pos = randomFreeSpot(g.mapW, g.mapH, g.crates);
          e.x = pos.x; e.y = pos.y;
        }
      }
      g.phase = 'main';
      g.mainEndsAt = Date.now() + MAIN_MS;
      broadcastToLobby(lobby.id, { type: 'phaseChange', phase: 'main' });
    }

    if (g.phase === 'main' && !g.over) {
      if (Date.now() >= g.mainEndsAt) {
        g.over = true; g.overTime = 0;
        g.winners = g.entities.filter(e => e.role === 'hider').map(e => e.id);
        if (g.winners.length === 0) g.winners = g.entities.map(e => e.id);
        broadcastToLobby(lobby.id, { type: 'matchEnd', winners: g.winners });
      } else {
        for (const e of g.entities) {
          if (e.shootCd > 0) e.shootCd -= dt;
          if (e.shootFlash > 0) e.shootFlash -= dt;
        }
        for (let i = g.projectiles.length - 1; i >= 0; i--) {
          const p = g.projectiles[i];
          p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
          if (p.life <= 0) { g.projectiles.splice(i, 1); continue; }

          let stopped = false;
          for (const c of g.crates) {
            if (!c.solid || c.transparent) continue;
            if (p.x >= c.x - c.hw && p.x <= c.x + c.hw &&
                p.y >= c.y - c.hd && p.y <= c.y + c.hd) {
              stopped = true; break;
            }
          }
          if (stopped) { g.projectiles.splice(i, 1); continue; }

          let hit = null;
          for (const e of g.entities) {
            if (e.id === p.owner || e.role !== 'hider') continue;
            const dx = e.x - p.x, dy = e.y - p.y;
            if (dx * dx + dy * dy < (13 + 9) * (13 + 9)) { hit = e; break; }
          }
          if (hit) {
            hit.role = 'hunter';
            hit.disguised = false; hit.disguiseType = null;
            hit.shootCd = 5;
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
        disguised: !!e.disguised, disguiseType: e.disguiseType, shootFlash: e.shootFlash,
        hat: e.hat || 'none', clothes: e.clothes || 'none',
      })),
      projectiles: g.projectiles, effects: g.effects, toasts: g.toasts,
      time: g.time, over: g.over, overTime: g.overTime,
    });
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`blockhide сервер: http://localhost:${PORT}`));
