// EatText — RSS e-reader PWA
// app.js — main entry point

import { prepareWithSegments, layoutWithLines } from 'https://esm.sh/@chenglou/pretext';

// ============================================================
// Constants
// ============================================================

const STORAGE_KEY_SETTINGS = 'eattext_settings';
const BITE_DURATION_MS     = 280; // one open→close cycle, independent of reading speed

function notifySpeedChange() {
  queueMicrotask(() => {
    dispatchEvent(new CustomEvent('eat:speed-change', {
      detail: { level: state.settings.speed }
    }));
  });
}

const DEFAULT_SETTINGS = {
  speed: 3,
  fontSize: 48,
  theme: 'auto',
  scrollEffect: 'linear',
  mirror: false,
  progress: false,
  asciiMode: false,
};

// ============================================================
// State
// ============================================================

const state = {
  settings: { ...DEFAULT_SETTINGS },
  script: '',
  articles: [],        // [{text}] from RSS, fallback = [DEMO_SCRIPT]
  articleIndex: 0,     // which article is currently playing
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
  finale: null,        // null | {phase, born, ghostX, chomped}
};

// ============================================================
// DOM refs
// ============================================================

const $ = (id) => document.getElementById(id);

const screens = {
  settings: $('screen-settings'),
  prompter: $('screen-prompter'),
};

const ui = {
  ahudWpm:         $('ahud-wpm-val'),
  ahudFontVal:     $('ahud-font-val'),
  ahudPips:        $('ahud-pips'),
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
  arcadeGameover:  $('arcade-gameover'),
  arcadeGameoverCount: $('arcade-gameover-count'),
  btnNextArticle:  $('btn-next-article'),
  btnGameOver:     $('btn-game-over'),
  sourceIcon:      $('arcade-source-icon'),
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

const DEMO_SCRIPT = `Feed unavailable. Pac-Man is hungry but offline. Check your connection and try again. Meanwhile, enjoy this placeholder text as Pac-Man eats every single character until help arrives. Waka waka waka.`;

// Race all CORS proxies simultaneously — first valid XML response wins.
// Individual timeout: 8s. If all fail, throws AggregateError.
async function fetchRaw(url) {
  const enc = encodeURIComponent(url);
  const attempt = async (proxyUrl, extract) => {
    const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(proxyUrl + ' → ' + r.status);
    const body = await extract(r);
    if (!body || body.length < 50) throw new Error(proxyUrl + ' → empty');
    return body;
  };

  return Promise.any([
    attempt(
      'https://api.codetabs.com/v1/proxy?quest=' + enc,
      r => r.text()
    ),
    attempt(
      'https://api.allorigins.win/get?url=' + enc,
      async r => { const j = await r.json(); return j.contents; }
    ),
    attempt(
      'https://corsproxy.io/?' + enc,
      r => r.text()
    ),
  ]);
}

// Generic RSS fetch with multi-proxy fallback.
// `descClean`: optional fn(rawDesc) → clean string (pass null to skip description).
async function fetchFeed(url, source, descClean) {
  const xml = await fetchRaw(url);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = [...doc.querySelectorAll('item')].slice(0, 30);
  if (!items.length) throw new Error('No items in ' + url);
  return items.map(item => {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const rawDesc = item.querySelector('description')?.textContent?.trim() ?? '';
    const desc = descClean ? descClean(rawDesc) : '';
    const text = [title, desc].filter(Boolean).join('. ');
    return { text, source };
  }).filter(a => a.text.length > 5);
}

// Fetch The Verge + BBC Tech in parallel, interleave results.
async function fetchRSSArticles() {
  const cleanHTML = raw => raw
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 450);

  const results = await Promise.allSettled([
    fetchFeed('https://www.theverge.com/rss/index.xml', 'theverge.com', cleanHTML),
    fetchFeed('https://feeds.bbci.co.uk/news/technology/rss.xml', 'bbc.co.uk', cleanHTML),
  ]);

  const [verge, bbc] = results.map(r => r.status === 'fulfilled' ? r.value : []);
  if (!verge.length && !bbc.length) {
    console.warn('[EatText] All feeds failed');
    return null;
  }

  // Interleave: Verge, BBC, Verge, BBC, …
  const merged = [];
  const len = Math.max(verge.length, bbc.length);
  for (let i = 0; i < len; i++) {
    if (i < verge.length) merged.push(verge[i]);
    if (i < bbc.length)   merged.push(bbc[i]);
  }
  return merged;
}

function loadCurrentArticle() {
  const article = state.articles[state.articleIndex];
  if (article && typeof article === 'object') {
    state.script = article.text;
    if (ui.sourceIcon) {
      ui.sourceIcon.src = `https://www.google.com/s2/favicons?domain=${article.source}&sz=32`;
      ui.sourceIcon.alt = article.source;
      ui.sourceIcon.hidden = false;
    }
  } else {
    state.script = article ?? DEMO_SCRIPT;
    if (ui.sourceIcon) ui.sourceIcon.hidden = true;
  }
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
    notifySpeedChange();
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
  ui.btnSettings.addEventListener('click', () => showScreen('settings'));
  ui.btnSettingsClose.addEventListener('click', () => showScreen('prompter'));
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
        notifySpeedChange();
        break;
      case 'ArrowDown':
        e.preventDefault();
        state.settings.speed = Math.max(1, state.settings.speed - 1);
        saveSettings();
        notifySpeedChange();
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
  if (state.settings.asciiMode) {
    // Uniform block width per grapheme in ASCII mode
    const { bw } = getASCIIBlockDims();
    for (let i = 0; i < state.graphemes.length; i++) {
      state.cumWidths.push(state.cumWidths.at(-1) + bw);
    }
  } else {
    for (const g of state.graphemes) state.cumWidths.push(state.cumWidths.at(-1) + g.width);
  }
}

// Scared ghost (blue) — appears at end of text for Pac-Man to eat.
function drawGhost(x, y, r, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const gr = r * 0.88;
  const gh = r * 1.5;

  ctx.fillStyle = '#2222cc';
  ctx.beginPath();
  ctx.arc(x, y, gr, Math.PI, 0, false);
  ctx.lineTo(x + gr, y + gh * 0.55);
  const bumpW = (gr * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const bx = x + gr - i * bumpW;
    ctx.quadraticCurveTo(bx - bumpW * 0.5, y + gh * 0.92, bx - bumpW, y + gh * 0.55);
  }
  ctx.closePath();
  ctx.fill();

  // White eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(x - gr * 0.3, y - gr * 0.08, gr * 0.22, gr * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + gr * 0.3, y - gr * 0.08, gr * 0.22, gr * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  // Pupils (scared — looking left toward Pac-Man)
  ctx.fillStyle = '#6699ff';
  ctx.beginPath(); ctx.arc(x - gr * 0.35, y - gr * 0.06, gr * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + gr * 0.24, y - gr * 0.06, gr * 0.12, 0, Math.PI * 2); ctx.fill();
  // Scared wavy mouth
  ctx.strokeStyle = '#6699ff'; ctx.lineWidth = gr * 0.1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  const my = y + gr * 0.38, mw = gr * 0.6;
  ctx.moveTo(x - mw / 2, my);
  ctx.lineTo(x - mw / 4, my - gr * 0.1);
  ctx.lineTo(x,          my + gr * 0.04);
  ctx.lineTo(x + mw / 4, my - gr * 0.1);
  ctx.lineTo(x + mw / 2, my);
  ctx.stroke();

  ctx.restore();
}

// Draw Chomp facing RIGHT.
// deathT: 0 = normal, 1 = fully dead (mouth opens wide → rotates → shrinks).
function drawChomp(cx, cy, r, mouthOpen, bob, deathT = 0) {
  const t     = Date.now() / 1000;

  // Death overrides
  const openT   = deathT > 0 ? Math.min(1, deathT * 2) : 0;
  const shrinkT = deathT > 0 ? Math.max(0, (deathT - 0.3) / 0.7) : 0;
  const angle   = deathT > 0 ? openT * Math.PI * 0.98 : mouthOpen * 0.36 * Math.PI;
  const sX      = deathT > 0 ? Math.max(0.01, 1 - shrinkT) : 1 - mouthOpen * 0.09;
  const sY      = deathT > 0 ? Math.max(0.01, 1 - shrinkT) : 1 + mouthOpen * 0.09;
  const rot     = openT * Math.PI * 0.8;
  const alpha   = deathT > 0 ? Math.max(0, 1 - shrinkT * 1.4) : 1;

  // Blink (disabled during death)
  const blinkCycle  = deathT > 0 ? 0 : t % 3.5;
  const blinkPhase  = blinkCycle > 3.35 ? (blinkCycle - 3.35) / 0.15 : 0;
  const blinkAmount = blinkPhase > 0 ? Math.sin(blinkPhase * Math.PI) : 0;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + bob);
  if (rot > 0) ctx.rotate(rot);
  ctx.scale(sX, sY);

  // Body
  ctx.fillStyle = '#f5c518';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, r, angle, Math.PI * 2 - angle);
  ctx.closePath();
  ctx.fill();

  // Teeth (skip during death)
  if (deathT === 0 && mouthOpen > 0.1) {
    ctx.fillStyle = '#fff';
    const tw = r * 0.18; const th = r * 0.2 * mouthOpen; const tx = r * 0.35;
    const uy = -Math.sin(angle) * r * 0.82;
    ctx.fillRect(tx - tw / 2, uy - th, tw, th);
    ctx.fillRect(tx - tw / 2, Math.sin(angle) * r * 0.82, tw, th);
  }

  // Eye
  if (deathT < 0.65) {
    const eyeX = r * 0.1; const eyeY = -r * 0.48; const eyeR = r * 0.14;
    ctx.save();
    ctx.translate(eyeX, eyeY);
    ctx.scale(1, Math.max(0.05, 1 - blinkAmount * 0.95));
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(0, 0, eyeR, 0, Math.PI * 2); ctx.fill();
    if (blinkAmount < 0.4) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.arc(eyeR * 0.38, -eyeR * 0.42, eyeR * 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

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

// ============================================================
// ASCII Art mode — letters made of letters (letterbox style)
// Triggered when user pinches past max font size.
// ============================================================

// Hidden canvas used to sample character shapes (pixel bitmaps).
const _offCanvas = Object.assign(document.createElement('canvas'), { width: 64, height: 84 });
const _offCtx    = _offCanvas.getContext('2d', { willReadFrequently: true });
const _bitmapCache = new Map();

const ASCII_COLS = 10;
const ASCII_ROWS = 14;

// Render `char` to offscreen canvas and return a flat Uint8Array bitmap.
// 1 = cell is "lit" (part of the character), 0 = background.
function getCharBitmap(char) {
  const key = char + getFont();
  if (_bitmapCache.has(key)) return _bitmapCache.get(key);

  const W = 64, H = 84;
  _offCtx.fillStyle = '#000';
  _offCtx.fillRect(0, 0, W, H);
  _offCtx.fillStyle = '#fff';
  _offCtx.font = `bold ${H * 0.78}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  _offCtx.textBaseline = 'middle';
  _offCtx.textAlign    = 'center';
  _offCtx.fillText(char, W / 2, H / 2 + H * 0.04);

  const pixels = _offCtx.getImageData(0, 0, W, H).data;
  const bitmap = new Uint8Array(ASCII_COLS * ASCII_ROWS);
  const cw = W / ASCII_COLS, ch = H / ASCII_ROWS;
  for (let r = 0; r < ASCII_ROWS; r++) {
    for (let c = 0; c < ASCII_COLS; c++) {
      const px = Math.floor(c * cw + cw / 2);
      const py = Math.floor(r * ch + ch / 2);
      bitmap[r * ASCII_COLS + c] = pixels[(py * W + px) * 4] > 110 ? 1 : 0;
    }
  }
  _bitmapCache.set(key, bitmap);
  return bitmap;
}

// Block dimensions for ASCII art characters (based on current line height).
function getASCIIBlockDims() {
  const lh = getLineHeight();
  const bh = Math.round(lh * 2.1);
  const bw = Math.round(bh * 0.62);
  return { bw, bh };
}

// Draw `char` as ASCII art at canvas center (cx, cy).
// fillText is cycled through for fill characters.
// fillOffset is the starting index in fillText.
// Returns the new fillOffset after consuming cells.
function drawCharAsASCII(char, fillText, fillOffset, cx, cy, bw, bh, alpha, eatColorT = 0) {
  if (alpha <= 0.02 || !char || char === ' ' || char === '\n') return fillOffset;

  const bitmap  = getCharBitmap(char);
  const cellW   = bw / ASCII_COLS;
  const cellH   = bh / ASCII_ROWS;
  const cellFontPx = Math.max(5, Math.floor(Math.min(cellW, cellH) * 0.82));
  const startX  = cx - bw / 2;
  const startY  = cy - bh / 2;
  const tLen    = fillText.length || 1;

  // Color: interpolate white → Pac-Man yellow as char is eaten (eatColorT 0→1)
  const cr = Math.round(240 + eatColorT * (245 - 240));
  const cg = Math.round(240 + eatColorT * (197 - 240));
  const cb = Math.round(240 + eatColorT * ( 24 - 240));

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font        = `${cellFontPx}px monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle   = `rgb(${cr},${cg},${cb})`;

  let fi = fillOffset;
  for (let r = 0; r < ASCII_ROWS; r++) {
    for (let c = 0; c < ASCII_COLS; c++) {
      if (bitmap[r * ASCII_COLS + c]) {
        ctx.fillText(fillText[fi % tLen] ?? '·', startX + c * cellW, startY + r * cellH);
        fi++;
      }
    }
  }
  ctx.restore();
  return fi;
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

  // WPM
  if (ui.ahudWpm) ui.ahudWpm.textContent = calcWPM(speed);

  // Font val
  if (ui.ahudFontVal) ui.ahudFontVal.textContent = `Aa ${fontSize}`;

  // Pips — 10 pips, cores: amarelo (1-3), laranja (4-7), vermelho (8-10)
  if (ui.ahudPips) {
    ui.ahudPips.querySelectorAll('.ahud-pip').forEach(pip => {
      const n = Number(pip.dataset.pip);
      pip.classList.toggle('on', n <= speed);
      pip.classList.toggle('yellow', n <= speed && n <= 3);
      pip.classList.toggle('orange', n <= speed && n >= 4 && n <= 7);
      pip.classList.toggle('red',    n <= speed && n >= 8);
    });
  }
}

function renderFrame() {
  const g = chompGeometry();
  const { w, h, lh, r: chompR, padding, activeY, mouthX } = g;

  // ── Jaw animation — time-based, fires only on char-consume events ──
  // bitePhase: 0=closed, 0.5=fully open, 1=closed again (one cycle = BITE_DURATION_MS)
  const biteAge   = performance.now() - state.lastBiteTime;
  const bitePhase = Math.min(1, biteAge / BITE_DURATION_MS);
  // During finale ghost-in, jaw does slow anticipatory chomps via a slower timer
  const finaleRunning = state.finale?.phase === 'ghost-in';
  const mouthOpen = (state.running || finaleRunning)
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
  // In ASCII mode each grapheme occupies a uniform block width
  const { bw: ASCII_BW, bh: ASCII_BH } = getASCIIBlockDims();
  const currentCharW = state.settings.asciiMode ? ASCII_BW : (currentG?.width ?? 0);

  // ── Pac-Man FIXED on left — text scrolls right→left into mouth ──
  const pacCX    = padding + chompR;
  const upcomingX = mouthX + (1 - charSubPhase) * currentCharW;

  // ── Upcoming text (normal OR ASCII art) ──────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(mouthX, 0, w - mouthX, h);
  ctx.clip();

  if (state.settings.asciiMode) {
    // Draw each upcoming grapheme as an ASCII art block
    const fillSrc = activeLine.text;
    let fi = eatenCount * 15; // fill text offset cycles per char
    let blockX = upcomingX;
    for (let i = eatenCount + 1; i < state.graphemes.length; i++) {
      if (blockX > w) break;
      fi = drawCharAsASCII(state.graphemes[i].char, fillSrc, fi, blockX + ASCII_BW / 2, activeY, ASCII_BW, ASCII_BH, 1);
      blockX += ASCII_BW;
    }
  } else {
    const nextG        = state.graphemes[eatenCount + 1];
    const upcomingText = nextG ? activeLine.text.substring(nextG.index) : '';
    ctx.fillStyle = '#f0f0f0';
    ctx.fillText(upcomingText, upcomingX, activeY + bob);
  }
  ctx.restore();

  // ── Focus gradient: text near mouth = clear, far right = faded ──────
  {
    const c   = renderCache.canvasBg;
    const br  = c.length === 7 ? parseInt(c.slice(1, 3), 16) : 10;
    const bg_ = c.length === 7 ? parseInt(c.slice(3, 5), 16) : 10;
    const bb  = c.length === 7 ? parseInt(c.slice(5, 7), 16) : 10;
    const fog = ctx.createLinearGradient(mouthX, 0, w, 0);
    fog.addColorStop(0,    `rgba(${br},${bg_},${bb},0)`);
    fog.addColorStop(0.12, `rgba(${br},${bg_},${bb},0.18)`);
    fog.addColorStop(0.4,  `rgba(${br},${bg_},${bb},0.60)`);
    fog.addColorStop(1,    `rgba(${br},${bg_},${bb},0.88)`);
    ctx.fillStyle = fog;
    ctx.fillRect(mouthX, 0, w - mouthX, h);
  }

  // ── Current grapheme: shrinks + fades + turns yellow as it's eaten ──
  if (currentChar) {
    const eatT   = charSubPhase;
    const charLX = mouthX - eatT * currentCharW;
    if (charLX + currentCharW > mouthX) {
      const cx  = charLX + currentCharW / 2;
      const scl = 1 - eatT * 0.35;
      const alp = 1 - eatT * 0.85;
      if (state.settings.asciiMode) {
        // Current char as ASCII art block, shrinks + fades + yellows
        drawCharAsASCII(currentChar, activeLine.text, eatenCount * 15, cx, activeY + bob, ASCII_BW * scl, ASCII_BH * scl, alp, eatT);
      } else {
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
  }

  if (state.settings.mirror) ctx.restore();

  // ── Finale ghost (drawn before Pac-Man so he's on top) ───────
  if (state.finale && !state.finale.chomped) {
    const ghostAlpha = state.finale.phase === 'eat'
      ? Math.max(0, 1 - (performance.now() - state.finale.born) / 250)
      : 1;
    drawGhost(state.finale.ghostX, activeY, chompR, ghostAlpha);
  }

  // ── Pac-Man — stationary, mouth facing right ─────────────────
  const deathT = state.finale?.phase === 'death' ? state.finale.deathT : 0;
  drawChomp(pacCX, activeY, chompR, mouthOpen, bob, deathT);

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

let _scrollLastTime = 0;

function scrollLoop(now = performance.now()) {
  if (!state.running) return;

  const activeLine = state.lines[state.lineIndex];
  if (!activeLine) { state.running = false; return; }

  // Use actual elapsed time so speed is correct on 120Hz+ displays
  const deltaMs = _scrollLastTime ? Math.min(now - _scrollLastTime, 100) : 16.67;
  _scrollLastTime = now;

  const wpm           = 150 + (state.settings.speed - 1) / 9 * 450;
  const charsPerSec   = wpm * 5 / 60; // 5 avg chars per word
  const charsPerFrame = charsPerSec * (deltaMs / 1000);

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
    // Notificar arcade.js
    const wordsConsumed = newFloor - prevFloor;
    queueMicrotask(() => {
      dispatchEvent(new CustomEvent('eat:word', {
        detail: { count: wordsConsumed, speed: state.settings.speed }
      }));
    });
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
    startFinale();
  }
}

// ============================================================
// Finale — ghost in → Pac-Man eats it → Pac-Man dies → Read Over
// ============================================================

function startFinale() {
  cancelAnimationFrame(state.animFrameId);
  state.running = false;
  state.finale  = {
    phase:   'ghost-in',
    born:    performance.now(),
    ghostX:  window.innerWidth + 80,
    chomped: false,
    deathT:  0,
  };
  finaleLoop();
}

function finaleLoop() {
  const f = state.finale;
  if (!f) return;

  const now = performance.now();
  const g   = chompGeometry();
  const ghostTargetX = g.mouthX + g.r * 0.8;

  if (f.phase === 'ghost-in') {
    // Slow dramatic walk-in: 2s, cubic ease-in-out
    const t    = Math.min(1, (now - f.born) / 2000);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    f.ghostX   = window.innerWidth + 80 + (ghostTargetX - (window.innerWidth + 80)) * ease;
    // Slow anticipatory jaw chomps (~speed 1)
    if (!f.lastSlowBite || now - f.lastSlowBite > 700) {
      f.lastSlowBite = now;
      state.lastBiteTime = now;
    }
    if (t >= 1) {
      f.phase = 'eat';
      f.born  = now;
      state.lastBiteTime = now;
      spawnExplosion(g.mouthX, g.activeY, g.lh);
      spawnCrunch(g.mouthX, g.activeY, g.lh * 0.6);
    }
  } else if (f.phase === 'eat') {
    // Hold 600ms while particles fly
    if (now - f.born >= 600) {
      f.phase   = 'death';
      f.born    = now;
      f.chomped = true;
    }
  } else if (f.phase === 'death') {
    // Pac-Man death spin: 1.2s
    f.deathT = Math.min(1, (now - f.born) / 1200);
    if (f.deathT >= 1) {
      state.finale = null;
      renderFrame(); // one last frame fully dead
      showReadOver();
      return;
    }
  }

  renderFrame();
  state.animFrameId = requestAnimationFrame(finaleLoop);
}

// ── Read Over screen ──────────────────────────────────────────

function showReadOver() {
  if (ui.arcadeGameoverCount) {
    ui.arcadeGameoverCount.textContent =
      `${state.articleIndex + 1} / ${state.articles.length}`;
  }
  if (ui.arcadeGameover) ui.arcadeGameover.hidden = false;
  dispatchEvent(new CustomEvent('eat:article-end', {
    detail: { index: state.articleIndex, total: state.articles.length }
  }));
}

function hideReadOver() {
  if (ui.arcadeGameover) ui.arcadeGameover.hidden = true;
}

function bindReadOverEvents() {
  ui.btnNextArticle.addEventListener('click', () => {
    hideReadOver();
    state.articleIndex = (state.articleIndex + 1) % state.articles.length;
    loadCurrentArticle();
    startPrompter();
  });
  ui.btnGameOver.addEventListener('click', () => {
    hideReadOver();
    exitPrompter();
  });
}

// Draw a "loading" frame on the canvas — used while waiting for RSS fetch.
function drawLoadingFrame(msg) {
  const g = chompGeometry();
  ctx.save();
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, g.w, g.h);
  // Pac-Man idle
  drawChomp(g.padding + g.r, g.activeY, g.r, 0.45, 0);
  // Message below
  ctx.font = `14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  ctx.fillStyle    = 'rgba(255,255,255,0.3)';
  ctx.fillText(msg, g.w / 2, g.activeY + g.r * 2.8);
  ctx.restore();
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
  // 2-finger pinch → font size (or ASCII mode toggle at extremes)
  if (e.touches.length === 2 && _pinchDist !== null) {
    const dist  = getTouchDist(e.touches);
    const scale = dist / _pinchDist;

    if (state.settings.asciiMode) {
      // Pinch-in while in ASCII mode → exit ASCII mode, return to max fontSize
      if (scale < 0.82) {
        state.settings.asciiMode = false;
        state.settings.fontSize  = 96;
        _pinchFontSize = 96;
        _pinchDist = dist; // re-anchor so normal pinch-in continues
        ui.sliderFontSize.value = 96;
        ui.fontSizeValue.textContent = '96px';
        saveSettings();
        rebuildGraphemes();
      }
      return;
    }

    // Normal mode: pinch controls font size
    const newSize = Math.round(Math.max(24, Math.min(96, _pinchFontSize * scale)));
    if (newSize !== state.settings.fontSize) {
      state.settings.fontSize = newSize;
      ui.sliderFontSize.value = newSize;
      ui.fontSizeValue.textContent = newSize + 'px';
      saveSettings();
      schedulePrepareCanvas();
    }
    // Pinch-out past max → enter ASCII mode
    if (scale > 1.18 && state.settings.fontSize >= 96) {
      state.settings.asciiMode = true;
      _bitmapCache.clear(); // regenerate bitmaps at new font
      saveSettings();
      rebuildGraphemes();
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
    notifySpeedChange();
  }
}, { passive: true });

// ============================================================
// Wheel / trackpad gestures (desktop)
// scroll up/down = speed, Ctrl+scroll = font size
// ============================================================

let _wheelSpeedAcc = 0;
let _wheelFontAcc  = 0;

ui.canvas.addEventListener('wheel', (e) => {
  if (!screens.prompter.classList.contains('active')) return;
  e.preventDefault();

  if (e.ctrlKey) {
    // Ctrl+scroll → font size (pinch equivalent)
    _wheelFontAcc += e.deltaY;
    const steps = Math.trunc(_wheelFontAcc / 20);
    if (steps === 0) return;
    _wheelFontAcc -= steps * 20;
    const newSize = Math.max(24, Math.min(96, state.settings.fontSize - steps));
    if (newSize !== state.settings.fontSize) {
      state.settings.fontSize = newSize;
      if (ui.ahudFontVal) ui.ahudFontVal.textContent = `Aa ${newSize}`;
      saveSettings();
    }
  } else {
    // Scroll up/down → speed
    _wheelSpeedAcc += e.deltaY;
    const steps = Math.trunc(_wheelSpeedAcc / 40);
    if (steps === 0) return;
    _wheelSpeedAcc -= steps * 40;
    const newSpeed = Math.max(1, Math.min(10, state.settings.speed + Math.sign(steps)));
    if (newSpeed !== state.settings.speed) {
      state.settings.speed = newSpeed;
      saveSettings();
      notifySpeedChange();
    }
  }
}, { passive: false });

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
  showScreen('prompter');
  hideReadOver();
  resizeCanvas();
  prepareCanvas();
  state.lineIndex    = 0;
  state.charProgress = 0;
  state.particles    = [];
  state.lastBiteTime = 0;
  _scrollLastTime    = 0;
  rebuildGraphemes();
  notifySpeedChange();
  state.running      = true;
  queueMicrotask(() => {
    dispatchEvent(new CustomEvent('eat:session-start'));
  });
  scrollLoop();

}


function exitPrompter() {
  state.running = false;
  state.finale  = null;
  cancelAnimationFrame(state.animFrameId);
  hideReadOver();
  startRSSReading();
}

async function startRSSReading() {
  showScreen('prompter');
  resizeCanvas();
  drawLoadingFrame('Buscando The Verge + BBC Tech...');
  const articles = await fetchRSSArticles();
  state.articles = articles?.length ? articles : [DEMO_SCRIPT];
  state.articleIndex = 0;
  loadCurrentArticle();
  startPrompter();
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

async function init() {
  loadSettings();
  updateRenderCache();
  syncSettingsUI();
  bindInputEvents();
  bindKeyboardEvents();
  bindReadOverEvents();
  startRSSReading();
}

init();
