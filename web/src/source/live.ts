// Live source: frames and events from the engine over a WebSocket, and
// commands back to it.

import { decodeFrames, type Frame } from './frames';
import type { Command, EngineEvent } from './messages';

export interface LiveHandlers {
  // The frames of one binary message, in order.
  onFrames(frames: Frame[]): void;
  // A status, error or warning event.
  onEvent(event: EngineEvent): void;
  // The connection opened (true) or was lost (false).
  onConnection(connected: boolean): void;
}

const RECONNECT_MS = 1000;

// URL of the engine's WebSocket for a page served from `location`:
// ws(s)://<host>/<directory of the page>/ws.
export function liveUrl(location: { protocol: string; host: string; pathname: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = location.pathname || '/';
  const dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return `${scheme}//${location.host}${dir}ws`;
}

// Connects on construction and reconnects by itself, about once per second,
// while the connection is down. After every (re)connection the engine sends
// the whole log again, starting with HELLO, so the store rebuilds itself.
export class LiveSource {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: LiveHandlers,
  ) {
    this.connect();
  }

  get connected(): boolean {
    return this.open;
  }

  // Sends a command. Dropped (returns false) while disconnected.
  send(command: Command): boolean {
    if (!this.open || !this.ws) return false;
    this.ws.send(JSON.stringify(command));
    return true;
  }

  // Closes for good: no more reconnections.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    if (this.open) {
      this.open = false;
      this.handlers.onConnection(false);
    }
  }

  private connect(): void {
    this.timer = null;
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      console.error('live: cannot open', this.url, e);
      this.retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.handlers.onConnection(true);
    };
    ws.onmessage = (m: MessageEvent) => this.receive(m.data);
    // An error is always followed by close, which does the work.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.open) {
        this.open = false;
        this.handlers.onConnection(false);
      }
      this.retry();
    };
  }

  private retry(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => this.connect(), RECONNECT_MS);
  }

  // A message that cannot be decoded is logged and skipped: it does not
  // bring the connection down.
  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      let frames: Frame[];
      try {
        frames = decodeFrames(new Uint8Array(data));
      } catch (e) {
        console.error('live: bad binary message', e);
        return;
      }
      this.handlers.onFrames(frames);
    } else if (typeof data === 'string') {
      let event: EngineEvent;
      try {
        event = JSON.parse(data) as EngineEvent;
      } catch (e) {
        console.error('live: bad text message', e);
        return;
      }
      this.handlers.onEvent(event);
    }
  }
}
