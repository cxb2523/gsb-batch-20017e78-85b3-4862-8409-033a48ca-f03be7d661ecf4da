// Minimal engine client for the end-to-end tests: Node's WebSocket (undici),
// which can set the Origin header the engine requires, feeding a Store.

import { decodeFrames, FRAME_CURSOR, FRAME_HELLO, NONE, type Frame } from '../source/frames';
import type { Command, ConfigChange, EngineEvent, StartCommand } from '../source/messages';
import { Store } from '../store/store';

// Polls `cond` until it holds. Rejects after `timeoutMs` with `what`.
export async function until(cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function wsUrl(base: string): string {
  return base.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
}

export class TestClient {
  readonly store = new Store();
  readonly events: EngineEvent[] = [];
  readonly ws: WebSocket;
  hellos = 0; // HELLO frames received
  frames: Frame[] = []; // the frames of the current session, from its HELLO
  cursors = 0; // CURSOR frames received
  lastCursorAt = 0; // performance.now() when the last CURSOR arrived
  opened = false;
  closed = false;
  errors: string[] = []; // messages that could not be decoded

  constructor(base: string, origin: string = new URL(base).origin) {
    // undici's WebSocketInit (`headers`) is not in the DOM typings.
    const init = { headers: { Origin: origin } } as unknown as string[];
    this.ws = new WebSocket(wsUrl(base), init);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.opened = true;
    };
    this.ws.onclose = () => {
      this.closed = true;
    };
    this.ws.onmessage = (m: MessageEvent) => {
      try {
        if (typeof m.data === 'string') {
          this.events.push(JSON.parse(m.data) as EngineEvent);
          return;
        }
        for (const f of decodeFrames(new Uint8Array(m.data as ArrayBuffer))) {
          if (f.type === FRAME_HELLO) {
            this.hellos++;
            this.frames = [];
          } else if (f.type === FRAME_CURSOR) {
            this.cursors++;
            this.lastCursorAt = performance.now();
          }
          this.frames.push(f);
          this.store.apply(f);
        }
      } catch (e) {
        this.errors.push(String(e));
      }
    };
  }

  send(c: Command): void {
    this.ws.send(JSON.stringify(c));
  }

  close(): void {
    this.ws.close();
  }

  // Tokens generated on the viewed path (prompt excluded).
  get generated(): number {
    return this.store.path.length - this.store.promptLength;
  }

  // The bytes of the viewed path, concatenated.
  text(): Uint8Array {
    const parts = this.store.path.map((n) => this.store.vocab.get(this.store.token[n])?.bytes ?? new Uint8Array(0));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let p = 0;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  }

  // Sends a configuration change.
  config(change: ConfigChange): void {
    this.send({ cmd: 'config', config: change });
  }

  // Whether no model can go on: each cursor sits on a stop that covers it.
  get stopped(): boolean {
    const s = this.store;
    const covers = (node: number, slot: number): boolean => {
      const st = s.stops.get(node);
      return st !== undefined && (st.slot === slot || st.slot === 2);
    };
    if (s.cursorA === NONE) return false;
    return covers(s.cursorA, 0) && (s.cursorB === NONE || covers(s.cursorB, 1));
  }

  // Sends `start` and waits until the new session's prompt is in the store.
  // `extra` can set the format, the system message and more configuration.
  async start(
    prompt: string,
    maxTokens: number,
    extra: { format?: StartCommand['format']; system?: string; config?: ConfigChange } = {},
  ): Promise<void> {
    const before = this.hellos;
    const seen = this.events.length;
    const cmd: StartCommand = {
      cmd: 'start',
      prompt,
      format: extra.format ?? 'raw',
      config: { ...extra.config, max_tokens: maxTokens },
    };
    if (extra.system !== undefined) cmd.system = extra.system;
    this.send(cmd);
    await until(
      () => (this.hellos > before && this.store.path.length > 0) || this.errorSince(seen, 'start') !== undefined,
      'the prompt of the new session',
    );
    const err = this.errorSince(seen, 'start');
    if (err) throw new Error(`start failed: ${err.msg}`);
  }

  // The first error event for `cmd` received after event number `index`.
  errorSince(index: number, cmd: string): Extract<EngineEvent, { ev: 'error' }> | undefined {
    for (let i = index; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.ev === 'error' && e.cmd === cmd) return e;
    }
    return undefined;
  }
}
