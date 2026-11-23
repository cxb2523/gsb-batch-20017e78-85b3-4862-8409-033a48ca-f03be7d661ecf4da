// Pure logic of the Layers view (render/lens.ts): the decision layer, the
// colour ramp of the heat map, the position ↔ x mapping and the grid of
// cells, filled column by column as EVALs arrive.
//
//   grid pixels (RGBA, one pixel per cell)        x: position on the path
//   ┌──────────────────────────────┐ ▲            y: layer, the last on top
//   │ band 0 (A): rows-1 … 0       │ │ rows
//   ├──────────────────────────────┤ ▼
//   │ band 1 (B): rows-1 … 0       │   only with two models
//   └──────────────────────────────┘
//    0 1 2 …              capacity-1
//
// The panel turns the grid into an image and scales it onto the screen, so a
// new token costs writing one column of pixels, not redrawing the map.

import type { Lens } from '../source/frames';
import type { Slot } from '../store/store';
import { MIN_SPAN } from './timeline';

// What the grid needs of a decision: its lens and its top candidate.
export interface LensDecision {
  readonly nRaw: number;
  readonly tokens: Uint32Array;
  readonly lens: Lens | null;
}

// What the grid needs of the store (Store satisfies it).
export interface LensSource {
  readonly path: readonly number[];
  decisionOf(index: number, slot: Slot): LensDecision | undefined;
}

// The final top candidate of a decision: the first raw entry (what answer_p
// refers to), else the favourite of the last layer probed. -1 without either.
export function finalTop(d: LensDecision): number {
  if (d.nRaw > 0 && d.tokens.length > 0) return d.tokens[0];
  const l = d.lens;
  return l && l.topId.length > 0 ? l.topId[l.topId.length - 1] : -1;
}

// The decision layer: the first layer (index into lens.layers) whose
// favourite is `final` and stays so up to the last layer. -1 if the last
// layer's favourite is not `final`.
export function decisionLayer(topId: ArrayLike<number>, final: number): number {
  let r = topId.length;
  while (r > 0 && topId[r - 1] === final) r--;
  return r === topId.length ? -1 : r;
}

// ----------------------------------------------------------- colour ramp

export const RAMP_STEPS = 64;
const RAMP_FLOOR = 0.07; // share of the model colour at p = 0: almost the ground
const RAMP_LIFT = 0.16; // most white mixed in at p = 1: bright, never burnt
const RAMP_GAMMA = 0.5; // spreads the low range, where most layers sit

// RGBA ramp from almost the ground (`ground`) to the bright model colour, in
// RAMP_STEPS + 1 steps, 4 bytes each. Built once per colour.
export function buildRamp(color: string, ground: string): Uint8ClampedArray {
  const c = hexRgb(color);
  const g = hexRgb(ground);
  const out = new Uint8ClampedArray((RAMP_STEPS + 1) * 4);
  for (let i = 0; i <= RAMP_STEPS; i++) {
    const t = i / RAMP_STEPS;
    // Ground → colour over most of the range, then a touch of white on top.
    const k = RAMP_FLOOR + (1 - RAMP_FLOOR) * Math.min(1, t / 0.85);
    const lift = t > 0.85 ? ((t - 0.85) / 0.15) * RAMP_LIFT : 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = g[ch] + (c[ch] - g[ch]) * k;
      out[i * 4 + ch] = Math.round(v + (255 - v) * lift);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Step of the ramp for a probability.
export function rampStep(p: number): number {
  if (!(p > 0)) return 0;
  return Math.round(Math.pow(Math.min(p, 1), RAMP_GAMMA) * RAMP_STEPS);
}

export function hexRgb(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

// ------------------------------------------------------ position ↔ x

// Positions across the map: the path, at least MIN_SPAN (as the Timeline).
export function spanFor(n: number): number {
  return Math.max(n, MIN_SPAN);
}

// Width of a position's column for a map `width` px wide.
export function stepFor(width: number, span: number): number {
  return span > 0 ? Math.max(0, width) / span : 0;
}

// Left edge of the column of position `i`.
export function xOfIndex(i: number, left: number, step: number): number {
  return left + i * step;
}

// Position under `x`, clamped to the path; null without a path or room.
export function indexAtX(x: number, left: number, step: number, n: number): number | null {
  if (n <= 0 || !(step > 0)) return null;
  return Math.max(0, Math.min(n - 1, Math.floor((x - left) / step)));
}

// ----------------------------------------------------------------- grid

export const NO_DATA = -2; // `decided` of a column without lens (the prompt)
const START_COLUMNS = 256;

export class LensGrid {
  rows = 0; // layers probed
  bands = 1; // models
  cols = 0; // positions of the path
  capacity = 0; // width of `pixels`
  // RGBA, `capacity` wide and `bands * rows` tall: see the drawing above.
  pixels = new Uint8ClampedArray(0);
  // Per band, then per column: the decision layer, -1 if it never settles,
  // NO_DATA without lens.
  decided = new Int16Array(0);
  // Columns rewritten by the last update: [from, to). Empty when from >= to.
  from = 0;
  to = 0;
  // True when the last update reallocated `pixels` (every column rewritten).
  relaid = false;
  // Bumped by every update that changed anything.
  version = 0;

  private seen: (LensDecision | undefined)[][] = [[], []];
  private known = 0; // columns whose `seen` entries are valid
  private sig = '';

  // Brings the grid up to date with the path. `ramps[band]` colours each
  // band. Returns true if anything changed.
  update(src: LensSource, rows: number, bands: 1 | 2, ramps: readonly Uint8ClampedArray[]): boolean {
    const cols = rows > 0 ? src.path.length : 0;
    this.relaid = false;
    const sig = `${rows}:${bands}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.rows = rows;
      this.bands = bands;
      this.known = 0;
      this.capacity = 0; // forces the reallocation below
    }
    if (cols > this.capacity || this.capacity === 0) {
      let cap = Math.max(this.capacity, START_COLUMNS);
      while (cap < cols) cap *= 2;
      this.capacity = cap;
      this.pixels = new Uint8ClampedArray(cap * bands * rows * 4);
      this.decided = new Int16Array(cap * bands).fill(NO_DATA);
      this.known = 0;
      this.relaid = true;
    }
    this.cols = cols;

    let from = cols;
    let to = 0;
    for (let i = 0; i < cols; i++) {
      for (let b = 0; b < bands; b++) {
        const d = src.decisionOf(i, b as Slot);
        if (i < this.known && this.seen[b][i] === d) continue;
        this.seen[b][i] = d;
        this.fill(i, b, d, ramps[b]);
        if (i < from) from = i;
        to = i + 1;
      }
    }
    // A shorter path: its old tail is cleared, so a longer one can reuse it.
    for (let i = cols; i < this.known; i++) {
      for (let b = 0; b < bands; b++) {
        if (this.seen[b][i] === undefined) continue;
        this.seen[b][i] = undefined;
        this.fill(i, b, undefined, ramps[b]);
        if (i < from) from = i;
        to = i + 1;
      }
    }
    this.known = cols;
    this.from = from;
    this.to = to;
    const changed = this.relaid || to > from;
    if (changed) this.version++;
    return changed;
  }

  // Decision layer of position `i` in `band`.
  decidedAt(band: number, i: number): number {
    return i >= 0 && i < this.capacity ? this.decided[band * this.capacity + i] : NO_DATA;
  }

  // Colour of the cell of position `i`, layer `r` (index into lens.layers)
  // in `band`, as [r, g, b, a]; for tests.
  cell(band: number, i: number, r: number): number[] {
    const o = this.offset(band, i, r);
    return [...this.pixels.subarray(o, o + 4)];
  }

  private offset(band: number, i: number, r: number): number {
    const y = band * this.rows + (this.rows - 1 - r);
    return (y * this.capacity + i) * 4;
  }

  private fill(i: number, band: number, d: LensDecision | undefined, ramp: Uint8ClampedArray): void {
    const lens = d?.lens ?? null;
    const px = this.pixels;
    for (let r = 0; r < this.rows; r++) {
      const o = this.offset(band, i, r);
      if (lens === null || r >= lens.answerP.length) {
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
        continue;
      }
      const s = rampStep(lens.answerP[r]) * 4;
      px[o] = ramp[s];
      px[o + 1] = ramp[s + 1];
      px[o + 2] = ramp[s + 2];
      px[o + 3] = ramp[s + 3];
    }
    this.decided[band * this.capacity + i] = lens === null || d === undefined ? NO_DATA : decisionLayer(lens.topId, finalTop(d));
  }
}
