// Layers (Canvas 2D): the logit lens of the whole viewed path, in the dock.
//
//   ◇ Layers  probability of the final top token, layer by layer   ┊ A #57 [·reuses]  ✓ decided at layer 17
//   A  L23 ▓▓▓▓▓▓▓▓▓▒▒▒▓▓▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓              ┊ L23 [·reuses ] ████████  92%  0.4 bits
//      ...  ░░▒▒▓▓░░▒▒▓▓▒▒░░▒▒▓▓▓│▓▒▒░░▒▒▓▓   ─ decision  ┊ L20 [·reuses ] ██████    71%  1.2 bits
//      L0  ░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░   layer      ┊ ...
//   B  L23 ▓▓▓▓▓▓▓▓▓▓▒▒▓▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓              ┊ L0  [ the    ] ██         18%  9.8 bits
//      L0  ░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░              ┊
//          0        20        40  ▲ selection (white)
//
// Left: a heat map, one column per position of the path, one row per layer
// probed (the last on top), coloured by answer_p: how likely the final top
// candidate already is at that layer. One band per model. A thin mark per
// column at its decision layer (lens-data.ts decisionLayer). The pointer
// selects the position (the sweep, animation 5); a click pins it.
//
// Right (below on a narrow panel): the selected position, layer by layer,
// for the model in front: the favourite of each layer, its probability and
// the entropy.
//
// The cells live in a grid of pixels (lens-data.ts) written column by column
// as EVALs arrive; the map with its labels is composed into an offscreen
// canvas only when the data or the size change. Moving the pointer costs a
// blit, the cursor and the detail.

import { NONE, type VocabEntry } from '../source/frames';
import type { EvalData, Slot, Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import { drawIcon } from './icons';
import { buildRamp, decisionLayer, finalTop, indexAtX, LensGrid, RAMP_STEPS, spanFor, stepFor } from './lens-data';
import { Surface } from './surface';
import { COLOR, MODEL_COLOR, SIZE, font, rgba, roundRect, uiFont } from './theme';

const PAD_X = 14;
const HEAD_Y = 16; // the header line
const TOP = 32; // the map never starts above this
const AXIS_H = 16; // position labels under the map
const BAND_GAP = 12; // between the bands of A and B
const LABEL_ONE = 40; // the label column before the map: one model, two
const LABEL_TWO = 66;
const DETAIL_MIN = 290; // the detail column
const DETAIL_MAX = 340;
const DETAIL_GAP = 28; // from the map to the detail, a hairline in between
const STACK_BELOW = 680; // narrower than this: the detail goes under the map
const TICK_MIN_PX = 64;
const ROW_MAX = 24; // tallest row of the detail
const GAP_MIN = 5; // least cell size (px) that gets a hairline gap around it

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Colours with alpha, built once.
const TINT = MODEL_COLOR.map((c) => rgba(c, 0.07));
const TINT_STRONG = MODEL_COLOR.map((c) => rgba(c, 0.16));
const HALO = rgba(COLOR.high, 0.07);
const HALO_CORE = rgba(COLOR.high, 0.18);
const MARK = rgba(COLOR.high, 0.55);
const TRACK = rgba(COLOR.line, 0.5);
const TRACK_PROMPT = rgba(COLOR.line, 0.2);
// Gradient stops of each model's ramp, for the legend.
const RAMPS = MODEL_COLOR.map((c) => buildRamp(c, COLOR.bg));
const LEGEND_STOPS = RAMPS.map((ramp) => {
  const out: string[] = [];
  for (let k = 0; k <= 8; k++) {
    const s = Math.round((k / 8) * RAMP_STEPS) * 4;
    out.push(`rgb(${ramp[s]},${ramp[s + 1]},${ramp[s + 2]})`);
  }
  return out;
});

// "0%" … "100%", and entropies to a tenth of a bit, so painting builds no text.
const PCT = Array.from({ length: 101 }, (_, i) => `${i}%`);
const BITS = Array.from({ length: 321 }, (_, i) => `${(i / 10).toFixed(1)} bits`);
const LETTER = ['A', 'B'];

export class LensPanel {
  private readonly surface: Surface;
  private readonly grid = new LensGrid();
  private readonly cells = document.createElement('canvas'); // the grid, one pixel per cell
  private cellsImage: ImageData | null = null;
  private readonly strip = document.createElement('canvas'); // the grid resampled to the map's width
  private readonly comp = document.createElement('canvas'); // the composed map
  private compKey = '';

  // Layout, as last composed.
  private two = false;
  private rows = 0;
  private left = PAD_X + LABEL_ONE; // the map's box
  private right = PAD_X;
  private top = TOP;
  private bottom = TOP;
  private bandTop = [TOP, TOP];
  private bandH = 0;
  private step = 0;
  private detailBox: Box = { x: 0, y: 0, w: 0, h: 0 };
  private stacked = false;

  // Token texts: the full label per vocabulary entry, and the label cut to
  // a chip's width per token id and length.
  private readonly labels = new WeakMap<VocabEntry, string>();
  private readonly cut = new Map<number, string>();
  private layerNames: string[] = [];
  private layersOf: number[] | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.surface = new Surface(canvas, () => {
      this.store.dirty.lens = true;
    });
    canvas.addEventListener('mousemove', (e) => {
      const i = this.indexAt(e.offsetX, e.offsetY);
      if (i !== null) this.view.setHover(i);
    });
    canvas.addEventListener('mouseleave', () => this.view.setHover(null));
    canvas.addEventListener('click', (e) => {
      const i = this.indexAt(e.offsetX, e.offsetY);
      if (i === null) return;
      if (this.view.pinnedIndex() === i) this.view.unpin();
      else this.view.pin(i);
    });
  }

  paint(): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    const s = this.store;
    const h = s.hello;
    const rows = h !== null && h.lens.enabled ? h.lens.layers.length : 0;
    const two = s.twoModels;
    if (h !== null && h.lens.layers !== this.layersOf) {
      this.layersOf = h.lens.layers;
      this.layerNames = h.lens.layers.map((l) => `L${l}`);
    }

    if (rows > 0) {
      this.grid.update(s, rows, two ? 2 : 1, RAMPS);
      this.pushCells();
    }
    const n = rows > 0 ? s.path.length : 0;
    const key = `${s.pathEpoch}:${n}:${two}:${s.front}:${rows}:${sf.canvas.width}:${sf.canvas.height}:${this.grid.version}`;
    if (key !== this.compKey) {
      this.compKey = key;
      this.compose(rows, two, n);
    }
    ctx.drawImage(this.comp, 0, 0, sf.w, sf.h);
    if (rows === 0) return;

    const sel = n > 0 ? this.view.selected() : -1;
    if (sel >= 0) this.cursor(sel);
    this.detail(sel);
  }

  dispose(): void {
    this.surface.dispose();
  }

  // ----------------------------------------------------------- internal

  // Position under (x, y) if it is on the map (or its axis), else null.
  private indexAt(x: number, y: number): number | null {
    if (this.rows === 0 || x < this.left - 2 || x > this.right + 2) return null;
    if (y < this.top - 8 || y > this.bottom + AXIS_H) return null;
    return indexAtX(x, this.left, this.step, this.store.path.length);
  }

  // Copies the columns the grid rewrote into the cells canvas.
  private pushCells(): void {
    const g = this.grid;
    const ch = g.bands * g.rows;
    if (ch === 0) return;
    if (g.relaid || this.cellsImage === null) {
      this.cells.width = g.capacity;
      this.cells.height = ch;
      this.cellsImage = new ImageData(g.pixels, g.capacity, ch);
      this.cells.getContext('2d')?.putImageData(this.cellsImage, 0, 0);
      return;
    }
    if (g.to > g.from) this.cells.getContext('2d')?.putImageData(this.cellsImage, 0, 0, g.from, 0, g.to - g.from, ch);
  }

  private layout(rows: number, two: boolean): void {
    const { w, h } = this.surface;
    this.two = two;
    this.rows = rows;
    this.stacked = w < STACK_BELOW;
    const axis = h >= 150 ? AXIS_H : 0;
    let mapBottom: number;
    if (this.stacked) {
      const split = Math.round(TOP + (h - TOP) * 0.46);
      this.right = w - PAD_X;
      mapBottom = split - axis - 6;
      this.detailBox = { x: PAD_X, y: split + 8, w: w - 2 * PAD_X, h: h - split - 14 };
    } else {
      const dw = Math.round(Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, w * 0.24)));
      this.right = w - PAD_X - dw - DETAIL_GAP;
      mapBottom = h - axis - 8;
      this.detailBox = { x: w - PAD_X - dw, y: 6, w: dw, h: h - 12 };
    }
    this.left = PAD_X + (two ? LABEL_TWO : LABEL_ONE);
    this.top = TOP;
    this.bottom = Math.max(TOP, mapBottom);
    const avail = this.bottom - this.top;
    this.bandH = two ? Math.max(0, (avail - BAND_GAP) / 2) : avail;
    this.bandTop = [this.top, this.top + this.bandH + BAND_GAP];
    this.step = stepFor(this.right - this.left, spanFor(this.store.path.length));
  }

  // The map with its labels, into the offscreen canvas.
  private compose(rows: number, two: boolean, n: number): void {
    const sf = this.surface;
    const c = this.comp;
    c.width = sf.canvas.width;
    c.height = sf.canvas.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(c.width / sf.w, 0, 0, c.height / sf.h, 0, 0);
    ctx.clearRect(0, 0, sf.w, sf.h);
    this.layout(rows, two);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    this.header(ctx);
    if (rows === 0) {
      ctx.font = uiFont(SIZE.body);
      ctx.fillStyle = COLOR.low;
      ctx.fillText('This session has no logit lens: start the engine with --lens.', PAD_X, this.top + 20);
      return;
    }
    const bands = two ? 2 : 1;
    const s = this.store;
    const prompt = Math.min(s.promptLength, n);
    const rowH = this.bandH / rows;
    const cellsW = n * this.step;

    for (let b = 0; b < bands; b++) {
      const y = this.bandTop[b];
      this.bandLabel(ctx, b as Slot, y, rowH);
      // The track under the cells: dimmer over the prompt, which has none.
      ctx.fillStyle = TRACK_PROMPT;
      roundRect(ctx, this.left, y, this.right - this.left, this.bandH, 4);
      ctx.fill();
      if (cellsW > prompt * this.step) {
        ctx.fillStyle = TRACK;
        ctx.fillRect(this.left + prompt * this.step, y, cellsW - prompt * this.step, this.bandH);
      }
    }
    if (n === 0) {
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.low;
      ctx.fillText('Waiting for the first token', this.left + 10, this.top + this.bandH / 2);
      return;
    }

    this.drawCells(ctx, n, bands, rowH);
    this.drawMarks(ctx, n, bands, rowH);
    if (prompt * this.step > 54) {
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.low;
      ctx.textAlign = 'center';
      ctx.fillText('prompt', this.left + (prompt * this.step) / 2, this.bandTop[0] + this.bandH / 2);
      ctx.textAlign = 'left';
    }
    if (this.surface.h >= 150) this.drawTicks(ctx, n);
  }

  // The cells, scaled to the map: first across (smoothed when the columns
  // are narrower than a few pixels, so none is skipped), then down (crisp,
  // so layers do not bleed into each other). A hairline cut between cells
  // when they are big enough to carry one.
  private drawCells(ctx: CanvasRenderingContext2D, n: number, bands: number, rowH: number): void {
    const sf = this.surface;
    const dpr = sf.canvas.width / sf.w;
    const g = this.grid;
    const ch = bands * g.rows;
    const sw = Math.max(1, Math.round(n * this.step * dpr));
    const st = this.strip;
    if (st.width !== sw || st.height !== ch) {
      st.width = sw;
      st.height = ch;
    }
    const sx = st.getContext('2d');
    if (!sx) return;
    sx.clearRect(0, 0, sw, ch);
    sx.imageSmoothingEnabled = this.step * dpr < 3;
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(this.cells, 0, 0, n, ch, 0, 0, sw, ch);

    const cellsW = n * this.step;
    ctx.imageSmoothingEnabled = false;
    for (let b = 0; b < bands; b++) {
      const y = this.bandTop[b];
      ctx.save();
      roundRect(ctx, this.left, y, this.right - this.left, this.bandH, 4);
      ctx.clip();
      ctx.drawImage(st, 0, b * g.rows, sw, g.rows, this.left, y, cellsW, this.bandH);
      // Hairline gaps: rows always when tall enough, columns when wide enough.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      if (rowH >= GAP_MIN) {
        for (let r = 1; r < g.rows; r++) ctx.fillRect(this.left, Math.round(y + r * rowH) - 0.5, cellsW, 1);
      }
      if (this.step >= GAP_MIN) {
        for (let i = 1; i < n; i++) ctx.fillRect(Math.round(this.left + i * this.step) - 0.5, y, 1, this.bandH);
      }
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
  }

  // A thin white mark on each column at the bottom of its decision layer:
  // from there up, the favourite is the final one. Where the columns are
  // narrow the marks join into a contour across the map.
  private drawMarks(ctx: CanvasRenderingContext2D, n: number, bands: number, rowH: number): void {
    const g = this.grid;
    const step = this.step;
    const inset = step >= GAP_MIN ? 1 : 0;
    const w = Math.max(1, step - inset);
    const th = rowH >= 8 ? 1.5 : 1;
    ctx.fillStyle = MARK;
    for (let b = 0; b < bands; b++) {
      const y0 = this.bandTop[b];
      for (let i = 0; i < n; i++) {
        const d = g.decidedAt(b, i);
        if (d < 0) continue;
        const y = y0 + (g.rows - d) * rowH;
        ctx.fillRect(this.left + i * step + inset / 2, Math.min(y, y0 + this.bandH) - th, w, th);
      }
    }
  }

  // What a cell's colour means, and the legend at the map's right end. The
  // tab above already names the view.
  private header(ctx: CanvasRenderingContext2D): void {
    if (this.rows === 0) return;

    // Legend, right to left: the ramp(s), then the decision mark.
    let r = this.right;
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    ctx.textAlign = 'right';
    ctx.fillText('100%', r, HEAD_Y);
    r -= ctx.measureText('100%').width + 6;
    const rw = 64;
    const bands = this.two ? 2 : 1;
    for (let b = 0; b < bands; b++) {
      const grad = ctx.createLinearGradient(r - rw, 0, r, 0);
      LEGEND_STOPS[b].forEach((c, k, a) => grad.addColorStop(k / (a.length - 1), c));
      ctx.fillStyle = grad;
      const bh = this.two ? 4 : 6;
      roundRect(ctx, r - rw, this.two ? HEAD_Y - 4.5 + b * 5 : HEAD_Y - 3, rw, bh, 2);
      ctx.fill();
    }
    r -= rw + 6;
    ctx.fillStyle = COLOR.low;
    ctx.fillText('0', r, HEAD_Y);
    r -= ctx.measureText('0').width + 18;
    ctx.fillText('decision layer', r, HEAD_Y);
    r -= ctx.measureText('decision layer').width + 6;
    ctx.fillStyle = MARK;
    ctx.fillRect(r - 12, HEAD_Y - 0.75, 12, 1.5);
    r -= 12;
    ctx.textAlign = 'left';

    // The note, if it fits before the legend.
    ctx.font = uiFont(SIZE.small, 500);
    const title = 'Each cell';
    const tw = ctx.measureText(title).width;
    ctx.font = uiFont(SIZE.small);
    const note = ': probability of the final top token at that layer';
    if (PAD_X + tw + ctx.measureText(note).width < r - 16) {
      ctx.font = uiFont(SIZE.small, 500);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(title, PAD_X, HEAD_Y);
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.low;
      ctx.fillText(note, PAD_X + tw, HEAD_Y);
    }
  }

  // The band's model (two models) and its layer names, in the left column.
  private bandLabel(ctx: CanvasRenderingContext2D, slot: Slot, y: number, rowH: number): void {
    const s = this.store;
    const rows = this.rows;
    const h = this.bandH;
    const inFront = !this.two || slot === s.front;
    ctx.fillStyle = MODEL_COLOR[slot];
    ctx.globalAlpha = inFront ? 1 : 0.55;
    roundRect(ctx, PAD_X, y + 1, 3, h - 2, 1.5);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (this.two) {
      ctx.font = uiFont(SIZE.label, 600);
      ctx.fillStyle = inFront ? MODEL_COLOR[slot] : COLOR.muted;
      const quant = s.hello?.models[slot]?.quant ?? '';
      const tall = h >= 34 && quant !== '';
      ctx.fillText(LETTER[slot], PAD_X + 9, tall ? y + h / 2 - 7 : y + h / 2);
      if (tall) {
        ctx.font = font(9.5);
        ctx.fillStyle = COLOR.low;
        ctx.fillText(quant.length > 6 ? quant.slice(0, 6) : quant, PAD_X + 9, y + h / 2 + 7);
      }
    }
    // Layer names, right-aligned against the map: every row with room,
    // else every k-th, always the first and the last.
    ctx.font = font(9.5);
    ctx.fillStyle = COLOR.low;
    ctx.textAlign = 'right';
    const every = Math.max(1, Math.ceil(15 / Math.max(rowH, 0.1)));
    for (let r = 0; r < rows; r++) {
      if (r !== 0 && r !== rows - 1 && r % every !== 0) continue;
      if (r !== rows - 1 && r !== 0 && rows - 1 - r < every) continue; // too near the top name
      if (rowH < 6 && r !== 0 && r !== rows - 1) continue;
      const cy = y + (rows - 1 - r + 0.5) * rowH;
      ctx.fillText(this.layerNames[r] ?? '', this.left - 6, cy);
    }
    ctx.textAlign = 'left';
  }

  // Position labels under the map, at a round step with room between.
  private drawTicks(ctx: CanvasRenderingContext2D, n: number): void {
    const step = this.step;
    if (!(step > 0)) return;
    let every = 1;
    for (const k of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      every = k;
      if (k * step >= TICK_MIN_PX) break;
    }
    const y = this.bottom + AXIS_H / 2 + 3;
    ctx.font = font(10);
    ctx.textAlign = 'center';
    const span = spanFor(n);
    for (let i = 0; i < span; i += every) {
      const x = this.left + (i + 0.5) * step;
      ctx.fillStyle = COLOR.lineStrong;
      ctx.fillRect(Math.round(x), this.bottom + 1, 1, 3);
      ctx.fillStyle = COLOR.low;
      ctx.fillText(`${i}`, x, y);
    }
    ctx.textAlign = 'left';
  }

  // The selected column: a white line with a soft halo across the bands,
  // an outline of the column where the cells are wide, the decision marks
  // lit, and the position in a pill on the axis.
  private cursor(sel: number): void {
    const ctx = this.surface.ctx;
    const pinned = this.view.pinnedIndex() !== null;
    const step = this.step;
    const x0 = this.left + sel * step;
    const cx = Math.round(x0 + step / 2);
    const top = this.top - 5;
    const h = this.bottom - this.top + 10;
    const bands = this.two ? 2 : 1;
    const rowH = this.bandH / this.rows;

    ctx.fillStyle = HALO;
    ctx.fillRect(cx - 7, top, 14, h);
    ctx.fillStyle = HALO_CORE;
    ctx.fillRect(cx - 2, top, 4, h);
    ctx.fillStyle = COLOR.high;
    ctx.globalAlpha = pinned ? 1 : 0.8;
    if (step >= 6) {
      ctx.strokeStyle = COLOR.high;
      ctx.lineWidth = 1.5;
      for (let b = 0; b < bands; b++) {
        ctx.strokeRect(Math.round(x0) - 0.25, this.bandTop[b] - 0.75, Math.max(2, step) + 0.5, this.bandH + 1.5);
      }
      // Stubs above and below join the two boxes into one cursor.
      ctx.fillRect(cx - 0.5, top, 1, 4);
      ctx.fillRect(cx - 0.5, this.bottom + 1, 1, 4);
    } else {
      ctx.fillRect(cx - 0.5, top, 1, h);
    }
    // The decision marks of the column, wider and brighter.
    for (let b = 0; b < bands; b++) {
      const d = this.grid.decidedAt(b, sel);
      if (d < 0) continue;
      const y = Math.min(this.bandTop[b] + (this.rows - d) * rowH, this.bandTop[b] + this.bandH);
      ctx.fillRect(cx - Math.max(5, step / 2 + 2), y - 2, Math.max(10, step + 4), 2);
    }
    ctx.globalAlpha = 1;

    if (this.surface.h >= 150) {
      const label = `${sel}`;
      ctx.font = font(10);
      const tw = ctx.measureText(label).width + 10;
      const px = Math.max(this.left, Math.min(this.right - tw, cx - tw / 2));
      const py = this.bottom + 3;
      // The position labels it would overlap are wiped first.
      ctx.clearRect(px - 14, py, tw + 28, 14);
      ctx.fillStyle = COLOR.surface3;
      roundRect(ctx, px, py, tw, 14, 4);
      ctx.fill();
      ctx.fillStyle = COLOR.high;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px + tw / 2, py + 7.5);
      ctx.textAlign = 'left';
    }
  }

  // The selected position, layer by layer, for the model in front (the
  // other where only the other has a lens there).
  private detail(sel: number): void {
    const ctx = this.surface.ctx;
    const s = this.store;
    const box = this.detailBox;
    if (box.w < 60 || box.h < 20) return;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // A hairline between the map and the detail.
    ctx.fillStyle = COLOR.line;
    if (this.stacked) ctx.fillRect(box.x, box.y - 6, box.w, 1);
    else ctx.fillRect(box.x - DETAIL_GAP / 2, box.y + 4, 1, box.h - 8);

    let slot: Slot = s.front;
    let d: EvalData | undefined = sel >= 0 ? s.decisionOf(sel, slot) : undefined;
    if (this.two && !d?.lens) {
      const o = s.decisionOf(sel, s.other);
      if (o?.lens) {
        slot = s.other;
        d = o;
      }
    }
    const lens = d?.lens ?? null;
    const color = MODEL_COLOR[slot];
    const y1 = box.y + 10;

    // Line 1: the model, the position, the final top token, the decision.
    let x = box.x;
    if (this.two) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 4, y1, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = uiFont(SIZE.label, 600);
      ctx.fillText(LETTER[slot], x + 12, y1);
      x += 12 + ctx.measureText(LETTER[slot]).width + 8;
    }
    if (sel < 0) {
      this.quiet(ctx, 'Waiting for the first token', box.x, y1 + 26);
      return;
    }
    ctx.font = font(SIZE.small);
    ctx.fillStyle = COLOR.muted;
    const pos = `#${sel}`;
    ctx.fillText(pos, x, y1);
    x += ctx.measureText(pos).width + 8;

    if (!d || !lens) {
      this.chip(ctx, s.token[s.path[sel]], x, y1, Math.min(150, box.x + box.w - x), 18, SIZE.small, false, -1);
      const promptTok = s.decisionNode(sel) === NONE;
      this.quiet(
        ctx,
        promptTok ? 'Prompt token: the lens starts at the first generated token.' : 'No lens data at this position.',
        box.x,
        y1 + 26,
      );
      return;
    }

    const final = finalTop(d);
    const dec = decisionLayer(lens.topId, final);
    const rows = Math.min(this.rows, lens.topId.length);

    // The decision, right-aligned; the final token's chip fills the gap.
    ctx.font = uiFont(SIZE.small, 500);
    const decText = dec < 0 ? 'not settled' : dec === 0 ? 'decided at the first layer' : 'decided at layer ';
    const decNum = dec > 0 ? (this.layerNames[dec]?.slice(1) ?? '') : '';
    ctx.font = font(SIZE.small, true);
    const numW = decNum ? ctx.measureText(decNum).width : 0;
    ctx.font = uiFont(SIZE.small, 500);
    const textW = ctx.measureText(decText).width;
    const decW = textW + numW + (dec >= 0 ? 18 : 0);
    const right = box.x + box.w;
    ctx.font = font(SIZE.small);
    const want = ctx.measureText(this.tokenText(final, 16)).width + 14;
    const chipW = Math.min(want, right - x - decW - 12);
    if (chipW >= 30) this.chip(ctx, final, x, y1, chipW, 20, SIZE.small, true, slot);
    let dx = right - decW;
    if (dec >= 0) {
      drawIcon(ctx, 'check', dx, y1 - 7, 14, color);
      dx += 18;
    }
    ctx.font = uiFont(SIZE.small, 500);
    ctx.fillStyle = dec < 0 ? COLOR.low : COLOR.high;
    ctx.fillText(decText, dx, y1);
    if (decNum) {
      ctx.font = font(SIZE.small, true);
      ctx.fillStyle = color;
      ctx.fillText(decNum, dx + textW, y1);
    }

    // Line 2: what the bars are, and the sampled token when it differs.
    const y2 = y1 + 20;
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    ctx.fillText('probability of the top candidate, per layer', box.x, y2);
    const picked = d.pick < d.tokens.length ? d.tokens[d.pick] : final;

    // The rows, last layer on top.
    const y0 = y2 + 12;
    const avail = box.y + box.h - y0;
    const rowH = Math.min(ROW_MAX, avail / Math.max(1, rows));
    if (rowH < 3) return;
    const full = rowH >= 15;
    const small = !full && rowH >= 11;
    const fs = full ? SIZE.small : 10;
    const labelW = full ? 32 : 28;
    const entW = full ? 62 : small ? 56 : 0;
    const pctW = full || small ? 36 : 0;
    const chipW2 = full || small ? Math.round(Math.min(124, Math.max(70, box.w * 0.34))) : 0;
    const barX = box.x + labelW + (chipW2 > 0 ? chipW2 + 10 : 0);
    const barW = Math.max(12, right - entW - pctW - barX - 8);

    // The settled zone, from the top layer down to the decision layer.
    if (dec >= 0) {
      ctx.fillStyle = TINT[slot];
      roundRect(ctx, box.x - 4, y0, box.w + 8, (rows - dec) * rowH, 6);
      ctx.fill();
    }

    for (let r = rows - 1; r >= 0; r--) {
      const ry = y0 + (rows - 1 - r) * rowH;
      const cy = ry + rowH / 2;
      const top = lens.topId[r];
      const isFinal = top === final;
      const isDec = r === dec;
      if (full || small) {
        ctx.font = font(fs - 0.5);
        ctx.fillStyle = isDec ? color : COLOR.low;
        ctx.fillText(this.layerNames[r] ?? '', box.x, cy);
        this.chip(ctx, top, box.x + labelW, cy, chipW2, Math.min(rowH - 3, 19), fs, isFinal, isDec ? slot : -1);
      } else if (isDec || r === rows - 1 || r === 0) {
        ctx.font = font(9);
        ctx.fillStyle = isDec ? color : COLOR.low;
        ctx.fillText(this.layerNames[r] ?? '', box.x, cy);
      }
      // The bar: the layer's favourite's probability.
      const bh = full ? 6 : small ? 5 : Math.max(2, Math.min(4, rowH - 3));
      ctx.fillStyle = COLOR.faint;
      roundRect(ctx, barX, cy - bh / 2, barW, bh, bh / 2);
      ctx.fill();
      const p = Math.min(1, Math.max(0, lens.topP[r]));
      if (p > 0) {
        ctx.fillStyle = isFinal ? color : COLOR.muted;
        ctx.globalAlpha = isFinal ? 1 : 0.55;
        roundRect(ctx, barX, cy - bh / 2, Math.max(bh, p * barW), bh, bh / 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Where the favourite is another token: how far the final one is.
      if (!isFinal && lens.answerP[r] > 0.004) {
        ctx.fillStyle = color;
        ctx.fillRect(barX + Math.min(1, lens.answerP[r]) * barW - 1, cy - bh / 2 - 2, 2, bh + 4);
      }
      if (pctW > 0) {
        ctx.font = font(fs - 0.5);
        ctx.textAlign = 'right';
        ctx.fillStyle = isFinal ? COLOR.high : COLOR.muted;
        ctx.fillText(PCT[Math.round(p * 100)], barX + barW + 4 + pctW, cy);
        ctx.fillStyle = COLOR.low;
        ctx.font = font(fs - 1);
        ctx.fillText(BITS[Math.min(BITS.length - 1, Math.max(0, Math.round(lens.entropy[r] * 10)))], right, cy);
        ctx.textAlign = 'left';
      }
    }

    // Under the rows, if there is room: the sampled token when it is not the top one.
    const below = y0 + rows * rowH + 12;
    if (picked !== final && below + 6 < box.y + box.h) {
      ctx.font = uiFont(10.5);
      ctx.fillStyle = COLOR.low;
      ctx.fillText('sampled instead', box.x, below);
      const lw = ctx.measureText('sampled instead').width + 8;
      this.chip(ctx, picked, box.x + lw, below, Math.min(130, box.w - lw), 18, 10.5, false, -1);
    }
  }

  // A token's text in a chip, left edge at x, centred on y. `lit`: the final
  // top token (bright text); `edge`: the slot whose colour outlines it (-1 none).
  private chip(
    ctx: CanvasRenderingContext2D,
    token: number,
    x: number,
    y: number,
    w: number,
    h: number,
    fs: number,
    lit: boolean,
    edge: number,
  ): void {
    if (w < 16 || h < 6) return;
    ctx.fillStyle = edge >= 0 ? TINT_STRONG[edge] : COLOR.surface2;
    roundRect(ctx, x, y - h / 2, w, h, Math.min(5, h / 2));
    ctx.fill();
    ctx.strokeStyle = edge >= 0 ? MODEL_COLOR[edge] : lit ? COLOR.lineStrong : COLOR.line;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y - h / 2 + 0.5, w - 1, h - 1, Math.min(5, h / 2));
    ctx.stroke();
    ctx.font = font(fs);
    ctx.fillStyle = lit ? COLOR.high : COLOR.muted;
    const chars = Math.max(1, Math.floor((w - 10) / (fs * 0.6)));
    ctx.fillText(this.tokenText(token, chars), x + 6, y + 0.5);
  }

  // The token's label, whitespace visible, cut to `chars` characters.
  private tokenText(token: number, chars: number): string {
    chars = Math.min(chars, 127);
    const key = token * 128 + chars;
    let t = this.cut.get(key);
    if (t !== undefined) return t;
    const v = this.store.vocab.get(token);
    let full = v ? this.labels.get(v) : undefined;
    if (full === undefined) {
      full = v ? showWhitespace(tokenLabel(v.bytes)) : `#${token}`;
      if (v) this.labels.set(v, full);
    }
    const a = Array.from(full);
    t = a.length <= chars ? full : a.slice(0, Math.max(1, chars - 1)).join('') + '…';
    if (this.cut.size > 4096) this.cut.clear();
    this.cut.set(key, t);
    return t;
  }

  private quiet(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.font = uiFont(SIZE.small);
    ctx.fillStyle = COLOR.low;
    ctx.fillText(text, x, y);
  }
}
