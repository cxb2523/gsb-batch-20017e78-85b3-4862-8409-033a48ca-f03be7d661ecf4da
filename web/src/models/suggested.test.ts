import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseQuant, validRepo } from './hf';
import { MAX_RECENT, pushRecent, readRecents, SUGGESTED } from './suggested';

// A Storage-like map, or one that throws on every access.
function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const s = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  return { data, get: () => s };
}
const throwing = () => ({
  getItem: (): string | null => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: (): void => {
    throw new DOMException('denied', 'QuotaExceededError');
  },
});

describe('suggested pairs', () => {
  it('are the ones `make models` downloads', () => {
    const makefile = readFileSync(resolve(import.meta.dirname, '../../../Makefile'), 'utf8');
    for (const p of SUGGESTED) {
      expect(validRepo(p.repo)).toBe(true);
      expect(makefile).toContain(`${p.repo}/${p.a}`);
      expect(makefile).toContain(`${p.repo}/${p.b}`);
      expect(parseQuant(p.a)).not.toBe(parseQuant(p.b));
      expect(p.size.every((n) => n > 0)).toBe(true);
    }
  });
});

describe('recent pairs', () => {
  it('starts empty and keeps the newest first, once, at most five', () => {
    const m = memory();
    expect(readRecents(m.get)).toEqual([]);
    for (let i = 0; i < 7; i++) pushRecent({ a: `a${i}.gguf`, b: null }, m.get);
    pushRecent({ a: 'a3.gguf', b: null }, m.get);
    const list = readRecents(m.get);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list.map((p) => p.a)).toEqual(['a3.gguf', 'a6.gguf', 'a5.gguf', 'a4.gguf', 'a2.gguf']);
  });

  it('tells pairs apart by both files', () => {
    const m = memory();
    pushRecent({ a: 'x.gguf', b: 'y.gguf' }, m.get);
    pushRecent({ a: 'x.gguf', b: null }, m.get);
    expect(readRecents(m.get)).toEqual([
      { a: 'x.gguf', b: null },
      { a: 'x.gguf', b: 'y.gguf' },
    ]);
  });

  it('ignores what it cannot read', () => {
    expect(readRecents(memory({ 'inside-llm.recentModels': '{not json' }).get)).toEqual([]);
    expect(readRecents(memory({ 'inside-llm.recentModels': '{"a":1}' }).get)).toEqual([]);
    const mixed = JSON.stringify([{ a: 'ok.gguf', b: 7 }, { b: 'x' }, 'str', { a: 'two.gguf', b: 'b.gguf' }]);
    expect(readRecents(memory({ 'inside-llm.recentModels': mixed }).get)).toEqual([
      { a: 'ok.gguf', b: null },
      { a: 'two.gguf', b: 'b.gguf' },
    ]);
  });

  it('works without storage, or with storage that throws', () => {
    expect(readRecents(throwing)).toEqual([]);
    expect(pushRecent({ a: 'x.gguf', b: null }, throwing)).toEqual([{ a: 'x.gguf', b: null }]);
    expect(readRecents(() => null)).toEqual([]);
    expect(pushRecent({ a: 'x.gguf', b: null }, () => null)).toEqual([{ a: 'x.gguf', b: null }]);
    expect(
      readRecents(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toEqual([]);
  });
});
