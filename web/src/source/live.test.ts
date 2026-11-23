import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cursor, hello } from '../testing/encode';
import { FRAME_CURSOR, FRAME_HELLO, type Frame } from './frames';
import { LiveSource, liveUrl } from './live';
import type { EngineEvent } from './messages';

describe('liveUrl', () => {
  it('uses ws for http and wss for https', () => {
    expect(liveUrl({ protocol: 'http:', host: '127.0.0.1:8642', pathname: '/' })).toBe('ws://127.0.0.1:8642/ws');
    expect(liveUrl({ protocol: 'https:', host: 'example.org', pathname: '/' })).toBe('wss://example.org/ws');
  });

  it('keeps the directory of the page', () => {
    expect(liveUrl({ protocol: 'http:', host: 'h:1', pathname: '/index.html' })).toBe('ws://h:1/ws');
    expect(liveUrl({ protocol: 'http:', host: 'h:1', pathname: '/app/' })).toBe('ws://h:1/app/ws');
    expect(liveUrl({ protocol: 'https:', host: 'h', pathname: '/a/b/index.html' })).toBe('wss://h/a/b/ws');
    expect(liveUrl({ protocol: 'http:', host: 'h', pathname: '' })).toBe('ws://h/ws');
  });
});

// A stand-in for the browser's WebSocket, driven by the test.
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // Test side.
  open(): void {
    this.onopen?.({});
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onerror?.({});
    this.onclose?.({});
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('LiveSource', () => {
  let frames: Frame[][];
  let events: EngineEvent[];
  let connection: boolean[];
  const handlers = {
    onFrames: (f: Frame[]) => frames.push(f),
    onEvent: (e: EngineEvent) => events.push(e),
    onConnection: (c: boolean) => connection.push(c),
  };

  beforeEach(() => {
    frames = [];
    events = [];
    connection = [];
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects, receives frames and events, and sends commands', () => {
    const live = new LiveSource('ws://h/ws', handlers);
    const ws = FakeSocket.all[0];
    expect(ws.url).toBe('ws://h/ws');
    expect(ws.binaryType).toBe('arraybuffer');
    expect(live.connected).toBe(false);
    expect(live.send({ cmd: 'run' })).toBe(false);

    ws.open();
    expect(live.connected).toBe(true);
    expect(connection).toEqual([true]);

    const msg = new Uint8Array([...hello(0), ...cursor(1, 0)]);
    ws.receive(buffer(msg));
    expect(frames.length).toBe(1);
    expect(frames[0].map((f) => f.type)).toEqual([FRAME_HELLO, FRAME_CURSOR]);

    ws.receive('{"ev":"status","state":"idle","tps":0,"tps_limit":0,"nodes":0,"clients":1}');
    expect(events).toEqual([{ ev: 'status', state: 'idle', tps: 0, tps_limit: 0, nodes: 0, clients: 1 }]);

    expect(live.send({ cmd: 'speed', tps: 12 })).toBe(true);
    expect(JSON.parse(ws.sent[0])).toEqual({ cmd: 'speed', tps: 12 });
    live.close();
  });

  it('survives a message that cannot be decoded', () => {
    const live = new LiveSource('ws://h/ws', handlers);
    const ws = FakeSocket.all[0];
    ws.open();
    ws.receive(buffer(hello(0).subarray(0, 20)));
    ws.receive('not json');
    expect(console.error).toHaveBeenCalledTimes(2);
    ws.receive(buffer(cursor(1, 0)));
    expect(frames.length).toBe(1);
    expect(live.connected).toBe(true);
    expect(ws.closed).toBe(false);
    live.close();
  });

  it('reconnects about once per second while down', () => {
    const live = new LiveSource('ws://h/ws', handlers);
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop();
    expect(live.connected).toBe(false);
    expect(connection).toEqual([true, false]);

    vi.advanceTimersByTime(999);
    expect(FakeSocket.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(2);

    // A failed attempt does not report a second loss, and tries again.
    FakeSocket.all[1].drop();
    expect(connection).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all.length).toBe(3);
    FakeSocket.all[2].open();
    expect(connection).toEqual([true, false, true]);
    live.close();
  });

  it('stops for good on close()', () => {
    const live = new LiveSource('ws://h/ws', handlers);
    FakeSocket.all[0].open();
    live.close();
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(live.connected).toBe(false);
    expect(connection).toEqual([true, false]);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all.length).toBe(1);
    expect(live.send({ cmd: 'run' })).toBe(false);
  });

  it('does not reconnect after close() while waiting to retry', () => {
    const live = new LiveSource('ws://h/ws', handlers);
    FakeSocket.all[0].drop();
    live.close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all.length).toBe(1);
  });
});
