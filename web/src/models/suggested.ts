// Pairs offered in the Models panel: the suggested ones (the same as the
// README and `make models`) and the last pairs loaded in this browser.

export interface SuggestedPair {
  title: string;
  note: string;
  repo: string;
  a: string; // paths in the repo
  b: string;
  size: [number, number]; // bytes of A and B on the hub, for "to download"
}

export const SUGGESTED: readonly SuggestedPair[] = [
  {
    title: 'Demo',
    note: 'Qwen3.5 4B · Q2_K vs Q8_0',
    repo: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
    a: 'Qwen_Qwen3.5-4B-Q2_K.gguf',
    b: 'Qwen_Qwen3.5-4B-Q8_0.gguf',
    size: [2191779808, 4622131168],
  },
  {
    title: 'Smaller',
    note: 'Qwen3.5 2B · UD-Q2_K_XL vs Q8_0',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    a: 'Qwen3.5-2B-UD-Q2_K_XL.gguf',
    b: 'Qwen3.5-2B-Q8_0.gguf',
    size: [966533376, 2012012800],
  },
  {
    title: 'Smallest',
    note: 'Qwen3.5 0.8B · Q4_K_M vs Q8_0',
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    a: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    b: 'Qwen3.5-0.8B-Q8_0.gguf',
    size: [532517120, 811843840],
  },
];

// ----------------------------------------------------------- recent pairs

export interface RecentPair {
  a: string; // file names in the folder
  b: string | null;
}

const KEY = 'inside-llm.recentModels';
export const MAX_RECENT = 5;

// Storage can be missing, or throw on access (private windows, blocked site
// data): then there are no recent pairs, and nothing breaks.
type StorageGetter = () => Pick<Storage, 'getItem' | 'setItem'> | null;
const browserStorage: StorageGetter = () => (typeof localStorage === 'undefined' ? null : localStorage);

export function readRecents(storage: StorageGetter = browserStorage): RecentPair[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const out: RecentPair[] = [];
  for (const e of json) {
    if (typeof e !== 'object' || e === null) continue;
    const { a, b } = e as Record<string, unknown>;
    if (typeof a !== 'string' || !a) continue;
    out.push({ a, b: typeof b === 'string' && b ? b : null });
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

export function samePair(x: RecentPair, y: RecentPair): boolean {
  return x.a === y.a && x.b === y.b;
}

// Puts a pair first (once) and keeps the last MAX_RECENT. Returns the new
// list, also when it could not be stored.
export function pushRecent(pair: RecentPair, storage: StorageGetter = browserStorage): RecentPair[] {
  const list = [pair, ...readRecents(storage).filter((p) => !samePair(p, pair))].slice(0, MAX_RECENT);
  try {
    storage()?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Not stored: the list lasts until the page is reloaded.
  }
  return list;
}
