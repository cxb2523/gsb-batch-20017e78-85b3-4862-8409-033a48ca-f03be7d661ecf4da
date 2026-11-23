// Tabular figures on a canvas. A canvas cannot ask Inter for
// font-variant-numeric: tabular-nums, so live figures drawn in the UI face
// would shift as their digits change. Here every digit gets the same
// advance (the widest digit of the font, centred in it) and every other
// character its natural width. Widths are measured once per font string and
// cached, so drawing a figure measures nothing after the first frame.

export type TabularAlign = 'left' | 'right' | 'center';

interface Metrics {
  digit: number; // the advance of every digit
  widths: Map<number, number>; // natural width by char code
}

const cache = new Map<string, Metrics>();

// Inter may arrive after the first measurement: measure again when it does.
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener?.('loadingdone', () => cache.clear());
  void document.fonts.ready?.then(() => cache.clear());
}

// Forgets every measurement (for tests, or after a font change).
export function clearTabularCache(): void {
  cache.clear();
}

function metrics(ctx: CanvasRenderingContext2D): Metrics {
  const key = ctx.font;
  let m = cache.get(key);
  if (m === undefined) {
    const widths = new Map<number, number>();
    let digit = 0;
    for (let c = 48; c <= 57; c++) {
      const w = ctx.measureText(String.fromCharCode(c)).width;
      widths.set(c, w);
      if (w > digit) digit = w;
    }
    m = { digit, widths };
    cache.set(key, m);
  }
  return m;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function charWidth(ctx: CanvasRenderingContext2D, m: Metrics, code: number, text: string, i: number): number {
  let w = m.widths.get(code);
  if (w === undefined) {
    w = ctx.measureText(text[i]).width;
    m.widths.set(code, w);
  }
  return w;
}

// The width of `text` in the current font, digits at their fixed advance.
export function tabularWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const m = metrics(ctx);
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    w += isDigit(code) ? m.digit : charWidth(ctx, m, code, text, i);
  }
  return w;
}

// Draws `text` at (x, y) in the current font and fill, aligned to x as
// `align` says, with tabular digits. Returns the width drawn. Leaves
// ctx.textAlign as it found it.
export function fillTabular(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: TabularAlign = 'left',
): number {
  const m = metrics(ctx);
  const total = tabularWidth(ctx, text);
  let px = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
  const before = ctx.textAlign;
  ctx.textAlign = 'left';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isDigit(code)) {
      const w = m.widths.get(code) ?? m.digit;
      ctx.fillText(text[i], px + (m.digit - w) / 2, y);
      px += m.digit;
    } else {
      const w = charWidth(ctx, m, code, text, i);
      if (code !== 32) ctx.fillText(text[i], px, y);
      px += w;
    }
  }
  ctx.textAlign = before;
  return total;
}
