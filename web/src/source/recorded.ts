// Recorded source: a session file (.ils = gzip of the frames) replayed
// against the store, honouring the frames' timestamps.

import type { Store } from '../store/store';
import { decodeFrames, FRAME_HELLO, NONE, type Frame } from './frames';

// While playing, a wait longer than this between frames (the user was idle
// during the recording) is skipped.
const MAX_GAP_MS = 1000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function gunzip(file: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([file.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decompresses a session file and decodes its frames.
export async function decodeSession(file: Uint8Array): Promise<Frame[]> {
  if (file.length < 2 || file[0] !== 0x1f || file[1] !== 0x8b) {
    throw new Error('not a session file (not gzip)');
  }
  let raw: Uint8Array;
  try {
    raw = await gunzip(file);
  } catch (e) {
    throw new Error(`damaged session file (gzip: ${message(e)})`);
  }
  let frames: Frame[];
  try {
    frames = decodeFrames(raw);
  } catch (e) {
    throw new Error(`damaged session file (${message(e)})`);
  }
  if (frames.length === 0 || frames[0].type !== FRAME_HELLO) {
    throw new Error('not a session file (does not start with HELLO)');
  }
  return frames;
}

// Fetches a session file and decodes it. Rejects with a readable message if
// the file cannot be fetched or is not a session.
export async function loadSession(url: string): Promise<Frame[]> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`cannot fetch ${url}: ${message(e)}`);
  }
  if (res.status === 404) throw new Error(`session not found: ${url}`);
  if (!res.ok) throw new Error(`cannot fetch ${url}: HTTP ${res.status}`);
  const file = new Uint8Array(await res.arrayBuffer());
  try {
    return await decodeSession(file);
  } catch (e) {
    throw new Error(`${url}: ${message(e)}`);
  }
}

// Plays a recorded session into a store. Time is the session's own clock
// (the frames' t_ms). The paint loop drives it: there is no timer here.
export class Player {
  private next = 0; // index of the first frame not yet applied
  private clock = 0;
  private running = false;

  // Applies the frames stamped at time 0 right away (HELLO and CONFIG), so
  // the models show before playing. Starts paused, at time 0.
  constructor(
    private readonly frames: Frame[],
    private readonly store: Store,
  ) {
    this.applyDue();
  }

  // t_ms of the last frame.
  get duration(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].t : 0;
  }

  // Current session time in ms, between 0 and duration.
  get time(): number {
    return this.clock;
  }

  get playing(): boolean {
    return this.running;
  }

  // True when every frame has been applied.
  get ended(): boolean {
    return this.next >= this.frames.length;
  }

  // Playback rate: 1 is real time.
  speed = 1;

  // Starts or resumes. At the end, starts again from the beginning.
  play(): void {
    if (this.ended) this.seek(0);
    this.running = !this.ended;
  }

  pause(): void {
    this.running = false;
  }

  // Jumps to a session time and applies every frame up to it. Going back
  // rebuilds the state from the start, which is immediate at session sizes,
  // and keeps the path chosen by hand if its tip exists by then.
  seek(timeMs: number): void {
    const t = Math.max(0, Math.min(this.duration, timeMs));
    const s = this.store;
    const back = t < this.clock;
    const tip = !back || s.follow || s.path.length === 0 ? NONE : s.path[s.path.length - 1];
    if (back) {
      s.reset();
      this.next = 0;
    }
    this.clock = t;
    this.applyDue();
    if (tip !== NONE && tip < s.nodeCount) s.viewNode(tip);
    if (this.ended) this.running = false;
  }

  // Applies the next frame group (all the frames sharing the next timestamp)
  // and pauses: the replay's "one step".
  stepForward(): void {
    this.running = false;
    if (this.ended) return;
    this.clock = Math.max(this.clock, this.frames[this.next].t);
    this.applyDue();
  }

  // Called once per animation frame with the wall-clock time elapsed since
  // the previous call. While playing, advances the session clock by
  // elapsed × speed and applies the frames that are due. Idle gaps longer
  // than one second are skipped. Pauses at the end.
  tick(elapsedMs: number): void {
    if (!this.running) return;
    let t = this.clock + Math.max(0, elapsedMs) * this.speed;
    const upcoming = this.frames[this.next];
    if (upcoming && upcoming.t - this.clock > MAX_GAP_MS) t = Math.max(t, upcoming.t);
    this.clock = Math.min(t, this.duration);
    this.applyDue();
    if (this.ended) this.running = false;
  }

  private applyDue(): void {
    while (this.next < this.frames.length && this.frames[this.next].t <= this.clock) {
      this.store.apply(this.frames[this.next]);
      this.next++;
    }
  }
}
