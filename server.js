const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const players = {}; // Store player data: { id: { x, y, color } }
const TICK_RATE = 20; // Updates per second

// Game loop – broadcast state to all clients
setInterval(() => {
  io.emit('gameState', players);
}, 1000 / TICK_RATE);

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Initialize new player at random position
  players[socket.id] = {
    x: Math.random() * 800,
    y: Math.random() * 600,
    color: `hsl(${Math.random() * 360}, 80%, 60%)`
  };

  // Send current players to the new client
  socket.emit('currentPlayers', players);

  // Notify others about the new player
  socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

  // Handle player movement input
  socket.on('move', (direction) => {
    const player = players[socket.id];
    if (!player) return;

    const SPEED = 5;
    if (direction.left) player.x -= SPEED;
    if (direction.right) player.x += SPEED;
    if (direction.up) player.y -= SPEED;
    if (direction.down) player.y += SPEED;

    // Keep within canvas bounds (optional)
    player.x = Math.max(20, Math.min(780, player.x));
    player.y = Math.max(20, Math.min(580, player.y));
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));