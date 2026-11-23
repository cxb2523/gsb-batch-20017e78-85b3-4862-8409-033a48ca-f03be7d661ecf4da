// JSON text messages of the engine protocol: commands to the engine and
// transient events from it. Neither is stored in the session log.

import type { Gate } from './frames';

// The part of the configuration a command can change. Fields left out keep
// their value.
export interface ConfigChange {
  mode?: 'lockstep' | 'free'; // two models only
  driver?: 'A' | 'B'; // counts in lockstep only
  max_tokens?: number;
  seed?: number;
  gates?: Gate[]; // the whole chain, in the order it is applied
}

export interface StartCommand {
  cmd: 'start';
  prompt: string;
  format: 'raw' | 'chat';
  system?: string; // chat only
  config?: ConfigChange;
}

export type Command =
  | StartCommand
  | { cmd: 'run' }
  | { cmd: 'pause' }
  | { cmd: 'step' }
  | { cmd: 'speed'; tps: number } // 0 is unlimited
  | { cmd: 'config'; config: ConfigChange }
  // Under `node` (the parent), finds or creates the child with `token` and
  // moves the cursors of `slots` there. In lockstep both always move.
  | { cmd: 'branch'; node: number; token: number; slots: Slots }
  // Moves the cursors of `slots` to an existing node.
  | { cmd: 'goto'; node: number; slots: Slots }
  // Models: list, load and download. Files are names in the
  // engine's models folder, never paths.
  | { cmd: 'models' } // re-read the folder; answered with a `models` event
  | { cmd: 'load'; a: string; b?: string | null }
  | { cmd: 'download'; repo: string; path: string } // a Hugging Face file
  | { cmd: 'cancel_download'; repo: string; path: string }
  | { cmd: 'delete'; file: string };

export type Slots = 'A' | 'B' | 'AB';

export interface StatusEvent {
  ev: 'status';
  state: 'idle' | 'running' | 'paused'; // idle: no prompt yet
  tps: number;
  tps_limit: number; // 0 is unlimited
  nodes: number;
  clients: number;
}

export interface ErrorEvent {
  ev: 'error';
  cmd?: string; // absent when a step failed
  msg: string;
}

export interface WarningEvent {
  ev: 'warning';
  msg: string;
}

// One GGUF of the models folder, read from its header without loading it.
export interface ModelFile {
  file: string; // name in the folder
  size: number; // bytes
  name: string; // general.name, or the file name
  arch: string;
  size_label: string; // general.size_label ("4B"), may be empty
  quant: string; // "Q8_0", may be empty
  n_layer: number;
  n_vocab: number;
  tok: string; // tokenizer fingerprint: equal means comparable
  vram: number; // estimated bytes on the GPU at the engine's n_ctx
  error: string; // non-empty: the header could not be read
}

export type DownloadState = 'queued' | 'running' | 'done' | 'cancelled' | 'error';

export interface DownloadInfo {
  repo: string;
  path: string; // path in the repo
  file: string; // name it gets in the folder
  state: DownloadState;
  done: number; // bytes
  total: number; // 0 while unknown
}

export interface ModelsEvent {
  ev: 'models';
  dir: string;
  files: ModelFile[];
  loaded: { a: string | null; b: string | null };
  loading: boolean;
  n_ctx: number;
  gpu: { total: number; available: number }; // 0 without a dedicated GPU
  download: boolean; // the engine can download (built with TLS)
  downloads: DownloadInfo[]; // the queue: running first, then pending
}

export interface LoadEvent {
  ev: 'load';
  state: 'loading' | 'ready' | 'error';
  a?: string | null;
  b?: string | null;
  msg?: string;
}

export interface DownloadEvent extends DownloadInfo {
  ev: 'download';
  msg?: string; // with state 'error'
}

export type EngineEvent =
  | StatusEvent
  | ErrorEvent
  | WarningEvent
  | ModelsEvent
  | LoadEvent
  | DownloadEvent;
