// The protocol contract with the logit lens, TypeScript side: reads
// sessions/golden/lens.ils and expects exactly what engine/tests/test_golden.cpp
// (build_golden_lens) writes. Change both together.
//
// The session: one model with the lens on layers 0, 1 and 3 of 4; prompt
// "<s>The" and two steps whose EVALs carry the lens section.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import {
  EVAL_LENS,
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_VOCAB,
  type EvalFrame,
  type Frame,
  type HelloFrame,
  type VocabFrame,
} from './frames';
import { decodeSession } from './recorded';

// Token ids of test_golden.cpp.
const T_CAT = 3, T_SAT = 4, T_CAF = 5, T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

let frames: Frame[];

function ofType<T extends Frame>(type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

beforeAll(async () => {
  const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/lens.ils'));
  frames = await decodeSession(new Uint8Array(file));
});

describe('golden session lens.ils', () => {
  it('has the expected frames and times', () => {
    // 2 + 4 + 4 + 4, as test_golden.cpp checks.
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_HELLO, FRAME_CONFIG,
      FRAME_VOCAB, FRAME_NODE, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
      FRAME_VOCAB, FRAME_EVAL, FRAME_NODE, FRAME_CURSOR,
    ]);
    expect(frames.map((f) => f.t)).toEqual([0, 0, 100, 100, 100, 100, 200, 200, 200, 200, 300, 300, 300, 300]);
  });

  it('reads HELLO with the lens layers', () => {
    expect((frames[0] as HelloFrame).hello).toEqual({
      protocol: 1,
      app: '0.1.0',
      llama_cpp: '0.9.0',
      created: '2026-01-01T00:00:00Z',
      n_vocab: 12,
      n_raw: 4,
      models: [
        { slot: 'A', name: 'Golden-5', file: 'golden.gguf', quant: 'Q8_0', arch: 'golden', n_params: 1000, size_bytes: 2000, n_layer: 4, n_embd: 8, n_ctx: 64 },
      ],
      lens: { enabled: true, layers: [0, 1, 3] },
      warnings: ['synthetic session'],
    });
  });

  it('the VOCAB of a step carries the lens tokens that are not candidates', () => {
    const v = ofType<VocabFrame>(FRAME_VOCAB);
    expect(v[1].entries.map((e) => e.token)).toEqual([T_CAT, T_DOG, T_CAF, T_DOT, T_ON, T_MAT]);
    expect(v[2].entries.map((e) => e.token)).toEqual([T_SAT]);
  });

  it('reads the lens section of the first EVAL', () => {
    const e = ofType<EvalFrame>(FRAME_EVAL)[0];
    expect([e.t, e.node, e.slot, e.flags]).toEqual([200, 1, 0, EVAL_LENS]);
    expect([e.nRaw, e.nExtra, e.nGates, e.pick]).toEqual([4, 0, 0, 0]);
    expect([e.entropy, e.rawMass, e.decodeMs]).toEqual([1.75, 0.9375, 1.5]);
    expect([...e.tokens]).toEqual([T_CAT, T_DOG, T_CAF, T_DOT]);
    expect([...e.lens!.topId]).toEqual([T_ON, T_MAT, T_CAT]);
    expect([...e.lens!.topP]).toEqual([0.125, 0.25, 0.5]);
    expect([...e.lens!.answerP]).toEqual([0.0625, 0.125, 0.5]);
    expect([...e.lens!.entropy]).toEqual([3.5, 2.75, 1.75]);
  });

  it('reads the lens section of the second EVAL', () => {
    const e = ofType<EvalFrame>(FRAME_EVAL)[1];
    expect([e.t, e.node, e.flags]).toEqual([300, 2, EVAL_LENS]);
    expect([...e.tokens]).toEqual([T_SAT, T_ON, T_DOT, T_MAT]);
    expect([...e.lens!.topId]).toEqual([T_SAT, T_SAT, T_SAT]);
    expect([...e.lens!.topP]).toEqual([0.25, 0.5, 0.75]);
    expect([...e.lens!.answerP]).toEqual([0.25, 0.5, 0.75]);
    expect([...e.lens!.entropy]).toEqual([3, 2, 1.25]);
  });
});

describe('golden session lens.ils in the store', () => {
  it('keeps the lens with each decision and knows every lens token', () => {
    const store = new Store();
    for (const f of frames) store.apply(f);
    expect(store.hello!.lens).toEqual({ enabled: true, layers: [0, 1, 3] });
    expect(store.path).toEqual([0, 1, 2, 3]);
    for (const i of [2, 3]) {
      const d = store.decision(i)!;
      expect(d.lens!.topId.length).toBe(store.hello!.lens.layers.length);
      for (const t of d.lens!.topId) expect(store.vocab.has(t)).toBe(true);
      // The last layer agrees with the model.
      expect(d.lens!.topId[2]).toBe(d.tokens[0]);
    }
  });
});
