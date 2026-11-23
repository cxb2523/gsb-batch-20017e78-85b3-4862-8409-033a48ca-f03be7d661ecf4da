// Acceptance checks for branching at protocol level, against an engine that is
// already running (`make run A=<a>.gguf [B=<b>.gguf] ARGS=--verify-seek`, then
// `make test-e2e E2E=src/e2e/branch.e2e.test.ts`). Skipped unless
// ILS_ENGINE_URL is set. Works with one model or two.
//
// - Speed: branching 500 tokens deep, from a context that is somewhere else,
//   resumes in under 300 ms. The branch points are the worst case for the
//   snapshots: 23 tokens after one, plus the node's own.
// - Correctness: 20 placements on nodes already evaluated give no `warning`
//   (seek mismatches need the engine started with --verify-seek; approximate
//   placements are always reported).
//
// ILS_SAVE=<path> also records a sample session with branches and writes it
// there. A relative path is taken from the repository root.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_NODE,
  ORIGIN_PROMPT,
  PAIR_APPROX,
  type CursorFrame,
  type EvalFrame,
  type Frame,
  type ModelInfo,
  type NodeFrame,
} from '../source/frames';
import type { Slots, StatusEvent } from '../source/messages';
import { decodeSession } from '../source/recorded';
import { Store } from '../store/store';
import { TestClient, until } from './client';

const BASE = process.env.ILS_ENGINE_URL ?? '';
const SAVE = process.env.ILS_SAVE ?? '';

const PROMPT =
  'Write a long and detailed essay, of at least ten paragraphs, about the history of computing: ' +
  'mechanical calculators, the first electronic computers, transistors, integrated circuits, ' +
  'personal computers, the internet and mobile phones. Do not stop early.';
const CHAT = { format: 'chat' } as const;

const SNAPSHOT_EVERY = 16; // engine/src/snapshots.h
const DEEP = 500;
// ILS_RESUME_MS relaxes it off the GPU (e.g. the CPU of a VM); the checks stay the same.
const RESUME_MS = Number(process.env.ILS_RESUME_MS ?? 300);
const PLACEMENTS = 20;
const ORIGIN_USER = 2;

const TIMEOUT = 600_000;
const GENERATION_MS = 480_000;

function ofType<T extends Frame>(frames: Frame[], type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

function lastStatus(c: TestClient): StatusEvent | undefined {
  return c.events.filter((e): e is StatusEvent => e.ev === 'status').at(-1);
}

function warnings(c: TestClient, from = 0): string[] {
  return c.events.slice(from).flatMap((e) => (e.ev === 'warning' ? [e.msg] : []));
}

function errors(c: TestClient, from = 0): string[] {
  return c.events.slice(from).flatMap((e) => (e.ev === 'error' ? [e.msg] : []));
}

// A token of the decision at `index` of the viewed path other than the one
// the path took: the alternative a click on Candidates would branch to.
function alternative(s: Store, index: number): number {
  const d = s.decision(index);
  if (!d) throw new Error(`no decision at index ${index}`);
  const taken = s.token[s.path[index]];
  for (let k = 0; k < d.tokens.length; k++) {
    const t = d.tokens[k];
    const e = s.vocab.get(t);
    // Not a control token: it could end the generation.
    if (t !== taken && e !== undefined && e.attr === 0) return t;
  }
  throw new Error(`no alternative at index ${index}`);
}

describe.skipIf(!BASE)('engine end to end, branches', () => {
  let models: ModelInfo[] = [];
  const clients: TestClient[] = [];
  const connect = (): TestClient => {
    const c = new TestClient(BASE);
    clients.push(c);
    return c;
  };
  const two = (): boolean => models.length > 1;
  const all = (): Slots => (two() ? 'AB' : 'A');

  beforeAll(async () => {
    const c = new TestClient(BASE);
    try {
      await until(() => c.store.hello !== null, 'HELLO');
      models = c.store.hello!.models;
    } finally {
      c.close();
    }
  }, TIMEOUT);

  afterAll(async () => {
    const c = new TestClient(BASE);
    try {
      await until(() => c.opened, 'the connection');
      c.send({ cmd: 'pause' });
      if (two()) {
        c.config({ mode: 'lockstep', driver: 'A' });
        await until(() => c.store.config?.mode === 'lockstep' && c.store.config.driver === 'A', 'the default mode');
      }
    } finally {
      c.close();
    }
  }, TIMEOUT);

  afterEach(() => {
    for (const c of clients) {
      expect(c.errors, 'undecodable messages').toEqual([]);
      c.close();
    }
    clients.length = 0;
  });

  async function begin(c: TestClient, maxTokens: number, tps: number): Promise<void> {
    await until(() => c.opened, 'the connection');
    await c.start(PROMPT, maxTokens, { ...CHAT, config: two() ? { mode: 'lockstep', driver: 'A' } : {} });
    c.send({ cmd: 'speed', tps });
    c.send({ cmd: 'run' });
  }

  async function pause(c: TestClient): Promise<void> {
    c.send({ cmd: 'pause' });
    await until(() => lastStatus(c)?.state !== 'running', 'the pause');
  }

  it(
    'branching 500 tokens deep resumes in under 300 ms, and placements are exact',
    async () => {
      const c = connect();
      const s = c.store;
      await begin(c, DEEP + 3 * SNAPSHOT_EVERY + 40, 0);
      const need = (): number => s.promptLength + DEEP + 3 * SNAPSHOT_EVERY + 8;
      await until(() => s.path.length >= need() || c.stopped, `${DEEP} tokens`, GENERATION_MS);
      await pause(c);
      expect(s.path.length, 'the generation stopped before reaching the depth').toBeGreaterThanOrEqual(need());
      const main = s.path.slice();
      const seen = c.events.length;

      // Worst cases: the new node at a depth d (its index in the path) with
      // d % 16 == 15, so 15 tokens are decoded after the snapshot and then
      // the node's own. From the deepest one to the shallowest, so the
      // context is always somewhere else.
      const first = Math.ceil((s.promptLength + DEEP - (SNAPSHOT_EVERY - 1)) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY +
        (SNAPSHOT_EVERY - 1);
      const depths = [first + 2 * SNAPSHOT_EVERY, first + SNAPSHOT_EVERY, first];
      const times: number[] = [];
      for (const d of depths) {
        expect(d).toBeLessThan(main.length);
        const parent = main[d - 1];
        // The decision of main[d], read from the main path.
        const dec = s.evals[0][parent] ?? s.evals[1][parent];
        expect(dec, `EVAL at node ${parent}`).toBeDefined();
        const token = Array.from(dec!.tokens).find((t) => t !== s.token[main[d]] && s.vocab.get(t)?.attr === 0);
        expect(token, 'an alternative').toBeDefined();

        const from = c.frames.length;
        const t0 = performance.now();
        c.send({ cmd: 'branch', node: parent, token: token!, slots: all() });
        c.send({ cmd: 'step' });
        // Resumed: the EVAL of the new node by every model has arrived.
        let child = -1;
        await until(
          () => {
            const added = c.frames.slice(from);
            const cur = ofType<CursorFrame>(added, FRAME_CURSOR)[0];
            if (!cur) return errors(c, seen).length > 0;
            child = cur.nodeA;
            const evals = ofType<EvalFrame>(added, FRAME_EVAL).filter((e) => e.node === child);
            return evals.length >= models.length || errors(c, seen).length > 0;
          },
          'the EVAL of the branch',
          GENERATION_MS,
        );
        times.push(performance.now() - t0);
        expect(errors(c, seen)).toEqual([]);
        const node = ofType<NodeFrame>(c.frames.slice(from), FRAME_NODE)[0];
        expect(node.origin).toBe(ORIGIN_USER);
        expect(node.parent).toBe(parent);
        expect(s.depth[child]).toBe(d);
        await until(() => ofType<CursorFrame>(c.frames.slice(from), FRAME_CURSOR).length >= 2, 'the end of the step');
      }
      console.log(
        `branch at depths ${depths.join(', ')} (prompt of ${s.promptLength}): ` +
          `${times.map((t) => t.toFixed(0)).join(', ')} ms until the EVAL of the new node`,
      );

      // 20 placements on nodes that already have an EVAL, far from each other.
      const tip = main.length - 2; // the last node of the main path with an EVAL
      let placed = 0;
      for (let k = 0; placed < PLACEMENTS; k++) {
        const index = k % 2 === 0 ? tip - 7 * k : s.promptLength + 11 * k;
        const node = main[index];
        const old = s.evals[0][node]!;
        // The goto's CURSOR and then the step's.
        const from = c.frames.length;
        c.send({ cmd: 'goto', node, slots: all() });
        c.send({ cmd: 'step' });
        await until(
          () => ofType<CursorFrame>(c.frames.slice(from), FRAME_CURSOR).length >= 2 || errors(c, seen).length > 0,
          'the step after the goto',
          GENERATION_MS,
        );
        expect(errors(c, seen)).toEqual([]);
        const added = c.frames.slice(from);
        expect(ofType<EvalFrame>(added, FRAME_EVAL).length).toBe(models.length);
        for (const e of ofType<EvalFrame>(added, FRAME_EVAL)) {
          expect(e.node).toBe(node);
          if (e.slot !== 0) continue;
          expect(Array.from(e.tokens.slice(0, e.nRaw))).toEqual(Array.from(old.tokens.slice(0, old.nRaw)));
          for (let i = 0; i < e.nRaw; i++) expect(Math.abs(e.pRaw[i] - old.pRaw[i])).toBeLessThanOrEqual(1e-4);
        }
        // The step leads to the same child as before: no new node.
        expect(ofType<NodeFrame>(added, FRAME_NODE)).toEqual([]);
        placed++;
      }
      const w = warnings(c, seen);
      console.log(`${placed} placements on evaluated nodes, ${w.length} warnings`);
      expect(w).toEqual([]);
      expect(Math.max(...times)).toBeLessThan(RESUME_MS);
    },
    TIMEOUT,
  );

  it.skipIf(!SAVE)(
    'records a sample session with branches',
    async () => {
      const c = connect();
      const s = c.store;
      const generated = (): number => s.origin.filter((o) => o !== ORIGIN_PROMPT).length;
      const follow = async (tokens: number): Promise<void> => {
        const target = generated() + tokens;
        c.send({ cmd: 'run' });
        await until(() => generated() >= target || c.stopped, `${tokens} more tokens`, GENERATION_MS);
        await pause(c);
      };

      // The demo speed, so the recorded times are those of a real demo.
      await begin(c, 400, 12);
      await until(() => generated() >= 60 || c.stopped, '60 tokens', GENERATION_MS);
      await pause(c);
      const main = s.path.slice();
      const p = s.promptLength;

      // A branch from the middle, another from near the start, then back to
      // the tip of the first path.
      c.send({ cmd: 'branch', node: main[p + 30], token: alternative(s, p + 31), slots: all() });
      await follow(40);
      c.send({ cmd: 'branch', node: main[p + 12], token: alternative(s, p + 13), slots: all() });
      await follow(30);
      c.send({ cmd: 'goto', node: main[main.length - 1], slots: all() });
      await follow(20);

      if (two()) {
        // Free mode: B takes a branch of its own, and A then visits a node
        // of it that only B evaluated: an approximate PAIR.
        c.config({ mode: 'free' });
        await until(() => s.config?.mode === 'free', 'free mode');
        c.send({ cmd: 'branch', node: main[p + 45], token: alternative(s, p + 46), slots: 'B' });
        await follow(12);
        const own = s.cursorB;
        let n = own;
        for (let i = 0; i < 6; i++) n = s.parent[n];
        c.send({ cmd: 'goto', node: n, slots: 'A' });
        await follow(8);
      }

      const res = await fetch(BASE.replace(/\/$/, '') + '/api/session.ils');
      expect(res.status).toBe(200);
      const file = new Uint8Array(await res.arrayBuffer());
      const frames = await decodeSession(file);
      const replayed = new Store();
      for (const f of frames) replayed.apply(f);
      const user = replayed.origin.filter((o) => o === ORIGIN_USER).length;
      const approx = replayed.pairs.filter((x) => x !== undefined && (x.flags & PAIR_APPROX) !== 0).length;
      console.log(
        `sample: ${replayed.origin.filter((o) => o !== ORIGIN_PROMPT).length} tokens, ${user} branches by the user, ` +
          `${approx} approximate PAIR, ${(file.length / 1024).toFixed(0)} KiB`,
      );
      expect(user).toBeGreaterThanOrEqual(two() ? 3 : 2);
      if (two()) expect(approx).toBeGreaterThanOrEqual(1);
      expect(warnings(c)).toEqual([]);

      const path = resolve(import.meta.dirname, '../../..', SAVE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file);
      console.log(`sample session written to ${path}`);
    },
    TIMEOUT,
  );
});
