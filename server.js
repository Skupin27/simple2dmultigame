// server.js
const express = require('express');
const http    = require('http');
const socketIo = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE        = 100;          // state broadcasts per second
const BASE_SPEED       = 10;
const SPRINT_MULT      = 1.5;
const CANVAS_W         = 1100;
const CANVAS_H         = 750;
const PLAYER_RADIUS    = 10;
const TAG_IMMUNITY_MS  = 2000;        // grace period after losing IT status

// Must match client
const OBSTACLES = [
  { x: 180, y: 140, w: 130, h: 18 },
  { x: 790, y: 140, w: 130, h: 18 },
  { x: 490, y: 290, w: 18,  h: 160 },
  { x: 180, y: 490, w: 130, h: 18 },
  { x: 790, y: 490, w: 130, h: 18 },
  { x: 340, y: 600, w: 18,  h: 100 },
  { x: 742, y: 600, w: 18,  h: 100 },
];

function obstacleBlocked(px, py) {
  for (const o of OBSTACLES) {
    const cx = Math.max(o.x, Math.min(px, o.x + o.w));
    const cy = Math.max(o.y, Math.min(py, o.y + o.h));
    if (Math.hypot(px - cx, py - cy) < PLAYER_RADIUS) return true;
  }
  return false;
}

let players    = {};
let itPlayerId = null;

function assignIt(excludeId) {
  const ids = Object.keys(players).filter(id => id !== excludeId);
  if (ids.length === 0) { itPlayerId = null; return; }
  const newIt = ids[Math.floor(Math.random() * ids.length)];
  itPlayerId = newIt;
  players[newIt].isIt = true;
}

function checkTagCollisions() {
  if (!itPlayerId || !players[itPlayerId]) return;
  const it  = players[itPlayerId];
  const now = Date.now();

  for (const id in players) {
    if (id === itPlayerId) continue;
    const other = players[id];
    if (now < (other.immuneUntil || 0)) continue;  // immune — skip
    const dist = Math.hypot(it.x - other.x, it.y - other.y);
    if (dist < PLAYER_RADIUS * 1.9) {
      const taggerName = it.nickname;
      players[itPlayerId].isIt = false;
      players[itPlayerId].immuneUntil = now + TAG_IMMUNITY_MS;  // old IT gets grace
      other.isIt   = true;
      itPlayerId   = id;
      io.emit('itChanged', { newItNickname: other.nickname, taggerNickname: taggerName });
      break;
    }
  }
}

setInterval(() => {
  if (Object.keys(players).length === 0) return;
  checkTagCollisions();

  const now      = Date.now();
  const snapshot = { players: {}, itId: itPlayerId, playerCount: Object.keys(players).length };
  for (const id in players) {
    const p = players[id];
    snapshot.players[id] = {
      x: p.x, y: p.y, color: p.color,
      nickname: p.nickname, isIt: p.isIt,
      immune: now < (p.immuneUntil || 0)
    };
  }
  io.emit('gameState', snapshot);
}, 1000 / TICK_RATE);

io.on('connection', (socket) => {
  console.log(`🟢 connected: ${socket.id}`);
  let currentNickname = 'anon';

  socket.on('setNickname', (raw) => {
    currentNickname = String(raw).slice(0, 14);

    // Spawn away from obstacles
    let spawnX, spawnY, attempts = 0;
    do {
      spawnX = Math.random() * (CANVAS_W - 100) + 50;
      spawnY = Math.random() * (CANVAS_H - 100) + 50;
    } while (obstacleBlocked(spawnX, spawnY) && ++attempts < 20);

    players[socket.id] = {
      x: spawnX, y: spawnY,
      color: `hsl(${Math.random() * 360}, 70%, 65%)`,
      nickname: currentNickname,
      isIt: false, sprinting: false, immuneUntil: 0
    };

    if (!itPlayerId || !players[itPlayerId]) {
      itPlayerId = socket.id;
      players[socket.id].isIt = true;
    }

    // Send current state to new player
    const init = {};
    const now  = Date.now();
    for (const id in players) {
      const p = players[id];
      init[id] = { x: p.x, y: p.y, color: p.color, nickname: p.nickname, isIt: p.isIt, immune: now < (p.immuneUntil || 0) };
    }
    socket.emit('currentPlayers', { players: init, itId: itPlayerId, playerCount: Object.keys(players).length });
    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });
    io.emit('playerCount', Object.keys(players).length);
    console.log(`🏷️  ${currentNickname} joined. Total: ${Object.keys(players).length}`);
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p) return;

    const speed = (data.sprint ? BASE_SPEED * SPRINT_MULT : BASE_SPEED);
    let dx = (data.right ? 1 : 0) - (data.left ? 1 : 0);
    let dy = (data.down  ? 1 : 0) - (data.up   ? 1 : 0);
    if (dx || dy) { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }

    const nx = Math.max(PLAYER_RADIUS, Math.min(CANVAS_W - PLAYER_RADIUS, p.x + dx * speed));
    const ny = Math.max(PLAYER_RADIUS, Math.min(CANVAS_H - PLAYER_RADIUS, p.y + dy * speed));

    // Slide collision against obstacles
    if      (!obstacleBlocked(nx, ny)) { p.x = nx; p.y = ny; }
    else if (!obstacleBlocked(nx, p.y)) { p.x = nx; }
    else if (!obstacleBlocked(p.x, ny)) { p.y = ny; }

    p.sprinting = !!data.sprint;
  });

  socket.on('disconnect', () => {
    console.log(`🔴 ${currentNickname} left`);
    const wasIt = itPlayerId === socket.id;
    delete players[socket.id];
    if (wasIt) {
      const ids = Object.keys(players);
      if (ids.length > 0) {
        const newIt = ids[Math.floor(Math.random() * ids.length)];
        itPlayerId = newIt;
        players[newIt].isIt = true;
        io.emit('itChanged', { newItNickname: players[newIt].nickname, taggerNickname: null });
      } else {
        itPlayerId = null;
      }
    }
    io.emit('playerDisconnected', socket.id);
    io.emit('playerCount', Object.keys(players).length);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Tag It → http://localhost:${PORT}`));
