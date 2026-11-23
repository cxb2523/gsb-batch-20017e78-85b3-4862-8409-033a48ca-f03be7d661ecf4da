// The store: everything the interface knows about the session, built by
// applying frames in order. Plain arrays and maps, no Svelte reactivity: the
// paint loop reads it and repaints the panels flagged in `dirty`.
//
// With two models:
//
//   path                       lane
//   0 ─ 1 ─ 2 ─ 3 ─ 4 ─┬─ 5 ─ 7 ─ 9      ◄ cursor of the model in front
//                 split └─ 6 ─ 8          ◄ cursor of the other model
//
// `path` follows the cursor of the model in front; `lane` is what the other
// model wrote after the two split, and `split` the index in `path` of their
// last common node.
//
// The user may choose another path by hand (a branch of the minimap): then
// `follow` is false, `path` stays where it was chosen whatever the cursors
// do, and there is no lane. Looking never moves the engine.

import {
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_PAIR,
  FRAME_STOP,
  FRAME_VOCAB,
  NONE,
  ORIGIN_PROMPT,
  PAIR_SAME_PICK,
  PROTOCOL_VERSION,
  type Config,
  type EvalFrame,
  type Frame,
  type Hello,
  type PairFrame,
  type VocabEntry,
} from '../source/frames';

export type Slot = 0 | 1; // 0: model A, 1: model B

// An EVAL with the CONFIG that was in force when it arrived: its gates are
// read with that configuration, not with the latest one.
export interface EvalData extends EvalFrame {
  config: Config | null;
}

export interface StopInfo {
  slot: number; // 0: A, 1: B, 2: both
  reason: number;
}

// What changed since the paint loop last looked. The loop clears the flags.
export interface Dirty {
  meta: boolean; // HELLO or CONFIG: models, warnings, configuration; the model in front
  stream: boolean;
  candidates: boolean;
  gates: boolean; // the gate strip under Candidates
  timeline: boolean;
  relief: boolean; // the 3D relief: its heights or the selected position
  metrics: boolean; // the strip of live figures
  lens: boolean; // the Layers view of the dock (logit lens in 2D)
  compare: boolean; // the Compare view of the Inspector (A against B)
}

// A branch hanging from the viewed path, for the minimap: `child` is a child
// of `path[fromIndex]` that is not the next node of the path; `tip` the leaf
// the branch leads to (see tipOf) and `tipDepth` its depth.
export interface Branch {
  fromIndex: number;
  child: number;
  tip: number;
  tipDepth: number;
}

// Where a cursor is drawn on the minimap: on the viewed path (`branch` -1)
// or on one of branches() (its index), at `depth`.
export interface CursorMark {
  slot: Slot;
  depth: number;
  branch: number;
}

const NO_CHILDREN: readonly number[] = [];

export class Store {
  hello: Hello | null = null;
  config: Config | null = null;
  // The session uses a newer protocol than this reader: nothing else is read.
  unsupported = false;

  readonly vocab = new Map<number, VocabEntry>();

  // Nodes, indexed by node id.
  parent: number[] = [];
  token: number[] = [];
  depth: number[] = [];
  origin: number[] = [];
  // Children of each node id, in arrival order (ids grow); undefined for a leaf.
  children: number[][] = [];

  // EVAL per slot, then per node id.
  evals: [(EvalData | undefined)[], (EvalData | undefined)[]] = [[], []];
  // PAIR per node id: the comparison of A and B where both evaluated the node.
  pairs: (PairFrame | undefined)[] = [];
  // Why a node cannot be continued. Two stops at one node merge into slot 2.
  readonly stops = new Map<number, StopInfo>();

  cursorA = NONE;
  cursorB = NONE;

  // The model in front: the one whose data wins when a panel must choose.
  // The driver in lockstep and A in free mode, until the user picks one.
  front: Slot = 0;

  // The viewed path: node ids from the root to the cursor of the model in
  // front while `follow` is true; to a tip chosen by hand otherwise.
  path: number[] = [];
  follow = true;
  // Bumped whenever `path` is replaced instead of extended at its end: what
  // was drawn from the old path beyond `pathKept` (the Stream's spans, a
  // selection) is void.
  pathEpoch = 0;
  // Length of the prefix the last replacement kept from the path before it
  // (0 after a reset). Valid for whoever saw the epoch just before this one.
  pathKept = 0;
  // After a branch or goto sent with follow, the path waits for the next
  // CURSOR instead of going back to the old cursor first (no flicker).
  private awaiting = false;

  // The other model's nodes after the split, and the index in `path` of the
  // last node the two share. -1 and empty while the cursors coincide (always,
  // in lockstep) or with a single model. `lane` can be empty with a split:
  // the other cursor stayed behind on the path.
  lane: number[] = [];
  split = -1;
  // Bumped whenever `lane` or `split` change in any way other than `lane`
  // growing at its end.
  laneEpoch = 0;
  // Times the cursors of A and B have gone from the same node to different
  // ones in this session: the trigger of animation 3.
  splits = 0;

  framesApplied = 0; // since the page loaded, for the debug panel
  sessionTime = 0; // t_ms of the last frame applied

  readonly dirty: Dirty = {
    meta: true,
    stream: true,
    candidates: true,
    gates: true,
    timeline: true,
    relief: true,
    metrics: true,
    lens: true,
    compare: true,
  };

  // Empties the session state, as a HELLO does. Also used by the player when
  // it rebuilds the state from the start.
  reset(): void {
    this.hello = null;
    this.config = null;
    this.unsupported = false;
    this.vocab.clear();
    this.parent = [];
    this.token = [];
    this.depth = [];
    this.origin = [];
    this.children = [];
    this.evals = [[], []];
    this.pairs = [];
    this.stops.clear();
    this.cursorA = NONE;
    this.cursorB = NONE;
    this.front = 0;
    this.path = [];
    this.follow = true;
    this.awaiting = false;
    this.pathEpoch++;
    this.pathKept = 0;
    this.lane = [];
    this.split = -1;
    this.laneEpoch++;
    this.splits = 0;
    this.sessionTime = 0;
    this.markAll();
  }

  apply(f: Frame): void {
    this.framesApplied++;
    if (f.type === FRAME_HELLO) {
      // A HELLO empties everything: what follows is a new session.
      this.reset();
      this.hello = f.hello;
      this.unsupported = f.hello.protocol > PROTOCOL_VERSION;
      this.sessionTime = f.t;
      return;
    }
    if (this.unsupported) return;
    this.sessionTime = f.t;

    switch (f.type) {
      case FRAME_CONFIG: {
        const prev = this.config;
        this.config = f.config;
        this.dirty.meta = true;
        this.dirty.stream = true; // the Stream's columns depend on the mode and driver
        // A new mode or driver puts the default model in front again.
        if (!prev || prev.mode !== f.config.mode || prev.driver !== f.config.driver) {
          this.setFront(this.defaultFront());
        }
        break;
      }
      case FRAME_VOCAB:
        for (const e of f.entries) this.vocab.set(e.token, e);
        break;
      case FRAME_NODE:
        if (this.parent[f.id] === undefined && f.parent !== NONE) (this.children[f.parent] ??= []).push(f.id);
        this.parent[f.id] = f.parent;
        this.token[f.id] = f.token;
        this.depth[f.id] = f.depth;
        this.origin[f.id] = f.origin;
        break;
      case FRAME_EVAL:
        // A second EVAL for the same node and slot replaces the first.
        if (f.slot === 0 || f.slot === 1) this.evals[f.slot][f.node] = { ...f, config: this.config };
        this.markPanels();
        break;
      case FRAME_PAIR:
        // A second PAIR for the same node replaces the first.
        this.pairs[f.node] = f;
        this.markPanels();
        break;
      case FRAME_CURSOR: {
        const together = this.cursorA !== NONE && this.cursorA === this.cursorB;
        const moved = this.cursorA !== f.nodeA || this.cursorB !== f.nodeB;
        this.cursorA = f.nodeA;
        this.cursorB = f.nodeB;
        if (together && f.nodeA !== NONE && f.nodeB !== NONE && f.nodeA !== f.nodeB) this.splits++;
        if (moved) this.dirty.timeline = true; // the minimap draws the cursors
        if (this.awaiting) {
          // The answer to a branch or goto: a replacement, never growth.
          this.awaiting = false;
          this.followCursor(true);
        } else if (this.follow) {
          this.followCursor();
        }
        break;
      }
      case FRAME_STOP: {
        const prev = this.stops.get(f.node);
        const slot = prev && prev.slot !== f.slot ? 2 : f.slot;
        this.stops.set(f.node, { slot, reason: f.reason });
        this.dirty.stream = true;
        break;
      }
    }
  }

  // ------------------------------------------------------------ queries

  get nodeCount(): number {
    return this.parent.length;
  }

  // Whether the session has a model B.
  get twoModels(): boolean {
    return (this.hello?.models.length ?? 1) > 1;
  }

  // The model that is not in front.
  get other(): Slot {
    return this.front === 0 ? 1 : 0;
  }

  // EVAL of model A / B per node id.
  get evalA(): (EvalData | undefined)[] {
    return this.evals[0];
  }
  get evalB(): (EvalData | undefined)[] {
    return this.evals[1];
  }

  // Number of prompt tokens at the start of the viewed path.
  get promptLength(): number {
    let n = 0;
    while (n < this.path.length && this.origin[this.path[n]] === ORIGIN_PROMPT) n++;
    return n;
  }

  // Node whose EVAL holds the decision of the token at `index` of the viewed
  // path: its parent. NONE for a prompt token or an index out of the path.
  decisionNode(index: number): number {
    if (index <= 0 || index >= this.path.length) return NONE;
    if (this.origin[this.path[index]] === ORIGIN_PROMPT) return NONE;
    return this.path[index - 1];
  }

  // The decision of the token at `index` of the viewed path as one model saw
  // it: that model's EVAL of the parent node, if it evaluated it.
  decisionOf(index: number, slot: Slot): EvalData | undefined {
    const n = this.decisionNode(index);
    return n === NONE ? undefined : this.evals[slot][n];
  }

  // The decision of the token at `index` of the viewed path: the distribution
  // that token came from. The model in front's if it evaluated the parent
  // node, else the other's. Prompt tokens have none.
  decision(index: number): EvalData | undefined {
    return this.decisionOf(index, this.front) ?? this.decisionOf(index, this.other);
  }

  // Probability the model gave to the token at `index` within its decision
  // (its p_raw), or undefined without a decision or if it is not listed.
  probability(index: number): number | undefined {
    return probabilityIn(this.decision(index), this.token[this.path[index]]);
  }

  // The comparison of A and B in the decision of the token at `index` of the
  // viewed path, if both evaluated its parent node.
  pairAt(index: number): PairFrame | undefined {
    const n = this.decisionNode(index);
    return n === NONE ? undefined : this.pairs[n];
  }

  // A disagreement: in the decision of the token at `index`, A and B picked
  // different tokens.
  disagrees(index: number): boolean {
    const p = this.pairAt(index);
    return p !== undefined && (p.flags & PAIR_SAME_PICK) === 0;
  }

  // Index in the viewed path of the first disagreement, or -1.
  firstDisagreement(): number {
    for (let i = 1; i < this.path.length; i++) {
      if (this.disagrees(i)) return i;
    }
    return -1;
  }

  // The decision of the token at `index` of `lane`: the other model's EVAL of
  // its parent node (the model in front's if the other did not evaluate it).
  laneDecision(index: number): EvalData | undefined {
    if (index < 0 || index >= this.lane.length) return undefined;
    const n = index === 0 ? this.path[this.split] : this.lane[index - 1];
    return this.evals[this.other][n] ?? this.evals[this.front][n];
  }

  laneProbability(index: number): number | undefined {
    return probabilityIn(this.laneDecision(index), this.token[this.lane[index]]);
  }

  // Why the viewed path cannot go on, if its last node is stopped.
  stopAtEnd(): StopInfo | undefined {
    if (this.path.length === 0) return undefined;
    return this.stops.get(this.path[this.path.length - 1]);
  }

  // Why the other model's lane cannot go on, if its cursor is stopped.
  stopAtLaneEnd(): StopInfo | undefined {
    if (this.split < 0) return undefined;
    const end = this.lane.length > 0 ? this.lane[this.lane.length - 1] : this.path[this.split];
    return this.stops.get(end);
  }

  // Whether the viewed path ends at the cursor of the model in front: then
  // "Resume here" would not move anything.
  viewEndsAtCursor(): boolean {
    const c = this.frontCursor();
    return c !== NONE && this.path.length > 0 && this.path[this.path.length - 1] === c;
  }

  // The leaf a branch leads to: down from `node`, at each fork the child
  // that leads to a cursor (the model in front's first, then the other's),
  // else the most recent one (highest id).
  tipOf(node: number, routes: number[][] = this.cursorRoutes()): number {
    if (!(node >= 0 && node < this.nodeCount)) return NONE;
    let n = node;
    for (;;) {
      const kids = this.children[n] ?? NO_CHILDREN;
      if (kids.length === 0) return n;
      let next = NONE;
      for (const r of routes) {
        const d = this.depth[n];
        if (r[d] === n && d + 1 < r.length) {
          next = r[d + 1];
          break;
        }
      }
      if (next === NONE) next = Math.max(...kids);
      n = next;
    }
  }

  // The branches hanging from the viewed path, by position and then id.
  branches(): Branch[] {
    const out: Branch[] = [];
    const routes = this.cursorRoutes();
    for (let i = 0; i < this.path.length; i++) {
      const kids = this.children[this.path[i]];
      if (!kids) continue;
      const next = this.path[i + 1];
      for (const child of kids) {
        if (child === next) continue;
        const tip = this.tipOf(child, routes);
        out.push({ fromIndex: i, child, tip, tipDepth: this.depth[tip] });
      }
    }
    return out;
  }

  // Where each cursor is on the minimap, given branches(). A cursor that is
  // on neither (it cannot happen with a well-formed tree) is left out.
  cursorMarks(branches: readonly Branch[] = this.branches()): CursorMark[] {
    const out: CursorMark[] = [];
    const slots: Slot[] = this.twoModels ? [0, 1] : [0];
    for (const slot of slots) {
      const c = slot === 0 ? this.cursorA : this.cursorB;
      if (c === NONE || !(c < this.nodeCount)) continue;
      const depth = this.depth[c];
      if (this.path[depth] === c) {
        out.push({ slot, depth, branch: -1 });
        continue;
      }
      // Up to the node hanging from the path: the child of its branch.
      let n = c;
      while (n !== NONE && n !== undefined) {
        const p = this.parent[n];
        if (p === NONE || p === undefined || this.path[this.depth[p]] === p) break;
        n = p;
      }
      const branch = branches.findIndex((b) => b.child === n);
      if (branch >= 0) out.push({ slot, depth, branch });
    }
    return out;
  }

  // ------------------------------------------------------------ the view

  // Puts a model in front. Local to the interface: nothing is sent to the
  // engine. Ignored for B in a session with a single model.
  setFront(slot: Slot): void {
    if (slot === 1 && !this.twoModels) slot = 0;
    if (slot === this.front) return;
    this.front = slot;
    this.dirty.meta = true;
    this.markPanels();
    if (this.follow && !this.awaiting) this.followCursor();
  }

  // Makes the path from the root to `tip` the viewed path and stops
  // following the cursor. Local: nothing is sent, no cursor moves. Without
  // a cursor to follow there is no lane.
  viewNode(tip: number): void {
    if (!(tip >= 0 && tip < this.nodeCount)) return;
    if (this.follow || this.awaiting) this.dirty.meta = true;
    this.follow = false;
    this.awaiting = false;
    this.replacePath(this.pathTo(tip));
    this.setLane([], -1);
  }

  // Follows the cursor of the model in front again. With `awaitCursor` (a
  // branch or goto was just sent) the path stays as it is until the next
  // CURSOR, which brings the cursor where the user looks.
  setFollow(awaitCursor = false): void {
    if (this.follow && !awaitCursor && !this.awaiting) return;
    this.follow = true;
    this.dirty.meta = true;
    this.awaiting = awaitCursor;
    if (!awaitCursor) this.followCursor(true);
  }

  // The engine refused the branch or goto: stop waiting for its CURSOR and
  // follow the cursor where it is.
  cancelAwait(): void {
    if (this.awaiting) this.setFollow();
  }

  // ----------------------------------------------------------- internal

  // The cursor of the model in front, or A's.
  private frontCursor(): number {
    return this.front === 1 && this.cursorB !== NONE ? this.cursorB : this.cursorA;
  }

  // The paths to the cursors (model in front first), indexed by depth.
  private cursorRoutes(): number[][] {
    const routes: number[][] = [];
    const inFront = this.frontCursor();
    const behind = inFront === this.cursorA ? this.cursorB : this.cursorA;
    for (const c of [inFront, behind]) if (c !== NONE && c < this.nodeCount) routes.push(this.pathTo(c));
    return routes;
  }

  private defaultFront(): Slot {
    const c = this.config;
    return this.twoModels && c !== null && c.mode === 'lockstep' && c.driver === 'B' ? 1 : 0;
  }

  private markPanels(): void {
    this.dirty.stream = true;
    this.dirty.candidates = true;
    this.dirty.gates = true;
    this.dirty.timeline = true;
    this.dirty.relief = true;
    this.dirty.metrics = true;
    this.dirty.lens = true;
    this.dirty.compare = true;
  }

  private markAll(): void {
    this.dirty.meta = true;
    this.markPanels();
  }

  // Brings `path` to the cursor of the model in front, and `lane` to the
  // other's. With `replace`, a path one token longer is still a replacement
  // (the user moved the view: no token birth).
  private followCursor(replace = false): void {
    const inFront = this.frontCursor();
    const behind = inFront === this.cursorA ? this.cursorB : this.cursorA;

    const last = this.path.length > 0 ? this.path[this.path.length - 1] : NONE;
    if (inFront !== last) {
      if (!replace && inFront !== NONE && this.parent[inFront] === last && this.path.length > 0) {
        this.path.push(inFront); // the usual case: one more token at the end
        this.markPanels();
      } else {
        this.replacePath(this.pathTo(inFront));
      }
    }
    this.followLane(behind);
  }

  // Puts `next` in place of the viewed path, keeping track of the common
  // prefix. Does nothing if they are the same.
  private replacePath(next: number[]): void {
    const old = this.path;
    let kept = 0;
    while (kept < old.length && kept < next.length && old[kept] === next[kept]) kept++;
    if (kept === old.length && kept === next.length) return;
    this.path = next;
    this.pathKept = kept;
    this.pathEpoch++;
    this.markPanels();
  }

  private setLane(lane: number[], split: number): void {
    if (split === this.split && sameNodes(lane, this.lane)) return;
    this.lane = lane;
    this.split = split;
    this.laneEpoch++;
    this.markPanels();
  }

  private pathTo(node: number): number[] {
    const path: number[] = [];
    for (let n = node; n !== NONE && n !== undefined; n = this.parent[n]) path.push(n);
    return path.reverse();
  }

  private followLane(cursor: number): void {
    const end = this.path.length > 0 ? this.path[this.path.length - 1] : NONE;
    let lane: number[] = [];
    let split = -1;
    if (cursor !== NONE && end !== NONE && cursor !== end) {
      const tail = this.lane.length > 0 ? this.lane[this.lane.length - 1] : NONE;
      // The lane still hangs from the path where it did: false once the path
      // was replaced (a goto, the other model put in front) or grew into it.
      const anchored =
        tail !== NONE &&
        this.path[this.split] === this.parent[this.lane[0]] &&
        this.path[this.split + 1] !== this.lane[0];
      if (anchored && cursor === tail) return; // the other cursor did not move
      if (anchored && this.parent[cursor] === tail) {
        this.lane.push(cursor); // the usual case: one more token at its end
        this.markPanels();
        return;
      }
      // Up from the cursor to the deepest node that is on the path.
      let n = cursor;
      while (n !== NONE && n !== undefined && this.path[this.depth[n]] !== n) {
        lane.push(n);
        n = this.parent[n];
      }
      lane.reverse();
      split = n === NONE || n === undefined ? -1 : this.depth[n];
      if (split < 0) lane = []; // no common node: nothing to show beside the path
    }
    if (split === this.split && sameNodes(lane, this.lane)) return;
    // Growing from nothing at a split that was already there is still growth.
    const grew = split === this.split && this.lane.length === 0 && lane.length > 0 && split >= 0;
    this.lane = lane;
    this.split = split;
    if (!grew) this.laneEpoch++;
    this.markPanels();
  }
}

function probabilityIn(d: EvalData | undefined, token: number): number | undefined {
  if (!d) return undefined;
  for (let i = 0; i < d.tokens.length; i++) {
    if (d.tokens[i] === token) return d.pRaw[i];
  }
  return undefined;
}

function sameNodes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
