import { describe, expect, it } from 'vitest';
import { RUN_MAX_MS, RUN_MIN_MS, runDuration, runPosition } from './gaterun';

describe('runDuration', () => {
  it('takes 85% of the interval, up to 360 ms', () => {
    expect(runDuration(200)).toBeCloseTo(170);
    expect(runDuration(1000)).toBe(RUN_MAX_MS);
    expect(runDuration(Infinity)).toBe(RUN_MAX_MS); // the first token
  });

  it('is skipped when it would be under 40 ms', () => {
    expect(runDuration(RUN_MIN_MS / 0.85 - 1)).toBe(0);
    expect(runDuration(RUN_MIN_MS / 0.85 + 1)).toBeGreaterThanOrEqual(RUN_MIN_MS);
    expect(runDuration(0)).toBe(0);
    // 15 steps per second: still animated.
    expect(runDuration(1000 / 15)).toBeGreaterThan(0);
  });
});

describe('runPosition', () => {
  it('goes steadily from 0 to the number of gates', () => {
    expect(runPosition(0, 300, 3)).toBe(0);
    expect(runPosition(-5, 300, 3)).toBe(0);
    expect(runPosition(100, 300, 3)).toBeCloseTo(1);
    expect(runPosition(150, 300, 3)).toBeCloseTo(1.5);
    expect(runPosition(300, 300, 3)).toBe(3);
    expect(runPosition(900, 300, 3)).toBe(3);
  });

  it('ends at once without a duration', () => {
    expect(runPosition(0, 0, 4)).toBe(4);
  });
});
