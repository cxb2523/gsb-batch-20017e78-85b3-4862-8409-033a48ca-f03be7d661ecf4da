// The single paint loop. One requestAnimationFrame for everything: the replay
// clock, the panels flagged in store.dirty (then cleared), the token birth,
// the gate run and its particles, the split, the relief and its growth, and
// the metrics, Layers and Compare views, and the frame-rate count. Panels
// whose data did not change are not touched.

import type { Store } from '../store/store';
import type { View } from '../store/view';
import type { Birth } from './birth';
import type { CandidatesPanel } from './candidates';
import type { GateRun } from './gaterun';
import type { GatesPanel } from './gates';
import type { Particles } from './particles';
import type { Split } from './split';
import type { StreamPanel } from './stream';
import type { TimelinePanel } from './timeline';

// The 3D relief (render/relief.ts), loaded after the rest: the loop only
// knows this much of it, so three.js stays out of the main chunk.
export interface ReliefPart {
  born(now: number): void; // the viewed path gained a token (animation 4)
  cancel(): void; // the viewed path was replaced
  paint(now: number, dirty: boolean): void; // every frame; it decides whether to render
  resetView(): void; // the camera back to its fitted default, auto-orbit on
}

// A panel that only needs to be told to repaint.
export interface Painted {
  paint(): void;
}

export interface LoopParts {
  store: Store;
  view: View;
  stream: StreamPanel;
  candidates: CandidatesPanel;
  gates: GatesPanel;
  timeline: TimelinePanel;
  birth: Birth;
  run: GateRun;
  particles: Particles;
  split: Split;
  metrics: Painted;
  lens: Painted;
  compare: Painted;
  // Whether a view behind a tab is on screen. A hidden one keeps its dirty
  // flag and is painted when it comes back.
  shown(view: 'lens' | 'compare'): boolean;
  relief(): ReliefPart | null; // null until its chunk has loaded
  tick(elapsedMs: number): void; // the replay clock; frames may be applied here
  meta(): void; // dirty.meta: HELLO or CONFIG changed
  // A few times per second: figures for the UI. `maxFrameMs` is the longest
  // gap between two frames since the last call.
  slow(fps: number, maxFrameMs: number): void;
}

const SLOW_MS = 250;

// Starts the loop; returns a function that stops it.
export function startLoop(p: LoopParts): () => void {
  const s = p.store;
  let raf = 0;
  let last = performance.now();
  let frames = 0;
  let countFrom = last;
  let maxGap = 0;
  let len = s.path.length;
  let epoch = s.pathEpoch;
  let flashing = false;
  let running = false;
  let splits = s.splits;
  let pulsing = false;

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const gap = now - last;
    last = now;
    if (gap > maxGap) maxGap = gap;
    // A hidden tab stops the loop: do not replay a long gap in one go.
    p.tick(Math.min(gap, SLOW_MS));

    const d = s.dirty;
    if (d.meta) {
      d.meta = false;
      p.meta();
    }

    // Did the viewed path gain exactly one token?
    const grew = s.pathEpoch === epoch && s.path.length === len + 1;
    const relief = p.relief();
    if (s.pathEpoch !== epoch || s.path.length < len) {
      p.birth.cancel();
      p.run.cancel();
      relief?.cancel();
    }
    epoch = s.pathEpoch;
    len = s.path.length;

    if (d.stream) {
      d.stream = false;
      p.stream.update();
    }

    // Animation 2: starts on a new token, before Candidates is painted for
    // it; stops as soon as a token is selected (Candidates shows another
    // decision then). Advancing it breaks the bars of the gates crossed, as
    // last painted, so it goes before this frame's paint.
    if (grew) p.run.born(now, len - 1);
    else if (p.run.active && (p.view.pinnedIndex() !== null || p.view.hoveredIndex() !== null)) p.run.cancel();
    const run = p.run.advance(now);
    // While it runs, Candidates and the strip repaint every frame, and once
    // more after it ends to show the selected gate again.
    if (running || run !== null) d.candidates = d.gates = true;
    running = run !== null;

    if (flashing) d.candidates = true;
    if (d.candidates) {
      d.candidates = false;
      p.candidates.paint(p.birth.flash(now), run);
    }
    if (grew) {
      p.birth.born(now, len - 1);
      if (p.birth.active) p.candidates.paint(p.birth.flash(now), run);
    }
    flashing = p.birth.active;

    if (d.gates) {
      d.gates = false;
      p.gates.paint(run);
    }
    if (p.particles.active) {
      p.particles.update(gap);
      p.particles.paint();
    }

    // The cursors have just split: animate only one new split since the
    // last frame. Fewer (a reset, a seek back) or several at once (a session
    // loaded already split) only bring the count up to date.
    if (s.splits !== splits) {
      if (s.splits === splits + 1) p.split.start(now);
      else p.split.cancel();
      splits = s.splits;
    }
    // While the pulse runs the Timeline repaints every frame, and once more
    // after it ends to clear it.
    if (pulsing || p.split.active) d.timeline = true;
    if (d.timeline) {
      d.timeline = false;
      p.timeline.paint(p.split.pulse(now));
    }
    pulsing = p.split.active;

    // The views added after the five animations: plain repaints.
    if (d.metrics) {
      d.metrics = false;
      p.metrics.paint();
    }
    if (d.lens && p.shown('lens')) {
      d.lens = false;
      p.lens.paint();
    }
    if (d.compare && p.shown('compare')) {
      d.compare = false;
      p.compare.paint();
    }

    // The relief: the light plane moves in this same frame as the Stream's
    // selection (animation 5). Until it has loaded, dirty.relief stays set.
    if (relief) {
      if (grew) relief.born(now);
      relief.paint(now, d.relief);
      d.relief = false;
    }

    frames++;
    if (now - countFrom >= SLOW_MS) {
      const fps = (frames * 1000) / (now - countFrom);
      p.slow(fps, maxGap);
      frames = 0;
      countFrom = now;
      maxGap = 0;
    }
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
