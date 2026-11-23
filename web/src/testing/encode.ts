// Frame encoder for the unit tests only: builds the protocol's frame bytes
// so the decoder and the store can be fed by hand.
// The real encoder lives in the engine (engine/src/frames.cpp).

import {
  EVAL_LENS,
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_EVAL,
  FRAME_HELLO,
  FRAME_NODE,
  FRAME_PAIR,
  FRAME_STOP,
  FRAME_VOCAB,
  NONE,
  type Config,
  type Gate,
  type Hello,
} from '../source/frames';

const utf8 = new TextEncoder();

class Writer {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): this {
    this.room(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
    return this;
  }
  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
    return this;
  }
  f32(v: number): this {
    this.room(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// A whole frame: 12-byte header and body.
export function frame(type: number, t: number, body: Uint8Array): Uint8Array {
  return new Writer().u8(type).u8(0).u16(0).u32(body.length).u32(t).bytes(body).done();
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// `models` is 1 (only A) or 2 (A and B). `lensLayers` turns the logit lens on.
export function helloBody(protocol = 1, models: 1 | 2 = 1, lensLayers: number[] | null = null): Hello {
  const model = (slot: 'A' | 'B'): Hello['models'][number] => ({
    slot,
    name: 'Test',
    file: slot === 'A' ? 'test.gguf' : 'test-b.gguf',
    quant: slot === 'A' ? 'Q8_0' : 'Q2_K',
    arch: 'test',
    n_params: 1,
    size_bytes: 1,
    n_layer: 1,
    n_embd: 1,
    n_ctx: 64,
  });
  return {
    protocol,
    app: '0.1.0',
    llama_cpp: '0.9.0',
    created: '2026-01-01T00:00:00Z',
    n_vocab: 16,
    n_raw: 4,
    models: models === 2 ? [model('A'), model('B')] : [model('A')],
    lens: { enabled: lensLayers !== null, layers: lensLayers ?? [] },
    warnings: [],
  };
}

export function configBody(
  maxTokens = 16,
  mode: Config['mode'] = 'lockstep',
  driver: Config['driver'] = 'A',
  gates: Gate[] = [],
  seed = 42,
): Config {
  return { mode, driver, seed, max_tokens: maxTokens, gates };
}

export function hello(t = 0, protocol = 1, models: 1 | 2 = 1, lensLayers: number[] | null = null): Uint8Array {
  return frame(FRAME_HELLO, t, utf8.encode(JSON.stringify(helloBody(protocol, models, lensLayers))));
}

export function config(t = 0, c: Config = configBody()): Uint8Array {
  return frame(FRAME_CONFIG, t, utf8.encode(JSON.stringify(c)));
}

export function vocab(t: number, entries: { token: number; attr?: number; text: string | Uint8Array }[]): Uint8Array {
  const w = new Writer().u32(entries.length);
  for (const e of entries) {
    const b = typeof e.text === 'string' ? utf8.encode(e.text) : e.text;
    w.u32(e.token).u8(e.attr ?? 0).u16(b.length).bytes(b);
  }
  return frame(FRAME_VOCAB, t, w.done());
}

export function node(t: number, id: number, parent: number, token: number, depth: number, origin: number): Uint8Array {
  return frame(FRAME_NODE, t, new Writer().u32(id).u32(parent).u32(token).u32(depth).u8(origin).done());
}

export interface EvalSpec {
  node: number;
  slot?: number;
  entries: [token: number, p: number][];
  nExtra?: number;
  pick?: number;
  entropy?: number;
  decodeMs?: number;
  survivors?: number[];
  stageP?: number[]; // gates x entries
  lens?: [topId: number, topP: number, answerP: number, entropy: number][]; // one per layer
}

export function evalFrame(t: number, e: EvalSpec): Uint8Array {
  const survivors = e.survivors ?? [];
  const w = new Writer()
    .u32(e.node)
    .u8(e.slot ?? 0)
    .u8(e.entries.length - (e.nExtra ?? 0))
    .u8(e.nExtra ?? 0)
    .u8(survivors.length)
    .u8(e.pick ?? 0)
    .u8(e.lens ? EVAL_LENS : 0)
    .u16(0)
    .f32(e.entropy ?? 1)
    .f32(e.entries.reduce((s, [, p]) => s + p, 0))
    .f32(e.decodeMs ?? 1);
  for (const [token, p] of e.entries) w.u32(token).f32(p);
  for (const s of survivors) w.u32(s);
  for (const p of e.stageP ?? []) w.f32(p);
  if (e.lens) {
    w.u8(e.lens.length).u8(0).u16(0);
    for (const [topId, topP, answerP, entropy] of e.lens) w.u32(topId).f32(topP).f32(answerP).f32(entropy);
  }
  return frame(FRAME_EVAL, t, w.done());
}

export interface PairSpec {
  node: number;
  js?: number;
  klAB?: number;
  klBA?: number;
  rankAInB?: number;
  rankBInA?: number;
  flags?: number; // PAIR_*
}

export function pair(t: number, p: PairSpec): Uint8Array {
  const w = new Writer()
    .u32(p.node)
    .f32(p.js ?? 0)
    .f32(p.klAB ?? 0)
    .f32(p.klBA ?? 0)
    .u32(p.rankAInB ?? 0)
    .u32(p.rankBInA ?? 0)
    .u8(p.flags ?? 0);
  return frame(FRAME_PAIR, t, w.done());
}

export function cursor(t: number, a: number, b = NONE): Uint8Array {
  return frame(FRAME_CURSOR, t, new Writer().u32(a).u32(b).done());
}

export function stop(t: number, nodeId: number, slot: number, reason: number): Uint8Array {
  return frame(FRAME_STOP, t, new Writer().u32(nodeId).u8(slot).u8(reason).done());
}
