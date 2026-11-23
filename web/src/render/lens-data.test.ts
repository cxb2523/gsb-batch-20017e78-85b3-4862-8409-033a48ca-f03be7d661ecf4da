import { describe, expect, it } from 'vitest';
import { decodeFrames, NONE, ORIGIN_MODEL, ORIGIN_PROMPT } from '../source/frames';
import { Store } from '../store/store';
import { concat, config, configBody, cursor, evalFrame, hello, node, vocab } from '../testing/encode';
import {
  buildRamp,
  decisionLayer,
  finalTop,
  indexAtX,
  LensGrid,
  NO_DATA,
  RAMP_STEPS,
  rampStep,
  spanFor,
  stepFor,
  xOfIndex,
} from './lens-data';
import { MIN_SPAN } from './timeline';

function feed(store: Store, ...parts: Uint8Array[]): void {
  for (const f of decodeFrames(concat(...parts))) store.apply(f);
}

describe('decisionLayer', () => {
  it('is the first layer from which the favourite stays the final one', () => {
    expect(decisionLayer([5, 6, 7, 7], 7)).toBe(2);
  });
  it('is 0 when every layer agrees from the first', () => {
    expect(decisionLayer([7, 7, 7], 7)).toBe(0);
  });
  it('ignores an early match that changes later', () => {
    expect(decisionLayer([7, 7, 3, 7, 7], 7)).toBe(3);
    expect(decisionLayer([7, 2, 3, 4, 7], 7)).toBe(4);
  });
  it('is -1 when the last layer does not favour the final token', () => {
    expect(decisionLayer([1, 2, 3], 7)).toBe(-1);
    expect(decisionLayer([7, 7, 3], 7)).toBe(-1);
    expect(decisionLayer([], 7)).toBe(-1);
  });
});

describe('finalTop', () => {
  const lens = { topId: new Uint32Array([4, 9]), topP: new Float32Array(2), answerP: new Float32Array(2), entropy: new Float32Array(2) };
  it('is the first raw candidate', () => {
    expect(finalTop({ nRaw: 2, tokens: new Uint32Array([3, 8]), lens })).toBe(3);
  });
  it('falls back to the last layer, then to -1', () => {
    expect(finalTop({ nRaw: 0, tokens: new Uint32Array(0), lens })).toBe(9);
    expect(finalTop({ nRaw: 0, tokens: new Uint32Array(0), lens: null })).toBe(-1);
  });
});

describe('colour ramp', () => {
  const ramp = buildRamp('#3dd6ff', '#060812');
  const lum = (i: number): number => ramp[i * 4] * 0.2126 + ramp[i * 4 + 1] * 0.7152 + ramp[i * 4 + 2] * 0.0722;
  it('goes from almost the ground to a bright tone, never white', () => {
    expect(ramp.length).toBe((RAMP_STEPS + 1) * 4);
    expect(lum(0)).toBeLessThan(30);
    const top = [...ramp.subarray(RAMP_STEPS * 4, RAMP_STEPS * 4 + 3)];
    expect(Math.min(...top)).toBeLessThan(120); // red stays low: still cyan
    expect(top[2]).toBe(255);
    for (let i = 1; i <= RAMP_STEPS; i++) expect(lum(i)).toBeGreaterThanOrEqual(lum(i - 1));
    for (let i = 0; i <= RAMP_STEPS; i++) expect(ramp[i * 4 + 3]).toBe(255);
  });
  it('maps probabilities to steps, spreading the low range', () => {
    expect(rampStep(0)).toBe(0);
    expect(rampStep(-1)).toBe(0);
    expect(rampStep(Number.NaN)).toBe(0);
    expect(rampStep(1)).toBe(RAMP_STEPS);
    expect(rampStep(2)).toBe(RAMP_STEPS);
    expect(rampStep(0.1)).toBeGreaterThan(RAMP_STEPS * 0.1);
  });
});

describe('position ↔ x', () => {
  it('holds at least MIN_SPAN positions', () => {
    expect(spanFor(3)).toBe(MIN_SPAN);
    expect(spanFor(500)).toBe(500);
    expect(stepFor(640, 64)).toBe(10);
    expect(stepFor(640, 0)).toBe(0);
  });
  it('maps index to x and back', () => {
    const left = 60;
    const step = 7.5;
    for (const i of [0, 1, 17, 99]) {
      expect(indexAtX(xOfIndex(i, left, step) + step / 2, left, step, 100)).toBe(i);
      expect(indexAtX(xOfIndex(i, left, step), left, step, 100)).toBe(i);
    }
  });
  it('clamps to the path and needs a path and room', () => {
    expect(indexAtX(0, 60, 5, 10)).toBe(0);
    expect(indexAtX(10000, 60, 5, 10)).toBe(9);
    expect(indexAtX(100, 60, 5, 0)).toBeNull();
    expect(indexAtX(100, 60, 0, 10)).toBeNull();
  });
});

// Prompt "<s> A" (nodes 0, 1) with three lens layers.
function prompt(models: 1 | 2 = 1): Uint8Array[] {
  return [
    hello(0, 1, models, [0, 4, 7]),
    config(0, configBody()),
    vocab(1, [0, 1, 2, 3, 4, 5, 6].map((token) => ({ token, text: `t${token}` }))),
    node(1, 0, NONE, 0, 0, ORIGIN_PROMPT),
    node(1, 1, 0, 1, 1, ORIGIN_PROMPT),
    models === 2 ? cursor(1, 1, 1) : cursor(1, 1),
  ];
}

const lensA: [number, number, number, number][] = [
  [5, 0.3, 0.0, 6],
  [2, 0.4, 0.4, 3],
  [2, 0.9, 0.9, 0.5],
];

describe('LensGrid', () => {
  const ramps = [buildRamp('#3dd6ff', '#060812'), buildRamp('#ffb547', '#060812')];

  it('fills a column per position, the prompt empty', () => {
    const s = new Store();
    feed(s, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 0.9], [3, 0.1]], lens: lensA }), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2));
    const g = new LensGrid();
    expect(g.update(s, 3, 1, ramps)).toBe(true);
    expect([g.cols, g.rows, g.bands, g.relaid]).toEqual([3, 3, 1, true]);
    expect([g.from, g.to]).toEqual([0, 3]);
    // Prompt: no lens, transparent.
    expect(g.cell(0, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(g.cell(0, 1, 2)).toEqual([0, 0, 0, 0]);
    expect(g.decidedAt(0, 1)).toBe(NO_DATA);
    // Position 2: answer_p of each layer through the ramp.
    expect(g.cell(0, 2, 0)).toEqual([...ramps[0].subarray(0, 4)]);
    const s9 = rampStep(0.9) * 4;
    expect(g.cell(0, 2, 2)).toEqual([...ramps[0].subarray(s9, s9 + 4)]);
    expect(g.decidedAt(0, 2)).toBe(1);
  });

  it('rewrites only new or changed columns', () => {
    const s = new Store();
    feed(s, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 0.9]], lens: lensA }), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2));
    const g = new LensGrid();
    g.update(s, 3, 1, ramps);
    const v = g.version;
    expect(g.update(s, 3, 1, ramps)).toBe(false);
    expect(g.version).toBe(v);
    feed(s, evalFrame(3, { node: 2, entries: [[3, 0.6]], lens: lensA }), node(3, 3, 2, 3, 3, ORIGIN_MODEL), cursor(3, 3));
    expect(g.update(s, 3, 1, ramps)).toBe(true);
    expect([g.from, g.to, g.relaid]).toEqual([3, 4, false]);
    // The last layer favours 2, the final top is 3: never settles.
    expect(g.decidedAt(0, 3)).toBe(-1);
    // A second EVAL of node 2 replaces column 3 only.
    feed(s, evalFrame(4, { node: 2, entries: [[2, 0.6]], lens: lensA }));
    expect(g.update(s, 3, 1, ramps)).toBe(true);
    expect([g.from, g.to]).toEqual([3, 4]);
    expect(g.decidedAt(0, 3)).toBe(1);
  });

  it('keeps one band per model, an empty cell where a model did not evaluate', () => {
    const s = new Store();
    feed(
      s,
      ...prompt(2),
      evalFrame(2, { node: 1, slot: 0, entries: [[2, 0.9]], lens: lensA }),
      node(2, 2, 1, 2, 2, ORIGIN_MODEL),
      cursor(2, 2, 2),
    );
    const g = new LensGrid();
    g.update(s, 3, 2, ramps);
    expect(g.bands).toBe(2);
    expect(g.cell(0, 2, 2)[3]).toBe(255);
    expect(g.cell(1, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(g.decidedAt(1, 2)).toBe(NO_DATA);
    feed(s, evalFrame(3, { node: 1, slot: 1, entries: [[2, 0.5]], lens: lensA }));
    expect(g.update(s, 3, 2, ramps)).toBe(true);
    const s9 = rampStep(0.9) * 4;
    expect(g.cell(1, 2, 2)).toEqual([...ramps[1].subarray(s9, s9 + 4)]);
    expect(g.decidedAt(1, 2)).toBe(1);
  });

  it('grows its capacity and clears a tail the path lost', () => {
    const g = new LensGrid();
    const lens = { topId: new Uint32Array([1, 1]), topP: new Float32Array([1, 1]), answerP: new Float32Array([1, 1]), entropy: new Float32Array(2) };
    const d = { nRaw: 1, tokens: new Uint32Array([1]), lens };
    const src = { path: Array.from({ length: 300 }, (_, i) => i), decisionOf: (i: number) => (i > 0 ? d : undefined) };
    g.update(src, 2, 1, ramps);
    expect(g.capacity).toBeGreaterThanOrEqual(300);
    expect(g.relaid).toBe(true);
    expect(g.decidedAt(0, 299)).toBe(0);
    src.path = src.path.slice(0, 10);
    expect(g.update(src, 2, 1, ramps)).toBe(true);
    expect(g.cols).toBe(10);
    expect(g.cell(0, 299, 0)).toEqual([0, 0, 0, 0]);
    expect(g.decidedAt(0, 299)).toBe(NO_DATA);
  });
});
