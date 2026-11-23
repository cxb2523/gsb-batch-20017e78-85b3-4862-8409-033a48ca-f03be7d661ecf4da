// The arithmetic of the strip of live figures (render/metrics.ts): six
// series along the viewed path, one set per model, and how each figure is
// written. Pure functions and a cache; nothing here touches the DOM.
//
//   index of the path   0 … prompt … first ─ first+1 ─ … ─ n-1
//   decision            none (no EVAL)    EVAL of the parent node, per model
//   series              NaN               confidence, surprise, perplexity,
//                                         margin, speed, latency (NaN where
//                                         that model did not evaluate)
//
// Perplexity is cumulative: 2^(mean surprise) from the first generated token
// to the position. It is kept as prefix sums, so a new token costs O(1) and
// reading any position costs O(1).

import type { Slot } from '../store/store';

// What a decision must carry: an EVAL frame has all of it.
export interface EvalLike {
  tokens: ArrayLike<number>;
  pRaw: ArrayLike<number>;
  pick: number;
  decodeMs: number;
}

// What the cache reads from the store (the Store satisfies it).
export interface MetricsSource {
  readonly path: { readonly length: number };
  readonly pathEpoch: number;
  readonly framesApplied: number;
  readonly promptLength: number;
  readonly twoModels: boolean;
  decisionOf(index: number, slot: Slot): EvalLike | undefined;
}

// The six series, in the order the strip shows them.
export const M_CONFIDENCE = 0;
export const M_SURPRISE = 1;
export const M_PERPLEXITY = 2;
export const M_MARGIN = 3;
export const M_SPEED = 4;
export const M_LATENCY = 5;
export const METRIC_COUNT = 6;

// Surprise of a token whose probability underflowed to 0: a finite ceiling,
// so that one such token does not make the perplexity infinite forever.
export const MAX_BITS = 40;
// Positions in the moving average of the compute speed.
export const SPEED_WINDOW = 8;
// Positions recomputed at the end of the path whenever frames arrive: an
// EVAL that replaces the last ones is picked up.
const TAIL = 2;

// ------------------------------------------------------------ one step

// Probability the model gave to the token it picked; NaN if the pick is not
// among the entries (it always is, by the protocol).
export function confidenceOf(e: EvalLike): number {
  return e.pick >= 0 && e.pick < e.pRaw.length ? e.pRaw[e.pick] : NaN;
}

// −log₂ p, in bits, capped at MAX_BITS (p = 0 gives MAX_BITS).
export function surpriseBits(p: number): number {
  if (!(p >= 0)) return NaN;
  if (p >= 1) return 0;
  return p > 0 ? Math.min(-Math.log2(p), MAX_BITS) : MAX_BITS;
}

// p(top1) − p(top2) of the raw distribution. With a single entry, p(top1).
export function marginOf(e: EvalLike): number {
  const p = e.pRaw;
  if (p.length === 0) return NaN;
  let a = -1;
  let b = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (v > a) {
      b = a;
      a = v;
    } else if (v > b) {
      b = v;
    }
  }
  return a - Math.max(b, 0);
}

// ------------------------------------------------------------ the series

// The six series of one model along the viewed path, NaN where it has no
// decision, with the prefix sums they are read from.
export class SlotSeries {
  length = 0;
  readonly v: Float64Array[] = [];
  // Inclusive prefix sums over the positions with a decision.
  private sumBits = new Float64Array(0);
  private nBits = new Float64Array(0);
  private sumMs = new Float64Array(0);
  private nMs = new Float64Array(0);
  // Generated positions without a decision yet, ascending: an EVAL that
  // arrives late for one of them (a model behind the other) is picked up.
  readonly missing: number[] = [];

  constructor() {
    for (let m = 0; m < METRIC_COUNT; m++) this.v.push(new Float64Array(0));
  }

  value(metric: number, index: number): number {
    return index >= 0 && index < this.length ? this.v[metric][index] : NaN;
  }

  // Smallest index of `missing` that now has a decision, or -1.
  recheck(get: (index: number) => EvalLike | undefined): number {
    for (const i of this.missing) if (get(i) !== undefined) return i;
    return -1;
  }

  // Recomputes positions [from, n). `first` is the first generated position:
  // anything before it is prompt and has no decision.
  compute(get: (index: number) => EvalLike | undefined, from: number, n: number, first: number): void {
    this.reserve(n);
    from = Math.max(0, Math.min(from, this.length, n));
    const miss = this.missing;
    while (miss.length > 0 && miss[miss.length - 1] >= from) miss.pop();
    const [conf, bits, ppl, margin, speed, lat] = this.v;
    const sb = this.sumBits;
    const nb = this.nBits;
    const sm = this.sumMs;
    const nm = this.nMs;
    for (let i = from; i < n; i++) {
      let pb = 0;
      let pn = 0;
      let pms = 0;
      let pmn = 0;
      if (i > 0) {
        pb = sb[i - 1];
        pn = nb[i - 1];
        pms = sm[i - 1];
        pmn = nm[i - 1];
      }
      const e = i >= first ? get(i) : undefined;
      const p = e ? confidenceOf(e) : NaN;
      if (e === undefined || Number.isNaN(p)) {
        if (i >= first) miss.push(i);
        sb[i] = pb;
        nb[i] = pn;
        sm[i] = pms;
        nm[i] = pmn;
        conf[i] = bits[i] = ppl[i] = margin[i] = speed[i] = lat[i] = NaN;
        continue;
      }
      const s = surpriseBits(p);
      sb[i] = pb + s;
      nb[i] = pn + 1;
      conf[i] = p;
      bits[i] = s;
      ppl[i] = Math.pow(2, sb[i] / nb[i]);
      margin[i] = marginOf(e);
      const ms = e.decodeMs;
      if (ms > 0 && Number.isFinite(ms)) {
        sm[i] = pms + ms;
        nm[i] = pmn + 1;
        lat[i] = ms;
        const j = i - SPEED_WINDOW;
        const cnt = nm[i] - (j >= 0 ? nm[j] : 0);
        const sum = sm[i] - (j >= 0 ? sm[j] : 0);
        speed[i] = sum > 0 ? (1000 * cnt) / sum : NaN;
      } else {
        sm[i] = pms;
        nm[i] = pmn;
        lat[i] = ms === 0 ? 0 : NaN;
        speed[i] = NaN;
      }
    }
    this.length = n;
  }

  private reserve(n: number): void {
    if (n <= this.sumBits.length) return;
    const cap = Math.max(256, this.sumBits.length * 2, n);
    const grow = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const b = new Float64Array(cap);
      b.set(a);
      return b;
    };
    for (let m = 0; m < METRIC_COUNT; m++) this.v[m] = grow(this.v[m]);
    this.sumBits = grow(this.sumBits);
    this.nBits = grow(this.nBits);
    this.sumMs = grow(this.sumMs);
    this.nMs = grow(this.nMs);
  }
}

// The series of both models along the viewed path, kept up to date with
// sync(): a full pass when the path is replaced (pathEpoch), otherwise only
// the new positions, the last TAIL ones and those whose EVAL arrived late.
export class PathMetrics {
  readonly slots: [SlotSeries, SlotSeries] = [new SlotSeries(), new SlotSeries()];
  first = 0; // first generated position of the path
  length = 0;
  two = false;
  private epoch = -1;
  private stamp = -1;
  private readonly getters: [(i: number) => EvalLike | undefined, (i: number) => EvalLike | undefined];
  private src: MetricsSource | null = null;

  constructor() {
    this.getters = [(i) => this.src?.decisionOf(i, 0), (i) => this.src?.decisionOf(i, 1)];
  }

  // Brings the series up to date. Returns whether anything was recomputed.
  sync(src: MetricsSource): boolean {
    const n = src.path.length;
    const fresh = src.pathEpoch !== this.epoch || src.twoModels !== this.two;
    if (!fresh && src.framesApplied === this.stamp && n === this.length) return false;
    this.src = src;
    // The prompt can only grow while the path still ends in it.
    if (fresh || this.first >= this.length) this.first = src.promptLength;
    const slots = src.twoModels ? 2 : 1;
    for (let k = 0; k < slots; k++) {
      const series = this.slots[k];
      const get = this.getters[k];
      let from = 0;
      if (!fresh) {
        from = Math.max(0, Math.min(series.length, n) - TAIL);
        const late = series.recheck(get);
        if (late >= 0 && late < from) from = late;
      }
      series.compute(get, from, n, this.first);
    }
    if (slots === 1) this.slots[1].compute(this.getters[1], 0, 0, 0);
    this.epoch = src.pathEpoch;
    this.stamp = src.framesApplied;
    this.length = n;
    this.two = src.twoModels;
    this.src = null;
    return true;
  }
}

// ------------------------------------------------------------ the window

// Range [start, end) of generated positions a sparkline shows: the last
// `size` of the path, or, when the selection lies before them, `size`
// positions around it. Written into `out` (no allocation per frame).
export function sparkWindow(
  n: number,
  first: number,
  sel: number,
  size: number,
  out: { start: number; end: number },
): void {
  const lo = Math.min(first, n);
  if (n - lo <= size) {
    out.start = lo;
    out.end = n;
  } else if (sel >= n - size) {
    out.start = n - size;
    out.end = n;
  } else {
    out.start = Math.max(lo, sel - (size >> 1));
    out.end = out.start + size;
  }
}

// ------------------------------------------------------------ the figures

export const DASH = '—';

// A probability as a percentage: "87.4", "4.2", "0.42", "<0.01", "100".
export function pctText(p: number): string {
  if (!Number.isFinite(p)) return DASH;
  const v = p * 100;
  if (v >= 99.95) return '100';
  if (v >= 1) return v.toFixed(1);
  if (v >= 0.01) return v.toFixed(2);
  return v > 0 ? '<0.01' : '0';
}

// Bits: "0.19", "12.4".
export function bitsText(b: number): string {
  if (!Number.isFinite(b)) return DASH;
  return b < 10 ? b.toFixed(2) : b.toFixed(1);
}

// A perplexity: "1.84", "23.5", "412", "3.1k", "12M".
export function pplText(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  if (v < 1e3) return v.toFixed(0);
  return compact(v);
}

// Tokens per second: "42.3", "118".
export function rateText(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (v < 100) return v.toFixed(1);
  if (v < 1e4) return v.toFixed(0);
  return compact(v);
}

// Milliseconds: "7.25", "23.6", "412".
export function msText(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  if (v < 1e4) return v.toFixed(0);
  return compact(v);
}

function compact(v: number): string {
  const units = ['k', 'M', 'G', 'T'];
  let u = -1;
  while (v >= 1e3 && u < units.length - 1) {
    v /= 1e3;
    u++;
  }
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + units[u];
}
