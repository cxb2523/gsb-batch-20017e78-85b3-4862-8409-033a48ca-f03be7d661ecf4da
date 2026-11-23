// Pure geometry and text of the branch tree at the bottom of the Timeline:
// how many rows it takes, which row each branch goes in, where a branch line
// runs, which branch a point falls on, and the preview of a branch's text.
// No DOM: tested with Vitest.
//
//   main ━━━━━━━━┯━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━●  the viewed path, its cursors
//   row 0        ╰─◇───────|   ╰──────────────●     a branch curves out of its
//   row 1          ╰──────────────//                fork and runs to its tip
//   row 2 …                                         the last row takes the rest
//
// ◇ a branch the user chose; at the tip, why it stopped: | end of
// generation, // max tokens, ■ context full.

import { STOP_CONTEXT_FULL, STOP_EOG, STOP_MAX_TOKENS } from '../source/frames';

export const MAP_ROWS = 6; // most rows of branches under the main line
export const ROW_H = 11; // px from one row to the next
export const TREE_GAP = 9; // from the position labels to the main line
export const TREE_FOOT = 10; // under the main line or the last row
export const CURVE_W = 12; // px the curve from a fork to the first row takes

// A branch line as drawn: it leaves the main line at x0 with a curve `c` px
// wide that lands on its row at height y, then runs straight to x1.
export interface MapLine {
  x0: number;
  x1: number;
  y: number;
  c: number;
}

// Height of the tree with `rows` rows of branches (0: only the main line).
export function treeHeight(rows: number): number {
  return TREE_GAP + rows * ROW_H + TREE_FOOT;
}

// Rows the tree may take when `room` px are left once the traces have their
// least height: at least one, at most MAP_ROWS.
export function maxRows(room: number): number {
  return Math.max(1, Math.min(MAP_ROWS, Math.floor((room - treeHeight(0)) / ROW_H)));
}

// Greedy row assignment by x interval: each [start, end] (in drawing order,
// by start) goes in the first row whose last line ends more than `gap`
// before it starts. What fits nowhere is piled on the last row.
export function assignRows(spans: readonly (readonly [number, number])[], rows = MAP_ROWS, gap = 4): number[] {
  const ends = new Array<number>(rows).fill(-Infinity);
  const out: number[] = [];
  for (const [start, end] of spans) {
    let r = 0;
    while (r < rows && start - ends[r] <= gap) r++;
    if (r === rows) r = rows - 1;
    ends[r] = Math.max(ends[r], end);
    out.push(r);
  }
  return out;
}

// Rows in use given assignRows' output: one more than the highest.
export function rowsUsed(rows: readonly number[]): number {
  let n = 0;
  for (const r of rows) n = Math.max(n, r + 1);
  return n;
}

// Height of a branch line at `x` within its curve: a smoothstep from the
// main line to its row, close to the cubic Bézier the Timeline draws.
export function curveY(l: MapLine, x: number, mainY: number): number {
  if (!(l.c > 0)) return l.y;
  const u = Math.min(1, Math.max(0, (x - l.x0) / l.c));
  return mainY + (l.y - mainY) * u * u * (3 - 2 * u);
}

// Index of the branch line under (x, y), or -1. A line is hit within `tol`
// px of its straight run or of its curve; never on the main line itself
// (that is the viewed path, not a branch). Lines piled on one row: the one
// drawn last (on top) wins.
export function hitBranch(lines: readonly MapLine[], x: number, y: number, mainY: number, tol = 4): number {
  if (y <= mainY + 2) return -1;
  let hit = -1;
  let best = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const end = Math.max(l.x1, l.x0 + l.c);
    if (x < l.x0 - 1 || x > end + tol) continue;
    const d = Math.abs(y - (x < l.x0 + l.c ? curveY(l, x, mainY) : l.y));
    if (d <= tol && d <= best) {
      best = d;
      hit = i;
    }
  }
  return hit;
}

// Node ids from `from` down to `tip`, given the parent of each node: the
// branch as the Timeline previews it. Empty if `tip` does not descend from
// `from`.
export function branchNodes(parent: readonly number[], from: number, tip: number): number[] {
  const out: number[] = [];
  for (let n = tip; n !== undefined && n >= 0; n = parent[n]) {
    out.push(n);
    if (n === from) return out.reverse();
  }
  return [];
}

// The start of a branch's text, from the bytes of its tokens: decoded as one
// run (a character may be split between tokens), whitespace folded into
// single spaces with line breaks shown as "↵", control characters dropped,
// cut at `max` characters with an ellipsis.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function previewText(bytes: readonly Uint8Array[], max = 60): string {
  // Enough bytes for `max` characters and a few to spare; never all of a
  // long branch.
  let len = 0;
  let k = 0;
  while (k < bytes.length && len < max * 4 + 8) len += bytes[k++].length;
  const all = new Uint8Array(len);
  let at = 0;
  for (let i = 0; i < k; i++) {
    all.set(bytes[i], at);
    at += bytes[i].length;
  }
  const text = decoder
    .decode(all)
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .replace(/[ \t]*\n\s*/g, ' ↵ ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length <= max && k === bytes.length) return text;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

// Why a node cannot be continued, as the glyph at the end of its line and
// the words of the hover chip.
export type StopGlyph = 'end' | 'cut' | 'full';

export function stopGlyph(reason: number | undefined): StopGlyph | null {
  if (reason === STOP_EOG) return 'end';
  if (reason === STOP_MAX_TOKENS) return 'cut';
  if (reason === STOP_CONTEXT_FULL) return 'full';
  return null;
}

export const STOP_WORDS: Record<StopGlyph, string> = {
  end: 'ended: end of generation',
  cut: 'cut: max tokens reached',
  full: 'cut: context full',
};
