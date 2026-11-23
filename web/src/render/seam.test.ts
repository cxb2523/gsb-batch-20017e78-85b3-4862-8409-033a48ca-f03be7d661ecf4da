import { describe, expect, it } from 'vitest';
import { MARK_OUT, MARK_W, SEAM_DOT, SEAM_INSET, seamGeometry, type Rect } from './seam';

// Two columns: the left one from 0 to 300, the right one from 332 to 632.
const GAP_L = 300;
const GAP_R = 332;
const OUT_L = 0;
const OUT_R = 632;

const rect = (left: number, top: number, w = 30, h = 18): Rect => ({ left, top, right: left + w, bottom: top + h });

const geo = (a: Rect | null, b: Rect | null, label = '#7') => seamGeometry(a, b, GAP_L, GAP_R, OUT_L, OUT_R, label);

// The numbers of an SVG path, in order.
const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('seamGeometry', () => {
  it('is null without either token', () => {
    expect(geo(null, null)).toBeNull();
  });

  it('joins both lines inside the gap, with a dot at each end', () => {
    const g = geo(rect(250, 100), rect(400, 160))!;
    expect(g.dots).toEqual([
      { x: GAP_L + SEAM_INSET, y: 109 },
      { x: GAP_R - SEAM_INSET, y: 169 },
    ]);
    expect(g.path.startsWith(`M${GAP_L + SEAM_INSET} 109 C`)).toBe(true);
    expect(g.path.endsWith(`${GAP_R - SEAM_INSET} 169`)).toBe(true);
    expect(g.mid).toBe(139);
    // Every x of the path (end and control points) stays in the gap, clear
    // of the text, and so do the dots.
    const xs = nums(g.path).filter((_, i) => i % 2 === 0);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(GAP_L + SEAM_DOT);
      expect(x).toBeLessThanOrEqual(GAP_R - SEAM_DOT);
    }
    for (const d of g.dots) {
      expect(d.x - SEAM_DOT).toBeGreaterThan(GAP_L);
      expect(d.x + SEAM_DOT).toBeLessThan(GAP_R);
    }
  });

  it('puts a bar at the outer edge of each column, on the line', () => {
    const g = geo(rect(10, 100), rect(400, 160))!;
    expect(g.marks).toEqual([
      { x: OUT_L - MARK_OUT - MARK_W, y: 100, w: MARK_W, h: 18 },
      { x: OUT_R + MARK_OUT, y: 160, w: MARK_W, h: 18 },
    ]);
  });

  it('goes up as well as down', () => {
    const g = geo(rect(250, 200), rect(400, 40))!;
    expect(g.dots[0].y).toBe(209);
    expect(g.dots[1].y).toBe(49);
    expect(g.mid).toBe(129);
    // The label sits over the upper end, centred in the gap.
    expect(g.label).toEqual({ x: (GAP_L + GAP_R) / 2, y: 49 - 8, text: '#7' });
  });

  it('is a straight line when both are on the same line', () => {
    const g = geo(rect(250, 100), rect(400, 100))!;
    const ys = nums(g.path).filter((_, i) => i % 2 === 1);
    expect(new Set(ys)).toEqual(new Set([109]));
    expect(g.mid).toBe(109);
    expect(g.label?.y).toBe(101);
  });

  it('only marks the side that has the position', () => {
    const left = geo(rect(250, 100), null)!;
    expect(left.path).toBe('');
    expect(left.dots).toEqual([]);
    expect(left.label).toBeNull();
    expect(left.marks).toHaveLength(1);
    expect(left.marks[0].x).toBe(OUT_L - MARK_OUT - MARK_W);
    expect(left.mid).toBe(109);

    const right = geo(null, rect(400, 60))!;
    expect(right.path).toBe('');
    expect(right.marks).toHaveLength(1);
    expect(right.marks[0].x).toBe(OUT_R + MARK_OUT);
    expect(right.mid).toBe(69);
  });

  it('drops the label when it does not fit', () => {
    expect(geo(rect(250, 100), rect(400, 100), '#12345')!.label).toBeNull(); // too wide for the gap
    expect(geo(rect(250, 4), rect(400, 4))!.label).toBeNull(); // no room above
    expect(geo(rect(250, 100), rect(400, 100), '')!.label).toBeNull();
  });

  it('draws no curve when the gap is too narrow', () => {
    const g = seamGeometry(rect(250, 100), rect(305, 140), 300, 305, OUT_L, OUT_R, '#7')!;
    expect(g.path).toBe('');
    expect(g.dots).toEqual([]);
    expect(g.marks).toHaveLength(2);
    expect(g.mid).toBe(129);
  });
});
