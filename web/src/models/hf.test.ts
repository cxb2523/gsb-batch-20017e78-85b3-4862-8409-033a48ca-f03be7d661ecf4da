import { describe, expect, it, vi } from 'vitest';
import {
  day,
  HfError,
  isAbort,
  isAuxiliary,
  isSplitPart,
  parseQuant,
  parseSearch,
  parseTree,
  repoFiles,
  searchRepos,
  searchUrl,
  shortCount,
  treeUrl,
  validRepo,
} from './hf';

// Shapes as the hub answers them (trimmed): search with expand[], and the
// recursive tree of a repo.
const SEARCH = [
  { _id: '69a44f6bbd54b442c759e17f', id: 'unsloth/Qwen3.5-0.8B-GGUF', lastModified: '2026-03-02T14:08:04.000Z', likes: 252, downloads: 342802 },
  { _id: '69f05263f4807a980a74f2d9', id: 'ggml-org/Qwen3.5-0.8B-GGUF', likes: 27, downloads: 55836, createdAt: '2026-04-28T06:23:31.000Z' },
  { _id: 'x', id: 'not a repo', likes: 1, downloads: 1 },
  null,
];

const lfs = (size: number) => ({ oid: 'ab', size, pointerSize: 134 });
const TREE = [
  { type: 'file', oid: '6b', size: 3104, path: '.gitattributes' },
  { type: 'file', oid: '5d', size: 1516744736, lfs: lfs(1516744736), path: 'Qwen3.5-0.8B-BF16.gguf' },
  { type: 'file', oid: '0d', size: 811843840, lfs: lfs(811843840), path: 'Qwen3.5-0.8B-Q8_0.gguf' },
  { type: 'file', oid: '8c', size: 417718528, lfs: lfs(417718528), path: 'Qwen3.5-0.8B-UD-Q2_K_XL.gguf' },
  { type: 'file', oid: '1a', size: 338227456, lfs: lfs(338227456), path: 'Qwen3.5-0.8B-UD-IQ2_XXS.gguf' },
  { type: 'file', oid: '2b', size: 62950, path: 'README.md' },
  { type: 'file', oid: '3c', size: 1134720, lfs: lfs(1134720), path: 'imatrix_unsloth.gguf_file' },
  { type: 'file', oid: '4d', size: 207346528, lfs: lfs(207346528), path: 'mmproj-BF16.gguf' },
  { type: 'directory', oid: '5e', size: 0, path: 'Q4_K_M' },
  { type: 'file', oid: '6f', size: 9e9, lfs: lfs(9e9), path: 'Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf' },
  { type: 'file', oid: '70', size: 8e9, lfs: lfs(8e9), path: 'Q4_K_M/Big-Q4_K_M-00002-of-00002.gguf' },
  { type: 'file', oid: '81', size: 135, lfs: lfs(532517120), path: 'sub/Qwen3.5-0.8B-Q4_K_M.gguf' },
];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('names', () => {
  it('reads the quantization from a file name', () => {
    const cases: [string, string][] = [
      ['Qwen3.5-2B-Q8_0.gguf', 'Q8_0'],
      ['Qwen_Qwen3.5-4B-Q2_K.gguf', 'Q2_K'],
      ['Qwen3.5-0.8B-Q4_K_M.gguf', 'Q4_K_M'],
      ['Qwen3.5-2B-UD-Q2_K_XL.gguf', 'UD-Q2_K_XL'],
      ['Qwen3.5-0.8B-UD-IQ2_XXS.gguf', 'UD-IQ2_XXS'],
      ['Qwen3.5-0.8B-IQ4_NL.gguf', 'IQ4_NL'],
      ['Qwen3.5-0.8B-BF16.gguf', 'BF16'],
      ['model-f16.gguf', 'F16'],
      ['model.Q4_1.gguf', 'Q4_1'],
      ['folder/llama-3-8b-instruct.q5_k_s.gguf', 'Q5_K_S'],
      ['gpt-oss-20b-MXFP4.gguf', 'MXFP4'],
      ['Qwen3.5-0.8B.gguf', ''],
    ];
    for (const [name, quant] of cases) expect(parseQuant(name), name).toBe(quant);
  });

  it('spots split parts and auxiliary files', () => {
    expect(isSplitPart('Big-Q4_K_M-00001-of-00002.gguf')).toBe(true);
    expect(isSplitPart('Big-Q4_K_M.gguf')).toBe(false);
    expect(isAuxiliary('mmproj-F16.gguf')).toBe(true);
    expect(isAuxiliary('vision/Model-mmproj.gguf')).toBe(true);
    expect(isAuxiliary('imatrix.gguf')).toBe(true);
    expect(isAuxiliary('Qwen3.5-2B-Q8_0.gguf')).toBe(false);
  });

  it('accepts user/name repos only', () => {
    expect(validRepo('unsloth/Qwen3.5-0.8B-GGUF')).toBe(true);
    expect(validRepo('unsloth')).toBe(false);
    expect(validRepo('a/b/c')).toBe(false);
    expect(validRepo('../x')).toBe(false);
    expect(validRepo('a/b c')).toBe(false);
  });

  it('formats counts and dates', () => {
    expect(shortCount(342802)).toBe('343k');
    expect(shortCount(5583)).toBe('5.6k');
    expect(shortCount(1_250_000)).toBe('1.3M');
    expect(shortCount(27)).toBe('27');
    expect(day('2026-03-02T14:08:04.000Z')).toBe('2026-03-02');
    expect(day('')).toBe('');
  });
});

describe('URLs', () => {
  it('asks for GGUF repos by downloads, with the fields the list shows', () => {
    const u = new URL(searchUrl(' qwen 3.5 '));
    expect(u.origin + u.pathname).toBe('https://huggingface.co/api/models');
    expect(u.searchParams.get('search')).toBe('qwen 3.5');
    expect(u.searchParams.get('filter')).toBe('gguf');
    expect(u.searchParams.get('sort')).toBe('downloads');
    expect(u.searchParams.get('direction')).toBe('-1');
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.getAll('expand[]')).toEqual(['downloads', 'likes', 'lastModified']);
  });

  it('lists the whole tree of a repo', () => {
    expect(treeUrl('unsloth/Qwen3.5-0.8B-GGUF')).toBe(
      'https://huggingface.co/api/models/unsloth/Qwen3.5-0.8B-GGUF/tree/main?recursive=true',
    );
  });
});

describe('parsing', () => {
  it('keeps valid repos, with the date it has', () => {
    expect(parseSearch(SEARCH)).toEqual([
      { id: 'unsloth/Qwen3.5-0.8B-GGUF', downloads: 342802, likes: 252, updated: '2026-03-02T14:08:04.000Z' },
      { id: 'ggml-org/Qwen3.5-0.8B-GGUF', downloads: 55836, likes: 27, updated: '2026-04-28T06:23:31.000Z' },
    ]);
    expect(() => parseSearch({ error: 'x' })).toThrow(HfError);
  });

  it('keeps single-file models, smallest first, with folders and LFS sizes', () => {
    const t = parseTree(TREE);
    expect(t.split).toBe(2);
    expect(t.files.map((f) => [f.path, f.quant, f.size])).toEqual([
      ['Qwen3.5-0.8B-UD-IQ2_XXS.gguf', 'UD-IQ2_XXS', 338227456],
      ['Qwen3.5-0.8B-UD-Q2_K_XL.gguf', 'UD-Q2_K_XL', 417718528],
      ['sub/Qwen3.5-0.8B-Q4_K_M.gguf', 'Q4_K_M', 532517120],
      ['Qwen3.5-0.8B-Q8_0.gguf', 'Q8_0', 811843840],
      ['Qwen3.5-0.8B-BF16.gguf', 'BF16', 1516744736],
    ]);
    const sub = t.files[2];
    expect(sub.file).toBe('Qwen3.5-0.8B-Q4_K_M.gguf');
    expect(sub.folder).toBe('sub');
    expect(t.files[0].folder).toBe('');
  });

  it('skips odd paths', () => {
    const t = parseTree([
      { type: 'file', size: 1, path: '../x.gguf' },
      { type: 'file', size: 1, path: 'a\\b.gguf' },
      { type: 'file', size: 1 },
    ]);
    expect(t.files).toEqual([]);
  });
});

describe('requests', () => {
  it('searches and parses', async () => {
    const f = vi.fn(async () => respond(SEARCH));
    const repos = await searchRepos('qwen', { fetch: f as unknown as typeof fetch });
    expect(repos.map((r) => r.id)).toEqual(['unsloth/Qwen3.5-0.8B-GGUF', 'ggml-org/Qwen3.5-0.8B-GGUF']);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('search=qwen');
  });

  it('lists the files of a repo', async () => {
    const f = vi.fn(async () => respond(TREE));
    const t = await repoFiles('unsloth/Qwen3.5-0.8B-GGUF', { fetch: f as unknown as typeof fetch });
    expect(t.files).toHaveLength(5);
  });

  it('refuses a bad repo name without a request', async () => {
    const f = vi.fn();
    await expect(repoFiles('nope', { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'not-found' });
    expect(f).not.toHaveBeenCalled();
  });

  it('turns HTTP errors into readable ones', async () => {
    const at = (status: number) => ({ fetch: (async () => respond({ error: 'x' }, status)) as unknown as typeof fetch });
    // The hub answers 401 for a repo that does not exist.
    await expect(repoFiles('nobody/nothing', at(401))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(repoFiles('nobody/nothing', at(404))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(searchRepos('x', at(429))).rejects.toMatchObject({ kind: 'rate-limit' });
    await expect(searchRepos('x', at(503))).rejects.toMatchObject({ kind: 'http', message: 'Hugging Face answered HTTP 503' });
  });

  it('reports a network failure as offline', async () => {
    const f = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(searchRepos('x', { fetch: f })).rejects.toMatchObject({ kind: 'offline' });
  });

  it('reports a bad body', async () => {
    const f = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(searchRepos('x', { fetch: f })).rejects.toMatchObject({ kind: 'bad-response' });
  });

  // A fetch that never answers until its signal aborts, as the real one.
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;

  it('times out', async () => {
    await expect(searchRepos('x', { fetch: hanging, timeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('passes a caller abort through, not as an HfError', async () => {
    const ctl = new AbortController();
    const p = searchRepos('x', { fetch: hanging, signal: ctl.signal });
    ctl.abort();
    const e = await p.catch((err: unknown) => err);
    expect(e).not.toBeInstanceOf(HfError);
    expect(isAbort(e)).toBe(true);
  });
});
