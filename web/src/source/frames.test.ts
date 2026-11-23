import { describe, expect, it } from 'vitest';
import { concat, config, cursor, evalFrame, frame, hello, node, pair, stop, vocab } from '../testing/encode';
import {
  EVAL_LENS,
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_PAIR,
  FRAME_STOP,
  FRAME_VOCAB,
  NONE,
  PAIR_APPROX,
  PAIR_SAME_PICK,
  decodeFrames,
  type EvalFrame,
  type NodeFrame,
  type VocabFrame,
} from './frames';

describe('decodeFrames', () => {
  it('decodes several concatenated frames of every type', () => {
    const buf = concat(
      hello(0),
      config(0),
      vocab(5, [{ token: 7, attr: 1, text: '<s>' }, { token: 9, text: new Uint8Array([0xc3]) }]),
      node(6, 0, NONE, 7, 0, 0),
      evalFrame(7, {
        node: 0,
        entries: [[9, 0.5], [7, 0.25], [3, 0.125]],
        nExtra: 1,
        pick: 2,
        entropy: 1.5,
        decodeMs: 2.5,
        survivors: [10, 2],
        stageP: [0.5, 0.25, 0.25, 1, 0, 0],
      }),
      cursor(8, 0),
      stop(9, 0, 2, 1),
    );
    const frames = decodeFrames(buf);
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_HELLO, FRAME_CONFIG, FRAME_VOCAB, FRAME_NODE, FRAME_EVAL, FRAME_CURSOR, FRAME_STOP,
    ]);
    expect(frames.map((f) => f.t)).toEqual([0, 0, 5, 6, 7, 8, 9]);

    const v = frames[2] as VocabFrame;
    expect(v.entries.map((e) => [e.token, e.attr, [...e.bytes]])).toEqual([
      [7, 1, [0x3c, 0x73, 0x3e]],
      [9, 0, [0xc3]],
    ]);
    expect(frames[3] as NodeFrame).toEqual({ type: FRAME_NODE, t: 6, id: 0, parent: NONE, token: 7, depth: 0, origin: 0 });

    const e = frames[4] as EvalFrame;
    expect([e.node, e.slot, e.nRaw, e.nExtra, e.nGates, e.pick]).toEqual([0, 0, 2, 1, 2, 2]);
    expect([e.entropy, e.rawMass, e.decodeMs]).toEqual([1.5, 0.875, 2.5]);
    expect([...e.tokens]).toEqual([9, 7, 3]);
    expect([...e.pRaw]).toEqual([0.5, 0.25, 0.125]);
    expect([...e.survivors]).toEqual([10, 2]);
    expect([...e.stageP]).toEqual([0.5, 0.25, 0.25, 1, 0, 0]);

    expect(frames[5]).toEqual({ type: FRAME_CURSOR, t: 8, nodeA: 0, nodeB: NONE });
    expect(frames[6]).toEqual({ type: FRAME_STOP, t: 9, node: 0, slot: 2, reason: 1 });
  });

  it('decodes the logit-lens section of an EVAL', () => {
    const frames = decodeFrames(
      concat(
        evalFrame(1, { node: 0, entries: [[9, 0.5], [7, 0.25]] }),
        evalFrame(2, {
          node: 1,
          entries: [[9, 0.5], [7, 0.25]],
          survivors: [2],
          stageP: [0.75, 0.25],
          lens: [[7, 0.25, 0.125, 3.5], [9, 0.5, 0.5, 1.5]],
        }),
        cursor(3, 1),
      ),
    );
    const [plain, withLens] = frames as EvalFrame[];
    expect(plain.flags & EVAL_LENS).toBe(0);
    expect(plain.lens).toBeNull();
    expect(withLens.flags & EVAL_LENS).toBe(EVAL_LENS);
    expect([...withLens.stageP]).toEqual([0.75, 0.25]);
    expect([...withLens.lens!.topId]).toEqual([7, 9]);
    expect([...withLens.lens!.topP]).toEqual([0.25, 0.5]);
    expect([...withLens.lens!.answerP]).toEqual([0.125, 0.5]);
    expect([...withLens.lens!.entropy]).toEqual([3.5, 1.5]);
    // The frame after the section is read from the right place.
    expect(frames[2]).toEqual({ type: FRAME_CURSOR, t: 3, nodeA: 1, nodeB: NONE });
  });

  it('skips a frame of an unknown type', () => {
    const unknown = frame(99, 3, new Uint8Array([1, 2, 3, 4, 5]));
    const frames = decodeFrames(concat(cursor(1, 4), unknown, cursor(5, 6)));
    expect(frames).toEqual([
      { type: FRAME_CURSOR, t: 1, nodeA: 4, nodeB: NONE },
      { type: FRAME_CURSOR, t: 5, nodeA: 6, nodeB: NONE },
    ]);
  });

  it('decodes PAIR', () => {
    const frames = decodeFrames(
      pair(4, { node: 9, js: 0.5, klAB: 0.25, klBA: Infinity, rankAInB: 3, rankBInA: NONE, flags: PAIR_SAME_PICK | PAIR_APPROX }),
    );
    expect(frames).toEqual([
      { type: FRAME_PAIR, t: 4, node: 9, js: 0.5, klAB: 0.25, klBA: Infinity, rankAInB: 3, rankBInA: NONE, flags: 6 },
    ]);
    // The body is 25 bytes, as the protocol defines.
    expect(pair(0, { node: 0 }).length).toBe(12 + 25);
  });

  it('decodes an empty buffer to no frames', () => {
    expect(decodeFrames(new Uint8Array(0))).toEqual([]);
  });

  it('throws on a truncated buffer', () => {
    const buf = concat(cursor(1, 4), cursor(2, 5));
    expect(() => decodeFrames(buf.subarray(0, buf.length - 1))).toThrow(/truncated frame body/);
    expect(() => decodeFrames(buf.subarray(0, 20 + 5))).toThrow(/truncated frame header/);
    expect(() => decodeFrames(buf.subarray(0, 11))).toThrow(/truncated/);
  });

  it('throws on a VOCAB entry that runs past its frame', () => {
    const v = vocab(0, [{ token: 1, text: 'abc' }]);
    // Shrink the frame's length by one byte and drop the last byte.
    const cut = v.slice(0, v.length - 1);
    new DataView(cut.buffer).setUint32(4, v.length - 12 - 1, true);
    expect(() => decodeFrames(cut)).toThrow();
  });

  it('reads a subarray whose byteOffset is not 0', () => {
    const inner = concat(cursor(1, 2), node(3, 0, NONE, 5, 0, 0));
    const outer = concat(new Uint8Array([0xaa, 0xbb, 0xcc]), inner, new Uint8Array([0xdd]));
    const view = outer.subarray(3, 3 + inner.length);
    expect(view.byteOffset).toBe(3);
    expect(decodeFrames(view)).toEqual(decodeFrames(inner));
    expect(decodeFrames(view).length).toBe(2);
  });
});
