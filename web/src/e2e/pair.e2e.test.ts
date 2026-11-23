// Acceptance checks for two models at protocol level, against an engine that is
// already running with two models (`make run A=<a>.gguf B=<b>.gguf`, then
// `make test-e2e`). Skipped unless ILS_ENGINE_URL is set, and skipped when the
// engine's HELLO has a single model.
//
// With two different files (the demo pair) the models must disagree and
// split; with the same file twice they must never do (the identity check).
//
// ILS_SAVE=<path> also records a sample session (lockstep with disagreements,
// then free mode with a split) and writes it there. A relative path is taken
// from the repository root, e.g. sessions/samples/pair-demo.ils.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  ORIGIN_PROMPT,
  PAIR_SAME_PICK,
  type ConfigFrame,
  type CursorFrame,
  type EvalFrame,
  type Frame,
  type ModelInfo,
  type PairFrame,
} from '../source/frames';
import type { StatusEvent } from '../source/messages';
import { decodeSession } from '../source/recorded';
import { Store } from '../store/store';
import { TestClient, until } from './client';

const BASE = process.env.ILS_ENGINE_URL ?? '';
const SAVE = process.env.ILS_SAVE ?? '';

// A chat request that gets a long, varied text.
const PROMPT =
  'Explain in four short paragraphs how a compiler turns source code into machine code. ' +
  'Mention parsing, intermediate representations, optimisation and register allocation, ' +
  'and give one small example for each.';
const CHAT = { format: 'chat' } as const;

const MAX_TOKENS = 200;
// ILS_MIN_STEPS relaxes it off the GPU (e.g. the CPU of a VM); the checks stay the same.
const MIN_STEPS_PER_SECOND = Number(process.env.ILS_MIN_STEPS ?? 15);
const IDENTITY_JS = 1e-6;

const TIMEOUT = 300_000;
const GENERATION_MS = 240_000;

function ofType<T extends Frame>(frames: Frame[], type: number): T[] {
  return frames.filter((f) => f.type === type) as T[];
}

// Tokens the models wrote: every node that is not part of the prompt.
function generatedNodes(s: Store): number {
  return s.origin.filter((o) => o !== ORIGIN_PROMPT).length;
}

function lastStatus(c: TestClient): StatusEvent | undefined {
  return c.events.filter((e): e is StatusEvent => e.ev === 'status').at(-1);
}

function pairsOf(s: Store): PairFrame[] {
  return s.pairs.filter((p): p is PairFrame => p !== undefined);
}

function disagreements(s: Store): number {
  return pairsOf(s).filter((p) => (p.flags & PAIR_SAME_PICK) === 0).length;
}

// Each model's own path is made of its own picks.
function expectOwnPicks(s: Store, slot: 0 | 1): void {
  s.setFront(slot);
  const end = slot === 0 ? s.cursorA : s.cursorB;
  expect(s.path[s.path.length - 1], `the path of ${slot === 0 ? 'A' : 'B'}`).toBe(end);
  for (let i = s.promptLength; i < s.path.length; i++) {
    const d = s.decisionOf(i, slot);
    expect(d, `EVAL of slot ${slot} for index ${i}`).toBeDefined();
    expect(d!.tokens[d!.pick], `pick of slot ${slot} at index ${i}`).toBe(s.token[s.path[i]]);
  }
}

describe.skipIf(!BASE)('engine end to end, two models', () => {
  let models: ModelInfo[] = [];
  const clients: TestClient[] = [];
  const connect = (): TestClient => {
    const c = new TestClient(BASE);
    clients.push(c);
    return c;
  };

  // Same file in A and B: the identity check instead of the demo pair.
  const identical = (): boolean => models.length > 1 && models[0].file === models[1].file;

  beforeAll(async () => {
    const c = new TestClient(BASE);
    try {
      await until(() => c.store.hello !== null, 'HELLO');
      models = c.store.hello!.models;
    } finally {
      c.close();
    }
  }, TIMEOUT);

  // Leave the engine in lockstep driven by A, as it starts.
  afterAll(async () => {
    if (models.length < 2) return;
    const c = new TestClient(BASE);
    try {
      await until(() => c.opened, 'the connection');
      c.send({ cmd: 'pause' });
      c.config({ mode: 'lockstep', driver: 'A' });
      await until(() => c.store.config?.mode === 'lockstep' && c.store.config.driver === 'A', 'the default mode');
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

  // Starts a session and lets it run at `tps` (0: unlimited).
  async function begin(c: TestClient, mode: 'lockstep' | 'free', tps: number): Promise<void> {
    await until(() => c.opened, 'the connection');
    await c.start(PROMPT, MAX_TOKENS, { ...CHAT, config: { mode, driver: 'A' } });
    expect(c.store.config!.mode).toBe(mode);
    c.send({ cmd: 'speed', tps });
    c.send({ cmd: 'run' });
  }

  it(
    'lockstep: both models evaluate every node and the cursors never part',
    async (ctx) => {
      if (models.length < 2) return ctx.skip();
      const c = connect();
      await until(() => c.opened, 'the connection');
      await c.start(PROMPT, MAX_TOKENS, { ...CHAT, config: { mode: 'lockstep', driver: 'A' } });
      const first = c.cursors; // the prompt's CURSOR is in
      c.send({ cmd: 'speed', tps: 0 });
      const t0 = performance.now();
      c.send({ cmd: 'run' });
      await until(() => c.stopped, 'the generation to stop', GENERATION_MS);

      const s = c.store;
      const steps = c.cursors - first;
      const perSecond = steps / ((c.lastCursorAt - t0) / 1000);
      const pairs = pairsOf(s);
      const meanJs = pairs.reduce((a, p) => a + p.js, 0) / Math.max(1, pairs.length);
      console.log(
        `lockstep: ${steps} steps at ${perSecond.toFixed(1)} steps/s; ` +
          `${disagreements(s)} disagreements, the first at position ${s.firstDisagreement()}; ` +
          `mean JS ${meanJs.toExponential(3)} bits` +
          (identical() ? ' (same file in A and B)' : ''),
      );

      expect(steps).toBeGreaterThan(0);
      for (const f of ofType<CursorFrame>(c.frames, FRAME_CURSOR)) expect(f.nodeA).toBe(f.nodeB);
      const evaluated = new Set(ofType<EvalFrame>(c.frames, FRAME_EVAL).map((e) => e.node));
      expect(evaluated.size).toBe(steps);
      for (const n of evaluated) {
        expect(s.evalA[n], `EVAL of A at node ${n}`).toBeDefined();
        expect(s.evalB[n], `EVAL of B at node ${n}`).toBeDefined();
        expect(s.pairs[n], `PAIR at node ${n}`).toBeDefined();
      }
      expect(perSecond).toBeGreaterThanOrEqual(MIN_STEPS_PER_SECOND);
      if (identical()) {
        expect(disagreements(s)).toBe(0);
        for (const p of pairs) expect(p.js, `JS at node ${p.node}`).toBeLessThan(IDENTITY_JS);
      } else {
        expect(disagreements(s)).toBeGreaterThanOrEqual(1);
        expect(s.firstDisagreement()).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    'free mode: each model follows its own picks, and different models split',
    async (ctx) => {
      if (models.length < 2) return ctx.skip();
      const c = connect();
      await begin(c, 'free', 0);
      await until(() => c.stopped, 'both models to stop', GENERATION_MS);

      const cursors = ofType<CursorFrame>(c.frames, FRAME_CURSOR);
      const parted = cursors.some((f) => f.nodeA !== f.nodeB);
      console.log(`free: ${cursors.length - 1} steps, ${parted ? 'split' : 'never split'}`);
      if (identical()) {
        expect(parted).toBe(false);
      } else {
        expect(parted).toBe(true);
        expect(c.store.splits).toBe(1);
      }
      expectOwnPicks(c.store, 0);
      expectOwnPicks(c.store, 1);
    },
    TIMEOUT,
  );

  it(
    'from free to lockstep: the cursors meet at the driver and generation goes on',
    async (ctx) => {
      if (models.length < 2) return ctx.skip();
      const c = connect();
      await begin(c, 'free', 30);
      const s = c.store;
      if (identical()) {
        await until(() => generatedNodes(s) >= 10 || c.stopped, 'about 10 tokens', GENERATION_MS);
      } else {
        await until(() => s.cursorA !== s.cursorB || c.stopped, 'the models to split', GENERATION_MS);
        expect(s.cursorA).not.toBe(s.cursorB);
      }
      expect(c.stopped, 'stopped before the change of mode').toBe(false);

      const from = c.frames.length;
      c.config({ mode: 'lockstep' });
      await until(
        () => c.frames.slice(from).some((f) => f.type === FRAME_CONFIG && f.config.mode === 'lockstep'),
        'the lockstep CONFIG',
      );
      const at = c.frames.findIndex((f, i) => i >= from && f.type === FRAME_CONFIG && f.config.mode === 'lockstep');
      const config = c.frames[at] as ConfigFrame;
      const driverSlot = config.config.driver === 'B' ? 1 : 0;

      // Where the driver stood when the CONFIG was written.
      const before = ofType<CursorFrame>(c.frames.slice(0, at), FRAME_CURSOR).at(-1)!;
      const driverNode = driverSlot === 0 ? before.nodeA : before.nodeB;

      // More steps after the change, with the cursors together.
      await until(
        () => ofType<CursorFrame>(c.frames.slice(at), FRAME_CURSOR).length >= 6 || c.stopped,
        'steps after the change of mode',
        GENERATION_MS,
      );
      c.send({ cmd: 'pause' });
      const after = c.frames.slice(at + 1);
      const moved = ofType<CursorFrame>(after, FRAME_CURSOR);
      if (before.nodeA !== before.nodeB) {
        // The CONFIG is followed by the CURSOR that brings the other model over.
        expect(after[0].type).toBe(FRAME_CURSOR);
        expect([moved[0].nodeA, moved[0].nodeB]).toEqual([driverNode, driverNode]);
      }
      for (const f of moved) expect(f.nodeA).toBe(f.nodeB);
      const steps = moved.length - (before.nodeA !== before.nodeB ? 1 : 0);
      console.log(`free → lockstep: driver ${config.config.driver} at node ${driverNode}; ${steps} steps after`);
      expect(steps).toBeGreaterThanOrEqual(5);
      // Whole steps only: a step ends with its CURSOR.
      let end = after.length;
      while (end > 0 && after[end - 1].type !== FRAME_CURSOR) end--;
      const whole = after.slice(0, end);
      for (const e of ofType<EvalFrame>(whole, FRAME_EVAL)) {
        expect(s.evalA[e.node], `EVAL of A at node ${e.node}`).toBeDefined();
        expect(s.evalB[e.node], `EVAL of B at node ${e.node}`).toBeDefined();
        expect(s.pairs[e.node], `PAIR at node ${e.node}`).toBeDefined();
      }
    },
    TIMEOUT,
  );

  it.skipIf(!SAVE)(
    'records a sample session: lockstep with disagreements, then free with a split',
    async (ctx) => {
      if (models.length < 2) return ctx.skip();
      const LOCKSTEP_TOKENS = 80;
      const LIMIT = 250; // tokens in the whole tree
      const c = connect();
      // The demo speed, so the recorded times are those of a real demo.
      await begin(c, 'lockstep', 12);
      const s = c.store;
      await until(
        () => (generatedNodes(s) >= LOCKSTEP_TOKENS && s.firstDisagreement() >= 0) || generatedNodes(s) >= 150 || c.stopped,
        `${LOCKSTEP_TOKENS} lockstep tokens with a disagreement`,
        GENERATION_MS,
      );
      expect(c.stopped, 'stopped in lockstep').toBe(false);
      c.config({ mode: 'free' });
      // A step writes up to two nodes: pause with room for the one in progress.
      await until(() => c.stopped || generatedNodes(s) >= LIMIT - 4, 'the end of the sample', GENERATION_MS);
      if (!c.stopped) c.send({ cmd: 'pause' });
      await until(() => lastStatus(c)?.state !== 'running', 'the pause');

      const res = await fetch(BASE.replace(/\/$/, '') + '/api/session.ils');
      expect(res.status).toBe(200);
      const file = new Uint8Array(await res.arrayBuffer());
      const frames = await decodeSession(file);
      const replayed = new Store();
      for (const f of frames) replayed.apply(f);
      const total = generatedNodes(replayed);
      const split = ofType<CursorFrame>(frames, FRAME_CURSOR).some((f) => f.nodeA !== f.nodeB);
      console.log(
        `sample: ${total} tokens, ${disagreements(replayed)} disagreements, ` +
          `${split ? 'split' : 'no split'}, ${(file.length / 1024).toFixed(0)} KiB`,
      );
      expect(total).toBeLessThan(LIMIT);
      if (!identical()) {
        expect(disagreements(replayed)).toBeGreaterThanOrEqual(1);
        expect(split).toBe(true);
      }

      const path = resolve(import.meta.dirname, '../../..', SAVE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file);
      console.log(`sample session written to ${path}`);
    },
    TIMEOUT,
  );
});
