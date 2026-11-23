import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store/store';
import { concat, config, cursor, evalFrame, hello, node, stop, vocab } from '../testing/encode';
import { decodeFrames, NONE, ORIGIN_MODEL, ORIGIN_PROMPT, type Frame } from './frames';
import { decodeSession, loadSession, Player } from './recorded';

// A session: HELLO and CONFIG at 0, prompt at 100, steps every 100 ms up to
// 500, an idle gap, and a last step at 5000 that stops.
function sessionBytes(): Uint8Array {
  const parts = [
    hello(0),
    config(0),
    vocab(100, [{ token: 0, attr: 1, text: '<s>' }, { token: 1, text: 'x' }]),
    node(100, 0, NONE, 0, 0, ORIGIN_PROMPT),
    cursor(100, 0),
  ];
  for (let i = 0; i < 4; i++) {
    const t = 200 + i * 100;
    parts.push(evalFrame(t, { node: i, entries: [[1, 0.5]] }), node(t, i + 1, i, 1, i + 1, ORIGIN_MODEL), cursor(t, i + 1));
  }
  parts.push(evalFrame(5000, { node: 4, entries: [[1, 0.5]] }), node(5000, 5, 4, 1, 5, ORIGIN_MODEL), cursor(5000, 5),
    stop(5000, 5, 0, 1));
  return concat(...parts);
}

const frames: Frame[] = decodeFrames(sessionBytes());

// What a store looks like, without the counters that differ between runs.
function snapshot(s: Store): unknown {
  return {
    hello: s.hello,
    config: s.config,
    vocab: [...s.vocab.entries()],
    parent: s.parent,
    token: s.token,
    depth: s.depth,
    origin: s.origin,
    evals: s.evals,
    pairs: s.pairs,
    stops: [...s.stops.entries()],
    cursorA: s.cursorA,
    cursorB: s.cursorB,
    front: s.front,
    path: s.path,
    lane: s.lane,
    split: s.split,
    splits: s.splits,
    sessionTime: s.sessionTime,
  };
}

// The store after applying every frame up to `t` directly.
function upTo(t: number, from: Frame[] = frames): unknown {
  const s = new Store();
  for (const f of from) if (f.t <= t) s.apply(f);
  return snapshot(s);
}

describe('decodeSession', () => {
  it('decompresses and decodes a session', async () => {
    const out = await decodeSession(new Uint8Array(gzipSync(sessionBytes())));
    expect(out).toEqual(frames);
  });

  it('rejects a file that is not gzip', async () => {
    await expect(decodeSession(sessionBytes())).rejects.toThrow(/not gzip/);
    await expect(decodeSession(new Uint8Array(0))).rejects.toThrow(/not gzip/);
  });

  it('rejects a damaged gzip stream', async () => {
    const z = gzipSync(sessionBytes());
    await expect(decodeSession(new Uint8Array(z.subarray(0, z.length - 10)))).rejects.toThrow(/damaged session file/);
  });

  it('rejects truncated frames', async () => {
    const raw = sessionBytes();
    await expect(decodeSession(new Uint8Array(gzipSync(raw.subarray(0, raw.length - 3))))).rejects.toThrow(
      /damaged session file \(truncated frame/,
    );
  });

  it('rejects frames that do not start with HELLO', async () => {
    await expect(decodeSession(new Uint8Array(gzipSync(cursor(0, 0))))).rejects.toThrow(/does not start with HELLO/);
  });
});

describe('loadSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and decodes', async () => {
    const body = gzipSync(sessionBytes());
    vi.stubGlobal('fetch', async () => new Response(body));
    expect(await loadSession('s.ils')).toEqual(frames);
  });

  it('gives readable errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(loadSession('missing.ils')).rejects.toThrow('session not found: missing.ils');

    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(loadSession('s.ils')).rejects.toThrow('cannot fetch s.ils: HTTP 500');

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    await expect(loadSession('s.ils')).rejects.toThrow('cannot fetch s.ils: network down');

    // A dev server answering with its index page.
    vi.stubGlobal('fetch', async () => new Response('<!doctype html>'));
    await expect(loadSession('s.ils')).rejects.toThrow('s.ils: not a session file (not gzip)');
  });
});

describe('Player', () => {
  it('applies the frames of time 0 on construction and starts paused', () => {
    const store = new Store();
    const p = new Player(frames, store);
    expect(store.hello).not.toBeNull();
    expect(store.config).not.toBeNull();
    expect(store.nodeCount).toBe(0);
    expect(p.time).toBe(0);
    expect(p.duration).toBe(5000);
    expect(p.playing).toBe(false);
    expect(p.ended).toBe(false);
    p.tick(1000); // paused: nothing moves
    expect(p.time).toBe(0);
    expect(store.nodeCount).toBe(0);
  });

  it('applies what is due on each tick, according to speed', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.play();
    p.tick(99);
    expect(store.nodeCount).toBe(0);
    p.tick(1);
    expect(p.time).toBe(100);
    expect(snapshot(store)).toEqual(upTo(100));
    p.speed = 2;
    p.tick(50);
    expect(p.time).toBe(200);
    expect(snapshot(store)).toEqual(upTo(200));
    p.speed = 0.5;
    p.tick(100);
    expect(p.time).toBe(250);
    expect(snapshot(store)).toEqual(upTo(250));
  });

  it('skips idle gaps longer than one second', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.seek(500);
    p.play();
    p.tick(16);
    // The next frame is 4.5 s away: the clock jumps to it.
    expect(p.time).toBe(5000);
    expect(p.ended).toBe(true);
    expect(p.playing).toBe(false);
    expect(snapshot(store)).toEqual(upTo(5000));
  });

  it('plays gaps of one second or less in real time', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.play();
    p.tick(16);
    expect(p.time).toBe(16);
  });

  it('seeks forward and back to the same state as applying up to that time', () => {
    const store = new Store();
    const p = new Player(frames, store);
    for (const t of [350, 5000, 0, 250, 200, 99, 100, 4999, 300]) {
      p.seek(t);
      expect(p.time).toBe(t);
      expect(snapshot(store), `at ${t}`).toEqual(upTo(t));
    }
    p.seek(-50);
    expect(p.time).toBe(0);
    p.seek(1e9);
    expect(p.time).toBe(5000);
    expect(p.ended).toBe(true);
  });

  it('rebuilds a two-model session (pair.ils) the same at any time', async () => {
    const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/pair.ils'));
    const pairFrames = await decodeSession(new Uint8Array(file));
    const store = new Store();
    const p = new Player(pairFrames, store);
    // Through the split (500), both stops (600, 700) and back to lockstep (800).
    for (const t of [550, 800, 0, 500, 350, 650, 700, 450, 800, 499]) {
      p.seek(t);
      expect(snapshot(store), `at ${t}`).toEqual(upTo(t, pairFrames));
    }
    p.seek(500);
    expect([store.lane, store.split, store.splits]).toEqual([[6], 4, 1]);
    p.seek(800);
    expect([store.front, store.lane, store.split]).toEqual([1, [], -1]);
  });

  it('a seek back voids the path drawn so far', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.seek(400);
    const epoch = store.pathEpoch;
    p.seek(300);
    expect(store.pathEpoch).toBeGreaterThan(epoch);
  });

  it('a seek back keeps the path chosen by hand if its tip exists by then', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.seek(400); // path 0..3, cursor at 3
    store.viewNode(2);
    expect(store.follow).toBe(false);
    p.seek(5000);
    expect(store.path).toEqual([0, 1, 2]); // going forward does not touch it
    p.seek(300); // node 2 exists at 300: still viewed
    expect(store.follow).toBe(false);
    expect(store.path).toEqual([0, 1, 2]);
    expect(store.cursorA).toBe(2);
    p.seek(150); // node 2 does not exist yet: follow the cursor
    expect(store.follow).toBe(true);
    expect(store.path).toEqual([0]);
  });

  it('steps one frame group at a time and pauses', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.play();
    const applied = store.framesApplied;
    p.stepForward();
    expect(p.playing).toBe(false);
    expect(p.time).toBe(100);
    expect(store.framesApplied - applied).toBe(3);
    p.stepForward();
    expect(p.time).toBe(200);
    expect(store.framesApplied - applied).toBe(6);
    expect(snapshot(store)).toEqual(upTo(200));
    for (let i = 0; i < 4; i++) p.stepForward();
    expect(p.time).toBe(5000);
    expect(p.ended).toBe(true);
    p.stepForward(); // at the end: nothing
    expect(p.time).toBe(5000);
  });

  it('stops at the end and plays again from the start', () => {
    const store = new Store();
    const p = new Player(frames, store);
    p.play();
    for (let i = 0; i < 100 && !p.ended; i++) p.tick(100);
    expect(p.ended).toBe(true);
    expect(p.playing).toBe(false);
    expect(p.time).toBe(5000);
    expect(store.stopAtEnd()).toEqual({ slot: 0, reason: 1 });
    expect(snapshot(store)).toEqual(upTo(5000));

    p.play();
    expect(p.playing).toBe(true);
    expect(p.time).toBe(0);
    expect(snapshot(store)).toEqual(upTo(0));
    p.tick(100);
    expect(snapshot(store)).toEqual(upTo(100));
  });

  it('handles an empty session', () => {
    const p = new Player([], new Store());
    expect(p.duration).toBe(0);
    expect(p.ended).toBe(true);
    p.play();
    expect(p.playing).toBe(false);
  });
});
