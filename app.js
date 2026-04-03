// EatText — Teleprompter PWA
// app.js — main entry point

import { prepareWithSegments, layoutWithLines } from 'https://esm.sh/@chenglou/pretext';

// ============================================================
// Constants
// ============================================================

const STORAGE_KEY_SCRIPT   = 'eattext_script';
const STORAGE_KEY_SETTINGS = 'eattext_settings';
const DEBOUNCE_SAVE_MS     = 500;
const BITE_DURATION_MS     = 280; // one open→close cycle, independent of reading speed

const DEFAULT_SETTINGS = {
  speed: 3,
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
  lastBiteTime: 0,     // performance.now() of last char-consume event
  graphemes: [],       // [{char, width, index}] for active line — grapheme-aware
  cumWidths: [0],      // [0, w0, w0+w1, ...] cumulative pixel widths, O(1) lookup
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
  hudSpeedFill:    $('hud-speed-fill'),
  hudWpm:          $('hud-wpm'),
  hudFontVal:      $('hud-font-val'),
  btnStart:        $('btn-start'),
  btnClear:        $('btn-clear'),
  btnSettings:     $('btn-settings'),
  btnSettingsClose:$('btn-settings-close'),
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

const DEMO_SCRIPT =
`Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper. Aenean ultricies mi vitae est. Mauris placerat eleifend leo. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi. Aenean fermentum, elit eget tincidunt condimentum, eros ipsum rutrum orci, sagittis tempus lacus enim ac dui. Donec non enim in turpis pulvinar facilisis. Ut felis. Praesent dapibus, neque id cursus faucibus, tortor neque egestas augue, eu vulputate magna eros eu erat. Aliquam erat volutpat. Nam dui mi, tincidunt quis, accumsan porttitor, facilisis luctus, metus. Phasellus ultrices nulla quis nibh. Quisque a lectus. Donec consectetuer ligula vulputate sem tristique cursus. Nam nulla quam, gravida non, commodo a, sodales sit amet, nisi. Nullam in massa. Suspendisse vitae nisl sit amet augue bibendum aliquam. Vestibulum nisi lectus, commodo ac, facilisis ac, ultricies eu, pede. Ut orci risus, accumsan porttitor, cursus quis, aliquet eget, justo. Sed pretium blandit orci. Ut eu diam at pede suscipit sodales. Aenean lectus elit, fermentum non, convallis id, sagittis at, neque. Nullam mauris orci, aliquet et, iaculis et, viverra vitae, ligula. Nulla ut felis in purus aliquam imperdiet. Maecenas aliquet mollis lectus. Vivamus consectetuer risus et tortor. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus sit amet semper lacus, in mollis libero. Curabitur commodo sagittis enim. Donec hendrerit sem vel ante lobortis euismod. Curabitur id tortor vitae nulla suscipit tincidunt vitae et arcu. Duis vel lacus at felis vehicula aliquam. Integer eu ante vel purus vehicula pharetra. Maecenas risus risus, condimentum et congue vel, laoreet a lorem.`;


function loadScript() {
  state.script = DEMO_SCRIPT;
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

// Build a single continuous line — no word-wrap at screen edge.
// Pretext segments + measures the full text; we join everything into one strip.
function prepareCanvas() {
  if (!state.script.trim()) return;
  const lh       = getLineHeight();
  // Use huge maxWidth so Pretext never wraps at screen edge.
  // With pre-wrap, explicit \n still creates breaks; we collapse those below.
  const prepared = prepareWithSegments(state.script, getFont(), { whiteSpace: 'pre-wrap' });
  const { lines } = layoutWithLines(prepared, Number.MAX_SAFE_INTEGER, lh);
  // Join all non-empty fragments into one continuous text stream
  const fullText = lines.map(l => l.text).filter(t => t.trim().length > 0).join(' ');
  state.lines = [{ text: fullText }];
  rebuildGraphemes();
}

// Precompute grapheme list + cumulative widths for the active line.
// Replaces per-frame ctx.measureText(substring) with O(1) array lookup.
function rebuildGraphemes() {
  const line = state.lines[state.lineIndex];
  if (!line) { state.graphemes = []; state.cumWidths = [0]; return; }
  ctx.font = getFont();
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  state.graphemes = [...seg.segment(line.text)].map(s => ({
    char:  s.segment,
    width: ctx.measureText(s.segment).width,
    index: s.index,
  }));
  state.cumWidths = [0];
  for (const g of state.graphemes) state.cumWidths.push(state.cumWidths.at(-1) + g.width);
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
  for (let i = 0; i < 14; i++) {
    const angle = Math.PI + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 120 + Math.random() * 260;
    state.particles.push({
      x,
      y: y + (Math.random() - 0.5) * spread,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r:  Math.round(4 + Math.random() * 8),
      color: Math.random() > 0.45 ? '#ffffff' : '#f5c518',
      born: now,
      life: 350 + Math.random() * 250,
    });
  }
}

// Bite crunch — fires on every char consumed.
// ch: the character eaten — uppercase → sharp shards, lowercase → soft crumbs.
function spawnBiteCrunch(x, y, spread, ch) {
  if (renderCache.reducedMotion) return;
  const isUpper = ch && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
  const now = performance.now();

  if (isUpper) {
    // UPPERCASE — estilhaços: sharp spinning shards, explosive, hot colors
    const colors = ['#ffffff', '#f5c518', '#ff8c00', '#ff4d00'];
    for (let i = 0; i < 9; i++) {
      const angle = Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.5;
      const speed = 110 + Math.random() * 230;
      state.particles.push({
        x: x + (Math.random() - 0.5) * spread * 0.3,
        y: y + (Math.random() - 0.5) * spread * 0.5,
        vx: Math.cos(angle) * speed - 35,
        vy: Math.sin(angle) * speed,
        r:  Math.round(4 + Math.random() * 7),
        rot: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 8,
        type: 'shard',
        color: colors[Math.floor(Math.random() * colors.length)],
        born: now,
        life: 200 + Math.random() * 150,
      });
    }
  } else {
    // lowercase — destroços: soft rounded crumbs, white/yellow, calm
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 40 + Math.random() * 90;
      state.particles.push({
        x: x + (Math.random() - 0.5) * spread * 0.15,
        y: y + (Math.random() - 0.5) * spread * 0.4,
        vx: Math.cos(angle) * speed - 15,
        vy: Math.sin(angle) * speed,
        r:  Math.round(2 + Math.random() * 3),
        type: 'crumb',
        color: Math.random() > 0.45 ? '#ffffff' : '#f5c518',
        born: now,
        life: 200 + Math.random() * 130,
      });
    }
  }
}

// True for accented letters (ã, é, ç…) and high-impact symbols (!?@# etc.)
function isSpecialChar(ch) {
  if (!ch || ch === ' ') return false;
  if (ch.normalize('NFD').length > ch.length) return true; // has diacritic
  return /[!?@#$%^&*()\[\]{}<>\/\\|`~=+]/.test(ch);
}

// Explosion for special/accented chars: flash + 360° burst + rising smoke.
function spawnExplosion(x, y, spread) {
  if (renderCache.reducedMotion) return;
  const now    = performance.now();
  const colors = ['#ffffff', '#f5c518', '#ff6b00', '#ff2200', '#ffee00'];

  // Quick white flash
  state.particles.push({
    x, y, vx: 0, vy: 0,
    r: spread * 0.35,
    type: 'flash', color: '#ffffff',
    born: now, life: 130,
  });

  // 360° burst shards
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const speed = 140 + Math.random() * 280;
    state.particles.push({
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 6,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r:  Math.round(4 + Math.random() * 8),
      rot: Math.random() * Math.PI,
      rotSpeed: (Math.random() - 0.5) * 12,
      type: 'shard',
      color: colors[Math.floor(Math.random() * colors.length)],
      born: now,
      life: 350 + Math.random() * 200,
    });
  }

  // Smoke puffs — rise upward, expand as they age
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 0.7;
    const speed = 18 + Math.random() * 45;
    const gray  = 140 + Math.floor(Math.random() * 80);
    state.particles.push({
      x: x + (Math.random() - 0.5) * spread * 0.5,
      y: y + (Math.random() - 0.5) * spread * 0.3,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r:  Math.round(10 + Math.random() * 12),
      type: 'smoke',
      color: `rgb(${gray},${gray},${gray})`,
      born: now,
      life: 550 + Math.random() * 350,
    });
  }
}

// Speed-wind streaks trailing behind Pac-Man — intensity = speed setting.
function drawWindLines(cx, cy, r, speed) {
  const intensity = Math.max(0, (speed - 1) / 9); // 0 at speed 1, 1 at speed 10
  if (intensity < 0.06 || renderCache.reducedMotion) return;
  const t     = Date.now() / 1000;
  const count = Math.round(2 + intensity * 7); // 2–9 lines
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const seed  = i * 1.618;
    // Y: sine wobble gives organic spread around Pac-Man
    const yOff  = Math.sin(seed * 2.9) * r * 1.5 + Math.cos(t * (0.4 + intensity * 0.8) + seed) * r * 0.25;
    // Phase animates each line independently — appears, stretches, fades
    const phase = ((seed * 0.41 + t * intensity * 0.55) % 1);
    const len   = r * (0.6 + intensity * 3.5) * (0.25 + (1 - phase) * 0.75);
    const alpha = intensity * 0.28 * phase * (1 - phase * 0.6);
    if (alpha < 0.015) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth   = 0.4 + intensity * 1.6 * (1 - phase * 0.6);
    const startX = cx - r - phase * r * 1.5;
    ctx.beginPath();
    ctx.moveTo(startX, cy + yOff);
    ctx.lineTo(startX - len, cy + yOff);
    ctx.stroke();
  }
  ctx.restore();
}

// WPM range: 150 (speed 1, slow reader) → 600 (speed 10, speed reader)
// Average adult reader ~200-250 WPM → default speed 3 = 250 WPM
function calcWPM(speed) {
  return Math.round(150 + (speed - 1) / 9 * 450);
}

// Update the HTML HUD pill — only when values actually change.
const _hudCache = { speed: -1, fontSize: -1 };
function updateHUD() {
  const { speed, fontSize } = state.settings;
  if (_hudCache.speed === speed && _hudCache.fontSize === fontSize) return;
  _hudCache.speed    = speed;
  _hudCache.fontSize = fontSize;
  ui.hudSpeedFill.style.width = ((speed - 1) / 9 * 100).toFixed(1) + '%';
  ui.hudWpm.textContent       = calcWPM(speed);
  ui.hudFontVal.textContent   = fontSize;
}

function renderFrame() {
  const g = chompGeometry();
  const { w, h, lh, r: chompR, padding, activeY, mouthX } = g;

  // ── Jaw animation — time-based, fires only on char-consume events ──
  // bitePhase: 0=closed, 0.5=fully open, 1=closed again (one cycle = BITE_DURATION_MS)
  const biteAge   = performance.now() - state.lastBiteTime;
  const bitePhase = Math.min(1, biteAge / BITE_DURATION_MS);
  const mouthOpen = state.running
    ? Math.pow(Math.sin(bitePhase * Math.PI), 1.6)
    : 0.45;
  const bob = (state.running && !renderCache.reducedMotion)
    ? Math.sin(bitePhase * Math.PI) * chompR * 0.11
    : 0;
  // ── Text scroll position — still driven by charProgress (smooth) ──
  const charSubPhase = state.charProgress % 1;

  // ── Background ───────────────────────────────────────────────
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  // ── Wind lines (drawn before text so they're behind everything) ──
  if (state.running) drawWindLines(padding + chompR, activeY, chompR, state.settings.speed);

  if (!state.lines.length) return;

  ctx.font = getFont();
  ctx.textBaseline = 'middle';

  if (state.settings.mirror) { ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1); }

  const activeLine   = state.lines[state.lineIndex] ?? { text: '' };
  const eatenCount   = Math.floor(state.charProgress);

  // O(1) width lookup via precomputed cumWidths — no measureText per frame
  const eatenWidth   = state.cumWidths[Math.min(eatenCount, state.cumWidths.length - 1)] ?? 0;
  const currentG     = state.graphemes[eatenCount];
  const currentChar  = currentG?.char ?? '';
  const currentCharW = currentG?.width ?? 0;

  // ── Pac-Man FIXED on left — text scrolls right→left into mouth ──
  const pacCX       = padding + chompR;
  const textOriginX = mouthX - eatenWidth - charSubPhase * currentCharW;

  // ── Upcoming text: grapheme-correct substring after current grapheme ──
  const nextG        = state.graphemes[eatenCount + 1];
  const upcomingText = nextG ? activeLine.text.substring(nextG.index) : '';
  const upcomingX    = mouthX + (1 - charSubPhase) * currentCharW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mouthX, 0, w - mouthX, h);
  ctx.clip();
  ctx.fillStyle = '#f0f0f0';
  ctx.fillText(upcomingText, upcomingX, activeY + bob);
  ctx.restore();

  // ── Focus gradient: text near mouth = clear, far right = faded ──────
  // Mimics WPM e-reader focus — eye pulled to the eating point, not ahead.
  {
    const c   = renderCache.canvasBg;
    const br  = c.length === 7 ? parseInt(c.slice(1, 3), 16) : 10;
    const bg_ = c.length === 7 ? parseInt(c.slice(3, 5), 16) : 10;
    const bb  = c.length === 7 ? parseInt(c.slice(5, 7), 16) : 10;
    const fog = ctx.createLinearGradient(mouthX, 0, w, 0);
    fog.addColorStop(0,    `rgba(${br},${bg_},${bb},0)`);     // mouth: fully clear
    fog.addColorStop(0.12, `rgba(${br},${bg_},${bb},0.18)`);  // just ahead: slight haze
    fog.addColorStop(0.4,  `rgba(${br},${bg_},${bb},0.60)`);  // mid: reading horizon
    fog.addColorStop(1,    `rgba(${br},${bg_},${bb},0.88)`);  // far: near-hidden
    ctx.fillStyle = fog;
    ctx.fillRect(mouthX, 0, w - mouthX, h);
  }

  // ── Current grapheme: shrinks + fades + turns yellow as it's eaten ──
  if (currentChar) {
    const eatT  = charSubPhase;                          // 0=entering mouth, 1=swallowed
    const charLX = mouthX - eatT * currentCharW;         // left edge scrolls into mouth
    if (charLX + currentCharW > mouthX) {                // still at least partially visible
      const cx  = charLX + currentCharW / 2;
      const scl = 1 - eatT * 0.35;                       // shrinks to 65%
      const alp = 1 - eatT * 0.85;                       // fades to 15%
      // Interpolate white → Pac-Man yellow as char is consumed
      const cr = Math.round(240 + eatT * (245 - 240));
      const cg = Math.round(240 + eatT * (197 - 240));
      const cb = Math.round(240 + eatT * ( 24 - 240));
      ctx.save();
      ctx.globalAlpha = alp;
      ctx.fillStyle   = `rgb(${cr},${cg},${cb})`;
      ctx.translate(cx, activeY + bob);
      ctx.scale(scl, scl);
      ctx.fillText(currentChar, -currentCharW / 2, 0);
      ctx.restore();
    }
  }

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
    if (p.type === 'flash') {
      // Expanding white circle that fades immediately
      const flashR = p.r * (1 + progress * 2.5);
      ctx.globalAlpha = (1 - progress) * 0.75;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.arc(px, py, flashR, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === 'smoke') {
      // Soft expanding circle — blurred via shadow
      const smokeR = p.r * (1 + progress * 2.2);
      ctx.globalAlpha  = (1 - progress) * 0.28;
      ctx.shadowColor  = p.color;
      ctx.shadowBlur   = smokeR * 1.4;
      ctx.fillStyle    = p.color;
      ctx.beginPath();
      ctx.arc(px, py, smokeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (p.type === 'shard') {
      // Thin spinning shard
      const rot = p.rot + (age / 1000) * p.rotSpeed;
      ctx.globalAlpha = 1 - progress;
      ctx.fillStyle   = p.color;
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.rect(-p.r * 0.25, -p.r, p.r * 0.5, p.r * 2);
      ctx.fill();
    } else {
      // Soft rounded crumb
      ctx.globalAlpha = 1 - progress;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.roundRect(px - p.r, py - p.r * 0.4, p.r * 2, p.r * 0.8, p.r * 0.4);
      ctx.fill();
    }
    ctx.restore();
    return true;
  });

  // ── Progress bar ─────────────────────────────────────────────
  if (state.settings.progress && state.lines.length > 0) {
    const pct = Math.min(1, state.lineIndex / state.lines.length);
    ui.progressBar.style.width = (pct * 100).toFixed(1) + '%';
  }

  // ── HUD (HTML element — update only when values change) ───────
  updateHUD();
}

function scrollLoop() {
  if (!state.running) return;

  const activeLine = state.lines[state.lineIndex];
  if (!activeLine) { state.running = false; return; }

  // Characters per second: comfortable reading pace at speed 4 (~75 WPM)
  // speed 1 = ~30 WPM, speed 10 = ~160 WPM
  const wpm           = 150 + (state.settings.speed - 1) / 9 * 450;
  const charsPerSec   = wpm * 5 / 60; // 5 avg chars per word
  const charsPerFrame = charsPerSec / 60;

  const prevFloor = Math.floor(state.charProgress);
  state.charProgress += charsPerFrame;
  const newFloor  = Math.floor(state.charProgress);

  const graphemeCount = state.graphemes.length;

  // Trigger jaw bite + crunch particles on every grapheme consumed
  if (newFloor > prevFloor) {
    state.lastBiteTime = performance.now();
    const g = chompGeometry();
    for (let ci = prevFloor; ci < newFloor && ci < graphemeCount; ci++) {
      const ch = state.graphemes[ci]?.char ?? '';
      if (isSpecialChar(ch)) spawnExplosion(g.mouthX, g.activeY, g.lh);
      else spawnBiteCrunch(g.mouthX, g.activeY, g.lh, ch);
    }
  }

  // Line fully eaten — advance to next and precompute graphemes
  if (state.charProgress >= graphemeCount) {
    const g = chompGeometry();
    spawnCrunch(g.mouthX, g.activeY, g.lh * 0.7);
    state.lineIndex++;
    state.charProgress = 0;
    rebuildGraphemes();
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
  state.lastBiteTime = 0;
  rebuildGraphemes();
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
  bindKeyboardEvents();
  startPrompter();
}

init();
