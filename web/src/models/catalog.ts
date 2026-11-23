// The engine's models folder as the Models panel shows it: files grouped by
// tokenizer, which files can be B for a given A, whether a pair fits in the
// GPU, the download queue, and a pending "download then load" intent. Pure
// functions over the `models` and `download` events; no Svelte, no DOM.

import type { DownloadEvent, DownloadInfo, ModelFile, ModelsEvent } from '../source/messages';

// Files that share a tokenizer fingerprint: any two of them can be compared.
// Files whose header could not be read go to a group of their own, last.
export interface Family {
  key: string; // the fingerprint, or ERROR_FAMILY
  label: string; // e.g. "Qwen3.5"
  arch: string;
  files: ModelFile[];
}

export const ERROR_FAMILY = '!error';

// Groups the folder by tokenizer, in the order the groups first appear (the
// engine sends the files sorted by name); files keep their order inside.
export function families(files: readonly ModelFile[]): Family[] {
  const byKey = new Map<string, ModelFile[]>();
  for (const f of files) {
    const key = f.error || !f.tok ? ERROR_FAMILY : f.tok;
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(f);
  }
  const out: Family[] = [];
  let broken: Family | null = null;
  for (const [key, list] of byKey) {
    if (key === ERROR_FAMILY) {
      broken = { key, label: 'Unreadable files', arch: '', files: list };
      continue;
    }
    out.push({ key, label: familyLabel(list), arch: list[0].arch, files: list });
  }
  if (broken) out.push(broken);
  return out;
}

// The words all the names of a family start with ("Qwen3.5 0.8B" and
// "Qwen3.5 2B" give "Qwen3.5"); the architecture if they share none.
export function familyLabel(files: readonly ModelFile[]): string {
  const names = files.map((f) => (f.name || f.file).split(/\s+/));
  let n = names[0]?.length ?? 0;
  for (const words of names) {
    let i = 0;
    while (i < n && i < words.length && words[i] === names[0][i]) i++;
    n = i;
  }
  const common = names[0]?.slice(0, n).join(' ') ?? '';
  return common || files[0]?.arch || 'Unknown';
}

export function findFile(files: readonly ModelFile[], file: string | null | undefined): ModelFile | undefined {
  return file ? files.find((f) => f.file === file) : undefined;
}

// A file that can be loaded: its header was read.
export function usable(f: ModelFile | undefined): boolean {
  return f !== undefined && !f.error && f.tok !== '';
}

// Whether `f` can be B next to `a`: both readable, same tokenizer.
export function compatible(a: ModelFile | undefined, f: ModelFile | undefined): boolean {
  return a !== undefined && f !== undefined && usable(a) && usable(f) && a.tok === f.tok;
}

// The files that can be B with A = `a` (a file name). Empty without A.
export function compatibleB(files: readonly ModelFile[], a: string | null): ModelFile[] {
  const fa = findFile(files, a);
  if (!fa || !usable(fa)) return [];
  return files.filter((f) => compatible(fa, f));
}

// ------------------------------------------------------------------ VRAM

export interface VramFit {
  need: number; // bytes: the estimate of A plus B (0 for a file not in the folder)
  available: number; // bytes the pair can use (gpu.available)
  state: 'ok' | 'over' | 'unknown'; // unknown: no dedicated GPU, or nothing chosen
  ratio: number; // need / available, for the bar (0 when unknown)
}

export function vramFit(
  files: readonly ModelFile[],
  a: string | null,
  b: string | null,
  gpu: { total: number; available: number },
): VramFit {
  const need = (findFile(files, a)?.vram ?? 0) + (findFile(files, b)?.vram ?? 0);
  if (gpu.total <= 0 || !a) return { need, available: gpu.available, state: 'unknown', ratio: 0 };
  const ratio = gpu.available > 0 ? need / gpu.available : Infinity;
  return { need, available: gpu.available, state: ratio > 1 ? 'over' : 'ok', ratio };
}

// --------------------------------------------------------------- sizes

// A size in decimal units, as the hub shows them: "812 MB", "2.01 GB".
export function gb(n: number): string {
  if (!(n > 0)) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

// Fraction downloaded, 0..1; null while the total is unknown.
export function progress(d: Pick<DownloadInfo, 'done' | 'total'>): number | null {
  if (!(d.total > 0)) return null;
  return Math.min(1, Math.max(0, d.done / d.total));
}

// "312 MB of 812 MB · 38%", or "312 MB" while the total is unknown.
export function progressText(d: Pick<DownloadInfo, 'done' | 'total' | 'state'>): string {
  if (d.state === 'queued') return 'queued';
  const p = progress(d);
  if (p === null) return gb(d.done);
  return `${gb(d.done)} of ${gb(d.total)} · ${Math.floor(p * 100)}%`;
}

// ------------------------------------------------------------ downloads

export function sameDownload(x: Pick<DownloadInfo, 'repo' | 'path'>, y: Pick<DownloadInfo, 'repo' | 'path'>): boolean {
  return x.repo === y.repo && x.path === y.path;
}

// The queue after a `download` event: queued and running ones are updated
// (or added at the end); finished, cancelled and failed ones leave it.
export function applyDownload(list: readonly DownloadInfo[], ev: DownloadEvent): DownloadInfo[] {
  const rest = list.filter((d) => !sameDownload(d, ev));
  if (ev.state !== 'queued' && ev.state !== 'running') return rest;
  const info: DownloadInfo = {
    repo: ev.repo,
    path: ev.path,
    file: ev.file,
    state: ev.state,
    done: ev.done,
    total: ev.total,
  };
  const i = list.findIndex((d) => sameDownload(d, ev));
  if (i < 0) return [...rest, info];
  const out = list.slice();
  out[i] = info;
  return out;
}

// The name a repo path gets in the folder (the engine drops the folders).
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// ------------------------------------------------- download, then load

// "Load this pair once both files are in the folder": what a suggested pair
// or "Download & compare" leaves behind while its files download.
export interface PendingLoad {
  a: string; // file names in the folder
  b: string | null;
  sources: { repo: string; path: string }[]; // the downloads it waits for
}

export type PendingStep =
  | { kind: 'wait' } // a file is still missing or downloading
  | { kind: 'load'; a: string; b: string | null }
  | { kind: 'fail'; msg: string };

// What to do with a pending load after a `models` event.
export function pendingStep(p: PendingLoad, ev: Pick<ModelsEvent, 'files' | 'downloads' | 'loading'>): PendingStep {
  const names = p.b ? [p.a, p.b] : [p.a];
  const queued = (name: string) => ev.downloads.some((d) => d.file === name);
  if (names.some((n) => queued(n) || !findFile(ev.files, n))) return { kind: 'wait' };
  const fa = findFile(ev.files, p.a);
  const fb = findFile(ev.files, p.b);
  for (const f of [fa, fb]) {
    if (f && !usable(f)) return { kind: 'fail', msg: `${f.file} cannot be read: ${f.error || 'no tokenizer'}` };
  }
  // The fingerprints are the authority: same repo does not guarantee it.
  if (fb && !compatible(fa, fb)) {
    return { kind: 'fail', msg: `${p.a} and ${p.b} use different tokenizers: they cannot be compared` };
  }
  if (ev.loading) return { kind: 'wait' };
  return { kind: 'load', a: p.a, b: p.b };
}

// Whether a finished download (cancelled or failed) breaks a pending load.
export function pendingBrokenBy(p: PendingLoad, ev: DownloadEvent): boolean {
  if (ev.state !== 'cancelled' && ev.state !== 'error') return false;
  return p.sources.some((s) => sameDownload(s, ev));
}
