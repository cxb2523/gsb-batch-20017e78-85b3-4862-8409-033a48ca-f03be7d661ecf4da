// The protocol contract with gates, TypeScript side: reads
// sessions/golden/gates.ils and expects exactly what engine/tests/test_golden.cpp
// (build_golden_gates) writes. Change both together.
//
// The session: prompt "<s>The"; a step with three gates (grammar, top_k 2,
// temp 0.5) where the pick, " dog", is an added candidate; a `config` that
// changes the chain to top_p 0.5 and the seed; and a step with that one gate.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import {
  ATTR_CONTROL,
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_VOCAB,
  NONE,
  ORIGIN_MODEL,
  ORIGIN_PROMPT,
  type Config,
  type ConfigFrame,
  type CursorFrame,
  type EvalFrame,
  type Frame,
  type HelloFrame,
  type NodeFrame,
  type VocabFrame,
} from './frames';
import { decodeSession } from './recorded';

// Token ids of test_golden.cpp.
const T_BOS = 0, T_THE = 2, T_CAT = 3, T_SAT = 4;
const T_E1 = 6, T_E2 = 7, T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

const FIRST: Config = {
  mode: 'lockstep',
  driver: 'A',
  seed: 7,
  max_tokens: 16,
  gates: [
    { type: 'grammar', gbnf: 'root ::= [a-z ]+' },
    { type: 'top_k', k: 2 },
    { type: 'temp', t: 0.5 },
  ],
};
const SECOND: Config = { ...FIRST, seed: 9, gates: [{ type: 'top_p', p: 0.5 }] };

// Nodes: id = index; parent, token, depth, origin.
const NODES: [parent: number, token: number, depth: number, origin: number][] = [
  [NONE, T_BOS, 0, ORIGIN_PROMPT],
  [0, T_THE, 1, ORIGIN_PROMPT],
  [1, T_DOG, 2, ORIGIN_MODEL],
  [2, T_SAT, 3, ORIGIN_MODEL],
];

// What a float32 reads back as: 0.9 and 0.1 are not exact.
const f32 = (xs: number[]): number[] => [...new Float32Array(xs)];

let frames: Frame[];

function ofType<T extends Frame>(type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

beforeAll(async () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/gates.ils'));
  frames = await decodeSession(new Uint8Array(file));
});

describe('golden session gates.ils', () => {
  it('has the expected frames and times', () => {
    // 2 + 4 + 4 + 1 + 4, as test_golden.cpp checks.
    expect(frames.length).toBe(15);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_HELLO, FRAME_CONFIG,
      FRAME_VOCAB, FRAME_NODE, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_CONFIG,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
    ]);
    expect(frames.map((f) => f.t)).toEqual([
      0, 0,
      100, 100, 100, 100,
      200, 200, 200, 200,
      250,
      300, 300, 300, 300,
    ]);
  });

  it('reads HELLO', () => {
    expect((frames[0] as HelloFrame).hello).toEqual({
      protocol: 1,
      app: '0.1.0',
      llama_cpp: '0.9.0',
      created: '2026-01-01T00:00:00Z',
      n_vocab: 12,
      n_raw: 4,
      models: [
        { slot: 'A', name: 'Golden-3', file: 'golden.gguf', quant: 'Q8_0', arch: 'golden', n_params: 1000, size_bytes: 2000, n_layer: 2, n_embd: 8, n_ctx: 64 },
      ],
      lens: { enabled: false, layers: [] },
      warnings: ['synthetic session'],
    });
  });

  it('reads the two CONFIGs with their gates, every parameter and the seed', () => {
    expect(ofType<ConfigFrame>(FRAME_CONFIG).map((f) => [f.t, f.config])).toEqual([
      [0, FIRST],
      [250, SECOND],
    ]);
  });

  it('reads the vocabulary of each step', () => {
    const v = ofType<VocabFrame>(FRAME_VOCAB);
    expect(v.map((f) => [f.t, f.entries.map((e) => e.token)])).toEqual([
      [100, [T_BOS, T_THE]],
      [200, [T_DOT, T_E1, T_CAT, T_E2, T_DOG]],
      [300, [T_SAT, T_ON, T_MAT]],
    ]);
    expect(v[0].entries[0].attr).toBe(ATTR_CONTROL);
    expect(new TextDecoder().decode(v[1].entries[4].bytes)).toBe(' dog');
  });

  it('reads the four nodes and the cursors', () => {
    const nodes = ofType<NodeFrame>(FRAME_NODE);
    expect(nodes.map((n) => n.id)).toEqual([0, 1, 2, 3]);
    expect(nodes.map((n) => [n.parent, n.token, n.depth, n.origin])).toEqual(NODES);
    expect(ofType<CursorFrame>(FRAME_CURSOR).map((c) => [c.t, c.nodeA, c.nodeB])).toEqual([
      [100, 1, NONE],
      [200, 2, NONE],
      [300, 3, NONE],
    ]);
  });

  it('reads the EVAL with three gates and an added candidate', () => {
    const e = ofType<EvalFrame>(FRAME_EVAL)[0];
    expect([e.t, e.node, e.slot]).toEqual([200, 1, 0]);
    expect([e.nRaw, e.nExtra, e.nGates, e.pick, e.flags]).toEqual([4, 1, 3, 4, 0]);
    expect([e.entropy, e.rawMass, e.decodeMs]).toEqual([2.25, 0.78125, 1.5]);
    expect([...e.tokens]).toEqual([T_DOT, T_E1, T_CAT, T_E2, T_DOG]);
    expect([...e.pRaw]).toEqual([0.5, 0.125, 0.09375, 0.0625, 0.03125]);
    expect(e.tokens[e.pick]).toBe(T_DOG);
    expect([...e.survivors]).toEqual([7, 2, 2]);
    expect([...e.stageP]).toEqual(
      f32([
        0, 0, 0.375, 0, 0.125, // grammar
        0, 0, 0.75, 0, 0.25, // top_k 2
        0, 0, 0.9, 0, 0.1, // temp 0.5
      ]),
    );
  });

  it('reads the EVAL with the new chain: one gate', () => {
    const e = ofType<EvalFrame>(FRAME_EVAL)[1];
    expect([e.t, e.node, e.slot]).toEqual([300, 2, 0]);
    expect([e.nRaw, e.nExtra, e.nGates, e.pick, e.flags]).toEqual([4, 0, 1, 0, 0]);
    expect([e.entropy, e.rawMass, e.decodeMs]).toEqual([1.875, 0.9375, 2.5]);
    expect([...e.tokens]).toEqual([T_SAT, T_ON, T_DOT, T_MAT]);
    expect([...e.pRaw]).toEqual([0.5, 0.25, 0.125, 0.0625]);
    expect([...e.survivors]).toEqual([1]);
    expect([...e.stageP]).toEqual([1, 0, 0, 0]);
  });
});

describe('golden session gates.ils in the store', () => {
  let store: Store;

  beforeAll(() => {
    store = new Store();
    for (const f of frames) store.apply(f);
  });

  it('ends with the new CONFIG', () => {
    expect(store.config).toEqual(SECOND);
    expect(store.path).toEqual([0, 1, 2, 3]);
  });

  // Acceptance criterion "old gates": after the chain changes halfway, a
  // decision taken before shows the gates it was taken with.
  it('an earlier decision keeps the CONFIG of three gates', () => {
    const first = store.evalA[1]!;
    expect(first.nGates).toBe(3);
    expect(first.config).toEqual(FIRST);
    expect(first.config!.gates.length).toBe(first.nGates);
    // " dog" (index 2) was decided at node 1.
    expect(store.decision(2)!.node).toBe(1);
    expect(store.decision(2)!.config!.gates).toEqual(FIRST.gates);

    const second = store.evalA[2]!;
    expect(second.config).toEqual(SECOND);
    expect(second.config!.gates.length).toBe(second.nGates);
    expect(store.decision(3)!.config!.gates).toEqual(SECOND.gates);
  });
});
