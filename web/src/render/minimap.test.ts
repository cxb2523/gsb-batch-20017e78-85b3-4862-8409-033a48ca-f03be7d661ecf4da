import { describe, expect, it } from 'vitest';
import { STOP_CONTEXT_FULL, STOP_EOG, STOP_MAX_TOKENS } from '../source/frames';
import {
  assignRows,
  branchNodes,
  curveY,
  hitBranch,
  MAP_ROWS,
  maxRows,
  previewText,
  ROW_H,
  rowsUsed,
  stopGlyph,
  treeHeight,
  type MapLine,
} from './minimap';

describe('assignRows', () => {
  it('puts lines that do not overlap on the first row', () => {
    expect(assignRows([[0, 10], [20, 30], [40, 50]])).toEqual([0, 0, 0]);
  });

  it('moves an overlapping line down a row, and back up when there is room', () => {
    expect(assignRows([[0, 50], [10, 20], [30, 40], [60, 70]])).toEqual([0, 1, 1, 0]);
  });

  it('keeps a gap between lines on one row', () => {
    expect(assignRows([[0, 10], [12, 20]], 3, 4)).toEqual([0, 1]);
    expect(assignRows([[0, 10], [15, 20]], 3, 4)).toEqual([0, 0]);
  });

  it('piles what does not fit on the last row', () => {
    expect(assignRows([[0, 100], [5, 100], [10, 100], [15, 100], [20, 100]], 3)).toEqual([0, 1, 2, 2, 2]);
    expect(assignRows([[0, 10], [5, 10]], 1)).toEqual([0, 0]);
  });

  it('is empty without lines', () => {
    expect(assignRows([])).toEqual([]);
  });
});

describe('tree height', () => {
  it('grows a row at a time from a single line', () => {
    expect(treeHeight(1) - treeHeight(0)).toBe(ROW_H);
    expect(treeHeight(3) - treeHeight(0)).toBe(3 * ROW_H);
  });

  it('counts the rows in use', () => {
    expect(rowsUsed([])).toBe(0);
    expect(rowsUsed([0, 0, 0])).toBe(1);
    expect(rowsUsed([0, 2, 1])).toBe(3);
  });

  it('takes at least one row and at most MAP_ROWS, as the room allows', () => {
    expect(maxRows(0)).toBe(1);
    expect(maxRows(treeHeight(2))).toBe(2);
    expect(maxRows(treeHeight(2) + ROW_H - 1)).toBe(2);
    expect(maxRows(10000)).toBe(MAP_ROWS);
  });
});

describe('curveY', () => {
  const l: MapLine = { x0: 10, x1: 60, y: 120, c: 10 };

  it('leaves the main line at the fork and lands on the row after the curve', () => {
    expect(curveY(l, 10, 100)).toBe(100);
    expect(curveY(l, 15, 100)).toBe(110);
    expect(curveY(l, 20, 100)).toBe(120);
    expect(curveY(l, 40, 100)).toBe(120);
  });

  it('is the row without a curve', () => {
    expect(curveY({ ...l, c: 0 }, 10, 100)).toBe(120);
  });
});

describe('hitBranch', () => {
  // Main line at y 100; rows at 111 and 122.
  const lines: MapLine[] = [
    { x0: 10, x1: 60, y: 111, c: 10 },
    { x0: 30, x1: 90, y: 122, c: 10 },
    { x0: 70, x1: 80, y: 111, c: 10 },
  ];

  it('hits the straight run of a line within the tolerance', () => {
    expect(hitBranch(lines, 40, 111, 100)).toBe(0);
    expect(hitBranch(lines, 40, 114, 100)).toBe(0);
    expect(hitBranch(lines, 50, 122, 100)).toBe(1);
    expect(hitBranch(lines, 78, 110, 100)).toBe(2);
  });

  it('hits the curve out of the fork', () => {
    expect(hitBranch(lines, 35, 111, 100)).toBe(1); // half way down the curve of line 1
    expect(hitBranch(lines, 15, 105, 100)).toBe(0);
  });

  it('misses the main line, the gaps and past the ends', () => {
    expect(hitBranch(lines, 40, 100, 100)).toBe(-1);
    expect(hitBranch(lines, 66, 111, 100)).toBe(-1);
    expect(hitBranch(lines, 96, 122, 100)).toBe(-1);
    expect(hitBranch(lines, 5, 111, 100)).toBe(-1);
    expect(hitBranch([], 40, 111, 100)).toBe(-1);
  });

  it('reaches a short branch up to the end of its curve', () => {
    const short: MapLine[] = [{ x0: 10, x1: 11, y: 111, c: 10 }];
    expect(hitBranch(short, 22, 111, 100)).toBe(0);
  });

  it('prefers the line drawn last where two share a row', () => {
    const piled: MapLine[] = [
      { x0: 0, x1: 100, y: 122, c: 10 },
      { x0: 20, x1: 50, y: 122, c: 10 },
    ];
    expect(hitBranch(piled, 40, 122, 100)).toBe(1);
    expect(hitBranch(piled, 80, 122, 100)).toBe(0);
  });
});

describe('branchNodes', () => {
  //   0 ─ 1 ─ 2 ─ 3
  //        └─ 4 ─ 5
  const parent = [-1, 0, 1, 2, 1, 4];

  it('runs from the branch down to its tip', () => {
    expect(branchNodes(parent, 4, 5)).toEqual([4, 5]);
    expect(branchNodes(parent, 2, 3)).toEqual([2, 3]);
    expect(branchNodes(parent, 5, 5)).toEqual([5]);
  });

  it('is empty when the tip is not under the branch', () => {
    expect(branchNodes(parent, 2, 5)).toEqual([]);
  });
});

describe('previewText', () => {
  const enc = new TextEncoder();
  const toks = (...s: string[]): Uint8Array[] => s.map((t) => enc.encode(t));

  it('joins the tokens and keeps short text whole', () => {
    expect(previewText(toks(' The', ' cat', ' sat.'))).toBe('The cat sat.');
  });

  it('decodes a character split between two tokens', () => {
    const e = enc.encode('é');
    expect(previewText([enc.encode(' caf'), e.slice(0, 1), e.slice(1)])).toBe('café');
  });

  it('folds whitespace and shows line breaks', () => {
    expect(previewText(toks('a', '\n\n', '  b\t c'))).toBe('a ↵ b c');
  });

  it('cuts long text with an ellipsis', () => {
    const out = previewText(toks('abcdefghij', 'klmnopqrst'), 12);
    expect(Array.from(out)).toHaveLength(12);
    expect(out).toBe('abcdefghijk…');
  });

  it('drops control characters', () => {
    expect(previewText(toks('a\x01b'))).toBe('ab');
  });
});

describe('stopGlyph', () => {
  it('has a glyph for each reason and none for a node that goes on', () => {
    expect(stopGlyph(STOP_EOG)).toBe('end');
    expect(stopGlyph(STOP_MAX_TOKENS)).toBe('cut');
    expect(stopGlyph(STOP_CONTEXT_FULL)).toBe('full');
    expect(stopGlyph(undefined)).toBeNull();
  });
});
