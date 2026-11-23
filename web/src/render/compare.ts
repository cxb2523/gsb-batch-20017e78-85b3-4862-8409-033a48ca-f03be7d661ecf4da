// Pure helpers for the two-model views of Candidates and Timeline: the
// figures as text, the other model's probability for a row, and the layout
// of the Timeline bands. No DOM: tested with Vitest.

import { NONE, PAIR_APPROX, PAIR_SAME_TOP, type PairFrame } from '../source/frames';

// ------------------------------------------------------------ figures

// A probability as a short percentage (at most 5 characters), for the narrow
// columns of facing bars: "41%", "4.1%", "<0.1%".
export function pctShort(p: number): string {
  if (!(p > 0)) return '0%';
  if (p < 0.001) return '<0.1%';
  if (p < 0.0995) return `${(p * 100).toFixed(1)}%`;
  return `${Math.round(p * 100)}%`;
}

// "Less than p": a token missing from a model's entries.
export function pctBelow(p: number): string {
  return p < 0.001 ? '<0.1%' : `<${pctShort(p)}`;
}

// A quantity in bits (entropy, divergence): more decimals when small.
// Infinity → "∞"; NaN → "?". Rounding noise below zero shows as 0.
export function bitsText(x: number): string {
  if (x === Infinity) return '∞';
  if (Number.isNaN(x)) return '?';
  const v = Math.max(0, x);
  if (v < 1) return v.toFixed(3);
  if (v < 10) return v.toFixed(2);
  return v.toFixed(1);
}

// Effective number of candidates, 2^entropy.
export function effText(entropy: number): string {
  const eff = Math.pow(2, entropy);
  if (eff < 10) return eff.toFixed(2);
  if (eff < 100) return eff.toFixed(1);
  return `${Math.round(eff)}`;
}

// A rank counted from 1 ("#1" is the most likely); NONE → "?".
export function rankText(rank: number): string {
  return rank === NONE ? '?' : `#${rank + 1}`;
}

// The figures of one model's decision: entropy, effective number of
// candidates and the probability of the token it picked.
export function modelFigures(e: { entropy: number; pRaw: ArrayLike<number>; pick: number }): string {
  const chosen = e.pick < e.pRaw.length ? e.pRaw[e.pick] : 0;
  return `H ${e.entropy.toFixed(2)} bits · eff ${effText(e.entropy)} · chosen ${pctShort(chosen)}`;
}

// The figures of a PAIR on two lines. Approximate values carry "≈".
//   JS 0.031 · KL A‖B 0.120 · B‖A 0.100
//   top differs · rank A→B #2 · B→A #1
// "rank A→B" is the rank in B of A's most likely token, counted from 1.
export function pairFigures(p: PairFrame): [string, string] {
  const ap = approx(p);
  const rank = (r: number): string => (r === NONE ? '?' : ap + rankText(r));
  const same = (p.flags & PAIR_SAME_TOP) !== 0;
  return [
    `${jsFigure(p)} · KL A‖B ${ap}${bitsText(p.klAB)} · B‖A ${ap}${bitsText(p.klBA)}`,
    `top ${same ? 'same' : 'differs'} · rank A→B ${rank(p.rankAInB)} · B→A ${rank(p.rankBInA)}`,
  ];
}

// The divergence of a PAIR as in its figures ("JS 0.031", "JS ≈0.031"), for
// the Timeline's line of the selected position.
export function jsFigure(p: PairFrame): string {
  return `JS ${approx(p)}${bitsText(p.js)}`;
}

// One model's cells in the figures table of Candidates:
//
//            picked     prob   entropy     options
//   A ●     "reuses"     41%   1.75 bits     3.36
//
// prob is the probability of the token it picked; options, the effective
// number of candidates (2^entropy).
export interface ModelCells {
  prob: string;
  entropy: string;
  options: string;
}

export function modelCells(e: { entropy: number; pRaw: ArrayLike<number>; pick: number }): ModelCells {
  const chosen = e.pick < e.pRaw.length ? e.pRaw[e.pick] : 0;
  return { prob: pctShort(chosen), entropy: `${e.entropy.toFixed(2)} bits`, options: effText(e.entropy) };
}

// The figures of a PAIR as labelled chips and a plain sentence for the
// ranks. Approximate values carry "≈".
//   divergence  0.031 bit
//   KL A‖B · B‖A  0.120 · 0.100
//   A's top token: #2 for B · B's top: #1 for A
export interface PairChips {
  divergence: string;
  kl: string;
  ranks: string;
}

export function pairChips(p: PairFrame): PairChips {
  const ap = approx(p);
  const rank = (r: number, other: string): string => (r === NONE ? `not in ${other}'s list` : `${ap}${rankText(r)} for ${other}`);
  const ranks =
    (p.flags & PAIR_SAME_TOP) !== 0
      ? 'Both put the same token first'
      : `A's top token: ${rank(p.rankAInB, 'B')} · B's top: ${rank(p.rankBInA, 'A')}`;
  return {
    divergence: `${ap}${bitsText(p.js)} bit`,
    kl: `${ap}${bitsText(p.klAB)} · ${ap}${bitsText(p.klBA)}`,
    ranks,
  };
}

// "≈" for an approximate PAIR, else nothing.
function approx(p: PairFrame): string {
  return (p.flags & PAIR_APPROX) !== 0 ? '≈' : '';
}

// ------------------------------------------------- a row, seen by a model

// Probability a model gives to `token` among its entries, or -1 if the
// token is not listed.
export function probOf(tokens: ArrayLike<number>, pRaw: ArrayLike<number>, token: number): number {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === token) return pRaw[i];
  }
  return -1;
}

// Upper bound for the probability of a token a model does not list: its
// lowest main entry. Extra entries are not the most likely ones, so a
// missing token may be above them, never above the main ones.
export function lowestMain(pRaw: ArrayLike<number>, nRaw: number): number {
  const n = Math.min(nRaw, pRaw.length);
  if (n <= 0) return 0;
  let low = pRaw[0];
  for (let i = 1; i < n; i++) if (pRaw[i] < low) low = pRaw[i];
  return low;
}

// ------------------------------------------------------ Timeline bands

// Vertical layout of the Timeline with two models, in CSS px:
//
//   top ─────────────── entropy A grows up from aBase
//   aBase ───────────── divergence (js) grows up from dBase, 0..1 bit
//          dTop..dBase
//          marks: discrepancy triangles stand on markY
//   bBase ───────────── entropy B grows down from bBase
//   bottom
export interface Bands {
  aTop: number;
  aBase: number;
  dTop: number;
  dBase: number;
  markY: number;
  bBase: number;
  bBottom: number;
}

export const MARK_STRIP = 10; // room under the divergence trace for the triangles

export function timelineBands(h: number, top: number, bottom: number): Bands {
  const avail = Math.max(0, h - top - bottom);
  const hD = Math.min(avail, Math.max(24, Math.min(56, Math.round(avail * 0.24))));
  const hE = Math.max(0, Math.floor((avail - hD) / 2));
  const aBase = top + hE;
  const bBase = top + avail - hE; // the central band takes the odd pixel
  const markY = bBase - 2;
  const dBase = Math.max(aBase, bBase - MARK_STRIP - 1);
  const dTop = Math.min(dBase, aBase + 4);
  return { aTop: top, aBase, dTop, dBase, markY, bBase, bBottom: top + avail };
}

// The box of the traces in a Timeline `h` px tall: below the header (`top`)
// and above what goes under them (`below`: axis and minimap), at most `max`
// px tall and centred in the room left, so a tall dock does not stretch the
// traces absurdly.
export function traceBox(h: number, top: number, below: number, max: number): { top: number; bottom: number } {
  const avail = Math.max(0, h - top - below);
  const used = Math.min(avail, Math.max(0, max));
  const t = top + Math.floor((avail - used) / 2);
  return { top: t, bottom: t + used };
}

// Width of a discrepancy triangle for a horizontal step per position: as
// wide as a position when there is room, never under 5 px. Triangles closer
// than their width are thinned (see timeline.ts), so they never smear.
export function markWidth(step: number): number {
  return Math.max(5, Math.min(8, Math.floor(step) - 1));
}

// -------------------------------------------------------- Compare view
//
// The Inspector's Compare view (comparepanel.ts) puts A and B face to face
// at one position. These helpers turn two EVALs and a PAIR into its figures
// and the rows of its butterfly chart.

// What the Compare view reads of an EVAL: entries in order (the first nRaw
// are the main ones, the most likely; extras follow) and their p_raw.
export interface Dist {
  tokens: ArrayLike<number>;
  pRaw: ArrayLike<number>;
  nRaw: number;
}

// The overlap of the main entries (top-32) of two models.
//   shared      tokens in both lists
//   union       tokens in either list
//   jaccard     shared / union, 0..1 (0 when both are empty)
//   commonMass  Σ min(pA, pB) over the shared tokens, 0..1: the probability
//               both models agree to spend on the same tokens
export interface Overlap {
  shared: number;
  union: number;
  jaccard: number;
  commonMass: number;
}

export function overlap(a: Dist, b: Dist): Overlap {
  const na = mainCount(a);
  const nb = mainCount(b);
  let shared = 0;
  let commonMass = 0;
  for (let i = 0; i < na; i++) {
    const t = a.tokens[i];
    for (let j = 0; j < nb; j++) {
      if (b.tokens[j] !== t) continue;
      shared++;
      commonMass += Math.min(a.pRaw[i], b.pRaw[j]);
      break;
    }
  }
  const union = na + nb - shared;
  return { shared, union, jaccard: union > 0 ? shared / union : 0, commonMass: Math.min(1, commonMass) };
}

// One row of the butterfly: a token and the probability each model gives
// it, or -1 when that model does not list it.
export interface ButterflyRow {
  token: number;
  pA: number;
  pB: number;
}

// The rows of the butterfly: every token either model lists (main and extra
// entries), most likely first by the larger of the two probabilities; ties
// by token id, so the order is stable. A missing model gives no rows.
export function butterflyRows(a: Dist | undefined, b: Dist | undefined): ButterflyRow[] {
  const byToken = new Map<number, ButterflyRow>();
  const add = (d: Dist | undefined, side: 'pA' | 'pB'): void => {
    if (!d) return;
    const n = Math.min(d.tokens.length, d.pRaw.length);
    for (let i = 0; i < n; i++) {
      const t = d.tokens[i];
      let r = byToken.get(t);
      if (r === undefined) {
        r = { token: t, pA: -1, pB: -1 };
        byToken.set(t, r);
      }
      r[side] = Math.max(0, d.pRaw[i]);
    }
  };
  add(a, 'pA');
  add(b, 'pB');
  const rows = Array.from(byToken.values());
  rows.sort((x, y) => Math.max(y.pA, y.pB) - Math.max(x.pA, x.pB) || x.token - y.token);
  return rows;
}

// Rank of `token` among the main entries of `d` (0 is first), or NONE when
// it is not one of them: an extra entry has a probability but no known rank.
export function rankIn(d: Dist, token: number): number {
  const n = mainCount(d);
  let p = -1;
  for (let i = 0; i < n; i++) {
    if (d.tokens[i] === token) {
      p = d.pRaw[i];
      break;
    }
  }
  if (p < 0) return NONE;
  let rank = 0;
  for (let i = 0; i < n; i++) if (d.pRaw[i] > p) rank++;
  return rank;
}

// The cross rank of a model's pick: its rank in the other model's list.
// Read from the other's EVAL; when the pick is not among its main entries,
// the PAIR may still know the rank of the picking model's most likely token
// over the whole vocabulary (`pairRank`), which is the pick when the model
// picked its top.
export function pickRank(mine: Dist & { pick: number }, other: Dist, pairRank: number | undefined): number {
  const token = mine.tokens[mine.pick];
  const r = rankIn(other, token);
  if (r !== NONE || pairRank === undefined) return r;
  return rankIn(mine, token) === 0 ? pairRank : NONE;
}

// A cross rank in words, in three parts so the figure can be drawn apart
// and `pre` dropped when the whole does not fit:
//   "A’s pick is " "#2" " for B"      "A’s pick: " "" "not in B’s top 32"
// `nTop` is the length of the other model's main list.
export interface RankWords {
  pre: string;
  fig: string;
  post: string;
}

export function rankWords(rank: number, owner: 'A' | 'B', other: 'A' | 'B', nTop: number): RankWords {
  if (rank === NONE) return { pre: `${owner}’s pick: `, fig: '', post: `not in ${other}’s top ${nTop}` };
  return { pre: `${owner}’s pick is `, fig: `#${rank + 1}`, post: ` for ${other}` };
}

// Length of a KL bar, 0..1, on a log scale from 0.001 bit (0) to 10 bits
// (1): the divergence of two quantizations of one model is often a few
// hundredths of a bit, and one of unrelated models several bits. Infinity
// fills the bar; NaN and zero leave it empty.
export const KL_MIN = 0.001;
export const KL_MAX = 10;

export function klScale(kl: number): number {
  if (kl === Infinity) return 1;
  if (!(kl > KL_MIN)) return 0;
  return Math.min(1, Math.log(kl / KL_MIN) / Math.log(KL_MAX / KL_MIN));
}

function mainCount(d: Dist): number {
  return Math.max(0, Math.min(d.nRaw, d.tokens.length, d.pRaw.length));
}
