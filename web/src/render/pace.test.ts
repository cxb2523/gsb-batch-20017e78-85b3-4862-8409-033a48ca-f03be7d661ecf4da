import { describe, expect, it } from 'vitest';
import { Pace } from './pace';
import { runDuration } from './gaterun';

describe('pace', () => {
  it('passes a long gap through and averages the steady ones', () => {
    const p = new Pace();
    expect(p.next(0)).toBe(Infinity);
    expect(p.next(5000)).toBe(5000);
    expect(p.next(5200)).toBe(200);
    expect(p.next(5300)).toBeCloseTo(175);
  });

  it('keeps a steady speed on one side of a threshold despite frame jitter', () => {
    // 30 tokens per second painted at 60 Hz: gaps of 33 and 50 ms alternate
    // with 17 ms ones; the gate run (skipped under 40 ms) must not flicker.
    const p = new Pace();
    const gaps = [33, 33, 50, 17, 33, 50, 33, 17, 50, 33, 33, 50, 17, 33];
    let t = 0;
    p.next(t);
    const on: boolean[] = [];
    for (const g of gaps) on.push(runDuration(p.next((t += g))) > 0);
    expect(on.slice(3).every((x) => !x)).toBe(true);
  });
});
