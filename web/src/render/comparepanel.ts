// Compare (Canvas 2D): A against B at the selected position, only with two
// models. A header with the verdict, three small indicators and a butterfly
// chart of both distributions.
//
//   "reuses"  position #57                         ◢ Different pick ◣
//   A picked "reuses"  41%              B picked "shares"  33%
//   ╭ Divergence ──╮ ╭ Cross rank ───╮ ╭ Overlap ─────╮
//   │ 0.031 bit JS │ │● A’s pick is #2│ │ (A(∩)B)  39% │
//   │ ▬▬▬───────── │ │ ▪▪█▪▪▪▪▪▪▪    │ │ 18 of 46     │
//   │ ───▬▬│▬──── │ │● B’s pick is #1│ │ common mass  │
//   │ 0.12  KL 0.10│ │ █▪▪▪▪▪▪▪▪▪    │ │ ▬▬▬▬▬▬───    │
//   ╰──────────────╯ ╰───────────────╯ ╰──────────────╯
//   A Q2_K                                        Q8_0 B
//    41%   ●▬▬▬▬▬▬▬▬▬  reuses   ▬▬▬▬▬▬▬     33%
//    38%      ▬▬▬▬▬▬▬  shares   ▬▬▬▬▬▬▬▬▬●  44%
//     9%        ▬▬▬▬▬   keeps  ─
//
// The butterfly has one row per token either model lists, most likely first
// by the larger of its two probabilities; both sides share one scale, the
// largest probability shown. A token the other model does not list leaves a
// faint dash on that side. The row under the pointer is lit; a click does
// nothing (branching is the Candidates view's).
//
// Everything that is text is built when the selection or the data change
// (see shown()), not on every paint.

import { ATTR_CONTROL, ORIGIN_PROMPT, PAIR_APPROX, type PairFrame, type VocabEntry } from '../source/frames';
import type { EvalData, Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import {
  bitsText,
  butterflyRows,
  klScale,
  overlap,
  pctShort,
  pickRank,
  rankWords,
  type ButterflyRow,
  type RankWords,
} from './compare';
import { drawIcon } from './icons';
import { Surface } from './surface';
import { COLOR, MODEL_COLOR, RADIUS, SIZE, font, rgba, roundRect, uiFont } from './theme';

const PAD = 14;

// The header, from the top (CSS px, middle of each line).
const TOKEN_Y = 20; // the selected token and the verdict
const PICKS_Y = 48; // what each model picked
const MSG_Y = 76; // messages of the states without a comparison
// The three indicators.
const TILES_Y = 66;
const TILE_H = 88;
const TILE_GAP = 8;
const TILE_PAD = 10;
// The butterfly.
const HEADS_GAP = 18; // from the tiles to the middle of the column heads
const ROWS_GAP = 12; // from the column heads to the first row
const ROW_H = 20;
const BAR_H = 10;
const BAR_GAP = 8; // between a token label and its bars
const LABEL_CHARS = 12;
const PICK_CHARS = 11;
const TOKEN_CHARS = 18;
const LADDER = 10; // ranks drawn in the cross-rank ladders
const SIDE_MAX = 170; // longest bar: a wide panel does not push the figures away
const PILL_H = 24;

const SLOTS = [0, 1] as const;
const LETTER = ['A', 'B'] as const;
const UNLIT = '#c5ccd6'; // labels of rows neither model picked

// Colours with alpha, built once.
const TILE_FILL = rgba(COLOR.high, 0.035);
const TILE_EDGE = rgba(COLOR.high, 0.07);
const HOVER_FILL = rgba(COLOR.high, 0.06);
const TRACK = rgba(COLOR.high, 0.08);
const NEUTRAL_LOW = rgba(COLOR.high, 0.25);
const DIS_FILL = rgba(COLOR.dis, 0.14);
const DIS_EDGE = rgba(COLOR.dis, 0.55);
const SAME_FILL = rgba(COLOR.high, 0.05);
const SAME_EDGE = rgba(COLOR.high, 0.12);
const MODEL_FILL = [rgba(COLOR.a, 0.42), rgba(COLOR.b, 0.42)] as const;
const MODEL_LOW = [rgba(COLOR.a, 0.5), rgba(COLOR.b, 0.5)] as const; // bars start here at the label
const MODEL_FAINT = [rgba(COLOR.a, 0.2), rgba(COLOR.b, 0.2)] as const;

const EMPTY_TEXT = 'Hover any generated token to see how A and B decided it, side by side.';
const PROMPT_TEXT = 'Part of your prompt: neither model chose it.';
const WAIT_TEXT = 'No decision received for this position yet.';

// One butterfly row with its texts.
interface Row {
  token: number;
  p: [number, number]; // -1: not listed by that model
  pct: [string, string];
  label: string;
  control: boolean;
  picked: [boolean, boolean];
}

// What the view shows for one selection, built when it changes.
interface Shown {
  sel: number;
  tok: number;
  ev: [EvalData | undefined, EvalData | undefined];
  pair: PairFrame | undefined;
  token: string; // quoted, or bare for a control token
  pos: string;
  prompt: boolean;
  same: boolean; // both evaluated and picked the same token
  only: string; // "Only A evaluated", when one did
  oneText: string; // the message of that state
  picks: [string, string];
  pickPct: [string, string];
  // Divergence.
  hasPair: boolean;
  js: string;
  jsT: number;
  kl: [string, string];
  klT: [number, number];
  // Cross ranks.
  ranks: [RankWords, RankWords] | null;
  rankN: [number, number];
  // Overlap.
  hasOverlap: boolean;
  jaccard: number;
  jaccardText: string;
  shared: [string, string, string]; // "23 of 41 shared", "23/41 shared", "23/41": the longest that fits
  mass: number;
  massText: string;
  // Butterfly.
  rows: Row[];
  maxP: number;
  moreText: string[]; // "+n more", by rows left out (built lazily)
}

// Geometry that depends only on the width: cached with its gradients.
interface Layout {
  w: number;
  cx: number;
  labelL: number;
  labelR: number;
  side: number; // longest bar
  inA: number; // where the bars of A start (they grow to the left)
  inB: number;
  pctA: number; // right edge of A's percentages
  pctB: number; // left edge of B's
  pw: number; // width of a percentage
  grad: [CanvasGradient, CanvasGradient];
  tileW: number;
  tileGrad: CanvasGradient[]; // the neutral meters of the tiles (JS, common mass)
}

export class ComparePanel {
  private readonly surface: Surface;
  private cache: Shown | null = null;
  private layout: Layout | null = null;
  private readonly labels = new WeakMap<VocabEntry, string>();
  private pointerY = -1;
  // Rows of the last paint, for the pointer.
  private rowsTop = 0;
  private shownRows = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.surface = new Surface(canvas, () => {
      this.store.dirty.compare = true;
    });
    canvas.addEventListener('mousemove', (e) => {
      const before = this.hoverRow();
      this.pointerY = e.offsetY;
      if (this.hoverRow() !== before) store.dirty.compare = true;
    });
    canvas.addEventListener('mouseleave', () => {
      if (this.hoverRow() >= 0) store.dirty.compare = true;
      this.pointerY = -1;
    });
  }

  paint(): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    this.shownRows = 0;

    const sel = this.view.selected();
    let m = sel >= 0 ? this.shown(sel) : null;
    // Nothing generated yet: the last token is the prompt's, and nobody
    // asked about it.
    if (m?.prompt && this.view.pinnedIndex() === null && this.view.hoveredIndex() === null) m = null;
    if (!m) {
      ctx.font = uiFont(SIZE.label);
      ctx.fillStyle = COLOR.muted;
      wrap(ctx, EMPTY_TEXT, PAD, TOKEN_Y, sf.w - 2 * PAD, 17);
      return;
    }

    const right = this.verdict(m);
    this.tokenLine(m, right);
    if (m.prompt || (!m.ev[0] && !m.ev[1])) {
      ctx.font = uiFont(SIZE.label);
      ctx.fillStyle = COLOR.low;
      wrap(ctx, m.prompt ? PROMPT_TEXT : WAIT_TEXT, PAD, PICKS_Y + 4, sf.w - 2 * PAD, 17);
      return;
    }
    this.picksLine(m);

    let headsY: number;
    if (m.ev[0] && m.ev[1]) {
      this.tiles(m);
      headsY = TILES_Y + TILE_H + HEADS_GAP;
    } else {
      ctx.font = uiFont(SIZE.label);
      ctx.fillStyle = COLOR.muted;
      const end = wrap(ctx, m.oneText, PAD, MSG_Y, sf.w - 2 * PAD, 17);
      headsY = end + 28;
    }
    this.butterfly(m, headsY);
  }

  dispose(): void {
    this.surface.dispose();
  }

  // ------------------------------------------------------------- model

  // What to show for `sel`, rebuilt only when the selection, its token or
  // the data behind it change.
  private shown(sel: number): Shown {
    const s = this.store;
    const tok = s.token[s.path[sel]];
    const a = s.decisionOf(sel, 0);
    const b = s.decisionOf(sel, 1);
    const pair = s.pairAt(sel);
    const c = this.cache;
    if (c && c.sel === sel && c.tok === tok && c.ev[0] === a && c.ev[1] === b && c.pair === pair) return c;

    const ev: [EvalData | undefined, EvalData | undefined] = [a, b];
    const v = s.vocab.get(tok);
    const control = ((v?.attr ?? 0) & ATTR_CONTROL) !== 0;
    const text = clip(this.labelOf(tok, v), TOKEN_CHARS);
    const pickTok = [a ? a.tokens[a.pick] : -1, b ? b.tokens[b.pick] : -1];
    const one = a ? 0 : 1;

    const m: Shown = {
      sel,
      tok,
      ev,
      pair,
      token: control ? text : `"${text}"`,
      pos: `position #${sel}`,
      prompt: s.origin[s.path[sel]] === ORIGIN_PROMPT,
      same: !!a && !!b && pickTok[0] === pickTok[1],
      only: `Only ${LETTER[one]} evaluated`,
      oneText: `Only ${LETTER[one]} evaluated this position: the models had already gone separate ways. Its candidates are below.`,
      picks: ['', ''],
      pickPct: ['', ''],
      hasPair: pair !== undefined,
      js: '–',
      jsT: 0,
      kl: ['–', '–'],
      klT: [0, 0],
      ranks: null,
      rankN: [-1, -1],
      hasOverlap: false,
      jaccard: 0,
      jaccardText: '',
      shared: ['', '', ''],
      mass: 0,
      massText: '',
      rows: [],
      maxP: 0,
      moreText: [],
    };

    for (const slot of SLOTS) {
      const e = ev[slot];
      if (!e) continue;
      const t = pickTok[slot];
      const pv = s.vocab.get(t);
      const label = clip(this.labelOf(t, pv), PICK_CHARS);
      m.picks[slot] = ((pv?.attr ?? 0) & ATTR_CONTROL) !== 0 ? label : `"${label}"`;
      m.pickPct[slot] = pctShort(e.pRaw[e.pick] ?? 0);
    }

    if (pair) {
      const ap = (pair.flags & PAIR_APPROX) !== 0 ? '≈' : '';
      m.js = `${ap}${bitsText(pair.js)}`;
      m.jsT = Math.max(0, Math.min(1, Number.isFinite(pair.js) ? pair.js : 1));
      m.kl = [`${ap}${bitsText(pair.klAB)}`, `${ap}${bitsText(pair.klBA)}`];
      m.klT = [klScale(pair.klAB), klScale(pair.klBA)];
    }

    if (a && b) {
      const ra = pickRank(a, b, pair?.rankAInB);
      const rb = pickRank(b, a, pair?.rankBInA);
      m.ranks = [rankWords(ra, 'A', 'B', b.nRaw), rankWords(rb, 'B', 'A', a.nRaw)];
      m.rankN = [ra, rb];
      const o = overlap(a, b);
      m.hasOverlap = true;
      m.jaccard = o.jaccard;
      m.jaccardText = `${Math.round(o.jaccard * 100)}%`;
      m.shared = [`${o.shared} of ${o.union} shared`, `${o.shared}/${o.union} shared`, `${o.shared}/${o.union}`];
      m.mass = o.commonMass;
      m.massText = pctShort(o.commonMass);
    }

    const rows = butterflyRows(a, b);
    m.rows = rows.map((r: ButterflyRow) => {
      const rv = s.vocab.get(r.token);
      return {
        token: r.token,
        p: [r.pA, r.pB],
        pct: [r.pA >= 0 ? pctShort(r.pA) : '', r.pB >= 0 ? pctShort(r.pB) : ''],
        label: clip(this.labelOf(r.token, rv), LABEL_CHARS),
        control: ((rv?.attr ?? 0) & ATTR_CONTROL) !== 0,
        picked: [r.token === pickTok[0], r.token === pickTok[1]],
      };
    });
    m.maxP = rows.length > 0 ? Math.max(rows[0].pA, rows[0].pB) : 0;
    this.cache = m;
    return m;
  }

  // A token's text with whitespace made visible, built once per token.
  private labelOf(tok: number, v: VocabEntry | undefined): string {
    if (!v) return `#${tok}`;
    let label = this.labels.get(v);
    if (label === undefined) {
      label = showWhitespace(tokenLabel(v.bytes));
      this.labels.set(v, label);
    }
    return label;
  }

  // Width-dependent geometry and its gradients, rebuilt when the width changes.
  private geometry(): Layout {
    const w = this.surface.w;
    if (this.layout && this.layout.w === w) return this.layout;
    const ctx = this.surface.ctx;
    ctx.font = font(SIZE.label);
    const cw = ctx.measureText('0').width;
    ctx.font = font(SIZE.small);
    const pw = 5 * ctx.measureText('0').width; // pctShort() is at most 5 characters
    const cx = Math.round(w / 2);
    const half = (LABEL_CHARS * cw) / 2;
    const labelL = cx - half;
    const labelR = cx + half;
    const inA = labelL - BAR_GAP;
    const inB = labelR + BAR_GAP;
    const side = Math.max(0, Math.min(SIDE_MAX, inA - PAD - pw - 10, w - PAD - pw - 10 - inB));
    const pctA = inA - side - 10;
    const pctB = inB + side + 10;
    const gA = ctx.createLinearGradient(inA, 0, inA - side, 0);
    gA.addColorStop(0, MODEL_LOW[0]);
    gA.addColorStop(1, COLOR.a);
    const gB = ctx.createLinearGradient(inB, 0, inB + side, 0);
    gB.addColorStop(0, MODEL_LOW[1]);
    gB.addColorStop(1, COLOR.b);

    const tileW = (w - 2 * PAD - 2 * TILE_GAP) / 3;
    const tileGrad: CanvasGradient[] = [];
    for (let i = 0; i < 3; i++) {
      const x0 = PAD + i * (tileW + TILE_GAP) + TILE_PAD;
      const g = ctx.createLinearGradient(x0, 0, x0 + tileW - 2 * TILE_PAD, 0);
      g.addColorStop(0, NEUTRAL_LOW);
      g.addColorStop(1, COLOR.high);
      tileGrad.push(g);
    }
    this.layout = { w, cx, labelL, labelR, side, inA, inB, pctA, pctB, pw, grad: [gA, gB], tileW, tileGrad };
    return this.layout;
  }

  // ------------------------------------------------------------ header

  // The verdict on the right of the token line, as a pill. Returns its left
  // edge, the room left for the token.
  private verdict(m: Shown): number {
    const ctx = this.surface.ctx;
    const right = this.surface.w - PAD;
    if (m.prompt || (!m.ev[0] && !m.ev[1])) return right;
    const both = !!m.ev[0] && !!m.ev[1];
    const differ = both && !m.same;
    const text = !both ? m.only : differ ? 'Different pick' : 'Same pick';
    ctx.font = uiFont(SIZE.label, differ ? 600 : 500);
    const tw = ctx.measureText(text).width;
    const pw = 10 + 14 + 6 + tw + 12;
    const x = right - pw;
    const y = TOKEN_Y - PILL_H / 2;
    roundRect(ctx, x + 0.5, y + 0.5, pw - 1, PILL_H - 1, PILL_H / 2);
    ctx.fillStyle = differ ? DIS_FILL : SAME_FILL;
    ctx.fill();
    ctx.strokeStyle = differ ? DIS_EDGE : SAME_EDGE;
    ctx.lineWidth = 1;
    ctx.stroke();

    const ix = x + 10;
    if (differ) {
      // The discrepancy's own shape: a triangle standing on its base, with glow.
      ctx.save();
      ctx.shadowColor = COLOR.dis;
      ctx.shadowBlur = 8;
      ctx.fillStyle = COLOR.dis;
      ctx.beginPath();
      ctx.moveTo(ix, TOKEN_Y + 5);
      ctx.lineTo(ix + 14, TOKEN_Y + 5);
      ctx.lineTo(ix + 7, TOKEN_Y - 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else if (both) {
      drawIcon(ctx, 'check', ix, TOKEN_Y - 7, 14, COLOR.muted);
    } else {
      const slot = m.ev[0] ? 0 : 1;
      ctx.fillStyle = MODEL_COLOR[slot];
      dot(ctx, ix + 7, TOKEN_Y, 4);
    }
    ctx.fillStyle = differ ? COLOR.dis : COLOR.muted;
    ctx.fillText(text, ix + 14 + 6, TOKEN_Y + 0.5);
    return x;
  }

  // The token at the position, quoted, and the position when it fits.
  private tokenLine(m: Shown, right: number): void {
    const ctx = this.surface.ctx;
    ctx.font = font(SIZE.text);
    ctx.fillStyle = COLOR.high;
    const room = right - 12 - PAD;
    ctx.fillText(m.token, PAD, TOKEN_Y, room);
    const lw = ctx.measureText(m.token).width;
    ctx.font = uiFont(SIZE.small);
    const posW = ctx.measureText(m.pos).width;
    if (lw + 10 + posW <= room) {
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(m.pos, PAD + lw + 10, TOKEN_Y + 1);
    }
  }

  // What each model picked: "A picked "reuses" 41%" on the left, B's on the
  // right half.
  private picksLine(m: Shown): void {
    const ctx = this.surface.ctx;
    const w = this.surface.w;
    for (const slot of SLOTS) {
      const e = m.ev[slot];
      let x = slot === 0 ? PAD : Math.round(w / 2) + 6;
      const end = slot === 0 ? Math.round(w / 2) - 6 : w - PAD;
      ctx.font = font(SIZE.small, true);
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.fillText(LETTER[slot], x, PICKS_Y);
      x += ctx.measureText(LETTER[slot]).width + 6;
      if (!e) {
        ctx.font = uiFont(SIZE.small);
        ctx.fillStyle = COLOR.low;
        ctx.fillText('did not evaluate it', x, PICKS_Y, end - x);
        continue;
      }
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText('picked', x, PICKS_Y);
      x += ctx.measureText('picked').width + 6;
      ctx.font = font(SIZE.label);
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.fillText(m.picks[slot], x, PICKS_Y, Math.max(1, end - x - 40));
      x += Math.min(ctx.measureText(m.picks[slot]).width, end - x - 40) + 8;
      ctx.font = font(SIZE.small);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(m.pickPct[slot], x, PICKS_Y + 0.5);
    }
  }

  // --------------------------------------------------------- indicators

  private tiles(m: Shown): void {
    const ctx = this.surface.ctx;
    const g = this.geometry();
    const tw = g.tileW;
    for (let i = 0; i < 3; i++) {
      const x = PAD + i * (tw + TILE_GAP);
      roundRect(ctx, x + 0.5, TILES_Y + 0.5, tw - 1, TILE_H - 1, RADIUS.control + 2);
      ctx.fillStyle = TILE_FILL;
      ctx.fill();
      ctx.strokeStyle = TILE_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = uiFont(SIZE.small, 500);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(i === 0 ? 'Divergence' : i === 1 ? 'Cross rank' : 'Overlap', x + TILE_PAD, TILES_Y + 15);
    }
    this.divergence(m, PAD, tw, g.tileGrad[0]);
    this.crossRank(m, PAD + tw + TILE_GAP, tw);
    this.overlapTile(m, PAD + 2 * (tw + TILE_GAP), tw, g.tileGrad[2]);
  }

  // JS as a meter from 0 to 1 bit, then KL both ways as a bar that diverges
  // from the centre: A‖B to the left (cyan), B‖A to the right (amber).
  private divergence(m: Shown, x: number, tw: number, grad: CanvasGradient): void {
    const ctx = this.surface.ctx;
    const y = TILES_Y;
    const x0 = x + TILE_PAD;
    const x1 = x + tw - TILE_PAD;
    const len = x1 - x0;

    ctx.font = font(20);
    ctx.fillStyle = m.hasPair ? COLOR.high : COLOR.low;
    ctx.fillText(m.js, x0, y + 38);
    const fw = ctx.measureText(m.js).width;
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    if (fw + 6 + 38 <= len) ctx.fillText('bit JS', x0 + fw + 6, y + 40);

    // JS meter.
    const my = y + 54;
    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, my - 2, len, 4, 2);
    ctx.fill();
    if (m.hasPair && m.jsT > 0) {
      const l = Math.max(4, m.jsT * len);
      ctx.fillStyle = grad;
      roundRect(ctx, x0, my - 2, l, 4, 2);
      ctx.fill();
      glowDot(ctx, x0 + l - 1, my, COLOR.high, 2.5);
    }

    // KL, diverging from the centre.
    const ky = y + 67;
    const cx = Math.round(x0 + len / 2);
    const half = len / 2 - 1;
    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, ky - 3, len, 6, 3);
    ctx.fill();
    if (m.hasPair) {
      for (const slot of SLOTS) {
        const t = m.klT[slot];
        if (!(t > 0)) continue;
        const l = Math.max(3, t * half);
        ctx.fillStyle = MODEL_COLOR[slot];
        ctx.beginPath();
        if (slot === 0) ctx.roundRect(cx - 1 - l, ky - 3, l, 6, [3, 0, 0, 3]);
        else ctx.roundRect(cx + 1, ky - 3, l, 6, [0, 3, 3, 0]);
        ctx.fill();
      }
    }
    ctx.fillStyle = COLOR.muted;
    ctx.fillRect(cx - 0.5, ky - 6, 1, 12);

    const ty = y + 79;
    ctx.font = font(10.5);
    ctx.fillStyle = COLOR.a;
    ctx.fillText(m.kl[0], x0, ty);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOR.b;
    ctx.fillText(m.kl[1], x1, ty);
    ctx.textAlign = 'center';
    ctx.font = uiFont(10);
    ctx.fillStyle = COLOR.low;
    ctx.fillText('KL', cx, ty);
    ctx.textAlign = 'left';
  }

  // Each pick's rank for the other model, in words and on a ladder of the
  // other model's first ranks.
  private crossRank(m: Shown, x: number, tw: number): void {
    const ctx = this.surface.ctx;
    const ranks = m.ranks;
    if (!ranks) return;
    const x0 = x + TILE_PAD;
    const x1 = x + tw - TILE_PAD;
    const len = x1 - x0;
    const sw = (len - (LADDER - 1) * 3) / LADDER;
    for (const slot of SLOTS) {
      const w = ranks[slot];
      const ty = TILES_Y + 36 + slot * 27;
      ctx.fillStyle = MODEL_COLOR[slot];
      dot(ctx, x0 + 3, ty, 3);
      // The whole sentence when it fits; without "A’s pick is" otherwise.
      let tx = x0 + 11;
      ctx.font = uiFont(SIZE.small);
      const preW = ctx.measureText(w.pre).width;
      const postW = ctx.measureText(w.post).width;
      ctx.font = font(SIZE.label, true);
      const figW = w.fig ? ctx.measureText(w.fig).width : 0;
      const known = w.fig !== '';
      if (tx + preW + figW + postW <= x1) {
        ctx.font = uiFont(SIZE.small);
        ctx.fillStyle = COLOR.muted;
        ctx.fillText(w.pre, tx, ty);
        tx += preW;
      }
      if (known) {
        ctx.font = font(SIZE.label, true);
        ctx.fillStyle = COLOR.high;
        ctx.fillText(w.fig, tx, ty);
        tx += figW;
      }
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = known ? COLOR.muted : COLOR.low;
      ctx.fillText(w.post, tx, ty, Math.max(1, x1 - tx));

      // The ladder: the other model's ranks #1..#LADDER in its colour, the
      // pick's rank lit in this model's colour.
      const ly = ty + 11;
      const other = slot === 0 ? 1 : 0;
      const r = m.rankN[slot];
      ctx.fillStyle = MODEL_FAINT[other];
      for (let k = 0; k < LADDER; k++) {
        roundRect(ctx, x0 + k * (sw + 3), ly - 2, sw, 4, 2);
        ctx.fill();
      }
      if (known && r < LADDER) {
        const lx = x0 + r * (sw + 3);
        ctx.save();
        ctx.shadowColor = MODEL_COLOR[slot];
        ctx.shadowBlur = 6;
        ctx.fillStyle = MODEL_COLOR[slot];
        roundRect(ctx, lx, ly - 2.5, sw, 5, 2.5);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Jaccard of the two top lists as two overlapping discs, and the
  // probability both spend on the shared tokens as a meter.
  private overlapTile(m: Shown, x: number, tw: number, grad: CanvasGradient): void {
    const ctx = this.surface.ctx;
    if (!m.hasOverlap) return;
    const x0 = x + TILE_PAD;
    const x1 = x + tw - TILE_PAD;
    const r = 10;
    const vy = TILES_Y + 42;
    const vc = x0 + 2 * r;
    const d = 2 * r * (1 - m.jaccard); // 0: the same list; 2r: nothing shared
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const slot of SLOTS) {
      const cx = slot === 0 ? vc - d / 2 : vc + d / 2;
      ctx.fillStyle = MODEL_FILL[slot];
      ctx.beginPath();
      ctx.arc(cx, vy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.lineWidth = 1;
    for (const slot of SLOTS) {
      const cx = slot === 0 ? vc - d / 2 : vc + d / 2;
      ctx.strokeStyle = MODEL_COLOR[slot];
      ctx.beginPath();
      ctx.arc(cx, vy, r - 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    const fx = x0 + 4 * r + 6;
    ctx.font = font(20);
    ctx.fillStyle = COLOR.high;
    ctx.fillText(m.jaccardText, fx, vy - 4, Math.max(1, x1 - fx));
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    let shared = m.shared[2];
    for (const t of m.shared) {
      if (ctx.measureText(t).width <= x1 - fx) {
        shared = t;
        break;
      }
    }
    ctx.fillText(shared, fx, vy + 12);

    const ty = TILES_Y + 69;
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    ctx.fillText('common mass', x0, ty);
    ctx.font = font(SIZE.small);
    ctx.fillStyle = COLOR.high;
    ctx.textAlign = 'right';
    ctx.fillText(m.massText, x1, ty);
    ctx.textAlign = 'left';
    const my = TILES_Y + 79;
    const len = x1 - x0;
    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, my - 2, len, 4, 2);
    ctx.fill();
    if (m.mass > 0) {
      ctx.fillStyle = grad;
      roundRect(ctx, x0, my - 2, Math.max(4, m.mass * len), 4, 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------- butterfly

  private butterfly(m: Shown, headsY: number): void {
    const ctx = this.surface.ctx;
    const { w, h } = this.surface;
    const g = this.geometry();
    const rowsTop = headsY + ROWS_GAP;
    const fit = Math.max(0, Math.floor((h - rowsTop - 6) / ROW_H));
    if (fit === 0 || m.rows.length === 0) return;

    // Column heads: which side is which model.
    const models = this.store.hello?.models;
    for (const slot of SLOTS) {
      if (!m.ev[slot]) continue;
      const quant = models?.[slot]?.quant ?? '';
      ctx.font = font(SIZE.small, true);
      const lw = ctx.measureText(LETTER[slot]).width;
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.textAlign = slot === 0 ? 'left' : 'right';
      const hx = slot === 0 ? g.pctA - g.pw : g.pctB + g.pw;
      ctx.fillText(LETTER[slot], hx, headsY);
      ctx.font = uiFont(SIZE.small);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(quant, slot === 0 ? hx + lw + 6 : hx - lw - 6, headsY);
    }
    ctx.textAlign = 'left';

    const more = m.rows.length > fit && fit >= 3;
    const rows = more ? fit - 1 : Math.min(fit, m.rows.length);
    this.rowsTop = rowsTop;
    this.shownRows = rows;
    const hover = this.hoverRow();
    const scale = m.maxP > 0 ? g.side / m.maxP : 0;

    for (let k = 0; k < rows; k++) {
      const row = m.rows[k];
      const top = rowsTop + k * ROW_H;
      const mid = top + ROW_H / 2;
      if (k === hover) {
        ctx.fillStyle = HOVER_FILL;
        roundRect(ctx, PAD - 6, top + 1, w - 2 * PAD + 12, ROW_H - 2, 6);
        ctx.fill();
      }

      for (const slot of SLOTS) {
        if (!m.ev[slot]) continue; // that model did not evaluate the position
        const p = row.p[slot];
        const inner = slot === 0 ? g.inA : g.inB;
        if (p < 0) {
          // Not in this model's list: a faint dash by the label.
          ctx.fillStyle = COLOR.lineStrong;
          ctx.fillRect(slot === 0 ? inner - 10 : inner, mid - 0.5, 10, 1);
          continue;
        }
        const len = Math.max(p > 0 ? 3 : 0, p * scale);
        const picked = row.picked[slot];
        if (len > 0) {
          ctx.fillStyle = g.grad[slot];
          ctx.globalAlpha = picked ? 1 : 0.7;
          ctx.beginPath();
          const r = BAR_H / 2;
          if (slot === 0) ctx.roundRect(inner - len, mid - BAR_H / 2, len, BAR_H, len >= BAR_H ? [r, 0, 0, r] : 0);
          else ctx.roundRect(inner, mid - BAR_H / 2, len, BAR_H, len >= BAR_H ? [0, r, r, 0] : 0);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (picked) pickDot(ctx, MODEL_COLOR[slot], slot === 0 ? inner - len + 4 : inner + len - 4, mid);
        ctx.font = font(SIZE.small);
        ctx.fillStyle = picked ? MODEL_COLOR[slot] : COLOR.muted;
        ctx.textAlign = slot === 0 ? 'right' : 'left';
        ctx.fillText(row.pct[slot], slot === 0 ? g.pctA : g.pctB, mid + 0.5);
      }

      // The token, centred.
      ctx.textAlign = 'center';
      ctx.font = font(SIZE.label);
      const lit = row.picked[0] || row.picked[1] || k === hover;
      if (row.control) {
        const lw = ctx.measureText(row.label).width + 8;
        ctx.strokeStyle = COLOR.muted;
        ctx.lineWidth = 1;
        roundRect(ctx, g.cx - lw / 2 + 0.5, top + 3.5, lw - 1, ROW_H - 7, 4);
        ctx.stroke();
        ctx.fillStyle = COLOR.muted;
      } else {
        ctx.fillStyle = lit ? COLOR.high : UNLIT;
      }
      ctx.fillText(row.label, g.cx, mid);
      ctx.textAlign = 'left';
    }

    if (more) {
      const left = m.rows.length - rows;
      let t = m.moreText[left];
      if (t === undefined) {
        t = `+${left} more candidates`;
        m.moreText[left] = t;
      }
      ctx.font = uiFont(10.5);
      ctx.fillStyle = COLOR.low;
      ctx.textAlign = 'center';
      ctx.fillText(t, g.cx, rowsTop + rows * ROW_H + ROW_H / 2);
      ctx.textAlign = 'left';
    }
  }

  // The butterfly row under the pointer as last painted, or -1.
  private hoverRow(): number {
    if (this.pointerY < 0 || this.shownRows === 0) return -1;
    const k = Math.floor((this.pointerY - this.rowsTop) / ROW_H);
    return this.pointerY >= this.rowsTop && k < this.shownRows ? k : -1;
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// A small light with a soft halo, at the tip of a meter.
function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r: number): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  dot(ctx, x, y, r);
  ctx.restore();
}

// A model's pick: a dot with a halo and a bright core.
function pickDot(ctx: CanvasRenderingContext2D, color: string, x: number, y: number): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  dot(ctx, x, y, 3.5);
  ctx.restore();
  ctx.fillStyle = COLOR.high;
  dot(ctx, x, y, 1.4);
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

// Draws `text` from (x, y) (middle of the first line), broken at spaces to
// fit `maxW`, with `lineH` px between lines. Returns the middle of the last
// line. For the messages only.
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
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
  return y;
}
