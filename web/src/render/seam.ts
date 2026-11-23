// The seam: where A and B first diverge, drawn between the two Stream
// columns. The columns wrap independently, so the same position sits at
// different heights; the seam joins the line of that position in the left
// column with its line in the right one, inside the gap between them, so it
// never crosses the text. A dot at each end, a small "#N" label over it when
// it fits, and a short bar at the outer edge of each column at that line.
//
//      left column       gap      right column
//   ▌ the cat [sat] on   ●╮
//                         │
//                         ╰●  the cat [is]      ▐
//
// Pure: it takes rectangles relative to one origin (the SVG drawing it) and
// returns what to draw. Nothing here touches the DOM.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

// A bar at the outer edge of a column.
export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SeamGeometry {
  path: string; // the curve, '' when only one side has the position
  dots: Point[]; // its two ends, or none
  label: { x: number; y: number; text: string } | null;
  marks: Mark[]; // one per side that has the position
  mid: number; // height to centre on: the curve's middle, or the lone token's line
}

export const SEAM_INSET = 5; // from each column edge to the end of the curve
export const SEAM_DOT = 2.5; // dot radius
export const MARK_W = 3;
export const MARK_OUT = 6; // from the column's outer edge to its bar
const LABEL_GAP = 8; // from the upper end of the curve to the label's baseline
const LABEL_H = 9; // the label's height over its baseline
const LABEL_PAD = 2; // free room each side of the label in the gap

// What to draw for the token at the first disagreement in the left column
// (`left`) and in the right one (`right`), either of which may be missing.
// `gapL` and `gapR` are the right edge of the left column and the left edge
// of the right one; `outerL` and `outerR`, the outer edges. `charW` is the
// width of a label character. Null when neither side has the position.
export function seamGeometry(
  left: Rect | null,
  right: Rect | null,
  gapL: number,
  gapR: number,
  outerL: number,
  outerR: number,
  label = '',
  charW = 6.6,
): SeamGeometry | null {
  if (!left && !right) return null;
  const marks: Mark[] = [];
  if (left) marks.push(mark(left, outerL - MARK_OUT - MARK_W));
  if (right) marks.push(mark(right, outerR + MARK_OUT));

  const x0 = gapL + SEAM_INSET;
  const x1 = gapR - SEAM_INSET;
  if (!left || !right || x1 - x0 < 2 * SEAM_DOT) {
    // One side only (or no room in the gap): no curve.
    const r = (left ?? right) as Rect;
    const mid = left && right ? (centre(left) + centre(right)) / 2 : centre(r);
    return { path: '', dots: [], label: null, marks, mid: round(mid) };
  }

  const y0 = centre(left);
  const y1 = centre(right);
  const xm = (x0 + x1) / 2;
  // A cubic whose control points stay within [x0, x1]: the curve stays in
  // the gap (it lies in the hull of its control points).
  const path = `M${n(x0)} ${n(y0)} C${n(xm)} ${n(y0)} ${n(xm)} ${n(y1)} ${n(x1)} ${n(y1)}`;
  const dots = [
    { x: round(x0), y: round(y0) },
    { x: round(x1), y: round(y1) },
  ];

  // The label sits over the upper end, centred in the gap, when it fits.
  let lab: SeamGeometry['label'] = null;
  const top = Math.min(y0, y1);
  const fits = label.length * charW <= gapR - gapL - 2 * LABEL_PAD && top - LABEL_GAP - LABEL_H >= 0;
  if (label && fits) lab = { x: round((gapL + gapR) / 2), y: round(top - LABEL_GAP), text: label };

  return { path, dots, label: lab, marks, mid: round((y0 + y1) / 2) };
}

function mark(r: Rect, x: number): Mark {
  const h = Math.max(4, r.bottom - r.top);
  return { x: round(x), y: round(centre(r) - h / 2), w: MARK_W, h: round(h) };
}

function centre(r: Rect): number {
  return (r.top + r.bottom) / 2;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function n(v: number): string {
  return String(round(v));
}
