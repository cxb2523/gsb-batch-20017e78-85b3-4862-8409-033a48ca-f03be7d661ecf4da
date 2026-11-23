import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_HELLO } from './source/frames';
import { decodeSession } from './source/recorded';
import { bootMode, fileSize, loadIndex, parseIndex, sessionHref, STATIC } from './gallery';

const SESSIONS = resolve(import.meta.dirname, '../../sessions');

const good = {
  file: 'samples/a.ils',
  title: 'A title',
  models: ['Model A', 'Model B'],
  description: 'What it shows.',
};

describe('bootMode', () => {
  it('replays ?session= in both builds', () => {
    expect(bootMode('?session=sessions/x.ils', false)).toEqual({ mode: 'replay', session: 'sessions/x.ils' });
    expect(bootMode('?debug&session=sessions/x.ils', true)).toEqual({ mode: 'replay', session: 'sessions/x.ils' });
  });

  it('goes live without ?session= in the embedded build', () => {
    expect(bootMode('', false)).toEqual({ mode: 'live' });
    expect(bootMode('?debug', false)).toEqual({ mode: 'live' });
  });

  it('shows the gallery without ?session= in the static build', () => {
    expect(bootMode('', true)).toEqual({ mode: 'gallery' });
    expect(bootMode('?debug', true)).toEqual({ mode: 'gallery' });
  });

  it('is not the static build under test', () => {
    expect(STATIC).toBe(false);
  });
});

describe('parseIndex', () => {
  it('accepts valid entries and keeps the size', () => {
    expect(parseIndex([good, { ...good, models: ['Only A'], size: 1234 }])).toEqual([
      good,
      { ...good, models: ['Only A'], size: 1234 },
    ]);
    expect(parseIndex([])).toEqual([]);
  });

  it('rejects what is not a list of entries', () => {
    expect(() => parseIndex({})).toThrow(/array/);
    expect(() => parseIndex([null])).toThrow(/entry 0/);
    expect(() => parseIndex(['x'])).toThrow(/entry 0/);
  });

  it('rejects missing or empty fields', () => {
    for (const key of ['file', 'title', 'description'] as const) {
      expect(() => parseIndex([{ ...good, [key]: undefined }])).toThrow(key);
      expect(() => parseIndex([{ ...good, [key]: ' ' }])).toThrow(key);
    }
    expect(() => parseIndex([{ ...good, models: [] }])).toThrow(/models/);
    expect(() => parseIndex([{ ...good, models: ['a', 'b', 'c'] }])).toThrow(/models/);
    expect(() => parseIndex([{ ...good, models: ['a', 3] }])).toThrow(/models/);
    expect(() => parseIndex([{ ...good, size: -1 }])).toThrow(/size/);
    expect(() => parseIndex([{ ...good, size: '10' }])).toThrow(/size/);
  });

  it('rejects file paths outside sessions/ or not .ils', () => {
    for (const file of [
      '../x.ils',
      'a/../../x.ils',
      '/abs.ils',
      'https://example.org/x.ils',
      'x.json',
      'a\\b.ils',
      'x.ils?y=1',
      './x.ils',
    ]) {
      expect(() => parseIndex([{ ...good, file }]), file).toThrow(/file/);
    }
  });

  it('formats sizes', () => {
    expect(fileSize(98014)).toBe('98 kB');
    expect(fileSize(200)).toBe('1 kB');
    expect(fileSize(739578)).toBe('740 kB');
    expect(fileSize(1_450_000)).toBe('1.4 MB');
  });

  it('links each entry to its replay', () => {
    expect(sessionHref(good)).toBe('?session=sessions/samples/a.ils');
  });
});

describe('loadIndex', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports HTTP errors and bad JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(loadIndex('i.json')).rejects.toThrow(/HTTP 404/);
    vi.stubGlobal('fetch', async () => new Response('{oops', { status: 200 }));
    await expect(loadIndex('i.json')).rejects.toThrow(/not valid JSON/);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await expect(loadIndex('i.json')).rejects.toThrow(/offline/);
  });

  it('returns the validated list', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([good])));
    await expect(loadIndex('i.json')).resolves.toEqual([good]);
  });
});

// The published gallery: every entry is valid, its file exists, is a session
// its size is right and it holds the models it names.
describe('sessions/index.json', () => {
  const entries = parseIndex(JSON.parse(readFileSync(resolve(SESSIONS, 'index.json'), 'utf8')));

  it('lists the sessions', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries.map((e) => [e.file, e] as const))('%s is a session of the declared size', async (_, e) => {
    const path = resolve(SESSIONS, e.file);
    if (e.size !== undefined) expect(statSync(path).size).toBe(e.size);
    const frames = await decodeSession(new Uint8Array(readFileSync(path)));
    const first = frames[0];
    if (first.type !== FRAME_HELLO) throw new Error('no HELLO');
    expect(first.hello.models.map((m) => `${m.name} ${m.quant}`)).toEqual(e.models);
  });
});
