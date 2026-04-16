// public/game.js
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

const modal          = document.getElementById('nicknameModal');
const gameHud        = document.getElementById('gameHud');
const toastDiv       = document.getElementById('toastMsg');
const itDisplaySpan  = document.getElementById('itDisplay');
const playerCountSpan = document.getElementById('playerCount');
const nicknameInput  = document.getElementById('nicknameInput');
const joinBtn        = document.getElementById('joinGameBtn');

let socket        = null;
let localPlayerId = null;
let localNickname = '';

let remotePlayers = {};
let playerTargets = {};
let itPlayerId    = null;

// ── Client-side prediction ───────────────────────────────────────────────────
const BASE_SPEED    = 10;
const SPRINT_MULT   = 1.5;
const CANVAS_W      = 1100;
const CANVAS_H      = 750;
const PLAYER_RADIUS = 10;

let localPos            = { x: 0, y: 0 };
let serverPos           = { x: 0, y: 0 };
let localPosReady       = false;

// Must match server
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

// ── Tag log ──────────────────────────────────────────────────────────────────
const tagLog    = [];
const LOG_MAX   = 4;
const LOG_TTL   = 6000;

function addLog(text) {
  tagLog.unshift({ text, ts: Date.now() });
  if (tagLog.length > LOG_MAX) tagLog.pop();
}

// ── Keys ─────────────────────────────────────────────────────────────────────
const keys = {
  ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  KeyA: false, KeyD: false, KeyW: false, KeyS: false,
  ShiftLeft: false, ShiftRight: false
};

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 2000) {
  toastDiv.textContent = msg;
  toastDiv.classList.remove('hidden');
  setTimeout(() => toastDiv.classList.add('hidden'), ms);
}

// ── HUD ──────────────────────────────────────────────────────────────────────
function updateHUD() {
  const name = (itPlayerId && remotePlayers[itPlayerId])
    ? remotePlayers[itPlayerId].nickname || 'unknown'
    : 'nobody';
  itDisplaySpan.textContent = `IT: ${name}`;
}

// ── Socket event handlers ────────────────────────────────────────────────────
function onCurrentPlayers(data) {
  remotePlayers = data.players;
  itPlayerId    = data.itId;
  localPlayerId = socket.id;

  for (const id in remotePlayers) {
    playerTargets[id] = { x: remotePlayers[id].x, y: remotePlayers[id].y };
  }

  if (remotePlayers[localPlayerId]) {
    localPos.x  = remotePlayers[localPlayerId].x;
    localPos.y  = remotePlayers[localPlayerId].y;
    serverPos.x = localPos.x;
    serverPos.y = localPos.y;
    localPosReady = true;
  }

  if (playerCountSpan && data.playerCount != null)
    playerCountSpan.textContent = `${data.playerCount} online`;

  updateHUD();
}

function onGameState(data) {
  const { players, itId, playerCount } = data;
  itPlayerId = itId;

  if (playerCountSpan && playerCount != null)
    playerCountSpan.textContent = `${playerCount} online`;

  for (const id in players) {
    const p = players[id];
    if (!remotePlayers[id]) {
      remotePlayers[id]  = { ...p };
      playerTargets[id]  = { x: p.x, y: p.y };
    } else {
      Object.assign(remotePlayers[id], { nickname: p.nickname, color: p.color, isIt: p.isIt, immune: p.immune });
      playerTargets[id] = { x: p.x, y: p.y };
    }
  }

  // Authoritative server position for local reconciliation
  if (localPlayerId && players[localPlayerId]) {
    serverPos.x = players[localPlayerId].x;
    serverPos.y = players[localPlayerId].y;
  }

  for (const id in remotePlayers) {
    if (!players[id]) { delete remotePlayers[id]; delete playerTargets[id]; }
  }

  updateHUD();

  if (localPlayerId && itPlayerId === localPlayerId) {
    if (!window._wasIt) { showToast('YOU ARE IT — go tag someone!', 2200); window._wasIt = true; }
  } else {
    window._wasIt = false;
  }
}

function onNewPlayer(pd) {
  remotePlayers[pd.id] = { ...pd, isIt: false, immune: false };
  playerTargets[pd.id] = { x: pd.x, y: pd.y };
}

function onPlayerDisconnected(id) {
  delete remotePlayers[id];
  delete playerTargets[id];
}

// ── Movement (with client-side prediction) ───────────────────────────────────
function sendMovement() {
  if (!localPlayerId || !localPosReady) return;

  const move = {
    left:   keys.ArrowLeft  || keys.KeyA,
    right:  keys.ArrowRight || keys.KeyD,
    up:     keys.ArrowUp    || keys.KeyW,
    down:   keys.ArrowDown  || keys.KeyS,
    sprint: keys.ShiftLeft  || keys.ShiftRight
  };

  // Mirror server movement locally
  const speed = move.sprint ? BASE_SPEED * SPRINT_MULT : BASE_SPEED;
  let dx = (move.right ? 1 : 0) - (move.left ? 1 : 0);
  let dy = (move.down  ? 1 : 0) - (move.up   ? 1 : 0);
  if (dx || dy) { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }

  const nx = Math.max(PLAYER_RADIUS, Math.min(CANVAS_W - PLAYER_RADIUS, localPos.x + dx * speed));
  const ny = Math.max(PLAYER_RADIUS, Math.min(CANVAS_H - PLAYER_RADIUS, localPos.y + dy * speed));

  if      (!obstacleBlocked(nx, ny))       { localPos.x = nx; localPos.y = ny; }
  else if (!obstacleBlocked(nx, localPos.y)) { localPos.x = nx; }
  else if (!obstacleBlocked(localPos.x, ny)) { localPos.y = ny; }

  socket.emit('move', move);
}

// ── Render ───────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }

function drawObstacles() {
  for (const o of OBSTACLES) {
    ctx.fillStyle   = '#ffffff';
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth   = 1;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  }
}

function drawTagLog() {
  const now = Date.now();
  ctx.font      = '11px "DM Mono", monospace';
  ctx.textAlign = 'left';
  let y = CANVAS_H - 14;
  for (const entry of tagLog) {
    const alpha = Math.max(0, 1 - (now - entry.ts) / LOG_TTL);
    if (alpha <= 0) continue;
    ctx.fillStyle = `rgba(160, 190, 160, ${alpha * 0.65})`;
    ctx.fillText(entry.text, 14, y);
    y -= 17;
  }
}

function draw() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Grid
  ctx.strokeStyle = '#161616';
  ctx.lineWidth   = 0.5;
  for (let i = 0; i < CANVAS_W; i += 50) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_H); ctx.stroke();
  }
  for (let j = 0; j < CANVAS_H; j += 50) {
    ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(CANVAS_W, j); ctx.stroke();
  }

  drawObstacles();

  // Reconcile local prediction with server
  if (localPlayerId && localPosReady) {
    const drift = Math.hypot(serverPos.x - localPos.x, serverPos.y - localPos.y);
    if (drift > 120) {
      localPos.x = serverPos.x; localPos.y = serverPos.y;
    } else {
      localPos.x = lerp(localPos.x, serverPos.x, 0.07);
      localPos.y = lerp(localPos.y, serverPos.y, 0.07);
    }
  }

  for (const id in remotePlayers) {
    const player = remotePlayers[id];
    const isLocal  = id === localPlayerId;
    const isIt     = player.isIt;
    const isImmune = player.immune;

    let drawX, drawY;
    if (isLocal) {
      drawX = localPos.x;
      drawY = localPos.y;
    } else {
      if (playerTargets[id]) {
        player.x = lerp(player.x, playerTargets[id].x, 0.28);
        player.y = lerp(player.y, playerTargets[id].y, 0.28);
      }
      drawX = player.x;
      drawY = player.y;
    }

    // Immunity flicker
    if (isImmune) ctx.globalAlpha = (Math.sin(Date.now() / 70) > 0) ? 0.4 : 1.0;

    // IT glow
    ctx.shadowColor = isIt ? '#ff5c3a' : 'transparent';
    ctx.shadowBlur  = isIt ? 16 : 0;

    // Body
    ctx.beginPath();
    ctx.arc(drawX, drawY, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = isIt ? '#ff5c3a' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = isIt ? 2.5 : 1.5;
    ctx.stroke();

    ctx.shadowBlur   = 0;
    ctx.globalAlpha  = 1;

    // "IT" label above player
    ctx.textAlign = 'center';
    if (isIt) {
      ctx.font      = 'bold 11px "DM Mono", monospace';
      ctx.fillStyle = '#ff5c3a';
      ctx.fillText('IT', drawX, drawY - 17);
    }

    // Nickname
    ctx.font      = '11px "DM Mono", monospace';
    ctx.fillStyle = isLocal ? '#c8f060' : 'rgba(210,210,210,0.75)';
    let label = player.nickname ? (player.nickname.length > 12 ? player.nickname.slice(0, 10) + '..' : player.nickname) : 'anon';
    ctx.fillText(label, drawX, drawY - (isIt ? 28 : 22));
  }

  drawTagLog();
  requestAnimationFrame(draw);
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (document.activeElement === nicknameInput) return;
  if (keys.hasOwnProperty(e.code)) { keys[e.code] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (document.activeElement === nicknameInput) return;
  if (keys.hasOwnProperty(e.code)) { keys[e.code] = false; e.preventDefault(); }
});

// ── Touch joystick ───────────────────────────────────────────────────────────
function initTouchControls() {
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const joystick  = document.getElementById('joystick');
  const thumb     = document.getElementById('joystickThumb');
  const sprintBtn = document.getElementById('sprintBtn');
  if (!joystick) return;

  joystick.style.display  = 'block';
  sprintBtn.style.display = 'flex';

  const MAX = 38;
  const DEAD = 8;
  let startX = 0, startY = 0, active = false;

  joystick.addEventListener('touchstart', (e) => {
    e.preventDefault();
    active = true;
    const r = joystick.getBoundingClientRect();
    startX = r.left + r.width  / 2;
    startY = r.top  + r.height / 2;
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!active) return;
    e.preventDefault();
    const t  = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dist = Math.min(Math.hypot(dx, dy), MAX);
    const angle = Math.atan2(dy, dx);
    thumb.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;
    keys.KeyA = dx < -DEAD;
    keys.KeyD = dx >  DEAD;
    keys.KeyW = dy < -DEAD;
    keys.KeyS = dy >  DEAD;
  }, { passive: false });

  const endTouch = () => {
    if (!active) return;
    active = false;
    thumb.style.transform = 'translate(0,0)';
    keys.KeyA = keys.KeyD = keys.KeyW = keys.KeyS = false;
  };
  document.addEventListener('touchend',   endTouch);
  document.addEventListener('touchcancel', endTouch);

  sprintBtn.addEventListener('touchstart', (e) => { e.preventDefault(); keys.ShiftLeft = true;  }, { passive: false });
  sprintBtn.addEventListener('touchend',   (e) => { e.preventDefault(); keys.ShiftLeft = false; }, { passive: false });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initGame(nickname) {
  localNickname = nickname;
  socket = io();

  socket.on('connect',           () => socket.emit('setNickname', localNickname));
  socket.on('currentPlayers',    onCurrentPlayers);
  socket.on('newPlayer',         onNewPlayer);
  socket.on('playerDisconnected', onPlayerDisconnected);
  socket.on('gameState',         onGameState);
  socket.on('playerCount',       (n) => { if (playerCountSpan) playerCountSpan.textContent = `${n} online`; });
  socket.on('itChanged', (data) => {
    const msg = data.taggerNickname
      ? `${data.taggerNickname} tagged ${data.newItNickname}`
      : `${data.newItNickname} is now IT`;
    showToast(msg, 1800);
    addLog(msg);
  });

  setInterval(sendMovement, 1000 / 30);
  requestAnimationFrame(draw);

  modal.classList.add('hidden');
  gameHud.classList.remove('hidden');
  initTouchControls();
}

const startGame = () => {
  let n = nicknameInput.value.trim() || `Runner_${Math.floor(Math.random() * 1000)}`;
  initGame(n.slice(0, 14));
};
joinBtn.addEventListener('click', startGame);
nicknameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') startGame(); });
