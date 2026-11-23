// The Stream's columns read from the golden sessions (sessions/golden):
// pair.ils (lockstep, free with a split, lockstep driven by B) and
// branches.ils (free mode, a branch by hand and a goto).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FRAME_CONFIG, FRAME_CURSOR, type Frame } from '../source/frames';
import { decodeSession } from '../source/recorded';
import { countDiffers, otherColumn, pathProbability, pathSlotOf, roleText, showsSplit } from './columns';
import { Store } from './store';

// Token ids of engine/tests/test_golden.cpp.
const T_EOS = 1, T_CAT = 3, T_SAT = 4, T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11;

let pair: Frame[];
let branches: Frame[];

async function load(name: string): Promise<Frame[]> {
  const file = readFileSync(resolve(import.meta.dirname, `../../../sessions/golden/${name}`));
  return decodeSession(new Uint8Array(file));
}

beforeAll(async () => {
  pair = await load('pair.ils');
  branches = await load('branches.ils');
});

// The store after applying frames up to and including the first one that
// matches `last`, or all of them.
function storeAt(frames: Frame[], last?: (f: Frame) => boolean): Store {
  const s = new Store();
  for (const f of frames) {
    s.apply(f);
    if (last?.(f)) break;
  }
  return s;
}

const cursorAt = (t: number) => (f: Frame) => f.type === FRAME_CURSOR && f.t === t;

// [token, p, pos, differs, split] of each item, for compact expectations.
function brief(s: Store): [number, number, number, boolean, boolean][] {
  const path = pathSlotOf(s);
  return otherColumn(s, path === 0 ? 1 : 0, path).map((t) => [t.token, t.p, t.pos, t.differs, t.split]);
}

describe('pathSlotOf', () => {
  it('is A with a single model', () => {
    const s = new Store();
    expect(pathSlotOf(s)).toBe(0);
  });

  it('is the driver in lockstep and the model in front in free mode', () => {
    const lock = storeAt(pair, cursorAt(300));
    expect(lock.config!.mode).toBe('lockstep');
    expect(pathSlotOf(lock)).toBe(0);
    lock.setFront(1); // looking at B does not change who writes
    expect(pathSlotOf(lock)).toBe(0);

    const free = storeAt(pair, cursorAt(600));
    expect(free.config!.mode).toBe('free');
    expect(pathSlotOf(free)).toBe(0);
    free.setFront(1);
    expect(pathSlotOf(free)).toBe(1);

    const byB = storeAt(pair);
    expect(byB.config).toMatchObject({ mode: 'lockstep', driver: 'B' });
    expect(pathSlotOf(byB)).toBe(1);
  });

  it('is the model in front while a lockstep CONFIG waits for its CURSOR', () => {
    // CONFIG lockstep by B at t=800, before the CURSOR that joins the cursors.
    const s = storeAt(pair, (f) => f.type === FRAME_CONFIG && f.t === 800);
    expect(s.split).toBeGreaterThanOrEqual(0);
    expect(pathSlotOf(s)).toBe(s.front);
  });
});

describe('otherColumn with pair.ils', () => {
  it('in lockstep: B pick at each position of A text, the disagreement marked', () => {
    const s = storeAt(pair, cursorAt(300));
    expect(s.path).toEqual([0, 1, 2, 3]);
    expect(s.promptLength).toBe(2);
    expect(brief(s)).toEqual([
      [T_CAT, 0.5, 2, false, false],
      [T_ON, 0.5, 3, true, false], // A wrote " sat"
    ]);
    const items = otherColumn(s, 1, 0);
    expect(items[0].js).toBe(-1);
    expect(items[1].js).toBe(0.25);
    expect(countDiffers(items)).toBe(1);
  });

  it('is empty with only the prompt', () => {
    const s = storeAt(pair, cursorAt(100));
    expect(s.path).toEqual([0, 1]);
    expect(brief(s)).toEqual([]);
  });

  it('at the split: the common stretch, then B lane', () => {
    const s = storeAt(pair, cursorAt(500));
    expect(s.split).toBe(4);
    expect(showsSplit(s)).toBe(true);
    expect(brief(s)).toEqual([
      [T_CAT, 0.5, 2, false, false],
      [T_ON, 0.5, 3, true, false],
      [T_ON, 0.75, 4, false, false],
      [T_DOG, 0.5, -1, false, true], // lane[0]: B's child of path[split]
    ]);
  });

  it('after the split: the lane grows, only its first token marks the split', () => {
    const s = storeAt(pair, cursorAt(700));
    expect(s.lane).toEqual([6, 8]);
    const items = brief(s);
    expect(items.slice(3)).toEqual([
      [T_DOG, 0.5, -1, false, true],
      [T_EOS, 0.5, -1, false, false],
    ]);
  });

  it('with B in front after the split: A is the other column, its lane the path it left', () => {
    const s = storeAt(pair, cursorAt(700));
    s.setFront(1);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 6, 8]);
    expect(s.lane).toEqual([5, 7, 9]);
    expect(pathSlotOf(s)).toBe(1);
    expect(brief(s)).toEqual([
      [T_CAT, 0.5, 2, false, false],
      [T_SAT, 0.5, 3, false, false], // A's own pick, written in lockstep by A
      [T_ON, 0.5, 4, false, false],
      [T_MAT, 0.5, -1, false, true],
      [T_DOT, 0.75, -1, false, false],
      [T_EOS, 0.875, -1, false, false],
    ]);
  });

  it('lockstep driven by B: A picks on B text; positions A did not evaluate are left out', () => {
    const s = storeAt(pair);
    expect(s.path).toEqual([0, 1, 2, 3, 4, 6, 8]);
    expect(s.split).toBe(-1);
    expect(showsSplit(s)).toBe(false);
    const items = otherColumn(s, 0, 1);
    expect(items.map((t) => [t.token, t.pos, t.differs])).toEqual([
      [T_CAT, 2, false],
      [T_SAT, 3, false],
      [T_ON, 4, false],
      [T_MAT, 5, true], // B wrote " dog"
    ]);
    expect(items[3].js).toBe(0.5);
  });
});

describe('otherColumn with branches.ils', () => {
  it('after the branch: the split right after the first generated token', () => {
    const s = storeAt(branches, (f) => f.type === FRAME_CURSOR && s0(f, 7, 6));
    expect(s.path).toEqual([0, 1, 2, 3, 7]);
    expect(s.split).toBe(2);
    expect(s.lane).toEqual([4, 6]);
    expect(brief(s)).toEqual([
      [T_CAT, 0.5, 2, false, false],
      [T_ON, 0.5, -1, false, true],
      [T_DOT, 0.5, -1, false, false],
    ]);
  });

  it('at the end: B evaluated node 3 after the goto', () => {
    const s = storeAt(branches);
    expect(s.path).toEqual([0, 1, 2, 3, 7, 8, 10]);
    expect(s.split).toBe(3);
    expect(s.lane).toEqual([11]);
    const items = otherColumn(s, 1, 0);
    expect(items.map((t) => [t.token, t.pos, t.differs, t.split])).toEqual([
      [T_CAT, 2, false, false],
      [T_ON, 3, true, false], // A wrote " sat"
      [T_DOG, -1, false, true],
    ]);
    expect(items[1].js).toBe(s.pairAt(3)!.js);
    expect(items[2].p).toBe(0.5);
  });

  it('without a split when the path is chosen by hand', () => {
    const s = storeAt(branches);
    s.viewNode(10);
    expect(s.follow).toBe(false);
    expect(s.split).toBe(-1);
    // Positions 2..6; B evaluated only nodes 1, 2 and 3 of this path.
    expect(otherColumn(s, 1, 0).map((t) => [t.token, t.pos, t.differs])).toEqual([
      [T_CAT, 2, false],
      [T_ON, 3, true],
      [T_DOG, 4, true], // A's branch wrote " mat"
    ]);
  });
});

describe('pathProbability and roleText', () => {
  it('reads the path column model first', () => {
    const s = storeAt(pair, cursorAt(300));
    expect(pathProbability(s, 3, 0)).toBe(0.5); // A: " sat" 0.5
    expect(pathProbability(s, 3, 1)).toBe(0.25); // B: " sat" 0.25
    expect(pathProbability(s, 1, 0)).toBeUndefined(); // a prompt token
  });

  it('says what each column is', () => {
    const lock = storeAt(pair, cursorAt(300));
    expect(roleText(lock, 0, 0)).toBe('writes the text (driver)');
    expect(roleText(lock, 1, 0)).toBe('what B would pick at each step');
    const free = storeAt(pair, cursorAt(600));
    expect(roleText(free, 0, 0)).toBe('its own text');
    expect(roleText(free, 1, 0)).toBe('its own text');
  });
});

function s0(f: Frame, a: number, b: number): boolean {
  return f.type === FRAME_CURSOR && f.nodeA === a && f.nodeB === b;
}
