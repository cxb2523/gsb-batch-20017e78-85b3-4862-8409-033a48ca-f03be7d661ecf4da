import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Gate } from '../source/frames';
import {
  chainText,
  defaultDraft,
  draftFromConfig,
  GATE_TYPES,
  gatesToSend,
  moveRow,
  sameGates,
  toggleRow,
  type DraftRow,
  type GateDraft,
} from './gate-draft';
import { JSON_GRAMMAR } from './json-grammar';

const types = (d: GateDraft): string[] => d.map((r) => r.gate.type);
const enabled = (d: GateDraft): boolean[] => d.map((r) => r.enabled);

describe('default draft', () => {
  it('has one row per type, all off, in the default order with the default parameters', () => {
    expect(defaultDraft()).toEqual([
      { enabled: false, gate: { type: 'grammar', gbnf: '' } },
      { enabled: false, gate: { type: 'penalties', last_n: 64, repeat: 1.1, frequency: 0, presence: 0 } },
      { enabled: false, gate: { type: 'top_k', k: 40 } },
      { enabled: false, gate: { type: 'top_p', p: 0.95 } },
      { enabled: false, gate: { type: 'min_p', p: 0.05 } },
      { enabled: false, gate: { type: 'temp', t: 0.8 } },
    ]);
    expect(GATE_TYPES).toEqual(types(defaultDraft()));
  });

  it('sends nothing', () => {
    expect(gatesToSend(defaultDraft())).toEqual([]);
  });
});

describe('draft from a CONFIG', () => {
  it('puts the CONFIG gates first, on and in order, then the rest off in the default order', () => {
    const gates: Gate[] = [
      { type: 'temp', t: 0.5 },
      { type: 'top_k', k: 7 },
    ];
    const d = draftFromConfig(gates);
    expect(types(d)).toEqual(['temp', 'top_k', 'grammar', 'penalties', 'top_p', 'min_p']);
    expect(enabled(d)).toEqual([true, true, false, false, false, false]);
    expect(d[0].gate).toEqual({ type: 'temp', t: 0.5 });
    expect(d[1].gate).toEqual({ type: 'top_k', k: 7 });
    expect(gatesToSend(d)).toEqual(gates);
  });

  it('keeps the parameters and relative order of the rows the CONFIG lacks', () => {
    let prev = defaultDraft();
    prev = moveRow(prev, 5, -1); // temp above min_p
    prev = prev.map((r): DraftRow => {
      if (r.gate.type === 'min_p') return { ...r, gate: { type: 'min_p', p: 0.2 } };
      if (r.gate.type === 'grammar') return { ...r, gate: { type: 'grammar', gbnf: 'root ::= "a"' } };
      return r;
    });
    const d = draftFromConfig([{ type: 'top_p', p: 0.5 }], prev);
    expect(types(d)).toEqual(['top_p', 'grammar', 'penalties', 'top_k', 'temp', 'min_p']);
    expect(enabled(d)).toEqual([true, false, false, false, false, false]);
    expect(d[0].gate).toEqual({ type: 'top_p', p: 0.5 });
    expect(d[1].gate).toEqual({ type: 'grammar', gbnf: 'root ::= "a"' });
    expect(d[5].gate).toEqual({ type: 'min_p', p: 0.2 });
  });

  it('an empty chain turns every row off and keeps the draft as it was', () => {
    const prev = draftFromConfig([{ type: 'top_k', k: 3 }, { type: 'temp', t: 1.5 }]);
    const d = draftFromConfig([], prev);
    expect(types(d)).toEqual(types(prev));
    expect(enabled(d)).toEqual([false, false, false, false, false, false]);
    expect(d[0].gate).toEqual({ type: 'top_k', k: 3 });
    expect(d[1].gate).toEqual({ type: 'temp', t: 1.5 });
  });

  it('counts the first gate of each type and leaves out repeats and unknown types', () => {
    const gates = [
      { type: 'top_k', k: 5 },
      { type: 'dry', multiplier: 0.8 },
      { type: 'top_k', k: 9 },
      { type: 'temp', t: 0 },
      { type: 'temp', t: 2 },
      { nothing: 1 },
      null,
    ];
    const d = draftFromConfig(gates);
    expect(types(d)).toEqual(['top_k', 'temp', 'grammar', 'penalties', 'top_p', 'min_p']);
    expect(gatesToSend(d)).toEqual([
      { type: 'top_k', k: 5 },
      { type: 'temp', t: 0 },
    ]);
  });

  it('fills a missing or ill-typed parameter from the previous draft', () => {
    const prev = draftFromConfig([{ type: 'penalties', last_n: 32, repeat: 1.3, frequency: 0.5, presence: 0.25 }]);
    const d = draftFromConfig([{ type: 'penalties', last_n: 16, repeat: 'x' }, { type: 'grammar' }], prev);
    expect(d[0].gate).toEqual({ type: 'penalties', last_n: 16, repeat: 1.3, frequency: 0.5, presence: 0.25 });
    expect(d[1].gate).toEqual({ type: 'grammar', gbnf: '' });
    // Extra fields of the CONFIG do not leak into the draft.
    const e = draftFromConfig([{ type: 'top_k', k: 3, extra: true }]);
    expect(e[0].gate).toEqual({ type: 'top_k', k: 3 });
  });
});

describe('gates to send', () => {
  it('are the rows that are on, in order', () => {
    let d = defaultDraft();
    d = d.map((r): DraftRow => (r.gate.type === 'temp' || r.gate.type === 'top_k' ? { ...r, enabled: true } : r));
    d = moveRow(d, 5, -1);
    d = moveRow(d, 4, -1);
    d = moveRow(d, 3, -1);
    expect(gatesToSend(d)).toEqual([
      { type: 'temp', t: 0.8 },
      { type: 'top_k', k: 40 },
    ]);
  });

  it('leave out a grammar that is on but has no text', () => {
    const on = (gbnf: string): GateDraft =>
      defaultDraft().map((r): DraftRow => (r.gate.type === 'grammar' ? { enabled: true, gate: { type: 'grammar', gbnf } } : r));
    expect(gatesToSend(on(''))).toEqual([]);
    expect(gatesToSend(on('  \n'))).toEqual([]);
    expect(gatesToSend(on('root ::= "a"'))).toEqual([{ type: 'grammar', gbnf: 'root ::= "a"' }]);
  });

  it('are copies: changing them leaves the draft alone', () => {
    const d = draftFromConfig([{ type: 'top_k', k: 3 }]);
    const g = gatesToSend(d);
    (g[0] as { k: number }).k = 99;
    expect(d[0].gate).toEqual({ type: 'top_k', k: 3 });
  });
});

describe('moving a row', () => {
  it('swaps it with its neighbour', () => {
    const d = defaultDraft();
    expect(types(moveRow(d, 2, -1))).toEqual(['grammar', 'top_k', 'penalties', 'top_p', 'min_p', 'temp']);
    expect(types(moveRow(d, 2, 1))).toEqual(['grammar', 'penalties', 'top_p', 'top_k', 'min_p', 'temp']);
    expect(types(d)).toEqual(GATE_TYPES); // untouched
  });

  it('does nothing past either end', () => {
    const d = defaultDraft();
    expect(moveRow(d, 0, -1)).toEqual(d);
    expect(moveRow(d, 5, 1)).toEqual(d);
    expect(moveRow(d, 9, -1)).toEqual(d);
  });
});

describe('chain text and comparison', () => {
  it('describes a chain', () => {
    expect(chainText([])).toBe('none');
    expect(
      chainText([
        { type: 'grammar', gbnf: 'root ::= "a"' },
        { type: 'top_k', k: 40 },
        { type: 'temp', t: 0.8 },
      ]),
    ).toBe('grammar ▸ top-k 40 ▸ temp 0.80');
  });

  it('compares chains with their parameters', () => {
    expect(sameGates([{ type: 'top_k', k: 3 }], [{ type: 'top_k', k: 3 }])).toBe(true);
    expect(sameGates([{ type: 'top_k', k: 3 }], [{ type: 'top_k', k: 4 }])).toBe(false);
    expect(sameGates([], [{ type: 'top_k', k: 4 }])).toBe(false);
  });
});

describe('JSON grammar', () => {
  it('is the llama.cpp file, with a root rule', () => {
    const file = readFileSync(resolve(import.meta.dirname, '../../../third_party/llama.cpp/grammars/json.gbnf'), 'utf8');
    expect(JSON_GRAMMAR).toBe(file);
    expect(JSON_GRAMMAR).toMatch(/^root\s+::=/m);
  });
});

describe('switching a row', () => {
  const on = (d: GateDraft) => d.filter((r) => r.enabled).map((r) => r.gate.type);
  const at = (d: GateDraft, type: string) => d.findIndex((r) => r.gate.type === type);

  it('brings the standard cut-offs with penalties alone', () => {
    const d = defaultDraft();
    const { draft, added } = toggleRow(d, at(d, 'penalties'), true);
    expect(on(draft)).toEqual(['penalties', 'top_k', 'top_p', 'min_p', 'temp']);
    expect(added).toEqual(['top_k', 'top_p', 'min_p', 'temp']);
    expect(gatesToSend(draft)[1]).toEqual({ type: 'top_k', k: 40 });
  });

  it('brings them with a temperature alone, not with temp 0', () => {
    const d = defaultDraft();
    expect(on(toggleRow(d, at(d, 'temp'), true).draft)).toEqual(['top_k', 'top_p', 'min_p', 'temp']);
    const t0 = d.map((r) => (r.gate.type === 'temp' ? { ...r, gate: { type: 'temp' as const, t: 0 } } : r));
    expect(on(toggleRow(t0, at(t0, 'temp'), true).draft)).toEqual(['temp']);
  });

  it('leaves the chain alone when something already cuts the tail', () => {
    let d = defaultDraft();
    d = toggleRow(d, at(d, 'min_p'), true).draft;
    const { draft, added } = toggleRow(d, at(d, 'penalties'), true);
    expect(on(draft)).toEqual(['penalties', 'min_p']);
    expect(added).toEqual([]);
  });

  it('switches off only the row', () => {
    const d = toggleRow(defaultDraft(), 1, true).draft; // penalties and the standard ones
    expect(on(toggleRow(d, at(d, 'penalties'), false).draft)).toEqual(['top_k', 'top_p', 'min_p', 'temp']);
  });

  it('keeps the parameters of the rows it switches on', () => {
    const d = defaultDraft().map((r) => (r.gate.type === 'top_k' ? { ...r, gate: { type: 'top_k' as const, k: 7 } } : r));
    expect(gatesToSend(toggleRow(d, at(d, 'penalties'), true).draft)[1]).toEqual({ type: 'top_k', k: 7 });
  });
});
