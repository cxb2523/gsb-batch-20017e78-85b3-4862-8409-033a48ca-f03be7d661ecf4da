import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  LIFE_MS,
  addBurst,
  burstSize,
  particleAlpha,
  particleState,
  stepParticles,
} from './particles';

// A fixed "random" sequence: the middle of every range.
const half = (): number => 0.5;

describe('particles', () => {
  it('bursts inside the rectangle, with a bounded count', () => {
    const s = particleState(100);
    const n = addBurst(s, 10, 20, 40, 10, 1, half);
    expect(n).toBe(burstSize(40, 10));
    expect(s.count).toBe(n);
    for (let i = 0; i < s.count; i++) {
      expect(s.x[i]).toBe(30);
      expect(s.y[i]).toBe(25);
      expect(s.color[i]).toBe(1);
      expect(s.life[i]).toBeCloseTo(LIFE_MS);
    }
    expect(burstSize(0, 0)).toBeGreaterThan(0);
    expect(burstSize(10000, 100)).toBeLessThanOrEqual(48);
  });

  it('never goes past the pool', () => {
    const s = particleState(10);
    addBurst(s, 0, 0, 1000, 100, 0, half);
    expect(s.count).toBe(10);
    expect(addBurst(s, 0, 0, 1000, 100, 0, half)).toBe(0);
    expect(s.count).toBe(10);
  });

  it('falls under gravity', () => {
    const s = particleState(4);
    s.count = 1;
    s.x[0] = 0;
    s.y[0] = 0;
    s.vx[0] = 100;
    s.vy[0] = 0;
    s.life[0] = 1000;
    stepParticles(s, 100);
    expect(s.vy[0]).toBeCloseTo(GRAVITY * 0.1);
    expect(s.y[0]).toBeCloseTo(GRAVITY * 0.1 * 0.1);
    expect(s.x[0]).toBeCloseTo(10);
    expect(s.age[0]).toBe(100);
    stepParticles(s, 100);
    expect(s.y[0]).toBeGreaterThan(GRAVITY * 0.01 * 2);
  });

  it('drops the dead and keeps the rest', () => {
    const s = particleState(4);
    s.count = 3;
    s.life.set([50, 1000, 40]);
    s.color.set([0, 1, 2]);
    stepParticles(s, 60);
    expect(s.count).toBe(1);
    expect(s.color[0]).toBe(1);
    stepParticles(s, 1000);
    expect(s.count).toBe(0);
  });

  it('fades out over its life', () => {
    expect(particleAlpha(0, 500)).toBe(1);
    expect(particleAlpha(500, 500)).toBe(0);
    expect(particleAlpha(600, 500)).toBe(0);
    let prev = 1;
    for (let a = 50; a < 500; a += 50) {
      const v = particleAlpha(a, 500);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThan(0);
      prev = v;
    }
  });
});
