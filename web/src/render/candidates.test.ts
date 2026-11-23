import { describe, expect, it } from 'vitest';
import { ROW_H, rowAt } from './candidates';

describe('rowAt', () => {
  // Rows of ROW_H px from y 52; three rows shown, then "rest".
  const top = 52;
  it('finds the candidate row under a point', () => {
    expect(rowAt(top, top, 3)).toBe(0);
    expect(rowAt(top + ROW_H - 0.1, top, 3)).toBe(0);
    expect(rowAt(top + ROW_H, top, 3)).toBe(1);
    expect(rowAt(top + 3 * ROW_H - 1, top, 3)).toBe(2);
  });

  it('is -1 on the header, on "rest" and below', () => {
    expect(rowAt(top - 1, top, 3)).toBe(-1);
    expect(rowAt(10, top, 3)).toBe(-1);
    expect(rowAt(top + 3 * ROW_H, top, 3)).toBe(-1); // the rest row
    expect(rowAt(top + 20 * ROW_H, top, 3)).toBe(-1);
    expect(rowAt(top + 8, top, 0)).toBe(-1);
  });
});
