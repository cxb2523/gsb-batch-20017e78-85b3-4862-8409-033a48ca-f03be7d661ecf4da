import { describe, expect, it } from 'vitest';
import {
  compactCount,
  crosses,
  hasStage,
  cutAt,
  cutBy,
  cutList,
  gateLabel,
  gateShortLabel,
  restAt,
  segmentOf,
  stagePosition,
  stageRest,
  stageValue,
  valueAt,
  type StageSource,
} from './stages';

// The first decision of sessions/golden/gates.ils: grammar, top_k 2, temp 0.5.
// Entries ".", "é"(1), " cat", "é"(2), " dog" (added).
const golden: StageSource = {
  nGates: 3,
  rawMass: 0.78125,
  pRaw: new Float32Array([0.5, 0.125, 0.09375, 0.0625, 0.03125]),
  stageP: new Float32Array([
    0, 0, 0.375, 0, 0.125, // grammar
    0, 0, 0.75, 0, 0.25, // top_k 2
    0, 0, 0.9, 0, 0.1, // temp 0.5
  ]),
};

const none: StageSource = {
  nGates: 0,
  rawMass: 0.9,
  pRaw: new Float32Array([0.6, 0.3]),
  stageP: new Float32Array(0),
};

describe('stageValue', () => {
  it('reads p_raw at raw and stage_p after each gate', () => {
    expect(stageValue(golden, -1, 0)).toBe(0.5);
    expect(stageValue(golden, 0, 0)).toBe(0);
    expect(stageValue(golden, 0, 2)).toBe(0.375);
    expect(stageValue(golden, 1, 4)).toBe(0.25);
    expect(stageValue(golden, 2, 2)).toBeCloseTo(0.9);
  });

  it('reads the last row past the last gate, and raw without gates', () => {
    expect(stageValue(golden, 7, 2)).toBeCloseTo(0.9);
    expect(stageValue(none, 0, 1)).toBeCloseTo(0.3);
  });
});

describe('stagePosition', () => {
  it('maps a selected gate to its position, and a missing one to raw', () => {
    expect(stagePosition(golden, -1)).toBe(0);
    expect(stagePosition(golden, 0)).toBe(1);
    expect(stagePosition(golden, 2)).toBe(3);
    expect(stagePosition(golden, 3)).toBe(0);
    expect(stagePosition(none, 0)).toBe(0);
  });
});

describe('valueAt', () => {
  it('matches the stages at whole positions', () => {
    for (let i = 0; i < 5; i++) {
      expect(valueAt(golden, 0, i)).toBe(stageValue(golden, -1, i));
      for (let g = 0; g < 3; g++) expect(valueAt(golden, g + 1, i)).toBeCloseTo(stageValue(golden, g, i));
    }
  });

  it('cuts at once on entering a gate and moves the survivors linearly', () => {
    expect(valueAt(golden, 0.01, 0)).toBe(0); // "." cut by the grammar
    expect(valueAt(golden, 0.5, 2)).toBeCloseTo((0.09375 + 0.375) / 2);
    expect(valueAt(golden, 2.5, 2)).toBeCloseTo((0.75 + 0.9) / 2); // temp sharpens
    expect(valueAt(golden, 2.5, 4)).toBeCloseTo((0.25 + 0.1) / 2);
  });

  it('stays at the last stage past the end and at raw before the start', () => {
    expect(valueAt(golden, 9, 2)).toBeCloseTo(0.9);
    expect(valueAt(golden, -1, 0)).toBe(0.5);
    expect(valueAt(none, 1, 0)).toBeCloseTo(0.6);
  });
});

describe('cuts', () => {
  it('knows which entries each gate cuts', () => {
    expect(cutList(golden, 0)).toEqual([0, 1, 3]);
    expect(cutList(golden, 1)).toEqual([]);
    expect(cutList(golden, 2)).toEqual([]);
    expect(cutBy(golden, 0, 2)).toBe(false);
    expect(cutBy(golden, -1, 0)).toBe(false);
    expect(cutBy(golden, 3, 0)).toBe(false);
  });

  it('cuts at a gate an entry that the previous one kept', () => {
    const e: StageSource = {
      nGates: 2,
      rawMass: 1,
      pRaw: new Float32Array([0.5, 0.3, 0.2]),
      stageP: new Float32Array([0.5, 0.3, 0.2, 0.625, 0.375, 0]),
    };
    expect(cutList(e, 0)).toEqual([]);
    expect(cutList(e, 1)).toEqual([2]);
    expect(cutAt(e, 1, 2)).toBe(false);
    expect(cutAt(e, 1.01, 2)).toBe(true);
    expect(cutAt(e, 0, 2)).toBe(false);
  });

  it('marks as cut every entry that no longer survives at a position', () => {
    expect(cutAt(golden, 0, 0)).toBe(false);
    expect(cutAt(golden, 0.2, 0)).toBe(true);
    expect(cutAt(golden, 3, 1)).toBe(true);
    expect(cutAt(golden, 3, 4)).toBe(false);
  });
});

describe('rest', () => {
  it('is 1 − raw_mass at raw and what the survivors leave after a gate', () => {
    expect(stageRest(golden, -1)).toBeCloseTo(0.21875);
    expect(stageRest(golden, 0)).toBeCloseTo(0.5); // the grammar keeps 7 tokens, 2 listed
    expect(stageRest(golden, 1)).toBeCloseTo(0);
    expect(stageRest(golden, 2)).toBeCloseTo(0);
    expect(stageRest(none, 0)).toBeCloseTo(0.1);
  });

  it('never goes below zero and moves linearly', () => {
    const e: StageSource = { nGates: 1, rawMass: 1, pRaw: new Float32Array([1]), stageP: new Float32Array([1.00001]) };
    expect(stageRest(e, 0)).toBe(0);
    expect(restAt(golden, 0)).toBeCloseTo(0.21875);
    expect(restAt(golden, 0.5)).toBeCloseTo((0.21875 + 0.5) / 2);
    expect(restAt(golden, 1)).toBeCloseTo(0.5);
    expect(restAt(golden, 1.5)).toBeCloseTo(0.25);
  });
});

describe('segmentOf, crosses and hasStage', () => {
  it('finds the gate being crossed', () => {
    expect(segmentOf(golden, 0)).toBe(-1);
    expect(segmentOf(golden, 0.1)).toBe(0);
    expect(segmentOf(golden, 1)).toBe(0);
    expect(segmentOf(golden, 1.1)).toBe(1);
    expect(segmentOf(golden, 3)).toBe(2);
    expect(segmentOf(golden, 5)).toBe(2);
    expect(segmentOf(none, 1)).toBe(-1);
  });

  it('reports each gate once along a run', () => {
    const seen: number[] = [];
    let prev = 0;
    for (const x of [0, 0.1, 0.5, 0.99, 1, 1.3, 2.7, 3, 3]) {
      for (let g = 0; g < 3; g++) if (crosses(prev, x, g)) seen.push(g);
      prev = x;
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reports several gates in one long step', () => {
    expect([0, 1, 2].filter((g) => crosses(0, 3, g))).toEqual([0, 1, 2]);
    expect([0, 1, 2].filter((g) => crosses(0.5, 2.5, g))).toEqual([1, 2]);
    expect(crosses(3, 4, 3)).toBe(true); // the caller stops at nGates
    expect(crosses(0, 1, -1)).toBe(false);
  });

  it('knows which positions a decision has', () => {
    expect(hasStage(golden, 0)).toBe(true);
    expect(hasStage(golden, 2.5)).toBe(true);
    expect(hasStage(golden, 3)).toBe(true);
    expect(hasStage(golden, 3.2)).toBe(false);
    expect(hasStage(none, 0)).toBe(true);
    expect(hasStage(none, 0.5)).toBe(false);
  });
});

describe('labels', () => {
  it('names each gate in a few characters', () => {
    expect(gateLabel({ type: 'grammar', gbnf: 'root ::= "a"' })).toBe('grammar');
    expect(gateLabel({ type: 'penalties', last_n: 64, repeat: 1.1, frequency: 0, presence: 0 })).toBe('penalties');
    expect(gateLabel({ type: 'top_k', k: 40 })).toBe('top-k 40');
    expect(gateLabel({ type: 'top_p', p: 0.949999988079071 })).toBe('top-p 0.95');
    expect(gateLabel({ type: 'min_p', p: 0.05 })).toBe('min-p 0.05');
    expect(gateLabel({ type: 'temp', t: 0.8 })).toBe('temp 0.8');
    expect(gateLabel({ type: 'xtc', p: 0.1 })).toBe('xtc');
    expect(gateShortLabel({ type: 'grammar', gbnf: 'root ::= "a"' })).toBe('gr');
    expect(gateShortLabel({ type: 'penalties', last_n: 64, repeat: 1.1, frequency: 0, presence: 0 })).toBe('pen');
    expect(gateShortLabel({ type: 'top_k', k: 40 })).toBe('k40');
    expect(gateShortLabel({ type: 'top_p', p: 0.949999988079071 })).toBe('p.95');
    expect(gateShortLabel({ type: 'min_p', p: 0.05 })).toBe('m.05');
    expect(gateShortLabel({ type: 'temp', t: 0.8 })).toBe('t.8');
    expect(gateShortLabel({ type: 'temp', t: 1.2 })).toBe('t1.2');
    expect(gateShortLabel({ type: 'typical', p: 0.1 })).toBe('typ');
  });

  it('writes counts compactly', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(40)).toBe('40');
    expect(compactCount(999)).toBe('999');
    expect(compactCount(1000)).toBe('1k');
    expect(compactCount(1234)).toBe('1.2k');
    expect(compactCount(12345)).toBe('12k');
    expect(compactCount(248320)).toBe('248k');
    expect(compactCount(151936)).toBe('152k');
    expect(compactCount(999999)).toBe('1M');
    expect(compactCount(1500000)).toBe('1.5M');
  });
});
