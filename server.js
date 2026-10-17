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
const POST_GAME_MS = 5000;

const OBJECT_DEFS = {
  // базовые
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
  // новые (Странный город / Свалка)
  skyscraper:  { w:1, d:1, h:220, solid:true,  disguise:false },
  shop:        { w:1, d:1, h:64,  solid:true,  disguise:true },
  trash:       { w:1, d:1, h:14,  solid:false, disguise:true },
  trashcan:    { w:1, d:1, h:34,  solid:true,  disguise:true },
  apple_tree:  { w:2, d:2, h:110, solid:false, disguise:false },
  brick_house: { w:2, d:2, h:110, solid:true,  disguise:false },
  bricks:      { w:1, d:1, h:20,  solid:true,  disguise:true },
  teddy_black: { w:1, d:1, h:20,  solid:false, disguise:true },
  teddy_white: { w:1, d:1, h:20,  solid:false, disguise:true },
};

/* карты в компактном формате [x, y, type] */
function parseCompact(arr){
  return arr.map(a => ({ x: a[0], y: a[1], type: a[2] }));
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

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
    objects: parseCompact([
      [8,16,"barrel"],[8,15,"box"],[8,14,"box"],[9,14,"box"],[8,13,"stone"],[9,13,"stone"],
      [13,17,"wood"],[14,16,"grass"],[13,15,"grass"],[14,15,"grass"],
      [20,10,"pumpkin"],[20,12,"pumpkin"],[18,12,"pumpkin"],[18,11,"pumpkin"],[20,11,"pumpkin"],
      [17,12,"box"],[16,12,"box"],[15,12,"box"],[15,11,"box"],[15,10,"box"],[16,10,"box"],[16,11,"box"],[17,11,"box"],
      [16,9,"stone"],[17,9,"stone"],[15,9,"stone"],
      [21,17,"wood"],[15,23,"wood"],[14,19,"wood"],[17,20,"wood"],[17,17,"wood"],[20,20,"wood"],[19,24,"wood"],
      [8,17,"barrel"],[16,21,"grass"],[15,21,"grass"],[15,22,"grass"],[16,22,"grass"],[20,18,"grass"],[19,18,"grass"],
      [8,12,"fence"],[9,12,"fence"],[17,8,"fence"],[16,8,"fence"],[15,8,"fence"],[14,8,"fence"],
      [3,4,"wood"],[5,4,"wood"],[3,7,"wood"],[5,6,"wood"],[7,5,"wood"],[5,8,"wood"],[1,8,"wood"],[3,9,"wood"],[6,10,"wood"],[7,8,"wood"],
      [10,13,"pumpkin"],[2,17,"stone"],[2,18,"stone"],[2,19,"stone"],
      [3,20,"pumpkin"],[4,20,"pumpkin"],[5,18,"pumpkin"],
      [4,19,"grass"],[3,19,"grass"],[3,18,"grass"],[4,18,"grass"],[3,17,"grass"],[4,17,"grass"],
      [19,4,"wood"],[21,4,"wood"],[22,6,"wood"],[5,23,"fence"],[6,23,"fence"],[7,23,"fence"],
      [26,11,"wood"],[26,13,"wood"],[28,11,"wood"],
      [11,6,"stone"],[11,5,"stone"],[12,5,"box"],[25,3,"box"],[25,2,"box"],[26,2,"stone"],
      [2,16,"box"],[2,20,"box"],[11,25,"wood"],[8,26,"wood"],[3,26,"wood"],[1,23,"wood"],
      [10,20,"wood"],[4,12,"wood"],[12,23,"wood"],[14,26,"wood"],[17,25,"wood"],
      [6,27,"grass"],[4,25,"grass"],[3,24,"grass"],[1,25,"grass"],[2,26,"grass"],[4,28,"grass"],
      [8,28,"grass"],[9,28,"grass"],[10,27,"grass"],[9,25,"grass"],[9,24,"grass"],[9,22,"grass"],
      [7,20,"grass"],[6,19,"grass"],[7,16,"grass"],[2,11,"grass"],[2,10,"grass"],[4,11,"grass"],
      [10,10,"grass"],[13,11,"grass"],[14,13,"grass"],[5,14,"grass"],[3,16,"grass"],[1,14,"grass"],[2,13,"grass"],
      [9,4,"grass"],[13,4,"grass"],[15,5,"grass"],[14,6,"grass"],[10,7,"grass"],[7,2,"grass"],
      [5,1,"grass"],[4,1,"grass"],[3,1,"grass"],[1,3,"grass"],[1,4,"grass"],[6,0,"grass"],
      [9,2,"grass"],[11,3,"grass"],[16,3,"grass"],[18,5,"grass"],[19,6,"grass"],
      [23,10,"grass"],[23,12,"grass"],[25,16,"grass"],[25,18,"grass"],[28,22,"grass"],
      [27,23,"grass"],[22,25,"grass"],[24,28,"grass"],[23,28,"grass"],[26,27,"grass"],
      [24,23,"grass"],[26,19,"grass"],[28,18,"grass"],[28,13,"grass"],[29,10,"grass"],
      [27,5,"grass"],[24,7,"grass"],[23,13,"grass"],[22,14,"grass"],[20,13,"grass"],
      [18,14,"grass"],[17,14,"grass"],[21,1,"grass"],[16,2,"grass"],[15,3,"grass"],
      [23,4,"grass"],[27,6,"grass"],[28,6,"grass"],[29,1,"grass"],[27,1,"grass"],
      [22,1,"grass"],[19,0,"grass"],[15,0,"grass"],[13,1,"grass"],[11,1,"grass"],
      [8,0,"grass"],[7,0,"grass"],[7,1,"grass"],[8,2,"grass"],[7,3,"grass"],
      [9,5,"grass"],[9,6,"grass"],[9,7,"grass"],[9,8,"grass"],[10,8,"grass"]
    ])
  },
  ice: {
    name: 'Ледов', width: 30, height: 30, theme: 'ice',
    objects: parseCompact([
      [10,5,"glass"],[11,5,"glass"],[12,5,"glass"],[12,4,"glass"],[13,4,"glass"],[11,4,"glass"],
      [7,9,"truck"],[13,11,"car"],[6,14,"car"],
      [3,8,"block_cyan"],[3,9,"block_cyan"],[4,8,"block_cyan"],[3,7,"block_cyan"],
      [19,11,"stone"],[19,12,"stone"],[20,10,"stone"],[19,10,"stone"],[20,11,"glass"],
      [8,22,"block_blue"],[9,22,"block_blue"],[9,23,"block_blue"],
      [10,22,"block_cyan"],[9,21,"block_cyan"],[10,21,"block_cyan"],
      [22,21,"block_cyan"],[22,19,"block_cyan"],[22,20,"block_cyan"],[23,20,"block_cyan"],
      [14,21,"block_blue"],[14,20,"block_blue"],[15,19,"block_blue"],[14,18,"block_blue"],
      [14,19,"block_blue"],[15,18,"block_blue"],[14,17,"block_blue"],
      [26,7,"block_cyan"],[25,5,"block_cyan"],[24,3,"block_cyan"],
      [25,6,"block_blue"],[24,4,"block_blue"],[26,8,"block_blue"],[24,2,"block_blue"],
      [26,9,"block_cyan"],[4,9,"glass"],[4,7,"glass"],[2,7,"glass"],
      [1,8,"glass"],[1,7,"glass"],[2,8,"glass"],
      [14,24,"glass"],[15,24,"glass"],[15,25,"glass"],[13,25,"glass"],[14,25,"glass"],
      [17,25,"glass"],[16,25,"glass"],[12,15,"stone"],[11,15,"stone"],[10,14,"stone"],[10,15,"stone"],
      [3,19,"block_blue"],[3,20,"block_blue"],[4,23,"block_cyan"],
      [6,25,"block_cyan"],[5,24,"block_cyan"],[4,24,"block_cyan"],
      [26,19,"stone"],[26,20,"stone"],[22,26,"grass"],
      [4,3,"grass"],[5,3,"grass"],[26,13,"grass"],[24,12,"grass"],[23,8,"grass"],
      [10,17,"grass"],[7,17,"grass"],[6,18,"grass"],[3,15,"grass"],[3,13,"grass"],[3,12,"grass"],
      [6,11,"grass"],[16,14,"grass"],[17,14,"grass"],[19,18,"grass"],[17,20,"grass"],
      [11,22,"grass"],[12,19,"grass"],[8,25,"grass"],[6,22,"grass"],[3,26,"grass"],
      [17,18,"pumpkin"],[16,5,"pumpkin"],[7,5,"pumpkin"],[8,18,"pumpkin"],[3,17,"pumpkin"],
      [24,14,"pumpkin"],[21,23,"pumpkin"],[10,26,"pumpkin"],[5,19,"pumpkin"],[1,25,"pumpkin"],
      [20,4,"pumpkin"],[16,1,"pumpkin"],[28,4,"pumpkin"],
      [26,6,"grass"],[26,5,"grass"],[25,4,"grass"],[25,3,"grass"],
      [19,15,"grass"],[22,16,"grass"],[15,8,"grass"],[12,8,"grass"],[11,8,"grass"],
      [25,23,"truck"],
      [10,16,"barrel"],[11,16,"barrel"],[11,6,"barrel"],[12,6,"barrel"],
      [24,5,"barrel"],[24,6,"barrel"],[14,26,"barrel"],[15,27,"barrel"],[14,27,"barrel"],
      [23,21,"barrel"],[21,19,"barrel"],[21,20,"barrel"]
    ])
  },
  strange_city: {
    name: 'Странный Город', width: 40, height: 40, theme: 'grass',
    objects: parseCompact([
      [3,21,"skyscraper"],[4,21,"skyscraper"],[5,21,"skyscraper"],[5,20,"skyscraper"],[5,19,"skyscraper"],[5,18,"skyscraper"],
      [14,20,"shop"],[15,20,"shop"],[16,20,"trash"],[16,19,"trashcan"],
      [13,23,"car"],[11,18,"apple_tree"],[10,20,"apple_tree"],[9,17,"apple_tree"],
      [15,19,"barrel"],[13,29,"trash"],[8,26,"trashcan"],[19,34,"trashcan"],[7,32,"trashcan"],
      [3,30,"apple_tree"],[8,35,"apple_tree"],
      [4,34,"wood"],[12,16,"wood"],[8,19,"wood"],
      [13,20,"shop"],[16,12,"brick_house"],[16,10,"brick_house"],
      [21,16,"bricks"],[21,15,"bricks"],[22,14,"bricks"],
      [17,28,"bricks"],[14,26,"bricks"],[12,25,"bricks"],[12,31,"bricks"],[14,32,"bricks"],
      [21,4,"skyscraper"],[22,4,"skyscraper"],[23,4,"skyscraper"],
      [7,7,"skyscraper"],[33,13,"skyscraper"],[31,18,"skyscraper"],[25,11,"skyscraper"],[30,25,"skyscraper"],
      [15,14,"truck"],[5,8,"barrel"],[17,4,"barrel"],[31,5,"barrel"],
      [26,29,"brick_house"],
      [29,22,"bricks"],[28,20,"bricks"],
      [34,27,"wood"],[34,23,"wood"],[37,25,"wood"],[37,29,"wood"],
      [33,31,"wood"],[31,29,"wood"],[31,26,"wood"],[38,18,"wood"],
      [31,23,"apple_tree"],[31,21,"apple_tree"],[34,19,"apple_tree"],
      [32,17,"apple_tree"],[33,15,"apple_tree"],[35,17,"apple_tree"],
      [37,31,"grass"],[33,28,"grass"],[32,28,"grass"],[33,29,"grass"],[34,30,"grass"],
      [35,26,"grass"],[36,25,"grass"],[37,27,"grass"],[38,27,"grass"],[33,24,"grass"],
      [37,22,"grass"],[37,21,"grass"],[38,22,"grass"],[33,19,"grass"],[32,20,"grass"],
      [37,20,"grass"],[37,16,"grass"],[38,14,"grass"],[38,15,"grass"],[36,16,"grass"],
      [35,14,"grass"],[35,13,"grass"],[37,12,"grass"],[35,10,"grass"],[33,9,"grass"],
      [30,9,"grass"],[29,11,"grass"],[30,12,"grass"],[31,15,"grass"],[30,15,"grass"],
      [28,13,"grass"],[28,12,"grass"],[28,10,"grass"],[27,9,"grass"],[28,8,"grass"],
      [35,7,"grass"],[39,8,"grass"],[39,12,"grass"],[38,10,"grass"],[35,8,"grass"],
      [32,7,"grass"],[27,7,"grass"],[27,6,"grass"],[26,5,"grass"],[25,3,"grass"],
      [25,2,"grass"],[28,4,"grass"],[30,7,"grass"],[28,2,"grass"],[32,1,"grass"],
      [36,4,"grass"],[36,5,"grass"],[34,4,"grass"],[33,4,"grass"],[31,3,"grass"],
      [35,3,"grass"],[37,3,"grass"],[38,5,"grass"],[39,6,"grass"],
      [4,13,"brick_house"],[4,11,"brick_house"],
      [21,29,"block_red"],[20,29,"block_red"],[20,28,"block_red"],[21,28,"block_red"],
      [11,4,"stone"],[12,4,"stone"],[10,4,"stone"],
      [11,8,"trash"],[10,12,"trash"],[8,11,"trash"],[10,9,"trash"],
      [5,15,"trashcan"],[23,5,"trashcan"],[17,9,"trashcan"],[29,17,"trashcan"],[28,25,"trashcan"],
      [23,34,"shop"],[24,34,"shop"],[22,34,"shop"],
      [21,22,"pumpkin"],[21,21,"pumpkin"],[22,20,"pumpkin"],[23,21,"pumpkin"],[22,21,"pumpkin"],
      [21,20,"pumpkin"],[23,22,"pumpkin"],[22,22,"pumpkin"],[23,20,"barrel"]
    ])
  },
  dump: {
    name: 'Свалка', width: 40, height: 40, theme: 'wood',
    objects: parseCompact([
      [35,1,"stump"],[36,1,"stump"],[37,2,"stump"],[36,2,"stump"],
      [2,27,"stump"],[4,29,"stump"],[1,33,"stump"],[2,31,"stump"],[2,35,"stump"],
      [3,33,"stump"],[4,35,"stump"],[4,38,"stump"],[6,37,"stump"],[4,34,"stump"],[5,33,"stump"],
      [28,29,"stump"],[29,33,"stump"],[31,31,"stump"],[32,31,"stump"],[29,29,"stump"],[28,32,"stump"],
      [14,29,"pumpkin"],[16,29,"pumpkin"],[15,30,"pumpkin"],[14,30,"pumpkin"],
      [14,37,"fence"],[15,37,"fence"],[16,37,"fence"],[35,16,"fence"],[35,17,"fence"],[35,18,"fence"],
      [15,24,"trash"],[18,26,"trash"],[19,25,"trash"],[21,26,"trash"],[24,23,"trash"],
      [26,22,"trash"],[27,22,"trash"],[26,18,"trash"],[24,15,"trash"],[23,12,"trash"],
      [21,10,"trash"],[16,9,"trash"],[13,10,"trash"],[9,12,"trash"],[9,13,"trash"],
      [8,17,"trash"],[9,19,"trash"],[11,20,"trash"],[12,21,"trash"],[9,23,"trash"],
      [7,21,"trash"],[6,17,"trash"],[5,15,"trash"],[7,12,"trash"],[7,11,"trash"],
      [8,10,"trash"],[10,8,"trash"],[12,8,"trash"],[14,7,"trash"],[18,5,"trash"],[24,5,"trash"],
      [21,32,"trashcan"],[24,31,"trashcan"],[17,15,"trashcan"],[2,18,"trashcan"],[9,33,"trashcan"],
      [32,8,"trashcan"],[25,1,"trashcan"],[8,4,"trashcan"],
      [15,19,"teddy_black"],[18,13,"teddy_black"],
      [32,26,"teddy_white"],[20,23,"teddy_white"],[9,15,"teddy_white"],[4,19,"teddy_white"],[27,15,"teddy_white"],[10,2,"teddy_white"],
      [4,4,"pumpkin"],[5,6,"pumpkin"],[6,6,"pumpkin"],[5,5,"pumpkin"],[4,5,"pumpkin"],[2,4,"pumpkin"],
      [30,2,"pumpkin"],[31,4,"pumpkin"],[30,4,"pumpkin"],[29,2,"pumpkin"],[30,3,"pumpkin"],
      [20,19,"stump"],[19,19,"stump"],[19,18,"stump"],[20,18,"stump"],
      [13,12,"stump"],[12,13,"stump"],[13,15,"stump"],
      [23,19,"car"],[10,10,"car"],[11,26,"truck"],
      [17,23,"shop"],[18,23,"shop"],
      [13,20,"bricks"],[13,17,"bricks"],[15,15,"bricks"],[16,18,"bricks"],[18,19,"bricks"],
      [22,22,"bricks"],[25,26,"bricks"],[24,28,"bricks"],[21,30,"bricks"],[18,29,"bricks"],
      [17,27,"bricks"],[15,26,"bricks"],[12,22,"bricks"],[11,22,"bricks"],[8,20,"bricks"],
      [5,19,"bricks"],[7,24,"bricks"],[10,28,"bricks"],[13,31,"bricks"],[17,34,"bricks"],
      [19,35,"bricks"],[25,33,"bricks"],[36,31,"bricks"],[38,24,"bricks"],[33,20,"bricks"],
      [30,20,"bricks"],[28,19,"bricks"],[27,17,"bricks"],[26,15,"bricks"],[23,13,"bricks"],
      [20,13,"bricks"],[16,8,"bricks"],[19,6,"bricks"],[24,10,"bricks"],[17,8,"bricks"],
      [16,6,"bricks"],[13,5,"bricks"],[11,5,"bricks"],[9,3,"bricks"],[7,2,"bricks"],
      [6,1,"bricks"],[15,0,"bricks"],[16,1,"bricks"],[22,4,"bricks"],
      [15,13,"block_red"],[11,17,"block_red"],[6,11,"block_red"],[9,8,"block_red"],[7,5,"block_red"],
      [28,9,"block_red"],[30,14,"block_red"],[30,22,"block_red"],[28,26,"block_red"],[13,24,"block_red"],[1,15,"block_red"],
      [2,37,"wood"],[38,0,"wood"],
      [16,21,"barrel"],[20,15,"barrel"],[11,9,"barrel"],[27,13,"barrel"],
      [31,26,"barrel"],[21,28,"barrel"],[14,21,"barrel"],[7,18,"barrel"],
      [35,7,"brick_house"],[23,37,"brick_house"],[1,23,"brick_house"],
      [25,36,"trashcan"],[24,36,"trashcan"],[25,37,"trashcan"],
      [36,9,"trashcan"],[37,9,"trashcan"],[37,8,"trashcan"],[3,22,"trashcan"],
      [4,24,"bricks"],[5,23,"bricks"],
      [17,30,"teddy_black"],[5,13,"teddy_white"],
      [18,22,"box"],[12,11,"box"],[18,11,"box"],[16,13,"box"],[29,17,"box"],
      [23,16,"box"],[22,17,"box"],[28,38,"box"],[31,37,"box"],[37,37,"box"],
      [36,35,"box"],[34,36,"box"],[34,37,"box"],[31,34,"box"],[35,32,"box"],[39,34,"box"],
      [9,36,"box"],[6,28,"box"],[11,31,"box"],
      [19,2,"shop"],[4,16,"shop"],[33,17,"shop"]
    ])
  }
};

const MAP_KEYS = Object.keys(MAPS);

function buildCrates(mapId, removePercent) {
  // random map selection
  if (mapId === 'random') {
    mapId = MAP_KEYS[Math.floor(Math.random() * MAP_KEYS.length)];
  }
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
  // сортируем по площади (большие первыми), чтобы при перекрытии маленькие отбрасывались
  objects.sort((a, b) => {
    const da = OBJECT_DEFS[a.type], db = OBJECT_DEFS[b.type];
    if (!da || !db) return 0;
    return (db.w * db.d) - (da.w * da.d);
  });
  const crates = [];
  for (const o of objects) {
    const def = OBJECT_DEFS[o.type];
    if (!def) continue;
    // проверка перекрытия с уже добавленными
    let overlaps = false;
    for (const c of crates) {
      if (Math.abs(c.x - (o.x * CELL + def.w * CELL / 2)) < c.hw + def.w * CELL / 2 &&
          Math.abs(c.y - (o.y * CELL + def.d * CELL / 2)) < c.hd + def.d * CELL / 2) {
        overlaps = true; break;
      }
    }
    if (overlaps) continue;
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
  return { crates, width: map.width, height: map.height, theme: map.theme, name: map.name };
}

function randomFreeSpot(mapW, mapH, crates) {
  const W = mapW * CELL, H = mapH * CELL;
  for (let i = 0; i < 100; i++) {
    const x = CELL + Math.random() * (W - 2 * CELL);
    const y = CELL + Math.random() * (H - 2 * CELL);
    let free = true;
    for (const c of crates) {
      if (!c.solid) continue;
      if (Math.abs(x - c.x) < c.hw + 16 && Math.abs(y - c.y) < c.hd + 16) { free = false; break; }
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
      prepDuration: 20,
      mainDuration: 90,
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

function endGame(lobby, winners) {
  const g = lobby.game;
  if (!g || g.over) return;
  g.over = true;
  g.overAt = Date.now();
  g.winners = winners;
  console.log(`[${lobby.id}] game over. winners=${winners.join(',')}`);
  broadcastToLobby(lobby.id, { type: 'matchEnd', winners });
  setTimeout(() => {
    const l = lobbies.get(lobby.id);
    if (!l) return;
    if (l.state !== 'game') return;
    l.state = 'lobby';
    l.game = null;
    for (const p of l.players) {
      p.x = 450 + (Math.random() - 0.5) * 120;
      p.y = 546 + (Math.random() - 0.5) * 120;
      p.moving = false;
    }
    console.log(`[${lobby.id}] → backToLobby`);
    broadcastToLobby(l.id, { type: 'backToLobby', lobby: lobbySummary(l) });
    broadcastLobbyList();
  }, POST_GAME_MS);
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
        if (typeof s.mapMode === 'string' && (MAPS[s.mapMode] || s.mapMode === 'random')) lobby.settings.mapMode = s.mapMode;
        if (typeof s.hunter === 'string') lobby.settings.hunter = s.hunter;
        if (typeof s.debug === 'boolean') lobby.settings.debug = s.debug;
        if (typeof s.playerCount === 'number') lobby.settings.playerCount = Math.max(1, Math.min(4, Math.floor(s.playerCount)));
        if (typeof s.fovPlayer === 'number') lobby.settings.fovPlayer = Math.max(0.05, Math.min(1.0, s.fovPlayer));
        if (typeof s.fovHunter === 'number') lobby.settings.fovHunter = Math.max(0.05, Math.min(1.0, s.fovHunter));
        if (typeof s.removePercent === 'number') lobby.settings.removePercent = Math.max(0, Math.min(50, Math.floor(s.removePercent)));
        if (typeof s.prepDuration === 'number') lobby.settings.prepDuration = Math.max(5, Math.min(60, Math.floor(s.prepDuration)));
        if (typeof s.mainDuration === 'number') lobby.settings.mainDuration = Math.max(30, Math.min(300, Math.floor(s.mainDuration)));
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
          const prepMs = (l.settings.prepDuration || 20) * 1000;
          l.state = 'game';
          l.game = {
            mapW, mapH, theme: mapData.theme,
            crates: mapData.crates,
            entities,
            projectiles: [], effects: [], toasts: [],
            time: 0, over: false, overAt: 0,
            phase: 'prep',
            prepEndsAt: Date.now() + prepMs,
            mainEndsAt: 0,
            mainDurationMs: (l.settings.mainDuration || 90) * 1000,
            winners: [],
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
        const fast = !!msg.fast;
        const speed = fast ? 1550 : 620;
        lobby.game.projectiles.push({
          x: ent.x + dx / len * 16, y: ent.y + dy / len * 16, z: 32,
          vx: dx / len * speed, vy: dy / len * speed,
          life: fast ? 0.6 : 0.95,
          owner: ent.id,
          fast,
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
  if (lobby.game && !lobby.game.over) {
    lobby.game.entities = lobby.game.entities.filter(e => e.id !== client.id);
    const hiders = lobby.game.entities.filter(e => e.role === 'hider').length;
    if (hiders === 0) {
      endGame(lobby, lobby.game.entities.filter(e => e.role === 'hunter').map(e => e.id));
    }
  } else if (lobby.game) {
    lobby.game.entities = lobby.game.entities.filter(e => e.id !== client.id);
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
      g.mainEndsAt = Date.now() + g.mainDurationMs;
      broadcastToLobby(lobby.id, { type: 'phaseChange', phase: 'main' });
    }

    if (g.over) {
      const timeLeft = 0;
      broadcastToLobby(lobby.id, {
        type: 'state', phase: g.phase, timeLeft,
        entities: g.entities.map(e => ({
          id: e.id, role: e.role, x: e.x, y: e.y, fx: e.fx, fy: e.fy,
          disguised: !!e.disguised, disguiseType: e.disguiseType, shootFlash: e.shootFlash,
          hat: e.hat || 'none', clothes: e.clothes || 'none',
        })),
        projectiles: [], effects: [], toasts: g.toasts,
        over: true,
      });
      continue;
    }

    if (g.phase === 'main') {
      if (now >= g.mainEndsAt) {
        const winners = g.entities.filter(e => e.role === 'hider').map(e => e.id);
        endGame(lobby, winners.length ? winners : g.entities.map(e => e.id));
        continue;
      }
      for (const e of g.entities) {
        if (e.shootCd > 0) e.shootCd -= dt;
        if (e.shootFlash > 0) e.shootFlash -= dt;
      }
      // снаряды с подшагами для fast
      for (let i = g.projectiles.length - 1; i >= 0; i--) {
        const p = g.projectiles[i];
        const steps = p.fast ? 8 : 1;
        let removed = false;
        for (let s = 0; s < steps && !removed; s++) {
          p.x += p.vx * dt / steps;
          p.y += p.vy * dt / steps;
          p.life -= dt / steps;
          if (p.life <= 0) { removed = true; break; }

          let stopped = false;
          for (const c of g.crates) {
            if (!c.solid || c.transparent) continue;
            if (p.x >= c.x - c.hw && p.x <= c.x + c.hw &&
                p.y >= c.y - c.hd && p.y <= c.y + c.hd) { stopped = true; break; }
          }
          if (stopped) { removed = true; break; }

          let hit = null;
          for (const e of g.entities) {
            if (e.id === p.owner || e.role !== 'hider') continue;
            const dx = e.x - p.x, dy = e.y - p.y;
            if (dx * dx + dy * dy < (13 + 18) * (13 + 18)) { hit = e; break; }
          }
          if (hit) {
            hit.role = 'hunter'; hit.disguised = false; hit.disguiseType = null; hit.shootCd = 5;
            g.effects.push({ x: hit.x, y: hit.y, z: 34, t: 0, max: 0.5 });
            g.toasts.push({ x: hit.x, y: hit.y, z: 58, text: 'Найден!', life: 1.4, color: '#ff9d94' });
            removed = true;
          }
        }
        if (removed) g.projectiles.splice(i, 1);
      }
      for (let i = g.effects.length - 1; i >= 0; i--) {
        g.effects[i].t += dt;
        if (g.effects[i].t > g.effects[i].max) g.effects.splice(i, 1);
      }
      g.time += dt;
      const hiders = g.entities.filter(e => e.role === 'hider').length;
      if (hiders === 0) {
        endGame(lobby, g.entities.filter(e => e.role === 'hunter').map(e => e.id));
        continue;
      }
    }

    for (let i = g.toasts.length - 1; i >= 0; i--) {
      const t = g.toasts[i]; t.life -= dt; t.z += dt * 26;
      if (t.life <= 0) g.toasts.splice(i, 1);
    }

    let timeLeft = 0;
    if (g.phase === 'main') timeLeft = Math.max(0, Math.ceil((g.mainEndsAt - Date.now()) / 1000));
    else if (g.phase === 'prep') timeLeft = Math.max(0, Math.ceil((g.prepEndsAt - Date.now()) / 1000));

    broadcastToLobby(lobby.id, {
      type: 'state', phase: g.phase, timeLeft,
      entities: g.entities.map(e => ({
        id: e.id, role: e.role, x: e.x, y: e.y, fx: e.fx, fy: e.fy,
        disguised: !!e.disguised, disguiseType: e.disguiseType, shootFlash: e.shootFlash,
        hat: e.hat || 'none', clothes: e.clothes || 'none',
      })),
      projectiles: g.projectiles, effects: g.effects, toasts: g.toasts,
      over: false,
    });
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`blockhide сервер: http://localhost:${PORT}`));
