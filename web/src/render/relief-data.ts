// The numbers of the relief, without three.js
// or the DOM: a grid of heights, one column per position of the viewed path
// and one row per candidate (Alternatives) or per lens layer (Layers), two
// per-column values that decide where the surface lights up, and the timing
// of animation 4.
//
//   rows ▲   Alternatives: row j = candidate j of the decision, most likely first
//        │   Layers:       row j = layer j of HELLO lens.layers, first layer first
//        │
//        └──────────────► columns = positions of the viewed path (0 … path.length-1)
//
// Heights are sqrt(p) (p_raw in Alternatives, answer_p in Layers): the root
// lifts the small probabilities off the ground, where a linear height would
// leave them flat, and keeps 1 at 1.
//
// Per column, 0..1:
//   doubt  how far the model hesitated in the decision shown in front:
//          smoothstep(0.1, 0.6, 1 - p of its first candidate). The surface
//          turns near white only on the crests of hesitant columns.
//   div    how far the two models parted (divergenceOf): 1 where they picked
//          different tokens, a little where only their distributions differ.
//          The surface turns magenta there.
//
// Heights live in Float32Arrays indexed `column * rows + row`, so a new column
// is a contiguous block at the end. The arrays only grow (doubling); refills
// allocate nothing.
//
// A column is recomputed only when the EVALs or the PAIR it is built from
// change (by identity: the store replaces the object when a second one
// arrives), so a new step costs one column, not the whole path.

import { PAIR_SAME_PICK, type PairFrame } from '../source/frames';
import type { EvalData, Slot, Store } from '../store/store';

export type ReliefSource = 'alternatives' | 'layers';

const START_COLUMNS = 256;

// Hesitation (0..1) in a decision: 0 when the first candidate took 90% or
// more, 1 when it took 40% or less. 0 without a decision.
export function doubtOf(d: EvalData | undefined): number {
  if (!d || d.nRaw === 0) return 0;
  return smoothstep(0.1, 0.6, 1 - d.pRaw[0]);
}

// How far two models parted in one decision (0..1): 1 where they picked
// different tokens; else a little, up to 0.45, from their Jensen-Shannon
// divergence (bits). 0 without a comparison.
export const DIV_SAME_MAX = 0.45;
export function divergenceOf(pair: PairFrame | undefined): number {
  if (!pair) return 0;
  if ((pair.flags & PAIR_SAME_PICK) === 0) return 1;
  const js = pair.js > 0 ? pair.js : 0; // also NaN
  return Math.min(js * 2, 1) * DIV_SAME_MAX;
}

// p_raw of `token` among the entries of `d` (extras included), 0 if absent.
export function pOf(d: EvalData, token: number): number {
  const t = d.tokens;
  for (let k = 0; k < t.length; k++) {
    if (t[k] === token) return d.pRaw[k];
  }
  return 0;
}

export class ReliefData {
  source: ReliefSource = 'alternatives';
  cols = 0; // columns in use: the length of the viewed path
  rows = 0;
  capacity = 0; // columns the arrays hold
  // Heights 0..1 (sqrt of the probability) of the surface in front and of
  // the other model's (only in Alternatives with two models; 0 elsewhere).
  front = new Float32Array(0);
  back = new Float32Array(0);
  // Per column, 0..1: hesitation of the decision in front, and divergence
  // of the two models (see the header).
  doubt = new Float32Array(0);
  div = new Float32Array(0);
  // Per column: the slot whose EVAL the front surface shows (the model in
  // front, or the other where only the other evaluated the node).
  tone = new Uint8Array(0);
  // Columns rewritten by the last update: [from, to). Empty when from >= to.
  from = 0;
  to = 0;

  // EVALs and PAIR each column was built from, for the identity check.
  private seenF: (EvalData | undefined)[] = [];
  private seenO: (EvalData | undefined)[] = [];
  private seenP: (PairFrame | undefined)[] = [];
  private known = 0; // columns whose seen* entries are valid
  private sig = '';

  // Brings the grid up to date with the store. Returns true if any column
  // changed (see from / to) or the layout did (rows, capacity).
  update(store: Store, source: ReliefSource): boolean {
    const h = store.hello;
    const layers = source === 'layers' && h !== null && h.lens.enabled;
    const src: ReliefSource = layers ? 'layers' : 'alternatives';
    const rows = h === null ? 0 : layers ? h.lens.layers.length : h.n_raw;
    const front = store.front;
    const two = store.twoModels;
    const other: Slot = front === 0 ? 1 : 0;
    const cols = rows > 0 ? store.path.length : 0;

    let relaid = false;
    const sig = `${src}:${rows}:${front}:${two}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.source = src;
      this.known = 0;
      relaid = rows !== this.rows;
      this.rows = rows;
    }
    if (cols > this.capacity || relaid) {
      this.grow(Math.max(cols, START_COLUMNS));
      relaid = true;
    }
    this.cols = cols;

    let from = cols;
    let to = 0;
    for (let i = 0; i < cols; i++) {
      const dF = store.decisionOf(i, front);
      const dO = two ? store.decisionOf(i, other) : undefined;
      const pr = two ? store.pairAt(i) : undefined;
      if (i < this.known && this.seenF[i] === dF && this.seenO[i] === dO && this.seenP[i] === pr) continue;
      this.seenF[i] = dF;
      this.seenO[i] = dO;
      this.seenP[i] = pr;
      const d = dF ?? dO;
      if (src === 'layers') this.layerColumn(i, d);
      else this.altColumn(i, d, dF ? dO : undefined);
      this.tone[i] = dF ? front : dO ? other : front;
      this.doubt[i] = doubtOf(d);
      this.div[i] = divergenceOf(pr);
      if (i < from) from = i;
      to = i + 1;
    }
    this.known = Math.max(this.known, cols);
    this.from = from;
    this.to = to;
    return relaid || to > from;
  }

  // Alternatives: the first rows of `base` (the decision shown in front)
  // and, for the same tokens, what `other` gave them.
  private altColumn(i: number, base: EvalData | undefined, other: EvalData | undefined): void {
    const rows = this.rows;
    const o = i * rows;
    for (let r = 0; r < rows; r++) {
      let p = 0;
      let q = 0;
      if (base && r < base.nRaw) {
        p = base.pRaw[r];
        if (other) q = pOf(other, base.tokens[r]);
      }
      this.front[o + r] = height(p);
      this.back[o + r] = height(q);
    }
  }

  // Layers: answer_p of each layer.
  private layerColumn(i: number, d: EvalData | undefined): void {
    const rows = this.rows;
    const o = i * rows;
    const lens = d?.lens ?? null;
    for (let r = 0; r < rows; r++) {
      const has = lens !== null && r < lens.answerP.length;
      this.front[o + r] = has ? height(lens.answerP[r]) : 0;
      this.back[o + r] = 0;
    }
  }

  // Room for at least `cols` columns of the current rows. Values are not
  // kept: every column is rebuilt.
  private grow(cols: number): void {
    let cap = Math.max(this.capacity, START_COLUMNS);
    while (cap < cols) cap *= 2;
    const n = cap * this.rows;
    this.capacity = cap;
    this.front = new Float32Array(n);
    this.back = new Float32Array(n);
    this.doubt = new Float32Array(cap);
    this.div = new Float32Array(cap);
    this.tone = new Uint8Array(cap);
    this.known = 0;
  }
}

// Height 0..1 of a probability: its square root.
export function height(p: number): number {
  return p > 0 ? Math.sqrt(Math.min(p, 1)) : 0;
}

// ------------------------------------------------- animation 4: growth

export const GROW_MAX_MS = 320;
export const GROW_MIN_MS = 60;

// Length of the growth of a new column when tokens come every `intervalMs`;
// 0 when too short to animate (the column then appears at once).
export function growDuration(intervalMs: number): number {
  const d = Math.min(GROW_MAX_MS, intervalMs * 0.85);
  return d >= GROW_MIN_MS ? d : 0;
}

// Height factor 0..1 of the growing column after `elapsed` ms of `dur`:
// fast at first, settling at the end (ease-out cubic).
export function growFactor(elapsed: number, dur: number): number {
  if (!(dur > 0) || elapsed >= dur) return 1;
  if (!(elapsed > 0)) return 0;
  const k = 1 - elapsed / dur;
  return 1 - k * k * k;
}

// ------------------------------------------------------ camera framing
//
// The relief is a box W wide (x), `height` tall (y) and `depth` deep (z).
// Its shape follows the panel's aspect, so that seen from the default
// camera it fills the panel as a landscape and not as a line:
//
//   aspect   1.8 (full screen)   4 (dock)    10 (thin strip)
//   depth        16              ≈7            ≈2.3
//   height       10              ≈3.8          ≈1.7
//   elevation    0.37 rad        0.49          0.62  (higher on wide panels,
//                                                     so the depth shows)
//   sway         0.5 rad         0.08          0.025 (the automatic swing)

export const RELIEF_W = 30;

export interface ReliefShape {
  depth: number; // world z
  height: number; // world y of probability 1
  elevation: number; // default camera angle above the floor, radians
  sway: number; // half the swing of the automatic orbit, radians
}

export function reliefShape(aspect: number, width = RELIEF_W): ReliefShape {
  const a = aspect > 0 ? Math.min(Math.max(aspect, 0.5), 20) : 2;
  const elevation = clamp(0.36 + 0.05 * (a - 1.5), 0.36, 0.62);
  // Vertical extent on screen (height and depth seen from the elevation)
  // a little under what the width leaves at this aspect: half each.
  const v = (0.9 * width) / a;
  return {
    depth: clamp((0.5 * v) / Math.sin(elevation), 1.8, 16),
    height: clamp((0.5 * v) / Math.cos(elevation), 1.2, 10),
    elevation,
    // Turning a long box tilts its ends up and down on the screen, and the
    // fit must leave room for that: on a wide strip the swing stays short.
    sway: clamp(a > 1.5 ? 0.2 / (a - 1.5) : Infinity, 0.025, 0.5),
  };
}

// Distance from the centre of a box (half sizes hx, hy, hz) at which a
// camera looking at that centre from azimuth `theta` (0: from +z) and polar
// angle `phi` (from +y) sees all 8 corners within tan half-angles tanX and
// tanY. Exact for a pinhole camera: no corner sits outside, at least one
// touches an edge.
export function fitDistance(hx: number, hy: number, hz: number, theta: number, phi: number, tanX: number, tanY: number): number {
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  // Unit vectors: towards the camera, to the right, and up on screen.
  const dx = sp * st;
  const dy = cp;
  const dz = sp * ct;
  const rx = ct;
  const rz = -st;
  const ux = -st * cp;
  const uy = sp;
  const uz = -ct * cp;
  let dist = 0;
  for (let k = 0; k < 8; k++) {
    const px = k & 1 ? hx : -hx;
    const py = k & 2 ? hy : -hy;
    const pz = k & 4 ? hz : -hz;
    const toward = px * dx + py * dy + pz * dz;
    const x = Math.abs(px * rx + pz * rz);
    const y = Math.abs(px * ux + py * uy + pz * uz);
    dist = Math.max(dist, toward + Math.max(x / tanX, y / tanY));
  }
  return dist;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// GLSL's smoothstep.
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
