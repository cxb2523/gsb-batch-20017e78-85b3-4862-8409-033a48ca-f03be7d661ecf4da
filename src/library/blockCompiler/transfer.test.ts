import { TStateSlot } from "../blockCompiler";
import { describe, expect, it, vi } from "vitest";
import { isStateNode, restoreNodes, snapshotNodes } from "./transfer";

// Состояние ноды — как у процессора: имя ключа → значение
const stateful = (state: Record<string, unknown>) => ({
  state,
  readWorkletState: vi.fn(async () => ({ ...state })),
  writeWorkletState: vi.fn((next: Record<string, unknown>) => {
    for (const key of Object.keys(next))
      if (Object.hasOwn(state, key))
        state[key] = next[key];
  }),
});

const stateOf = (node: ReturnType<typeof stateful>) => node.state as Record<string, unknown>;

const slots: TStateSlot[] = [
  // Нода 0 — Expression: y1
  { node: 0, name: 'y1', key: 'n:expr:y1', kind: 'number' },
  // Нода 1 — петля: живого соответствия нет, она остаётся только в процессоре
  { node: 1, name: 'delayed', key: 'd:mem', kind: 'number' },
  // Нода 2 — Counter: count и trigger
  { node: 2, name: 'count', key: 'n:counter:count', kind: 'number' },
  { node: 2, name: 'trigger', key: 'n:counter:trigger', kind: 'number' },
];

describe('node state transfer', () => {
  it('recognises nodes that can read and write state', () => {
    expect(isStateNode(stateful({}))).toBe(true);
    expect(isStateNode({})).toBe(false);
    expect(isStateNode(null)).toBe(false);
    expect(isStateNode({ readWorkletState() { } })).toBe(false);
  });

  it('builds a processor seed from live node state, keyed like the compiler', async () => {
    const expression = stateful({ y1: 7 });
    const counter = stateful({ count: 3, trigger: 1 });

    const seed = await snapshotNodes(slots, [expression, {}, counter]);

    expect(seed).toEqual({
      'n:expr:y1': 7,
      'n:counter:count': 3,
      'n:counter:trigger': 1,
    });
    // Значение петли живых нод не касается
    expect(seed).not.toHaveProperty('d:mem');
  });

  it('skips nodes that are not ready and nodes without the field', async () => {
    const pending = {
      readWorkletState: async () => null,
      writeWorkletState() { },
    };
    const counter = stateful({ count: 3 });

    const seed = await snapshotNodes(slots, [pending, {}, counter]);

    expect(seed).toEqual({ 'n:counter:count': 3 });
  });

  it('restores each node with only its own keys', () => {
    const expression = stateful({ y1: 0 });
    const counter = stateful({ count: 0, trigger: 0 });

    restoreNodes(slots, [expression, {}, counter], {
      'n:expr:y1': 5,
      'n:counter:count': 9,
      'n:counter:trigger': 1,
      'd:mem': 42,
    });

    expect(expression.writeWorkletState).toHaveBeenCalledWith({ y1: 5 });
    expect(counter.writeWorkletState).toHaveBeenCalledWith({ count: 9, trigger: 1 });
  });

  it('does not touch nodes whose keys are absent', () => {
    const expression = stateful({ y1: 0 });
    const counter = stateful({ count: 0, trigger: 0 });

    restoreNodes(slots, [expression, {}, counter], { 'n:counter:trigger': 1 });

    expect(expression.writeWorkletState).not.toHaveBeenCalled();
    expect(counter.writeWorkletState).toHaveBeenCalledWith({ trigger: 1 });
  });

  it('ignores a broken payload', () => {
    const expression = stateful({ y1: 0 });

    expect(() => restoreNodes(slots, [expression], null as unknown as Record<string, unknown>)).not.toThrow();
    expect(expression.writeWorkletState).not.toHaveBeenCalled();
  });

  it('round-trips through a snapshot without losing values', async () => {
    const nodes = [stateful({ y1: 1.5 }), {}, stateful({ count: 4, trigger: 0 })];
    const seed = await snapshotNodes(slots, nodes);

    const next = [stateful({ y1: 0 }), {}, stateful({ count: 0, trigger: 0 })];
    restoreNodes(slots, next, seed);

    expect(stateOf(next[0] as ReturnType<typeof stateful>)).toEqual({ y1: 1.5 });
    expect(stateOf(next[2] as ReturnType<typeof stateful>)).toEqual({ count: 4, trigger: 0 });
  });});
