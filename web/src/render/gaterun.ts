// Animation 2, the gates: when the viewed path gains a token whose decision
// went through gates, the bars of Candidates run along the gate strip, from
// "raw" to the last gate. At each gate the bars it cuts break into particles
// in their model's colour; a temperature just flattens or sharpens the bars
// (the interpolation of render/stages.ts). When the run ends, Candidates
// shows the selected gate again.
//
//   position  0 ── 1 ── 2 ── 3          duration min(360, interval × 0.85) ms
//             raw  g0   g1   g2         skipped under 40 ms
//
// Only without a selected token (neither pinned nor hovered): Candidates
// shows this decision only then. Never queued: a new token restarts it.
// Nothing with prefers-reduced-motion. Nothing is allocated per frame.

import type { EvalData, Slot, Store } from '../store/store';
import type { View } from '../store/view';
import type { CandidatesPanel } from './candidates';
import { Pace } from './pace';
import type { Particles } from './particles';
import { crosses } from './stages';

export const RUN_MAX_MS = 360;
export const RUN_MIN_MS = 40;

// What Candidates and the strip read while the run goes on: the decision it
// runs over and its position along the stages (0 → nGates).
export interface RunState {
  decision: EvalData | undefined;
  x: number;
}

// Length of a run when tokens come every `intervalMs`; 0 when too short to
// animate.
export function runDuration(intervalMs: number): number {
  const d = Math.min(RUN_MAX_MS, intervalMs * 0.85);
  return d >= RUN_MIN_MS ? d : 0;
}

// Position after `elapsed` ms of a run of `dur` ms over `nGates` gates:
// steady, so every gate gets the same time.
export function runPosition(elapsed: number, dur: number, nGates: number): number {
  if (!(dur > 0) || elapsed >= dur) return nGates;
  if (!(elapsed > 0)) return 0;
  return (elapsed / dur) * nGates;
}

export class GateRun {
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  readonly state: RunState = { decision: undefined, x: 0 };
  private readonly pace = new Pace();
  private t0 = 0;
  private dur = 0;
  private on = false;
  // Per crossing: the offset of the Candidates canvas on the particle layer.
  private dx = 0;
  private dy = 0;
  private readonly emit: (slot: Slot, x: number, y: number, w: number, h: number) => void;

  constructor(
    private readonly store: Store,
    private readonly view: View,
    private readonly candidates: CandidatesPanel,
    private readonly particles: Particles,
  ) {
    this.emit = (slot, x, y, w, h) => this.particles.burst(this.dx + x, this.dy + y, w, h, slot);
  }

  // The token at `index` has just been appended to the viewed path. Called
  // before Candidates is painted for it.
  born(now: number, index: number): void {
    const interval = this.pace.next(now);
    this.cancel();
    if (this.reduced.matches) return;
    const d = this.store.decision(index);
    if (!d || d.nGates === 0) return;
    if (this.view.pinnedIndex() !== null || this.view.hoveredIndex() !== null) return;
    const dur = runDuration(interval);
    if (dur <= 0) return;
    this.t0 = now;
    this.dur = dur;
    this.on = true;
    this.state.decision = d;
    this.state.x = 0;
  }

  // Moves the run to `now`, breaking the bars of each gate crossed since the
  // last frame (as Candidates last painted them). Returns the state, or
  // null once the run is over.
  advance(now: number): RunState | null {
    if (!this.on) return null;
    const st = this.state;
    const d = st.decision;
    if (!d) {
      this.cancel();
      return null;
    }
    const prev = st.x;
    const x = runPosition(now - this.t0, this.dur, d.nGates);
    let first = true;
    for (let g = 0; g < d.nGates; g++) {
      if (!crosses(prev, x, g)) continue;
      if (first) {
        first = false;
        this.locate();
      }
      this.candidates.cutBars(g, this.emit);
    }
    st.x = x;
    if (x >= d.nGates) {
      this.on = false;
      st.decision = undefined;
      return null;
    }
    return st;
  }

  get active(): boolean {
    return this.on;
  }

  // Ends the run at once; the sparks already out keep falling.
  cancel(): void {
    this.on = false;
    this.state.decision = undefined;
  }

  // Where the Candidates canvas sits on the particle layer.
  private locate(): void {
    const c = this.candidates.canvasRect();
    const f = this.particles.canvasRect();
    this.dx = c.left - f.left;
    this.dy = c.top - f.top;
  }
}
