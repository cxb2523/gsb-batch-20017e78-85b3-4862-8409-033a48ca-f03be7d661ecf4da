// The draft of the gate panel: one row for each of the six gate types, each
// with its own switch and parameters. The rows that are on, in order, are the
// chain the engine gets (`config` command, `gates`). Pure functions: the
// panel keeps the draft and sends what `gatesToSend` gives.

import type { Gate, GateType } from '../source/frames';

export interface DraftRow {
  enabled: boolean;
  gate: Gate;
}

export type GateDraft = DraftRow[];

// The default order of the rows.
export const GATE_TYPES: readonly GateType[] = ['grammar', 'penalties', 'top_k', 'top_p', 'min_p', 'temp'];

export const GATE_LABELS: Record<GateType, string> = {
  grammar: 'grammar',
  penalties: 'penalties',
  top_k: 'top-k',
  top_p: 'top-p',
  min_p: 'min-p',
  temp: 'temp',
};

// The slider of one numeric parameter.
export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  int: boolean;
}

export type NumericGateType = Exclude<GateType, 'grammar'>;

export const PARAMS: Record<NumericGateType, readonly ParamSpec[]> = {
  penalties: [
    { key: 'last_n', label: 'last n', min: 0, max: 1024, step: 1, int: true },
    { key: 'repeat', label: 'repeat', min: 1, max: 2, step: 0.01, int: false },
    { key: 'frequency', label: 'frequency', min: 0, max: 2, step: 0.01, int: false },
    { key: 'presence', label: 'presence', min: 0, max: 2, step: 0.01, int: false },
  ],
  top_k: [{ key: 'k', label: 'k', min: 1, max: 200, step: 1, int: true }],
  top_p: [{ key: 'p', label: 'p', min: 0.01, max: 1, step: 0.01, int: false }],
  min_p: [{ key: 'p', label: 'p', min: 0, max: 1, step: 0.01, int: false }],
  temp: [{ key: 't', label: 't', min: 0, max: 2, step: 0.01, int: false }],
};

export const SEED_MAX = 4294967295;

// A gate of `type` with the parameters of a row that is off.
export function defaultGate(type: GateType): Gate {
  switch (type) {
    case 'grammar':
      return { type, gbnf: '' };
    case 'penalties':
      return { type, last_n: 64, repeat: 1.1, frequency: 0, presence: 0 };
    case 'top_k':
      return { type, k: 40 };
    case 'top_p':
      return { type, p: 0.95 };
    case 'min_p':
      return { type, p: 0.05 };
    case 'temp':
      return { type, t: 0.8 };
  }
}

export function defaultDraft(): GateDraft {
  return GATE_TYPES.map((type) => ({ enabled: false, gate: defaultGate(type) }));
}

function isGateType(t: unknown): t is GateType {
  return typeof t === 'string' && (GATE_TYPES as readonly string[]).includes(t);
}

// A gate of a CONFIG, read defensively: a known type, its parameters where
// they are of the right kind and `fallback`'s otherwise. Null for an unknown
// type.
function readGate(g: unknown, fallback: (type: GateType) => Gate): Gate | null {
  if (typeof g !== 'object' || g === null) return null;
  const src = g as Record<string, unknown>;
  if (!isGateType(src.type)) return null;
  const base = fallback(src.type) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    if (key === 'type') continue;
    const v = src[key];
    if (typeof v === typeof base[key] && (typeof v !== 'number' || Number.isFinite(v))) out[key] = v;
  }
  return out as Gate;
}

// The draft for the chain of a CONFIG: its gates on and in their order, then
// the types it lacks, off, with the parameters and relative order they had in
// `prev`. Only the first gate of each known type counts; repeats and unknown
// types are left out.
export function draftFromConfig(gates: readonly unknown[], prev: GateDraft = defaultDraft()): GateDraft {
  const prevOf = (type: GateType): Gate => prev.find((r) => r.gate.type === type)?.gate ?? defaultGate(type);
  const seen = new Set<GateType>();
  const rows: GateDraft = [];
  for (const g of gates) {
    const gate = readGate(g, prevOf);
    if (gate === null || seen.has(gate.type)) continue;
    seen.add(gate.type);
    rows.push({ enabled: true, gate });
  }
  // The rest: those of `prev` in its order, then any type `prev` lacked.
  const rest = [...prev.map((r) => r.gate.type), ...GATE_TYPES];
  for (const type of rest) {
    if (seen.has(type)) continue;
    seen.add(type);
    rows.push({ enabled: false, gate: { ...prevOf(type) } });
  }
  return rows;
}

// The chain to send: the rows that are on, in order. A grammar without text
// is not sent.
export function gatesToSend(draft: GateDraft): Gate[] {
  return draft
    .filter((r) => r.enabled && !(r.gate.type === 'grammar' && r.gate.gbnf.trim() === ''))
    .map((r) => ({ ...r.gate }));
}

// The gates that cut the tail of the distribution off.
const TRUNCATING: readonly GateType[] = ['top_k', 'top_p', 'min_p'];
// What is switched on with them: llama.cpp's default chain.
const STANDARD: readonly GateType[] = ['top_k', 'top_p', 'min_p', 'temp'];

// The draft with row `index` switched on or off. Switching on penalties or a
// temperature when no gate cuts the tail would make the final draw run over
// the whole vocabulary (the draw samples whatever the last gate leaves): a
// weak model then picks near-zero tokens from the tail. In that case top-k,
// top-p, min-p and temp are switched on too, with their rows' parameters.
// `added` lists them.
export function toggleRow(draft: GateDraft, index: number, on: boolean): { draft: GateDraft; added: GateType[] } {
  const row = draft[index];
  if (row === undefined) return { draft: draft.slice(), added: [] };
  let next = setRow(draft, index, { ...row, enabled: on });
  const type = row.gate.type;
  const cuts = draft.some((r) => r.enabled && TRUNCATING.includes(r.gate.type));
  if (!on || cuts || (type !== 'penalties' && type !== 'temp')) return { draft: next, added: [] };
  if (type === 'temp' && row.gate.t === 0) return { draft: next, added: [] }; // greedy: nothing to draw
  const added: GateType[] = [];
  next = next.map((r) => {
    if (r.enabled || !STANDARD.includes(r.gate.type)) return r;
    added.push(r.gate.type);
    return { ...r, enabled: true };
  });
  return { draft: next, added };
}

// The draft with row `index` moved one place up (-1) or down (+1). Out of
// range, an unchanged copy.
export function moveRow(draft: GateDraft, index: number, delta: -1 | 1): GateDraft {
  const out = draft.slice();
  const to = index + delta;
  if (index < 0 || index >= out.length || to < 0 || to >= out.length) return out;
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

// The draft with one row replaced.
export function setRow(draft: GateDraft, index: number, row: DraftRow): GateDraft {
  return draft.map((r, i) => (i === index ? row : r));
}

// Whether two chains are the same, parameters included.
export function sameGates(a: readonly Gate[], b: readonly Gate[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A short text for a chain: "top-k 40 ▸ temp 0.80", or "none".
export function chainText(gates: readonly Gate[]): string {
  if (gates.length === 0) return 'none';
  return gates.map(gateText).join(' ▸ ');
}

function gateText(g: Gate): string {
  const type = (g as { type: unknown }).type;
  if (!isGateType(type)) return String(type);
  if (g.type === 'grammar') return 'grammar';
  const params = PARAMS[g.type as NumericGateType]
    .map((p) => formatParam(p, (g as unknown as Record<string, number>)[p.key]))
    .join(' ');
  return `${GATE_LABELS[g.type]} ${params}`;
}

export function formatParam(p: ParamSpec, v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return p.int ? String(Math.round(v)) : v.toFixed(2);
}
