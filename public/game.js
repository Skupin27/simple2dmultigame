// public/game.js
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// DOM elements
const modal = document.getElementById('nicknameModal');
const gameHud = document.getElementById('gameHud');
const toastDiv = document.getElementById('toastMsg');
const itDisplaySpan = document.getElementById('itDisplay');
const nicknameInput = document.getElementById('nicknameInput');
const joinBtn = document.getElementById('joinGameBtn');

let socket = null;
let localPlayerId = null;
let localNickname = '';

// World state
let remotePlayers = {};     // { id: { x, y, color, nickname, isIt } }
let itPlayerId = null;

// Smooth interpolation targets
let playerTargets = {};

// Input tracking (movement + sprint)
const keys = {
  ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  KeyA: false, KeyD: false, KeyW: false, KeyS: false,
  ShiftLeft: false, ShiftRight: false
};

let moveInterval = null;
let animationId = null;

// Helper: toast message
function showToast(msg, duration = 2000) {
  toastDiv.textContent = msg;
  toastDiv.classList.remove('hidden');
  setTimeout(() => toastDiv.classList.add('hidden'), duration);
}

// Update HUD with current IT nickname
function updateHUD() {
  if (!itPlayerId || !remotePlayers[itPlayerId]) {
    itDisplaySpan.textContent = `🎯 IT: nobody`;
    return;
  }
  const itName = remotePlayers[itPlayerId].nickname || 'unknown';
  itDisplaySpan.textContent = `🎯 IT: ${itName}`;
}

// Game state from server (players + IT id)
function onGameState(data) {
  const { players, itId } = data;
  itPlayerId = itId;

  for (let id in players) {
    const p = players[id];
    if (!remotePlayers[id]) {
      remotePlayers[id] = { ...p };
      playerTargets[id] = { x: p.x, y: p.y };
    } else {
      remotePlayers[id].nickname = p.nickname;
      remotePlayers[id].color = p.color;
      remotePlayers[id].isIt = (id === itId);
      if (playerTargets[id]) {
        playerTargets[id].x = p.x;
        playerTargets[id].y = p.y;
      } else {
        playerTargets[id] = { x: p.x, y: p.y };
      }
    }
  }

  // Cleanup disconnected players
  for (let id in remotePlayers) {
    if (!players[id]) {
      delete remotePlayers[id];
      delete playerTargets[id];
    }
  }

  updateHUD();

  // Notify local player if they become IT
  if (localPlayerId && itPlayerId === localPlayerId) {
    if (!window._itFlagNotified) {
      showToast("🔥 YOU ARE IT! Chase & tag others! 🔥", 2000);
      window._itFlagNotified = true;
    }
  } else {
    window._itFlagNotified = false;
  }
}

function onNewPlayer(playerData) {
  remotePlayers[playerData.id] = {
    x: playerData.x,
    y: playerData.y,
    color: playerData.color,
    nickname: playerData.nickname,
    isIt: false
  };
  playerTargets[playerData.id] = { x: playerData.x, y: playerData.y };
}

function onPlayerDisconnected(id) {
  delete remotePlayers[id];
  delete playerTargets[id];
}

function onCurrentPlayers(data) {
  remotePlayers = data.players;
  itPlayerId = data.itId;
  localPlayerId = socket.id;

  for (let id in remotePlayers) {
    playerTargets[id] = { x: remotePlayers[id].x, y: remotePlayers[id].y };
  }
  updateHUD();
}

// ----- SEND MOVEMENT + SPRINT -----
function sendMovement() {
  if (!localPlayerId) return;

  const move = {
    left: keys.ArrowLeft || keys.KeyA,
    right: keys.ArrowRight || keys.KeyD,
    up: keys.ArrowUp || keys.KeyW,
    down: keys.ArrowDown || keys.KeyS,
    sprint: keys.ShiftLeft || keys.ShiftRight
  };
  socket.emit('move', move);
}

// ----- RENDERING with interpolation + TAG visuals -----
function lerp(start, end, factor) {
  return start + (end - start) * factor;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw grid effect (light lines)
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < canvas.width; i += 50) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(canvas.width, i);
    ctx.stroke();
  }

  for (let id in remotePlayers) {
    const player = remotePlayers[id];
    let drawX = player.x;
    let drawY = player.y;

    // Interpolate remote players (smooth follow)
    if (playerTargets[id] && id !== localPlayerId) {
      const target = playerTargets[id];
      player.x = lerp(player.x, target.x, 0.28);
      player.y = lerp(player.y, target.y, 0.28);
      drawX = player.x;
      drawY = player.y;
    } else if (id === localPlayerId && playerTargets[id]) {
      // Local: snap to server position (server authoritative)
      drawX = playerTargets[id].x;
      drawY = playerTargets[id].y;
    }

    // Draw shadow
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 8;

    // Glow if IT
    if (player.isIt) {
      ctx.shadowColor = '#ff884d';
      ctx.shadowBlur = 18;
    }

    // Circle body
    ctx.beginPath();
    ctx.arc(drawX, drawY, 10, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = player.isIt ? '#ffaa33' : '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // IT crown / mark
    if (player.isIt) {
      ctx.font = 'bold 22px "Segoe UI"';
      ctx.fillStyle = '#FFD966';
      ctx.shadowBlur = 8;
      ctx.fillText('👑', drawX - 12, drawY - 22);
    }

    // Nickname label
    ctx.font = 'bold 14px "Segoe UI"';
    ctx.fillStyle = '#f0f3f8';
    ctx.shadowBlur = 3;
    ctx.shadowColor = '#000000aa';
    ctx.textAlign = 'center';
    let displayName = player.nickname ? (player.nickname.length > 12 ? player.nickname.slice(0, 10) + '..' : player.nickname) : 'anon';
    if (id === localPlayerId) displayName = `✨ ${displayName} ✨`;
    ctx.fillText(displayName, drawX, drawY - 28);

    // Sprint effect particles (local only hint)
    if (id === localPlayerId && (keys.ShiftLeft || keys.ShiftRight)) {
      ctx.beginPath();
      ctx.arc(drawX - 8, drawY + 4, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffaa55aa';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(drawX + 10, drawY + 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.shadowBlur = 0;
  requestAnimationFrame(draw);
}

// ----- KEYBOARD HANDLERS -----
function handleKeyDown(e) {
  if (document.activeElement === nicknameInput) return;
  const code = e.code;
  if (keys.hasOwnProperty(code)) {
    keys[code] = true;
    e.preventDefault();
  }
}

function handleKeyUp(e) {
  if (document.activeElement === nicknameInput) return;
  const code = e.code;
  if (keys.hasOwnProperty(code)) {
    keys[code] = false;
    e.preventDefault();
  }
}

// ----- INITIALIZE SOCKET & GAME AFTER NICKNAME -----
function initGame(nickname) {
  localNickname = nickname;
  socket = io();

  socket.on('connect', () => {
    socket.emit('setNickname', localNickname);
  });

  socket.on('currentPlayers', onCurrentPlayers);
  socket.on('newPlayer', onNewPlayer);
  socket.on('playerDisconnected', onPlayerDisconnected);
  socket.on('gameState', onGameState);
  socket.on('itChanged', (data) => {
    showToast(`${data.newItNickname} is now IT!`, 1500);
  });

  // Start sending movement 30 times/sec
  if (moveInterval) clearInterval(moveInterval);
  moveInterval = setInterval(() => sendMovement(), 1000 / 30);

  // Start render loop
  if (animationId) cancelAnimationFrame(animationId);
  animationId = requestAnimationFrame(draw);

  // UI transition
  modal.classList.add('hidden');
  gameHud.classList.remove('hidden');
}

// ----- EVENT LISTENERS FOR MODAL -----
joinBtn.addEventListener('click', () => {
  let nickname = nicknameInput.value.trim();
  if (nickname === '') nickname = `Runner_${Math.floor(Math.random() * 1000)}`;
  if (nickname.length > 14) nickname = nickname.slice(0, 14);
  initGame(nickname);
});

nicknameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    let nickname = nicknameInput.value.trim();
    if (nickname === '') nickname = `Runner_${Math.floor(Math.random() * 1000)}`;
    if (nickname.length > 14) nickname = nickname.slice(0, 14);
    initGame(nickname);
  }
});

window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', handleKeyUp);
