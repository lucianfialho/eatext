# EatText — Arcade Reading Screen

**Date:** 2026-04-03  
**Scope:** Tela de leitura (`#screen-prompter`) — refatoração completa com estética arcade/fliperama  
**Status:** Approved

---

## Objetivo

Transformar a tela de leitura do EatText em uma experiência full imersão de fliperama anos 80. O chrome (HUD, marquee, scoreboard, overlay) recebe visual arcade pixel-art. O conteúdo dos artigos permanece legível (sans-serif no canvas).

---

## Arquitetura

O `#screen-prompter` é reorganizado em camadas limpas:

```
#screen-prompter
├── .arcade-marquee        ← novo: título neon + vidas Pac-Man
├── .arcade-scoreboard     ← novo: 1UP / HI-SCORE / WORDS
├── #prompter-canvas       ← existente: lógica de renderização intacta
│   ├── ::before           ← scanlines via CSS (pointer-events: none)
│   └── ::after            ← glow roxo radial via CSS (pointer-events: none)
├── .arcade-hud            ← refatorado: substitui .prompter-hud
├── .arcade-gameover       ← refatorado: substitui .read-over
└── #progress-bar          ← existente: reestilizado neon amarelo
```

Novo arquivo `arcade.js` separado de `app.js`. Comunicação via `CustomEvent` — `arcade.js` nunca escreve no canvas nem entra no loop `requestAnimationFrame`.

---

## Visual / CSS

### Tokens

```css
:root {
  --arcade-yellow:  #ff0;
  --arcade-cyan:    #0ff;
  --arcade-magenta: #f0f;
  --arcade-purple:  #8800ff;
  --arcade-bg:      #05010d;
  --arcade-font:    'Press Start 2P', monospace;
}
```

Google Fonts: `Press Start 2P` carregada no `<head>` de `index.html`.

### Elementos visuais

| Elemento | Descrição |
|---|---|
| Scanlines | `#prompter-canvas::before` — `repeating-linear-gradient` 4px, 25% opacidade, `pointer-events: none`, `z-index` acima do canvas |
| Glow | `#prompter-canvas::after` — `radial-gradient` roxo central, pointer-events none |
| Cabinet border | `#screen-prompter`: `border: 3px solid var(--arcade-purple)`, `box-shadow: 0 0 30px rgba(136,0,255,0.4)` |
| Progress bar | Fundo amarelo neon com `box-shadow` glow |
| Fontes | `Press Start 2P` apenas para chrome; canvas mantém sans-serif |

### Marquee (`.arcade-marquee`)

```
◄ EAT TEXT ►                    ᗤ ᗤ ░
```

- Fundo `#0d0618`, borda inferior amarela
- Título em `var(--arcade-yellow)` com `text-shadow` glow
- Vidas: ícones ᗤ amarelos, artigos esgotados em `opacity: 0.25`

### Scoreboard (`.arcade-scoreboard`)

```
1UP        HI-SCORE      WORDS
04820       12400        00248
```

- Fundo preto, fonte 7px
- Labels em magenta neon
- HI-SCORE value em amarelo neon
- Valores com zero-padding (5 dígitos)

### HUD (`.arcade-hud`)

Posicionado na base da tela, fundo preto sólido, borda superior amarela.

| Seção | Conteúdo |
|---|---|
| WPM | Valor em cyan neon 14px |
| Speed | 8 pips quadrados: amarelo (1–2), laranja (3–5), vermelho (6–8) |
| Font | "Aa NN" em magenta neon |

### GAME OVER overlay (`.arcade-gameover`)

- Fundo `rgba(0,0,0,0.95)` sobre tudo
- "READ OVER" piscando em pixel font amarelo — `animation: blink 1s steps(1) infinite`
- Contador `N / TOTAL` em branco
- Botões `NEXT →` e `GAME OVER`: borda neon, hover com `box-shadow` glow

---

## Módulo `arcade.js`

### Responsabilidades

- Escutar eventos de `app.js`
- Calcular e atualizar score
- Gerenciar vidas (ícones no marquee)
- Controlar o overlay GAME OVER
- Persistir HI-SCORE em `localStorage`

### Eventos (despachados por `app.js`)

```js
dispatchEvent(new CustomEvent('eat:word', { detail: { speed } }))
// Cada palavra consumida pelo leitor

dispatchEvent(new CustomEvent('eat:article-end'))
// Artigo terminou — arcade.js mostra o overlay

dispatchEvent(new CustomEvent('eat:speed-change', { detail: { level } }))
// Nível de velocidade mudou (1–8) — arcade.js atualiza os pips
```

### Score

```
pontos por palavra = 10 × speed_level
```

- `WORDS`: contador de palavras lidas na sessão
- `1UP`: score acumulado da sessão
- `HI-SCORE`: máximo histórico via `localStorage.getItem('eattext:hiscore')`

### Vidas

- Vidas = artigos disponíveis no feed, máximo 3 exibidos como ícones
- Artigos esgotados: ícone com `opacity: 0.25`
- `arcade.js` lê `articleCount` via evento ou atributo DOM exposto por `app.js`

### Restrições

- Nunca chamar `canvas.getContext()` ou escrever pixels
- Nunca entrar no loop `requestAnimationFrame` de `app.js`
- Toda atualização de DOM via `requestAnimationFrame` próprio ou microtask

---

## Modificações em `app.js`

Mínimas e cirúrgicas:

1. Despachar `eat:word` a cada palavra avançada no render loop (fora do rAF, via microtask)
2. Despachar `eat:article-end` onde hoje aciona o overlay `.read-over`
3. Despachar `eat:speed-change` onde hoje atualiza o HUD de velocidade
4. Expor `articleCount` como atributo `data-article-count` no `#screen-prompter`

---

## Modificações em `index.html`

- Adicionar `<link>` do Google Fonts para `Press Start 2P`
- Adicionar `.arcade-marquee` e `.arcade-scoreboard` dentro de `#screen-prompter`
- Renomear `.prompter-hud` → `.arcade-hud` (atualizar referências em `app.js`)
- Renomear `.read-over` → `.arcade-gameover` (atualizar referências em `app.js`)
- Adicionar `<script type="module" src="/arcade.js">` após `app.js`

---

## Fora de escopo

- Tela de input (`#screen-input`)
- Tela de settings (`#screen-settings`)
- Feed / lista de artigos
- Lógica de RSS, CORS proxies, Service Worker
- Canvas render (Pac-Man, ghost, ASCII mode) — intocados
