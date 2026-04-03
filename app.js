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
  scrollY: 0,
  totalHeight: 0,
  animFrameId: null,
  lines: [],
  // Camera
  cameraStream: null,
  cameraActive: false,
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
  cameraFeed:      $('camera-feed'),
  btnCamera:       $('btn-camera'),
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
// Theme
// ============================================================

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

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
    // Front camera is already mirrored by CSS; flip back when mirror mode is on
    ui.cameraFeed.style.transform = state.settings.mirror ? 'scaleX(1)' : 'scaleX(-1)';
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
  ui.btnCamera.addEventListener('click', toggleCamera);
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

// Word-wrap text into lines that fit maxWidth using canvas measureText.
// Handles explicit newlines in the source text.
function buildLines(text, font, maxWidth) {
  ctx.font = font;
  const result = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        result.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

function prepareCanvas() {
  if (!state.script.trim()) return;
  const font    = getFont();
  const lh      = getLineHeight();
  const padding = Math.round(window.innerWidth * 0.08);
  const maxWidth = window.innerWidth - padding * 2;

  state.lines = buildLines(state.script, font, maxWidth);
  state.totalHeight = state.lines.length * lh;
}

// Draw the Chomp character — a round face with animated chomping jaw.
// cx/cy = center, r = radius, mouthOpen = 0 (closed) to 1 (fully open).
function drawChomp(cx, cy, r, mouthOpen, isDark) {
  const angle = mouthOpen * 0.38 * Math.PI; // max ~68° opening

  // Body
  ctx.save();
  ctx.fillStyle = isDark ? '#f5c518' : '#e6b800';
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle, Math.PI * 2 - angle);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.fill();

  // Upper teeth (2 small rectangles)
  if (mouthOpen > 0.15) {
    ctx.fillStyle = '#fff';
    const toothW = r * 0.22;
    const toothH = r * 0.18 * mouthOpen;
    const teethY = cy - r * 0.04;
    ctx.fillRect(cx - toothW - 1, teethY - toothH, toothW, toothH);
    ctx.fillRect(cx + 1, teethY - toothH, toothW, toothH);
  }

  // Eye
  ctx.fillStyle = isDark ? '#1a1a1a' : '#222';
  ctx.beginPath();
  ctx.arc(cx + r * 0.15, cy - r * 0.45, r * 0.13, 0, Math.PI * 2);
  ctx.fill();

  // Eye shine
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(cx + r * 0.19, cy - r * 0.5, r * 0.05, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function renderFrame() {
  const w   = window.innerWidth;
  const h   = window.innerHeight;
  const lh  = getLineHeight();
  const padding = Math.round(w * 0.08);
  const x   = padding;
  const isFisheye   = state.settings.scrollEffect === 'fisheye';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const useFisheye  = isFisheye && !reducedMotion;
  const center = h / 2;

  // Background — solid when no camera, dark overlay when camera active
  ctx.fillStyle = state.cameraActive ? 'rgba(0,0,0,0.62)' : (
    getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#0a0a0a'
  );
  ctx.fillRect(0, 0, w, h);

  if (!state.lines.length) return;

  // Mirror transform
  if (state.settings.mirror) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }

  const canvasText = getComputedStyle(document.documentElement)
    .getPropertyValue('--canvas-text').trim() || '#f0f0f0';
  const font = getFont();

  state.lines.forEach((line, i) => {
    const lineY = i * lh - state.scrollY + h * 0.15; // start 15% from top

    // Cull lines outside viewport (+/- 2 extra lines for safety)
    if (lineY + lh < -lh * 2 || lineY > h + lh * 2) return;

    let scale   = 1;
    let opacity = 1;

    if (useFisheye) {
      const dist = Math.abs((lineY + lh / 2) - center) / h;
      // Dramatic: center 2x, edges ~0.3x
      const t = Math.min(1, dist * 2.2);
      const eased = t * t * (3 - 2 * t); // smoothstep
      scale   = 1 + (1 - eased) * 1.0;  // 2.0 at center, 1.0 at edge
      opacity = 1 - eased * 0.9;          // 1.0 at center, 0.1 at edge
    }

    ctx.save();
    ctx.globalAlpha = opacity;

    if (useFisheye && scale !== 1) {
      const cy = lineY + lh / 2;
      ctx.translate(w / 2, cy);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -cy);
    }

    ctx.font      = font;
    ctx.fillStyle = canvasText;
    ctx.textBaseline = 'top';
    ctx.fillText(line, x, lineY);

    ctx.restore();
  });

  if (state.settings.mirror) ctx.restore();

  // Chomp character — sits at the reading line (25% from top)
  const readingY = h * 0.25 + lh / 2;
  const chompR   = Math.round(lh * 0.42);
  const chompX   = Math.round(padding * 0.42);
  const isDark   = (state.settings.theme === 'light') ? false
    : (state.settings.theme === 'dark') ? true
    : !window.matchMedia('(prefers-color-scheme: light)').matches;

  let mouthOpen;
  if (!state.running) {
    // Paused: mouth half-open, waiting
    mouthOpen = 0.5;
  } else {
    // Chomping: oscillate at ~3Hz tied to real time so it feels alive
    const t = Date.now() / 1000;
    mouthOpen = (Math.sin(t * Math.PI * 6) + 1) / 2;
  }

  drawChomp(chompX, readingY, chompR, mouthOpen, isDark);

  // Progress bar update
  if (state.settings.progress && state.totalHeight > 0) {
    const pct = Math.min(1, state.scrollY / (state.totalHeight - h));
    ui.progressBar.style.width = (pct * 100).toFixed(1) + '%';
  }
}

function scrollLoop() {
  if (!state.running) return;

  // Speed: 1 = 0.5px/frame, 10 = 8px/frame (exponential feel)
  const px = 0.3 * Math.pow(state.settings.speed, 1.4);
  const maxScroll = Math.max(0, state.totalHeight - window.innerHeight * 0.85);

  state.scrollY = Math.min(state.scrollY + px, maxScroll);
  renderFrame();

  if (state.scrollY < maxScroll) {
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

// ============================================================
// Touch gestures on canvas
// ============================================================

let _touchStartY = null;
let _touchStartSpeed = null;

ui.canvas.addEventListener('touchstart', (e) => {
  _touchStartY     = e.touches[0].clientY;
  _touchStartSpeed = state.settings.speed;
}, { passive: true });

ui.canvas.addEventListener('touchend', (e) => {
  // If moved less than 10px = tap → toggle pause
  if (_touchStartY !== null && Math.abs(e.changedTouches[0].clientY - _touchStartY) < 10) {
    togglePause();
  }
  _touchStartY = null;
}, { passive: true });

ui.canvas.addEventListener('touchmove', (e) => {
  if (_touchStartY === null) return;
  const dy = _touchStartY - e.touches[0].clientY;
  // Every 30px drag = 1 speed unit
  const delta = Math.round(dy / 30);
  const newSpeed = Math.max(1, Math.min(10, _touchStartSpeed + delta));
  if (newSpeed !== state.settings.speed) {
    state.settings.speed = newSpeed;
    saveSettings();
  }
}, { passive: true });

// ============================================================
// Camera
// ============================================================

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    ui.cameraFeed.srcObject = state.cameraStream;
    ui.cameraFeed.classList.add('active');
    state.cameraActive = true;
    ui.btnCamera.setAttribute('aria-pressed', 'true');
    ui.btnCamera.setAttribute('aria-label', 'Desativar câmera');
  } catch (err) {
    // Permission denied or no camera — fail silently
    state.cameraActive = false;
  }
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  ui.cameraFeed.srcObject = null;
  ui.cameraFeed.classList.remove('active');
  state.cameraActive = false;
  ui.btnCamera.setAttribute('aria-pressed', 'false');
  ui.btnCamera.setAttribute('aria-label', 'Ativar câmera');
}

function toggleCamera() {
  if (state.cameraActive) stopCamera();
  else startCamera();
}

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
  state.scrollY = 0;
  state.running = true;
  scrollLoop();

  requestFullscreen(document.documentElement).catch(() => {});
}

function exitPrompter() {
  state.running = false;
  cancelAnimationFrame(state.animFrameId);
  stopCamera();
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
  syncSettingsUI();
  bindInputEvents();
  bindSettingsEvents();
  bindKeyboardEvents();
  showScreen('input');
}

init();
