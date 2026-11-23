// What is being looked at: the selected token of the viewed path, and the
// selected gate of its decision. Local to the interface, never sent to the
// engine, and outside Svelte reactivity: every change flags the panels, and
// they all repaint in the same animation frame. That is the sweep
// (animation 5).

import type { Store } from './store';

export class View {
  private hover: number | null = null; // index into store.path, while the pointer is on a token
  private pinned: number | null = null; // index fixed by a click
  private epoch = -1;
  // Selected stage of the gate chain: -1 is "raw", g the distribution after
  // gate g. Kept when the selected token or the path changes.
  private gate = -1;

  constructor(private readonly store: Store) {}

  // Index of the token being inspected: the pinned one, else the hovered
  // one, else the last of the viewed path. -1 when the path is empty.
  selected(): number {
    this.sync();
    return this.pinned ?? this.hover ?? this.store.path.length - 1;
  }

  // The pinned index, or null. Follows the same validity rules as selected().
  pinnedIndex(): number | null {
    this.sync();
    return this.pinned;
  }

  hoveredIndex(): number | null {
    this.sync();
    return this.hover;
  }

  setHover(index: number | null): void {
    this.sync();
    index = this.clamp(index);
    if (index === this.hover) return;
    this.hover = index;
    this.touch();
  }

  pin(index: number): void {
    this.sync();
    const i = this.clamp(index);
    if (i === this.pinned) return;
    this.pinned = i;
    this.touch();
  }

  unpin(): void {
    this.sync();
    if (this.pinned === null) return;
    this.pinned = null;
    this.touch();
  }

  // Moves the pinned selection by `delta` tokens. Does nothing without one.
  move(delta: number): void {
    this.sync();
    if (this.pinned === null) return;
    this.pin(this.pinned + delta);
  }

  // The selected gate as chosen, which a decision may not have: see shownGate().
  selectedGate(): number {
    return this.gate;
  }

  // The stage shown for a decision with `nGates` gates: the selected gate,
  // or "raw" (-1) if that decision has fewer gates.
  shownGate(nGates: number): number {
    return this.gate < nGates ? this.gate : -1;
  }

  // Selects a gate (-1 or less: "raw").
  selectGate(gate: number): void {
    const g = gate < 0 ? -1 : Math.round(gate);
    if (g === this.gate) return;
    this.gate = g;
    this.store.dirty.candidates = true;
    this.store.dirty.gates = true;
  }

  // When the path is replaced, a pinned token survives only within the
  // prefix kept from the old path (none after a new session). The prefix is
  // only known for the replacement right after the epoch last seen: after
  // several at once, nothing survives.
  private sync(): void {
    const s = this.store;
    if (this.epoch === s.pathEpoch) return;
    const kept = s.pathEpoch === this.epoch + 1 ? s.pathKept : 0;
    this.epoch = s.pathEpoch;
    this.hover = null;
    if (this.pinned !== null && this.pinned >= kept) this.pinned = null;
  }

  private clamp(index: number | null): number | null {
    const n = this.store.path.length;
    if (index === null || n === 0) return null;
    return Math.max(0, Math.min(n - 1, Math.round(index)));
  }

  private touch(): void {
    const d = this.store.dirty;
    d.stream = true;
    d.candidates = true;
    d.gates = true;
    d.timeline = true;
    d.relief = true;
    d.metrics = true;
    d.lens = true;
    d.compare = true;
  }
}
