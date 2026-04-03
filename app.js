// EatText — Teleprompter PWA
// app.js — main entry point

// No external dependencies — word-wrap is implemented inline below.

// ============================================================
// Constants
// ============================================================

const STORAGE_KEY_SCRIPT   = 'eattext_script';
const STORAGE_KEY_SETTINGS = 'eattext_settings';
const DEBOUNCE_SAVE_MS     = 500;

const DEFAULT_SETTINGS = {
  speed: 4,
  fontSize: 48,
  theme: 'auto',
  scrollEffect: 'linear',
  mirror: false,
  progress: false,
};

// ============================================================
// State
// ============================================================

const state = {
  settings: { ...DEFAULT_SETTINGS },
  script: '',
  // Prompter runtime state
  running: false,
  lineIndex:    0,     // which line is being eaten
  charProgress: 0.0,   // chars consumed from active line (float, sub-char smooth)
  animFrameId:  null,
  lines: [],           // [{text}]
  particles: [],       // crunch debris
};

// ============================================================
// DOM refs
// ============================================================

const $ = (id) => document.getElementById(id);

const screens = {
  input:    $('screen-input'),
  settings: $('screen-settings'),
  prompter: $('screen-prompter'),
};

const ui = {
  scriptInput:     $('script-input'),
  btnStart:        $('btn-start'),
  btnClear:        $('btn-clear'),
  btnSettings:     $('btn-settings'),
  btnSettingsClose:$('btn-settings-close'),
  btnExit:         $('btn-exit'),
  canvas:          $('prompter-canvas'),
  progressBar:     $('progress-bar'),
  sliderSpeed:     $('slider-speed'),
  sliderFontSize:  $('slider-font-size'),
  speedValue:      $('speed-value'),
  fontSizeValue:   $('font-size-value'),
  toggleMirror:    $('toggle-mirror'),
  toggleProgress:  $('toggle-progress'),
};

// ============================================================
// Persistence
// ============================================================

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (_) { /* ignore parse errors */ }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
}

const EXAMPLE_SCRIPT =
`Você já perdeu uma gravação porque estava olhando para o papel?

Cue resolve isso.

É um teleprompter que roda direto no seu celular. Sem instalar nada. Sem criar conta. Sem pagar nada.

Cole seu roteiro, aperte Iniciar — e leia enquanto olha para a câmera.

O texto rola automaticamente. Você controla a velocidade com um toque na tela. Se precisar pausar, é só tocar de novo.

Tem modo espelho para quem usa teleprompter físico na frente da câmera. Tem modo fisheye, que destaca a linha que você está lendo agora. Funciona offline. Funciona em qualquer celular.

EatText. O teleprompter que come seu roteiro linha por linha.`;

function loadScript() {
  state.script = localStorage.getItem(STORAGE_KEY_SCRIPT) ?? EXAMPLE_SCRIPT;
  ui.scriptInput.value = state.script;
}

let _saveScriptTimer = null;
function scheduleSaveScript() {
  clearTimeout(_saveScriptTimer);
  _saveScriptTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY_SCRIPT, state.script);
  }, DEBOUNCE_SAVE_MS);
}

// ============================================================
// Theme + render cache
// Computed style reads are expensive — cache and update only on theme change.
// ============================================================

const renderCache = {
  canvasBg:     '#0a0a0a',
  canvasText:   '#f0f0f0',
  isDark:       true,
  reducedMotion: false,
};

function updateRenderCache() {
  const style = getComputedStyle(document.documentElement);
  renderCache.canvasBg   = style.getPropertyValue('--canvas-bg').trim()   || '#0a0a0a';
  renderCache.canvasText = style.getPropertyValue('--canvas-text').trim() || '#f0f0f0';
  const theme = state.settings.theme;
  renderCache.isDark = theme === 'dark' ? true
    : theme === 'light' ? false
    : !window.matchMedia('(prefers-color-scheme: light)').matches;
  renderCache.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Defer one tick so CSS vars resolve before we read them
  requestAnimationFrame(updateRenderCache);
}

// Keep reduced-motion cache in sync
window.matchMedia('(prefers-reduced-motion: reduce)')
  .addEventListener('change', updateRenderCache);

// ============================================================
// Screen navigation
// ============================================================

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

// ============================================================
// Settings UI sync
// ============================================================

function syncSettingsUI() {
  const s = state.settings;

  ui.sliderSpeed.value    = s.speed;
  ui.speedValue.textContent = s.speed;

  ui.sliderFontSize.value      = s.fontSize;
  ui.fontSizeValue.textContent = s.fontSize + 'px';

  // Theme toggles
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    const active = btn.dataset.theme === s.theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Scroll effect toggles
  document.querySelectorAll('[data-scroll-effect]').forEach((btn) => {
    const active = btn.dataset.scrollEffect === s.scrollEffect;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  ui.toggleMirror.setAttribute('aria-checked', String(s.mirror));
  ui.toggleProgress.setAttribute('aria-checked', String(s.progress));

  if (s.progress) ui.progressBar.classList.add('visible');
  else ui.progressBar.classList.remove('visible');

  applyTheme(s.theme);
}

// ============================================================
// Settings event handlers
// ============================================================

function bindSettingsEvents() {
  ui.sliderSpeed.addEventListener('input', () => {
    state.settings.speed = Number(ui.sliderSpeed.value);
    ui.speedValue.textContent = state.settings.speed;
    saveSettings();
  });

  ui.sliderFontSize.addEventListener('input', () => {
    state.settings.fontSize = Number(ui.sliderFontSize.value);
    ui.fontSizeValue.textContent = state.settings.fontSize + 'px';
    saveSettings();
    // Re-prepare text if canvas is active (live update)
    if (state.lines.length) prepareCanvas();
  });

  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.theme = btn.dataset.theme;
      saveSettings();
      syncSettingsUI();
    });
  });

  document.querySelectorAll('[data-scroll-effect]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.scrollEffect = btn.dataset.scrollEffect;
      saveSettings();
      syncSettingsUI();
    });
  });

  ui.toggleMirror.addEventListener('click', () => {
    state.settings.mirror = !state.settings.mirror;
    saveSettings();
    syncSettingsUI();
    if (state.lines.length) renderFrame();
  });

  ui.toggleProgress.addEventListener('click', () => {
    state.settings.progress = !state.settings.progress;
    saveSettings();
    syncSettingsUI();
  });
}

// ============================================================
// Script input events
// ============================================================

function bindInputEvents() {
  ui.scriptInput.addEventListener('input', () => {
    state.script = ui.scriptInput.value;
    scheduleSaveScript();
  });

  ui.btnClear.addEventListener('click', () => {
    if (!state.script) return;
    if (!confirm('Apagar o roteiro? Esta ação não pode ser desfeita.')) return;
    state.script = '';
    ui.scriptInput.value = '';
    localStorage.removeItem(STORAGE_KEY_SCRIPT);
  });

  ui.btnSettings.addEventListener('click', () => showScreen('settings'));
  ui.btnSettingsClose.addEventListener('click', () => showScreen('input'));

  ui.btnStart.addEventListener('click', startPrompter);
  ui.btnExit.addEventListener('click', exitPrompter);
}

// ============================================================
// Keyboard navigation (bluetooth keyboard support)
// ============================================================

function bindKeyboardEvents() {
  document.addEventListener('keydown', (e) => {
    const inPrompter = screens.prompter.classList.contains('active');
    if (!inPrompter) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePause();
        break;
      case 'ArrowUp':
        e.preventDefault();
        state.settings.speed = Math.min(10, state.settings.speed + 1);
        saveSettings();
        break;
      case 'ArrowDown':
        e.preventDefault();
        state.settings.speed = Math.max(1, state.settings.speed - 1);
        saveSettings();
        break;
      case 'Escape':
        e.preventDefault();
        exitPrompter();
        break;
    }
  });
}

// ============================================================
// Canvas / Prompter
// ============================================================

const ctx = ui.canvas.getContext('2d');

function getFont() {
  // Avoid system-ui due to canvas/DOM mismatch on macOS (pretext known issue)
  // Use -apple-system as fallback for iOS, Segoe UI for Windows
  return `${state.settings.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function getLineHeight() {
  return Math.round(state.settings.fontSize * 1.5);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  ui.canvas.width  = w * dpr;
  ui.canvas.height = h * dpr;
  ui.canvas.style.width  = w + 'px';
  ui.canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
}

// Word-wrap text into lines, handling explicit newlines as paragraph breaks.
function buildLines(text, font, maxWidth) {
  ctx.font = font;
  const result = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { result.push({ text: '' }); continue; }
    const words = para.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        result.push({ text: current });
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) result.push({ text: current });
  }
  return result;
}

function prepareCanvas() {
  if (!state.script.trim()) return;
  const padding  = Math.round(window.innerWidth * 0.06);
  const maxWidth = window.innerWidth - padding * 2;
  state.lines = buildLines(state.script, getFont(), maxWidth);
}

// Draw Chomp facing RIGHT — mouth opens toward the text.
// cx/cy = center, r = radius, mouthOpen = 0..1, bob = pre-computed vertical offset
function drawChomp(cx, cy, r, mouthOpen, bob) {
  const t     = Date.now() / 1000;
  const angle = mouthOpen * 0.36 * Math.PI; // max ~65°

  // Squish/stretch: body deforms on each chomp
  const sX = 1 - mouthOpen * 0.09;  // squeeze width when mouth open
  const sY = 1 + mouthOpen * 0.09;  // stretch height when mouth open

  // Blink: eye closes briefly every ~3.5 s
  const blinkCycle  = t % 3.5;
  const blinkPhase  = blinkCycle > 3.35 ? (blinkCycle - 3.35) / 0.15 : 0; // 0..1
  const blinkAmount = blinkPhase > 0 ? Math.sin(blinkPhase * Math.PI) : 0;  // 0..1

  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.scale(sX, sY);

  // Body — yellow circle with bite taken out
  ctx.fillStyle = '#f5c518';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, r, angle, Math.PI * 2 - angle);
  ctx.closePath();
  ctx.fill();

  // Teeth on the jaw edges
  if (mouthOpen > 0.1) {
    ctx.fillStyle = '#fff';
    const tw = r * 0.18;
    const th = r * 0.2 * mouthOpen;
    const tx = r * 0.35;
    const uy = -Math.sin(angle) * r * 0.82;
    ctx.fillRect(tx - tw / 2, uy - th, tw, th);
    const ly = Math.sin(angle) * r * 0.82;
    ctx.fillRect(tx - tw / 2, ly, tw, th);
  }

  // Eye (with blink)
  const eyeX = r * 0.1;
  const eyeY = -r * 0.48;
  const eyeR = r * 0.14;

  ctx.save();
  ctx.translate(eyeX, eyeY);
  ctx.scale(1, Math.max(0.05, 1 - blinkAmount * 0.95)); // squish vertically on blink
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.arc(0, 0, eyeR, 0, Math.PI * 2);
  ctx.fill();
  if (blinkAmount < 0.4) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.arc(eyeR * 0.38, -eyeR * 0.42, eyeR * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}

// Shared geometry — horizontal mode: Pac-Man fixed on left, text scrolls into it.
function chompGeometry() {
  const w  = window.innerWidth;
  const h  = window.innerHeight;
  const lh = getLineHeight();
  const r  = Math.round(Math.min(lh * 0.82, 56));
  const padding = Math.round(w * 0.06);
  return { w, h, lh, r, padding, activeY: Math.round(h * 0.5), mouthX: padding + r * 2 };
}

// Spawn crunch debris particles (line-end, big burst).
function spawnCrunch(x, y, spread) {
  if (renderCache.reducedMotion) return;
  const now = performance.now();
  for (let i = 0; i < 8; i++) {
    const angle = Math.PI + (Math.random() - 0.5) * Math.PI * 0.8;
    const speed = 80 + Math.random() * 180;
    state.particles.push({
      x,
      y: y + (Math.random() - 0.5) * spread,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r:  Math.round(3 + Math.random() * 7),
      color: Math.random() > 0.45 ? '#ffffff' : '#f5c518',
      born: now,
      life: 280 + Math.random() * 180,
    });
  }
}

// Tiny bite crunch at the current mouth X/Y position.
function spawnBiteCrunch(x, y, spread) {
  if (renderCache.reducedMotion) return;
  const now = performance.now();
  for (let i = 0; i < 3; i++) {
    const angle = Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 0.9; // mostly up/down
    const speed = 30 + Math.random() * 70;
    state.particles.push({
      x: x + (Math.random() - 0.5) * spread * 0.3,
      y: y + (Math.random() - 0.5) * spread * 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r:  Math.round(2 + Math.random() * 3),
      color: Math.random() > 0.5 ? '#ffffff' : '#f5c518',
      born: now,
      life: 140 + Math.random() * 80,
    });
  }
}

function renderFrame() {
  const g = chompGeometry();
  const { w, h, lh, r: chompR, padding, activeY, mouthX } = g;

  // ── Char phase & "nhac nhac" jaw animation ────────────────────
  const charPhase = state.charProgress % 1;
  const bitePhase = Math.min(1, charPhase / 0.55);
  const mouthOpen = state.running
    ? Math.pow(Math.sin(bitePhase * Math.PI), 1.6)
    : 0.45;
  const bob = (state.running && !renderCache.reducedMotion)
    ? Math.sin(bitePhase * Math.PI) * chompR * 0.11
    : 0;

  // ── Background ───────────────────────────────────────────────
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  if (!state.lines.length) return;

  ctx.font = getFont();
  ctx.textBaseline = 'middle';

  if (state.settings.mirror) { ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1); }

  const activeLine = state.lines[state.lineIndex] ?? { text: '' };
  const eatenCount = Math.floor(state.charProgress);

  const eatenText    = activeLine.text.substring(0, eatenCount);
  const eatenWidth   = ctx.measureText(eatenText).width;
  const currentChar  = activeLine.text[eatenCount] ?? '';
  const currentCharW = currentChar ? ctx.measureText(currentChar).width : 0;

  // ── Pac-Man FIXED on left — text scrolls right→left into mouth ──
  // Text origin shifts left as chars are eaten, keeping the mouth at fixedMouthX
  const pacCX       = padding + chompR;                               // fixed
  const textOriginX = mouthX - eatenWidth - bitePhase * currentCharW; // scrolls left

  // Show only uneaten portion (right of mouth)
  ctx.save();
  ctx.beginPath();
  ctx.rect(mouthX, 0, w - mouthX, h);
  ctx.clip();
  ctx.fillStyle = '#f0f0f0';
  ctx.fillText(activeLine.text, textOriginX, activeY + bob);
  ctx.restore();

  if (state.settings.mirror) ctx.restore();

  // ── Pac-Man — stationary, mouth facing right ─────────────────
  drawChomp(pacCX, activeY, chompR, mouthOpen, bob);

  // ── Crunch particles ─────────────────────────────────────────
  const now = performance.now();
  state.particles = state.particles.filter((p) => {
    const age      = now - p.born;
    if (age > p.life) return false;
    const progress = age / p.life;
    const sec      = age / 1000;
    const px       = p.x + p.vx * sec;
    const py       = p.y + p.vy * sec + 0.5 * 320 * sec * sec;

    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.fillStyle   = p.color;
    ctx.beginPath();
    ctx.roundRect(px - p.r, py - p.r * 0.4, p.r * 2, p.r * 0.8, p.r * 0.4);
    ctx.fill();
    ctx.restore();
    return true;
  });

  // ── Progress bar ─────────────────────────────────────────────
  if (state.settings.progress && state.lines.length > 0) {
    const pct = Math.min(1, state.lineIndex / state.lines.length);
    ui.progressBar.style.width = (pct * 100).toFixed(1) + '%';
  }
}

function scrollLoop() {
  if (!state.running) return;

  const activeLine = state.lines[state.lineIndex];
  if (!activeLine) { state.running = false; return; }

  // Characters per second: comfortable reading pace at speed 4 (~75 WPM)
  // speed 1 = ~30 WPM, speed 10 = ~160 WPM
  const charsPerSec   = 1.8 + state.settings.speed * 1.25;
  const charsPerFrame = charsPerSec / 60;

  const prevFloor = Math.floor(state.charProgress);
  state.charProgress += charsPerFrame;
  const newFloor  = Math.floor(state.charProgress);

  // Crunch at each word/punct boundary — always at fixed mouth position
  if (newFloor > prevFloor) {
    const g = chompGeometry();
    for (let ci = prevFloor; ci < newFloor && ci < activeLine.text.length; ci++) {
      const ch = activeLine.text[ci];
      if (ch === ' ' || ch === '.' || ch === ',' || ch === '!' || ch === '?') {
        spawnBiteCrunch(g.mouthX, g.activeY, g.lh);
      }
    }
  }

  // Line fully eaten — advance to next
  if (state.charProgress >= activeLine.text.length) {
    const g = chompGeometry();
    spawnCrunch(g.mouthX, g.activeY, g.lh * 0.7);
    state.lineIndex++;
    state.charProgress = 0;
  }

  renderFrame();

  if (state.lineIndex < state.lines.length) {
    state.animFrameId = requestAnimationFrame(scrollLoop);
  } else {
    state.running = false;
  }
}

function togglePause() {
  if (state.running) {
    state.running = false;
    cancelAnimationFrame(state.animFrameId);
  } else {
    state.running = true;
    scrollLoop();
  }
}

let _prepareTimer = null;
function schedulePrepareCanvas() {
  clearTimeout(_prepareTimer);
  _prepareTimer = setTimeout(prepareCanvas, 80);
}

// ============================================================
// Touch gestures on canvas
// 1-finger: tap = pause, swipe up/down = speed
// 2-finger: pinch = font size
// ============================================================

let _touch1Y = null;
let _touch1Speed = null;
let _pinchDist = null;
let _pinchFontSize = null;

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

ui.canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    _pinchDist     = getTouchDist(e.touches);
    _pinchFontSize = state.settings.fontSize;
    _touch1X = null;
  } else {
    _touch1Y     = e.touches[0].clientY;
    _touch1Speed = state.settings.speed;
    _pinchDist   = null;
  }
}, { passive: true });

ui.canvas.addEventListener('touchend', (e) => {
  if (_pinchDist !== null) {
    _pinchDist = null;
    return;
  }
  // tap = moved less than 10px
  if (_touch1Y !== null && Math.abs(e.changedTouches[0].clientY - _touch1Y) < 10) {
    togglePause();
  }
  _touch1Y = null;
}, { passive: true });

ui.canvas.addEventListener('touchmove', (e) => {
  // 2-finger pinch → font size
  if (e.touches.length === 2 && _pinchDist !== null) {
    const dist  = getTouchDist(e.touches);
    const scale = dist / _pinchDist;
    const newSize = Math.round(Math.max(24, Math.min(96, _pinchFontSize * scale)));
    if (newSize !== state.settings.fontSize) {
      state.settings.fontSize = newSize;
      ui.sliderFontSize.value = newSize;
      ui.fontSizeValue.textContent = newSize + 'px';
      saveSettings();
      schedulePrepareCanvas();
    }
    return;
  }
  // 1-finger swipe up/down → speed
  if (_touch1Y === null) return;
  const dy    = _touch1Y - e.touches[0].clientY;
  const delta = Math.round(dy / 30);
  const newSpeed = Math.max(1, Math.min(10, _touch1Speed + delta));
  if (newSpeed !== state.settings.speed) {
    state.settings.speed = newSpeed;
    saveSettings();
  }
}, { passive: true });

// ============================================================
// Fullscreen helpers
// ============================================================

function requestFullscreen(el) {
  if (el.requestFullscreen)             return el.requestFullscreen();
  if (el.webkitRequestFullscreen)       return el.webkitRequestFullscreen();
  if (el.mozRequestFullScreen)          return el.mozRequestFullScreen();
  return Promise.resolve(); // graceful fallback (Firefox Android)
}

function exitFullscreen() {
  if (document.exitFullscreen)          return document.exitFullscreen();
  if (document.webkitExitFullscreen)    return document.webkitExitFullscreen();
  if (document.mozCancelFullScreen)     return document.mozCancelFullScreen();
  return Promise.resolve();
}

// ============================================================
// Start / Exit prompter
// ============================================================

function startPrompter() {
  if (!state.script.trim()) {
    ui.scriptInput.focus();
    return;
  }

  showScreen('prompter');
  resizeCanvas();
  prepareCanvas();
  state.lineIndex    = 0;
  state.charProgress = 0;
  state.particles    = [];
  state.running      = true;
  scrollLoop();

  requestFullscreen(document.documentElement).catch(() => {});
}

function exitPrompter() {
  state.running = false;
  cancelAnimationFrame(state.animFrameId);
  exitFullscreen().catch(() => {});
  showScreen('input');
}

// Handle fullscreen exit via browser back button / swipe
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && screens.prompter.classList.contains('active')) {
    exitPrompter();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && screens.prompter.classList.contains('active')) {
    exitPrompter();
  }
});

// Resize canvas when orientation changes
window.addEventListener('resize', () => {
  if (screens.prompter.classList.contains('active')) {
    resizeCanvas();
    prepareCanvas();
    renderFrame();
  }
});

// ============================================================
// Service Worker registration
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ============================================================
// Boot
// ============================================================

function init() {
  loadSettings();
  loadScript();
  updateRenderCache();
  syncSettingsUI();
  bindInputEvents();
  bindSettingsEvents();
  bindKeyboardEvents();
  showScreen('input');
}

init();
