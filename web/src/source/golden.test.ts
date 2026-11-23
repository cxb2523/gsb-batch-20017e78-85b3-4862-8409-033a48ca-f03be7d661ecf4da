// The protocol contract, TypeScript side: reads sessions/golden/single.ils and
// expects exactly what engine/tests/test_golden.cpp writes. Change both together.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { groupTokens } from '../store/text';
import {
  ATTR_CONTROL,
  ATTR_EOG,
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_STOP,
  FRAME_VOCAB,
  NONE,
  ORIGIN_MODEL,
  ORIGIN_PROMPT,
  STOP_EOG,
  type Frame,
} from './frames';
import { decodeSession } from './recorded';

// Token ids of test_golden.cpp.
const T_BOS = 0, T_EOS = 1, T_THE = 2, T_CAT = 3, T_SAT = 4, T_CAF = 5;
const T_E1 = 6, T_E2 = 7, T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

const VOCAB: [token: number, attr: number, bytes: number[]][] = [
  [T_BOS, ATTR_CONTROL, [...'<s>'].map((c) => c.charCodeAt(0))],
  [T_EOS, ATTR_CONTROL | ATTR_EOG, [...'<eos>'].map((c) => c.charCodeAt(0))],
  [T_THE, 0, [0x54, 0x68, 0x65]],
  [T_CAT, 0, [0x20, 0x63, 0x61, 0x74]],
  [T_SAT, 0, [0x20, 0x73, 0x61, 0x74]],
  [T_CAF, 0, [0x20, 0x63, 0x61, 0x66]],
  [T_E1, 0, [0xc3]],
  [T_E2, 0, [0xa9]],
  [T_DOT, 0, [0x2e]],
  [T_DOG, 0, [0x20, 0x64, 0x6f, 0x67]],
  [T_ON, 0, [0x20, 0x6f, 0x6e]],
  [T_MAT, 0, [0x20, 0x6d, 0x61, 0x74]],
];

// The five steps: evaluated node, time, entries (token, p_raw), entropy, decode_ms.
const STEPS: { node: number; t: number; entries: [number, number][]; entropy: number; decodeMs: number }[] = [
  { node: 1, t: 200, entries: [[T_CAT, 0.5], [T_DOG, 0.25], [T_CAF, 0.125], [T_DOT, 0.0625]], entropy: 1.75, decodeMs: 1.5 },
  { node: 2, t: 300, entries: [[T_CAF, 0.5], [T_SAT, 0.25], [T_ON, 0.125], [T_DOT, 0.0625]], entropy: 2.0, decodeMs: 2.5 },
  { node: 3, t: 400, entries: [[T_E1, 0.75], [T_DOT, 0.125], [T_E2, 0.0625], [T_EOS, 0.03125]], entropy: 1.25, decodeMs: 3.5 },
  { node: 4, t: 500, entries: [[T_E2, 0.875], [T_DOT, 0.0625], [T_CAT, 0.03125], [T_DOG, 0.015625]], entropy: 0.75, decodeMs: 4.5 },
  { node: 5, t: 600, entries: [[T_EOS, 0.5], [T_DOT, 0.25], [T_MAT, 0.125], [T_ON, 0.0625]], entropy: 1.875, decodeMs: 5.5 },
];

// Nodes: id = index; parent, token, depth, origin.
const NODES: [parent: number, token: number, depth: number, origin: number][] = [
  [NONE, T_BOS, 0, ORIGIN_PROMPT],
  [0, T_THE, 1, ORIGIN_PROMPT],
  [1, T_CAT, 2, ORIGIN_MODEL],
  [2, T_CAF, 3, ORIGIN_MODEL],
  [3, T_E1, 4, ORIGIN_MODEL],
  [4, T_E2, 5, ORIGIN_MODEL],
  [5, T_EOS, 6, ORIGIN_MODEL],
];

let frames: Frame[];
let store: Store;

beforeAll(async () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/single.ils'));
  frames = await decodeSession(new Uint8Array(file));
  store = new Store();
  for (const f of frames) store.apply(f);
});

describe('golden session single.ils', () => {
  it('has the expected frames and times', () => {
    // 2 + 4 + (4 + 4 + 4 + 3 + 4) + 1, as test_golden.cpp checks.
    expect(frames.length).toBe(26);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_HELLO, FRAME_CONFIG,
      FRAME_VOCAB, FRAME_NODE, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_STOP,
    ]);
    expect(frames.map((f) => f.t)).toEqual([
      0, 0,
      100, 100, 100, 100,
      200, 200, 200, 200,
      300, 300, 300, 300,
      400, 400, 400, 400,
      500, 500, 500,
      600, 600, 600, 600,
      600,
    ]);
    expect(store.framesApplied).toBe(26);
    expect(store.sessionTime).toBe(600);
  });

  it('reads HELLO', () => {
    expect(store.unsupported).toBe(false);
    expect(store.hello).toEqual({
      protocol: 1,
      app: '0.1.0',
      llama_cpp: '0.9.0',
      created: '2026-01-01T00:00:00Z',
      n_vocab: 12,
      n_raw: 4,
      models: [
        {
          slot: 'A',
          name: 'Golden-1',
          file: 'golden.gguf',
          quant: 'Q8_0',
          arch: 'golden',
          n_params: 1000,
          size_bytes: 2000,
          n_layer: 2,
          n_embd: 8,
          n_ctx: 64,
        },
      ],
      lens: { enabled: false, layers: [] },
      warnings: ['synthetic session'],
    });
  });

  it('reads CONFIG', () => {
    expect(store.config).toEqual({ mode: 'lockstep', driver: 'A', seed: 42, max_tokens: 16, gates: [] });
  });

  it('reads the vocabulary, split characters included', () => {
    expect(store.vocab.size).toBe(12);
    for (const [token, attr, bytes] of VOCAB) {
      const e = store.vocab.get(token);
      expect(e, `token ${token}`).toBeDefined();
      expect(e!.token).toBe(token);
      expect(e!.attr).toBe(attr);
      expect([...e!.bytes]).toEqual(bytes);
    }
    // The two halves of "é" (C3 A9).
    expect([...store.vocab.get(T_E1)!.bytes]).toEqual([0xc3]);
    expect([...store.vocab.get(T_E2)!.bytes]).toEqual([0xa9]);
  });

  it('rebuilds the seven nodes', () => {
    expect(store.nodeCount).toBe(7);
    expect(store.parent).toEqual(NODES.map((n) => n[0]));
    expect(store.token).toEqual(NODES.map((n) => n[1]));
    expect(store.depth).toEqual(NODES.map((n) => n[2]));
    expect(store.origin).toEqual(NODES.map((n) => n[3]));
  });

  it('reads the five EVALs exactly', () => {
    const evals = frames.filter((f) => f.type === FRAME_EVAL);
    expect(evals.length).toBe(5);
    expect(store.evalA.filter((e) => e !== undefined).length).toBe(5);
    expect(store.evalA[0]).toBeUndefined();
    expect(store.evalA[6]).toBeUndefined();
    for (const s of STEPS) {
      const e = store.evalA[s.node]!;
      expect(e, `EVAL of node ${s.node}`).toBeDefined();
      expect(e.t).toBe(s.t);
      expect(e.node).toBe(s.node);
      expect(e.slot).toBe(0);
      expect(e.nRaw).toBe(4);
      expect(e.nExtra).toBe(0);
      expect(e.nGates).toBe(0);
      expect(e.pick).toBe(0);
      expect(e.flags).toBe(0);
      expect([...e.tokens]).toEqual(s.entries.map((x) => x[0]));
      // Sums of powers of two: exact in a float.
      expect([...e.pRaw]).toEqual(s.entries.map((x) => x[1]));
      expect(e.entropy).toBe(s.entropy);
      expect(e.rawMass).toBe(s.entries.reduce((a, x) => a + x[1], 0));
      expect(e.decodeMs).toBe(s.decodeMs);
      expect(e.survivors.length).toBe(0);
      expect(e.stageP.length).toBe(0);
      expect(e.config).toBe(store.config);
    }
  });

  it('follows the cursor and stops at the end of generation', () => {
    expect(store.cursorA).toBe(6);
    expect(store.cursorB).toBe(NONE);
    expect(store.path).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(store.promptLength).toBe(2);
    expect(store.stops.size).toBe(1);
    expect(store.stops.get(6)).toEqual({ slot: 0, reason: STOP_EOG });
    expect(store.stopAtEnd()).toEqual({ slot: 0, reason: STOP_EOG });
  });

  it('answers decision() and probability() per path index', () => {
    expect(store.decision(0)).toBeUndefined();
    expect(store.decision(1)).toBeUndefined(); // prompt token
    expect(store.probability(1)).toBeUndefined();
    expect(store.decision(7)).toBeUndefined();
    const expected = [0.5, 0.5, 0.75, 0.875, 0.5];
    for (let i = 2; i < 7; i++) {
      expect(store.decision(i)).toBe(store.evalA[i - 1]);
      expect(store.probability(i)).toBe(expected[i - 2]);
    }
  });

  it('joins the two halves of "é" into one group', () => {
    const bytes = store.path.map((n) => store.vocab.get(store.token[n])!.bytes);
    const control = store.path.map((n) => (store.vocab.get(store.token[n])!.attr & ATTR_CONTROL) !== 0);
    expect(groupTokens(bytes, control)).toEqual([
      { start: 0, end: 1, text: '<s>' },
      { start: 1, end: 2, text: 'The' },
      { start: 2, end: 3, text: ' cat' },
      { start: 3, end: 4, text: ' caf' },
      { start: 4, end: 6, text: 'é' },
      { start: 6, end: 7, text: '<eos>' },
    ]);
  });
});
