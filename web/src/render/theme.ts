// Colours, fonts, sizes and the probability → lightness scale. The single
// source of the design tokens: the canvases read these constants and
// applyTheme() hands the same values to the CSS as custom properties.

export const COLOR = {
  bg: '#060812', // the ground, under the ambient halos
  surface: '#0d1220', // panel background
  surface2: '#151c2e', // chips, hovered rows, floating readouts
  surface3: '#1d2740', // raised or active controls
  line: '#1e2740',
  lineStrong: '#2f3b5c',
  high: '#f3f6fc', // text the model was sure of
  low: '#7c88a1', // hints and secondary text: 4.7:1 on surface2
  unlikely: '#5d6982', // floor of the probability ramp: 3.4:1 on surface
  muted: '#94a0b8', // labels
  faint: '#2a3550', // tracks, pill outlines
  prompt: '#7b869c', // the prompt's text in the Stream
  a: '#3dd6ff', // model A
  b: '#ffb547', // model B
  dis: '#ff4f9a', // a disagreement, and nothing else
} as const;

// Colour of a model by slot (0: A, 1: B).
export const MODEL_COLOR = [COLOR.a, COLOR.b] as const;

// Tokens, and figures that must line up in columns: monospaced, so token
// edges show and digits do not dance. Everything else: the UI face.
export const FONT = '"JetBrains Mono", ui-monospace, monospace';
export const FONT_UI = 'Inter, system-ui, sans-serif';

// The type sizes, in CSS px. `figure` is for the headline numbers.
export const SIZE = { text: 15, body: 13, label: 12, small: 11, figure: 24 } as const;

// Corner radii, in CSS px. `panel` is for floating surfaces (glass, cards,
// the bar's zones); `pane` for the tiled panels of the page, which are told
// apart by their ground and the gutter, not by rounded boxes.
export const RADIUS = { panel: 12, pane: 4, control: 8, chip: 6 } as const;

// Built once per size: painting every animation frame builds no strings.
const fonts = new Map<number, string>();

export function font(px: number, bold = false): string {
  const key = bold ? -px : px;
  let f = fonts.get(key);
  if (f === undefined) {
    f = `${bold ? '700 ' : ''}${px}px ${FONT}`;
    fonts.set(key, f);
  }
  return f;
}

// The UI face at `px` CSS px and `weight` (400, 500 or 600). Cached too.
const uiFonts = new Map<number, string>();

export function uiFont(px: number, weight = 400): string {
  const key = weight * 1000 + px;
  let f = uiFonts.get(key);
  if (f === undefined) {
    f = `${weight} ${px}px ${FONT_UI}`;
    uiFonts.set(key, f);
  }
  return f;
}

// "rgba(r,g,b,a)" for a "#rrggbb" colour, for gradients. Not for per-frame
// use: build it once and keep it.
export function rgba(color: string, alpha: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Text colour for a probability: `unlikely` at 0, `high` at 1. The power curve
// spreads the middle range, where the interesting choices are. Precomputed
// in steps so that painting never builds colour strings.
const STEPS = 48;
const palette: string[] = (() => {
  const lo = hex(COLOR.unlikely);
  const hi = hex(COLOR.high);
  const out: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const c = lo.map((v, k) => Math.round(v + (hi[k] - v) * t));
    out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
  return out;
})();

export function probColor(p: number | undefined): string {
  if (p === undefined || !(p > 0)) return palette[0];
  const t = Math.pow(Math.min(p, 1), 0.6);
  return palette[Math.round(t * STEPS)];
}

// A rounded rectangle path, for bars, chips and tiles. `r` is clamped to the
// box. The caller fills or strokes.
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// Hands the tokens to the CSS: every colour as --name and as --name-rgb
// ("r,g,b", for rgba(var(--a-rgb), .2)), the sizes and the radii. Called once
// from main.ts, before anything is mounted.
export function applyTheme(root: HTMLElement = document.documentElement): void {
  const st = root.style;
  for (const [name, value] of Object.entries(COLOR)) {
    const css = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d)/, '-$1');
    st.setProperty(`--${css}`, value);
    st.setProperty(`--${css}-rgb`, hex(value).join(','));
  }
  st.setProperty('--font-ui', FONT_UI);
  st.setProperty('--font-mono', FONT);
  for (const [name, px] of Object.entries(SIZE)) st.setProperty(`--fs-${name}`, `${px}px`);
  st.setProperty('--radius', `${RADIUS.panel}px`);
  st.setProperty('--radius-pane', `${RADIUS.pane}px`);
  st.setProperty('--radius-control', `${RADIUS.control}px`);
  st.setProperty('--radius-chip', `${RADIUS.chip}px`);
}

function hex(c: string): number[] {
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
}
