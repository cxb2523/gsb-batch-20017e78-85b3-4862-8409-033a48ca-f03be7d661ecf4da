// Acceptance checks for generation at protocol level, against an engine that is
// already running (`make run` or `make run-fake`, then `make test-e2e`).
// Skipped unless ILS_ENGINE_URL is set. Nothing is assumed about the model:
// vocabulary, text and lengths come from the engine.

import { afterEach, describe, expect, it } from 'vitest';
import { STOP_MAX_TOKENS } from '../source/frames';
import type { StatusEvent } from '../source/messages';
import { decodeSession, Player } from '../source/recorded';
import { Store } from '../store/store';
import { TestClient, until } from './client';

const BASE = process.env.ILS_ENGINE_URL ?? '';

// A prompt that invites the model to go on.
const PROMPT =
  'The history of computing is a long story of people trying to make machines ' +
  'do arithmetic faster than they could themselves. It begins, in most tellings, with';

const TIMEOUT = 120_000;

function textOf(store: Store): string {
  const bytes = store.path.flatMap((n) => [...(store.vocab.get(store.token[n])?.bytes ?? [])]);
  return Buffer.from(bytes).toString('hex');
}

function nodesOf(store: Store): unknown {
  return { parent: store.parent, token: store.token, depth: store.depth, origin: store.origin };
}

describe.skipIf(!BASE)('engine end to end', () => {
  const clients: TestClient[] = [];
  const connect = (origin?: string): TestClient => {
    const c = new TestClient(BASE, origin);
    clients.push(c);
    return c;
  };

  afterEach(() => {
    for (const c of clients) {
      expect(c.errors, 'undecodable messages').toEqual([]);
      c.close();
    }
    clients.length = 0;
  });

  // Starts a session on `c` and generates it to the end at `tps` (0: unlimited).
  async function generate(c: TestClient, maxTokens: number, tps: number): Promise<void> {
    await until(() => c.opened, 'the connection');
    await c.start(PROMPT, maxTokens);
    c.send({ cmd: 'speed', tps });
    c.send({ cmd: 'run' });
  }

  it(
    'shows the loaded model before any prompt',
    async () => {
      const c = connect();
      await until(() => c.store.hello !== null && c.store.config !== null && c.events.some((e) => e.ev === 'status'),
        'HELLO, CONFIG and a status event');
      expect(c.opened).toBe(true);
      const hello = c.store.hello!;
      expect(hello.protocol).toBe(1);
      expect(c.store.unsupported).toBe(false);
      expect(hello.models.length).toBeGreaterThanOrEqual(1);
      expect(hello.models[0].slot).toBe('A');
      expect(hello.models[0].name.length).toBeGreaterThan(0);
      expect(hello.n_vocab).toBeGreaterThan(0);
      expect(c.store.config!.max_tokens).toBeGreaterThan(0);
      const status = c.events.find((e): e is StatusEvent => e.ev === 'status')!;
      expect(['idle', 'running', 'paused']).toContain(status.state);
      expect(status.clients).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  it(
    'stops after max_tokens and refuses to run on',
    async () => {
      const c = connect();
      await generate(c, 20, 0);
      await until(() => c.store.stopAtEnd() !== undefined, 'the generation to stop', 60_000);
      const stop = c.store.stopAtEnd()!;
      if (stop.reason === STOP_MAX_TOKENS) expect(c.generated).toBe(20);
      else expect(c.generated).toBeLessThanOrEqual(20);
      expect(c.generated).toBeGreaterThan(0);

      const seen = c.events.length;
      c.send({ cmd: 'run' });
      await until(() => c.errorSince(seen, 'run') !== undefined, 'an error for run');
    },
    TIMEOUT,
  );

  it(
    'a late browser ends with the same nodes and text',
    async () => {
      const first = connect();
      await generate(first, 40, 20);
      await until(() => first.generated >= 10 || first.store.stopAtEnd() !== undefined, 'about 10 tokens', 60_000);
      const late = connect();
      const atJoin = first.store.stopAtEnd() === undefined ? first.generated : -1;
      await until(() => first.store.stopAtEnd() !== undefined, 'the generation to stop', 60_000);
      // It really joined halfway (unless the model stopped before 10 tokens).
      if (atJoin >= 0) expect(atJoin).toBeLessThan(first.generated);
      await until(
        () => late.store.stopAtEnd() !== undefined && late.store.nodeCount === first.store.nodeCount,
        'the late browser to catch up',
      );
      expect(late.store.nodeCount).toBeGreaterThan(first.store.promptLength);
      expect(nodesOf(late.store)).toEqual(nodesOf(first.store));
      expect(late.store.path).toEqual(first.store.path);
      expect(textOf(late.store)).toBe(textOf(first.store));
    },
    TIMEOUT,
  );

  it(
    'the downloaded session replays to the same nodes and text',
    async () => {
      const c = connect();
      await generate(c, 20, 0);
      await until(() => c.store.stopAtEnd() !== undefined, 'the generation to stop', 60_000);

      const res = await fetch(BASE.replace(/\/$/, '') + '/api/session.ils');
      expect(res.status).toBe(200);
      const frames = await decodeSession(new Uint8Array(await res.arrayBuffer()));

      // Applied all at once.
      const all = new Store();
      for (const f of frames) all.apply(f);
      expect(all.nodeCount).toBe(c.store.nodeCount);
      expect(nodesOf(all)).toEqual(nodesOf(c.store));
      expect(textOf(all)).toBe(textOf(c.store));
      expect(all.stopAtEnd()).toEqual(c.store.stopAtEnd());

      // Played to the end.
      const played = new Store();
      const player = new Player(frames, played);
      player.play();
      for (let i = 0; i < 100_000 && !player.ended; i++) player.tick(100);
      expect(player.ended).toBe(true);
      expect(played.nodeCount).toBe(c.store.nodeCount);
      expect(nodesOf(played)).toEqual(nodesOf(c.store));
      expect(textOf(played)).toBe(textOf(c.store));
    },
    TIMEOUT,
  );

  it(
    'rejects a WebSocket from another origin',
    async () => {
      const evil = connect('http://evil.example');
      await until(() => evil.closed, 'the connection to be refused');
      expect(evil.opened).toBe(false);
      expect(evil.store.hello).toBeNull();
    },
    TIMEOUT,
  );
});
