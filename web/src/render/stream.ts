// The Stream: the text in real DOM, one <span> per token group (split UTF-8
// characters are joined). With two models, always two columns side by side,
// A on the left and B on the right:
//
//   div.stream-text
//     div.prompt-block          the prompt tokens of the viewed path, once
//     div.columns               one column per model
//       div.col.a / div.col.b   div.col-head, div.col-wait, div.col-body
//
// One column holds the viewed path (see pathSlotOf): its spans are appended
// as the path grows and never rebuilt while the path epoch stays the same;
// only the last group is redone while its bytes are still an incomplete
// character. When the path is replaced (another branch), the spans of the
// prefix it keeps stay: only the rest is redone, without touching the
// scroll. The other column is read only and built from otherColumn: what the
// other model picked at each position, then its lane after a split. It is
// appended to while it only grows, and rebuilt otherwise.
//
//   ┌ (A) model Q4   writes the text ┐ ┌ (B) model Q8   12 tokens  2 differ ┐
//   │ The cat sat on the mat.        │ │ The cat [on] on the [dog]          │
//   └────────────────────────────────┘ └────────────────────────────────────┘
//
// Resting the pointer on a generated token opens a floating card (TokenCard)
// with its probability and the three most likely candidates of its decision.
//
// With two models, the first disagreement is ringed in both columns and
// joined by the seam (render/seam.ts): an SVG over div.columns that scrolls
// with the text, measured again only when that position, its spans or the
// layout change.

import '../stream.css';
import { ATTR_CONTROL, ATTR_EOG, ORIGIN_PROMPT, STOP_CONTEXT_FULL, STOP_EOG, STOP_MAX_TOKENS } from '../source/frames';
import {
  countDiffers,
  otherColumn,
  pathProbability,
  pathSlotOf,
  roleText,
  showsSplit,
  type OtherToken,
} from '../store/columns';
import type { EvalData, Slot, StopInfo, Store } from '../store/store';
import { groupTokens, showWhitespace, tokenLabel, type TokenGroup } from '../store/text';
import type { View } from '../store/view';
import { bitsText, pctShort } from './compare';
import { ICONS, type IconName } from './icons';
import { SEAM_DOT, seamGeometry, type Rect } from './seam';
import { COLOR, probColor } from './theme';

const EMPTY = new Uint8Array(0);

const CARD_DELAY_MS = 250; // rest on a token this long before its card opens
const CARD_ROWS = 3;
const CARD_CHARS = 18; // longest token label in the card

const SVG_NS = 'http://www.w3.org/2000/svg';
const SEAM_FLASH_MS = 360; // the seam's flash after the "diverges" chip
const SCROLL_WAIT_MS = 800; // longest wait for a smooth scroll to end

const STOP_TEXT: Record<number, string> = {
  [STOP_EOG]: 'end of generation',
  [STOP_MAX_TOKENS]: 'max tokens reached',
  [STOP_CONTEXT_FULL]: 'context full',
};

// A unit of the other column: items [start, end) of otherColumn's list.
interface OtherGroup {
  start: number;
  end: number;
  text: string;
  pos: number; // path index of its first item; -1 for a lane token (read only)
  plain: boolean; // grouped text (not a differing pick): may be redone if incomplete
}

// The header of a column.
interface Head {
  el: HTMLDivElement;
  edge: HTMLSpanElement;
  name: HTMLSpanElement;
  quant: HTMLSpanElement;
  count: HTMLSpanElement;
  differ: HTMLSpanElement; // shown with `hidden`; its text in differN
  differN: HTMLSpanElement;
  first: HTMLSpanElement; // shown with `hidden`; its text in firstN
  firstN: HTMLSpanElement;
  role: HTMLSpanElement;
}

// A selectable unit under the pointer: the span, the path index it stands
// for, and the column (model) it belongs to.
interface Unit {
  el: HTMLElement;
  index: number;
  slot: Slot;
  token: number; // the token this column shows there (its first, for a group)
}

export class StreamPanel {
  private readonly text: HTMLDivElement;
  private readonly promptBlock: HTMLDivElement;
  private readonly columns: HTMLDivElement;
  private readonly cols: [HTMLDivElement, HTMLDivElement]; // by slot
  private readonly heads: [Head, Head];
  private readonly waits: [HTMLDivElement, HTMLDivElement];
  private readonly bodies: [HTMLDivElement, HTMLDivElement];
  private readonly stopEl: HTMLSpanElement; // end of the viewed path
  private readonly laneStopEl: HTMLSpanElement; // end of the other model's lane
  private readonly pathMark: HTMLSpanElement; // the split, in the path column
  private readonly otherMark: HTMLSpanElement; // the split, in the other column

  // The viewed path, indexed by position in store.path.
  private epoch = -1;
  private split = -1;
  private pl = 0; // prompt length drawn
  private pathSlot: Slot = 0;
  private groups: TokenGroup[] = [];
  private spans: HTMLSpanElement[] = [];
  private groupOf: number[] = []; // token index → group index

  // The other column, indexed by position in its otherColumn list.
  private oSig = '';
  private oKey = '';
  private oItems: OtherToken[] = [];
  private oGroups: OtherGroup[] = [];
  private oSpans: HTMLSpanElement[] = [];
  private oByPos: (HTMLSpanElement | undefined)[] = []; // path index → its unit
  private hello: unknown = null; // the HELLO the headers were written for

  private stick = true; // follow the end of the text while generating
  private marked: HTMLSpanElement | null = null; // path span showing the selection
  private markedO: HTMLSpanElement | null = null; // other-column unit showing it

  // The hover card: built on first use, then only moved and refilled.
  private card: TokenCard | null = null;
  private cardUnit: Unit | null = null; // the unit the card is for (or waits for)
  private cardTimer = 0;

  // The seam at the first disagreement: what it was last drawn for.
  private readonly seam: Seam;
  private sFirst = -1;
  private sPath: HTMLSpanElement | null = null;
  private sOther: HTMLSpanElement | null = null;
  private sEpoch = -1;
  private layoutEpoch = 0; // bumped when the columns resize or the fonts load
  private sMid: number | null = null; // height to centre on, in the seam's box
  private ringed: HTMLSpanElement[] = [];
  private flash: Animation | null = null;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.text = div('stream-text');
    this.promptBlock = div('prompt-block');
    this.promptBlock.hidden = true;
    this.columns = div('columns one');
    this.cols = [div('col a path'), div('col b')];
    this.heads = [head(this.cols[0], 'A'), head(this.cols[1], 'B')];
    this.waits = [div('col-wait'), div('col-wait')];
    this.bodies = [div('col-body'), div('col-body')];
    for (const slot of [0, 1] as const) {
      this.waits[slot].textContent = 'waiting for the first token…';
      this.cols[slot].append(this.waits[slot], this.bodies[slot]);
      this.columns.append(this.cols[slot]);
      this.heads[slot].el.addEventListener('click', (e) => this.onHead(slot, e));
    }
    this.cols[1].hidden = true;
    this.stopEl = span('stop');
    this.laneStopEl = span('stop');
    this.pathMark = splitMark();
    this.otherMark = splitMark();
    this.bodies[0].append(this.stopEl);
    this.bodies[1].append(this.laneStopEl);
    this.seam = seamSvg();
    this.columns.append(this.seam.svg);
    this.text.append(this.promptBlock, this.columns);
    root.append(this.text);
    for (const h of this.heads) {
      h.first.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const i = Number(h.first.dataset.i);
        if (i >= 0) this.goToFirst(i);
      });
    }
    // Wrapping moves the lines: the seam is measured again. No cost per frame.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.relayout()).observe(this.columns);
    void document.fonts?.ready.then(() => this.relayout());

    root.addEventListener('scroll', () => {
      this.stick = root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      if (this.cardUnit) this.hideCard();
      this.clipSeam();
    });
    this.text.addEventListener('mouseover', (e) => {
      const u = this.unitAt(e.target);
      this.view.setHover(u?.index ?? null);
      this.hoverCard(u);
    });
    this.text.addEventListener('mouseleave', () => {
      this.view.setHover(null);
      this.hideCard();
    });
    this.text.addEventListener('click', (e) => {
      const u = this.unitAt(e.target);
      if (!u) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // the user is selecting text to copy
      const pinned = this.view.pinnedIndex();
      if (pinned !== null && (this.spanAt(pinned) === u.el || this.oByPos[pinned] === u.el)) this.view.unpin();
      else this.view.pin(u.index);
    });
  }

  // Brings the Stream up to date with the store and the selection.
  update(): void {
    const s = this.store;
    const n = s.path.length;
    const pl = s.promptLength;
    const two = s.twoModels;
    const pathSlot = pathSlotOf(s);

    if (s.pathEpoch !== this.epoch) {
      // The kept prefix is known only for one replacement since the last look.
      const kept = s.pathEpoch === this.epoch + 1 ? s.pathKept : 0;
      this.epoch = s.pathEpoch;
      if (kept > 0 && pl === this.pl) this.cut(kept);
      else this.rebuild(pl);
    }
    if (pl !== this.pl) this.rebuild(pl);
    if (n < this.groupOf.length) this.cut(n);
    if (s.split !== this.split) {
      const from = regroupFrom(this.groups, this.split, s.split);
      this.split = s.split;
      if (from >= 0) this.truncate(from);
    }
    if (pathSlot !== this.pathSlot) this.movePath(pathSlot);
    if (n > this.groupOf.length) this.append(n);
    this.placePathMark(showsSplit(s));

    this.columns.classList.toggle('one', !two);
    this.cols[1].hidden = !two;
    this.updateOther(two);
    this.updateHeads(two, n);

    this.promptBlock.hidden = pl === 0;
    this.waits[this.pathSlot].hidden = n > pl;
    setText(this.stopEl, stopText(s.stopAtEnd()));
    setText(this.laneStopEl, two && s.split >= 0 ? stopText(s.stopAtLaneEnd()) : '');
    this.root.classList.toggle('empty', n === 0);
    this.text.hidden = n === 0;
    this.mark();
    this.placeSeam(two);
    if (this.cardUnit && !this.cardUnit.el.isConnected) this.hideCard();
    if (this.stick) this.root.scrollTop = this.root.scrollHeight;
  }

  // Span drawing the token at `index` of the viewed path.
  spanAt(index: number): HTMLSpanElement | undefined {
    return this.spans[this.groupOf[index]];
  }

  // Unit of the other column standing for path index `index`, if any.
  otherSpanAt(index: number): HTMLSpanElement | undefined {
    return this.oByPos[index];
  }

  // The column of a model (animation 3).
  laneOf(slot: Slot): HTMLDivElement {
    return this.cols[slot];
  }

  // The coloured edge of a column's header (animation 3).
  edgeOf(slot: Slot): HTMLSpanElement {
    return this.heads[slot].edge;
  }

  // The split markers on the page (animation 3).
  splitMarks(): HTMLSpanElement[] {
    return [this.pathMark, this.otherMark].filter((m) => m.isConnected);
  }

  // The other column's units for lane tokens (animation 3).
  laneSpans(): HTMLSpanElement[] {
    const out: HTMLSpanElement[] = [];
    this.oGroups.forEach((g, i) => {
      if (g.pos < 0) out.push(this.oSpans[i]);
    });
    return out;
  }

  // Rectangle of a span in the viewport, or null if it is scrolled out of sight.
  visibleRect(span: HTMLElement): DOMRect | null {
    const r = span.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    if (r.bottom <= box.top || r.top >= box.bottom || r.width === 0) return null;
    return r;
  }

  // Scrolls the token at `index` into view (keyboard moves of the selection).
  reveal(index: number): void {
    this.spanAt(index)?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------- the path

  private rebuild(pl: number): void {
    for (const el of this.spans) el.remove();
    this.groups = [];
    this.spans = [];
    this.groupOf = [];
    this.marked = null;
    this.pl = pl;
    this.stick = true;
  }

  // Moves the generated path spans to the column of another model, and
  // takes their lightness from it. The other column is drawn again.
  private movePath(slot: Slot): void {
    this.clearOther();
    this.pathSlot = slot;
    const frag = document.createDocumentFragment();
    for (let g = 0; g < this.groups.length; g++) {
      if (this.groups[g].start < this.pl) continue;
      frag.append(this.spans[g]);
      this.color(g);
    }
    this.bodies[slot].append(frag, this.stopEl);
    this.bodies[slot === 0 ? 1 : 0].replaceChildren(this.laneStopEl);
    this.oKey = '';
  }

  // Keeps the spans of the first `kept` path tokens and drops the rest,
  // with the group that holds token `kept` (see cutPoint).
  private cut(kept: number): void {
    const from = cutPoint(this.groups, kept);
    if (from < this.groupOf.length) this.truncate(from);
  }

  // Drops the path groups from token `from` on (`from` starts a group).
  private truncate(from: number): void {
    while (this.groups.length > 0 && this.groups[this.groups.length - 1].start >= from) {
      this.groups.pop();
      this.spans.pop()?.remove();
    }
    const last = this.groups[this.groups.length - 1];
    this.groupOf.length = last ? last.end : 0;
    if (this.marked && !this.marked.isConnected) this.marked = null;
  }

  private append(n: number): void {
    // The last group is redone while its bytes are still incomplete: the
    // next token may finish its character, unless the split or the end of
    // the prompt ends it.
    const last = this.groups[this.groups.length - 1];
    if (last && last.text.includes('�') && last.end !== this.split + 1 && last.end !== this.pl) {
      this.truncate(last.start);
    }
    const from = this.groupOf.length;

    const s = this.store;
    const prompt = document.createDocumentFragment();
    const body = document.createDocumentFragment();
    for (const [a, b] of segments(from, n, this.split, this.pl)) {
      const bytes: Uint8Array[] = [];
      const control: boolean[] = [];
      for (let i = a; i < b; i++) tokenBytes(s, s.path[i], bytes, control);
      for (const g of groupTokens(bytes, control)) {
        const group = { start: g.start + a, end: g.end + a, text: g.text };
        const gi = this.groups.length;
        this.groups.push(group);
        for (let i = group.start; i < group.end; i++) this.groupOf[i] = gi;
        const el = tokenSpan(s, group.text, s.path[group.start]);
        this.spans.push(el);
        if (group.start < this.pl) {
          el.classList.add('prompt'); // no decision: no lightness, no mark, not selectable
          prompt.append(el);
        } else {
          el.dataset.g = String(gi);
          this.color(gi);
          body.append(el);
        }
      }
    }
    this.promptBlock.append(prompt);
    this.bodies[this.pathSlot].insertBefore(body, this.stopEl);
  }

  // Lightness and disagreement mark of path group `gi`. A group is as sure
  // as its least sure token, and as divergent as its most divergent
  // disagreement.
  private color(gi: number): void {
    const s = this.store;
    const g = this.groups[gi];
    const el = this.spans[gi];
    let p = 1;
    let js = -1;
    for (let i = g.start; i < g.end; i++) {
      p = Math.min(p, pathProbability(s, i, this.pathSlot) ?? 0);
      if (s.disagrees(i)) js = Math.max(js, s.pairAt(i)?.js ?? 0);
    }
    if (!el.classList.contains('ctl')) el.style.color = probColor(p);
    if (js >= 0) {
      el.classList.add('dis');
      el.style.setProperty('--js', clamp01(js).toFixed(2));
    }
  }

  // The split marker sits right after the last common token.
  private placePathMark(show: boolean): void {
    const m = this.pathMark;
    if (!show) {
      m.remove();
      return;
    }
    const body = this.bodies[this.pathSlot];
    if (this.split < this.pl) {
      if (body.firstChild !== m) body.prepend(m);
      return;
    }
    const ref = this.spanAt(this.split);
    if (ref && ref.nextSibling !== m) ref.after(m);
  }

  // ------------------------------------------------- the other column

  private updateOther(two: boolean): void {
    const s = this.store;
    if (!two) {
      if (this.oItems.length > 0 || this.otherMark.isConnected) this.clearOther();
      this.oSig = '';
      return;
    }
    const c = s.config;
    const key = `${s.pathEpoch}|${s.laneEpoch}|${s.split}|${s.front}|${c?.mode}|${c?.driver}|${this.pl}|${this.pathSlot}`;
    // Nothing to redo while no frame arrived and the layout did not change
    // (hovering, pinning).
    const sig = `${key}|${s.framesApplied}`;
    if (sig === this.oSig) return;
    this.oSig = sig;

    const other: Slot = this.pathSlot === 0 ? 1 : 0;
    const items = otherColumn(s, other, this.pathSlot);
    const drawn = this.oItems.length;
    const grew =
      key === this.oKey && items.length >= drawn && (drawn === 0 || sameItem(items[drawn - 1], this.oItems[drawn - 1]));
    if (!grew) this.clearOther();
    this.oKey = key;
    this.appendOther(items);
    this.oItems = items;

    this.waits[other].hidden = items.length > 0;
    const h = this.heads[other];
    setText(h.count, count(items.length));
    const nd = countDiffers(items);
    setFig(h.differ, h.differN, nd > 0 ? `${nd} differ` : '');
    const first = s.firstDisagreement();
    setFig(h.first, h.firstN, first >= 0 ? `diverges #${first} →` : '');
    h.first.dataset.i = String(first);
    const ph = this.heads[this.pathSlot];
    setFig(ph.differ, ph.differN, '');
    setFig(ph.first, ph.firstN, '');
  }

  private clearOther(): void {
    for (const el of this.oSpans) el.remove();
    this.otherMark.remove();
    this.oItems = [];
    this.oGroups = [];
    this.oSpans = [];
    this.oByPos = [];
    if (this.markedO && !this.markedO.isConnected) this.markedO = null;
  }

  // Draws the items of `items` not drawn yet, redoing an incomplete last
  // group of plain text.
  private appendOther(items: readonly OtherToken[]): void {
    let from = this.oItems.length;
    const last = this.oGroups[this.oGroups.length - 1];
    if (last && last.plain && last.text.includes('�') && last.end === from && from < items.length) {
      const next = items[from];
      if (!next.differs && !next.split) {
        this.oGroups.pop();
        this.oSpans.pop()?.remove();
        from = last.start;
      }
    }
    if (from >= items.length) return;

    const s = this.store;
    const frag = document.createDocumentFragment();
    let i = from;
    while (i < items.length) {
      const t = items[i];
      if (t.split) frag.append(this.otherMark);
      if (t.differs) {
        // A pick that is not the text: a unit of its own, a magenta pill.
        const v = s.vocab.get(t.token);
        const el = span('diff');
        // A whitespace-only pick would be an empty pill: show its whitespace.
        const label = tokenLabel(v?.bytes ?? EMPTY);
        el.textContent = label.trim() === '' ? showWhitespace(label) : label.replace(/\n/g, '↵');
        if ((v?.attr ?? 0) & ATTR_EOG) el.classList.add('eog');
        el.style.color = probColor(t.p);
        if (t.js >= 0) el.style.setProperty('--js', clamp01(t.js).toFixed(2));
        this.addOther(frag, el, { start: i, end: i + 1, text: el.textContent, pos: t.pos, plain: false }, items);
        i++;
        continue;
      }
      // A run of plain tokens, grouped by UTF-8, up to the next differing
      // pick or the split.
      let j = i + 1;
      while (j < items.length && !items[j].differs && !items[j].split) j++;
      const bytes: Uint8Array[] = [];
      const control: boolean[] = [];
      for (let k = i; k < j; k++) {
        const v = s.vocab.get(items[k].token);
        bytes.push(v?.bytes ?? EMPTY);
        control.push(((v?.attr ?? 0) & ATTR_CONTROL) !== 0);
      }
      for (const g of groupTokens(bytes, control)) {
        const start = g.start + i;
        const end = g.end + i;
        let p = 1;
        for (let k = start; k < end; k++) p = Math.min(p, items[k].p);
        const el = document.createElement('span');
        el.textContent = g.text;
        const attr = s.vocab.get(items[start].token)?.attr ?? 0;
        if (attr & ATTR_CONTROL) el.className = attr & ATTR_EOG ? 'ctl eog' : 'ctl';
        else el.style.color = probColor(p);
        this.addOther(frag, el, { start, end, text: g.text, pos: items[start].pos, plain: true }, items);
      }
      i = j;
    }
    const other = this.pathSlot === 0 ? 1 : 0;
    this.bodies[other].insertBefore(frag, this.laneStopEl);
  }

  private addOther(frag: DocumentFragment, el: HTMLSpanElement, g: OtherGroup, items: readonly OtherToken[]): void {
    const gi = this.oGroups.length;
    this.oGroups.push(g);
    this.oSpans.push(el);
    if (g.pos >= 0) {
      el.dataset.o = String(gi); // lane tokens are read only
      for (let k = g.start; k < g.end; k++) this.oByPos[items[k].pos] = el;
    }
    frag.append(el);
  }

  // --------------------------------------------------------- headers

  private updateHeads(two: boolean, n: number): void {
    const s = this.store;
    if (s.hello !== this.hello) {
      this.hello = s.hello;
      for (const slot of [0, 1] as const) {
        const m = s.hello?.models[slot];
        setText(this.heads[slot].name, m?.name ?? '');
        setText(this.heads[slot].quant, m?.quant ?? '');
      }
    }
    for (const slot of [0, 1] as const) {
      const h = this.heads[slot];
      setText(h.role, roleText(s, slot, this.pathSlot));
      this.cols[slot].classList.toggle('front', two && s.front === slot);
      this.cols[slot].classList.toggle('path', slot === this.pathSlot);
      h.el.classList.toggle('pick', two);
    }
    setText(this.heads[this.pathSlot].count, count(Math.max(0, n - this.pl)));
    if (!two) {
      setFig(this.heads[0].differ, this.heads[0].differN, '');
      setFig(this.heads[0].first, this.heads[0].firstN, '');
    }
  }

  // A click on a header puts its model in front; on "diverges #n", goes to
  // the first disagreement.
  private onHead(slot: Slot, e: MouseEvent): void {
    const first = (e.target as Element | null)?.closest?.('.first') as HTMLElement | null;
    if (first) {
      const i = Number(first.dataset.i);
      if (i >= 0) this.goToFirst(i);
      return;
    }
    if (this.store.twoModels) this.store.setFront(slot);
  }

  // --------------------------------------------------------- the seam

  // Pins the first disagreement `i`, scrolls the Stream so the middle of its
  // seam (or the token, with one side only) is centred under the sticky
  // header, and flashes the seam once it is there.
  goToFirst(i: number): void {
    this.view.pin(i);
    const root = this.root;
    let y: number | null = null; // in the viewport
    if (i === this.sFirst && this.sMid !== null) y = this.seam.svg.getBoundingClientRect().top + this.sMid;
    else {
      const r = this.spanAt(i)?.getClientRects()[0];
      if (r) y = (r.top + r.bottom) / 2;
    }
    if (y === null) {
      this.reveal(i);
      return;
    }
    this.stick = false; // do not snap back to the end while scrolling away
    const box = root.getBoundingClientRect();
    const top = box.top + root.clientTop + this.heads[this.pathSlot].el.offsetHeight;
    const bottom = box.top + root.clientTop + root.clientHeight;
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const target = Math.min(max, Math.max(0, root.scrollTop + y - (top + bottom) / 2));
    const reduced = this.reduced.matches;
    if (Math.abs(target - root.scrollTop) < 1) {
      this.flashSeam();
      return;
    }
    root.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
    if (!reduced) this.afterScroll(() => this.flashSeam());
  }

  // Rings the first disagreement in both columns and draws its seam, when
  // that position, its spans or the layout changed since the last time.
  private placeSeam(two: boolean): void {
    const first = two ? this.store.firstDisagreement() : -1;
    let path = first >= 0 ? (this.spanAt(first) ?? null) : null;
    if (path?.classList.contains('prompt')) path = null;
    const other = first >= 0 ? (this.oByPos[first] ?? null) : null;
    if (
      first === this.sFirst &&
      path === this.sPath &&
      other === this.sOther &&
      this.sEpoch === this.layoutEpoch
    ) {
      return;
    }
    this.sFirst = first;
    this.sPath = path;
    this.sOther = other;
    this.sEpoch = this.layoutEpoch;
    for (const el of this.ringed) if (el !== path && el !== other) el.classList.remove('first-dis');
    this.ringed = [];
    for (const el of [path, other]) {
      if (!el) continue;
      el.classList.add('first-dis');
      this.ringed.push(el);
    }
    this.drawSeam();
  }

  // The columns were resized or the fonts loaded: the lines may have moved.
  private relayout(): void {
    this.layoutEpoch++;
    this.sEpoch = this.layoutEpoch;
    this.drawSeam();
  }

  // Measures the spans the seam was placed for and draws it: a few
  // getBoundingClientRect, only when placeSeam or relayout asks.
  private drawSeam(): void {
    const sm = this.seam;
    const geo = this.measureSeam();
    this.sMid = geo?.mid ?? null;
    sm.svg.classList.toggle('on', geo !== null);
    if (!geo) return;
    sm.path.setAttribute('d', geo.path);
    show(sm.path, geo.path !== '');
    sm.dots.forEach((c, k) => {
      const d = geo.dots[k];
      show(c, d !== undefined);
      if (!d) return;
      c.setAttribute('cx', String(d.x));
      c.setAttribute('cy', String(d.y));
    });
    show(sm.label, geo.label !== null);
    if (geo.label) {
      sm.label.setAttribute('x', String(geo.label.x));
      sm.label.setAttribute('y', String(geo.label.y));
      if (sm.label.textContent !== geo.label.text) sm.label.textContent = geo.label.text;
    }
    sm.marks.forEach((m, k) => {
      const g = geo.marks[k];
      show(m, g !== undefined);
      if (!g) return;
      m.setAttribute('x', String(g.x));
      m.setAttribute('y', String(g.y));
      m.setAttribute('width', String(g.w));
      m.setAttribute('height', String(g.h));
    });
    this.clipSeam();
  }

  // The column headers are sticky and the seam scrolls with the text: the
  // part of the seam that runs under the stuck headers (and the gap between
  // them) is cut off. Two reads per scroll, only while the seam is shown.
  private clipSeam(): void {
    const svg = this.seam.svg;
    if (this.sMid === null) return;
    const top = svg.getBoundingClientRect().top;
    const head = this.heads[this.pathSlot].el.getBoundingClientRect().bottom;
    const cut = Math.max(0, Math.round(head - top));
    const clip = cut > 0 ? `inset(${cut}px 0 0 0)` : '';
    if (svg.style.clipPath !== clip) svg.style.clipPath = clip;
  }

  private measureSeam(): ReturnType<typeof seamGeometry> {
    const first = this.sFirst;
    if (first < 0 || (!this.sPath && !this.sOther)) return null;
    const o = this.seam.svg.getBoundingClientRect();
    if (o.width === 0) return null; // not laid out (hidden panel)
    // By the columns' actual places, so the seam always runs left to right.
    const c0 = this.cols[0].getBoundingClientRect();
    const c1 = this.cols[1].getBoundingClientRect();
    const leftSlot: Slot = c0.left <= c1.left ? 0 : 1;
    const lc = leftSlot === 0 ? c0 : c1;
    const rc = leftSlot === 0 ? c1 : c0;
    const bySlot = this.pathSlot === 0 ? [this.sPath, this.sOther] : [this.sOther, this.sPath];
    const rel = (el: HTMLElement | null): Rect | null => {
      const r = el?.isConnected ? el.getClientRects()[0] : undefined;
      return r ? { left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top } : null;
    };
    return seamGeometry(
      rel(bySlot[leftSlot]),
      rel(bySlot[leftSlot === 0 ? 1 : 0]),
      lc.right - o.left,
      rc.left - o.left,
      lc.left - o.left,
      rc.right - o.left,
      `#${first}`,
    );
  }

  // One short flash of the seam (none with reduced motion).
  private flashSeam(): void {
    if (this.reduced.matches || this.sMid === null) return;
    this.flash?.cancel();
    this.flash = this.seam.svg.animate(
      [{ filter: `drop-shadow(0 0 5px ${COLOR.dis})` }, { filter: 'drop-shadow(0 0 0 transparent)' }],
      { duration: SEAM_FLASH_MS, easing: 'ease-out' },
    );
  }

  // Runs `fn` once the Stream's smooth scroll has ended (or after a while,
  // where scrollend is not supported).
  private afterScroll(fn: () => void): void {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.root.removeEventListener('scrollend', finish);
      clearTimeout(timer);
      fn();
    };
    this.root.addEventListener('scrollend', finish);
    const timer = window.setTimeout(finish, SCROLL_WAIT_MS);
  }

  // ------------------------------------------------------- selection

  // Highlights the hovered or pinned unit in both columns (the default
  // "last token" is not highlighted: it is simply the end of the text).
  private mark(): void {
    const pinned = this.view.pinnedIndex();
    const index = pinned ?? this.view.hoveredIndex();
    const el = index === null ? null : (this.spanAt(index) ?? null);
    const oel = index === null ? null : (this.oByPos[index] ?? null);
    this.marked = swapMark(this.marked, el, pinned !== null);
    this.markedO = swapMark(this.markedO, oel, pinned !== null);
  }

  // The selectable unit under an event target: a generated path group or a
  // pick of the other column, with the path index it stands for.
  private unitAt(target: EventTarget | null): Unit | null {
    const el = (target as Element | null)?.closest?.('span[data-g], span[data-o]') as HTMLElement | null;
    if (!el || !this.text.contains(el)) return null;
    if (el.dataset.g !== undefined) {
      const g = Number(el.dataset.g);
      if (this.spans[g] !== el) return null;
      const index = this.groups[g].start;
      return { el, index, slot: this.pathSlot, token: this.store.token[this.store.path[index]] };
    }
    const o = Number(el.dataset.o);
    if (this.oSpans[o] !== el) return null;
    const g = this.oGroups[o];
    return { el, index: g.pos, slot: this.pathSlot === 0 ? 1 : 0, token: this.oItems[g.start]?.token ?? -1 };
  }

  // ------------------------------------------------------- hover card

  // The pointer is on unit `u` (or on none). The card opens after a short
  // rest; once open, it follows from token to token at once.
  private hoverCard(u: Unit | null): void {
    if (!u) {
      this.hideCard();
      return;
    }
    if (this.cardUnit?.el === u.el) return;
    this.cardUnit = u;
    if (this.card?.open) {
      this.showCard();
      return;
    }
    clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.showCard(), CARD_DELAY_MS);
  }

  private showCard(): void {
    const u = this.cardUnit;
    if (!u || !u.el.isConnected) return this.hideCard();
    const s = this.store;
    const d = s.decisionOf(u.index, u.slot) ?? s.decision(u.index);
    if (!d) return this.hideCard();
    this.card ??= new TokenCard();
    this.card.show(u.el, s, d, u.index, u.token);
  }

  private hideCard(): void {
    clearTimeout(this.cardTimer);
    this.cardUnit = null;
    this.card?.hide();
  }
}

// The floating card of a hovered token: the token, its probability, and the
// three most likely candidates of its decision with small bars, in the
// colour of the model that decided it. One element in <body>, made the
// first time it is needed; hidden with display: none, so it costs nothing
// while unused.
//
//   (A) position #45            1.75 bits
//   "Island"                          41%
//   ─────────────────────────────────────
//   ● Island      ███████████         41%
//     Isle        ████████            30%
//     Is          ███                 12%
class TokenCard {
  private readonly el: HTMLDivElement;
  private readonly slot: HTMLSpanElement;
  private readonly pos: HTMLSpanElement;
  private readonly entropy: HTMLSpanElement;
  private readonly tok: HTMLSpanElement;
  private readonly prob: HTMLSpanElement;
  private readonly rows: { el: HTMLDivElement; label: HTMLSpanElement; fill: HTMLElement; pct: HTMLSpanElement }[] = [];
  private readonly top: number[] = [];
  open = false;

  constructor() {
    this.el = div('tok-card glass');
    this.el.setAttribute('aria-hidden', 'true');
    const headEl = div('tc-head');
    this.slot = span('tc-slot');
    this.pos = span('tc-pos');
    this.entropy = span('tc-ent');
    headEl.append(this.slot, this.pos, this.entropy);
    const main = div('tc-tok');
    this.tok = span('tc-text');
    this.prob = span('tc-p');
    main.append(this.tok, this.prob);
    const list = div('tc-rows');
    for (let k = 0; k < CARD_ROWS; k++) {
      const row = div('tc-row');
      const label = span('tc-label');
      const track = span('tc-bar');
      const fill = document.createElement('i');
      track.append(fill);
      const pct = span('tc-pct');
      row.append(label, track, pct);
      list.append(row);
      this.rows.push({ el: row, label, fill, pct });
    }
    this.el.append(headEl, main, list);
    this.el.style.display = 'none';
    document.body.append(this.el);
  }

  // Fills the card for token `token` at path `index` of decision `d`, and
  // places it under (or over) `anchor`.
  show(anchor: HTMLElement, s: Store, d: EvalData, index: number, token: number): void {
    const b = d.slot === 1;
    this.el.classList.toggle('b', b);
    setText(this.slot, b ? 'B' : 'A');
    setText(this.pos, `position #${index}`);
    setText(this.entropy, `${bitsText(d.entropy)} bits`);
    const j = indexIn(d.tokens, token);
    const p = j >= 0 ? d.pRaw[j] : 0;
    setText(this.tok, cardLabel(s, token));
    this.tok.style.color = probColor(p);
    setText(this.prob, j >= 0 ? pctShort(p) : '–');

    const n = topEntries(d.pRaw, d.tokens.length, CARD_ROWS, this.top);
    const max = n > 0 ? d.pRaw[this.top[0]] : 1;
    for (let k = 0; k < CARD_ROWS; k++) {
      const r = this.rows[k];
      r.el.hidden = k >= n;
      if (k >= n) continue;
      const e = this.top[k];
      setText(r.label, cardLabel(s, d.tokens[e]));
      setText(r.pct, pctShort(d.pRaw[e]));
      r.fill.style.width = `${Math.max(3, (100 * d.pRaw[e]) / (max || 1)).toFixed(1)}%`;
      r.el.classList.toggle('on', d.tokens[e] === token);
      r.el.classList.toggle('pick', e === d.pick);
    }

    const box = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
    const wasOpen = this.open;
    this.el.style.display = '';
    const { x, y } = placeCard(box, this.el.offsetWidth, this.el.offsetHeight, window.innerWidth, window.innerHeight);
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    if (!wasOpen) this.el.classList.add('on'); // fades in from the style just computed
    this.open = true;
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    this.el.style.display = 'none';
  }
}

// ----------------------------------------------------------------- pure

// Ranges of [from, to) to group separately: a UTF-8 group never crosses the
// split nor the end of the prompt, so tokens up to `split` and those after
// it are grouped apart, and so are the prompt's and the generated ones.
export function segments(from: number, to: number, split: number, promptLength = 0): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of cutAt(from, to, split + 1)) out.push(...cutAt(a, b, promptLength));
  return out;
}

function cutAt(from: number, to: number, cut: number): [number, number][] {
  if (from >= to) return [];
  if (cut <= from || cut >= to) return [[from, to]];
  return [
    [from, cut],
    [cut, to],
  ];
}

// When the split moves from `oldSplit` to `newSplit`, the first token from
// which the path groups must be redone, or -1 if none: a group that crosses
// the new split, or an incomplete group the old split cut short (the tokens
// after it may finish its character now).
export function regroupFrom(groups: readonly TokenGroup[], oldSplit: number, newSplit: number): number {
  let cut = -1;
  for (const g of groups) {
    const crosses = newSplit >= 0 && g.start <= newSplit && g.end > newSplit + 1;
    const cutShort = oldSplit >= 0 && oldSplit !== newSplit && g.end === oldSplit + 1 && g.text.includes('�');
    if (crosses || cutShort) {
      cut = g.start; // groups are in order: the first one found is the earliest
      break;
    }
  }
  return cut;
}

// The path keeps its first `kept` tokens: the first token from which the
// groups must be redone. The start of the group holding token `kept` (it
// mixes kept and new tokens), or of an incomplete group ending right before
// it (the new tokens may finish its character); else `kept`.
export function cutPoint(groups: readonly TokenGroup[], kept: number): number {
  for (const g of groups) {
    if (g.end > kept || (g.end === kept && g.text.includes('�'))) return Math.min(g.start, kept);
  }
  return kept;
}

// Indices of the `k` largest of the first `n` values of `p`, largest first,
// written to `out`; returns how many (min(k, n)).
export function topEntries(p: ArrayLike<number>, n: number, k: number, out: number[]): number {
  out.length = 0;
  for (let i = 0; i < n; i++) {
    const v = p[i];
    let at = out.length;
    while (at > 0 && p[out[at - 1]] < v) at--;
    if (at < k) {
      out.splice(at, 0, i);
      if (out.length > k) out.length = k;
    }
  }
  return out.length;
}

// Top-left corner of a `w` × `h` card for a token whose box is `r`, in a
// `vw` × `vh` viewport: under the token, or over it if there is no room
// below; never past the edges, never on the token while it fits.
export function placeCard(
  r: { left: number; top: number; bottom: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
): { x: number; y: number } {
  const M = 8; // margin to the viewport's edges
  const GAP = 8; // between the token and the card
  const x = Math.max(M, Math.min(r.left - 12, vw - w - M));
  let y = r.bottom + GAP;
  if (y + h > vh - M) y = r.top - GAP - h;
  return { x, y: Math.max(M, Math.min(y, vh - h - M)) };
}

// ------------------------------------------------------------- helpers

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function span(className: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  return el;
}

// A column header: coloured edge, slot badge, model name and quant, live
// figures, and what the column is.
function head(col: HTMLDivElement, letter: string): Head {
  const el = div('col-head');
  const edge = span('edge');
  const slot = span('slot');
  slot.textContent = letter;
  const name = span('name');
  const quant = span('quant');
  const figs = span('figs');
  const count = span('count');
  const differ = span('differ');
  const differN = span('n');
  differ.append(span('tri'), differN);
  differ.hidden = true;
  const first = span('first');
  const firstN = span('n');
  first.append(firstN);
  first.title = 'Go to where A and B first diverge';
  first.setAttribute('role', 'button');
  first.tabIndex = 0;
  first.hidden = true;
  figs.append(count, differ, first);
  const role = span('role');
  el.append(edge, slot, name, quant, figs, role);
  col.append(el);
  return { el, edge, name, quant, count, differ, differN, first, firstN, role };
}

// The seam's SVG: a curve, two dots, a label and two margin bars, made once
// and only moved (see render/seam.ts).
interface Seam {
  svg: SVGSVGElement;
  path: SVGPathElement;
  dots: SVGCircleElement[];
  label: SVGTextElement;
  marks: SVGRectElement[];
}

function seamSvg(): Seam {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('seam');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.classList.add('seam-line');
  const dots = [0, 1].map(() => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.classList.add('seam-dot');
    c.setAttribute('r', String(SEAM_DOT));
    return c;
  });
  const label = document.createElementNS(SVG_NS, 'text');
  label.classList.add('seam-label');
  const marks = [0, 1].map(() => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.classList.add('seam-mark');
    r.setAttribute('rx', '1.5');
    return r;
  });
  svg.append(path, ...dots, label, ...marks);
  return { svg, path, dots, label, marks };
}

function show(el: SVGElement, on: boolean): void {
  el.style.display = on ? '' : 'none';
}

function splitMark(): HTMLSpanElement {
  const el = span('split-mark');
  el.append(icon('branch'), 'split');
  return el;
}

// An inline line icon from the shared set (render/icons.ts).
function icon(name: IconName): SVGSVGElement {
  const ns = SVG_NS;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// A header figure: its text, hidden while empty.
function setFig(el: HTMLElement, textEl: HTMLElement, text: string): void {
  setText(textEl, text);
  if (el.hidden !== (text === '')) el.hidden = text === '';
}

// A token as the hover card shows it: whitespace made visible, clipped.
function cardLabel(s: Store, tok: number): string {
  const v = s.vocab.get(tok);
  const text = v ? showWhitespace(tokenLabel(v.bytes)) : `#${tok}`;
  const chars = Array.from(text);
  return chars.length <= CARD_CHARS ? text : chars.slice(0, CARD_CHARS - 1).join('') + '…';
}

function indexIn(tokens: ArrayLike<number>, token: number): number {
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === token) return i;
  return -1;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function count(n: number): string {
  return n === 1 ? '1 token' : `${n} tokens`;
}

function sameItem(a: OtherToken, b: OtherToken): boolean {
  return a.token === b.token && a.pos === b.pos && a.differs === b.differs && a.split === b.split;
}

function swapMark(prev: HTMLSpanElement | null, el: HTMLSpanElement | null, pinned: boolean): HTMLSpanElement | null {
  if (prev !== el) prev?.classList.remove('sel', 'pin');
  if (el) {
    el.classList.add('sel');
    el.classList.toggle('pin', pinned);
  }
  return el;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x)) || 0;
}

function stopText(stop: StopInfo | undefined): string {
  return stop ? (STOP_TEXT[stop.reason] ?? 'stopped') : '';
}

function tokenBytes(s: Store, node: number, bytes: Uint8Array[], control: boolean[]): void {
  const v = s.vocab.get(s.token[node]);
  bytes.push(v?.bytes ?? EMPTY);
  control.push(((v?.attr ?? 0) & ATTR_CONTROL) !== 0);
}

// A path token group: a pill for a control token. Lightness and marks are
// set apart (StreamPanel.color), prompt tokens have neither.
function tokenSpan(s: Store, text: string, node: number): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  const attr = s.vocab.get(s.token[node])?.attr ?? 0;
  if (attr & ATTR_CONTROL) el.className = attr & ATTR_EOG ? 'ctl eog' : 'ctl';
  if (s.origin[node] === ORIGIN_PROMPT) el.classList.add('prompt');
  return el;
}
