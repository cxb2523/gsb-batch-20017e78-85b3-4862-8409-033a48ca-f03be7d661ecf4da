// Acceptance checks for the gate chain at protocol level, against an engine that is
// already running with one or two models (`make run A=<file> [B=<file>]` or
// `make run-fake`, then `make test-e2e`). Skipped unless ILS_ENGINE_URL is set.
// Every check reads the frames: the EVALs, their survivors and stage_p, and
// the CONFIG each EVAL belongs to.
//
// The grammar checks need a real model: they are skipped with the fake one
// (its HELLO says llama_cpp "fake").
//
// ILS_SAVE=<path> also records a sample session (gates, a change of chain and
// the JSON grammar) and writes it there. A relative path is taken from the
// repository root, e.g. sessions/samples/gates-demo.ils.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTR_CONTROL,
  ATTR_EOG,
  FRAME_CONFIG,
  FRAME_EVAL,
  ORIGIN_PROMPT,
  STOP_EOG,
  type Config,
  type ConfigFrame,
  type EvalFrame,
  type Frame,
  type Gate,
  type Hello,
} from '../source/frames';
import type { ConfigChange, EngineEvent, StatusEvent } from '../source/messages';
import { decodeSession } from '../source/recorded';
import { Store } from '../store/store';
import { TestClient, until } from './client';

const BASE = process.env.ILS_ENGINE_URL ?? '';
const SAVE = process.env.ILS_SAVE ?? '';

// A raw prompt that invites the model to go on.
const PROMPT =
  'The old lighthouse keeper climbed the stairs every evening. One night, ' +
  'when the lamp would not light, he';

const JSON_PROMPT =
  'Describe a cat as a JSON object with exactly two keys, "name" (a string) and "age" (a number). ' +
  'Reply with the JSON object only.';

const JSON_GBNF = readFileSync(resolve(import.meta.dirname, '../../../third_party/llama.cpp/grammars/json.gbnf'), 'utf8');

const TOKENS = 24; // max_tokens of most checks
const SUM_EPS = 1e-4;
const TIMEOUT = 120_000;
const GENERATION_MS = 90_000;

// Explicit mode and driver: ignored with one model, and with two they make
// the text follow A.
const BASE_CONFIG: ConfigChange = { mode: 'lockstep', driver: 'A' };

const topK = (k: number): Gate => ({ type: 'top_k', k });
const topP = (p: number): Gate => ({ type: 'top_p', p });
const minP = (p: number): Gate => ({ type: 'min_p', p });
const temp = (t: number): Gate => ({ type: 'temp', t });
const PENALTIES: Gate = { type: 'penalties', last_n: 64, repeat: 1.1, frequency: 0, presence: 0 };

// Each EVAL with the gates of the CONFIG it belongs to (the last one before it).
function evalsWithGates(frames: Frame[]): { e: EvalFrame; gates: Gate[] }[] {
  const out: { e: EvalFrame; gates: Gate[] }[] = [];
  let config: Config | null = null;
  for (const f of frames) {
    if (f.type === FRAME_CONFIG) config = f.config;
    else if (f.type === FRAME_EVAL) out.push({ e: f, gates: config?.gates ?? [] });
  }
  return out;
}

// Row `g` of stage_p.
function stageRow(e: EvalFrame, g: number): number[] {
  const n = e.nRaw + e.nExtra;
  return [...e.stageP.subarray(g * n, (g + 1) * n)];
}

// The distribution a gate starts from: the row of the gate before it, or p_raw.
function rowBefore(e: EvalFrame, g: number): number[] {
  return g === 0 ? [...e.pRaw] : stageRow(e, g - 1);
}

// The text the models wrote on the viewed path, control tokens left out.
function generatedText(s: Store): string {
  const bytes: number[] = [];
  for (let i = s.promptLength; i < s.path.length; i++) {
    const v = s.vocab.get(s.token[s.path[i]]);
    if (!v || v.attr & (ATTR_CONTROL | ATTR_EOG)) continue;
    bytes.push(...v.bytes);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function generatedNodes(s: Store): number {
  return s.origin.filter((o) => o !== ORIGIN_PROMPT).length;
}

function lastStatus(c: TestClient): StatusEvent | undefined {
  return c.events.filter((e): e is StatusEvent => e.ev === 'status').at(-1);
}

// The first error of a failed step (no `cmd`) after event number `index`.
function stepError(c: TestClient, index: number): Extract<EngineEvent, { ev: 'error' }> | undefined {
  for (let i = index; i < c.events.length; i++) {
    const e = c.events[i];
    if (e.ev === 'error' && e.cmd === undefined) return e;
  }
  return undefined;
}

describe.skipIf(!BASE)('engine end to end, gates', () => {
  let hello: Hello | null = null;
  const clients: TestClient[] = [];
  const connect = (): TestClient => {
    const c = new TestClient(BASE);
    clients.push(c);
    return c;
  };
  const fake = (): boolean => hello?.llama_cpp === 'fake';

  beforeAll(async () => {
    const c = new TestClient(BASE);
    try {
      await until(() => c.store.hello !== null, 'HELLO');
      hello = c.store.hello;
    } finally {
      c.close();
    }
  }, TIMEOUT);

  // Leave the engine without gates, as it starts.
  afterAll(async () => {
    const c = new TestClient(BASE);
    try {
      await until(() => c.store.config !== null, 'the CONFIG');
      c.send({ cmd: 'pause' });
      c.config({ gates: [] });
      await until(() => c.store.config?.gates.length === 0, 'an empty chain');
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

  // Starts a session with `config` and lets it run at `tps` (0: unlimited).
  async function begin(
    c: TestClient,
    config: ConfigChange,
    maxTokens = TOKENS,
    tps = 0,
    prompt = PROMPT,
    format: 'raw' | 'chat' = 'raw',
  ): Promise<void> {
    await until(() => c.opened, 'the connection');
    await c.start(prompt, maxTokens, { format, config: { ...BASE_CONFIG, ...config } });
    expect(c.store.config!.gates).toHaveLength(config.gates?.length ?? 0);
    c.send({ cmd: 'speed', tps });
    c.send({ cmd: 'run' });
  }

  // Generates a whole session with `config` and returns its EVALs.
  async function generate(c: TestClient, config: ConfigChange, maxTokens = TOKENS): Promise<{ e: EvalFrame; gates: Gate[] }[]> {
    const seen = c.events.length;
    await begin(c, config, maxTokens);
    await until(() => c.stopped || stepError(c, seen) !== undefined, 'the generation to stop', GENERATION_MS);
    expect(stepError(c, seen), 'a failed step').toBeUndefined();
    const evals = evalsWithGates(c.frames);
    expect(evals.length).toBeGreaterThan(0);
    for (const { e, gates } of evals) expect(e.nGates, `n_gates at node ${e.node}`).toBe(gates.length);
    return evals;
  }

  it(
    'top-k: k survivors, or those the gate before left if fewer',
    async () => {
      const c = connect();
      const gates = [PENALTIES, topK(20), topP(0.9), topK(3), temp(1)];
      const evals = await generate(c, { gates, seed: 1 });
      const nVocab = c.store.hello!.n_vocab;
      let fewer = 0; // times a top_k found fewer than k
      for (const { e } of evals) {
        gates.forEach((gate, g) => {
          if (gate.type !== 'top_k') return;
          const before = g === 0 ? nVocab : e.survivors[g - 1];
          if (before < gate.k) fewer++;
          expect(e.survivors[g], `survivors of gate ${g} at node ${e.node}`).toBe(Math.min(gate.k, before));
        });
      }
      console.log(`top-k: ${evals.length} EVALs, ${fewer} times a top_k had fewer than k to keep`);
    },
    TIMEOUT,
  );

  it(
    'sum: with a chain that ends in top_k <= 8 the survivors are entries and the last row adds up to 1',
    async () => {
      const c = connect();
      const gates = [topP(0.95), temp(0.9), topK(6)];
      const evals = await generate(c, { gates, seed: 2 });
      for (const { e } of evals) {
        const last = stageRow(e, e.nGates - 1);
        const sum = last.reduce((a, p) => a + p, 0);
        expect(Math.abs(sum - 1), `sum of the last row at node ${e.node}`).toBeLessThan(SUM_EPS);
        const alive = last.filter((p) => p > 0).length;
        expect(alive, `survivors among the entries at node ${e.node}`).toBe(e.survivors[e.nGates - 1]);
        expect(e.survivors[e.nGates - 1]).toBeLessThanOrEqual(6);
        expect(last[e.pick], `the pick survives at node ${e.node}`).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    'the most likely: temperature 0, or top_k 1 last, picks the best of what the gates before left',
    async () => {
      const chains: Gate[][] = [
        [temp(0)], // from p_raw
        [topK(1)], // from p_raw
        [topP(0.9), temp(0)],
        [PENALTIES, temp(1.5), topK(1)],
      ];
      for (const gates of chains) {
        const c = connect();
        const evals = await generate(c, { gates, seed: 3 }, 16);
        const g = gates.length - 1;
        for (const { e } of evals) {
          const before = rowBefore(e, g);
          const best = Math.max(...before);
          expect(before[e.pick], `pick at node ${e.node} with ${JSON.stringify(gates)}`).toBe(best);
          expect(e.survivors[g], `one survivor at node ${e.node}`).toBe(1);
        }
        c.close();
      }
    },
    TIMEOUT * 2,
  );

  it(
    'determinism: same prompt, seed and configuration give the same text',
    async () => {
      const config: ConfigChange = { gates: [PENALTIES, topK(40), topP(0.95), temp(1)], seed: 1234 };
      const texts: string[] = [];
      for (let run = 0; run < 2; run++) {
        const c = connect();
        await generate(c, config);
        texts.push(Buffer.from(c.text()).toString('hex'));
        c.close();
      }
      expect(texts[0].length).toBeGreaterThan(0);
      expect(texts[1]).toBe(texts[0]);
    },
    TIMEOUT,
  );

  it(
    'a change of chain halfway: a CONFIG arrives and later EVALs carry the new n_gates; a bad grammar is refused',
    async () => {
      const c = connect();
      const seen = c.events.length;
      await begin(c, { gates: [topK(40), temp(0.8)], seed: 5 }, 60, 10);
      const s = c.store;
      await until(() => generatedNodes(s) >= 5 || c.stopped, 'about 5 tokens', GENERATION_MS);
      expect(c.stopped, 'stopped before the change').toBe(false);

      const next = [topP(0.9), topK(10), temp(0.7)];
      const from = c.frames.length;
      c.config({ gates: next });
      await until(
        () => c.frames.slice(from).some((f) => f.type === FRAME_CONFIG && f.config.gates.length === next.length),
        'the CONFIG with the new chain',
      );
      const at = c.frames.findIndex((f, i) => i >= from && f.type === FRAME_CONFIG);
      expect((c.frames[at] as ConfigFrame).config.gates).toEqual(next);
      await until(
        () => c.frames.slice(at).filter((f) => f.type === FRAME_EVAL).length >= 3 || c.stopped,
        'steps after the change',
        GENERATION_MS,
      );
      c.send({ cmd: 'pause' });
      await until(() => lastStatus(c)?.state !== 'running', 'the pause');
      expect(stepError(c, seen), 'a failed step').toBeUndefined();

      const before = evalsWithGates(c.frames.slice(0, at));
      const after = c.frames.slice(at).filter((f): f is EvalFrame => f.type === FRAME_EVAL);
      expect(before.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);
      for (const { e } of before) expect(e.nGates, `n_gates before, node ${e.node}`).toBe(2);
      for (const e of after) expect(e.nGates, `n_gates after, node ${e.node}`).toBe(3);
      // The store keeps each decision with its own chain.
      const stored = (e: EvalFrame) => s.evals[e.slot as 0 | 1][e.node]!;
      expect(stored(before[0].e).config!.gates).toHaveLength(2);
      expect(stored(after[0]).config!.gates).toEqual(next);

      // A grammar that cannot be read: an error, and no CONFIG.
      const events = c.events.length;
      const frames = c.frames.length;
      c.config({ gates: [{ type: 'grammar', gbnf: 'root ::= (' }] });
      await until(() => c.errorSince(events, 'config') !== undefined, 'an error for config');
      await new Promise((r) => setTimeout(r, 300));
      expect(c.frames.slice(frames).filter((f) => f.type === FRAME_CONFIG)).toEqual([]);
      expect(c.store.config!.gates).toEqual(next);
    },
    TIMEOUT,
  );

  it(
    'grammar: with the JSON grammar the generated text is JSON',
    async (ctx) => {
      if (fake()) return ctx.skip();
      const c = connect();
      const seen = c.events.length;
      const gates: Gate[] = [{ type: 'grammar', gbnf: JSON_GBNF }, temp(0)];
      await begin(c, { gates, seed: 6 }, 160, 0, JSON_PROMPT, 'chat');
      await until(() => c.stopped || stepError(c, seen) !== undefined, 'the generation to stop', GENERATION_MS);
      expect(stepError(c, seen), 'a failed step').toBeUndefined();
      const text = generatedText(c.store);
      console.log(`grammar: ${JSON.stringify(text)}`);
      expect(c.store.stopAtEnd()?.reason, 'stopped at the end of generation').toBe(STOP_EOG);
      expect(() => JSON.parse(text)).not.toThrow();
      // The grammar is the first gate and cuts most of the vocabulary.
      const first = evalsWithGates(c.frames)[0].e;
      expect(first.survivors[0]).toBeLessThan(c.store.hello!.n_vocab / 2);
    },
    TIMEOUT,
  );

  it.skipIf(!SAVE)(
    'records a sample session: gates, a change of chain and the JSON grammar',
    async (ctx) => {
      if (fake()) return ctx.skip();
      const c = connect();
      const seen = c.events.length;
      const grammar: Gate = { type: 'grammar', gbnf: JSON_GBNF };
      const prompt =
        'List three famous lighthouses as a JSON array of objects with the keys "name", "country" and "year". ' +
        'Reply with the JSON only.';
      // The demo speed, so the recorded times are those of a real demo.
      await begin(c, { gates: [grammar, PENALTIES, topK(40), topP(0.95), temp(0.8)], seed: 42 }, 200, 12, prompt, 'chat');
      const s = c.store;
      await until(() => generatedNodes(s) >= 25 || c.stopped, '25 tokens', GENERATION_MS);
      expect(c.stopped, 'stopped before the change').toBe(false);
      c.config({ gates: [grammar, topK(10), minP(0.05), temp(0.5)] });
      await until(() => c.stopped || generatedNodes(s) >= 150, 'the end of the sample', GENERATION_MS);
      if (!c.stopped) c.send({ cmd: 'pause' });
      await until(() => lastStatus(c)?.state !== 'running', 'the pause');
      expect(stepError(c, seen), 'a failed step').toBeUndefined();

      const res = await fetch(BASE.replace(/\/$/, '') + '/api/session.ils');
      expect(res.status).toBe(200);
      const file = new Uint8Array(await res.arrayBuffer());
      const frames = await decodeSession(file);
      const replayed = new Store();
      for (const f of frames) replayed.apply(f);
      const chains = new Set(evalsWithGates(frames).map(({ e }) => e.nGates));
      console.log(
        `sample: ${generatedNodes(replayed)} tokens, chains of ${[...chains].join(' and ')} gates, ` +
          `${(file.length / 1024).toFixed(0)} KiB: ${JSON.stringify(generatedText(replayed))}`,
      );
      expect(chains).toEqual(new Set([5, 4]));

      const path = resolve(import.meta.dirname, '../../..', SAVE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file);
      console.log(`sample session written to ${path}`);
    },
    TIMEOUT,
  );
});
