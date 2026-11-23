// The protocol contract with branches, TypeScript side: reads
// sessions/golden/branches.ils and expects exactly what
// engine/tests/test_golden.cpp writes. Change both together.
//
// The session, two models in free mode: prompt "<s>The"; a step together; a
// step where they split (A at node 3, B at node 4); a step apart; a `branch`
// under node 3 for A only (node 7, origin 2); a step; a `goto` of B to node 3,
// which only A had evaluated; and a step where B evaluates it, with an
// approximate PAIR whose rank of B's top in A is unknown, and A stops.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_PAIR,
  FRAME_STOP,
  FRAME_VOCAB,
  NONE,
  ORIGIN_MODEL,
  ORIGIN_PROMPT,
  ORIGIN_USER,
  PAIR_APPROX,
  PAIR_SAME_PICK,
  PAIR_SAME_TOP,
  STOP_EOG,
  type ConfigFrame,
  type CursorFrame,
  type EvalFrame,
  type Frame,
  type NodeFrame,
  type PairFrame,
  type StopFrame,
} from './frames';
import { decodeSession } from './recorded';
import { Store } from '../store/store';
import { pairFigures } from '../render/compare';

// Token ids of test_golden.cpp.
const T_BOS = 0, T_EOS = 1, T_THE = 2, T_CAT = 3, T_SAT = 4, T_CAF = 5;
const T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

// Every EVAL in order: time, node, slot, entries (token, p_raw). The pick is entry 0.
const EVALS: { t: number; node: number; slot: number; entries: [number, number][] }[] = [
  { t: 200, node: 1, slot: 0, entries: [[T_CAT, 0.5], [T_DOG, 0.25], [T_CAF, 0.125], [T_DOT, 0.0625]] },
  { t: 200, node: 1, slot: 1, entries: [[T_CAT, 0.5], [T_CAF, 0.25], [T_DOG, 0.125], [T_DOT, 0.0625]] },
  { t: 300, node: 2, slot: 0, entries: [[T_SAT, 0.5], [T_ON, 0.25], [T_DOT, 0.125], [T_DOG, 0.0625]] },
  { t: 300, node: 2, slot: 1, entries: [[T_ON, 0.5], [T_SAT, 0.25], [T_DOT, 0.125], [T_DOG, 0.0625]] },
  { t: 400, node: 3, slot: 0, entries: [[T_ON, 0.5], [T_DOT, 0.25], [T_MAT, 0.125], [T_CAT, 0.0625]] },
  { t: 400, node: 4, slot: 1, entries: [[T_DOT, 0.5], [T_MAT, 0.25], [T_CAT, 0.125], [T_DOG, 0.0625]] },
  { t: 600, node: 7, slot: 0, entries: [[T_DOT, 0.75], [T_EOS, 0.125], [T_ON, 0.0625], [T_CAT, 0.03125]] },
  { t: 600, node: 6, slot: 1, entries: [[T_CAF, 0.5], [T_DOT, 0.25], [T_CAT, 0.125], [T_DOG, 0.0625]] },
  { t: 800, node: 8, slot: 0, entries: [[T_EOS, 0.875], [T_DOT, 0.0625], [T_CAT, 0.03125], [T_DOG, 0.015625]] },
  { t: 800, node: 3, slot: 1, entries: [[T_DOG, 0.5], [T_ON, 0.25], [T_DOT, 0.125], [T_MAT, 0.0625]] },
];

// Nodes: id = index; parent, token, depth, origin.
const NODES: [parent: number, token: number, depth: number, origin: number][] = [
  [NONE, T_BOS, 0, ORIGIN_PROMPT],
  [0, T_THE, 1, ORIGIN_PROMPT],
  [1, T_CAT, 2, ORIGIN_MODEL],
  [2, T_SAT, 3, ORIGIN_MODEL], // A's pick: the node of the branch and the goto
  [2, T_ON, 3, ORIGIN_MODEL], // B's pick
  [3, T_ON, 4, ORIGIN_MODEL],
  [4, T_DOT, 4, ORIGIN_MODEL],
  [3, T_MAT, 4, ORIGIN_USER], // the branch
  [7, T_DOT, 5, ORIGIN_MODEL],
  [6, T_CAF, 5, ORIGIN_MODEL],
  [8, T_EOS, 6, ORIGIN_MODEL],
  [3, T_DOG, 4, ORIGIN_MODEL], // B's pick after the goto
];

let frames: Frame[];

function ofType<T extends Frame>(type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

beforeAll(async () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/branches.ils'));
  frames = await decodeSession(new Uint8Array(file));
});

describe('golden session branches.ils', () => {
  it('has the expected frames and times', () => {
    // 2 + 4 + (6 + 7 + 6) + 2 + 6 + 1 + 7, as test_golden.cpp checks.
    expect(frames.length).toBe(41);
    expect(frames.map((f) => [f.t, f.type])).toEqual([
      [0, FRAME_HELLO], [0, FRAME_CONFIG],
      [100, FRAME_VOCAB], [100, FRAME_NODE], [100, FRAME_NODE], [100, FRAME_CURSOR],
      [200, FRAME_VOCAB], [200, FRAME_EVAL], [200, FRAME_EVAL], [200, FRAME_PAIR], [200, FRAME_NODE], [200, FRAME_CURSOR],
      [300, FRAME_VOCAB], [300, FRAME_EVAL], [300, FRAME_EVAL], [300, FRAME_PAIR], [300, FRAME_NODE], [300, FRAME_NODE],
      [300, FRAME_CURSOR],
      [400, FRAME_VOCAB], [400, FRAME_EVAL], [400, FRAME_EVAL], [400, FRAME_NODE], [400, FRAME_NODE], [400, FRAME_CURSOR],
      [500, FRAME_NODE], [500, FRAME_CURSOR], // branch
      [600, FRAME_VOCAB], [600, FRAME_EVAL], [600, FRAME_EVAL], [600, FRAME_NODE], [600, FRAME_NODE], [600, FRAME_CURSOR],
      [700, FRAME_CURSOR], // goto
      [800, FRAME_EVAL], [800, FRAME_EVAL], [800, FRAME_PAIR], [800, FRAME_NODE], [800, FRAME_NODE], [800, FRAME_CURSOR],
      [800, FRAME_STOP],
    ]);
  });

  it('reads one CONFIG: free mode from the start', () => {
    expect(ofType<ConfigFrame>(FRAME_CONFIG).map((f) => f.config)).toEqual([
      { mode: 'free', driver: 'A', seed: 42, max_tokens: 16, gates: [] },
    ]);
  });

  it('reads the twelve nodes, the branch with origin 2 under node 3', () => {
    const nodes = ofType<NodeFrame>(FRAME_NODE);
    expect(nodes.map((n) => n.id)).toEqual(NODES.map((_, i) => i));
    expect(nodes.map((n) => [n.parent, n.token, n.depth, n.origin])).toEqual(NODES);
    expect(frames[25]).toEqual({ type: FRAME_NODE, t: 500, id: 7, parent: 3, token: T_MAT, depth: 4, origin: ORIGIN_USER });
  });

  it('reads the EVALs; the branch token is an alternative of A at node 3', () => {
    const evals = ofType<EvalFrame>(FRAME_EVAL);
    expect(evals.length).toBe(EVALS.length);
    evals.forEach((e, i) => {
      const s = EVALS[i];
      expect([e.t, e.node, e.slot], `EVAL ${i}`).toEqual([s.t, s.node, s.slot]);
      expect([e.nRaw, e.nExtra, e.nGates, e.pick]).toEqual([4, 0, 0, 0]);
      expect([...e.tokens]).toEqual(s.entries.map((x) => x[0]));
      expect([...e.pRaw]).toEqual(s.entries.map((x) => x[1]));
    });
    expect([...evals[4].tokens]).toContain(T_MAT);
  });

  it('reads two exact PAIRs and the approximate one, with an unknown rank', () => {
    expect(ofType<PairFrame>(FRAME_PAIR)).toEqual([
      { type: FRAME_PAIR, t: 200, node: 1, js: 0.03125, klAB: 0.125, klBA: 0.0625, rankAInB: 0, rankBInA: 0, flags: PAIR_SAME_TOP | PAIR_SAME_PICK },
      { type: FRAME_PAIR, t: 300, node: 2, js: 0.25, klAB: 0.5, klBA: 0.75, rankAInB: 1, rankBInA: 1, flags: 0 },
      { type: FRAME_PAIR, t: 800, node: 3, js: 0.375, klAB: 1.25, klBA: 1.5, rankAInB: 1, rankBInA: NONE, flags: PAIR_APPROX },
    ]);
    // The unknown rank is coherent with the candidates: B's top at node 3 is
    // not among A's, A's top is B's second.
    const evals = ofType<EvalFrame>(FRAME_EVAL);
    const a3 = evals[4], b3 = evals[9];
    expect([...a3.tokens]).not.toContain(b3.tokens[0]);
    expect([...b3.tokens].indexOf(a3.tokens[0])).toBe(1);
  });

  it('reads the cursors: split, branch of A, goto of B', () => {
    expect(ofType<CursorFrame>(FRAME_CURSOR).map((c) => [c.t, c.nodeA, c.nodeB])).toEqual([
      [100, 1, 1],
      [200, 2, 2],
      [300, 3, 4], // the split
      [400, 5, 6],
      [500, 7, 6], // branch: only A moves
      [600, 8, 9],
      [700, 8, 3], // goto: only B moves
      [800, 10, 11],
    ]);
  });

  it("reads A's STOP", () => {
    expect(ofType<StopFrame>(FRAME_STOP).map((s) => [s.t, s.node, s.slot, s.reason])).toEqual([
      [800, 10, 0, STOP_EOG],
    ]);
  });
});

describe('golden session branches.ils in the store', () => {
  function storeAt(last?: (f: Frame) => boolean): Store {
    const s = new Store();
    for (const f of frames) {
      s.apply(f);
      if (last?.(f)) break;
    }
    return s;
  }

  it('after the branch: node 7 hangs from node 3 with origin 2, A on it', () => {
    const s = storeAt((f) => f.type === FRAME_CURSOR && f.t === 500);
    expect(s.parent[7]).toBe(3);
    expect(s.origin[7]).toBe(ORIGIN_USER);
    expect([s.cursorA, s.cursorB]).toEqual([7, 6]);
  });

  it('after the goto: B at node 3, A where it was', () => {
    const s = storeAt((f) => f.type === FRAME_CURSOR && f.t === 700);
    expect([s.cursorA, s.cursorB]).toEqual([8, 3]);
    expect(s.pairs[3]).toBeUndefined();
  });

  it('at the end: the approximate PAIR of node 3 and its figures', () => {
    const s = storeAt();
    expect([s.cursorA, s.cursorB]).toEqual([10, 11]);
    expect(s.parent[7]).toBe(3);
    expect(s.origin[7]).toBe(ORIGIN_USER);
    const p = s.pairs[3]!;
    expect(p.flags & PAIR_APPROX).toBe(PAIR_APPROX);
    expect(pairFigures(p)).toEqual([
      'JS ≈0.375 · KL A‖B ≈1.25 · B‖A ≈1.50',
      'top differs · rank A→B ≈#2 · B→A ?',
    ]);
  });
});
