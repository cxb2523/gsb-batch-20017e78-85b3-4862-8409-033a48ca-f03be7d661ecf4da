import { describe, expect, it } from 'vitest';
import { pulseAlpha } from './split';

describe('pulseAlpha', () => {
  it('starts at 1 and ends at 0', () => {
    expect(pulseAlpha(0)).toBe(1);
    expect(pulseAlpha(-0.5)).toBe(1);
    expect(pulseAlpha(1)).toBe(0);
    expect(pulseAlpha(2)).toBe(0);
  });

  it('decays steadily', () => {
    let prev = 1;
    for (let k = 0.05; k < 1; k += 0.05) {
      const a = pulseAlpha(k);
      expect(a).toBeLessThan(prev);
      expect(a).toBeGreaterThan(0);
      prev = a;
    }
  });
});
