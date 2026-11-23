// Candidates (Canvas 2D): the decision of the selected token, or of the last
// one. One row per EVAL entry in its order and a final "rest" row with
// 1 − raw_mass.
//
// Bars and percentages show one stage of the gate chain (render/stages.ts):
// the gate selected in the strip ("raw" by default), or the position of
// animation 2 while it runs. Rows never move: the bars change in place, and
// a row cut by then is dimmed and has no bar.
//
// One model: a bar to the right proportional to p_raw.
// Two models: facing bars from a central axis, A to the left, B to the right,
// on the same scale.
//
//   Position #57 · after top-p 0.95            ● Pinned · Esc to release
//   ╭─────────╮
//   │ reuses  │                                     [▲ picks differ]
//   ╰─────────╯
//         picked          prob    entropy   options
//   (A)   "reuses"         41%   1.75 bits     3.36
//   (B)   "shares"         33%   2.00 bits     4.00
//   (divergence 0.031 bit) (KL A‖B · B‖A 0.120 · 0.100)
//   A's top token: #2 for B · B's top: #1 for A
//                 A │ B
//   ●  41%   ━━━━│━━━   33%    reuses      ← the path's token: a halo
//      38%    ━━━│━━━━  44% ●  shares
//       9%      ━│░    <4.1%   keeps
//      12%     ━━│━━    16%    rest
//   ⑂ Click a row to branch from here
//
// Bars are pills on a faint track, in a gradient of the model's colour:
// the longer, the brighter. The model's pick glows. One model has a row of
// chips (picked, entropy, options) instead of the table. A click on a
// candidate row branches with that token under the decision's node (live
// only; not "rest", not the header); the row under the pointer says so.

import { ATTR_CONTROL, ORIGIN_PROMPT, PAIR_SAME_PICK, type PairFrame, type VocabEntry } from '../source/frames';
import type { EvalData, Slot, Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import { lowestMain, modelCells, pairChips, pctBelow, pctShort, type ModelCells, type PairChips } from './compare';
import type { RunState } from './gaterun';
import { drawIcon } from './icons';
import { cutAt, cutBy, gateLabel, gateShortLabel, hasStage, restAt, stagePosition, valueAt } from './stages';
import { Surface } from './surface';
import { COLOR, MODEL_COLOR, RADIUS, SIZE, font, rgba, roundRect, uiFont } from './theme';

// Row lit by the token birth (animation 1).
export interface Flash {
  entry: number;
  alpha: number; // 1 → 0
}

const PAD = 16;
export const ROW_H = 22;
const LABEL_CHARS = 14;
const PCT_CHARS = 6;

// The header, from the top (CSS px, middle of each line).
const TOP_Y = 16; // the position, the stage shown, the selection state
const TOKEN_Y = 46; // the selected token, big; with two models, "picks differ"
const TOKEN_PX = 19; // its type size
const MSG_Y = 82; // empty states, under the token line
// One model: a row of chips, then the rows.
const CHIPS_Y_1 = 82;
const ROWS_TOP_1 = 104;
// Two models: the table of both models, the pair's chips, the ranks.
const HEAD_Y = 80; // column names of the table
const TABLE_Y = [98, 116] as const; // A, B
const CHIPS_Y_2 = 141;
const RANKS_Y = 163; // only when the panel is tall enough (ROOMY_H)
const ROWS_TOP_2 = 188;
const ROWS_TOP_2_COMPACT = 170;
const ROOMY_H = 440;
const SIDES_ABOVE = 9; // "A" and "B" over the axis: this far above the rows
const CHIP_H = 20;
const HINT_H = 24; // "Click a row to branch from here", under the rows

const PCT_CHARS_2 = 5; // pctShort() is at most 5 characters
const UNLIT = '#c5ccd6'; // labels of rows that are neither followed nor lit
const UNLIT_ALPHA = 0.82;
const CUT_ALPHA = 0.3; // rows cut by a gate at the stage shown
const BAR_H = 8;
const BAR_TOP = (ROW_H - BAR_H) / 2; // bar inside its row
const BAR_ALPHA = 0.62; // bars of rows that are not the model's pick
const MAX_ROWS = 512; // n_raw (u8) + n_extra (≤ 8)
const SLOTS = [0, 1] as const;
const LETTER = ['A', 'B'] as const;

// Colours built once: painting builds no strings.
const TRACK = rgba(COLOR.high, 0.05);
const HOVER = rgba(COLOR.high, 0.055);
const HAIR = rgba(COLOR.high, 0.08);
const TOKEN_BG = rgba(COLOR.high, 0.06);
const TOKEN_LINE = rgba(COLOR.high, 0.1);
const PILL_BG = rgba(COLOR.surface3, 0.96);
const PILL_LINE = rgba(COLOR.high, 0.18);
const DIS_BG = rgba(COLOR.dis, 0.12);
const DIS_LINE = rgba(COLOR.dis, 0.45);
const REST_BAR = rgba(COLOR.low, 0.7);
const BAR_FROM = MODEL_COLOR.map((c) => rgba(c, 0.32));
const GLOW = MODEL_COLOR.map((c) => rgba(c, 0.8));
const HALO_FILL = MODEL_COLOR.map((c) => rgba(c, 0.09));
const HALO_LINE = MODEL_COLOR.map((c) => rgba(c, 0.32));
const BADGE_BG = MODEL_COLOR.map((c) => rgba(c, 0.16));

const EMPTY_TEXT = 'Candidates appear here as the model generates. Hover any generated token to inspect its decision.';
const PROMPT_TEXT = 'Part of your prompt — the model did not choose it.';
const WAIT_TEXT = 'No decision received for this position yet.';
const HINT_TEXT = 'Click a row to branch from here';
const BRANCH_TEXT = 'Branch here';

// Called for each bar a gate cuts: model slot and bar rectangle (canvas px).
export type CutBar = (slot: Slot, x: number, y: number, w: number, h: number) => void;

// Branching from a row: whether it can be done now (live and connected),
// and doing it with the decision's node (the parent) and the row's token.
export interface BranchAction {
  can(): boolean;
  branch(node: number, token: number): void;
}

// The candidate row under `y` (CSS px), or -1: the header and "rest" are
// not rows.
export function rowAt(y: number, rowsTop: number, rows: number): number {
  const k = Math.floor((y - rowsTop) / ROW_H);
  return y >= rowsTop && k < rows ? k : -1;
}

export class CandidatesPanel {
  private readonly surface: Surface;
  // Layout of the last paint, for rowRect() and the pointer.
  private labelX = 0;
  private rowsTop = ROWS_TOP_1;
  private shownRows = 0;
  private shownDecision: EvalData | undefined;
  private pointerY = -1; // CSS px, -1 outside the canvas
  // Bars of the last paint, per side (0: A or the only model, 1: B): the
  // EVAL drawn there, and per row its entry in that EVAL (-1: none) and the
  // bar's x and width. Read by cutBars() for the particles.
  private readonly barEval: [EvalData | undefined, EvalData | undefined] = [undefined, undefined];
  private readonly barEntry = [new Int16Array(MAX_ROWS), new Int16Array(MAX_ROWS)];
  private readonly barX = [new Float32Array(MAX_ROWS), new Float32Array(MAX_ROWS)];
  private readonly barW = [new Float32Array(MAX_ROWS), new Float32Array(MAX_ROWS)];
  // Per paint, reused: the EVAL of each model, the token each picked, the
  // lowest main probability of each.
  private readonly ev: [EvalData | undefined, EvalData | undefined] = [undefined, undefined];
  private readonly pickTok = [-1, -1];
  private readonly low = [0, 0];
  // Texts built once and reused while animation 2 repaints every frame.
  private readonly labels = new WeakMap<VocabEntry, string>();
  private readonly cells = new WeakMap<EvalData, ModelCells>();
  private readonly chips = new WeakMap<PairFrame, PairChips>();
  // The header's token line, rebuilt when the token, its room or the
  // position change.
  private head = { tok: -2, chars: 0, ch: 0, sel: -2, label: '', labelW: 0, pos: '' };
  // Bar gradients, one per track (0: one model, 1: A's side, 2: B's side),
  // made again only when the track moves.
  private readonly grads: (CanvasGradient | null)[] = [null, null, null];
  private readonly gradAt = [0, 0, 0, 0, 0, 0];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
    private readonly branching: BranchAction | null = null,
  ) {
    this.surface = new Surface(canvas, () => (store.dirty.candidates = true));
    canvas.addEventListener('mousemove', (e) => {
      const before = this.hoverRow();
      this.pointerY = e.offsetY;
      if (this.hoverRow() !== before) store.dirty.candidates = true;
      canvas.style.cursor = this.branchRow(e.offsetY) >= 0 ? 'pointer' : '';
    });
    canvas.addEventListener('mouseleave', () => {
      if (this.hoverRow() >= 0) store.dirty.candidates = true;
      this.pointerY = -1;
      canvas.style.cursor = '';
    });
    canvas.addEventListener('click', (e) => {
      const k = this.branchRow(e.offsetY);
      const d = this.shownDecision;
      if (k < 0 || !d || !this.branching) return;
      // The EVAL on screen is the decision's: its node is the parent.
      this.branching.branch(d.node, d.tokens[k]);
    });
  }

  // The row a click at `y` would branch from, or -1.
  private branchRow(y: number): number {
    if (!this.branching?.can() || !this.shownDecision) return -1;
    return rowAt(y, this.rowsTop, this.shownRows);
  }

  // The row under the pointer as last laid out, or -1.
  private hoverRow(): number {
    if (this.pointerY < 0 || !this.shownDecision) return -1;
    return rowAt(this.pointerY, this.rowsTop, this.shownRows);
  }

  // `run`: animation 2, if it is running. Its position is shown when it
  // runs on the decision on screen; otherwise, the selected gate.
  paint(flash: Flash | null, run: RunState | null = null): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    const s = this.store;
    const sel = this.view.selected();
    const pinned = this.view.pinnedIndex() !== null;
    const hovered = this.view.hoveredIndex() !== null;
    this.shownRows = 0;
    this.shownDecision = undefined;
    this.barEval[0] = this.barEval[1] = undefined;

    const d = s.decision(sel);
    const running = run !== null && d !== undefined && run.decision === d;
    const x = !d ? 0 : running ? run.x : stagePosition(d, this.view.shownGate(d.nGates));

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    this.top(d, running ? 0 : x, sel, pinned, hovered);
    const pair = s.twoModels ? s.pairAt(sel) : undefined;
    if (sel >= 0) this.tokenLine(sel, pair);

    if (!d) {
      const prompt = sel >= 0 && s.origin[s.path[sel]] === ORIGIN_PROMPT;
      const msg = sel < 0 || (prompt && !pinned && !hovered) ? EMPTY_TEXT : prompt ? PROMPT_TEXT : WAIT_TEXT;
      ctx.font = uiFont(12);
      ctx.fillStyle = COLOR.muted;
      wrap(ctx, msg, PAD, sel < 0 ? TOP_Y + 4 : MSG_Y, sf.w - 2 * PAD, 18);
      return;
    }
    this.shownDecision = d;

    if (s.twoModels) this.paintTwo(d, sel, flash, x, pair);
    else this.paintOne(d, sel, flash, x);
  }

  // Viewport rectangle of the label of row `entry` as last painted for
  // decision `d`, or null if that row is not on screen.
  rowRect(d: EvalData, entry: number): DOMRect | null {
    if (d !== this.shownDecision || entry < 0 || entry >= this.shownRows) return null;
    const box = this.surface.canvas.getBoundingClientRect();
    return new DOMRect(box.left + this.labelX, box.top + this.rowsTop + entry * ROW_H, LABEL_CHARS * 8, ROW_H);
  }

  // Calls `out` for each bar of the last paint that gate `g` cuts, in the
  // EVAL of its side. Coordinates are canvas px; see canvasRect().
  cutBars(g: number, out: CutBar): void {
    for (const slot of SLOTS) {
      const e = this.barEval[slot];
      if (!e) continue;
      const entry = this.barEntry[slot];
      const bx = this.barX[slot];
      const bw = this.barW[slot];
      for (let k = 0; k < this.shownRows; k++) {
        const j = entry[k];
        if (j < 0 || !(bw[k] > 0) || !cutBy(e, g, j)) continue;
        out(e.slot === 1 ? 1 : 0, bx[k], this.rowsTop + k * ROW_H + BAR_TOP, bw[k], BAR_H);
      }
    }
  }

  // Viewport rectangle of the canvas, to place canvas px on another layer.
  canvasRect(): DOMRect {
    return this.surface.canvas.getBoundingClientRect();
  }

  dispose(): void {
    this.surface.dispose();
  }

  // ------------------------------------------------------------ header

  // The position and the stage shown when it is not raw, and on the right
  // what is selected: pinned, hovered or the last token.
  private top(d: EvalData | undefined, x: number, sel: number, pinned: boolean, hovered: boolean): void {
    const ctx = this.surface.ctx;
    const w = this.surface.w;
    ctx.font = uiFont(11, pinned ? 500 : 400);
    const state = sel < 0 ? '' : pinned ? 'Pinned · Esc to release' : hovered ? 'Click to pin' : 'Latest token';
    const stateW = state ? ctx.measureText(state).width : 0;
    if (state) {
      ctx.fillStyle = pinned ? COLOR.high : COLOR.low;
      ctx.textAlign = 'right';
      ctx.fillText(state, w - PAD, TOP_Y);
      ctx.textAlign = 'left';
      if (pinned) {
        ctx.fillStyle = COLOR.high;
        dot(ctx, w - PAD - stateW - 9, TOP_Y, 3);
      }
    }
    if (sel < 0) return;

    const h = this.head;
    if (h.sel !== sel) {
      h.sel = sel;
      h.pos = `Position #${sel}`;
    }
    ctx.font = uiFont(11, 500);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(h.pos, PAD, TOP_Y);
    const posW = ctx.measureText(h.pos).width;

    if (d && x > 0) {
      // The stage shown, when it is not raw: the short name if the full
      // one does not fit, never over the state.
      const g = d.config?.gates[x - 1];
      ctx.font = uiFont(11, 500);
      const left = PAD + posW + 16;
      const room = w - PAD - stateW - 24 - left;
      const full = `after ${g ? gateLabel(g) : `gate ${x}`}`;
      const text = ctx.measureText(full).width <= room ? full : `after ${g ? gateShortLabel(g) : `g${x}`}`;
      if (room >= 40) {
        ctx.fillStyle = COLOR.low;
        dot(ctx, left - 8, TOP_Y, 1.5);
        ctx.fillStyle = COLOR.high;
        ctx.fillText(text, left, TOP_Y, room);
      }
    }
  }

  // The selected token, big, on a soft tile; with two models, whether their
  // picks differ.
  private tokenLine(sel: number, pair: PairFrame | undefined): void {
    const ctx = this.surface.ctx;
    const w = this.surface.w;
    const s = this.store;
    const differ = pair !== undefined && (pair.flags & PAIR_SAME_PICK) === 0;
    let right = w - PAD;
    if (pair) {
      ctx.font = uiFont(11, differ ? 600 : 400);
      const text = differ ? 'picks differ' : 'same pick';
      const tw = ctx.measureText(text).width;
      if (differ) {
        // A magenta pill with the disagreement's triangle.
        const pw = tw + 34;
        ctx.fillStyle = DIS_BG;
        roundRect(ctx, right - pw, TOKEN_Y - 11, pw, 22, 11);
        ctx.fill();
        ctx.strokeStyle = DIS_LINE;
        ctx.lineWidth = 1;
        roundRect(ctx, right - pw + 0.5, TOKEN_Y - 10.5, pw - 1, 21, 10.5);
        ctx.stroke();
        ctx.fillStyle = COLOR.dis;
        triangle(ctx, right - pw + 14, TOKEN_Y);
        ctx.fillText(text, right - tw - 10, TOKEN_Y);
        right -= pw + 12;
      } else {
        ctx.fillStyle = COLOR.low;
        ctx.textAlign = 'right';
        ctx.fillText(text, right, TOKEN_Y);
        ctx.textAlign = 'left';
        drawIcon(ctx, 'check', right - tw - 17, TOKEN_Y - 6.5, 13, COLOR.low);
        right -= tw + 30;
      }
    }

    const tok = s.token[s.path[sel]];
    ctx.font = font(TOKEN_PX);
    const ch = ctx.measureText('0').width;
    const chars = Math.max(4, Math.floor((right - PAD - 24) / ch));
    const h = this.head;
    if (h.tok !== tok || h.chars !== chars || h.ch !== ch) {
      const v = s.vocab.get(tok);
      h.tok = tok;
      h.chars = chars;
      h.ch = ch;
      h.label = clip(v ? showWhitespace(tokenLabel(v.bytes)) : `#${tok}`, chars);
      h.labelW = ctx.measureText(h.label).width;
    }
    const lw = h.labelW;
    ctx.fillStyle = TOKEN_BG;
    roundRect(ctx, PAD - 2, TOKEN_Y - 16, lw + 20, 32, RADIUS.control);
    ctx.fill();
    ctx.strokeStyle = TOKEN_LINE;
    ctx.lineWidth = 1;
    roundRect(ctx, PAD - 1.5, TOKEN_Y - 15.5, lw + 19, 31, RADIUS.control);
    ctx.stroke();
    ctx.fillStyle = COLOR.high;
    ctx.fillText(h.label, PAD + 8, TOKEN_Y + 1);
  }

  // A pill with a label (UI face, muted) and a value (mono, `color`).
  // Returns its width, or 0 if it does not fit before `maxX` (then it is
  // not drawn).
  private chip(x: number, y: number, label: string, value: string, maxX: number, color: string = COLOR.high): number {
    const ctx = this.surface.ctx;
    ctx.font = uiFont(10.5);
    const lw = ctx.measureText(label).width;
    ctx.font = font(SIZE.small);
    const vw = ctx.measureText(value).width;
    const cw = 10 + lw + 6 + vw + 10;
    if (x + cw > maxX) return 0;
    ctx.fillStyle = COLOR.surface2;
    roundRect(ctx, x, y - CHIP_H / 2, cw, CHIP_H, CHIP_H / 2);
    ctx.fill();
    ctx.strokeStyle = HAIR;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y - CHIP_H / 2 + 0.5, cw - 1, CHIP_H - 1, CHIP_H / 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(value, x + 10 + lw + 6, y);
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(label, x + 10, y);
    return cw;
  }

  private cellsOf(e: EvalData): ModelCells {
    let c = this.cells.get(e);
    if (c === undefined) {
      c = modelCells(e);
      this.cells.set(e, c);
    }
    return c;
  }

  // Remembers the bar of row `k` on side `side`.
  private keepBar(side: Slot, k: number, entry: number, x: number, w: number): void {
    if (k >= MAX_ROWS) return;
    this.barEntry[side][k] = entry;
    this.barX[side][k] = x;
    this.barW[side][k] = w;
  }

  // Rows that fit under `rowsTop`, the "rest" row and the hint aside.
  private fit(rowsTop: number): number {
    const hint = this.branching?.can() ? HINT_H : 0;
    return Math.max(0, Math.floor((this.surface.h - rowsTop - 4 - hint) / ROW_H) - 1);
  }

  // The gradient of track `i` from x0 (dim) to x1 (full colour), kept while
  // the track stays put.
  private gradient(i: number, x0: number, x1: number, slot: Slot): CanvasGradient {
    const at = this.gradAt;
    let g = this.grads[i];
    if (g === null || at[2 * i] !== x0 || at[2 * i + 1] !== x1) {
      g = this.surface.ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, BAR_FROM[slot]);
      g.addColorStop(1, MODEL_COLOR[slot]);
      this.grads[i] = g;
      at[2 * i] = x0;
      at[2 * i + 1] = x1;
    }
    return g;
  }

  // The background of a row: the token the path follows in a halo of the
  // deciding model's colour, the row under the pointer lighter, the row of
  // the token being born lit.
  private rowBack(k: number, top: number, followed: boolean, slot: Slot, flash: Flash | null): void {
    const ctx = this.surface.ctx;
    const x = PAD - 8;
    const w = this.surface.w - 2 * PAD + 16;
    if (followed) {
      ctx.fillStyle = HALO_FILL[slot];
      roundRect(ctx, x, top + 1, w, ROW_H - 2, RADIUS.chip);
      ctx.fill();
      ctx.strokeStyle = HALO_LINE[slot];
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, top + 1.5, w - 1, ROW_H - 3, RADIUS.chip);
      ctx.stroke();
    }
    if (k === this.hoverRow()) {
      ctx.fillStyle = HOVER;
      roundRect(ctx, x, top + 1, w, ROW_H - 2, RADIUS.chip);
      ctx.fill();
    }
    if (flash && flash.entry === k && flash.alpha > 0) {
      ctx.globalAlpha = 0.28 * flash.alpha;
      ctx.fillStyle = MODEL_COLOR[slot];
      roundRect(ctx, x, top + 1, w, ROW_H - 2, RADIUS.chip);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // "Branch here" on the row under the pointer, right-aligned at `right`,
  // when a click there would branch.
  private branchPill(k: number, right: number, mid: number): void {
    if (k !== this.hoverRow() || !this.branching?.can()) return;
    const ctx = this.surface.ctx;
    ctx.font = uiFont(11, 500);
    const tw = ctx.measureText(BRANCH_TEXT).width;
    const pw = tw + 34;
    const x = right - pw;
    ctx.fillStyle = PILL_BG;
    roundRect(ctx, x, mid - 9, pw, 18, 9);
    ctx.fill();
    ctx.strokeStyle = PILL_LINE;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, mid - 8.5, pw - 1, 17, 8.5);
    ctx.stroke();
    drawIcon(ctx, 'branch', x + 8, mid - 6.5, 13, COLOR.high);
    ctx.fillStyle = COLOR.high;
    ctx.fillText(BRANCH_TEXT, x + 25, mid + 0.5);
  }

  // "Click a row to branch from here", under the rows, when it can be done.
  private hint(rowsEnd: number): void {
    if (!this.branching?.can()) return;
    const ctx = this.surface.ctx;
    const y = Math.min(this.surface.h - 12, rowsEnd + 14);
    drawIcon(ctx, 'branch', PAD, y - 6, 12, COLOR.low);
    ctx.font = uiFont(11);
    ctx.fillStyle = COLOR.low;
    ctx.fillText(HINT_TEXT, PAD + 18, y, this.surface.w - 2 * PAD - 18);
  }

  // ----------------------------------------------------------- one model

  private paintOne(d: EvalData, sel: number, flash: Flash | null, x: number): void {
    const ctx = this.surface.ctx;
    const { w } = this.surface;
    const s = this.store;
    const slot = slotOf(d);
    const color = MODEL_COLOR[slot];

    // Chips: the picked token's probability, entropy, effective options.
    const c = this.cellsOf(d);
    let cx = PAD;
    const maxX = w - PAD;
    cx += this.chip(cx, CHIPS_Y_1, 'picked', c.prob, maxX) + 6;
    cx += this.chip(cx, CHIPS_Y_1, 'entropy', c.entropy, maxX) + 6;
    this.chip(cx, CHIPS_Y_1, 'options', c.options, maxX);

    // Layout.
    ctx.font = font(SIZE.label);
    const cw = ctx.measureText('0').width;
    const labelX = PAD + 14;
    const labelW = LABEL_CHARS * cw;
    const barX = labelX + labelW + 10;
    ctx.font = font(SIZE.small);
    const pctW = PCT_CHARS * ctx.measureText('0').width;
    const barMax = Math.max(0, w - PAD - pctW - 10 - barX);
    this.labelX = labelX;
    this.rowsTop = ROWS_TOP_1;
    const grad = this.gradient(0, barX, barX + barMax, slot);

    const followed = s.token[s.path[sel]];
    const n = d.tokens.length;
    const fit = this.fit(ROWS_TOP_1);
    const rows = Math.min(n, fit);
    this.shownRows = rows;
    this.barEval[0] = d;

    for (let k = 0; k < rows; k++) {
      const top = ROWS_TOP_1 + k * ROW_H;
      const mid = top + ROW_H / 2;
      const tok = d.tokens[k];
      const p = valueAt(d, x, k);
      const cut = cutAt(d, x, k);
      const lit = flash !== null && flash.entry === k;

      this.rowBack(k, top, tok === followed, slot, flash);
      if (k === d.nRaw && k > 0) {
        // Extra candidates follow the main ones.
        ctx.fillStyle = HAIR;
        ctx.fillRect(PAD, top, w - 2 * PAD, 1);
      }
      if (k === d.pick) pickDot(ctx, color, PAD + 3, mid);

      if (cut) ctx.globalAlpha = CUT_ALPHA;
      this.label(tok, labelX, top, cw, tok === followed || lit ? COLOR.high : UNLIT);
      ctx.globalAlpha = 1;

      // A pill bar on a faint track, and the percentage. A cut row has no bar.
      const len = cut ? 0 : Math.max(p > 0 ? 2 : 0, p * barMax);
      this.keepBar(0, k, k, barX, len);
      ctx.fillStyle = TRACK;
      roundRect(ctx, barX, top + BAR_TOP, barMax, BAR_H, BAR_H / 2);
      ctx.fill();
      if (len > 0) this.bar(grad, barX, top, len, k === d.pick, slot);
      this.branchPill(k, barX + barMax, mid);
      ctx.font = font(SIZE.small);
      ctx.fillStyle = cut ? COLOR.low : COLOR.high;
      ctx.textAlign = 'right';
      ctx.fillText(pct(p), w - PAD, mid);
      ctx.textAlign = 'left';
    }

    if (fit > 0) {
      // The rest of the vocabulary.
      const top = ROWS_TOP_1 + rows * ROW_H;
      const mid = top + ROW_H / 2;
      const rest = restAt(d, x);
      ctx.fillStyle = HAIR;
      ctx.fillRect(PAD, top, w - 2 * PAD, 1);
      ctx.font = uiFont(11);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(rows < n ? `rest · ${n - rows} more rows` : 'rest of vocabulary', labelX, mid, labelW);
      ctx.fillStyle = TRACK;
      roundRect(ctx, barX, top + BAR_TOP, barMax, BAR_H, BAR_H / 2);
      ctx.fill();
      const len = Math.max(rest > 0 ? 2 : 0, rest * barMax);
      ctx.fillStyle = REST_BAR;
      if (len > 0) {
        roundRect(ctx, barX, top + BAR_TOP, len, BAR_H, BAR_H / 2);
        ctx.fill();
      }
      ctx.font = font(SIZE.small);
      ctx.fillStyle = COLOR.muted;
      ctx.textAlign = 'right';
      ctx.fillText(pct(rest), w - PAD, mid);
      ctx.textAlign = 'left';
      this.hint(top + ROW_H);
    }
  }

  // A bar of row `top`, filled with the track's gradient; the model's pick
  // in full and with a glow, the others dimmer.
  private bar(grad: CanvasGradient, x: number, top: number, len: number, pick: boolean, slot: Slot): void {
    const ctx = this.surface.ctx;
    ctx.fillStyle = grad;
    if (pick) {
      ctx.shadowColor = GLOW[slot];
      ctx.shadowBlur = 10;
    } else {
      ctx.globalAlpha = BAR_ALPHA;
    }
    roundRect(ctx, x, top + BAR_TOP, len, BAR_H, BAR_H / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------- two models

  // `d` is the decision whose entries make the rows: the model in front's,
  // or the other's if the model in front did not evaluate the node. `x` is
  // the stage position; a model whose EVAL lacks that stage has no bars.
  private paintTwo(d: EvalData, sel: number, flash: Flash | null, x: number, pair: PairFrame | undefined): void {
    const ctx = this.surface.ctx;
    const { w, h } = this.surface;
    const s = this.store;
    const ev = this.ev;
    ev[0] = s.decisionOf(sel, 0);
    ev[1] = s.decisionOf(sel, 1);

    this.table();

    // The pair, only where both evaluated the node: chips, then the ranks
    // in words when the panel is tall enough.
    const roomy = h >= ROOMY_H;
    if (pair) {
      let c = this.chips.get(pair);
      if (!c) {
        c = pairChips(pair);
        this.chips.set(pair, c);
      }
      let cx = PAD;
      cx += this.chip(cx, CHIPS_Y_2, 'divergence', c.divergence, w - PAD) + 6;
      this.chip(cx, CHIPS_Y_2, 'KL A‖B · B‖A', c.kl, w - PAD);
      if (roomy) {
        ctx.font = uiFont(11);
        ctx.fillStyle = COLOR.low;
        ctx.fillText(c.ranks, PAD, RANKS_Y, w - 2 * PAD);
      }
    } else {
      ctx.font = uiFont(11);
      ctx.fillStyle = COLOR.low;
      ctx.fillText('No comparison: only one model evaluated this position.', PAD, CHIPS_Y_2, w - 2 * PAD);
    }

    // Layout, right to left: label, B's pick dot, B's percentage, the bars
    // around the axis, A's percentage, A's pick dot.
    const rowsTop = roomy ? ROWS_TOP_2 : ROWS_TOP_2_COMPACT;
    ctx.font = font(SIZE.small);
    const cs = ctx.measureText('0').width;
    ctx.font = font(SIZE.label);
    const cw = ctx.measureText('0').width;
    const labelX = w - PAD - LABEL_CHARS * cw;
    const pw = PCT_CHARS_2 * cs;
    const pctR0 = PAD + 10 + pw; // right edges of the percentages of A, B
    const pctR1 = labelX - 21;
    const barsL = pctR0 + 8;
    const barsR = pctR1 - pw - 8;
    const barMax = Math.max(0, Math.floor((barsR - barsL - 3) / 2));
    const axisX = Math.round(barsL) + 1 + barMax; // 1 px column; bars keep 1 px off it
    this.labelX = labelX;
    this.rowsTop = rowsTop;
    const gradA = this.gradient(1, axisX - 1, axisX - 1 - barMax, 0);
    const gradB = this.gradient(2, axisX + 2, axisX + 2 + barMax, 1);

    const n = d.tokens.length;
    const fit = this.fit(rowsTop);
    const rows = Math.min(n, fit);
    this.shownRows = rows;
    const followed = s.token[s.path[sel]];
    const raw = !(x > 0);
    for (const slot of SLOTS) {
      const e = ev[slot];
      this.pickTok[slot] = e ? e.tokens[e.pick] : -1;
      this.low[slot] = e ? lowestMain(e.pRaw, e.nRaw) : 0;
      this.barEval[slot] = e && hasStage(e, x) ? e : undefined;
    }

    // Which side is which, over the axis.
    if (fit > 0) {
      ctx.font = uiFont(11, 700);
      for (const slot of SLOTS) {
        if (!ev[slot]) continue;
        const color = MODEL_COLOR[slot];
        const y = rowsTop - SIDES_ABOVE;
        ctx.fillStyle = color;
        if (slot === 0) {
          ctx.textAlign = 'right';
          ctx.fillText('A', axisX - 5, y);
          drawIcon(ctx, 'arrowLeft', axisX - 26, y - 5, 10, color);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText('B', axisX + 6, y);
          drawIcon(ctx, 'arrowRight', axisX + 16, y - 5, 10, color);
        }
      }
      ctx.textAlign = 'left';
    }

    const dslot = slotOf(d);
    for (let k = 0; k < rows; k++) {
      const top = rowsTop + k * ROW_H;
      const mid = top + ROW_H / 2;
      const tok = d.tokens[k];
      const lit = flash !== null && flash.entry === k && flash.alpha > 0;
      const rowCut = hasStage(d, x) && cutAt(d, x, k);

      this.rowBack(k, top, tok === followed, dslot, flash);
      if (k === d.nRaw && k > 0) {
        // Extra candidates follow the main ones.
        ctx.fillStyle = HAIR;
        ctx.fillRect(PAD, top, w - 2 * PAD, 1);
      }

      if (rowCut) ctx.globalAlpha = CUT_ALPHA;
      else if (tok !== followed && !lit) ctx.globalAlpha = UNLIT_ALPHA;
      this.label(tok, labelX, top, cw, COLOR.high);
      ctx.globalAlpha = 1;

      for (const slot of SLOTS) {
        const e = ev[slot];
        if (!e) continue; // that model did not evaluate the node: its side stays empty
        const color = MODEL_COLOR[slot];
        const trackX = slot === 0 ? axisX - 1 - barMax : axisX + 2;
        const pctX = slot === 0 ? pctR0 : pctR1;
        ctx.fillStyle = TRACK;
        roundRect(ctx, trackX, top + BAR_TOP, barMax, BAR_H, BAR_H / 2);
        ctx.fill();

        // Its entry for this row, and its value at the stage shown. Without
        // the entry, raw has an upper bound (its lowest main entry) and a
        // later stage is unknown; without the stage, nothing is known.
        const j = e === d ? k : indexOf(e.tokens, tok);
        const known = hasStage(e, x) && (j >= 0 || raw);
        const below = known && j < 0;
        const cut = known && j >= 0 && cutAt(e, x, j);
        const p = !known ? 0 : below ? this.low[slot] : valueAt(e, x, j);
        const len = !known || cut ? 0 : Math.max(p > 0 ? 2 : 0, p * barMax);
        const bx = slot === 0 ? axisX - 1 - len : axisX + 2;
        if (this.barEval[slot]) this.keepBar(slot, k, below ? -1 : j, bx, len);

        if (len > 0 && below) {
          // Only an upper bound: an outline.
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          roundRect(ctx, bx + 0.5, top + BAR_TOP + 0.5, Math.max(1, len - 1), BAR_H - 1, BAR_H / 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else if (len > 0) {
          this.bar(slot === 0 ? gradA : gradB, bx, top, len, tok === this.pickTok[slot], slot);
        }

        if (tok === this.pickTok[slot]) pickDot(ctx, color, slot === 0 ? PAD + 3 : labelX - 14, mid);
        ctx.font = font(SIZE.small);
        ctx.fillStyle = below || cut || !known ? COLOR.low : COLOR.high;
        ctx.textAlign = 'right';
        ctx.fillText(!known ? '–' : below ? pctBelow(p) : pctShort(p), pctX, mid);
        ctx.textAlign = 'left';
      }
      this.branchPill(k, axisX + 2 + barMax, mid);
    }

    if (fit > 0) {
      // The rest of the vocabulary, for each model.
      const top = rowsTop + rows * ROW_H;
      const mid = top + ROW_H / 2;
      ctx.fillStyle = HAIR;
      ctx.fillRect(PAD, top, w - 2 * PAD, 1);
      ctx.font = uiFont(11);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(rows < n ? `rest · ${n - rows} more` : 'rest', labelX, mid, LABEL_CHARS * cw);
      for (const slot of SLOTS) {
        const e = ev[slot];
        if (!e || !hasStage(e, x)) continue;
        const rest = restAt(e, x);
        const len = Math.max(rest > 0 ? 2 : 0, rest * barMax);
        ctx.fillStyle = REST_BAR;
        if (len > 0) {
          roundRect(ctx, slot === 0 ? axisX - 1 - len : axisX + 2, top + BAR_TOP, len, BAR_H, BAR_H / 2);
          ctx.fill();
        }
        ctx.font = font(SIZE.small);
        ctx.fillStyle = COLOR.muted;
        ctx.textAlign = 'right';
        ctx.fillText(pctShort(rest), slot === 0 ? pctR0 : pctR1, mid);
        ctx.textAlign = 'left';
      }

      // The axis, only where both sides have bars.
      if (ev[0] && ev[1]) {
        ctx.fillStyle = COLOR.lineStrong;
        ctx.fillRect(axisX, rowsTop + 2, 1, (rows + 1) * ROW_H - 4);
      }
      this.hint(top + ROW_H);
    }
  }

  // The figures of both models as a small table: what each picked, with
  // which probability, the entropy and the effective number of options.
  private table(): void {
    const ctx = this.surface.ctx;
    const w = this.surface.w;
    const r3 = w - PAD; // right edges of options, entropy, prob
    const r2 = r3 - 58;
    const r1 = r2 - 78;
    const pickX = PAD + 26;
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    ctx.fillText('picked', pickX, HEAD_Y);
    ctx.textAlign = 'right';
    ctx.fillText('prob', r1, HEAD_Y);
    ctx.fillText('entropy', r2, HEAD_Y);
    ctx.fillText('options', r3, HEAD_Y);
    ctx.textAlign = 'left';

    for (const slot of SLOTS) {
      const e = this.ev[slot];
      const y = TABLE_Y[slot];
      // The model's badge: its letter on a tinted tile.
      ctx.fillStyle = BADGE_BG[slot];
      roundRect(ctx, PAD, y - 8, 16, 16, 4);
      ctx.fill();
      ctx.font = uiFont(10, 700);
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.textAlign = 'center';
      ctx.fillText(LETTER[slot], PAD + 8, y + 0.5);
      ctx.textAlign = 'left';
      if (!e) {
        ctx.font = uiFont(11);
        ctx.fillStyle = COLOR.low;
        ctx.fillText('did not evaluate this position', pickX, y, w - PAD - pickX);
        continue;
      }
      const c = this.cellsOf(e);
      ctx.font = font(SIZE.small);
      ctx.fillStyle = COLOR.high;
      ctx.textAlign = 'right';
      ctx.fillText(c.prob, r1, y);
      ctx.fillText(c.entropy, r2, y);
      ctx.fillText(c.options, r3, y);
      ctx.textAlign = 'left';
      const tok = e.tokens[e.pick];
      const v = this.store.vocab.get(tok);
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.fillText(this.labelText(tok, v), pickX, y, Math.max(1, r1 - 44 - pickX));
    }
  }

  // ------------------------------------------------------------ shared

  // A token label clipped to LABEL_CHARS with whitespace made visible,
  // built once per token.
  private labelText(tok: number, v: VocabEntry | undefined): string {
    let label = v ? this.labels.get(v) : undefined;
    if (label === undefined) {
      label = clip(v ? showWhitespace(tokenLabel(v.bytes)) : `#${tok}`, LABEL_CHARS);
      if (v) this.labels.set(v, label);
    }
    return label;
  }

  // A token label at `x` in row `top`: control tokens on a chip, whitespace
  // made visible, clipped to LABEL_CHARS.
  private label(tok: number, x: number, top: number, cw: number, color: string): void {
    const ctx = this.surface.ctx;
    const mid = top + ROW_H / 2;
    const v = this.store.vocab.get(tok);
    const control = ((v?.attr ?? 0) & ATTR_CONTROL) !== 0;
    const label = this.labelText(tok, v);
    ctx.font = font(SIZE.label);
    if (control) {
      const shown = clip(label, LABEL_CHARS - 1);
      const lw = Array.from(shown).length * cw + 8;
      ctx.fillStyle = TOKEN_BG;
      roundRect(ctx, x - 1, top + 3, lw, ROW_H - 6, RADIUS.chip - 1);
      ctx.fill();
      ctx.strokeStyle = TOKEN_LINE;
      ctx.lineWidth = 1;
      roundRect(ctx, x - 0.5, top + 3.5, lw - 1, ROW_H - 7, RADIUS.chip - 1);
      ctx.stroke();
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(shown, x + 3, mid);
    } else {
      ctx.fillStyle = color;
      ctx.fillText(label, x, mid);
    }
  }
}

// Index of `token` among `tokens`, or -1.
function indexOf(tokens: ArrayLike<number>, token: number): number {
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === token) return i;
  return -1;
}

function slotOf(d: EvalData): Slot {
  return d.slot === 1 ? 1 : 0;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r = 3): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// The disagreement's shape: a small triangle pointing up, centred at (x, y).
function triangle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x + 4.5, y + 3.5);
  ctx.lineTo(x - 4.5, y + 3.5);
  ctx.closePath();
  ctx.fill();
}

// A model's pick: a dot with a soft ring.
function pickDot(ctx: CanvasRenderingContext2D, color: string, x: number, y: number): void {
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  dot(ctx, x, y, 6);
  ctx.globalAlpha = 1;
  dot(ctx, x, y, 3);
}

function pct(p: number): string {
  if (p > 0 && p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(1)}%`;
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

// Draws `text` from (x, y) (middle of the first line), broken at spaces to
// fit `maxW`, with `lineH` px between lines. For the empty states only.
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): void {
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      ctx.fillText(line, x, y, maxW);
      y += lineH;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, y, maxW);
}
