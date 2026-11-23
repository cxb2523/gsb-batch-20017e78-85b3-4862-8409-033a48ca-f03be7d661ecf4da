// The particle canvas over Candidates and the gate strip: the bars cut by a
// gate break into sparks that fall and fade (animation 2). Transparent, with
// additive blending, so the sparks glow over the panels without hiding them:
// each spark is a bright core in a faint halo, and shrinks as it fades.
//
// A fixed pool of particles in typed arrays: bursting, moving and painting
// never allocate. When the pool is full, new sparks are dropped.

import { Surface } from './surface';

export const MAX_PARTICLES = 600;
export const GRAVITY = 900; // px/s²
export const LIFE_MS = 500;
const SIZE_PX = 2.4; // core at birth
const HALO_PX = 6;
const HALO_ALPHA = 0.22;
const PER_PX2 = 1 / 14; // sparks per px² of bar
const MIN_BURST = 4;
const MAX_BURST = 48;

// The state of the pool: particle i lives at index i < count.
export interface ParticleState {
  count: number;
  x: Float32Array; // px
  y: Float32Array;
  vx: Float32Array; // px/s
  vy: Float32Array;
  age: Float32Array; // ms
  life: Float32Array; // ms
  color: Uint8Array; // index into the palette
}

export function particleState(max = MAX_PARTICLES): ParticleState {
  return {
    count: 0,
    x: new Float32Array(max),
    y: new Float32Array(max),
    vx: new Float32Array(max),
    vy: new Float32Array(max),
    age: new Float32Array(max),
    life: new Float32Array(max),
    color: new Uint8Array(max),
  };
}

// Moves every particle by `dt` ms under gravity, ages it, and drops the
// dead ones (the last live particle takes the place of each). The order of
// the survivors may change; nothing is allocated.
export function stepParticles(s: ParticleState, dt: number): void {
  const t = dt / 1000;
  let i = 0;
  while (i < s.count) {
    const age = s.age[i] + dt;
    if (age >= s.life[i]) {
      const last = --s.count;
      s.x[i] = s.x[last];
      s.y[i] = s.y[last];
      s.vx[i] = s.vx[last];
      s.vy[i] = s.vy[last];
      s.age[i] = s.age[last];
      s.life[i] = s.life[last];
      s.color[i] = s.color[last];
      continue; // the moved one has not been stepped yet
    }
    s.age[i] = age;
    s.vy[i] += GRAVITY * t;
    s.x[i] += s.vx[i] * t;
    s.y[i] += s.vy[i] * t;
    i++;
  }
}

// Opacity of a particle: full at birth, fading out over its life.
export function particleAlpha(age: number, life: number): number {
  if (!(life > 0) || age >= life) return 0;
  if (age <= 0) return 1;
  const k = 1 - age / life;
  return k * k;
}

// How many sparks a bar of `w` × `h` px gives.
export function burstSize(w: number, h: number): number {
  const n = Math.round(Math.max(0, w) * Math.max(0, h) * PER_PX2);
  return Math.max(MIN_BURST, Math.min(MAX_BURST, n));
}

// Adds a burst over the rectangle (canvas px). Returns how many were added.
export function addBurst(
  s: ParticleState,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  random: () => number = Math.random,
): number {
  const max = s.x.length;
  const n = Math.min(burstSize(w, h), max - s.count);
  for (let k = 0; k < n; k++) {
    const i = s.count++;
    s.x[i] = x + random() * w;
    s.y[i] = y + random() * h;
    s.vx[i] = (random() - 0.5) * 120;
    s.vy[i] = -random() * 140; // a small hop before the fall
    s.age[i] = 0;
    s.life[i] = LIFE_MS * (0.8 + random() * 0.4);
    s.color[i] = color;
  }
  return n;
}

export class Particles {
  private readonly surface: Surface;
  private readonly state = particleState();
  private drawn = false; // something is on the canvas

  constructor(
    canvas: HTMLCanvasElement,
    private readonly palette: readonly string[],
  ) {
    this.surface = new Surface(canvas, () => {});
  }

  // A burst over a rectangle in canvas px (see canvasRect()), in palette
  // colour `color`.
  burst(x: number, y: number, w: number, h: number, color: number): void {
    addBurst(this.state, x, y, w, h, color);
  }

  // Viewport rectangle of the canvas, to bring other layers' px to this one.
  canvasRect(): DOMRect {
    return this.surface.canvas.getBoundingClientRect();
  }

  update(dt: number): void {
    if (this.state.count > 0) stepParticles(this.state, Math.min(dt, 100));
  }

  // Paints the live particles; clears the canvas once after the last one.
  paint(): void {
    const s = this.state;
    if (s.count === 0 && !this.drawn) return;
    const sf = this.surface;
    if (!sf.begin(null)) return;
    this.drawn = s.count > 0;
    if (!this.drawn) return;
    const ctx = sf.ctx;
    ctx.globalCompositeOperation = 'lighter';
    // One pass per colour: the fill style changes a handful of times.
    for (let c = 0; c < this.palette.length; c++) {
      ctx.fillStyle = this.palette[c];
      for (let i = 0; i < s.count; i++) {
        if (s.color[i] !== c) continue;
        const a = particleAlpha(s.age[i], s.life[i]);
        const x = s.x[i];
        const y = s.y[i];
        ctx.globalAlpha = a * HALO_ALPHA;
        ctx.fillRect(x - HALO_PX / 2, y - HALO_PX / 2, HALO_PX, HALO_PX);
        const core = SIZE_PX * (0.6 + 0.4 * a);
        ctx.globalAlpha = a;
        ctx.fillRect(x - core / 2, y - core / 2, core, core);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Something to move or to clear.
  get active(): boolean {
    return this.state.count > 0 || this.drawn;
  }

  clear(): void {
    this.state.count = 0;
  }

  dispose(): void {
    this.surface.dispose();
  }
}
