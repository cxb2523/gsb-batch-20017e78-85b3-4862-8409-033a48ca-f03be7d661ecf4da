import { describe, expect, it } from 'vitest';
import { decodeFrames, FRAME_PAIR, NONE, ORIGIN_MODEL, ORIGIN_PROMPT, PAIR_SAME_PICK, type PairFrame } from '../source/frames';
import { Store } from '../store/store';
import { concat, config, configBody, cursor, evalFrame, hello, node, pair, vocab } from '../testing/encode';
import {
  DIV_SAME_MAX,
  divergenceOf,
  doubtOf,
  GROW_MAX_MS,
  GROW_MIN_MS,
  growDuration,
  fitDistance,
  growFactor,
  height,
  RELIEF_W,
  ReliefData,
  reliefShape,
} from './relief-data';
import { axisSpan, MIN_SPAN } from './timeline';

function feed(store: Store, ...parts: Uint8Array[]): void {
  for (const f of decodeFrames(concat(...parts))) store.apply(f);
}

// Values of one column, rounded to avoid float32 noise.
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const sq = (...ps: number[]): number[] => ps.map((p) => r4(Math.sqrt(p)));

function column(a: Float32Array, rows: number, i: number): number[] {
  return [...a.subarray(i * rows, (i + 1) * rows)].map((v) => Math.round(v * 1e4) / 1e4);
}

// Prompt "<s> A" (nodes 0, 1) with `models` models and n_raw 4.
function prompt(models: 1 | 2 = 1, lens: number[] | null = null): Uint8Array[] {
  return [
    hello(0, 1, models, lens),
    config(0, configBody()),
    vocab(1, [0, 1, 2, 3, 4, 5, 6].map((token) => ({ token, text: `t${token}` }))),
    node(1, 0, NONE, 0, 0, ORIGIN_PROMPT),
    node(1, 1, 0, 1, 1, ORIGIN_PROMPT),
    models === 2 ? cursor(1, 1, 1) : cursor(1, 1),
  ];
}

// One step from node 1 to node 2 (token 2).
const step = [node(2, 2, 1, 2, 2, ORIGIN_MODEL)];

describe('ReliefData, Alternatives', () => {
  it('builds a column per position, the prompt at zero', () => {
    const s = new Store();
    feed(s, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 0.5], [3, 0.25], [4, 0.125]] }), ...step, cursor(2, 2));
    const r = new ReliefData();
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.cols, r.rows, r.source]).toEqual([3, 4, 'alternatives']);
    expect(r.capacity).toBeGreaterThanOrEqual(3);
    expect(column(r.front, 4, 0)).toEqual([0, 0, 0, 0]);
    expect(column(r.front, 4, 1)).toEqual([0, 0, 0, 0]);
    expect(column(r.front, 4, 2)).toEqual(sq(0.5, 0.25, 0.125, 0)); // fewer entries than n_raw
    expect(column(r.back, 4, 2)).toEqual([0, 0, 0, 0]); // a single model
    expect(r.tone[2]).toBe(0);
    // The first candidate took 50%: doubt smoothstep(0.1, 0.6, 0.5).
    expect(r.doubt[2]).toBeCloseTo(0.896);
    expect([r.doubt[0], r.doubt[1]]).toEqual([0, 0]); // the prompt: no decision
    expect([...r.div.subarray(0, 3)]).toEqual([0, 0, 0]); // a single model
    expect([r.from, r.to]).toEqual([0, 3]);
  });

  it('recomputes only what changed', () => {
    const s = new Store();
    feed(s, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 0.5]] }), ...step, cursor(2, 2));
    const r = new ReliefData();
    r.update(s, 'alternatives');
    expect(r.update(s, 'alternatives')).toBe(false);

    // A new step: only its column.
    feed(s, evalFrame(3, { node: 2, entries: [[3, 0.75]] }), node(3, 3, 2, 3, 3, ORIGIN_MODEL), cursor(3, 3));
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.from, r.to]).toEqual([3, 4]);
    expect(column(r.front, 4, 3)).toEqual(sq(0.75, 0, 0, 0));

    // A second EVAL of an old node replaces its column.
    feed(s, evalFrame(4, { node: 1, entries: [[2, 0.25]] }));
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.from, r.to]).toEqual([2, 3]);
    expect(column(r.front, 4, 2)).toEqual(sq(0.25, 0, 0, 0));
    expect(r.doubt[2]).toBe(1);

    // A new session.
    feed(s, hello(5));
    r.update(s, 'alternatives');
    expect(r.cols).toBe(0);
  });

  it('grows its arrays by doubling', () => {
    const s = new Store();
    const parts = [hello(0), config(0), node(0, 0, NONE, 0, 0, ORIGIN_PROMPT)];
    for (let id = 1; id < 300; id++) {
      parts.push(evalFrame(id, { node: id - 1, entries: [[1, 0.5]] }), node(id, id, id - 1, 1, id, ORIGIN_MODEL));
    }
    parts.push(cursor(300, 299));
    feed(s, ...parts);
    const r = new ReliefData();
    r.update(s, 'alternatives');
    expect(r.cols).toBe(300);
    expect(r.capacity).toBe(512);
    expect(r.front.length).toBe(512 * 4);
    expect(column(r.front, 4, 299)).toEqual(sq(0.5, 0, 0, 0));
    expect(r.doubt.length).toBe(512);
  });

  it('puts the other model on the same tokens, in the order of the one in front', () => {
    const s = new Store();
    feed(
      s,
      ...prompt(2),
      // A: 2, 3, 4, 6. B lists them in another order, has 4 only among its
      // extras and lacks 6.
      evalFrame(2, { node: 1, entries: [[2, 0.5], [3, 0.25], [4, 0.125], [6, 0.0625]] }),
      evalFrame(2, { node: 1, slot: 1, entries: [[3, 0.5], [2, 0.25], [5, 0.125], [1, 0.0625], [4, 0.03125]], nExtra: 1 }),
      ...step,
      cursor(2, 2, 2),
    );
    const r = new ReliefData();
    r.update(s, 'alternatives');
    expect(column(r.front, 4, 2)).toEqual(sq(0.5, 0.25, 0.125, 0.0625));
    expect(column(r.back, 4, 2)).toEqual(sq(0.25, 0.5, 0.03125, 0));
    expect(column(r.back, 4, 1)).toEqual([0, 0, 0, 0]); // the prompt
    expect(r.tone[2]).toBe(0);

    // B in front: B's rows, A's values on them.
    s.setFront(1);
    expect(r.update(s, 'alternatives')).toBe(true);
    expect(column(r.front, 4, 2)).toEqual(sq(0.5, 0.25, 0.125, 0.0625));
    expect(column(r.back, 4, 2)).toEqual(sq(0.25, 0.5, 0, 0)); // A lacks 5 and 1
    expect(r.tone[2]).toBe(1);
  });

  it('shows the other model in front where only it evaluated the node', () => {
    const s = new Store();
    feed(s, ...prompt(2), evalFrame(2, { node: 1, slot: 1, entries: [[2, 0.75], [3, 0.25]] }), ...step, cursor(2, 2, 2));
    const r = new ReliefData();
    r.update(s, 'alternatives');
    expect(column(r.front, 4, 2)).toEqual(sq(0.75, 0.25, 0, 0));
    expect(column(r.back, 4, 2)).toEqual([0, 0, 0, 0]);
    expect(r.tone[2]).toBe(1);
    // The doubt of the decision shown in front: B's.
    expect(r.doubt[2]).toBeCloseTo(doubtOf(s.decisionOf(2, 1)));
    expect(r.doubt[2]).toBeGreaterThan(0);
  });

  it('rewrites only the column whose PAIR arrives', () => {
    const s = new Store();
    feed(
      s,
      ...prompt(2),
      evalFrame(2, { node: 1, entries: [[2, 0.5], [3, 0.5]] }),
      evalFrame(2, { node: 1, slot: 1, entries: [[3, 0.75], [2, 0.25]] }),
      ...step,
      evalFrame(3, { node: 2, entries: [[3, 0.75]] }),
      evalFrame(3, { node: 2, slot: 1, entries: [[3, 0.75]] }),
      node(3, 3, 2, 3, 3, ORIGIN_MODEL),
      cursor(3, 3, 3),
    );
    const r = new ReliefData();
    r.update(s, 'alternatives');
    expect([...r.div.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(r.update(s, 'alternatives')).toBe(false);

    // The PAIR of node 1 (the decision of position 2): different picks.
    feed(s, pair(4, { node: 1, js: 0.2 }));
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.from, r.to]).toEqual([2, 3]);
    expect(r.div[2]).toBe(1);
    expect(r.div[3]).toBe(0);

    // The PAIR of node 2: the same pick, a small divergence.
    feed(s, pair(5, { node: 2, js: 0.1, flags: PAIR_SAME_PICK }));
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.from, r.to]).toEqual([3, 4]);
    expect(r.div[3]).toBeCloseTo(0.2 * DIV_SAME_MAX);
    expect(r.div[2]).toBe(1);
  });
});

describe('ReliefData, Layers', () => {
  const lensStep = evalFrame(2, {
    node: 1,
    entries: [[2, 0.5], [3, 0.25]],
    lens: [
      [3, 0.25, 0.125, 3],
      [2, 0.375, 0.25, 2],
      [2, 0.5, 0.5, 0],
    ],
  });

  it('builds a row per lens layer with sqrt(answer_p)', () => {
    const s = new Store();
    feed(s, ...prompt(1, [0, 1, 3]), lensStep, ...step, cursor(2, 2));
    const r = new ReliefData();
    r.update(s, 'layers');
    expect([r.cols, r.rows, r.source]).toEqual([3, 3, 'layers']);
    expect(column(r.front, 3, 2)).toEqual(sq(0.125, 0.25, 0.5));
    expect(r.doubt[2]).toBeCloseTo(0.896); // as in Alternatives: the decision's
    expect(column(r.front, 3, 0)).toEqual([0, 0, 0]);
    expect(column(r.back, 3, 2)).toEqual([0, 0, 0]);
  });

  it('falls back to Alternatives without the lens, and switches source', () => {
    const s = new Store();
    feed(s, ...prompt(1, [0, 1, 3]), lensStep, ...step, cursor(2, 2));
    const r = new ReliefData();
    r.update(s, 'layers');
    expect(r.update(s, 'alternatives')).toBe(true);
    expect([r.rows, r.source]).toEqual([4, 'alternatives']);
    expect(column(r.front, 4, 2)).toEqual(sq(0.5, 0.25, 0, 0));

    const t = new Store();
    feed(t, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 1]] }), ...step, cursor(2, 2));
    r.update(t, 'layers');
    expect([r.rows, r.source]).toEqual([4, 'alternatives']);
  });
});

describe('height', () => {
  it('is the square root of the probability, within 0..1', () => {
    expect(height(0)).toBe(0);
    expect(height(-1)).toBe(0);
    expect(height(0.25)).toBe(0.5);
    expect(height(1)).toBe(1);
    expect(height(2)).toBe(1);
  });
});

describe('doubtOf', () => {
  const d = (p0: number) => ({ nRaw: 1, pRaw: new Float32Array([p0]) }) as unknown as Parameters<typeof doubtOf>[0];
  it('is 0 for a sure decision, 1 for a hesitant one, smooth between', () => {
    expect(doubtOf(undefined)).toBe(0);
    expect(doubtOf(d(1))).toBe(0);
    expect(doubtOf(d(0.9))).toBeCloseTo(0, 6); // 0.9 in float32
    expect(doubtOf(d(0.4))).toBeCloseTo(1, 6);
    expect(doubtOf(d(0.1))).toBe(1);
    expect(doubtOf(d(0.65))).toBeCloseTo(0.5);
    expect(doubtOf({ nRaw: 0, pRaw: new Float32Array(0) } as unknown as Parameters<typeof doubtOf>[0])).toBe(0);
  });
});

describe('divergenceOf', () => {
  const p = (js: number, flags: number): PairFrame => ({
    type: FRAME_PAIR,
    t: 0,
    node: 0,
    js,
    klAB: 0,
    klBA: 0,
    rankAInB: 0,
    rankBInA: 0,
    flags,
  });
  it('is 0 without a comparison and 1 where the picks differ', () => {
    expect(divergenceOf(undefined)).toBe(0);
    expect(divergenceOf(p(0, 0))).toBe(1);
    expect(divergenceOf(p(0.9, 0))).toBe(1);
  });
  it('grows with the Jensen-Shannon divergence where the picks agree, up to its cap', () => {
    expect(divergenceOf(p(0, PAIR_SAME_PICK))).toBe(0);
    expect(divergenceOf(p(0.1, PAIR_SAME_PICK))).toBeCloseTo(0.2 * DIV_SAME_MAX);
    expect(divergenceOf(p(0.5, PAIR_SAME_PICK))).toBeCloseTo(DIV_SAME_MAX);
    expect(divergenceOf(p(1, PAIR_SAME_PICK))).toBeCloseTo(DIV_SAME_MAX);
    expect(divergenceOf(p(NaN, PAIR_SAME_PICK))).toBe(0);
  });
});

describe('animation 4 timing', () => {
  it('takes 85% of the interval, up to its maximum', () => {
    expect(growDuration(200)).toBeCloseTo(170);
    expect(growDuration(1000)).toBe(GROW_MAX_MS);
    expect(growDuration(Infinity)).toBe(GROW_MAX_MS); // the first token
  });

  it('is skipped when tokens come too fast', () => {
    expect(growDuration(GROW_MIN_MS / 0.85 - 1)).toBe(0);
    expect(growDuration(GROW_MIN_MS / 0.85 + 1)).toBeGreaterThanOrEqual(GROW_MIN_MS);
    expect(growDuration(0)).toBe(0);
  });

  it('grows from 0 to 1, fast at first', () => {
    expect(growFactor(0, 300)).toBe(0);
    expect(growFactor(-5, 300)).toBe(0);
    expect(growFactor(150, 300)).toBeCloseTo(0.875);
    expect(growFactor(300, 300)).toBe(1);
    expect(growFactor(900, 300)).toBe(1);
    expect(growFactor(0, 0)).toBe(1); // no animation: at once
    let prev = 0;
    for (let t = 30; t <= 300; t += 30) {
      const k = growFactor(t, 300);
      expect(k).toBeGreaterThan(prev);
      prev = k;
    }
  });
});

describe('axisSpan (shared with the Timeline)', () => {
  it('holds the path and the deepest branch tip, at least MIN_SPAN', () => {
    expect(axisSpan(3, [])).toBe(MIN_SPAN);
    expect(axisSpan(100, [])).toBe(100);
    expect(axisSpan(100, [{ tipDepth: 120 }, { tipDepth: 7 }])).toBe(121);
  });
});

describe('reliefShape', () => {
  const aspects = [1.5, 1.8, 2.5, 4, 5, 7, 10];
  it('is flatter, shallower and steeper the wider the panel', () => {
    for (let i = 1; i < aspects.length; i++) {
      const a = reliefShape(aspects[i - 1]);
      const b = reliefShape(aspects[i]);
      expect(b.elevation).toBeGreaterThanOrEqual(a.elevation);
      expect(b.depth).toBeLessThanOrEqual(a.depth);
      expect(b.height).toBeLessThanOrEqual(a.height);
      expect(b.sway).toBeLessThanOrEqual(a.sway);
    }
  });
  it('fills a wide dock as a landscape, not a line', () => {
    const s = reliefShape(2000 / 400);
    expect(s.depth).toBeGreaterThan(4);
    expect(s.height).toBeGreaterThan(2.5);
    // Seen from its elevation, the box is about as tall as the width allows.
    const v = s.height * Math.cos(s.elevation) + s.depth * Math.sin(s.elevation);
    expect(v / RELIEF_W).toBeGreaterThan(0.15);
    expect(v / RELIEF_W).toBeLessThan(0.25);
  });
  it('swings little where swinging would shrink the fitted relief', () => {
    const tanX = Math.tan((36 * Math.PI) / 360) * 0.94;
    for (const a of [1.6, 2.5, 4, 6.2, 10]) {
      const s = reliefShape(a);
      const phi = Math.PI / 2 - s.elevation;
      const box = [RELIEF_W / 2, s.height / 2, s.depth / 2] as const;
      const front = fitDistance(...box, 0, phi, tanX, tanX / a);
      expect(fitDistance(...box, s.sway, phi, tanX, tanX / a) / front).toBeLessThan(1.15);
    }
  });
  it('stays finite for any aspect', () => {
    for (const a of [0, -1, NaN, 0.2, 100]) {
      const s = reliefShape(a);
      for (const v of [s.depth, s.height, s.elevation, s.sway]) expect(Number.isFinite(v) && v > 0).toBe(true);
    }
  });
});

describe('fitDistance', () => {
  it('fits a box seen from the front', () => {
    // Corners at z = +1 are 1 closer; x = 15 needs 15 / tan more.
    expect(fitDistance(15, 1, 1, 0, Math.PI / 2, 1, 1)).toBeCloseTo(16);
  });
  it('is symmetric in the azimuth', () => {
    const a = fitDistance(15, 2, 4, 0.3, 1.2, 0.4, 0.1);
    expect(fitDistance(15, 2, 4, -0.3, 1.2, 0.4, 0.1)).toBeCloseTo(a);
  });
  it('keeps every corner inside the view, one on its edge', () => {
    const [hx, hy, hz, th, ph, tx, ty] = [15, 2.5, 3, 0.2, 1.1, 0.41, 0.08];
    const d = fitDistance(hx, hy, hz, th, ph, tx, ty);
    const dir = [Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th)];
    const right = [Math.cos(th), 0, -Math.sin(th)];
    const up = [-Math.sin(th) * Math.cos(ph), Math.sin(ph), -Math.cos(th) * Math.cos(ph)];
    const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let tight = 0;
    for (let k = 0; k < 8; k++) {
      const p = [k & 1 ? hx : -hx, k & 2 ? hy : -hy, k & 4 ? hz : -hz];
      const depth = d - dot(p, dir);
      const fx = Math.abs(dot(p, right)) / (depth * tx);
      const fy = Math.abs(dot(p, up)) / (depth * ty);
      expect(Math.max(fx, fy)).toBeLessThanOrEqual(1 + 1e-9);
      tight = Math.max(tight, fx, fy);
    }
    expect(tight).toBeCloseTo(1);
  });
  it('needs more room for a thin strip than for a wide view', () => {
    expect(fitDistance(15, 2, 3, 0, 1.1, 0.41, 0.04)).toBeGreaterThan(fitDistance(15, 2, 3, 0, 1.1, 0.41, 0.25));
  });
});
