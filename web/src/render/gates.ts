// The gate strip (Canvas 2D), under Candidates: the gate chain of the
// decision on screen, left to right, with the candidates alive after each.
//
//   Sampling chain                           Click a stage to inspect it
//   (raw)───(grammar)─›─(top-k 2)─›─(temp 0.5)     ← chips on a flow line
//   ══════════════●                               ← animation 2 running
//    248k     245k        2          2            ← one row per model, in its colour
//
// The gates are those of the CONFIG the EVAL belongs to (EvalData.config),
// not the current ones: an old decision shows the chain it went through.
// Under "raw", n_vocab of HELLO; under each gate, its `survivors`. A click
// on a stage selects it and Candidates shows the distribution after it; a
// click on the selected one goes back to "raw". A decision without gates
// says so, and where to add them.
//
// Labels, figures and columns are laid out only when the decision, the
// models' EVALs or the width change: painting during the animation only
// draws cached strings.

import type { EvalData, Store } from '../store/store';
import type { View } from '../store/view';
import type { RunState } from './gaterun';
import { drawIcon } from './icons';
import { compactCount, gateLabel, gateShortLabel } from './stages';
import { Surface } from './surface';
import { COLOR, MODEL_COLOR, SIZE, font, rgba, roundRect, uiFont } from './theme';

const PAD = 16;
const TITLE_Y = 13;
const CHIP_Y = 36; // middle of the chips and of the flow line
const CHIP_H = 22;
const CHIP_PAD = 10; // text to chip edge
const TRACE_Y = CHIP_Y + CHIP_H / 2 + 3; // animation 2, under the chips
const NUM_Y_ONE = [61] as const;
const NUM_Y_TWO = [58, 71] as const;
const SEP_W = 20; // between chips, with room for a chevron
const SEP_W_TIGHT = 8;
const MAX_STAGES = 17; // raw + 16 gates
const SLOTS = [0, 1] as const;

// Colours built once: painting builds no strings.
const FLOW = rgba(COLOR.high, 0.12);
const FLOW_SHOWN = rgba(COLOR.high, 0.38);
const CHIP_LINE = rgba(COLOR.high, 0.09);
const SHOWN_LINE = rgba(COLOR.high, 0.6);
const SHOWN_GLOW = rgba(COLOR.high, 0.28);
const RUN_GLOW = MODEL_COLOR.map((c) => rgba(c, 0.9));
const RUN_TRACE = MODEL_COLOR.map((c) => rgba(c, 0.55));

export class GatesPanel {
  private readonly surface: Surface;

  // Layout of the decision on screen (see layout()).
  private key: { d: EvalData | undefined; a: EvalData | undefined; b: EvalData | undefined; w: number; vocab: number } =
    { d: undefined, a: undefined, b: undefined, w: 0, vocab: 0 };
  private stages = 0; // columns: raw and each gate
  private readonly names: string[] = [];
  private readonly nums: [string[], string[]] = [[], []]; // per slot; '' where it has no figure
  private readonly colX = new Float32Array(MAX_STAGES);
  private readonly colW = new Float32Array(MAX_STAGES);
  private readonly chipW = new Float32Array(MAX_STAGES);
  private sepW = 0;
  private two = false;
  private readonly ev: [EvalData | undefined, EvalData | undefined] = [undefined, undefined];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.surface = new Surface(canvas, () => (store.dirty.gates = true));
    canvas.addEventListener('click', (e) => {
      const c = this.columnAt(e.offsetX);
      const d = this.key.d;
      if (c < 0 || !d) return;
      const g = c - 1; // column 0 is raw
      this.view.selectGate(g === this.view.shownGate(d.nGates) ? -1 : g);
    });
    canvas.addEventListener('mousemove', (e) => {
      const over = this.stages > 1 && this.columnAt(e.offsetX) >= 0;
      const cursor = over ? 'pointer' : '';
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    });
  }

  // `run`: animation 2, if it is running; marked when it runs on the
  // decision on screen.
  paint(run: RunState | null = null): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    const s = this.store;
    const sel = this.view.selected();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = uiFont(11, 500);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText('Sampling chain', PAD, TITLE_Y);

    const d = s.decision(sel);
    this.ev[0] = s.decisionOf(sel, 0);
    this.ev[1] = s.decisionOf(sel, 1);
    this.layout(d);
    const room = sf.w - 2 * PAD;
    if (!d) {
      // A prompt token, or nothing yet.
      ctx.font = uiFont(11);
      ctx.fillStyle = COLOR.low;
      ctx.fillText(
        sel < 0 ? 'The sampling chain of each decision shows here.' : 'No decision here: nothing was sampled.',
        PAD,
        CHIP_Y,
        room,
      );
      return;
    }
    if (d.nGates === 0) {
      // Raw distribution, nothing to click: say where the samplers are.
      this.chip(0, true, false, MODEL_COLOR[0]);
      const left = this.colX[0] + this.chipW[0] + 12;
      ctx.font = uiFont(12, 500);
      ctx.fillStyle = COLOR.high;
      ctx.fillText('No samplers active', left, CHIP_Y, Math.max(1, sf.w - PAD - left));
      drawIcon(ctx, 'sliders', PAD, NUM_Y_ONE[0] - 6, 12, COLOR.muted);
      ctx.font = uiFont(11);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText('Open Samplers to add top-k, top-p, temperature…', PAD + 18, NUM_Y_ONE[0], room - 18);
      return;
    }
    // What a click does, while there is room for it beside the title.
    ctx.font = uiFont(11);
    ctx.fillStyle = COLOR.low;
    ctx.textAlign = 'right';
    if (sf.w >= 300) ctx.fillText('Click a stage to inspect it', sf.w - PAD, TITLE_Y);
    ctx.textAlign = 'left';

    const shown = this.view.shownGate(d.nGates) + 1; // selected column
    const running = run !== null && run.decision === d;
    const x = running ? run.x : -1;
    const slot = d.slot === 1 ? 1 : 0;
    const n = this.stages;

    // The flow line through the chips; brighter up to the stage shown.
    const x0 = this.mid(0);
    ctx.fillStyle = FLOW;
    ctx.fillRect(x0, CHIP_Y - 0.5, this.mid(n - 1) - x0, 1);
    if (shown > 0 && !running) {
      ctx.fillStyle = FLOW_SHOWN;
      ctx.fillRect(x0, CHIP_Y - 0.5, this.mid(shown) - x0, 1);
    }
    if (this.sepW >= SEP_W) {
      for (let c = 1; c < n; c++) {
        const cx = this.colX[c] - this.sepW / 2;
        drawIcon(ctx, 'chevronRight', cx - 4, CHIP_Y - 4, 8, c <= shown && !running ? COLOR.muted : COLOR.lineStrong);
      }
    }

    // The chips: while running, the stage being crossed lights up in the
    // model's colour; else the selected one in white.
    for (let c = 0; c < n; c++) {
      const crossing = running && c === Math.ceil(x);
      this.chip(c, !running && c === shown, crossing, MODEL_COLOR[slot]);
    }

    // Figures, one row per model in its colour (one model: plain white).
    ctx.font = font(SIZE.small);
    ctx.textAlign = 'center';
    const ys = this.two ? NUM_Y_TWO : NUM_Y_ONE;
    for (let r = 0; r < ys.length; r++) {
      const ns = this.two ? SLOTS[r] : slot;
      const nums = this.nums[ns];
      ctx.fillStyle = this.two ? MODEL_COLOR[ns] : COLOR.high;
      for (let c = 0; c < n; c++) {
        if (nums[c]) ctx.fillText(nums[c], this.mid(c), ys[r], this.colW[c]);
      }
    }
    ctx.textAlign = 'left';

    // Animation 2: a trace from raw to where the bars are, and a spark.
    if (running) {
      const px = this.xAt(x);
      ctx.fillStyle = RUN_TRACE[slot];
      ctx.fillRect(x0, TRACE_Y - 0.5, Math.max(0, px - x0), 1);
      ctx.fillStyle = MODEL_COLOR[slot];
      ctx.shadowColor = RUN_GLOW[slot];
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(px, TRACE_Y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // The chip of column `c`: `shown` is the stage Candidates shows (white,
  // with a soft glow), `crossing` the one animation 2 is crossing.
  private chip(c: number, shown: boolean, crossing: boolean, color: string): void {
    const ctx = this.surface.ctx;
    const w = this.chipW[c];
    const x = this.mid(c) - w / 2;
    const y = CHIP_Y - CHIP_H / 2;
    ctx.fillStyle = shown ? COLOR.surface3 : COLOR.surface2;
    if (shown) {
      ctx.shadowColor = SHOWN_GLOW;
      ctx.shadowBlur = 12;
    }
    roundRect(ctx, x, y, w, CHIP_H, CHIP_H / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = shown ? SHOWN_LINE : crossing ? color : CHIP_LINE;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, CHIP_H - 1, (CHIP_H - 1) / 2);
    ctx.stroke();
    ctx.font = uiFont(11.5, shown ? 600 : 500);
    ctx.fillStyle = shown || crossing ? COLOR.high : COLOR.muted;
    ctx.textAlign = 'center';
    ctx.fillText(this.names[c], x + w / 2, CHIP_Y + 0.5, Math.max(1, w - 2 * CHIP_PAD + 4));
    ctx.textAlign = 'left';
  }

  // Lays the strip out again on the next paint: the web font has arrived.
  invalidate(): void {
    this.key.w = -1;
    this.store.dirty.gates = true;
  }

  dispose(): void {
    this.surface.dispose();
  }

  // ----------------------------------------------------------- internal

  // Lays out the columns for decision `d`, if anything they depend on
  // changed since the last paint.
  private layout(d: EvalData | undefined): void {
    const k = this.key;
    const vocab = this.store.hello?.n_vocab ?? 0;
    const w = this.surface.w;
    if (k.d === d && k.a === this.ev[0] && k.b === this.ev[1] && k.w === w && k.vocab === vocab) return;
    k.d = d;
    k.a = this.ev[0];
    k.b = this.ev[1];
    k.w = w;
    k.vocab = vocab;
    this.two = this.store.twoModels;
    this.stages = 0;
    if (!d) return;

    const n = Math.min(MAX_STAGES, d.nGates + 1);
    this.stages = n;
    const gates = d.config?.gates ?? [];
    const names = this.names;
    names.length = n;
    names[0] = 'raw';
    for (let c = 1; c < n; c++) names[c] = c - 1 < gates.length ? gateLabel(gates[c - 1]) : `gate ${c}`;

    for (const slot of SLOTS) {
      const e = this.ev[slot] ?? (slot === (d.slot === 1 ? 1 : 0) ? d : undefined);
      const nums = this.nums[slot];
      nums.length = n;
      for (let c = 0; c < n; c++) {
        if (!e) nums[c] = '';
        else if (c === 0) nums[c] = vocab > 0 ? compactCount(vocab) : '';
        else nums[c] = c - 1 < e.nGates ? compactCount(e.survivors[c - 1]) : '';
      }
    }

    // Columns as wide as their chip or figures. If the strip is too narrow
    // for the full names, short ones and tight gaps without a chevron; if
    // that is still too wide, the columns are squeezed alike (fillText then
    // narrows the text to fit).
    const ctx = this.surface.ctx;
    ctx.font = font(SIZE.small);
    const ch = ctx.measureText('0').width;
    const avail = Math.max(1, w - 2 * PAD);
    const measure = (): number => {
      let total = (n - 1) * this.sepW;
      for (let c = 0; c < n; c++) {
        ctx.font = uiFont(11.5, 600);
        const chip = ctx.measureText(names[c]).width + 2 * CHIP_PAD;
        let cw = chip;
        for (const slot of SLOTS) cw = Math.max(cw, this.nums[slot][c].length * ch);
        this.chipW[c] = chip;
        this.colW[c] = cw;
        total += cw;
      }
      return total;
    };
    this.sepW = SEP_W;
    let total = measure();
    if (total > avail) {
      for (let c = 1; c < n; c++) names[c] = c - 1 < gates.length ? gateShortLabel(gates[c - 1]) : `g${c}`;
      this.sepW = SEP_W_TIGHT;
      total = measure();
    }
    const squeeze = total > avail ? (avail - (n - 1) * this.sepW) / (total - (n - 1) * this.sepW) : 1;
    let cx = PAD;
    for (let c = 0; c < n; c++) {
      const k = Math.max(0.1, squeeze);
      this.colW[c] = Math.max(ch, this.colW[c] * k);
      this.chipW[c] = Math.min(this.colW[c], Math.max(2 * CHIP_PAD, this.chipW[c] * k));
      this.colX[c] = cx;
      cx += this.colW[c] + this.sepW;
    }
  }

  // Column under x (canvas px), with half a separator on each side; -1 if none.
  private columnAt(x: number): number {
    const half = this.sepW / 2;
    for (let c = 0; c < this.stages; c++) {
      if (x >= this.colX[c] - half && x < this.colX[c] + this.colW[c] + half) return c;
    }
    return -1;
  }

  // x (canvas px) of a stage position: the middle of column 0 at raw, of
  // column g + 1 after gate g, in between while the bars cross a gate.
  private xAt(pos: number): number {
    const last = this.stages - 1;
    const p = Math.max(0, Math.min(last, pos));
    const c = Math.floor(p);
    if (c >= last) return this.mid(last);
    return this.mid(c) + (this.mid(c + 1) - this.mid(c)) * (p - c);
  }

  private mid(c: number): number {
    return this.colX[c] + this.colW[c] / 2;
  }
}
