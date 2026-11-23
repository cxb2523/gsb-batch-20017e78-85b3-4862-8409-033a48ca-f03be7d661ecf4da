// The strip of live figures (Canvas 2D), between the stage and the dock: six
// indicators of the selected position, each with a label, its figure and a
// sparkline of the last positions of the viewed path. The arithmetic lives
// in metrics-data.ts; this file only lays out and paints.
//
//   Confidence  p(pick) │ Surprise  −log₂ p │ Perplexity  generated │ …
//   87.4 %      ╱╲__╱‾‾●  │ 0.19 bits   _╱╲_●   │ 1.84        ‾‾‾╲__●    │ …
//
// With two models every indicator carries A (cyan) and B (amber): two
// figures, stacked or side by side, and two lines. Below 120 px of height
// (the narrow layout gives 144) the six go in two rows of three. With little
// width the sparklines go first, the figures never.

import type { Store } from '../store/store';
import type { View } from '../store/view';
import { drawIcon, type IconName } from './icons';
import {
  bitsText,
  DASH,
  METRIC_COUNT,
  msText,
  PathMetrics,
  pctText,
  pplText,
  rateText,
  sparkWindow,
} from './metrics-data';
import { Surface } from './surface';
import { fillTabular, tabularWidth } from './tabular';
import { COLOR, MODEL_COLOR, SIZE, rgba, uiFont } from './theme';

const PAD = 16; // inside each cell
const SEP_INSET = 14; // the separators stop short of the edges
const ICON = 12;
const GAP = 14; // between the figures and the sparkline
const MIN_SPARK = 44; // narrower than this, no sparkline
const ROOMY_SPARK = 90; // two big figures side by side only if this is left
const SPARK_SIZE = 120; // positions a sparkline shows
const MIN_SLOTS = 24; // positions across a sparkline before it compresses
const MED = 16; // figure size when two are stacked
const SAMPLE = '88.88'; // widest figure, for the layout

interface Def {
  label: string;
  note: string; // beside the label, when there is room
  short: string; // the note when the long one does not fit ('' = none)
  unit: string;
  icon: IconName;
  text: (v: number) => string;
  scale: 'unit' | 'zero' | 'log'; // [0, 1]; [0, max]; log₂ from 0
}

const DEFS: Def[] = [
  { label: 'Confidence', note: 'p of the pick', short: '', unit: '%', icon: 'target', text: pctText, scale: 'unit' },
  { label: 'Surprise', note: '−log₂ p', short: '', unit: 'bits', icon: 'sparkle', text: bitsText, scale: 'zero' },
  { label: 'Perplexity', note: 'generated text', short: 'generated', unit: '', icon: 'activity', text: pplText, scale: 'log' },
  { label: 'Margin', note: 'top 1 − top 2', short: '', unit: 'pp', icon: 'compare', text: pctText, scale: 'unit' },
  { label: 'Speed', note: 'compute', short: '', unit: 'tok/s', icon: 'bolt', text: rateText, scale: 'zero' },
  { label: 'Latency', note: 'per step', short: '', unit: 'ms', icon: 'clock', text: msText, scale: 'zero' },
];

const enum Mode {
  Big, // one model: one big figure
  Inline, // two models, two big figures side by side
  Stacked, // two models, two medium figures one over the other
}

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: Mode;
  note: string;
  // The sparkline's box; sw 0: none.
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  fills: CanvasGradient[]; // per slot, top to bottom of the box
}

// Built once: painting builds no colour strings.
const HALO = [rgba(COLOR.a, 0.28), rgba(COLOR.b, 0.28)];
const GLOW = [rgba(COLOR.a, 0.6), rgba(COLOR.b, 0.6)];

export class MetricsPanel {
  private readonly surface: Surface;
  private readonly data = new PathMetrics();
  private readonly win = { start: 0, end: 0 };
  private cells: Cell[] = [];
  private seps: CanvasGradient | null = null;
  private rows = 1;
  // What the layout was built for.
  private lw = -1;
  private lh = -1;
  private ltwo = false;
  private fontGen = 0;
  private lfont = -1;
  private bigW = 0;
  private medW = 0;
  private readonly unitW: number[] = [];
  private readonly onFonts = (): void => {
    this.fontGen++;
    this.store.dirty.metrics = true;
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.surface = new Surface(canvas, () => {
      this.store.dirty.metrics = true;
    });
    // Inter may arrive after the first layout: measure again when it does.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener('loadingdone', this.onFonts);
    void fonts?.ready.then(this.onFonts);
  }

  paint(): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    const s = this.store;
    const data = this.data;
    data.sync(s);
    const two = s.twoModels;
    if (sf.w !== this.lw || sf.h !== this.lh || two !== this.ltwo || this.fontGen !== this.lfont) this.layout(two);

    const n = data.length;
    const sel = this.view.selected();
    const empty = n <= data.first;
    sparkWindow(n, data.first, sel, SPARK_SIZE, this.win);

    this.drawSeparators(ctx);
    for (let m = 0; m < METRIC_COUNT; m++) {
      const c = this.cells[m];
      this.drawLabel(ctx, m, c);
      if (c.sw > 0) this.drawSpark(ctx, m, c, two, sel, empty);
      this.drawFigures(ctx, m, c, two, sel, empty);
    }
  }

  dispose(): void {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.removeEventListener('loadingdone', this.onFonts);
    this.surface.dispose();
  }

  // ----------------------------------------------------------- layout

  private layout(two: boolean): void {
    const sf = this.surface;
    const ctx = sf.ctx;
    this.lw = sf.w;
    this.lh = sf.h;
    this.ltwo = two;
    this.lfont = this.fontGen;

    // Figures are drawn with tabular digits: measured the same way.
    ctx.font = uiFont(SIZE.figure, 600);
    this.bigW = Math.ceil(tabularWidth(ctx, SAMPLE));
    ctx.font = uiFont(MED, 600);
    this.medW = Math.ceil(tabularWidth(ctx, SAMPLE));
    ctx.font = uiFont(SIZE.small, 500);
    for (let m = 0; m < METRIC_COUNT; m++) {
      const u = DEFS[m].unit;
      this.unitW[m] = u ? Math.ceil(ctx.measureText(u).width) + 5 : 0;
    }

    this.rows = sf.h >= 120 ? 2 : 1;
    const cols = METRIC_COUNT / this.rows;
    const rh = sf.h / this.rows;
    const cw = sf.w / cols;
    this.cells = [];
    for (let m = 0; m < METRIC_COUNT; m++) {
      const row = Math.floor(m / cols);
      const col = m % cols;
      const x = Math.round(col * cw);
      const c = this.cell(ctx, m, x, Math.round(row * rh), Math.round((col + 1) * cw) - x, Math.round(rh), two);
      this.cells.push(c);
    }
    // The separators fade out towards their ends.
    const g = ctx.createLinearGradient(0, SEP_INSET, 0, rh - SEP_INSET);
    g.addColorStop(0, rgba(COLOR.lineStrong, 0));
    g.addColorStop(0.5, rgba(COLOR.lineStrong, 0.9));
    g.addColorStop(1, rgba(COLOR.lineStrong, 0));
    this.seps = g;
  }

  private cell(ctx: CanvasRenderingContext2D, m: number, x: number, y: number, w: number, h: number, two: boolean): Cell {
    const def = DEFS[m];
    const inner = w - 2 * PAD;
    // The widest unit for every cell: the sparklines line up and come and
    // go together.
    const unit = Math.max(...this.unitW);
    let mode = Mode.Big;
    let block = this.bigW + unit;
    if (two) {
      const inline = 2 * this.bigW + 12 + unit;
      if (inner - inline - GAP >= ROOMY_SPARK) {
        mode = Mode.Inline;
        block = inline;
      } else {
        mode = Mode.Stacked;
        block = 14 + this.medW + unit;
      }
    }
    let sw = inner - block - GAP;
    if (sw < MIN_SPARK) sw = 0;
    const sx = x + w - PAD - sw;
    const sy = y + 31;
    const sh = Math.max(8, h - 31 - 13);

    // The note beside the label: the long one, the short one or none.
    ctx.font = uiFont(SIZE.small, 600);
    ctx.letterSpacing = '0px';
    const labelW = ctx.measureText(def.label).width;
    ctx.letterSpacing = '0px';
    ctx.font = uiFont(SIZE.small);
    const room = inner - ICON - 6 - labelW - 12;
    let note = '';
    if (ctx.measureText(def.note).width <= room) note = def.note;
    else if (def.short && ctx.measureText(def.short).width <= room) note = def.short;

    const fills: CanvasGradient[] = [];
    for (let k = 0; k < 2; k++) {
      const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
      g.addColorStop(0, rgba(MODEL_COLOR[k], two ? 0.2 : 0.3));
      g.addColorStop(1, rgba(MODEL_COLOR[k], 0));
      fills.push(g);
    }
    return { x, y, w, h, mode, note, sx, sy, sw, sh, fills };
  }

  // ----------------------------------------------------------- painting

  private drawSeparators(ctx: CanvasRenderingContext2D): void {
    if (!this.seps) return;
    const cols = METRIC_COUNT / this.rows;
    ctx.fillStyle = this.seps;
    for (let m = 0; m < METRIC_COUNT; m++) {
      if (m % cols === 0) continue;
      const c = this.cells[m];
      // The gradient is laid out for the first row: shift into this one.
      ctx.save();
      ctx.translate(0, c.y);
      ctx.fillRect(c.x, SEP_INSET, 1, c.h - 2 * SEP_INSET);
      ctx.restore();
    }
    if (this.rows > 1) {
      const y = this.cells[cols].y;
      ctx.fillStyle = COLOR.line;
      ctx.fillRect(PAD, y, this.surface.w - 2 * PAD, 1);
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, m: number, c: Cell): void {
    const def = DEFS[m];
    const x = c.x + PAD;
    const base = c.y + 21;
    drawIcon(ctx, def.icon, x, base - 10, ICON, COLOR.muted);
    ctx.font = uiFont(SIZE.small, 600);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'left';
    ctx.fillText(def.label, x + ICON + 6, base);
    ctx.letterSpacing = '0px';
    if (c.note) {
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.unlikely;
      ctx.textAlign = 'right';
      ctx.fillText(c.note, c.x + c.w - PAD, base);
      ctx.textAlign = 'left';
    }
  }

  private drawFigures(ctx: CanvasRenderingContext2D, m: number, c: Cell, two: boolean, sel: number, empty: boolean): void {
    const def = DEFS[m];
    const x = c.x + PAD;
    const a = empty ? NaN : this.data.slots[0].value(m, sel);
    if (!two) {
      this.figure(ctx, m, def.text(a), x, c.y + c.h - 15, SIZE.figure, COLOR.high);
      return;
    }
    const b = empty ? NaN : this.data.slots[1].value(m, sel);
    if (c.mode === Mode.Inline) {
      const base = c.y + c.h - 15;
      const ta = def.text(a);
      const tb = def.text(b);
      ctx.font = uiFont(SIZE.figure, 600);
      ctx.fillStyle = ta === DASH ? COLOR.unlikely : COLOR.a;
      fillTabular(ctx, ta, x, base);
      this.figure(ctx, m, tb, x + this.bigW + 12, base, SIZE.figure, COLOR.b);
      return;
    }
    // Stacked: a small model letter, then the figure.
    for (let k = 0; k < 2; k++) {
      const base = c.y + c.h - (k === 0 ? 29 : 10);
      ctx.font = uiFont(10, 600);
      ctx.fillStyle = MODEL_COLOR[k];
      ctx.globalAlpha = 0.75;
      ctx.fillText(k === 0 ? 'A' : 'B', x, base - 1);
      ctx.globalAlpha = 1;
      this.figure(ctx, m, def.text(k === 0 ? a : b), x + 14, base, MED, MODEL_COLOR[k]);
    }
  }

  // A figure and its unit, at (x, base), with tabular digits: the figure
  // keeps its place as it changes. A dash is dimmed and has no unit.
  private figure(ctx: CanvasRenderingContext2D, m: number, text: string, x: number, base: number, px: number, color: string): void {
    ctx.font = uiFont(px, 600);
    if (text === DASH) {
      ctx.fillStyle = COLOR.unlikely;
      ctx.fillText(text, x, base);
      return;
    }
    ctx.fillStyle = color;
    const w = fillTabular(ctx, text, x, base);
    const unit = DEFS[m].unit;
    if (!unit) return;
    ctx.font = uiFont(SIZE.small, 500);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(unit, x + w + 4, base);
  }

  private drawSpark(ctx: CanvasRenderingContext2D, m: number, c: Cell, two: boolean, sel: number, empty: boolean): void {
    const bottom = c.sy + c.sh;
    // The floor of the sparkline, always there: an empty one still reads.
    ctx.fillStyle = COLOR.line;
    ctx.fillRect(c.sx, Math.round(bottom) - 0.5, c.sw, 1);
    if (empty) return;

    const { start, end } = this.win;
    if (end <= start) return;
    const def = DEFS[m];
    const slots = two ? 2 : 1;

    // The scale, shared by both models so that their lines compare.
    let hi = def.scale === 'unit' ? 1 : def.scale === 'log' ? 1 : 0;
    if (def.scale !== 'unit') {
      for (let k = 0; k < slots; k++) {
        const v = this.data.slots[k].v[m];
        for (let i = start; i < end; i++) {
          const y = def.scale === 'log' ? Math.log2(v[i]) : v[i];
          if (y > hi) hi = y;
        }
      }
      if (def.scale === 'zero') hi = hi > 0 ? hi * 1.15 : 1;
      else hi *= 1.1;
    }

    const span = Math.max(end - start, MIN_SLOTS) - 1;
    const dx = span > 0 ? c.sw / span : 0;
    const top = c.sy + 2;
    const kh = (bottom - 2 - top) / hi;

    // The selected position: a hairline across the box.
    const inWin = sel >= start && sel < end;
    const selX = c.sx + (sel - start) * dx;
    if (inWin) {
      ctx.fillStyle = COLOR.lineStrong;
      ctx.fillRect(Math.round(selX) - 0.5, c.sy, 1, c.sh);
    }

    ctx.lineWidth = dx < 2 ? 1.25 : 1.5; // a dense line stays crisp
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // The model in front last, on top.
    const front = two ? this.store.front : 0;
    for (let o = 0; o < slots; o++) {
      const k = slots === 2 && o === 0 ? 1 - front : front;
      const v = this.data.slots[k].v[m];
      const log = def.scale === 'log';

      // The fill under each run of values, then the line.
      ctx.beginPath();
      let run = -1;
      let lastX = 0;
      for (let i = start; i <= end; i++) {
        const raw = i < end ? v[i] : NaN;
        const val = log ? Math.log2(raw) : raw;
        if (Number.isFinite(val)) {
          const x = c.sx + (i - start) * dx;
          const y = bottom - 2 - Math.min(val, hi) * kh;
          if (run < 0) {
            run = i;
            ctx.moveTo(x, bottom);
          }
          ctx.lineTo(x, y);
          lastX = x;
        } else if (run >= 0) {
          ctx.lineTo(lastX, bottom);
          ctx.closePath();
          run = -1;
        }
      }
      ctx.fillStyle = c.fills[k];
      ctx.fill();

      ctx.beginPath();
      run = -1;
      for (let i = start; i < end; i++) {
        const val = log ? Math.log2(v[i]) : v[i];
        if (!Number.isFinite(val)) {
          run = -1;
          continue;
        }
        const x = c.sx + (i - start) * dx;
        const y = bottom - 2 - Math.min(val, hi) * kh;
        if (run < 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        run = i;
      }
      ctx.strokeStyle = MODEL_COLOR[k];
      ctx.shadowColor = GLOW[k];
      ctx.shadowBlur = 5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (inWin) {
        const val = log ? Math.log2(v[sel]) : v[sel];
        if (Number.isFinite(val)) {
          const y = bottom - 2 - Math.min(val, hi) * kh;
          ctx.fillStyle = HALO[k];
          ctx.beginPath();
          ctx.arc(selX, y, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = COLOR.high;
          ctx.beginPath();
          ctx.arc(selX, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = MODEL_COLOR[k];
          ctx.beginPath();
          ctx.arc(selX, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}
