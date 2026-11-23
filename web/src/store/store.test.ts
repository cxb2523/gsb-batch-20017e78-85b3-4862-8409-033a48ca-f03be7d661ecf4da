import { describe, expect, it } from 'vitest';
import { concat, config, configBody, cursor, evalFrame, hello, node, pair, stop, vocab } from '../testing/encode';
import {
  decodeFrames,
  FRAME_PAIR,
  NONE,
  ORIGIN_MODEL,
  ORIGIN_PROMPT,
  ORIGIN_USER,
  PAIR_SAME_PICK,
  PAIR_SAME_TOP,
  type Config,
  type Frame,
} from '../source/frames';
import { Store } from './store';

function feed(store: Store, ...parts: Uint8Array[]): void {
  for (const f of decodeFrames(concat(...parts))) store.apply(f);
}

function clearDirty(store: Store): void {
  for (const k of Object.keys(store.dirty) as (keyof Store["dirty"])[]) store.dirty[k] = false;
}

// A prompt of two tokens (nodes 0, 1) with the cursor at its end.
const prompt = [
  hello(0),
  config(0),
  vocab(1, [{ token: 0, attr: 1, text: '<s>' }, { token: 1, text: 'A' }, { token: 2, text: 'B' }]),
  node(1, 0, NONE, 0, 0, ORIGIN_PROMPT),
  node(1, 1, 0, 1, 1, ORIGIN_PROMPT),
  cursor(1, 1),
];

describe('Store', () => {
  it('starts empty', () => {
    const s = new Store();
    expect(s.hello).toBeNull();
    expect(s.nodeCount).toBe(0);
    expect(s.path).toEqual([]);
    expect(s.promptLength).toBe(0);
    expect(s.stopAtEnd()).toBeUndefined();
  });

  it('empties everything on HELLO and bumps pathEpoch', () => {
    const s = new Store();
    feed(s, ...prompt, evalFrame(2, { node: 1, entries: [[2, 1]] }), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2),
      stop(2, 2, 0, 0));
    expect(s.nodeCount).toBe(3);
    expect(s.stopAtEnd()).toBeDefined();
    const epoch = s.pathEpoch;
    clearDirty(s);

    feed(s, hello(0));
    expect(s.hello).not.toBeNull();
    expect(s.config).toBeNull();
    expect(s.vocab.size).toBe(0);
    expect(s.nodeCount).toBe(0);
    expect(s.parent).toEqual([]);
    expect(s.token).toEqual([]);
    expect(s.evalA).toEqual([]);
    expect(s.stops.size).toBe(0);
    expect(s.cursorA).toBe(NONE);
    expect(s.cursorB).toBe(NONE);
    expect(s.path).toEqual([]);
    expect(s.pathEpoch).toBeGreaterThan(epoch);
    expect(s.sessionTime).toBe(0);
    expect(s.dirty).toEqual({ meta: true, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });
  });

  it('replaces the EVAL of a node with a second one', () => {
    const s = new Store();
    feed(s, ...prompt, evalFrame(2, { node: 1, entries: [[1, 0.5]] }), evalFrame(3, { node: 1, entries: [[2, 0.75]] }));
    expect([...s.evalA[1]!.tokens]).toEqual([2]);
    expect(s.evalA[1]!.t).toBe(3);
    // Model B's EVAL (two models) does not touch A's.
    feed(s, evalFrame(4, { node: 1, slot: 1, entries: [[0, 1]] }));
    expect([...s.evalA[1]!.tokens]).toEqual([2]);
  });

  it('keeps the CONFIG in force with each EVAL', () => {
    const s = new Store();
    const c2 = { ...configBody(99), seed: 7 };
    feed(s, ...prompt, evalFrame(2, { node: 0, entries: [[1, 1]] }), config(3, c2), evalFrame(4, { node: 1, entries: [[2, 1]] }));
    expect(s.evalA[0]!.config).toEqual(configBody());
    expect(s.evalA[1]!.config).toEqual(c2);
    expect(s.config).toEqual(c2);
  });

  it('reads nothing more after a HELLO with a newer protocol', () => {
    const s = new Store();
    feed(s, hello(0, 2), config(0), vocab(1, [{ token: 0, text: 'x' }]), node(1, 0, NONE, 0, 0, 0), cursor(1, 0));
    expect(s.unsupported).toBe(true);
    expect(s.hello!.protocol).toBe(2);
    expect(s.config).toBeNull();
    expect(s.vocab.size).toBe(0);
    expect(s.nodeCount).toBe(0);
    expect(s.path).toEqual([]);
    // A later HELLO of a supported version starts a readable session.
    feed(s, ...prompt);
    expect(s.unsupported).toBe(false);
    expect(s.nodeCount).toBe(2);
  });

  it('extends the path at its end without bumping pathEpoch', () => {
    const s = new Store();
    feed(s, ...prompt);
    expect(s.path).toEqual([0, 1]);
    expect(s.promptLength).toBe(2);
    const epoch = s.pathEpoch;
    clearDirty(s);

    feed(s, node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2));
    expect(s.path).toEqual([0, 1, 2]);
    expect(s.pathEpoch).toBe(epoch);
    expect(s.dirty.stream && s.dirty.candidates && s.dirty.timeline).toBe(true);
    expect(s.dirty.meta).toBe(false);

    // The same cursor again changes nothing.
    clearDirty(s);
    feed(s, cursor(3, 2));
    expect(s.path).toEqual([0, 1, 2]);
    expect(s.dirty.stream).toBe(false);
  });

  it('rebuilds the path and bumps pathEpoch when the cursor jumps', () => {
    const s = new Store();
    feed(s, ...prompt, node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2));
    const epoch = s.pathEpoch;

    // A branch: node 3 is a sibling of node 2.
    feed(s, node(3, 3, 1, 1, 2, ORIGIN_USER), cursor(3, 3));
    expect(s.path).toEqual([0, 1, 3]);
    expect(s.pathEpoch).toBe(epoch + 1);

    // Straight back to the other branch.
    feed(s, cursor(4, 2));
    expect(s.path).toEqual([0, 1, 2]);
    expect(s.pathEpoch).toBe(epoch + 2);

    // Back up the tree (goto an ancestor).
    feed(s, cursor(5, 1));
    expect(s.path).toEqual([0, 1]);
    expect(s.pathEpoch).toBe(epoch + 3);
  });

  it('flags the panels that changed', () => {
    const s = new Store();
    feed(s, ...prompt);

    clearDirty(s);
    feed(s, config(2)); // the Stream columns depend on the mode
    expect(s.dirty).toEqual({ meta: true, stream: true, candidates: false, gates: false, timeline: false, relief: false, metrics: false, lens: false, compare: false });

    clearDirty(s);
    feed(s, vocab(2, [{ token: 5, text: 'z' }]), node(2, 2, 1, 5, 2, ORIGIN_MODEL));
    expect(s.dirty).toEqual({ meta: false, stream: false, candidates: false, gates: false, timeline: false, relief: false, metrics: false, lens: false, compare: false });

    clearDirty(s);
    feed(s, evalFrame(2, { node: 1, entries: [[5, 1]] }));
    expect(s.dirty).toEqual({ meta: false, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });

    clearDirty(s);
    feed(s, cursor(2, 2));
    expect(s.dirty).toEqual({ meta: false, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });

    clearDirty(s);
    feed(s, stop(2, 2, 0, 1));
    expect(s.dirty).toEqual({ meta: false, stream: true, candidates: false, gates: false, timeline: false, relief: false, metrics: false, lens: false, compare: false });
    expect(s.stopAtEnd()).toEqual({ slot: 0, reason: 1 });
  });

  it('counts frames and keeps the session time', () => {
    const s = new Store();
    const frames: Frame[] = decodeFrames(concat(...prompt));
    for (const f of frames) s.apply(f);
    expect(s.framesApplied).toBe(frames.length);
    expect(s.sessionTime).toBe(1);
  });
});

// ------------------------------------------------------------ two models

const SAME = PAIR_SAME_TOP | PAIR_SAME_PICK;

// A prompt of two tokens (nodes 0, 1) with both cursors at its end.
function prompt2(c: Config = configBody()): Uint8Array[] {
  return [
    hello(0, 1, 2),
    config(0, c),
    vocab(1, [0, 1, 2, 3, 4, 5, 6, 7].map((token) => ({ token, text: `t${token}` }))),
    node(1, 0, NONE, 0, 0, ORIGIN_PROMPT),
    node(1, 1, 0, 1, 1, ORIGIN_PROMPT),
    cursor(1, 1, 1),
  ];
}

// Free mode: one common step (node 2), then A writes node 3 and B node 4.
//
//   0 ─ 1 ─ 2 ─┬─ 3   ◄ A
//              └─ 4   ◄ B
function split2(): Uint8Array[] {
  return [
    ...prompt2(configBody(16, 'free')),
    evalFrame(2, { node: 1, entries: [[2, 0.5]] }),
    evalFrame(2, { node: 1, slot: 1, entries: [[2, 0.75]] }),
    pair(2, { node: 1, flags: SAME }),
    node(2, 2, 1, 2, 2, ORIGIN_MODEL),
    cursor(2, 2, 2),
    evalFrame(3, { node: 2, entries: [[3, 0.5], [4, 0.25]] }),
    evalFrame(3, { node: 2, slot: 1, entries: [[4, 0.625], [3, 0.125]] }),
    pair(3, { node: 2, js: 0.25, flags: 0 }),
    node(3, 3, 2, 3, 3, ORIGIN_MODEL),
    node(3, 4, 2, 4, 3, ORIGIN_MODEL),
    cursor(3, 3, 4),
  ];
}

describe('Store with two models', () => {
  it('keeps the EVAL of B apart from A', () => {
    const s = new Store();
    feed(s, ...prompt2(), evalFrame(2, { node: 1, entries: [[2, 1]] }), evalFrame(2, { node: 1, slot: 1, entries: [[3, 1]] }));
    expect([...s.evalA[1]!.tokens]).toEqual([2]);
    expect([...s.evalB[1]!.tokens]).toEqual([3]);
    expect(s.evals[0]).toBe(s.evalA);
    expect(s.evals[1]).toBe(s.evalB);
    expect(s.evalB[1]!.config).toEqual(configBody());
    expect(s.twoModels).toBe(true);
  });

  it('keeps a PAIR per node and replaces it with a second one', () => {
    const s = new Store();
    feed(s, ...prompt2());
    clearDirty(s);
    feed(s, pair(2, { node: 1, js: 0.5, flags: 0 }));
    expect(s.pairs[1]!.js).toBe(0.5);
    expect(s.dirty).toEqual({ meta: false, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });
    feed(s, pair(3, { node: 1, js: 0.25, klAB: 1, klBA: 2, rankAInB: 3, rankBInA: NONE, flags: SAME }));
    expect(s.pairs[1]).toEqual({ type: FRAME_PAIR, t: 3, node: 1, js: 0.25, klAB: 1, klBA: 2, rankAInB: 3, rankBInA: NONE, flags: SAME });
    expect(s.pairs[0]).toBeUndefined();
  });

  it('merges two stops at one node into slot 2', () => {
    const s = new Store();
    feed(s, ...prompt2(), stop(2, 1, 0, 1));
    expect(s.stops.get(1)).toEqual({ slot: 0, reason: 1 });
    feed(s, stop(2, 1, 0, 1)); // the same slot again: still A
    expect(s.stops.get(1)).toEqual({ slot: 0, reason: 1 });
    feed(s, stop(3, 1, 1, 0));
    expect(s.stops.get(1)).toEqual({ slot: 2, reason: 0 });
    feed(s, stop(3, 0, 2, 2));
    expect(s.stops.get(0)).toEqual({ slot: 2, reason: 2 });
  });

  it('puts the driver in front in lockstep and A in free mode', () => {
    const at = (c: Config, models: 1 | 2 = 2): number => {
      const s = new Store();
      feed(s, hello(0, 1, models), config(0, c));
      return s.front;
    };
    expect(at(configBody(16, 'lockstep', 'A'))).toBe(0);
    expect(at(configBody(16, 'lockstep', 'B'))).toBe(1);
    expect(at(configBody(16, 'free', 'B'))).toBe(0);
    expect(at(configBody(16, 'lockstep', 'B'), 1)).toBe(0); // a single model
  });

  it('puts the default model in front again when mode or driver change', () => {
    const s = new Store();
    feed(s, ...prompt2(configBody(16, 'lockstep', 'B')));
    expect(s.front).toBe(1);
    s.setFront(0);
    expect(s.front).toBe(0);
    // Another max_tokens keeps the user's choice.
    feed(s, config(2, configBody(99, 'lockstep', 'B')));
    expect(s.front).toBe(0);
    feed(s, config(3, configBody(99, 'free', 'B')));
    expect(s.front).toBe(0);
    s.setFront(1);
    feed(s, config(4, configBody(99, 'free', 'A'))); // only the driver: still the default
    expect(s.front).toBe(0);
    feed(s, config(5, configBody(99, 'lockstep', 'B')));
    expect(s.front).toBe(1);
    clearDirty(s);
    feed(s, config(6, configBody(99, 'lockstep', 'A')));
    expect(s.front).toBe(0);
    expect(s.dirty.meta).toBe(true);
  });

  it('setFront follows the other cursor and voids the path only when it changes', () => {
    const s = new Store();
    feed(s, ...prompt2());
    // Cursors together: the path stays.
    let epoch = s.pathEpoch;
    clearDirty(s);
    s.setFront(1);
    expect(s.front).toBe(1);
    expect(s.other).toBe(0);
    expect(s.path).toEqual([0, 1]);
    expect(s.pathEpoch).toBe(epoch);
    expect(s.dirty.meta).toBe(true);

    const t = new Store();
    feed(t, ...split2());
    expect(t.path).toEqual([0, 1, 2, 3]);
    epoch = t.pathEpoch;
    clearDirty(t);
    t.setFront(1);
    expect(t.path).toEqual([0, 1, 2, 4]);
    expect(t.pathEpoch).toBe(epoch + 1);
    expect(t.lane).toEqual([3]);
    expect(t.split).toBe(2);
    expect(t.dirty).toEqual({ meta: true, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });

    // The same model again: nothing.
    clearDirty(t);
    t.setFront(1);
    expect(t.pathEpoch).toBe(epoch + 1);
    expect(t.dirty).toEqual({ meta: false, stream: false, candidates: false, gates: false, timeline: false, relief: false, metrics: false, lens: false, compare: false });

    t.setFront(0);
    expect(t.path).toEqual([0, 1, 2, 3]);
    expect(t.lane).toEqual([4]);
  });

  it('ignores B in front with a single model', () => {
    const s = new Store();
    feed(s, ...prompt);
    clearDirty(s);
    s.setFront(1);
    expect(s.front).toBe(0);
    expect(s.twoModels).toBe(false);
    expect(s.dirty.meta).toBe(false);
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
  });

  it('follows the lane: split, growth, a cursor left behind and joining again', () => {
    const s = new Store();
    feed(s, ...prompt2(configBody(16, 'free')), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2, 2));
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
    expect(s.splits).toBe(0);

    // The split.
    let lane = s.laneEpoch;
    feed(s, node(3, 3, 2, 3, 3, ORIGIN_MODEL), node(3, 4, 2, 4, 3, ORIGIN_MODEL), cursor(3, 3, 4));
    expect(s.path).toEqual([0, 1, 2, 3]);
    expect(s.lane).toEqual([4]);
    expect(s.split).toBe(2);
    expect(s.splits).toBe(1);
    expect(s.laneEpoch).toBeGreaterThan(lane);

    // B grows at its end; then A alone (B stopped): the lane epoch stays.
    lane = s.laneEpoch;
    clearDirty(s);
    feed(s, node(4, 5, 4, 5, 4, ORIGIN_MODEL), cursor(4, 3, 5));
    expect(s.lane).toEqual([4, 5]);
    expect(s.laneEpoch).toBe(lane);
    expect(s.dirty.stream && s.dirty.candidates && s.dirty.timeline).toBe(true);
    feed(s, node(5, 6, 3, 6, 4, ORIGIN_MODEL), cursor(5, 6, 5));
    expect(s.path).toEqual([0, 1, 2, 3, 6]);
    expect(s.lane).toEqual([4, 5]);
    expect(s.laneEpoch).toBe(lane);

    // Together again (lockstep moves B to A's node).
    feed(s, cursor(6, 6, 6));
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
    expect(s.laneEpoch).toBeGreaterThan(lane);
    expect(s.splits).toBe(1);

    // B left behind on the path: a split with an empty lane, then B grows
    // away from it without voiding the lane.
    lane = s.laneEpoch;
    feed(s, cursor(7, 6, 3));
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(3);
    expect(s.splits).toBe(2);
    expect(s.laneEpoch).toBeGreaterThan(lane);
    lane = s.laneEpoch;
    feed(s, node(8, 7, 3, 7, 4, ORIGIN_MODEL), cursor(8, 6, 7));
    expect(s.lane).toEqual([7]);
    expect(s.split).toBe(3);
    expect(s.laneEpoch).toBe(lane);
  });

  it('rebuilds the lane when the path jumps and the other cursor stays', () => {
    const s = new Store();
    feed(s, ...split2());
    expect([s.lane, s.split]).toEqual([[4], 2]);
    const lane = s.laneEpoch;
    // A goes back to the end of the prompt: B's lane now starts at node 2.
    feed(s, cursor(4, 1, 4));
    expect(s.path).toEqual([0, 1]);
    expect(s.lane).toEqual([2, 4]);
    expect(s.split).toBe(1);
    expect(s.laneEpoch).toBeGreaterThan(lane);
    // A takes B's first token again: the lane shrinks to what is not shared.
    feed(s, cursor(5, 2, 4));
    expect(s.path).toEqual([0, 1, 2]);
    expect(s.lane).toEqual([4]);
    expect(s.split).toBe(2);
  });

  it('reads decisions from the model in front, else from the other', () => {
    const s = new Store();
    feed(s, ...split2());
    // Token 3 at index 3 of A's path: decision of node 2.
    expect(s.decisionNode(3)).toBe(2);
    expect(s.decision(3)!.slot).toBe(0);
    expect(s.decisionOf(3, 0)!.slot).toBe(0);
    expect(s.decisionOf(3, 1)!.slot).toBe(1);
    expect(s.probability(3)).toBe(0.5);
    expect(s.decision(1)).toBeUndefined(); // a prompt token
    expect(s.decisionOf(1, 1)).toBeUndefined();
    s.setFront(1);
    expect(s.decision(3)!.slot).toBe(1);
    expect(s.probability(3)).toBe(0.625); // token 4 in B's EVAL of node 2

    // A node only B evaluated: A in front falls back on B.
    s.setFront(0);
    feed(s, evalFrame(4, { node: 3, slot: 1, entries: [[5, 1]] }), node(4, 5, 3, 5, 4, ORIGIN_MODEL), cursor(4, 5, 4));
    expect(s.decisionOf(4, 0)).toBeUndefined();
    expect(s.decision(4)!.slot).toBe(1);
  });

  it('finds the comparisons and the disagreements of the viewed path', () => {
    const s = new Store();
    feed(s, ...prompt2());
    expect(s.firstDisagreement()).toBe(-1);
    // Lockstep: agree, disagree (same top, other pick), agree.
    feed(s,
      pair(2, { node: 1, flags: SAME }), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2, 2),
      pair(3, { node: 2, flags: PAIR_SAME_TOP }), node(3, 3, 2, 3, 3, ORIGIN_MODEL), cursor(3, 3, 3),
      pair(4, { node: 3, flags: SAME }), node(4, 4, 3, 4, 4, ORIGIN_MODEL), cursor(4, 4, 4),
    );
    expect(s.path).toEqual([0, 1, 2, 3, 4]);
    expect(s.pairAt(1)).toBeUndefined(); // a prompt token
    expect(s.pairAt(2)!.node).toBe(1);
    expect(s.pairAt(3)!.node).toBe(2);
    expect([0, 1, 2, 3, 4, 5, -1].map((i) => s.disagrees(i))).toEqual([false, false, false, true, false, false, false]);
    expect(s.firstDisagreement()).toBe(3);
    // A later disagreement does not move the first one.
    feed(s, pair(5, { node: 4, flags: 0 }), node(5, 5, 4, 5, 5, ORIGIN_MODEL), cursor(5, 5, 5));
    expect(s.disagrees(5)).toBe(true);
    expect(s.firstDisagreement()).toBe(3);
  });

  it('reads the decisions of the lane and why it stopped', () => {
    const s = new Store();
    feed(s, ...split2());
    // Lane token 0 (node 4) comes from B's EVAL of the split node 2.
    expect(s.laneDecision(0)!.node).toBe(2);
    expect(s.laneDecision(0)!.slot).toBe(1);
    expect(s.laneProbability(0)).toBe(0.625);
    expect(s.laneDecision(1)).toBeUndefined();
    expect(s.laneDecision(-1)).toBeUndefined();
    expect(s.laneProbability(1)).toBeUndefined();
    expect(s.stopAtLaneEnd()).toBeUndefined();

    // B goes on from node 4; A did not evaluate node 4.
    feed(s, evalFrame(4, { node: 4, slot: 1, entries: [[1, 0.875]] }), node(4, 5, 4, 1, 4, ORIGIN_MODEL), cursor(4, 3, 5));
    expect(s.lane).toEqual([4, 5]);
    expect(s.laneDecision(1)!.node).toBe(4);
    expect(s.laneProbability(1)).toBe(0.875);

    // A node of the lane only A evaluated: the lane falls back on A.
    feed(s, evalFrame(5, { node: 5, entries: [[6, 1]] }), node(5, 6, 5, 6, 5, ORIGIN_MODEL), cursor(5, 3, 6));
    expect(s.laneDecision(2)!.slot).toBe(0);

    feed(s, stop(6, 6, 1, 0));
    expect(s.stopAtLaneEnd()).toEqual({ slot: 1, reason: 0 });
    expect(s.stopAtEnd()).toBeUndefined();

    // B in front: the lane is A's and is read with A's EVALs.
    s.setFront(1);
    expect(s.path).toEqual([0, 1, 2, 4, 5, 6]);
    expect(s.lane).toEqual([3]);
    expect(s.laneDecision(0)!.slot).toBe(0);
    expect(s.laneProbability(0)).toBe(0.5);
    expect(s.stopAtEnd()).toEqual({ slot: 1, reason: 0 });
    expect(s.stopAtLaneEnd()).toBeUndefined();
  });

  it('reads the stop of a lane left behind on the path', () => {
    const s = new Store();
    feed(s, ...split2(), cursor(4, 3, 2), stop(4, 2, 1, 1));
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(2);
    expect(s.stopAtLaneEnd()).toEqual({ slot: 1, reason: 1 });
  });

  it('empties the two-model state on HELLO', () => {
    const s = new Store();
    feed(s, ...split2(), stop(4, 4, 1, 0));
    s.setFront(1);
    const lane = s.laneEpoch;
    feed(s, hello(0, 1, 2));
    expect(s.evals).toEqual([[], []]);
    expect(s.pairs).toEqual([]);
    expect(s.stops.size).toBe(0);
    expect(s.front).toBe(0);
    expect(s.lane).toEqual([]);
    expect(s.split).toBe(-1);
    expect(s.splits).toBe(0);
    expect(s.laneEpoch).toBeGreaterThan(lane);
    expect(s.firstDisagreement()).toBe(-1);
  });
});

// ------------------------------------------------------------ branches

// One model. After the prompt (0, 1), the tree:
//
//   0 ─ 1 ─┬─ 2 ─┬─ 3 ─ 4      ◄ cursor
//          │     └─ 5 ─ 6
//          └─ 7
function tree(): Uint8Array[] {
  return [
    ...prompt,
    node(2, 2, 1, 2, 2, ORIGIN_MODEL),
    node(2, 3, 2, 1, 3, ORIGIN_MODEL),
    node(2, 4, 3, 1, 4, ORIGIN_MODEL),
    node(3, 5, 2, 2, 3, ORIGIN_USER),
    node(3, 6, 5, 1, 4, ORIGIN_MODEL),
    node(4, 7, 1, 1, 2, ORIGIN_USER),
    cursor(4, 4),
  ];
}

describe('Store branches', () => {
  it('indexes the children of each node and empties them on reset', () => {
    const s = new Store();
    feed(s, ...tree());
    expect(s.children[0]).toEqual([1]);
    expect(s.children[1]).toEqual([2, 7]);
    expect(s.children[2]).toEqual([3, 5]);
    expect(s.children[4]).toBeUndefined();
    // A NODE seen again is not a second child.
    feed(s, node(5, 7, 1, 1, 2, ORIGIN_USER));
    expect(s.children[1]).toEqual([2, 7]);
    feed(s, hello(0));
    expect(s.children).toEqual([]);
  });

  it('views another path without sending anything or moving the cursors', () => {
    const s = new Store();
    feed(s, ...tree());
    expect(s.path).toEqual([0, 1, 2, 3, 4]);
    expect(s.follow).toBe(true);
    const epoch = s.pathEpoch;
    clearDirty(s);

    s.viewNode(6);
    expect(s.follow).toBe(false);
    expect(s.path).toEqual([0, 1, 2, 5, 6]);
    expect(s.pathEpoch).toBe(epoch + 1);
    expect(s.pathKept).toBe(3);
    expect(s.cursorA).toBe(4); // looking does not move
    expect(s.dirty).toEqual({ meta: true, stream: true, candidates: true, gates: true, timeline: true, relief: true, metrics: true, lens: true, compare: true });
    expect(s.viewEndsAtCursor()).toBe(false);

    // An unknown node changes nothing.
    s.viewNode(99);
    s.viewNode(NONE);
    expect(s.path).toEqual([0, 1, 2, 5, 6]);
  });

  it('keeps the chosen path while the cursor moves, and follows it again', () => {
    const s = new Store();
    feed(s, ...tree());
    s.viewNode(7);
    const epoch = s.pathEpoch;
    clearDirty(s);

    feed(s, node(5, 8, 4, 1, 5, ORIGIN_MODEL), cursor(5, 8));
    expect(s.path).toEqual([0, 1, 7]);
    expect(s.pathEpoch).toBe(epoch);
    expect(s.cursorA).toBe(8);
    expect(s.dirty.timeline).toBe(true); // the minimap moves its dot
    expect(s.dirty.stream).toBe(false);

    s.setFollow();
    expect(s.follow).toBe(true);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 8]);
    expect(s.pathEpoch).toBe(epoch + 1);
    expect(s.pathKept).toBe(2);
    expect(s.viewEndsAtCursor()).toBe(true);

    // Following already: nothing.
    clearDirty(s);
    s.setFollow();
    expect(s.pathEpoch).toBe(epoch + 1);
    expect(s.dirty.meta).toBe(false);
  });

  it('follows the cursor back as a replacement even when it is one token further', () => {
    const s = new Store();
    feed(s, ...tree());
    s.viewNode(3); // the cursor (4) is the child of the tip
    const epoch = s.pathEpoch;
    s.setFollow();
    expect(s.path).toEqual([0, 1, 2, 3, 4]);
    expect(s.pathEpoch).toBe(epoch + 1); // not growth: no token birth
    expect(s.pathKept).toBe(4);
  });

  it('waits for the next CURSOR after a branch or goto', () => {
    const s = new Store();
    feed(s, ...tree());
    s.viewNode(6);
    s.setFollow(true);
    expect(s.follow).toBe(true);
    expect(s.path).toEqual([0, 1, 2, 5, 6]); // still where the user looks
    // A cursor that is one token further is still a replacement.
    const epoch = s.pathEpoch;
    feed(s, node(5, 8, 6, 1, 5, ORIGIN_MODEL), cursor(5, 8));
    expect(s.path).toEqual([0, 1, 2, 5, 6, 8]);
    expect(s.pathEpoch).toBe(epoch + 1);
    expect(s.pathKept).toBe(5);
    // Then growth as usual.
    feed(s, node(6, 9, 8, 1, 6, ORIGIN_MODEL), cursor(6, 9));
    expect(s.pathEpoch).toBe(epoch + 1);

    // A refused command: follow the cursor where it is.
    s.viewNode(7);
    s.setFollow(true);
    expect(s.path).toEqual([0, 1, 7]);
    s.cancelAwait();
    expect(s.path).toEqual([0, 1, 2, 5, 6, 8, 9]);
    s.cancelAwait(); // not waiting: nothing
    expect(s.follow).toBe(true);
  });

  it('keeps pathKept at 0 after a reset', () => {
    const s = new Store();
    feed(s, ...tree());
    s.viewNode(6);
    expect(s.pathKept).toBe(3);
    feed(s, hello(0));
    expect(s.pathKept).toBe(0);
    expect(s.follow).toBe(true);
  });

  it('finds the tip of a branch: the cursor first, else the most recent child', () => {
    const s = new Store();
    feed(s, ...tree(), node(5, 8, 5, 2, 4, ORIGIN_USER));
    // Under 5 there are 6 and 8: no cursor there, so the higher id.
    expect(s.tipOf(5)).toBe(8);
    expect(s.tipOf(2)).toBe(4); // the cursor is down 3
    expect(s.tipOf(4)).toBe(4); // a leaf is its own tip
    expect(s.tipOf(99)).toBe(NONE);
    feed(s, cursor(6, 6));
    expect(s.tipOf(5)).toBe(6);
    expect(s.tipOf(2)).toBe(6);
  });

  it('lists the branches of the viewed path and where the cursor is', () => {
    const s = new Store();
    feed(s, ...tree());
    expect(s.branches()).toEqual([
      { fromIndex: 1, child: 7, tip: 7, tipDepth: 2 },
      { fromIndex: 2, child: 5, tip: 6, tipDepth: 4 },
    ]);
    expect(s.cursorMarks()).toEqual([{ slot: 0, depth: 4, branch: -1 }]);

    s.viewNode(6);
    const b = s.branches();
    expect(b).toEqual([
      { fromIndex: 1, child: 7, tip: 7, tipDepth: 2 },
      { fromIndex: 2, child: 3, tip: 4, tipDepth: 4 },
    ]);
    expect(s.cursorMarks(b)).toEqual([{ slot: 0, depth: 4, branch: 1 }]);
  });

  it('has no lane while a path is chosen by hand', () => {
    const s = new Store();
    feed(s, ...split2());
    expect([s.lane, s.split]).toEqual([[4], 2]);
    const lane = s.laneEpoch;
    s.viewNode(4);
    expect(s.path).toEqual([0, 1, 2, 4]);
    expect([s.lane, s.split]).toEqual([[], -1]);
    expect(s.laneEpoch).toBeGreaterThan(lane);

    // The cursors keep moving; the view and the (absent) lane stay.
    feed(s, node(4, 5, 3, 5, 4, ORIGIN_MODEL), cursor(4, 5, 4));
    expect(s.path).toEqual([0, 1, 2, 4]);
    expect([s.lane, s.split]).toEqual([[], -1]);
    // B in front does not move the chosen path either.
    s.setFront(1);
    expect(s.path).toEqual([0, 1, 2, 4]);
    expect(s.viewEndsAtCursor()).toBe(true); // B's cursor is at its tip

    // Both cursors on the minimap: B at the tip, A on the branch from 2.
    const b = s.branches();
    expect(b).toEqual([{ fromIndex: 2, child: 3, tip: 5, tipDepth: 4 }]);
    expect(s.cursorMarks(b)).toEqual([
      { slot: 0, depth: 4, branch: 0 },
      { slot: 1, depth: 3, branch: -1 },
    ]);

    // Following again brings the lane back.
    s.setFront(0);
    s.setFollow();
    expect(s.path).toEqual([0, 1, 2, 3, 5]);
    expect([s.lane, s.split]).toEqual([[4], 2]);
  });
});
