// The protocol contract with two models, TypeScript side: reads
// sessions/golden/pair.ils and expects exactly what engine/tests/test_golden.cpp
// writes. Change both together.
//
// The session: prompt "<s>The"; two lockstep steps driven by A (the second one
// a disagreement); free mode, where the models agree once and then split: A
// writes " mat.<eos>" and B " dog<eos>"; and back to lockstep driven by B,
// which moves A's cursor to B's node.

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
  PAIR_SAME_PICK,
  PAIR_SAME_TOP,
  STOP_EOG,
  type ConfigFrame,
  type CursorFrame,
  type EvalFrame,
  type Frame,
  type HelloFrame,
  type NodeFrame,
  type PairFrame,
  type StopFrame,
} from './frames';
import { decodeSession } from './recorded';
import { Store } from '../store/store';

// Token ids of test_golden.cpp.
const T_BOS = 0, T_EOS = 1, T_THE = 2, T_CAT = 3, T_SAT = 4, T_CAF = 5;
const T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

const SAME = PAIR_SAME_TOP | PAIR_SAME_PICK;

// Every EVAL in order: time, node, slot, entries (token, p_raw), entropy, decode_ms. The pick is entry 0.
const EVALS: { t: number; node: number; slot: number; entries: [number, number][]; entropy: number; decodeMs: number }[] = [
  { t: 200, node: 1, slot: 0, entries: [[T_CAT, 0.5], [T_DOG, 0.25], [T_CAF, 0.125], [T_DOT, 0.0625]], entropy: 1.75, decodeMs: 1.5 },
  { t: 200, node: 1, slot: 1, entries: [[T_CAT, 0.5], [T_CAF, 0.25], [T_DOG, 0.125], [T_DOT, 0.0625]], entropy: 1.875, decodeMs: 2.5 },
  { t: 300, node: 2, slot: 0, entries: [[T_SAT, 0.5], [T_ON, 0.25], [T_DOT, 0.125], [T_DOG, 0.0625]], entropy: 2.0, decodeMs: 1.5 },
  { t: 300, node: 2, slot: 1, entries: [[T_ON, 0.5], [T_SAT, 0.25], [T_DOT, 0.125], [T_DOG, 0.0625]], entropy: 2.25, decodeMs: 2.5 },
  { t: 400, node: 3, slot: 0, entries: [[T_ON, 0.5], [T_DOT, 0.25], [T_MAT, 0.125], [T_CAT, 0.0625]], entropy: 1.5, decodeMs: 1.5 },
  { t: 400, node: 3, slot: 1, entries: [[T_ON, 0.75], [T_DOT, 0.125], [T_MAT, 0.0625], [T_CAT, 0.03125]], entropy: 1.25, decodeMs: 2.5 },
  { t: 500, node: 4, slot: 0, entries: [[T_MAT, 0.5], [T_DOG, 0.25], [T_DOT, 0.125], [T_CAT, 0.0625]], entropy: 1.75, decodeMs: 1.5 },
  { t: 500, node: 4, slot: 1, entries: [[T_DOG, 0.5], [T_MAT, 0.25], [T_DOT, 0.125], [T_CAT, 0.0625]], entropy: 2.0, decodeMs: 2.5 },
  { t: 600, node: 5, slot: 0, entries: [[T_DOT, 0.75], [T_EOS, 0.125], [T_ON, 0.0625], [T_CAT, 0.03125]], entropy: 1.25, decodeMs: 1.5 },
  { t: 600, node: 6, slot: 1, entries: [[T_EOS, 0.5], [T_DOT, 0.25], [T_ON, 0.125], [T_CAT, 0.0625]], entropy: 1.875, decodeMs: 2.5 },
  { t: 700, node: 7, slot: 0, entries: [[T_EOS, 0.875], [T_DOT, 0.0625], [T_CAT, 0.03125], [T_DOG, 0.015625]], entropy: 0.75, decodeMs: 1.5 },
];

const PAIRS: Omit<PairFrame, 'type'>[] = [
  { t: 200, node: 1, js: 0.03125, klAB: 0.125, klBA: 0.0625, rankAInB: 0, rankBInA: 0, flags: SAME },
  { t: 300, node: 2, js: 0.25, klAB: 0.5, klBA: 0.75, rankAInB: 1, rankBInA: 1, flags: 0 },
  { t: 400, node: 3, js: 0.0625, klAB: 0.25, klBA: 0.125, rankAInB: 0, rankBInA: 0, flags: SAME },
  { t: 500, node: 4, js: 0.5, klAB: 1.0, klBA: 1.5, rankAInB: 1, rankBInA: 1, flags: 0 },
];

// Nodes: id = index; parent, token, depth, origin.
const NODES: [parent: number, token: number, depth: number, origin: number][] = [
  [NONE, T_BOS, 0, ORIGIN_PROMPT],
  [0, T_THE, 1, ORIGIN_PROMPT],
  [1, T_CAT, 2, ORIGIN_MODEL],
  [2, T_SAT, 3, ORIGIN_MODEL],
  [3, T_ON, 4, ORIGIN_MODEL],
  [4, T_MAT, 5, ORIGIN_MODEL], // A's lane
  [4, T_DOG, 5, ORIGIN_MODEL], // B's lane
  [5, T_DOT, 6, ORIGIN_MODEL],
  [6, T_EOS, 6, ORIGIN_MODEL],
  [7, T_EOS, 7, ORIGIN_MODEL],
];

let frames: Frame[];

function ofType<T extends Frame>(type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

beforeAll(async () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/pair.ils'));
  frames = await decodeSession(new Uint8Array(file));
});

describe('golden session pair.ils', () => {
  it('has the expected frames and times', () => {
    // 2 + 4 + (6 + 6) + 1 + (6 + 6 + 7 + 4) + 2, as test_golden.cpp checks.
    expect(frames.length).toBe(44);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_HELLO, FRAME_CONFIG,
      FRAME_VOCAB, FRAME_NODE, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_EVAL, FRAME_PAIR, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_EVAL, FRAME_PAIR, FRAME_NODE, FRAME_CURSOR,
      FRAME_CONFIG,
      FRAME_VOCAB, FRAME_EVAL, FRAME_EVAL, FRAME_PAIR, FRAME_NODE, FRAME_CURSOR,
      FRAME_EVAL, FRAME_EVAL, FRAME_PAIR, FRAME_NODE, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_EVAL, FRAME_NODE, FRAME_NODE, FRAME_CURSOR, FRAME_STOP,
      FRAME_EVAL, FRAME_NODE, FRAME_CURSOR, FRAME_STOP,
      FRAME_CONFIG, FRAME_CURSOR,
    ]);
    expect(frames.map((f) => f.t)).toEqual([
      0, 0,
      100, 100, 100, 100,
      200, 200, 200, 200, 200, 200,
      300, 300, 300, 300, 300, 300,
      350,
      400, 400, 400, 400, 400, 400,
      500, 500, 500, 500, 500, 500,
      600, 600, 600, 600, 600, 600, 600,
      700, 700, 700, 700,
      800, 800,
    ]);
  });

  it('reads HELLO with two models', () => {
    const model = { name: 'Golden-2', arch: 'golden', n_params: 1000, n_layer: 2, n_embd: 8, n_ctx: 64 };
    expect((frames[0] as HelloFrame).hello).toEqual({
      protocol: 1,
      app: '0.1.0',
      llama_cpp: '0.9.0',
      created: '2026-01-01T00:00:00Z',
      n_vocab: 12,
      n_raw: 4,
      models: [
        { slot: 'A', name: model.name, file: 'golden-q2.gguf', quant: 'Q2_K', arch: model.arch, n_params: 1000, size_bytes: 1000, n_layer: 2, n_embd: 8, n_ctx: 64 },
        { slot: 'B', name: model.name, file: 'golden-q8.gguf', quant: 'Q8_0', arch: model.arch, n_params: 1000, size_bytes: 2000, n_layer: 2, n_embd: 8, n_ctx: 64 },
      ],
      lens: { enabled: false, layers: [] },
      warnings: ['synthetic session'],
    });
  });

  it('reads the three CONFIGs: lockstep by A, free, lockstep by B', () => {
    const base = { seed: 42, max_tokens: 16, gates: [] };
    expect(ofType<ConfigFrame>(FRAME_CONFIG).map((f) => [f.t, f.config])).toEqual([
      [0, { mode: 'lockstep', driver: 'A', ...base }],
      [350, { mode: 'free', driver: 'A', ...base }],
      [800, { mode: 'lockstep', driver: 'B', ...base }],
    ]);
  });

  it('reads the ten nodes', () => {
    const nodes = ofType<NodeFrame>(FRAME_NODE);
    expect(nodes.map((n) => n.id)).toEqual(NODES.map((_, i) => i));
    expect(nodes.map((n) => [n.parent, n.token, n.depth, n.origin])).toEqual(NODES);
  });

  it('reads the EVALs of both models exactly', () => {
    const evals = ofType<EvalFrame>(FRAME_EVAL);
    expect(evals.length).toBe(EVALS.length);
    evals.forEach((e, i) => {
      const s = EVALS[i];
      expect([e.t, e.node, e.slot], `EVAL ${i}`).toEqual([s.t, s.node, s.slot]);
      expect([e.nRaw, e.nExtra, e.nGates, e.pick, e.flags]).toEqual([4, 0, 0, 0, 0]);
      expect([...e.tokens]).toEqual(s.entries.map((x) => x[0]));
      // Sums of powers of two: exact in a float.
      expect([...e.pRaw]).toEqual(s.entries.map((x) => x[1]));
      expect(e.entropy).toBe(s.entropy);
      expect(e.rawMass).toBe(s.entries.reduce((a, x) => a + x[1], 0));
      expect(e.decodeMs).toBe(s.decodeMs);
    });
  });

  it('reads the four PAIRs exactly', () => {
    expect(ofType<PairFrame>(FRAME_PAIR)).toEqual(PAIRS.map((p) => ({ type: FRAME_PAIR, ...p })));
  });

  it('reads the cursors: together, split, and together again at the driver', () => {
    expect(ofType<CursorFrame>(FRAME_CURSOR).map((c) => [c.t, c.nodeA, c.nodeB])).toEqual([
      [100, 1, 1],
      [200, 2, 2],
      [300, 3, 3],
      [400, 4, 4],
      [500, 5, 6], // the split
      [600, 7, 8],
      [700, 9, 8],
      [800, 8, 8], // lockstep driven by B: A moves to B's node
    ]);
  });

  it('reads one STOP per model', () => {
    expect(ofType<StopFrame>(FRAME_STOP).map((s) => [s.t, s.node, s.slot, s.reason])).toEqual([
      [600, 8, 1, STOP_EOG],
      [700, 9, 0, STOP_EOG],
    ]);
  });
});

describe('golden session pair.ils in the store', () => {
  // The store after applying frames up to and including the first one that
  // matches `last`, or all of them.
  function storeAt(last?: (f: Frame) => boolean): Store {
    const s = new Store();
    for (const f of frames) {
      s.apply(f);
      if (last?.(f)) break;
    }
    return s;
  }

  const atSplit = (f: Frame): boolean => f.type === FRAME_CURSOR && f.t === 500;

  it('in lockstep, before the split: one path, the disagreement marked', () => {
    const s = storeAt((f) => f.type === FRAME_CURSOR && f.t === 400);
    expect(s.twoModels).toBe(true);
    expect(s.config!.mode).toBe('free');
    expect(s.front).toBe(0);
    expect(s.path).toEqual([0, 1, 2, 3, 4]);
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
    expect(s.splits).toBe(0);
    // Index 3 is " sat", picked from node 2, where B would have said " on".
    expect([1, 2, 3, 4].map((i) => s.disagrees(i))).toEqual([false, false, true, false]);
    expect(s.firstDisagreement()).toBe(3);
    expect(s.pairAt(3)!.js).toBe(0.25);
    expect(s.decisionOf(3, 1)!.tokens[0]).toBe(T_ON);
  });

  it('at the split (CURSOR(5, 6) of t=500): A on the path, B in the lane', () => {
    const s = storeAt(atSplit);
    expect([s.cursorA, s.cursorB]).toEqual([5, 6]);
    expect(s.front).toBe(0);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.lane).toEqual([6]);
    expect(s.split).toBe(4);
    expect(s.splits).toBe(1);
    expect([1, 2, 3, 4, 5].map((i) => s.disagrees(i))).toEqual([false, false, true, false, true]);
    expect(s.firstDisagreement()).toBe(3);
    // " mat" for A, " dog" for B, both from their EVAL of node 4.
    expect(s.decision(5)!.slot).toBe(0);
    expect(s.probability(5)).toBe(0.5);
    expect(s.laneDecision(0)!.slot).toBe(1);
    expect(s.laneDecision(0)!.node).toBe(4);
    expect(s.laneProbability(0)).toBe(0.5);
    expect(s.stopAtLaneEnd()).toBeUndefined();
  });

  it('after the split: the lane grows and each model stops on its own', () => {
    const s = storeAt((f) => f.type === FRAME_STOP && f.t === 700);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(s.lane).toEqual([6, 8]);
    expect(s.split).toBe(4);
    expect(s.splits).toBe(1);
    expect(s.laneDecision(1)!.node).toBe(6);
    expect(s.laneDecision(1)!.slot).toBe(1);
    expect(s.stopAtEnd()).toEqual({ slot: 0, reason: STOP_EOG });
    expect(s.stopAtLaneEnd()).toEqual({ slot: 1, reason: STOP_EOG });
    // No PAIR after the split: no disagreement there.
    expect(s.disagrees(6)).toBe(false);
    expect(s.pairs[5]).toBeUndefined();
  });

  it('at the end: lockstep driven by B, B in front, cursors together at node 8', () => {
    const s = storeAt();
    expect(s.config).toMatchObject({ mode: 'lockstep', driver: 'B' });
    expect(s.front).toBe(1);
    expect([s.cursorA, s.cursorB]).toEqual([8, 8]);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 6, 8]);
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
    expect(s.splits).toBe(1);
    expect(s.firstDisagreement()).toBe(3);
    expect(s.disagrees(5)).toBe(true); // " dog": B's pick, A said " mat"
    // B's data in front, on B's path.
    expect(s.decision(5)!.slot).toBe(1);
    expect(s.decision(6)!.slot).toBe(1);
    expect(s.stopAtEnd()).toEqual({ slot: 1, reason: STOP_EOG });
    expect(s.evalA.filter(Boolean).length).toBe(6);
    expect(s.evalB.filter(Boolean).length).toBe(5);
    expect(s.pairs.filter(Boolean).length).toBe(4);

    // The cursors are together: A in front shows the same path.
    s.setFront(0);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 6, 8]);
    expect(s.lane).toEqual([]);
  });
});
