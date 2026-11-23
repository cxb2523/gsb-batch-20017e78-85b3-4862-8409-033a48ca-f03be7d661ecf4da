// Node-side stand-ins for the Web Audio / browser APIs TalkingAvatar uses. No real audio hardware, no network:
// the model is fetched from the local model/ file, decodeAudioData wraps a Float32Array, and time is driven
// manually through FakeAudioContext.setTime. Imported first by talkingAvatar.test.ts so the globals exist before
// src/TalkingAvatar.ts evaluates (it reads __VERSION__ at module scope).
import { readFileSync } from "node:fs";

(globalThis as Record<string, unknown>).__VERSION__ = "0.0.0-test";

/** Sample rate every FakeAudioContext uses; available before any context has been created. */
export const SAMPLE_RATE = 16000;

const modelBytes = (() => {
  const buf = readFileSync(new URL("../model/viseme-model.bin", import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
})();

// fetch is only used for the model URL and speak() URL clips; both are served from local fixtures.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("viseme-model.bin")) {
    return { ok: true, arrayBuffer: async () => modelBytes.slice(0) } as Response;
  }
  if (url === "data:clip") return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};

// ---- Fake Web Audio graph -------------------------------------------------

class FakeNode {
  connectedTo: FakeNode[] = [];
  incoming: FakeNode[] = [];
  disconnected = false;

  connect(node: FakeNode): FakeNode {
    this.connectedTo.push(node);
    node.incoming.push(this);
    return node; // Web Audio returns the target node so source.connect(a).connect(b) chains a -> b
  }

  disconnect(): void {
    this.disconnected = true;
    for (const node of this.connectedTo) node.incoming = node.incoming.filter((other) => other !== this);
    this.connectedTo = [];
  }
}

class FakeParam {
  value = 0;
}

class FakeDelayNode extends FakeNode {
  delayTime = new FakeParam();
}

class FakeMediaStreamSourceNode extends FakeNode {}

class FakeBufferSourceNode extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  private readonly audioContext: FakeAudioContext;

  constructor(context: FakeAudioContext) {
    super();
    this.audioContext = context;
  }

  start(when: number): void {
    this.startedAt = when;
    this.audioContext.bufferSources.push(this);
  }

  stop(): void {
    this.stopped = true;
    // A real AudioBufferSourceNode fires onended asynchronously after stop(); emulate that on the next tick.
    // The handler reference is kept (tests also invoke it manually to simulate a late event after disposal).
    if (this.onended) {
      const onended = this.onended;
      setTimeout(() => onended(), 0);
    }
  }
}

class FakeAudioWorkletNode extends FakeNode {
  static instances: FakeAudioWorkletNode[] = [];

  port: { onmessage: ((event: { data: { time: number; samples: Float32Array } }) => void) | null };

  constructor() {
    super();
    this.port = { onmessage: null };
    FakeAudioWorkletNode.instances.push(this);
  }
}

export class FakeAudioBuffer {
  readonly length: number;
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  private readonly channelData: Float32Array[];

  constructor(sampleRate: number, channels: Float32Array[]) {
    this.sampleRate = sampleRate;
    this.channelData = channels;
    this.numberOfChannels = channels.length;
    this.length = channels[0].length;
    this.duration = this.length / sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channelData[channel];
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly sampleRate = SAMPLE_RATE;
  readonly destination = new FakeNode();
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  outputLatency = 0;
  audioWorklet = { addModule: async () => {} };
  /** Every buffer source ever created, in order — tests assert what audio was actually scheduled. */
  bufferSources: FakeBufferSourceNode[] = [];
  private closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  setTime(seconds: number): void {
    this.currentTime = seconds;
  }

  createDelay(): FakeDelayNode {
    return new FakeDelayNode();
  }

  createMediaStreamSource(): FakeMediaStreamSourceNode {
    return new FakeMediaStreamSourceNode();
  }

  createBufferSource(): FakeBufferSourceNode {
    return new FakeBufferSourceNode(this);
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
    // Tests pass a Float32Array whose .buffer is the "encoded" clip: mono PCM at the context rate.
    const view = new Float32Array(bytes);
    return Promise.resolve(new FakeAudioBuffer(this.sampleRate, [Float32Array.from(view)]));
  }

  resume(): Promise<void> {
    if (!this.closed) this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }

  getOutputTimestamp(): AudioTimestamp | undefined {
    return undefined; // heardMs() then falls back to currentTime, which tests drive manually
  }

  // Test helpers: drive worklet blocks into the currently attached capture node.
  get captureNodes(): FakeAudioWorkletNode[] {
    return FakeAudioWorkletNode.instances;
  }
}

globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

// ---- Media element / stream fakes -----------------------------------------

class FakeAudioElement {
  muted = false;
  srcObject: MediaStream | null = null;
  async play(): Promise<void> {}
}

globalThis.Audio = FakeAudioElement as unknown as typeof Audio;

export class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = [{ kind: "audio" } as MediaStreamTrack]) {
    this.tracks = tracks;
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;

/** Let the microtask/timeout queue drain so async speak() analysis can make progress. */
export function flushMicrotasks(times = 1): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return chain;
}

export type Frame = { visemes: Record<string, number>; mode: string };

/** Renderer double: it never touches the DOM/WebGL, just exposes the frame the avatar would draw. */
export class FakeRenderer {
  static instances: FakeRenderer[] = [];
  readonly getFrame: () => Frame;
  disposed = false;

  constructor(_container: HTMLElement, getFrame: () => Frame) {
    this.getFrame = getFrame;
    FakeRenderer.instances.push(this);
  }

  async load(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
  }

  frame(): Frame {
    return this.getFrame();
  }
}

export function resetFakes(): void {
  FakeAudioContext.instances = [];
  FakeRenderer.instances = [];
  FakeAudioWorkletNode.instances = [];
}
