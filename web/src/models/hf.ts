// The public Hugging Face API, called from the browser (it allows CORS for
// any origin): search GGUF repos and list the GGUF files of one. The engine
// only downloads (`download` command); it never searches. Kept on its own so
// the engine can proxy these calls later without touching the panel.
//
//   search  GET <hub>/api/models?search=<q>&filter=gguf&sort=downloads&direction=-1&limit=20
//               &expand[]=downloads&expand[]=likes&expand[]=lastModified
//           → [{ id, downloads, likes, lastModified }]
//   files   GET <hub>/api/models/<repo>/tree/main?recursive=true
//           → [{ type: "file" | "directory", path, size, lfs?: { size } }]

export const HF_HUB = 'https://huggingface.co';
const TIMEOUT_MS = 15000;
const LIMIT = 20;

export interface HfRepo {
  id: string; // "user/name"
  downloads: number;
  likes: number;
  updated: string; // ISO date, may be empty
}

export interface HfFile {
  path: string; // in the repo, folders included
  file: string; // the name it gets in the engine's folder
  folder: string; // "" at the top of the repo
  size: number; // bytes
  quant: string; // "Q4_K_M", "" if the name has none
}

export interface HfFiles {
  files: HfFile[]; // single-file GGUF models, smallest first
  split: number; // GGUF parts (-00001-of-00003) left out: the engine loads single files only
}

export type HfErrorKind = 'offline' | 'timeout' | 'not-found' | 'rate-limit' | 'http' | 'bad-response';

export class HfError extends Error {
  constructor(
    readonly kind: HfErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'HfError';
  }
}

export interface HfOptions {
  signal?: AbortSignal; // the caller gave up: rejects with an AbortError, not an HfError
  timeoutMs?: number;
  fetch?: typeof fetch; // tests
  hub?: string;
}

// "user/name" with the characters the hub (and the engine) accept.
export function validRepo(id: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id) && !id.split('/').some((p) => p === '.' || p === '..');
}

// A part of a split GGUF: "x-00001-of-00003.gguf".
export function isSplitPart(path: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(path);
}

// Files that are GGUF but not a language model: vision projectors and
// importance matrices.
export function isAuxiliary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return name.includes('mmproj') || name.startsWith('imatrix');
}

// The quantization in a file name: Q8_0, Q4_K_M, UD-Q2_K_XL, IQ2_XXS, BF16…
// The last one wins ("…-Q4_K_M-imat" still gives Q4_K_M). Upper case.
const QUANT =
  /(?:^|[-_.])((?:UD-)?(?:I?Q\d_K(?:_[A-Z]{1,3})?|IQ\d_[A-Z]{1,3}|Q\d_\d|TQ\d_\d|MXFP4(?:_MOE)?|BF16|F16|F32))(?=$|[-_.])/gi;

export function parseQuant(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.gguf$/i, '');
  let last = '';
  for (const m of name.matchAll(QUANT)) last = m[1];
  return last.toUpperCase();
}

// Fetches JSON with a timeout. Network failures, time-outs and HTTP errors
// become an HfError with a readable message; an abort by the caller is
// passed through as is.
async function getJson(url: string, opt: HfOptions, what: string): Promise<unknown> {
  const doFetch = opt.fetch ?? fetch;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opt.timeoutMs ?? TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (opt.signal?.aborted) ctl.abort();
  opt.signal?.addEventListener('abort', onAbort);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (opt.signal?.aborted) throw e;
      if (timedOut) throw new HfError('timeout', 'Hugging Face did not answer in time');
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new HfError('offline', offline ? 'You are offline' : 'Cannot reach Hugging Face');
    }
    if (!res.ok) {
      // A repo that does not exist answers 401 (as a private one would).
      if (res.status === 401 || res.status === 404) {
        throw new HfError('not-found', `${what} not found (or private / gated)`);
      }
      if (res.status === 429) throw new HfError('rate-limit', 'Hugging Face is rate limiting: try again in a minute');
      throw new HfError('http', `Hugging Face answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      if (opt.signal?.aborted) throw e;
      if (timedOut) throw new HfError('timeout', 'Hugging Face did not answer in time');
      throw new HfError('bad-response', 'Unexpected answer from Hugging Face');
    }
  } finally {
    clearTimeout(timer);
    opt.signal?.removeEventListener('abort', onAbort);
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function searchUrl(query: string, hub = HF_HUB): string {
  const q = new URLSearchParams({
    search: query.trim(),
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: String(LIMIT),
  });
  for (const field of ['downloads', 'likes', 'lastModified']) q.append('expand[]', field);
  return `${hub}/api/models?${q}`;
}

export function treeUrl(repo: string, hub = HF_HUB): string {
  const [user, name] = repo.split('/');
  return `${hub}/api/models/${encodeURIComponent(user)}/${encodeURIComponent(name)}/tree/main?recursive=true`;
}

// The page of a repo on the hub, for a link.
export function repoUrl(repo: string, hub = HF_HUB): string {
  return `${hub}/${repo}`;
}

export function parseSearch(json: unknown): HfRepo[] {
  if (!Array.isArray(json)) throw new HfError('bad-response', 'Unexpected answer from Hugging Face');
  const out: HfRepo[] = [];
  for (const r of json) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : typeof o.modelId === 'string' ? o.modelId : '';
    if (!validRepo(id)) continue;
    const updated = typeof o.lastModified === 'string' ? o.lastModified : typeof o.createdAt === 'string' ? o.createdAt : '';
    out.push({ id, downloads: num(o.downloads), likes: num(o.likes), updated });
  }
  return out;
}

export function parseTree(json: unknown): HfFiles {
  if (!Array.isArray(json)) throw new HfError('bad-response', 'Unexpected answer from Hugging Face');
  const files: HfFile[] = [];
  let split = 0;
  for (const e of json) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    const path = typeof o.path === 'string' ? o.path : '';
    if (o.type !== 'file' || !/\.gguf$/i.test(path) || path.includes('\\') || path.split('/').includes('..')) continue;
    if (isAuxiliary(path)) continue;
    if (isSplitPart(path)) {
      split++;
      continue;
    }
    const lfs = o.lfs as Record<string, unknown> | undefined;
    const size = num(lfs?.size) || num(o.size);
    const cut = path.lastIndexOf('/');
    files.push({ path, file: path.slice(cut + 1), folder: cut < 0 ? '' : path.slice(0, cut), size, quant: parseQuant(path) });
  }
  files.sort((x, y) => x.size - y.size || x.path.localeCompare(y.path));
  return { files, split };
}

// GGUF repos matching `query`, most downloaded first. An empty query lists
// the most downloaded GGUF repos.
export async function searchRepos(query: string, opt: HfOptions = {}): Promise<HfRepo[]> {
  return parseSearch(await getJson(searchUrl(query, opt.hub), opt, 'Search'));
}

// The single-file GGUF models of a repo.
export async function repoFiles(repo: string, opt: HfOptions = {}): Promise<HfFiles> {
  if (!validRepo(repo)) throw new HfError('not-found', `"${repo}" is not a repository name (user/name)`);
  return parseTree(await getJson(treeUrl(repo, opt.hub), opt, 'Repository'));
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string } | null)?.name === 'AbortError';
}

// "1.2M", "34k", "980": downloads and likes in a list.
export function shortCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

// "2026-03-02" from an ISO date; "" if there is none.
export function day(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}
