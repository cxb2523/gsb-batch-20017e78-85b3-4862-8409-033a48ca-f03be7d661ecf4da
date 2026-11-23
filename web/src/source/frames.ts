// Binary frames of the engine protocol. This file and engine/src/frames.cpp
// are the two sides of the contract: change them together, and with the
// synthetic sessions in sessions/golden/.

export const NONE = 0xffffffff; // "no node"
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 12;

export const FRAME_HELLO = 1;
export const FRAME_VOCAB = 2;
export const FRAME_CONFIG = 3;
export const FRAME_NODE = 4;
export const FRAME_EVAL = 5;
export const FRAME_PAIR = 6;
export const FRAME_CURSOR = 7;
export const FRAME_STOP = 8;

export const ORIGIN_PROMPT = 0;
export const ORIGIN_MODEL = 1;
export const ORIGIN_USER = 2;

export const ATTR_CONTROL = 1;
export const ATTR_EOG = 2;

// PAIR flag bits.
export const PAIR_SAME_TOP = 1; // same most likely token
export const PAIR_SAME_PICK = 2; // same pick: no disagreement
export const PAIR_APPROX = 4; // computed from stored candidates

// EVAL flag bits.
export const EVAL_LENS = 1; // a logit-lens section follows stageP

export const STOP_EOG = 0;
export const STOP_MAX_TOKENS = 1;
export const STOP_CONTEXT_FULL = 2;

export interface ModelInfo {
  slot: 'A' | 'B';
  name: string;
  file: string;
  quant: string;
  arch: string;
  n_params: number;
  size_bytes: number;
  n_layer: number;
  n_embd: number;
  n_ctx: number;
}

export interface Hello {
  protocol: number;
  app: string;
  llama_cpp: string;
  created: string;
  n_vocab: number;
  n_raw: number;
  models: ModelInfo[];
  lens: { enabled: boolean; layers: number[] };
  warnings: string[];
}

// One gate of CONFIG.gates: a sampler and its parameters. A session written
// by a newer engine may carry a type this reader does not know: read `type`
// as a plain string before trusting the parameters.
export type Gate =
  | { type: 'grammar'; gbnf: string }
  | { type: 'penalties'; last_n: number; repeat: number; frequency: number; presence: number }
  | { type: 'top_k'; k: number }
  | { type: 'top_p'; p: number }
  | { type: 'min_p'; p: number }
  | { type: 'temp'; t: number };

export type GateType = Gate['type'];

export interface Config {
  mode: 'lockstep' | 'free';
  driver: 'A' | 'B';
  seed: number;
  max_tokens: number;
  gates: Gate[];
}

export interface VocabEntry {
  token: number;
  attr: number; // ATTR_CONTROL | ATTR_EOG
  bytes: Uint8Array; // raw bytes, possibly an incomplete UTF-8 sequence
}

export interface HelloFrame {
  type: typeof FRAME_HELLO;
  t: number;
  hello: Hello;
}

export interface VocabFrame {
  type: typeof FRAME_VOCAB;
  t: number;
  entries: VocabEntry[];
}

export interface ConfigFrame {
  type: typeof FRAME_CONFIG;
  t: number;
  config: Config;
}

export interface NodeFrame {
  type: typeof FRAME_NODE;
  t: number;
  id: number;
  parent: number; // NONE for the first token
  token: number;
  depth: number;
  origin: number;
}

// The logit-lens section of an EVAL: one value per layer of HELLO lens.layers.
export interface Lens {
  topId: Uint32Array; // most likely token according to each layer
  topP: Float32Array; // its probability
  answerP: Float32Array; // probability of the model's most likely token
  entropy: Float32Array; // bits
}

export interface EvalFrame {
  type: typeof FRAME_EVAL;
  t: number;
  node: number;
  slot: number; // 0: A, 1: B
  nRaw: number;
  nExtra: number;
  nGates: number;
  pick: number; // index into tokens / pRaw
  flags: number;
  entropy: number; // bits
  rawMass: number;
  decodeMs: number;
  tokens: Uint32Array; // nRaw + nExtra token ids
  pRaw: Float32Array; // their probabilities, same order
  survivors: Uint32Array; // one per gate
  stageP: Float32Array; // nGates rows of (nRaw + nExtra)
  lens: Lens | null; // only with the EVAL_LENS flag
}

// The comparison of A and B at a node both have evaluated.
export interface PairFrame {
  type: typeof FRAME_PAIR;
  t: number;
  node: number;
  js: number; // Jensen-Shannon divergence, bits, 0..1
  klAB: number; // KL of A with respect to B, bits; may be Infinity
  klBA: number;
  rankAInB: number; // rank in B of A's most likely token, 0 is first; NONE if unknown
  rankBInA: number;
  flags: number; // PAIR_*
}

export interface CursorFrame {
  type: typeof FRAME_CURSOR;
  t: number;
  nodeA: number;
  nodeB: number; // NONE without a model B
}

export interface StopFrame {
  type: typeof FRAME_STOP;
  t: number;
  node: number;
  slot: number; // 0: A, 1: B, 2: both
  reason: number; // STOP_*
}

export type Frame =
  | HelloFrame
  | VocabFrame
  | ConfigFrame
  | NodeFrame
  | EvalFrame
  | PairFrame
  | CursorFrame
  | StopFrame;

const utf8 = new TextDecoder('utf-8');

function parseJson<T>(body: Uint8Array): T {
  return JSON.parse(utf8.decode(body)) as T;
}

function decodeVocab(d: DataView, body: Uint8Array, t: number): VocabFrame {
  const count = d.getUint32(0, true);
  const entries: VocabEntry[] = [];
  let p = 4;
  for (let i = 0; i < count; i++) {
    const token = d.getUint32(p, true);
    const attr = d.getUint8(p + 4);
    const len = d.getUint16(p + 5, true);
    p += 7;
    if (p + len > body.length) throw new Error('VOCAB entry runs past the frame');
    entries.push({ token, attr, bytes: body.slice(p, p + len) });
    p += len;
  }
  return { type: FRAME_VOCAB, t, entries };
}

function decodeEval(d: DataView, t: number): EvalFrame {
  const nRaw = d.getUint8(5);
  const nExtra = d.getUint8(6);
  const nGates = d.getUint8(7);
  const n = nRaw + nExtra;
  const tokens = new Uint32Array(n);
  const pRaw = new Float32Array(n);
  let p = 24;
  for (let i = 0; i < n; i++) {
    tokens[i] = d.getUint32(p, true);
    pRaw[i] = d.getFloat32(p + 4, true);
    p += 8;
  }
  const survivors = new Uint32Array(nGates);
  for (let g = 0; g < nGates; g++) {
    survivors[g] = d.getUint32(p, true);
    p += 4;
  }
  const stageP = new Float32Array(nGates * n);
  for (let i = 0; i < stageP.length; i++) {
    stageP[i] = d.getFloat32(p, true);
    p += 4;
  }
  const flags = d.getUint8(9);
  let lens: Lens | null = null;
  if (flags & EVAL_LENS) {
    const nLens = d.getUint8(p);
    p += 4; // n_lens and three reserved bytes
    lens = {
      topId: new Uint32Array(nLens),
      topP: new Float32Array(nLens),
      answerP: new Float32Array(nLens),
      entropy: new Float32Array(nLens),
    };
    for (let i = 0; i < nLens; i++) {
      lens.topId[i] = d.getUint32(p, true);
      lens.topP[i] = d.getFloat32(p + 4, true);
      lens.answerP[i] = d.getFloat32(p + 8, true);
      lens.entropy[i] = d.getFloat32(p + 12, true);
      p += 16;
    }
  }
  return {
    type: FRAME_EVAL,
    t,
    node: d.getUint32(0, true),
    slot: d.getUint8(4),
    nRaw,
    nExtra,
    nGates,
    pick: d.getUint8(8),
    flags,
    entropy: d.getFloat32(12, true),
    rawMass: d.getFloat32(16, true),
    decodeMs: d.getFloat32(20, true),
    tokens,
    pRaw,
    survivors,
    stageP,
    lens,
  };
}

// Decodes a buffer holding one or more whole frames: a WebSocket message or
// a decompressed session file. Frames of an unknown type are skipped, so new
// types do not break old readers. Throws if the buffer is cut short.
export function decodeFrames(buf: Uint8Array): Frame[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frames: Frame[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < HEADER_SIZE) throw new Error('truncated frame header');
    const type = view.getUint8(pos);
    const length = view.getUint32(pos + 4, true);
    const t = view.getUint32(pos + 8, true);
    const start = pos + HEADER_SIZE;
    if (buf.length - start < length) throw new Error('truncated frame body');
    const body = buf.subarray(start, start + length);
    const d = new DataView(body.buffer, body.byteOffset, body.byteLength);
    switch (type) {
      case FRAME_HELLO:
        frames.push({ type, t, hello: parseJson<Hello>(body) });
        break;
      case FRAME_CONFIG:
        frames.push({ type, t, config: parseJson<Config>(body) });
        break;
      case FRAME_VOCAB:
        frames.push(decodeVocab(d, body, t));
        break;
      case FRAME_NODE:
        frames.push({
          type,
          t,
          id: d.getUint32(0, true),
          parent: d.getUint32(4, true),
          token: d.getUint32(8, true),
          depth: d.getUint32(12, true),
          origin: d.getUint8(16),
        });
        break;
      case FRAME_EVAL:
        frames.push(decodeEval(d, t));
        break;
      case FRAME_PAIR:
        frames.push({
          type,
          t,
          node: d.getUint32(0, true),
          js: d.getFloat32(4, true),
          klAB: d.getFloat32(8, true),
          klBA: d.getFloat32(12, true),
          rankAInB: d.getUint32(16, true),
          rankBInA: d.getUint32(20, true),
          flags: d.getUint8(24),
        });
        break;
      case FRAME_CURSOR:
        frames.push({ type, t, nodeA: d.getUint32(0, true), nodeB: d.getUint32(4, true) });
        break;
      case FRAME_STOP:
        frames.push({ type, t, node: d.getUint32(0, true), slot: d.getUint8(4), reason: d.getUint8(5) });
        break;
      default:
        break; // unknown type: skip `length` bytes
    }
    pos = start + length;
  }
  return frames;
}
