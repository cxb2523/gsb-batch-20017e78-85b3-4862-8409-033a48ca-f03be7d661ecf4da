// Pure helpers for the gate chain of a decision: the value of an entry at
// each stage, the "rest" row, which entries a gate cuts, and the labels of
// the gate strip. No DOM: tested with Vitest.
//
// Stages of a decision with n gates, and the continuous position `x` that
// animation 2 runs along (0 → n):
//
//   stage    raw      gate 0     gate 1    …   gate n−1
//   x         0 ────────── 1 ─────── 2 ── … ──── n
//                 segment 0   segment 1
//
// Entering segment g (x just above g) means crossing gate g: the entries it
// cuts drop to 0 at once (their bars break into particles) and the rest move
// linearly from their value before the gate to their value after it.

import type { EvalFrame } from '../source/frames';

// What the stage helpers read from an EVAL.
export type StageSource = Pick<EvalFrame, 'nGates' | 'pRaw' | 'stageP' | 'rawMass'>;

// Probability of entry `i` at stage `s`: -1 is raw (p_raw), g is after gate
// g (stage_p row g). A stage past the last gate reads the last row.
export function stageValue(e: StageSource, s: number, i: number): number {
  if (s < 0 || e.nGates <= 0) return e.pRaw[i];
  const g = s < e.nGates ? s : e.nGates - 1;
  return e.stageP[g * e.pRaw.length + i];
}

// The stage position of a selected gate: 0 for raw, g + 1 after gate g.
// A gate the decision does not have shows raw.
export function stagePosition(e: StageSource, gate: number): number {
  return gate >= 0 && gate < e.nGates ? gate + 1 : 0;
}

// The segment `x` falls in: the gate being crossed, from 0 to nGates − 1;
// -1 at raw (x ≤ 0 or no gates).
export function segmentOf(e: StageSource, x: number): number {
  if (!(x > 0) || e.nGates <= 0) return -1;
  return Math.min(e.nGates - 1, Math.ceil(x) - 1);
}

// Probability of entry `i` at position `x` (see the drawing above).
export function valueAt(e: StageSource, x: number, i: number): number {
  const g = segmentOf(e, x);
  if (g < 0) return e.pRaw[i];
  const after = stageValue(e, g, i);
  if (after <= 0) return 0; // cut by this gate or an earlier one
  const before = stageValue(e, g - 1, i);
  const f = Math.min(1, x - g);
  return before + (after - before) * f;
}

// Whether entry `i` is cut at position `x`: it no longer survives there.
export function cutAt(e: StageSource, x: number, i: number): boolean {
  const g = segmentOf(e, x);
  return g >= 0 && !(stageValue(e, g, i) > 0);
}

// Probability of the rest of the vocabulary at stage `s`: 1 − raw_mass at
// raw; after a gate, what its surviving entries leave out.
export function stageRest(e: StageSource, s: number): number {
  if (s < 0 || e.nGates <= 0) return Math.max(0, 1 - e.rawMass);
  const n = e.pRaw.length;
  const g = s < e.nGates ? s : e.nGates - 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += e.stageP[g * n + i];
  return Math.max(0, 1 - sum);
}

// The rest at position `x`, moving linearly across each segment.
export function restAt(e: StageSource, x: number): number {
  const g = segmentOf(e, x);
  if (g < 0) return stageRest(e, -1);
  const before = stageRest(e, g - 1);
  const after = stageRest(e, g);
  return before + (after - before) * Math.min(1, x - g);
}

// Whether gate `g` cuts entry `i`: it was alive before the gate and is not
// after it.
export function cutBy(e: StageSource, g: number, i: number): boolean {
  if (g < 0 || g >= e.nGates) return false;
  return stageValue(e, g - 1, i) > 0 && !(stageValue(e, g, i) > 0);
}

// Entries cut by gate `g`, in EVAL order.
export function cutList(e: StageSource, g: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.pRaw.length; i++) if (cutBy(e, g, i)) out.push(i);
  return out;
}

// Whether gate `g` is crossed when the position moves from `prev` to `x`:
// prev ≤ g < x. Each gate of a run is crossed in exactly one frame.
export function crosses(prev: number, x: number, g: number): boolean {
  return g >= 0 && prev <= g && g < x;
}

// Whether a decision has the stage at position `x`: "raw" always, the
// segment of gate g only if it has that gate.
export function hasStage(e: StageSource, x: number): boolean {
  return !(x > 0) || Math.ceil(x) <= e.nGates;
}

// -------------------------------------------------------- the strip

// Short label of a gate: "grammar", "top-k 40", "top-p 0.95", "temp 0.8".
// A type this reader does not know shows as it came.
export function gateLabel(g: { type: string } & Record<string, unknown>): string {
  switch (g.type) {
    case 'grammar':
      return 'grammar';
    case 'penalties':
      return 'penalties';
    case 'top_k':
      return `top-k ${num(g.k)}`;
    case 'top_p':
      return `top-p ${num(g.p)}`;
    case 'min_p':
      return `min-p ${num(g.p)}`;
    case 'temp':
      return `temp ${num(g.t)}`;
    default:
      return String(g.type);
  }
}

// The same in a handful of characters, for a strip with many gates:
// "gr", "pen", "k40", "p.95", "m.05", "t.8".
export function gateShortLabel(g: { type: string } & Record<string, unknown>): string {
  const short = (v: unknown): string => num(v).replace(/^0\./, '.');
  switch (g.type) {
    case 'grammar':
      return 'gr';
    case 'penalties':
      return 'pen';
    case 'top_k':
      return `k${short(g.k)}`;
    case 'top_p':
      return `p${short(g.p)}`;
    case 'min_p':
      return `m${short(g.p)}`;
    case 'temp':
      return `t${short(g.t)}`;
    default:
      return String(g.type).slice(0, 3);
  }
}

// A count in a few characters: "40", "1.2k", "248k", "1.5M".
export function compactCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 9950) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 999500) return `${Math.round(n / 1000)}k`;
  if (n < 9950000) return `${trim((n / 1e6).toFixed(1))}M`;
  return `${Math.round(n / 1e6)}M`;
}

// A parameter as the user typed it: at most three decimals, no float noise.
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${+v.toFixed(3)}` : '?';
}

function trim(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
