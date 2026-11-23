import { describe, expect, it } from 'vitest';
import type { TokenGroup } from '../store/text';
import { cutPoint, placeCard, regroupFrom, segments, topEntries } from './stream';

const g = (start: number, end: number, text = 'x'): TokenGroup => ({ start, end, text });

describe('segments', () => {
  it('keeps a single range without a split', () => {
    expect(segments(0, 5, -1)).toEqual([[0, 5]]);
  });

  it('cuts the range after the split', () => {
    expect(segments(0, 5, 2)).toEqual([
      [0, 3],
      [3, 5],
    ]);
  });

  it('does not cut when the split is outside the range', () => {
    expect(segments(4, 6, 2)).toEqual([[4, 6]]); // all after the split
    expect(segments(4, 6, 3)).toEqual([[4, 6]]); // the split is the token before
    expect(segments(0, 3, 2)).toEqual([[0, 3]]); // all up to the split
  });

  it('is empty for an empty range', () => {
    expect(segments(3, 3, 1)).toEqual([]);
  });

  it('also cuts at the end of the prompt', () => {
    expect(segments(0, 5, -1, 2)).toEqual([
      [0, 2],
      [2, 5],
    ]);
    expect(segments(0, 6, 3, 2)).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
    expect(segments(2, 5, -1, 2)).toEqual([[2, 5]]); // all generated
    expect(segments(0, 2, -1, 2)).toEqual([[0, 2]]); // all prompt
  });
});

describe('regroupFrom', () => {
  const groups = [g(0, 1), g(1, 3), g(3, 4), g(4, 5)];

  it('needs nothing when the groups respect the new split', () => {
    expect(regroupFrom(groups, -1, 2)).toBe(-1);
    expect(regroupFrom(groups, 2, -1)).toBe(-1); // complete groups stay
    expect(regroupFrom([], -1, 4)).toBe(-1);
  });

  it('redoes a group that crosses the new split', () => {
    expect(regroupFrom(groups, -1, 1)).toBe(1);
  });

  it('redoes an incomplete group the old split cut short', () => {
    const cut = [g(0, 1), g(1, 3, 'a�'), g(3, 4, '�')];
    expect(regroupFrom(cut, 2, -1)).toBe(1);
    expect(regroupFrom(cut, 2, 2)).toBe(-1); // the split did not move
  });

  it('returns the earliest group to redo', () => {
    const cut = [g(0, 2, '�'), g(2, 5)];
    expect(regroupFrom(cut, 1, 3)).toBe(0);
  });
});

describe('cutPoint', () => {
  const groups = [g(0, 1), g(1, 3), g(3, 4), g(4, 5)];

  it('keeps whole groups before the kept length', () => {
    expect(cutPoint(groups, 3)).toBe(3);
    expect(cutPoint(groups, 1)).toBe(1);
  });

  it('redoes a group that mixes kept and new tokens', () => {
    expect(cutPoint(groups, 2)).toBe(1);
    expect(cutPoint(groups, 0)).toBe(0);
  });

  it('redoes an incomplete group that ends at the cut', () => {
    expect(cutPoint([g(0, 1), g(1, 3, 'a�')], 3)).toBe(1);
  });

  it('keeps everything when the cut is past the groups drawn', () => {
    expect(cutPoint(groups, 5)).toBe(5);
    expect(cutPoint(groups, 9)).toBe(9);
    expect(cutPoint([], 4)).toBe(4);
  });
});

describe('topEntries', () => {
  it('returns the largest first, at most k', () => {
    const out: number[] = [];
    expect(topEntries([0.1, 0.5, 0.05, 0.3], 4, 3, out)).toBe(3);
    expect(out).toEqual([1, 3, 0]);
  });

  it('keeps fewer when there are fewer entries', () => {
    const out = [9, 9, 9, 9];
    expect(topEntries([0.2, 0.7], 2, 3, out)).toBe(2);
    expect(out).toEqual([1, 0]);
  });

  it('looks only at the first n values', () => {
    const out: number[] = [];
    topEntries([0.1, 0.2, 0.9], 2, 3, out);
    expect(out).toEqual([1, 0]);
  });
});

describe('placeCard', () => {
  const token = { left: 100, top: 200, bottom: 220 };

  it('goes under the token', () => {
    expect(placeCard(token, 240, 120, 1600, 1000)).toEqual({ x: 88, y: 228 });
  });

  it('goes over the token when there is no room below', () => {
    const low = { left: 100, top: 900, bottom: 920 };
    expect(placeCard(low, 240, 120, 1600, 1000).y).toBe(900 - 8 - 120);
  });

  it('never leaves the viewport', () => {
    const right = { left: 1550, top: 10, bottom: 30 };
    const p = placeCard(right, 240, 120, 1600, 1000);
    expect(p.x).toBe(1600 - 240 - 8);
    expect(placeCard({ left: 0, top: 10, bottom: 30 }, 240, 120, 1600, 1000).x).toBe(8);
  });
});
