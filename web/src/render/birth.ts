// Animation 1, token birth: when the viewed path gains a token, its row in
// Candidates lights up and a copy flies to its place in the Stream, where it
// settles with a brief glow in the colour of its column. Only for the viewed
// path (the path column), never for the other model's column.
// 120–400 ms; shortened or skipped when tokens come fast, never queued;
// nothing with prefers-reduced-motion.

import type { Store } from '../store/store';
import type { View } from '../store/view';
import type { CandidatesPanel, Flash } from './candidates';
import { Pace } from './pace';
import type { StreamPanel } from './stream';

const MAX_MS = 320;
const MIN_MS = 120;

export class Birth {
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly fly: HTMLSpanElement;
  private readonly pace = new Pace();
  private t0 = 0;
  private dur = 0;
  private entry = -1; // Candidates row being lit
  private anim: Animation | null = null;
  private hidden: HTMLElement | null = null; // span waiting for its copy

  constructor(
    private readonly store: Store,
    private readonly view: View,
    private readonly stream: StreamPanel,
    private readonly candidates: CandidatesPanel,
  ) {
    this.fly = document.createElement('span');
    this.fly.className = 'fly';
    document.body.append(this.fly);
  }

  // The token at `index` has just been appended to the viewed path. Called
  // after the Stream and Candidates have been updated for it.
  born(now: number, index: number): void {
    const interval = this.pace.next(now);
    this.cancel();
    if (this.reduced.matches) return;
    const dur = Math.min(MAX_MS, interval * 0.85);
    if (dur < MIN_MS) return; // too fast to animate each token

    // Candidates shows this decision only without a selection.
    const d = this.store.decision(index);
    const span = this.stream.spanAt(index);
    if (!d || !span || this.view.pinnedIndex() !== null || this.view.hoveredIndex() !== null) return;

    const token = this.store.token[this.store.path[index]];
    let entry = d.tokens.indexOf(token);
    if (entry < 0) entry = d.pick;
    this.t0 = now;
    this.dur = dur;
    this.entry = entry;

    const from = this.candidates.rowRect(d, entry);
    const to = this.stream.visibleRect(span);
    // A half character waits for the next token: nothing worth flying yet.
    if (!from || !to || span.textContent?.includes('�')) {
      settle(span);
      return;
    }
    this.fly.textContent = span.textContent;
    this.fly.style.left = `${to.left}px`;
    this.fly.style.top = `${to.top}px`;
    this.fly.style.display = 'block';
    span.style.visibility = 'hidden';
    this.hidden = span;
    this.anim = this.fly.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(0.85)`, opacity: 0.5 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ],
      { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
    this.anim.onfinish = () => this.land();
  }

  // The lit Candidates row for this animation frame, or null.
  flash(now: number): Flash | null {
    if (this.entry < 0) return null;
    const k = (now - this.t0) / this.dur;
    if (k >= 1) {
      this.entry = -1;
      return null;
    }
    return { entry: this.entry, alpha: 1 - k };
  }

  get active(): boolean {
    return this.entry >= 0;
  }

  // Ends whatever is running at once: the text is never held back.
  cancel(): void {
    this.entry = -1;
    if (this.anim) {
      this.anim.onfinish = null;
      this.anim.cancel();
      this.anim = null;
    }
    this.fly.style.display = 'none';
    if (this.hidden) {
      this.hidden.style.visibility = '';
      this.hidden = null;
    }
  }

  private land(): void {
    const span = this.hidden;
    this.anim = null;
    this.hidden = null;
    this.fly.style.display = 'none';
    if (span) {
      span.style.visibility = '';
      settle(span);
    }
  }
}

// The brief glow of a token taking its place (CSS animation, removed after).
function settle(span: HTMLElement): void {
  span.classList.add('born');
  span.addEventListener('animationend', () => span.classList.remove('born'), { once: true });
}
