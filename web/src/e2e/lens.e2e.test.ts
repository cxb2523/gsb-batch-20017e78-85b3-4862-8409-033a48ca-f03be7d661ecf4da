// Acceptance checks for the logit lens at protocol level,
// against an engine that is already running with `--lens`
// (`make run A=<a>.gguf [B=<b>.gguf] ARGS=--lens`, then
// `make test-e2e E2E=src/e2e/lens.e2e.test.ts`). Skipped unless
// ILS_ENGINE_URL is set, and skipped when the engine's HELLO has no lens.
//
// ILS_SAVE=<path> also writes the session there: a long lockstep run, the
// sample the Relief is checked with. A relative path is taken from the
// repository root, e.g. sessions/samples/lens.ils.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_LENS, FRAME_EVAL, FRAME_VOCAB, type EvalFrame, type Frame } from '../source/frames';
import type { StatusEvent } from '../source/messages';
import { decodeSession } from '../source/recorded';
import { TestClient, until } from './client';

const BASE = process.env.ILS_ENGINE_URL ?? '';
const SAVE = process.env.ILS_SAVE ?? '';

// A chat request that gets a long text.
const PROMPT =
  'Write a detailed essay of at least eight paragraphs about how a compiler turns source code ' +
  'into machine code: lexing, parsing, semantic analysis, intermediate representations, ' +
  'optimisation, register allocation and code generation, with a small example for each.';

const MAX_TOKENS = SAVE ? 1000 : 200;
const MIN_STEPS_PER_SECOND = 10; // with the lens on, with a pair of small models
const MIN_COHERENCE = 0.99;
const TIMEOUT = 300_000;

describe.skipIf(!BASE)('logit lens against a running engine', () => {
  let c: TestClient;
  let seconds = 0;

  beforeAll(async () => {
    c = new TestClient(BASE);
    await until(() => c.store.hello !== null, 'HELLO');
    if (!c.store.hello!.lens.enabled) return;
    await c.start(PROMPT, MAX_TOKENS, { format: 'chat' });
    c.send({ cmd: 'speed', tps: 0 });
    const t0 = performance.now();
    c.send({ cmd: 'run' });
    await until(() => c.stopped, 'the end of the generation', TIMEOUT - 20_000);
    seconds = (c.lastCursorAt - t0) / 1000;
    await until(() => c.events.filter((e): e is StatusEvent => e.ev === 'status').at(-1)?.state !== 'running', 'the pause');
  }, TIMEOUT);

  afterAll(() => c?.close());

  it('every EVAL carries one lens entry per layer of HELLO, and every lens token is in a VOCAB before', (ctx) => {
    const hello = c.store.hello!;
    if (!hello.lens.enabled) return ctx.skip();
    const layers = hello.lens.layers;
    expect(layers.length).toBeGreaterThan(0);
    expect([...layers].sort((a, b) => a - b)).toEqual(layers);
    for (const m of hello.models) expect(layers.at(-1)!).toBeLessThan(m.n_layer);

    const known = new Set<number>();
    let evals = 0;
    for (const f of c.frames as Frame[]) {
      if (f.type === FRAME_VOCAB) for (const e of f.entries) known.add(e.token);
      if (f.type !== FRAME_EVAL) continue;
      evals++;
      expect(f.flags & EVAL_LENS, `lens flag at node ${f.node}`).toBe(EVAL_LENS);
      expect(f.lens!.topId.length).toBe(layers.length);
      for (let i = 0; i < layers.length; i++) {
        expect(known.has(f.lens!.topId[i]), `VOCAB of lens token ${f.lens!.topId[i]}`).toBe(true);
        expect(f.lens!.topP[i]).toBeGreaterThan(0);
        expect(f.lens!.topP[i]).toBeLessThanOrEqual(1.0001);
        expect(f.lens!.answerP[i]).toBeLessThanOrEqual(f.lens!.topP[i] + 1e-6);
        expect(f.lens!.entropy[i]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(evals).toBeGreaterThan(50);
  });

  it('the last layer agrees with the model in at least 99 % of the nodes', (ctx) => {
    const hello = c.store.hello!;
    if (!hello.lens.enabled) return ctx.skip();
    // Only meaningful if the last lens layer is the model's last layer.
    if (hello.lens.layers.at(-1) !== hello.models[0].n_layer - 1) return ctx.skip();
    const evals = (c.frames as Frame[]).filter((f): f is EvalFrame => f.type === FRAME_EVAL);
    const last = hello.lens.layers.length - 1;
    for (const slot of hello.models.map((_, i) => i)) {
      const mine = evals.filter((e) => e.slot === slot);
      const same = mine.filter((e) => e.lens!.topId[last] === e.tokens[0]).length;
      console.log(`lens coherence, model ${'AB'[slot]}: ${same} of ${mine.length} (${((100 * same) / mine.length).toFixed(1)} %)`);
      expect(same / mine.length).toBeGreaterThanOrEqual(MIN_COHERENCE);
    }
  });

  it(`generates at least ${MIN_STEPS_PER_SECOND} steps per second with the lens on`, (ctx) => {
    if (!c.store.hello!.lens.enabled) return ctx.skip();
    const rate = c.generated / seconds;
    console.log(`lens: ${c.generated} steps in ${seconds.toFixed(1)} s, ${rate.toFixed(1)} steps per second`);
    expect(rate).toBeGreaterThanOrEqual(MIN_STEPS_PER_SECOND);
  });

  it.skipIf(!SAVE)('records the session as a sample', async (ctx) => {
    if (!c.store.hello!.lens.enabled) return ctx.skip();
    const res = await fetch(BASE.replace(/\/$/, '') + '/api/session.ils');
    expect(res.status).toBe(200);
    const file = new Uint8Array(await res.arrayBuffer());
    const frames = await decodeSession(file);
    expect(frames.filter((f) => f.type === FRAME_EVAL).every((f) => (f as EvalFrame).lens !== null)).toBe(true);
    const path = resolve(import.meta.dirname, '../../..', SAVE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file);
    console.log(`sample session with lens: ${c.store.path.length} positions, ${(file.length / 1024).toFixed(0)} KiB, written to ${path}`);
  });
});
