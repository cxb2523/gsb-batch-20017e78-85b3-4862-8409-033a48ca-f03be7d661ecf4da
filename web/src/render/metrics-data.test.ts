import { describe, expect, it } from 'vitest';
import type { Slot } from '../store/store';
import {
  bitsText,
  confidenceOf,
  DASH,
  marginOf,
  MAX_BITS,
  M_CONFIDENCE,
  M_LATENCY,
  M_MARGIN,
  M_PERPLEXITY,
  M_SPEED,
  M_SURPRISE,
  msText,
  PathMetrics,
  pctText,
  pplText,
  rateText,
  sparkWindow,
  surpriseBits,
  type EvalLike,
  type MetricsSource,
} from './metrics-data';

function ev(pRaw: number[], pick = 0, decodeMs = 20): EvalLike {
  return { tokens: pRaw.map((_, i) => i), pRaw: Float32Array.from(pRaw), pick, decodeMs };
}

// A fake store: `prompt` positions without decisions, then one decision per
// position and model (undefined where that model did not evaluate).
class Fake implements MetricsSource {
  path: number[] = [];
  pathEpoch = 0;
  framesApplied = 0;
  twoModels = false;
  readonly decisions: [(EvalLike | undefined)[], (EvalLike | undefined)[]] = [[], []];
  calls = 0;

  constructor(public prompt: number) {
    for (let i = 0; i < prompt; i++) this.path.push(i);
  }

  get promptLength(): number {
    return this.prompt;
  }

  push(a: EvalLike | undefined, b?: EvalLike): void {
    const i = this.path.length;
    this.path.push(i);
    this.decisions[0][i] = a;
    this.decisions[1][i] = b;
    this.framesApplied++;
  }

  decisionOf(index: number, slot: Slot): EvalLike | undefined {
    this.calls++;
    return this.decisions[slot][index];
  }
}

describe('one step', () => {
  it('reads the confidence of the pick', () => {
    expect(confidenceOf(ev([0.5, 0.3, 0.2], 1))).toBeCloseTo(0.3);
    expect(confidenceOf(ev([0.5], 3))).toBeNaN();
  });

  it('measures surprise in bits, capped for p = 0', () => {
    expect(surpriseBits(0.5)).toBeCloseTo(1);
    expect(surpriseBits(0.125)).toBeCloseTo(3);
    expect(surpriseBits(1)).toBe(0);
    expect(surpriseBits(0)).toBe(MAX_BITS);
    expect(surpriseBits(1e-30)).toBe(MAX_BITS);
    expect(surpriseBits(NaN)).toBeNaN();
  });

  it('takes the margin between the two most likely, in any order', () => {
    expect(marginOf(ev([0.2, 0.6, 0.15]))).toBeCloseTo(0.4);
    expect(marginOf(ev([0.3, 0.3]))).toBeCloseTo(0);
    expect(marginOf(ev([0.9]))).toBeCloseTo(0.9);
    expect(marginOf(ev([]))).toBeNaN();
  });
});

describe('PathMetrics', () => {
  it('has nothing for a prompt without EVAL', () => {
    const f = new Fake(5);
    const m = new PathMetrics();
    m.sync(f);
    expect(m.first).toBe(5);
    expect(m.length).toBe(5);
    for (let i = 0; i < 5; i++) expect(m.slots[0].value(M_CONFIDENCE, i)).toBeNaN();
    expect(m.slots[0].missing).toEqual([]);
    expect(f.calls).toBe(0); // prompt positions are never asked for
  });

  it('computes the series of a single model', () => {
    const f = new Fake(2);
    f.push(ev([0.5, 0.25], 0, 10));
    f.push(ev([0.5, 0.25, 0.125], 2, 40));
    const m = new PathMetrics();
    m.sync(f);
    const s = m.slots[0];
    expect(s.value(M_CONFIDENCE, 2)).toBeCloseTo(0.5);
    expect(s.value(M_SURPRISE, 3)).toBeCloseTo(3);
    // 2^((1 + 3) / 2) = 4, from the first generated token only.
    expect(s.value(M_PERPLEXITY, 2)).toBeCloseTo(2);
    expect(s.value(M_PERPLEXITY, 3)).toBeCloseTo(4);
    expect(s.value(M_MARGIN, 3)).toBeCloseTo(0.25);
    expect(s.value(M_LATENCY, 3)).toBe(40);
    // Moving average over the window: 2 steps in 50 ms.
    expect(s.value(M_SPEED, 2)).toBeCloseTo(100);
    expect(s.value(M_SPEED, 3)).toBeCloseTo(40);
    expect(m.slots[1].length).toBe(0); // no model B
  });

  it('keeps perplexity finite with a probability of 0', () => {
    const f = new Fake(1);
    f.push(ev([0.9, 0], 1));
    f.push(ev([1], 0));
    const m = new PathMetrics();
    m.sync(f);
    const s = m.slots[0];
    expect(s.value(M_CONFIDENCE, 1)).toBe(0);
    expect(s.value(M_SURPRISE, 1)).toBe(MAX_BITS);
    expect(s.value(M_PERPLEXITY, 2)).toBeCloseTo(Math.pow(2, MAX_BITS / 2));
    expect(Number.isFinite(s.value(M_PERPLEXITY, 2))).toBe(true);
  });

  it('leaves a dash where a model did not evaluate, and skips it in perplexity', () => {
    const f = new Fake(1);
    f.twoModels = true;
    f.push(ev([0.5]), ev([0.25]));
    f.push(ev([0.5]), undefined);
    f.push(ev([0.5]), ev([0.25]));
    const m = new PathMetrics();
    m.sync(f);
    const b = m.slots[1];
    expect(b.value(M_CONFIDENCE, 2)).toBeNaN();
    expect(b.value(M_PERPLEXITY, 2)).toBeNaN();
    expect(b.value(M_PERPLEXITY, 3)).toBeCloseTo(4); // two steps of 2 bits
    expect(b.missing).toEqual([2]);
    expect(m.slots[0].value(M_PERPLEXITY, 3)).toBeCloseTo(2);
  });

  it('picks up an EVAL that arrives late', () => {
    const f = new Fake(1);
    f.twoModels = true;
    for (let i = 0; i < 10; i++) f.push(ev([0.5]), i < 3 ? ev([0.5]) : undefined);
    const m = new PathMetrics();
    m.sync(f);
    expect(m.slots[1].value(M_CONFIDENCE, 5)).toBeNaN();
    f.decisions[1][4] = ev([0.25]);
    f.decisions[1][5] = ev([0.25]);
    f.framesApplied++;
    m.sync(f);
    expect(m.slots[1].value(M_CONFIDENCE, 5)).toBeCloseTo(0.25);
    // 1, 1, 1, 2, 2 bits → 2^(7/5)
    expect(m.slots[1].value(M_PERPLEXITY, 5)).toBeCloseTo(Math.pow(2, 7 / 5));
  });

  it('extends incrementally and recomputes after a replacement', () => {
    const f = new Fake(1);
    for (let i = 0; i < 1000; i++) f.push(ev([0.5, 0.25]));
    const m = new PathMetrics();
    m.sync(f);
    expect(m.sync(f)).toBe(false); // nothing new: nothing done
    f.calls = 0;
    f.push(ev([0.25, 0.5]));
    m.sync(f);
    expect(f.calls).toBeLessThan(10);
    expect(m.slots[0].value(M_CONFIDENCE, 1001)).toBeCloseTo(0.25);
    expect(m.slots[0].value(M_PERPLEXITY, 1001)).toBeCloseTo(Math.pow(2, 1002 / 1001));

    // A goto: the path is replaced by a shorter one.
    f.path.length = 4;
    f.pathEpoch++;
    m.sync(f);
    expect(m.length).toBe(4);
    expect(m.slots[0].value(M_CONFIDENCE, 5)).toBeNaN();
  });

  it('notices a session with a second model', () => {
    const f = new Fake(1);
    f.push(ev([0.5]), ev([0.25]));
    const m = new PathMetrics();
    m.sync(f);
    expect(m.slots[1].length).toBe(0);
    f.twoModels = true;
    m.sync(f);
    expect(m.slots[1].value(M_CONFIDENCE, 1)).toBeCloseTo(0.25);
  });
});

describe('sparkWindow', () => {
  const w = { start: 0, end: 0 };
  it('shows everything generated when it fits', () => {
    sparkWindow(50, 10, 49, 120, w);
    expect(w).toEqual({ start: 10, end: 50 });
    sparkWindow(5, 5, 4, 120, w);
    expect(w).toEqual({ start: 5, end: 5 });
  });
  it('follows the end, or the selection when it lies before', () => {
    sparkWindow(1000, 10, 999, 120, w);
    expect(w).toEqual({ start: 880, end: 1000 });
    sparkWindow(1000, 10, 900, 120, w);
    expect(w).toEqual({ start: 880, end: 1000 });
    sparkWindow(1000, 10, 300, 120, w);
    expect(w).toEqual({ start: 240, end: 360 });
    sparkWindow(1000, 10, 3, 120, w);
    expect(w).toEqual({ start: 10, end: 130 });
  });
});

describe('figures', () => {
  it('write a dash for no value', () => {
    for (const f of [pctText, bitsText, pplText, rateText, msText]) expect(f(NaN)).toBe(DASH);
  });
  it('stay short', () => {
    expect(pctText(0.8743)).toBe('87.4');
    expect(pctText(0.0042)).toBe('0.42');
    expect(pctText(0.99999)).toBe('100');
    expect(pctText(0)).toBe('0');
    expect(pctText(1e-7)).toBe('<0.01');
    expect(bitsText(0.193)).toBe('0.19');
    expect(bitsText(12.44)).toBe('12.4');
    expect(pplText(1.843)).toBe('1.84');
    expect(pplText(412.3)).toBe('412');
    expect(pplText(3140)).toBe('3.1k');
    expect(pplText(Math.pow(2, 20))).toBe('1.0M');
    expect(rateText(42.31)).toBe('42.3');
    expect(rateText(118.2)).toBe('118');
    expect(msText(7.251)).toBe('7.25');
    expect(msText(23.62)).toBe('23.6');
  });
});
