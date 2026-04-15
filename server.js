// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const TICK_RATE = 30;          // 30 updates per second (tag detection)
const BASE_SPEED = 5.0;
const SPRINT_MULTIPLIER = 2.5;
const CANVAS_W = 1300;
const CANVAS_H = 850;
const PLAYER_RADIUS = 15;

let players = {};      // id -> { x, y, color, nickname, isIt, sprinting }
let itPlayerId = null;

// Helper: assign random IT if none exists or IT disconnects
function assignRandomIt() {
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) {
    itPlayerId = null;
    return;
  }
  if (itPlayerId && players[itPlayerId]) return; // already valid IT
  const randomId = playerIds[Math.floor(Math.random() * playerIds.length)];
  itPlayerId = randomId;
  if (players[randomId]) players[randomId].isIt = true;
}

// Tag logic: check distance between IT and every other player
function checkTagCollisions() {
  if (!itPlayerId || !players[itPlayerId]) return false;
  const it = players[itPlayerId];
  let taggedSomeone = false;

  for (let id in players) {
    if (id === itPlayerId) continue;
    const other = players[id];
    const dx = it.x - other.x;
    const dy = it.y - other.y;
    const dist = Math.hypot(dx, dy);
    if (dist < PLAYER_RADIUS * 1.8) {
      // TAG! Transfer IT status
      players[itPlayerId].isIt = false;
      players[id].isIt = true;
      itPlayerId = id;
      taggedSomeone = true;
      
      // Broadcast IT change message
      io.emit('itChanged', { newItNickname: players[id].nickname || 'someone' });
      break;
    }
  }
  return taggedSomeone;
}

// Game loop: move players? Actually movement happens via 'move' events, but we apply speed there.
// However collision must be checked on each tick (server authoritative)
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  
  // First check tag collisions
  const tagged = checkTagCollisions();
  
  // Prepare game state snapshot to broadcast
  const snapshot = {
    players: {},
    itId: itPlayerId
  };
  for (let id in players) {
    snapshot.players[id] = {
      x: players[id].x,
      y: players[id].y,
      color: players[id].color,
      nickname: players[id].nickname,
      isIt: players[id].isIt
    };
  }
  io.emit('gameState', snapshot);
}, 1000 / TICK_RATE);

// Socket handlers
io.on('connection', (socket) => {
  console.log(`🟢 Player connected: ${socket.id}`);

  let currentNickname = 'anonymous';

  socket.on('setNickname', (nickname) => {
    currentNickname = nickname.slice(0, 14);
    // Spawn player at random safe position
    const spawnX = Math.random() * (CANVAS_W - 100) + 50;
    const spawnY = Math.random() * (CANVAS_H - 100) + 50;
    const hue = Math.random() * 360;
    const color = `hsl(${hue}, 75%, 65%)`;

    players[socket.id] = {
      x: spawnX,
      y: spawnY,
      color: color,
      nickname: currentNickname,
      isIt: false,
      sprinting: false
    };

    // If no IT exists, assign first player as IT
    if (itPlayerId === null || !players[itPlayerId]) {
      itPlayerId = socket.id;
      players[socket.id].isIt = true;
    }

    // Send current game state to new player
    const initialPlayers = {};
    for (let id in players) {
      initialPlayers[id] = {
        x: players[id].x,
        y: players[id].y,
        color: players[id].color,
        nickname: players[id].nickname,
        isIt: players[id].isIt
      };
    }
    socket.emit('currentPlayers', { players: initialPlayers, itId: itPlayerId });

    // Notify others about new player
    socket.broadcast.emit('newPlayer', {
      id: socket.id,
      x: players[socket.id].x,
      y: players[socket.id].y,
      color: players[socket.id].color,
      nickname: players[socket.id].nickname
    });

    console.log(`🏷️ ${currentNickname} (${socket.id}) joined. IT: ${itPlayerId}`);
  });

  // Movement with sprint
  socket.on('move', (data) => {
    const player = players[socket.id];
    if (!player) return;

    const speed = (data.sprint ? BASE_SPEED * SPRINT_MULTIPLIER : BASE_SPEED);
    let dx = 0, dy = 0;
    if (data.left) dx = -1;
    if (data.right) dx = 1;
    if (data.up) dy = -1;
    if (data.down) dy = 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    }
    player.x += dx * speed;
    player.y += dy * speed;

    // Boundaries with padding
    player.x = Math.max(PLAYER_RADIUS, Math.min(CANVAS_W - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(CANVAS_H - PLAYER_RADIUS, player.y));
    player.sprinting = data.sprint || false;
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Player disconnected: ${socket.id} (${currentNickname})`);
    const wasIt = (itPlayerId === socket.id);
    delete players[socket.id];

    if (wasIt) {
      // Reassign IT to a random remaining player
      const remainingIds = Object.keys(players);
      if (remainingIds.length > 0) {
        const newIt = remainingIds[Math.floor(Math.random() * remainingIds.length)];
        itPlayerId = newIt;
        players[newIt].isIt = true;
        io.emit('itChanged', { newItNickname: players[newIt].nickname });
      } else {
        itPlayerId = null;
      }
    }
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Tag It server running on http://localhost:${PORT}`);
});
