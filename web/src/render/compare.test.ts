import { describe, expect, it } from 'vitest';
import { FRAME_PAIR, NONE, PAIR_APPROX, PAIR_SAME_PICK, PAIR_SAME_TOP, type PairFrame } from '../source/frames';
import {
  KL_MAX,
  KL_MIN,
  bitsText,
  butterflyRows,
  klScale,
  overlap,
  pickRank,
  rankIn,
  rankWords,
  effText,
  lowestMain,
  markWidth,
  modelCells,
  modelFigures,
  pairChips,
  pairFigures,
  pctBelow,
  pctShort,
  probOf,
  rankText,
  timelineBands,
  traceBox,
} from './compare';

function pair(over: Partial<PairFrame> = {}): PairFrame {
  return {
    type: FRAME_PAIR,
    t: 0,
    node: 3,
    js: 0.031,
    klAB: 0.12,
    klBA: 0.1,
    rankAInB: 1,
    rankBInA: 0,
    flags: 0,
    ...over,
  };
}

describe('percentages', () => {
  it('fit in five characters', () => {
    for (const p of [0, 1e-5, 0.0005, 0.001, 0.0412, 0.0996, 0.1, 0.412, 0.9996, 1]) {
      expect(pctShort(p).length).toBeLessThanOrEqual(5);
      expect(pctBelow(p).length).toBeLessThanOrEqual(5);
    }
  });
  it('round as expected', () => {
    expect(pctShort(0)).toBe('0%');
    expect(pctShort(0.0004)).toBe('<0.1%');
    expect(pctShort(0.0412)).toBe('4.1%');
    expect(pctShort(0.412)).toBe('41%');
    expect(pctShort(1)).toBe('100%');
    expect(pctBelow(0.0412)).toBe('<4.1%');
    expect(pctBelow(0.0004)).toBe('<0.1%');
  });
});

describe('bitsText', () => {
  it('formats small and large values', () => {
    expect(bitsText(0.0312)).toBe('0.031');
    expect(bitsText(3.456)).toBe('3.46');
    expect(bitsText(12.34)).toBe('12.3');
  });
  it('handles infinity, NaN and rounding noise', () => {
    expect(bitsText(Infinity)).toBe('∞');
    expect(bitsText(NaN)).toBe('?');
    expect(bitsText(-1e-9)).toBe('0.000');
  });
});

describe('model figures', () => {
  it('shows entropy, effective candidates and the chosen probability', () => {
    const f = modelFigures({ entropy: 1, pRaw: new Float32Array([0.5, 0.25]), pick: 0 });
    expect(f).toBe('H 1.00 bits · eff 2.00 · chosen 50%');
  });
  it('formats the effective number by size', () => {
    expect(effText(Math.log2(42))).toBe('42.0');
    expect(effText(17)).toBe('131072');
  });
});

describe('pairFigures', () => {
  it('counts ranks from 1 and marks a different top', () => {
    const [l1, l2] = pairFigures(pair());
    expect(l1).toBe('JS 0.031 · KL A‖B 0.120 · B‖A 0.100');
    expect(l2).toBe('top differs · rank A→B #2 · B→A #1');
  });
  it('shows a shared top, unknown ranks and infinite KL', () => {
    const [l1, l2] = pairFigures(pair({ klAB: Infinity, rankAInB: NONE, flags: PAIR_SAME_TOP | PAIR_SAME_PICK }));
    expect(l1).toContain('KL A‖B ∞');
    expect(l2).toBe('top same · rank A→B ? · B→A #1');
    expect(rankText(NONE)).toBe('?');
  });
  it('marks approximate values', () => {
    const [l1, l2] = pairFigures(pair({ flags: PAIR_APPROX, rankAInB: NONE }));
    expect(l1).toBe('JS ≈0.031 · KL A‖B ≈0.120 · B‖A ≈0.100');
    expect(l2).toBe('top differs · rank A→B ? · B→A ≈#1');
  });
});

describe('a row seen by the other model', () => {
  const tokens = new Uint32Array([10, 11, 12, 99]);
  const pRaw = new Float32Array([0.5, 0.3, 0.1, 0.01]); // 99 is an extra entry
  it('finds a listed token', () => {
    expect(probOf(tokens, pRaw, 11)).toBeCloseTo(0.3);
    expect(probOf(tokens, pRaw, 7)).toBe(-1);
  });
  it('bounds a missing token by the lowest main entry, not by the extras', () => {
    expect(lowestMain(pRaw, 3)).toBeCloseTo(0.1);
    expect(lowestMain(pRaw, 0)).toBe(0);
    expect(lowestMain(pRaw, 9)).toBeCloseTo(0.01);
  });
});

describe('timelineBands', () => {
  for (const h of [60, 150, 190, 400]) {
    it(`stacks the bands in order at ${h} px`, () => {
      const b = timelineBands(h, 26, 10);
      expect(b.aTop).toBe(26);
      expect(b.bBottom).toBe(Math.max(26, h - 10));
      const ys = [b.aTop, b.aBase, b.dTop, b.dBase, b.markY, b.bBase, b.bBottom];
      for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
      // Both entropy bands have the same height: a mirror.
      expect(b.aBase - b.aTop).toBe(b.bBottom - b.bBase);
    });
  }
  it('gives every band room at 190 px', () => {
    const b = timelineBands(190, 26, 10);
    expect(b.aBase - b.aTop).toBeGreaterThanOrEqual(50);
    expect(b.dBase - b.dTop).toBeGreaterThanOrEqual(16);
    expect(b.bBase - b.dBase).toBeGreaterThanOrEqual(10);
  });
});

describe('markWidth', () => {
  it('stays between 5 and 8 px', () => {
    expect(markWidth(0.5)).toBe(5);
    expect(markWidth(7)).toBe(6);
    expect(markWidth(40)).toBe(8);
  });
});

describe('modelCells', () => {
  it('gives the picked probability, the entropy and the options', () => {
    const c = modelCells({ entropy: 1, pRaw: new Float32Array([0.5, 0.25]), pick: 1 });
    expect(c).toEqual({ prob: '25%', entropy: '1.00 bits', options: '2.00' });
  });
});

describe('pairChips', () => {
  it('labels divergence, KL and ranks in words', () => {
    const c = pairChips(pair());
    expect(c.divergence).toBe('0.031 bit');
    expect(c.kl).toBe('0.120 · 0.100');
    expect(c.ranks).toBe("A's top token: #2 for B · B's top: #1 for A");
  });
  it('says when both put the same token first, and marks approximations', () => {
    expect(pairChips(pair({ flags: PAIR_SAME_TOP })).ranks).toBe('Both put the same token first');
    const c = pairChips(pair({ flags: PAIR_APPROX, rankAInB: NONE }));
    expect(c.divergence).toBe('≈0.031 bit');
    expect(c.ranks).toBe("A's top token: not in B's list · B's top: ≈#1 for A");
  });
});

describe('traceBox', () => {
  it('fills the room when it is small', () => {
    expect(traceBox(170, 28, 44, 300)).toEqual({ top: 28, bottom: 126 });
  });
  it('caps the height and centres the box when the room is tall', () => {
    const b = traceBox(700, 28, 44, 300);
    expect(b.bottom - b.top).toBe(300);
    expect(b.top - 28).toBe(700 - 44 - b.bottom);
  });
  it('never inverts', () => {
    expect(traceBox(10, 28, 44, 300)).toEqual({ top: 28, bottom: 28 });
  });
});

function dist(tokens: number[], p: number[], nRaw = tokens.length, pick = 0) {
  return { tokens: new Uint32Array(tokens), pRaw: new Float32Array(p), nRaw, pick };
}

describe('overlap', () => {
  it('counts shared tokens over the union and the common mass', () => {
    const a = dist([1, 2, 3], [0.5, 0.3, 0.2]);
    const b = dist([2, 1, 4], [0.6, 0.1, 0.3]);
    const o = overlap(a, b);
    expect(o.shared).toBe(2);
    expect(o.union).toBe(4);
    expect(o.jaccard).toBeCloseTo(0.5);
    expect(o.commonMass).toBeCloseTo(0.1 + 0.3); // min on 1 and on 2
  });
  it('ignores the extra entries', () => {
    const a = dist([1, 2, 9], [0.6, 0.3, 0.01], 2);
    const b = dist([9, 3], [0.7, 0.2], 2);
    // 9 is only an extra entry of A: not part of its top list.
    expect(overlap(a, b)).toEqual({ shared: 0, union: 4, jaccard: 0, commonMass: 0 });
    const c = dist([2, 3], [0.7, 0.2]);
    expect(overlap(a, c)).toEqual({ shared: 1, union: 3, jaccard: 1 / 3, commonMass: expect.closeTo(0.3) });
  });
  it('is 1 for the same list and 0 for empty ones', () => {
    const a = dist([1, 2], [0.7, 0.3]);
    expect(overlap(a, a)).toEqual({ shared: 2, union: 2, jaccard: 1, commonMass: expect.closeTo(1) });
    expect(overlap(dist([], []), dist([], [])).jaccard).toBe(0);
  });
});

describe('butterflyRows', () => {
  it('takes the union, ordered by the larger probability, with gaps', () => {
    const a = dist([1, 2, 3], [0.5, 0.3, 0.2]);
    const b = dist([4, 1, 2], [0.6, 0.25, 0.15]);
    expect(butterflyRows(a, b)).toEqual([
      { token: 4, pA: -1, pB: expect.closeTo(0.6) },
      { token: 1, pA: expect.closeTo(0.5), pB: expect.closeTo(0.25) },
      { token: 2, pA: expect.closeTo(0.3), pB: expect.closeTo(0.15) },
      { token: 3, pA: expect.closeTo(0.2), pB: -1 },
    ]);
  });
  it('includes extra entries and breaks ties by token', () => {
    const a = dist([7, 5], [0.5, 0.5], 1);
    expect(butterflyRows(a, undefined).map((r) => r.token)).toEqual([5, 7]);
  });
  it('leaves the side of a missing model empty', () => {
    const rows = butterflyRows(undefined, dist([3], [1]));
    expect(rows).toEqual([{ token: 3, pA: -1, pB: 1 }]);
    expect(butterflyRows(undefined, undefined)).toEqual([]);
  });
});

describe('cross ranks', () => {
  const b = dist([10, 11, 12, 99], [0.5, 0.3, 0.1, 0.01], 3);
  it('ranks a token among the main entries by probability', () => {
    expect(rankIn(b, 10)).toBe(0);
    expect(rankIn(b, 12)).toBe(2);
    expect(rankIn(dist([12, 10], [0.1, 0.5]), 12)).toBe(1); // order of the list does not matter
  });
  it('does not know the rank of an extra entry or a missing token', () => {
    expect(rankIn(b, 99)).toBe(NONE);
    expect(rankIn(b, 5)).toBe(NONE);
  });
  it('falls back to the PAIR only when the pick is the top', () => {
    const top = dist([5, 6], [0.6, 0.4], 2, 0);
    expect(pickRank(top, b, 40)).toBe(40);
    expect(pickRank(top, b, undefined)).toBe(NONE);
    expect(pickRank(dist([5, 11], [0.6, 0.4], 2, 1), b, 40)).toBe(1);
    expect(pickRank(dist([5, 6], [0.6, 0.4], 2, 1), b, 40)).toBe(NONE);
  });
  it('says the rank in words, counted from 1, or that it is unknown', () => {
    const w = rankWords(1, 'A', 'B', 32);
    expect(w.pre + w.fig + w.post).toBe('A’s pick is #2 for B');
    const u = rankWords(NONE, 'B', 'A', 32);
    expect(u.fig).toBe('');
    expect(u.post).toBe('not in A’s top 32');
  });
});

describe('klScale', () => {
  it('spans 0..1 on a log scale', () => {
    expect(klScale(KL_MIN)).toBe(0);
    expect(klScale(KL_MAX)).toBeCloseTo(1);
    expect(klScale(0.1)).toBeCloseTo(0.5);
    expect(klScale(0.01)).toBeLessThan(klScale(0.02));
  });
  it('fills the bar with infinity and stays empty with nothing to show', () => {
    expect(klScale(Infinity)).toBe(1);
    expect(klScale(1e6)).toBe(1);
    expect(klScale(0)).toBe(0);
    expect(klScale(-1)).toBe(0);
    expect(klScale(NaN)).toBe(0);
  });
});
