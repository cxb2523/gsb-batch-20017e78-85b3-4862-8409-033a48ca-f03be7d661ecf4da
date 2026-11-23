// Animation 3, the split: when the cursors of A and B stop coinciding, the
// "⑂ split" markers of both Stream columns flash magenta, the coloured edge
// of each column header pulses in its model's colour, the other column's
// new lane tokens fade in, and the Timeline's divergence trace fires a pulse
// at that position. Nothing moves vertically. Happens once per split, so it
// may last longer than the per-token animations; only opacity, transform
// and shadows on a handful of elements, so it holds 60 frames per second.
// Nothing with prefers-reduced-motion.

import type { Store } from '../store/store';
import type { StreamPanel } from './stream';
import { COLOR, MODEL_COLOR } from './theme';

const DUR_MS = 400; // the flash and the Timeline pulse
const FADE_MS = 280; // the other model's lane tokens appearing

const DIS_GLOW = hexAlpha(COLOR.dis, 0.9);
const DIS_CLEAR = hexAlpha(COLOR.dis, 0);

export interface Pulse {
  index: number; // position in the viewed path
  alpha: number; // 1 at the start, fading to 0
}

export class Split {
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private t0 = 0;
  private on = false;
  private anims: Animation[] = [];

  constructor(
    private readonly store: Store,
    private readonly stream: StreamPanel,
  ) {}

  // The cursors have just split. Called after the Stream has been updated,
  // so the markers and the lane are already in the DOM.
  start(now: number): void {
    this.cancel();
    const s = this.store;
    if (this.reduced.matches || s.split < 0) return;
    this.t0 = now;
    this.on = true;
    const ease = { duration: DUR_MS, easing: 'ease-out' };

    // The markers flash magenta and settle.
    for (const m of this.stream.splitMarks()) {
      this.anims.push(
        m.animate(
          [
            { textShadow: `0 0 10px ${DIS_GLOW}`, boxShadow: `0 0 14px ${DIS_GLOW}` },
            { textShadow: `0 0 0 ${DIS_CLEAR}`, boxShadow: `0 0 0 ${DIS_CLEAR}` },
          ],
          ease,
        ),
      );
    }
    // Each header edge pulses in its model's colour.
    for (const slot of [0, 1] as const) {
      const c = MODEL_COLOR[slot];
      this.anims.push(
        this.stream
          .edgeOf(slot)
          .animate(
            [
              { transform: 'scaleX(2.4)', boxShadow: `0 0 12px ${hexAlpha(c, 0.9)}` },
              { transform: 'none', boxShadow: `0 0 0 ${hexAlpha(c, 0)}` },
            ],
            ease,
          ),
      );
    }
    // The other model's own tokens fade in where they already stand.
    for (const el of this.stream.laneSpans()) {
      this.anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' }));
    }
  }

  // The Timeline pulse for this animation frame, or null.
  pulse(now: number): Pulse | null {
    if (!this.on) return null;
    const k = (now - this.t0) / DUR_MS;
    if (k >= 1) {
      this.on = false;
      return null;
    }
    const index = this.store.split;
    return index < 0 ? null : { index, alpha: pulseAlpha(k) };
  }

  get active(): boolean {
    return this.on;
  }

  // Ends whatever is running at once.
  cancel(): void {
    this.on = false;
    for (const a of this.anims) a.cancel();
    this.anims = [];
  }
}

// Opacity of the pulse at fraction `k` of its duration: 1 at the start,
// fading to 0, fast at first (ease-out), like a spark.
export function pulseAlpha(k: number): number {
  if (!(k > 0)) return 1;
  if (k >= 1) return 0;
  return (1 - k) * (1 - k);
}

function hexAlpha(hex: string, a: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
