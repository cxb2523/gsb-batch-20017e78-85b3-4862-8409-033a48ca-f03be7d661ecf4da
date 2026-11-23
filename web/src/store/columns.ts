// The two columns of the Stream with two models: model A on the left, B on
// the right, always side by side.
//
//   lockstep                          free, after the split
//   ┌─ A (driver) ─┬─ B ──────────┐   ┌─ A ──────────┬─ B ──────────┐
//   │ the text     │ B's pick at  │   │ common text  │ B's picks on │
//   │ written      │ each step of │   │ ⑂ A's own    │ the common   │
//   │              │ A's text     │   │   text       │ ⑂ B's lane   │
//   └──────────────┴──────────────┘   └──────────────┴──────────────┘
//
// One column holds the viewed path (the "path column"): the driver's in
// lockstep, the model in front's otherwise. The other column is built here,
// read only: at each position of the common stretch, what the other model
// picked from its own decision; after the split, the tokens of its lane.

import { NONE } from '../source/frames';
import type { EvalData, Slot, Store } from './store';

// A token of the other column.
export interface OtherToken {
  token: number; // token id
  p: number; // the other model's p_raw of this token in its own decision
  pos: number; // index in store.path it corresponds to; -1 for a lane token
  differs: boolean; // its pick is not the token written at `pos`
  split: boolean; // the first token of the lane, right after the split
  js: number; // divergence of the disagreement at `pos`, or -1
}

// The model whose column holds the viewed path.
export function pathSlotOf(s: Store): Slot {
  if (!s.twoModels) return 0;
  // In lockstep the driver writes; while the cursors are still apart (the
  // CURSOR that brings them together has not arrived yet) the path is the
  // model in front's.
  if (s.config?.mode === 'lockstep' && s.split < 0) return s.config.driver === 'B' ? 1 : 0;
  return s.front;
}

// Whether the split markers are shown: the cursors are apart and the other
// model has written something of its own (a cursor left behind on the path
// is not a split).
export function showsSplit(s: Store): boolean {
  return s.twoModels && s.split >= 0 && s.lane.length > 0;
}

// The probability the path column's model gave to the token at `index` of
// the viewed path: from its own decision, else the other model's.
export function pathProbability(s: Store, index: number, pathSlot: Slot): number | undefined {
  const other: Slot = pathSlot === 0 ? 1 : 0;
  const d = s.decisionOf(index, pathSlot) ?? s.decisionOf(index, other);
  return d ? probabilityIn(d, s.token[s.path[index]]) : undefined;
}

// The other column: for each generated position of the common stretch (all
// of the path without a split, up to `split` with one), the other model's
// pick in its decision of that position; positions it did not evaluate are
// left out. Then, after a split, the tokens of the other model's lane.
export function otherColumn(s: Store, otherSlot: Slot, pathSlot: Slot): OtherToken[] {
  const out: OtherToken[] = [];
  const end = s.split >= 0 ? s.split : s.path.length - 1;
  for (let i = s.promptLength; i <= end; i++) {
    const e = s.decisionOf(i, otherSlot);
    if (!e || e.pick >= e.tokens.length) continue;
    const token = e.tokens[e.pick];
    const differs = token !== s.token[s.path[i]];
    out.push({
      token,
      p: e.pRaw[e.pick],
      pos: i,
      differs,
      split: false,
      js: differs ? (s.pairAt(i)?.js ?? -1) : -1,
    });
  }
  if (s.split >= 0) {
    for (let j = 0; j < s.lane.length; j++) {
      const parent = j === 0 ? s.path[s.split] : s.lane[j - 1];
      const node = s.lane[j];
      const token = s.token[node];
      const d = parent === NONE ? undefined : (s.evals[otherSlot][parent] ?? s.evals[pathSlot][parent]);
      out.push({ token, p: probabilityIn(d, token) ?? 0, pos: -1, differs: false, split: j === 0, js: -1 });
    }
  }
  return out;
}

// Number of positions where the other model's pick differs from the text.
export function countDiffers(items: readonly OtherToken[]): number {
  let n = 0;
  for (const t of items) if (t.differs) n++;
  return n;
}

// What a column is, under its model's name.
export function roleText(s: Store, slot: Slot, pathSlot: Slot): string {
  if (!s.twoModels) return '';
  if (s.config?.mode === 'lockstep' && s.split < 0) {
    return slot === pathSlot ? 'writes the text (driver)' : `what ${slot === 0 ? 'A' : 'B'} would pick at each step`;
  }
  return 'its own text';
}

function probabilityIn(d: EvalData | undefined, token: number): number | undefined {
  if (!d) return undefined;
  for (let i = 0; i < d.tokens.length; i++) {
    if (d.tokens[i] === token) return d.pRaw[i];
  }
  return undefined;
}
