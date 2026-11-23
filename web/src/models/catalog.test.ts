import { describe, expect, it } from 'vitest';
import type { DownloadEvent, DownloadInfo, ModelFile, ModelsEvent } from '../source/messages';
import {
  applyDownload,
  basename,
  compatible,
  compatibleB,
  ERROR_FAMILY,
  families,
  familyLabel,
  gb,
  pendingBrokenBy,
  pendingStep,
  progress,
  progressText,
  vramFit,
  type PendingLoad,
} from './catalog';

const QWEN = '9f3a51c2e07b44d1';
const GEMMA = '0b7e2d6a11c3f5e8';

function file(name: string, over: Partial<ModelFile> = {}): ModelFile {
  return {
    file: name,
    size: 1e9,
    name: 'Qwen3.5 2B',
    arch: 'qwen35',
    size_label: '2B',
    quant: 'Q8_0',
    n_layer: 24,
    n_vocab: 248320,
    tok: QWEN,
    vram: 1.5e9,
    error: '',
    ...over,
  };
}

const FILES: ModelFile[] = [
  file('Qwen3.5-0.8B-Q8_0.gguf', { name: 'Qwen3.5 0.8B', size_label: '0.8B', vram: 1e9 }),
  file('Qwen3.5-2B-Q8_0.gguf', { vram: 2.6e9 }),
  file('Qwen3.5-2B-UD-Q2_K_XL.gguf', { quant: 'Q2_K', vram: 1.4e9 }),
  file('broken.gguf', { name: '', arch: '', size_label: '', quant: '', tok: '', vram: 0, error: 'bad magic' }),
  file('gemma-4-E4B-it-Q2_K.gguf', { name: 'Gemma 4 E4B It', arch: 'gemma4', tok: GEMMA, vram: 3e9 }),
];

function models(over: Partial<ModelsEvent> = {}): ModelsEvent {
  return {
    ev: 'models',
    dir: 'models',
    files: FILES,
    loaded: { a: null, b: null },
    loading: false,
    n_ctx: 4096,
    gpu: { total: 17e9, available: 14e9 },
    download: true,
    downloads: [],
    ...over,
  };
}

function dl(over: Partial<DownloadEvent> = {}): DownloadEvent {
  return {
    ev: 'download',
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    path: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    state: 'running',
    done: 100,
    total: 1000,
    ...over,
  };
}

describe('families', () => {
  it('groups by tokenizer, in order, with unreadable files last', () => {
    const g = families(FILES);
    expect(g.map((f) => f.key)).toEqual([QWEN, GEMMA, ERROR_FAMILY]);
    expect(g[0].files.map((f) => f.file)).toEqual([
      'Qwen3.5-0.8B-Q8_0.gguf',
      'Qwen3.5-2B-Q8_0.gguf',
      'Qwen3.5-2B-UD-Q2_K_XL.gguf',
    ]);
    expect(g[0].label).toBe('Qwen3.5');
    expect(g[0].arch).toBe('qwen35');
    expect(g[1].label).toBe('Gemma 4 E4B It');
    expect(g[2].files.map((f) => f.file)).toEqual(['broken.gguf']);
  });

  it('labels a family by the words its names share, or the architecture', () => {
    expect(familyLabel([file('x', { name: 'Llama 3 8B' }), file('y', { name: 'Llama 3 70B' })])).toBe('Llama 3');
    expect(familyLabel([file('x', { name: 'Foo' }), file('y', { name: 'Bar', arch: 'llama' })])).toBe('qwen35');
    expect(familyLabel([file('only.gguf', { name: '' })])).toBe('only.gguf');
  });

  it('handles an empty folder', () => {
    expect(families([])).toEqual([]);
  });
});

describe('compatibility', () => {
  it('needs the same fingerprint and readable headers', () => {
    expect(compatible(FILES[0], FILES[1])).toBe(true);
    expect(compatible(FILES[0], FILES[4])).toBe(false);
    expect(compatible(FILES[3], FILES[3])).toBe(false);
    expect(compatible(undefined, FILES[0])).toBe(false);
  });

  it('lists the files that can be B', () => {
    expect(compatibleB(FILES, 'Qwen3.5-2B-Q8_0.gguf').map((f) => f.file)).toEqual([
      'Qwen3.5-0.8B-Q8_0.gguf',
      'Qwen3.5-2B-Q8_0.gguf',
      'Qwen3.5-2B-UD-Q2_K_XL.gguf',
    ]);
    expect(compatibleB(FILES, 'gemma-4-E4B-it-Q2_K.gguf').map((f) => f.file)).toEqual(['gemma-4-E4B-it-Q2_K.gguf']);
    expect(compatibleB(FILES, null)).toEqual([]);
    expect(compatibleB(FILES, 'broken.gguf')).toEqual([]);
  });
});

describe('vramFit', () => {
  const gpu = { total: 17e9, available: 4e9 };

  it('adds A and B against the available memory', () => {
    expect(vramFit(FILES, 'Qwen3.5-2B-Q8_0.gguf', null, gpu)).toMatchObject({ need: 2.6e9, state: 'ok' });
    const two = vramFit(FILES, 'Qwen3.5-2B-Q8_0.gguf', 'Qwen3.5-2B-UD-Q2_K_XL.gguf', gpu);
    expect(two.need).toBeCloseTo(4e9);
    expect(two.state).toBe('ok');
    const over = vramFit(FILES, 'Qwen3.5-2B-Q8_0.gguf', 'gemma-4-E4B-it-Q2_K.gguf', gpu);
    expect(over.state).toBe('over');
    expect(over.ratio).toBeGreaterThan(1);
  });

  it('is unknown without a dedicated GPU or without A', () => {
    expect(vramFit(FILES, 'Qwen3.5-2B-Q8_0.gguf', null, { total: 0, available: 0 })).toMatchObject({
      state: 'unknown',
      ratio: 0,
    });
    expect(vramFit(FILES, null, null, gpu).state).toBe('unknown');
  });

  it('counts a file outside the folder as 0', () => {
    expect(vramFit(FILES, 'elsewhere.gguf', null, gpu)).toMatchObject({ need: 0, state: 'ok' });
  });
});

describe('sizes and progress', () => {
  it('formats sizes', () => {
    expect(gb(0)).toBe('0 MB');
    expect(gb(400_000)).toBe('1 MB');
    expect(gb(811_843_840)).toBe('812 MB');
    expect(gb(2_012_012_800)).toBe('2.01 GB');
    expect(gb(17_094_000_000)).toBe('17.1 GB');
  });

  it('gives the fraction, or null while the total is unknown', () => {
    expect(progress({ done: 250, total: 1000 })).toBe(0.25);
    expect(progress({ done: 2000, total: 1000 })).toBe(1);
    expect(progress({ done: 10, total: 0 })).toBeNull();
    expect(progressText({ done: 312e6, total: 812e6, state: 'running' })).toBe('312 MB of 812 MB · 38%');
    expect(progressText({ done: 5e6, total: 0, state: 'running' })).toBe('5 MB');
    expect(progressText({ done: 0, total: 0, state: 'queued' })).toBe('queued');
  });

  it('takes the base name of a repo path', () => {
    expect(basename('Q4_K_M/x.gguf')).toBe('x.gguf');
    expect(basename('x.gguf')).toBe('x.gguf');
  });
});

describe('applyDownload', () => {
  const queue: DownloadInfo[] = [
    { repo: 'r/one', path: 'a.gguf', file: 'a.gguf', state: 'running', done: 1, total: 10 },
    { repo: 'r/one', path: 'b.gguf', file: 'b.gguf', state: 'queued', done: 0, total: 0 },
  ];

  it('updates a download in place', () => {
    const next = applyDownload(queue, dl({ repo: 'r/one', path: 'a.gguf', file: 'a.gguf', done: 5, total: 10 }));
    expect(next.map((d) => [d.file, d.done])).toEqual([
      ['a.gguf', 5],
      ['b.gguf', 0],
    ]);
    expect(next[0]).not.toHaveProperty('ev');
  });

  it('adds a new one at the end', () => {
    const next = applyDownload(queue, dl({ state: 'queued' }));
    expect(next.map((d) => d.file)).toEqual(['a.gguf', 'b.gguf', 'Qwen3.5-0.8B-Q4_K_M.gguf']);
  });

  it('removes finished, cancelled and failed ones', () => {
    for (const state of ['done', 'cancelled', 'error'] as const) {
      const next = applyDownload(queue, dl({ repo: 'r/one', path: 'a.gguf', file: 'a.gguf', state }));
      expect(next.map((d) => d.file)).toEqual(['b.gguf']);
    }
    expect(applyDownload(queue, dl({ state: 'done' }))).toEqual(queue);
  });
});

describe('pending load', () => {
  const pair: PendingLoad = {
    a: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    b: 'Qwen3.5-0.8B-Q8_0.gguf',
    sources: [{ repo: 'unsloth/Qwen3.5-0.8B-GGUF', path: 'Qwen3.5-0.8B-Q4_K_M.gguf' }],
  };
  const fetched = file('Qwen3.5-0.8B-Q4_K_M.gguf', { name: 'Qwen3.5 0.8B', quant: 'Q4_K_M' });

  it('waits while a file is missing or still downloading', () => {
    expect(pendingStep(pair, models())).toEqual({ kind: 'wait' });
    const downloading: DownloadInfo = { ...dl(), state: 'running' };
    expect(pendingStep(pair, models({ files: [...FILES, fetched], downloads: [downloading] }))).toEqual({ kind: 'wait' });
  });

  it('loads once both are in the folder', () => {
    expect(pendingStep(pair, models({ files: [...FILES, fetched] }))).toEqual({
      kind: 'load',
      a: 'Qwen3.5-0.8B-Q4_K_M.gguf',
      b: 'Qwen3.5-0.8B-Q8_0.gguf',
    });
    expect(pendingStep({ a: 'Qwen3.5-2B-Q8_0.gguf', b: null, sources: [] }, models())).toEqual({
      kind: 'load',
      a: 'Qwen3.5-2B-Q8_0.gguf',
      b: null,
    });
  });

  it('waits for a load in progress', () => {
    expect(pendingStep(pair, models({ files: [...FILES, fetched], loading: true }))).toEqual({ kind: 'wait' });
  });

  it('fails when the fingerprints differ, whatever the repo says', () => {
    const odd = { ...fetched, tok: GEMMA };
    const step = pendingStep(pair, models({ files: [...FILES, odd] }));
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') expect(step.msg).toMatch(/different tokenizers/);
  });

  it('fails when a file cannot be read', () => {
    const bad = { ...fetched, tok: '', error: 'truncated' };
    const step = pendingStep(pair, models({ files: [...FILES, bad] }));
    expect(step).toEqual({ kind: 'fail', msg: 'Qwen3.5-0.8B-Q4_K_M.gguf cannot be read: truncated' });
  });

  it('breaks when one of its downloads is cancelled or fails', () => {
    expect(pendingBrokenBy(pair, dl({ state: 'error', msg: 'HTTP 404' }))).toBe(true);
    expect(pendingBrokenBy(pair, dl({ state: 'cancelled' }))).toBe(true);
    expect(pendingBrokenBy(pair, dl({ state: 'done' }))).toBe(false);
    expect(pendingBrokenBy(pair, dl({ state: 'error', path: 'other.gguf' }))).toBe(false);
  });
});
