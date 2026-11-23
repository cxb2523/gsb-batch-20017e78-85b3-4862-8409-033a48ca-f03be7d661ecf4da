// Fixtures for the live shots (`make web-shots`): what a fake engine sends
// over /ws when it starts without a model or with a session paused, and
// what the Hugging Face API answers. The shapes follow the engine's
// `models` and `download` events and the hub's real answers; the values are
// made up.

const QWEN = '9f3a51c2e07b44d1';
const GEMMA = '0b7e2d6a11c3f5e8';

const file = (f) => ({
  size: 1e9,
  name: 'Qwen3.5 2B',
  arch: 'qwen35',
  size_label: '2B',
  quant: 'Q8_0',
  n_layer: 24,
  n_vocab: 248320,
  tok: QWEN,
  vram: 2.6e9,
  error: '',
  ...f,
});

const FILES = [
  file({ file: 'Qwen3.5-0.8B-Q8_0.gguf', size: 811843840, name: 'Qwen3.5 0.8B', size_label: '0.8B', vram: 1.2e9 }),
  file({ file: 'Qwen3.5-2B-Q8_0.gguf', size: 2012012800, vram: 2.6e9 }),
  file({ file: 'Qwen3.5-2B-UD-Q2_K_XL.gguf', size: 966533376, quant: 'Q2_K', vram: 1.5e9 }),
  file({
    file: 'Qwen_Qwen3.5-4B-Q2_K.gguf',
    size: 2191779808,
    name: 'Qwen3.5 4B',
    size_label: '4B',
    quant: 'Q2_K',
    n_layer: 32,
    vram: 2.9e9,
  }),
  file({
    file: 'google_gemma-4-E4B-it-Q2_K.gguf',
    size: 3.1e9,
    name: 'Gemma 4 E4B It',
    arch: 'gemma4',
    size_label: 'E4B',
    quant: 'Q2_K',
    n_layer: 42,
    n_vocab: 262144,
    tok: GEMMA,
    vram: 3.9e9,
  }),
  file({ file: 'half-copied.gguf', size: 12e6, name: '', arch: '', size_label: '', quant: '', n_layer: 0, n_vocab: 0, tok: '', vram: 0, error: 'truncated header' }),
];

// The engine just started, nothing loaded, one download under way.
export const NO_MODEL = [
  {
    ev: 'status',
    state: 'idle',
    tps: 0,
    tps_limit: 0,
    nodes: 0,
    clients: 1,
  },
  {
    ev: 'models',
    dir: 'models',
    files: FILES,
    loaded: { a: null, b: null },
    loading: false,
    n_ctx: 4096,
    gpu: { total: 17094000000, available: 14200000000 },
    download: true,
    downloads: [
      {
        repo: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
        path: 'Qwen_Qwen3.5-4B-Q8_0.gguf',
        file: 'Qwen_Qwen3.5-4B-Q8_0.gguf',
        state: 'running',
        done: 1724000000,
        total: 4622131168,
      },
    ],
  },
];

// The engine with a session loaded (its frames come from a recording, see
// `frames` in shots.mjs), paused.
export const PAUSED = [
  {
    ev: 'status',
    state: 'paused',
    tps: 0,
    tps_limit: 0,
    nodes: 0,
    clients: 1,
  },
];

export const HUB_SEARCH = [
  { _id: '1', id: 'unsloth/Qwen3.5-0.8B-GGUF', lastModified: '2026-03-02T14:08:04.000Z', likes: 252, downloads: 342802 },
  { _id: '2', id: 'turintech/Qwen3.5-0.8B-Artemis-GGUF', lastModified: '2026-06-10T14:28:34.000Z', likes: 18, downloads: 546830 },
  { _id: '3', id: 'ggml-org/Qwen3.5-0.8B-GGUF', lastModified: '2026-04-28T06:23:31.000Z', likes: 27, downloads: 55836 },
  { _id: '4', id: 'bartowski/Qwen_Qwen3.5-4B-GGUF', lastModified: '2026-03-05T09:12:44.000Z', likes: 96, downloads: 120533 },
];

const lfs = (path, size) => ({ type: 'file', oid: 'x', size, lfs: { oid: 'y', size, pointerSize: 134 }, path });
export const HUB_TREE = [
  { type: 'file', oid: 'a', size: 3104, path: '.gitattributes' },
  lfs('Qwen3.5-0.8B-BF16.gguf', 1516744736),
  lfs('Qwen3.5-0.8B-IQ4_XS.gguf', 492605696),
  lfs('Qwen3.5-0.8B-Q4_K_M.gguf', 532517120),
  lfs('Qwen3.5-0.8B-Q8_0.gguf', 811843840),
  lfs('Qwen3.5-0.8B-UD-IQ2_XXS.gguf', 338227456),
  lfs('Qwen3.5-0.8B-UD-Q2_K_XL.gguf', 417718528),
  lfs('mmproj-F16.gguf', 204987232),
  { type: 'file', oid: 'b', size: 62950, path: 'README.md' },
];
