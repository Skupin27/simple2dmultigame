const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const socket = io();

// Input state
const keys = {
  ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  KeyA: false, KeyD: false, KeyW: false, KeyS: false
};

// Local player reference
let localPlayerId = null;

// All players received from server
let remotePlayers = {};

// Smoothing: store previous and target positions for interpolation
let playerTargets = {};

// ----- Network event handlers -----
socket.on('currentPlayers', (players) => {
  remotePlayers = players;
  localPlayerId = socket.id;
  // Initialize interpolation targets
  for (let id in players) {
    playerTargets[id] = { x: players[id].x, y: players[id].y };
  }
});

socket.on('newPlayer', (player) => {
  remotePlayers[player.id] = player;
  playerTargets[player.id] = { x: player.x, y: player.y };
});

socket.on('playerDisconnected', (id) => {
  delete remotePlayers[id];
  delete playerTargets[id];
});

socket.on('gameState', (serverPlayers) => {
  // Update target positions for interpolation
  for (let id in serverPlayers) {
    if (!playerTargets[id]) {
      playerTargets[id] = { x: serverPlayers[id].x, y: serverPlayers[id].y };
    } else {
      playerTargets[id].x = serverPlayers[id].x;
      playerTargets[id].y = serverPlayers[id].y;
    }
    // Also update color if changed (rare)
    remotePlayers[id] = serverPlayers[id];
  }
});

// ----- Input handling -----
function handleKeyDown(e) {
  if (e.code in keys) {
    keys[e.code] = true;
    e.preventDefault();
  }
}
function handleKeyUp(e) {
  if (e.code in keys) {
    keys[e.code] = false;
    e.preventDefault();
  }
}
window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', handleKeyUp);

// Send movement input 30 times per second
setInterval(() => {
  const move = {
    left: keys.ArrowLeft || keys.KeyA,
    right: keys.ArrowRight || keys.KeyD,
    up: keys.ArrowUp || keys.KeyW,
    down: keys.ArrowDown || keys.KeyS
  };
  socket.emit('move', move);
}, 1000 / 30);

// ----- Rendering with interpolation -----
function lerp(start, end, amt) {
  return (1 - amt) * start + amt * end;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw all players
  for (let id in remotePlayers) {
    const player = remotePlayers[id];
    let drawX = player.x;
    let drawY = player.y;

    // Interpolate between current and target for smooth motion
    if (playerTargets[id]) {
      // Only interpolate remote players, not local (we want immediate response)
      if (id !== localPlayerId) {
        const target = playerTargets[id];
        // Move 30% toward target each frame for smoothness
        player.x = lerp(player.x, target.x, 0.3);
        player.y = lerp(player.y, target.y, 0.3);
        drawX = player.x;
        drawY = player.y;
      } else {
        // For local player, snap to target (server authoritative but we already moved optimistically)
        drawX = playerTargets[id].x;
        drawY = playerTargets[id].y;
      }
    }

    // Draw circle
    ctx.beginPath();
    ctx.arc(drawX, drawY, 20, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw player ID (first 4 chars)
    ctx.fillStyle = '#fff';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(id === localPlayerId ? 'YOU' : id.substr(0,4), drawX, drawY - 25);
  }

  requestAnimationFrame(draw);
}

draw();