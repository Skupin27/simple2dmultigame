// public/game.js
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

const modal           = document.getElementById('nicknameModal');
const gameHud         = document.getElementById('gameHud');
const toastDiv        = document.getElementById('toastMsg');
const itDisplaySpan   = document.getElementById('itDisplay');
const playerCountSpan = document.getElementById('playerCount');
const timerSpan       = document.getElementById('timerDisplay');
const roundSpan       = document.getElementById('roundDisplay');
const nicknameInput   = document.getElementById('nicknameInput');
const joinBtn         = document.getElementById('joinGameBtn');
const breakOverlay    = document.getElementById('breakOverlay');
const breakCountdown  = document.getElementById('breakCountdown');
const breakItName     = document.getElementById('breakItName');
const breakRoundNum   = document.getElementById('breakRoundNum');

let socket        = null;
let localPlayerId = null;
let localNickname = '';

let remotePlayers = {};
let playerTargets = {};
let itPlayerId    = null;

// ── Timer state ───────────────────────────────────────────────────────────────
let timerState    = 'playing';
let timerTimeLeft = 300;
let timerRound    = 1;

// ── Event state ───────────────────────────────────────────────────────────────
let currentEvent     = 'normal';
let eventName        = 'Normal';
let eventTimeLeft    = 20;
let eventChangedAt   = 0;    // timestamp of last event change, for banner animation

// ── Client-side constants ─────────────────────────────────────────────────────
const BASE_SPEED    = 10;
const SPRINT_MULT   = 1.5;
const CANVAS_W      = 1100;
const CANVAS_H      = 750;
const PLAYER_RADIUS = 10;

let localPos      = { x: 0, y: 0 };
let serverPos     = { x: 0, y: 0 };
let localPosReady = false;

// ── Obstacles (synced from server) ───────────────────────────────────────────
let obstacles = [];
let wallsChangedAt = 0;
const WALL_FLASH_MS = 700;

function obstacleBlocked(px, py) {
  for (const o of obstacles) {
    const cx = Math.max(o.x, Math.min(px, o.x + o.w));
    const cy = Math.max(o.y, Math.min(py, o.y + o.h));
    if (Math.hypot(px - cx, py - cy) < PLAYER_RADIUS) return true;
  }
  return false;
}

// ── Darkness overlay canvas ──────────────────────────────────────────────────
const darknessCanvas = document.createElement('canvas');
darknessCanvas.width  = CANVAS_W;
darknessCanvas.height = CANVAS_H;
const dCtx = darknessCanvas.getContext('2d');

function applyDarknessOverlay(px, py) {
  const LIGHT_RADIUS = 145;
  dCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  dCtx.fillStyle = 'rgba(0,0,0,0.96)';
  dCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  dCtx.globalCompositeOperation = 'destination-out';
  const grd = dCtx.createRadialGradient(px, py, 0, px, py, LIGHT_RADIUS);
  grd.addColorStop(0,    'rgba(0,0,0,1)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  grd.addColorStop(1,    'rgba(0,0,0,0)');
  dCtx.fillStyle = grd;
  dCtx.beginPath();
  dCtx.arc(px, py, LIGHT_RADIUS, 0, Math.PI * 2);
  dCtx.fill();
  dCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(darknessCanvas, 0, 0);
}

// ── Blizzard particles ───────────────────────────────────────────────────────
const blizzardParticles = [];

function updateBlizzardParticles() {
  // Spawn new flakes
  if (Math.random() < 0.35) {
    blizzardParticles.push({
      x:     Math.random() < 0.6 ? -5 : Math.random() * CANVAS_W,
      y:     Math.random() < 0.4 ?  Math.random() * CANVAS_H : -5,
      vx:    2.5 + Math.random() * 3,
      vy:    0.8 + Math.random() * 1.8,
      size:  0.8 + Math.random() * 2.5,
      alpha: 0.25 + Math.random() * 0.5,
    });
  }
  for (let i = blizzardParticles.length - 1; i >= 0; i--) {
    const p = blizzardParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    if (p.x > CANVAS_W + 10 || p.y > CANVAS_H + 10) blizzardParticles.splice(i, 1);
  }
}

function drawBlizzard() {
  ctx.save();
  for (const p of blizzardParticles) {
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle   = '#c8f0ff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Tag log ───────────────────────────────────────────────────────────────────
const tagLog  = [];
const LOG_MAX = 4;
const LOG_TTL = 6000;

function addLog(text) {
  tagLog.unshift({ text, ts: Date.now() });
  if (tagLog.length > LOG_MAX) tagLog.pop();
}

// ── Keys ──────────────────────────────────────────────────────────────────────
const keys = {
  ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  KeyA: false, KeyD: false, KeyW: false, KeyS: false,
  ShiftLeft: false, ShiftRight: false,
};

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 2000) {
  toastDiv.textContent = msg;
  toastDiv.classList.remove('hidden');
  setTimeout(() => toastDiv.classList.add('hidden'), ms);
}

// ── Timer helpers ─────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimerHUD() {
  if (!timerSpan || !roundSpan) return;
  roundSpan.textContent = `R${timerRound}`;
  if (timerState === 'playing') {
    timerSpan.textContent = formatTime(timerTimeLeft);
    timerSpan.classList.toggle('timer-urgent', timerTimeLeft <= 30);
  } else {
    timerSpan.textContent = `${timerTimeLeft}s`;
    timerSpan.classList.remove('timer-urgent');
  }
}

function showBreakOverlay(itName, nextRound, countdown) {
  if (!breakOverlay) return;
  breakItName.textContent   = itName;
  breakRoundNum.textContent = nextRound;
  breakCountdown.textContent = countdown;
  breakOverlay.classList.remove('hidden');
}

function hideBreakOverlay() {
  if (breakOverlay) breakOverlay.classList.add('hidden');
}

function updateBreakCountdown(secs) {
  if (breakCountdown) breakCountdown.textContent = secs;
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHUD() {
  const name = (itPlayerId && remotePlayers[itPlayerId])
    ? remotePlayers[itPlayerId].nickname || 'unknown'
    : 'nobody';
  itDisplaySpan.textContent = `IT: ${name}`;
}

// ── Socket event handlers ─────────────────────────────────────────────────────
function onCurrentPlayers(data) {
  remotePlayers = data.players;
  itPlayerId    = data.itId;
  localPlayerId = socket.id;

  for (const id in remotePlayers) {
    playerTargets[id] = { x: remotePlayers[id].x, y: remotePlayers[id].y };
  }

  if (remotePlayers[localPlayerId]) {
    localPos.x    = remotePlayers[localPlayerId].x;
    localPos.y    = remotePlayers[localPlayerId].y;
    serverPos.x   = localPos.x;
    serverPos.y   = localPos.y;
    localPosReady = true;
  }

  if (data.obstacles && data.obstacles.length) {
    obstacles = data.obstacles;
  }

  if (playerCountSpan && data.playerCount != null)
    playerCountSpan.textContent = `${data.playerCount} online`;

  if (data.timer) {
    timerState    = data.timer.state;
    timerTimeLeft = data.timer.timeLeft;
    timerRound    = data.timer.roundNumber;
    updateTimerHUD();
  }

  if (data.event) {
    currentEvent  = data.event.id;
    eventName     = data.event.name;
    eventTimeLeft = data.event.timeLeft;
  }

  updateHUD();
}

function onGameState(data) {
  const { players, itId, playerCount, timer, event } = data;
  itPlayerId = itId;

  if (playerCountSpan && playerCount != null)
    playerCountSpan.textContent = `${playerCount} online`;

  if (timer) {
    timerState    = timer.state;
    timerTimeLeft = timer.timeLeft;
    timerRound    = timer.roundNumber;
    updateTimerHUD();
    if (timerState === 'break') updateBreakCountdown(timerTimeLeft);
  }

  if (event) {
    currentEvent  = event.id;
    eventName     = event.name;
    eventTimeLeft = event.timeLeft;
  }

  for (const id in players) {
    const p = players[id];
    if (!remotePlayers[id]) {
      remotePlayers[id] = { ...p };
      playerTargets[id] = { x: p.x, y: p.y };
    } else {
      Object.assign(remotePlayers[id], { nickname: p.nickname, color: p.color, isIt: p.isIt, immune: p.immune });
      playerTargets[id] = { x: p.x, y: p.y };
    }
  }

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

function onRoundEnd(data) {
  timerState = 'break';
  showBreakOverlay(data.itNickname, data.roundNumber + 1, data.breakDuration);
  addLog(`Round ${data.roundNumber} over — ${data.itNickname} was IT`);
}

function onRoundStart(data) {
  timerState    = 'playing';
  timerTimeLeft = 300;
  timerRound    = data.roundNumber;
  currentEvent  = 'normal';
  eventName     = 'Normal';
  hideBreakOverlay();
  showToast(`Round ${data.roundNumber} — ${data.itNickname} is IT!`, 2500);
  addLog(`Round ${data.roundNumber} started`);
  updateTimerHUD();
}

function onNewPlayer(pd) {
  remotePlayers[pd.id] = { ...pd, isIt: false, immune: false };
  playerTargets[pd.id] = { x: pd.x, y: pd.y };
}

function onPlayerDisconnected(id) {
  delete remotePlayers[id];
  delete playerTargets[id];
}

// ── Movement (client-side prediction) ────────────────────────────────────────
function sendMovement() {
  if (!localPlayerId || !localPosReady) return;
  if (timerState !== 'playing') return;

  const inv = (currentEvent === 'invert');
  const move = {
    left:   inv ? (keys.ArrowRight || keys.KeyD) : (keys.ArrowLeft  || keys.KeyA),
    right:  inv ? (keys.ArrowLeft  || keys.KeyA) : (keys.ArrowRight || keys.KeyD),
    up:     inv ? (keys.ArrowDown  || keys.KeyS) : (keys.ArrowUp    || keys.KeyW),
    down:   inv ? (keys.ArrowUp    || keys.KeyW) : (keys.ArrowDown  || keys.KeyS),
    sprint: keys.ShiftLeft || keys.ShiftRight,
  };

  // Client-side prediction speed (mirrors server event speedMult roughly)
  const eventSpeedTable = {
    speed_rush: 1.90, blizzard: 0.60, big_it: 0.80, tiny: 1.30,
  };
  const evMult = eventSpeedTable[currentEvent] || 1.0;
  const speed  = (move.sprint ? BASE_SPEED * SPRINT_MULT : BASE_SPEED) * evMult;

  let dx = (move.right ? 1 : 0) - (move.left ? 1 : 0);
  let dy = (move.down  ? 1 : 0) - (move.up   ? 1 : 0);
  if (dx || dy) { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }

  const nx = Math.max(PLAYER_RADIUS, Math.min(CANVAS_W - PLAYER_RADIUS, localPos.x + dx * speed));
  const ny = Math.max(PLAYER_RADIUS, Math.min(CANVAS_H - PLAYER_RADIUS, localPos.y + dy * speed));

  const isGhost = (currentEvent === 'ghost') && (localPlayerId !== itPlayerId);
  if (isGhost) {
    localPos.x = nx; localPos.y = ny;
  } else {
    if      (!obstacleBlocked(nx, ny))        { localPos.x = nx; localPos.y = ny; }
    else if (!obstacleBlocked(nx, localPos.y)) { localPos.x = nx; }
    else if (!obstacleBlocked(localPos.x, ny)) { localPos.y = ny; }
  }

  socket.emit('move', move);
}

// ── Render helpers ────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }

// Effective player draw radius per event
function playerDrawRadius(isIt) {
  if (currentEvent === 'big_it' && isIt)  return PLAYER_RADIUS * 2.6;
  if (currentEvent === 'tiny')            return PLAYER_RADIUS * 0.5;
  return PLAYER_RADIUS;
}

function drawObstacles() {
  const now      = Date.now();
  const flashAge = now - wallsChangedAt;
  const flashT   = (flashAge < WALL_FLASH_MS) ? 1 - flashAge / WALL_FLASH_MS : 0;

  for (const o of obstacles) {
    // Ghost mode: walls are semi-transparent
    ctx.globalAlpha = (currentEvent === 'ghost') ? 0.35 : 1;

    if (flashT > 0) {
      const b = Math.round(96 * flashT + 255 * (1 - flashT));
      ctx.fillStyle   = `rgb(255,255,${b})`;
      ctx.strokeStyle = `rgba(200,240,96,${flashT * 0.9})`;
      ctx.lineWidth   = 1 + flashT * 2;
    } else {
      ctx.fillStyle   = currentEvent === 'darkness' ? '#3a3a3a' : '#ffffff';
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth   = 1;
    }

    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  }
  ctx.globalAlpha = 1;
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

// Event name banner drawn on canvas
function drawEventBanner() {
  const now     = Date.now();
  const age     = now - eventChangedAt;
  const FADE_IN  = 400;
  const HOLD     = 2000;
  const FADE_OUT = 600;
  const total    = FADE_IN + HOLD + FADE_OUT;
  if (age > total) return;

  let alpha;
  if (age < FADE_IN)                  alpha = age / FADE_IN;
  else if (age < FADE_IN + HOLD)      alpha = 1;
  else                                alpha = 1 - (age - FADE_IN - HOLD) / FADE_OUT;

  const eventColors = {
    normal:     '#aaaaaa',
    darkness:   '#6060c0',
    speed_rush: '#ffdd44',
    ghost:      '#88ddff',
    blizzard:   '#aaddff',
    invert:     '#ff88cc',
    big_it:     '#ff5c3a',
    tiny:       '#88ff88',
    earthquake: '#ff9944',
    phantom_it: '#cc88ff',
  };
  const color = eventColors[currentEvent] || '#c8f060';

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font        = 'bold 22px "DM Mono", monospace';
  ctx.textAlign   = 'center';

  // Shadow / glow
  ctx.shadowColor = color;
  ctx.shadowBlur  = 18;
  ctx.fillStyle   = color;
  ctx.fillText(eventName.toUpperCase(), CANVAS_W / 2, CANVAS_H / 2 - 6);

  ctx.shadowBlur  = 0;
  ctx.font        = '12px "DM Mono", monospace';
  ctx.fillStyle   = 'rgba(200,200,200,0.8)';
  ctx.fillText(`${eventTimeLeft}s`, CANVAS_W / 2, CANVAS_H / 2 + 16);

  ctx.restore();
}

// Persistent event indicator (top-right corner on canvas)
function drawEventIndicator() {
  if (currentEvent === 'normal') return;

  const eventColors = {
    darkness:   '#6060c0',
    speed_rush: '#ffdd44',
    ghost:      '#88ddff',
    blizzard:   '#aaddff',
    invert:     '#ff88cc',
    big_it:     '#ff5c3a',
    tiny:       '#88ff88',
    earthquake: '#ff9944',
    phantom_it: '#cc88ff',
  };

  const eventIcons = {
    darkness:   '🌑',
    speed_rush: '⚡',
    ghost:      '👻',
    blizzard:   '❄',
    invert:     '🔄',
    big_it:     '💥',
    tiny:       '🔬',
    earthquake: '🌋',
    phantom_it: '👁',
  };

  const color = eventColors[currentEvent] || '#c8f060';
  const icon  = eventIcons[currentEvent]  || '?';

  ctx.save();
  ctx.font      = '11px "DM Mono", monospace';
  ctx.textAlign = 'right';

  // Timer bar background
  const barW = 120;
  const barH = 4;
  const bx   = CANVAS_W - 14 - barW;
  const by   = CANVAS_H - 14;
  const fraction = Math.max(0, Math.min(1, eventTimeLeft / 30));

  ctx.fillStyle   = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx, by, barW, barH);
  ctx.fillStyle   = color;
  ctx.fillRect(bx, by, barW * fraction, barH);

  ctx.fillStyle = color;
  ctx.fillText(`${icon} ${eventName}`, CANVAS_W - 14, CANVAS_H - 20);
  ctx.restore();
}

// ── Main draw loop ────────────────────────────────────────────────────────────
function draw() {
  const now = Date.now();

  // Earthquake jitter: save context and offset origin randomly
  ctx.save();
  if (currentEvent === 'earthquake') {
    ctx.translate(
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 7,
    );
  }

  ctx.clearRect(-20, -20, CANVAS_W + 40, CANVAS_H + 40);

  // ── Background tint per event ──────────────────────────────────────────────
  const bgTints = {
    darkness:   '#060614',
    blizzard:   '#0a0e14',
    ghost:      '#080c0c',
    speed_rush: '#120c06',
    big_it:     '#120606',
    earthquake: '#100a06',
    phantom_it: '#0a060e',
    invert:     '#0e060e',
    tiny:       '#060e06',
  };
  ctx.fillStyle = bgTints[currentEvent] || '#111';
  ctx.fillRect(-20, -20, CANVAS_W + 40, CANVAS_H + 40);

  // ── Grid ───────────────────────────────────────────────────────────────────
  ctx.strokeStyle = currentEvent === 'darkness' ? '#0d0d0d' : '#161616';
  ctx.lineWidth   = 0.5;
  for (let i = 0; i < CANVAS_W; i += 50) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_H); ctx.stroke();
  }
  for (let j = 0; j < CANVAS_H; j += 50) {
    ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(CANVAS_W, j); ctx.stroke();
  }

  drawObstacles();

  // ── Reconcile local prediction with server ────────────────────────────────
  if (localPlayerId && localPosReady) {
    const drift = Math.hypot(serverPos.x - localPos.x, serverPos.y - localPos.y);
    if (drift > 120) {
      localPos.x = serverPos.x; localPos.y = serverPos.y;
    } else {
      localPos.x = lerp(localPos.x, serverPos.x, 0.07);
      localPos.y = lerp(localPos.y, serverPos.y, 0.07);
    }
  }

  // ── Draw players ──────────────────────────────────────────────────────────
  for (const id in remotePlayers) {
    const player  = remotePlayers[id];
    const isLocal = id === localPlayerId;
    const isIt    = player.isIt;
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

    // ── phantom_it: IT player is nearly invisible ─────────────────────────
    const isPhantomHidden = (currentEvent === 'phantom_it') && isIt && !isLocal;
    if (isPhantomHidden) {
      // Draw faint pulsing outline only
      const pulse = 0.12 + Math.abs(Math.sin(now / 500)) * 0.1;
      ctx.save();
      ctx.globalAlpha   = pulse;
      ctx.strokeStyle   = '#ff5c3a';
      ctx.lineWidth     = 1.5;
      ctx.shadowColor   = '#ff5c3a';
      ctx.shadowBlur    = 10;
      ctx.beginPath();
      ctx.arc(drawX, drawY, PLAYER_RADIUS * 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (isImmune) ctx.globalAlpha = (Math.sin(now / 70) > 0) ? 0.4 : 1.0;

    const drawR = playerDrawRadius(isIt);

    ctx.shadowColor = isIt ? '#ff5c3a' : 'transparent';
    ctx.shadowBlur  = isIt ? 16 : 0;

    // Ghost mode: non-IT players are translucent
    if (currentEvent === 'ghost' && !isIt) {
      ctx.globalAlpha = isImmune ? 0.2 : 0.45;
    }

    ctx.beginPath();
    ctx.arc(drawX, drawY, drawR, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = isIt ? '#ff5c3a' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = isIt ? 2.5 : 1.5;
    ctx.stroke();

    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    if (isIt) {
      ctx.font      = 'bold 11px "DM Mono", monospace';
      ctx.fillStyle = '#ff5c3a';
      ctx.fillText('IT', drawX, drawY - drawR - 7);
    }
    ctx.font      = '11px "DM Mono", monospace';
    ctx.fillStyle = isLocal ? '#c8f060' : 'rgba(210,210,210,0.75)';
    const label = player.nickname
      ? (player.nickname.length > 12 ? player.nickname.slice(0, 10) + '..' : player.nickname)
      : 'anon';
    ctx.fillText(label, drawX, drawY - drawR - (isIt ? 18 : 12));
  }

  // ── Blizzard particles (drawn above players) ──────────────────────────────
  if (currentEvent === 'blizzard') {
    updateBlizzardParticles();
    drawBlizzard();
  } else if (currentEvent !== 'blizzard') {
    // Drain particles when event ends
    if (blizzardParticles.length > 0) blizzardParticles.length = 0;
  }

  drawTagLog();
  drawEventIndicator();

  // Restore jitter transform before darkness overlay
  ctx.restore();

  // ── Darkness overlay (applied after ctx.restore so it covers full canvas) ─
  if (currentEvent === 'darkness' && localPlayerId && localPosReady) {
    applyDarknessOverlay(localPos.x, localPos.y);
  }

  drawEventBanner();
  requestAnimationFrame(draw);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (document.activeElement === nicknameInput) return;
  if (keys.hasOwnProperty(e.code)) { keys[e.code] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (document.activeElement === nicknameInput) return;
  if (keys.hasOwnProperty(e.code)) { keys[e.code] = false; e.preventDefault(); }
});

// ── Touch joystick ────────────────────────────────────────────────────────────
function initTouchControls() {
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const joystick  = document.getElementById('joystick');
  const thumb     = document.getElementById('joystickThumb');
  const sprintBtn = document.getElementById('sprintBtn');
  if (!joystick) return;

  joystick.style.display  = 'block';
  sprintBtn.style.display = 'flex';

  const MAX  = 38;
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
    const dist  = Math.min(Math.hypot(dx, dy), MAX);
    const angle = Math.atan2(dy, dx);
    thumb.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;

    const inv = (currentEvent === 'invert');
    keys.KeyA = inv ? dx >  DEAD : dx < -DEAD;
    keys.KeyD = inv ? dx < -DEAD : dx >  DEAD;
    keys.KeyW = inv ? dy >  DEAD : dy < -DEAD;
    keys.KeyS = inv ? dy < -DEAD : dy >  DEAD;
  }, { passive: false });

  const endTouch = () => {
    if (!active) return;
    active = false;
    thumb.style.transform = 'translate(0,0)';
    keys.KeyA = keys.KeyD = keys.KeyW = keys.KeyS = false;
  };
  document.addEventListener('touchend',    endTouch);
  document.addEventListener('touchcancel', endTouch);

  sprintBtn.addEventListener('touchstart', (e) => { e.preventDefault(); keys.ShiftLeft = true;  }, { passive: false });
  sprintBtn.addEventListener('touchend',   (e) => { e.preventDefault(); keys.ShiftLeft = false; }, { passive: false });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initGame(nickname) {
  localNickname = nickname;

  // Hide modal immediately so the button always feels responsive
  modal.classList.add('hidden');
  gameHud.classList.remove('hidden');
  initTouchControls();

  // Allow polling fallback — required on Render (proxy blocks WS-only upgrades)
  socket = io({ transports: ['polling', 'websocket'] });

  socket.on('connect_error', (err) => {
    console.error('Socket connect error:', err.message);
    showToast('connection failed — retrying…', 3000);
  });

  socket.on('connect',            () => socket.emit('setNickname', localNickname));
  socket.on('currentPlayers',     onCurrentPlayers);
  socket.on('newPlayer',          onNewPlayer);
  socket.on('playerDisconnected', onPlayerDisconnected);
  socket.on('gameState',          onGameState);
  socket.on('roundEnd',           onRoundEnd);
  socket.on('roundStart',         onRoundStart);
  socket.on('playerCount', (n) => {
    if (playerCountSpan) playerCountSpan.textContent = `${n} online`;
  });
  socket.on('itChanged', (data) => {
    const msg = data.taggerNickname
      ? `${data.taggerNickname} tagged ${data.newItNickname}`
      : `${data.newItNickname} is now IT`;
    showToast(msg, 1800);
    addLog(msg);
  });

  // Wall shuffle
  socket.on('wallsUpdate', (data) => {
    obstacles      = data.obstacles;
    wallsChangedAt = Date.now();
    showToast('walls shuffled!', 1800);
    addLog('walls shuffled');
  });

  // Event change
  socket.on('eventChange', (data) => {
    currentEvent    = data.eventId;
    eventName       = data.eventName;
    eventTimeLeft   = data.eventDuration;
    eventChangedAt  = Date.now();

    const eventDescs = {
      darkness:   'Lights Out — use your torch!',
      speed_rush: 'Speed Rush — everyone\'s faster!',
      ghost:      'Ghost Mode — run through walls!',
      blizzard:   'Blizzard — slowed in the storm!',
      invert:     'Confusion — controls flipped!',
      big_it:     'Mega IT — IT has a huge reach!',
      tiny:       'Micro Mode — tiny & hard to tag!',
      earthquake: 'Earthquake — the ground shakes!',
      phantom_it: 'Phantom IT — IT is nearly invisible!',
      normal:     'Normal mode',
    };
    const desc = eventDescs[data.eventId] || data.eventName;
    showToast(desc, 2400);
    addLog(`Event: ${data.eventName}`);
  });

  setInterval(sendMovement, 1000 / 30);
  requestAnimationFrame(draw);
}

const startGame = () => {
  if (socket) return;                          // already joined — ignore extra clicks
  joinBtn.disabled = true;
  joinBtn.textContent = 'joining…';
  let n = nicknameInput.value.trim() || `Runner_${Math.floor(Math.random() * 1000)}`;
  initGame(n.slice(0, 14));
};
joinBtn.addEventListener('click', startGame);
nicknameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') startGame(); });