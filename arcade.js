// arcade.js — Arcade chrome: score, lives, HUD pips, GAME OVER overlay
// Communicates with app.js only via CustomEvents — never touches the canvas.

const HISCORE_KEY = 'eattext:hiscore';

const state = {
  score:   0,
  words:   0,
  hiscore: Number(localStorage.getItem(HISCORE_KEY) ?? 0),
};

// ── DOM refs ──────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const ui = {
  score1up:   $('arcade-score-1up'),
  scoreHi:    $('arcade-score-hi'),
  scoreWords: $('arcade-score-words'),
  lives:      $('arcade-lives'),
  pips:       $('ahud-pips'),
  wpmVal:     $('ahud-wpm-val'),
};

// ── Helpers ───────────────────────────────────────────────────

function pad5(n) {
  return String(Math.min(99999, n)).padStart(5, '0');
}

function updateScoreDOM() {
  if (ui.score1up)   ui.score1up.textContent   = pad5(state.score);
  if (ui.scoreHi)    ui.scoreHi.textContent    = pad5(state.hiscore);
  if (ui.scoreWords) ui.scoreWords.textContent = pad5(state.words);
}

function saveHiscore() {
  if (state.score > state.hiscore) {
    state.hiscore = state.score;
    localStorage.setItem(HISCORE_KEY, state.hiscore);
  }
}

// ── Event: eat:word ───────────────────────────────────────────

window.addEventListener('eat:word', (e) => {
  const { count = 1, speed = 1 } = e.detail ?? {};
  // Approximate words: ~5 chars per word average
  const wordsApprox = Math.max(1, Math.round(count / 5));
  state.words += wordsApprox;
  state.score += wordsApprox * 10 * speed;
  saveHiscore();
  requestAnimationFrame(updateScoreDOM);
});

// ── Event: eat:speed-change ───────────────────────────────────

window.addEventListener('eat:speed-change', (e) => {
  const level = e.detail?.level ?? 1;
  updatePips(level);
  updateWPM(level);
});

function updatePips(level) {
  if (!ui.pips) return;
  ui.pips.querySelectorAll('.ahud-pip').forEach(pip => {
    const n = Number(pip.dataset.pip);
    const on = n <= level;
    pip.classList.toggle('on',     on);
    pip.classList.toggle('yellow', on && n <= 3);
    pip.classList.toggle('orange', on && n >= 4 && n <= 7);
    pip.classList.toggle('red',    on && n >= 8);
  });
}

function calcWPM(speed) {
  return Math.round(150 + (speed - 1) / 9 * 450);
}

function updateWPM(level) {
  if (ui.wpmVal) ui.wpmVal.textContent = calcWPM(level);
}

// ── Event: eat:article-end ────────────────────────────────────

window.addEventListener('eat:article-end', (e) => {
  const { index = 0, total = 1 } = e.detail ?? {};
  updateLives(index, total);
});

function updateLives(articleIndex, total) {
  if (!ui.lives) return;
  const remaining = total - articleIndex;
  ui.lives.querySelectorAll('.arcade-life').forEach((el, i) => {
    el.classList.toggle('spent', i >= remaining);
  });
}

// ── Event: eat:session-start ──────────────────────────────────

window.addEventListener('eat:session-start', () => {
  state.score = 0;
  state.words = 0;
  requestAnimationFrame(updateScoreDOM);
});

// ── Initialization ────────────────────────────────────────────

updateScoreDOM();
