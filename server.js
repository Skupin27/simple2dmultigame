// server.js
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
});

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE       = 60;
const BASE_SPEED      = 10;
const SPRINT_MULT     = 1.25;
const CANVAS_W        = 1200;
const CANVAS_H        = 900;
const PLAYER_RADIUS   = 15;
const TAG_IMMUNITY_MS = 1500;
const ROUND_DURATION  = 180;
const BREAK_DURATION  = 5;

// ── Event pool ───────────────────────────────────────────────────────────────
// speedMult    : multiplier on BASE_SPEED
// ghostNonIt   : non-IT players skip wall collision
// tagRadiusMult: scales tag detection distance
const EVENT_POOL = [
  { id: 'normal',     name: 'Normal',     duration: 60, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'darkness',   name: 'Lights Out', duration: 25, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'speed_rush', name: 'Speed Rush', duration: 18, speedMult: 2.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'ghost',      name: 'Ghost Mode', duration: 25, speedMult: 1.00, ghostNonIt: true,  tagRadiusMult: 1.00 },
  { id: 'blizzard',   name: 'Blizzard',   duration: 25, speedMult: 0.60, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'invert',     name: 'Confusion',  duration: 18, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'big_it',     name: 'Mega IT',    duration: 28, speedMult: 0.80, ghostNonIt: false, tagRadiusMult: 4.00 },
  { id: 'tiny',       name: 'Micro Mode', duration: 25, speedMult: 1.30, ghostNonIt: false, tagRadiusMult: 0.50 },
  { id: 'earthquake', name: 'Earthquake', duration: 20, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'phantom_it', name: 'Phantom IT', duration: 25, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
  { id: 'zoomies',    name: 'Zoomies',    duration: 15, speedMult: 3.00, ghostNonIt: true,  tagRadiusMult: 1.50 },
  { id: 'vrooom',     name: 'Vroom',      duration: 5,  speedMult: 2.50, ghostNonIt: false, tagRadiusMult: 2.00 },
  { id: 'ghost_it',   name: 'Ghost IT',   duration: 15, speedMult: 1.00, ghostNonIt: false, tagRadiusMult: 1.00 },
];

let currentEvent  = EVENT_POOL[0];
let eventTimeLeft = currentEvent.duration;

function pickNextEvent() {
  const pool = EVENT_POOL.filter(e => e.id !== currentEvent.id);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Wall generator ───────────────────────────────────────────────────────────
function generateObstacles() {
  const walls    = [];
  const count    = 5 + Math.floor(Math.random() * 4);
  const margin   = 75;
  const minGap   = 15;
  const maxTries = count * 20;

  for (let attempt = 0; attempt < maxTries && walls.length < count; attempt++) {
    const isHoriz = Math.random() > 0.38;
    const w = isHoriz ? 80  + Math.floor(Math.random() * 120) : 16 + Math.floor(Math.random() * 6);
    const h = isHoriz ? 16  + Math.floor(Math.random() * 6)   : 80 + Math.floor(Math.random() * 120);
    const x = margin  + Math.floor(Math.random() * (CANVAS_W - 2 * margin - w));
    const y = margin  + Math.floor(Math.random() * (CANVAS_H - 2 * margin - h));

    let ok = true;
    for (const o of walls) {
      if (x < o.x + o.w + minGap && x + w + minGap > o.x &&
          y < o.y + o.h + minGap && y + h + minGap > o.y) {
        ok = false; break;
      }
    }
    if (ok) walls.push({ x, y, w, h });
  }
  return walls;
}

let obstacles = generateObstacles();

function obstacleBlocked(px, py) {
  for (const o of obstacles) {
    const cx = Math.max(o.x, Math.min(px, o.x + o.w));
    const cy = Math.max(o.y, Math.min(py, o.y + o.h));
    if (Math.hypot(px - cx, py - cy) < PLAYER_RADIUS) return true;
  }
  return false;
}

// Shuffle walls every 60 s
setInterval(() => {
  obstacles = generateObstacles();
  for (const id in players) {
    const p = players[id];
    if (obstacleBlocked(p.x, p.y)) {
      let sx, sy, att = 0;
      do {
        sx = Math.random() * (CANVAS_W - 50) + 40;
        sy = Math.random() * (CANVAS_H - 50) + 40;
      } while (obstacleBlocked(sx, sy) && ++att < 30);
      p.x = sx; p.y = sy;
    }
  }
  io.emit('wallsUpdate', { obstacles });
  console.log(`🧱 Walls shuffled (${obstacles.length} walls)`);
}, 60_000);

// ── Player state ─────────────────────────────────────────────────────────────
let players    = {};
let itPlayerId = null;

// ── Round state ──────────────────────────────────────────────────────────────
let roundNumber   = 1;
let roundState    = 'playing';
let roundTimeLeft = ROUND_DURATION;
let breakTimeLeft = 0;

function startRound() {
  roundState    = 'playing';
  roundTimeLeft = ROUND_DURATION;

  // Reset event to normal at the top of each round
  currentEvent  = EVENT_POOL[0];
  eventTimeLeft = currentEvent.duration;

  const now = Date.now();
  for (const id in players) {
    players[id].isIt        = false;
    players[id].immuneUntil = 0;
  }

  const ids = Object.keys(players);
  if (ids.length > 0) {
    const newIt = ids[Math.floor(Math.random() * ids.length)];
    itPlayerId = newIt;
    players[newIt].isIt = true;
    io.emit('roundStart', { roundNumber, itNickname: players[newIt].nickname });
  } else {
    itPlayerId = null;
  }
}

function endRound() {
  roundState    = 'break';
  breakTimeLeft = BREAK_DURATION;
  const itName  = (itPlayerId && players[itPlayerId]) ? players[itPlayerId].nickname : 'nobody';
  io.emit('roundEnd', { roundNumber, itNickname: itName, breakDuration: BREAK_DURATION });
  roundNumber++;
}

// 1-second tick: rounds + events
setInterval(() => {
  if (Object.keys(players).length === 0) return;

  if (roundState === 'playing') {
    roundTimeLeft = Math.max(0, roundTimeLeft - 1);
    if (roundTimeLeft === 0) { endRound(); return; }

    eventTimeLeft = Math.max(0, eventTimeLeft - 1);
    if (eventTimeLeft === 0) {
      currentEvent  = pickNextEvent();
      eventTimeLeft = currentEvent.duration;
      io.emit('eventChange', {
        eventId:       currentEvent.id,
        eventName:     currentEvent.name,
        eventDuration: currentEvent.duration,
      });
      console.log(`🎮 Event → ${currentEvent.name} (${currentEvent.duration}s)`);
    }
  } else {
    breakTimeLeft = Math.max(0, breakTimeLeft - 1);
    if (breakTimeLeft === 0) startRound();
  }
}, 1000);

// ── Tag collision ────────────────────────────────────────────────────────────
function checkTagCollisions() {
  if (roundState !== 'playing') return;
  if (!itPlayerId || !players[itPlayerId]) return;

  const it      = players[itPlayerId];
  const now     = Date.now();
  const tagDist = PLAYER_RADIUS * 1.9 * currentEvent.tagRadiusMult;

  for (const id in players) {
    if (id === itPlayerId) continue;
    const other = players[id];
    if (now < (other.immuneUntil || 0)) continue;
    if (Math.hypot(it.x - other.x, it.y - other.y) < tagDist) {
      const taggerName              = it.nickname;
      players[itPlayerId].isIt        = false;
      players[itPlayerId].immuneUntil = now + TAG_IMMUNITY_MS;
      other.isIt = true;
      itPlayerId = id;
      io.emit('itChanged', { newItNickname: other.nickname, taggerNickname: taggerName });
      break;
    }
  }
}

// Main loop
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  checkTagCollisions();

  const now      = Date.now();
  const snapshot = {
    players:     {},
    itId:        itPlayerId,
    playerCount: Object.keys(players).length,
    timer: {
      state:       roundState,
      timeLeft:    roundState === 'playing' ? roundTimeLeft : breakTimeLeft,
      roundNumber,
    },
    event: {
      id:       currentEvent.id,
      name:     currentEvent.name,
      timeLeft: eventTimeLeft,
    },
  };

  for (const id in players) {
    const p = players[id];
    snapshot.players[id] = {
      x: p.x, y: p.y, color: p.color,
      nickname: p.nickname, isIt: p.isIt,
      immune: now < (p.immuneUntil || 0),
    };
  }
  io.emit('gameState', snapshot);
}, 1000 / TICK_RATE);

// ── Connections ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🟢 connected: ${socket.id}`);
  let currentNickname = 'anon';

  socket.on('setNickname', (raw) => {
    currentNickname = String(raw).slice(0, 14);

    let spawnX, spawnY, attempts = 0;
    do {
      spawnX = Math.random() * (CANVAS_W - 100) + 50;
      spawnY = Math.random() * (CANVAS_H - 100) + 50;
    } while (obstacleBlocked(spawnX, spawnY) && ++attempts < 20);

    players[socket.id] = {
      x: spawnX, y: spawnY,
      color: `hsl(${Math.random() * 360}, 70%, 65%)`,
      nickname: currentNickname,
      isIt: false, sprinting: false, immuneUntil: 0,
    };

    if (!itPlayerId || !players[itPlayerId]) {
      itPlayerId = socket.id;
      players[socket.id].isIt = true;
    }

    const init = {};
    const now  = Date.now();
    for (const id in players) {
      const p = players[id];
      init[id] = { x: p.x, y: p.y, color: p.color, nickname: p.nickname, isIt: p.isIt, immune: now < (p.immuneUntil || 0) };
    }

    socket.emit('currentPlayers', {
      players: init, itId: itPlayerId,
      playerCount: Object.keys(players).length,
      obstacles,
      timer: {
        state:    roundState,
        timeLeft: roundState === 'playing' ? roundTimeLeft : breakTimeLeft,
        roundNumber,
      },
      event: {
        id:       currentEvent.id,
        name:     currentEvent.name,
        timeLeft: eventTimeLeft,
      },
    });

    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });
    io.emit('playerCount', Object.keys(players).length);
    console.log(`🏷️  ${currentNickname} joined. Total: ${Object.keys(players).length}`);
  });

  socket.on('move', (data) => {
    if (roundState !== 'playing') return;
    const p = players[socket.id];
    if (!p) return;

    const speed  = (data.sprint ? BASE_SPEED * SPRINT_MULT : BASE_SPEED) * currentEvent.speedMult;
    let dx = (data.right ? 1 : 0) - (data.left ? 1 : 0);
    let dy = (data.down  ? 1 : 0) - (data.up   ? 1 : 0);
    if (dx || dy) { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }

    const nx = Math.max(PLAYER_RADIUS, Math.min(CANVAS_W - PLAYER_RADIUS, p.x + dx * speed));
    const ny = Math.max(PLAYER_RADIUS, Math.min(CANVAS_H - PLAYER_RADIUS, p.y + dy * speed));

    const isGhost = currentEvent.ghostNonIt && socket.id !== itPlayerId;
    if (isGhost) {
      p.x = nx; p.y = ny;
    } else {
      if      (!obstacleBlocked(nx, ny))  { p.x = nx; p.y = ny; }
      else if (!obstacleBlocked(nx, p.y)) { p.x = nx; }
      else if (!obstacleBlocked(p.x, ny)) { p.y = ny; }
    }

    p.sprinting = !!data.sprint;
  });

  socket.on('disconnect', () => {
    console.log(`🔴 ${currentNickname} left`);
    const wasIt = itPlayerId === socket.id;
    delete players[socket.id];
    if (wasIt && roundState === 'playing') {
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
