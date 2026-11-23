import { beforeEach, describe, expect, it } from 'vitest';
import { clearTabularCache, fillTabular, tabularWidth } from './tabular';

// A stand-in for a 2D context: '1' is narrow, '8' the widest digit, other
// characters as listed; it records what is drawn and what is measured.
const WIDTH: Record<string, number> = { '1': 4, '8': 10, '.': 3, '%': 9, ' ': 2, '−': 7 };

function fakeCtx(widthOf: (ch: string) => number = (ch) => WIDTH[ch] ?? 6) {
  const drawn: { ch: string; x: number; y: number; align: string }[] = [];
  const measured: string[] = [];
  const ctx = {
    font: '600 24px Inter',
    textAlign: 'start' as CanvasTextAlign,
    measureText(s: string) {
      measured.push(s);
      let w = 0;
      for (const ch of s) w += widthOf(ch);
      return { width: w };
    },
    fillText(ch: string, x: number, y: number) {
      drawn.push({ ch, x, y, align: ctx.textAlign });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, measured };
}

describe('tabular figures', () => {
  beforeEach(() => clearTabularCache());

  it('gives every digit the widest digit advance', () => {
    const { ctx } = fakeCtx();
    expect(tabularWidth(ctx, '11')).toBe(20);
    expect(tabularWidth(ctx, '88')).toBe(20);
    expect(tabularWidth(ctx, '1.8 %')).toBe(10 + 3 + 10 + 2 + 9);
  });

  it('centres a narrow digit in its cell and keeps other characters natural', () => {
    const { ctx, drawn } = fakeCtx();
    const w = fillTabular(ctx, '1.8', 100, 50);
    expect(w).toBe(23);
    expect(drawn.map((d) => d.ch)).toEqual(['1', '.', '8']);
    expect(drawn[0].x).toBe(103); // (10 - 4) / 2 into its cell
    expect(drawn[1].x).toBe(110);
    expect(drawn[2].x).toBe(113);
    expect(drawn.every((d) => d.y === 50 && d.align === 'left')).toBe(true);
  });

  it('aligns right and centre on the total width', () => {
    const { ctx, drawn } = fakeCtx();
    fillTabular(ctx, '88', 100, 0, 'right');
    expect(drawn[0].x).toBe(80);
    drawn.length = 0;
    fillTabular(ctx, '88', 100, 0, 'center');
    expect(drawn[0].x).toBe(90);
  });

  it('skips drawing spaces but keeps their width', () => {
    const { ctx, drawn } = fakeCtx();
    fillTabular(ctx, '8 %', 0, 0);
    expect(drawn.map((d) => d.ch)).toEqual(['8', '%']);
    expect(drawn[1].x).toBe(12);
  });

  it('restores the text alignment it found', () => {
    const { ctx } = fakeCtx();
    ctx.textAlign = 'right';
    fillTabular(ctx, '12', 0, 0);
    expect(ctx.textAlign).toBe('right');
  });

  it('measures once per font and nothing on later draws', () => {
    const { ctx, measured } = fakeCtx();
    fillTabular(ctx, '−1.8 %', 0, 0);
    const first = measured.length;
    fillTabular(ctx, '−8.1 %', 0, 0);
    fillTabular(ctx, '18.88', 0, 0);
    expect(measured.length).toBe(first);
    // Another font: measured again, with its own widest digit.
    ctx.font = '600 16px Inter';
    const before = measured.length;
    tabularWidth(ctx, '1');
    expect(measured.length).toBeGreaterThan(before);
  });

  it('keeps a separate advance per font', () => {
    let scale = 2;
    const { ctx } = fakeCtx((ch) => (ch === '8' ? 10 : 5) * scale);
    expect(tabularWidth(ctx, '1')).toBe(20);
    ctx.font = '600 11px Inter';
    scale = 1;
    expect(tabularWidth(ctx, '11')).toBe(20);
    ctx.font = '600 24px Inter';
    expect(tabularWidth(ctx, '1')).toBe(20); // cached for the first font
  });
});
