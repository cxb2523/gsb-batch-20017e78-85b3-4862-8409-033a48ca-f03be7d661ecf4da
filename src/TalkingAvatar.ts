import { buildSegments, isSpeakingAt, mouthAt, type Segment } from "./coarticulation";
import { AvatarRenderer, type Mode, type MorphTargetMap } from "./renderer";
import { VisemeDetector, type VisemeEvent } from "./visemeDetector";
import { parseVisemeModel, type VisemeModel } from "./visemeModel";

declare const __VERSION__: string;

const PACKAGE_CDN = `https://cdn.jsdelivr.net/npm/@interviewflowai/talking-avatar@${__VERSION__}/dist`;

/** This package version's copy of the lip-sync model on jsDelivr. Self-host it (see `modelUrl`) in production. */
export const DEFAULT_MODEL_URL = `${PACKAGE_CDN}/viseme-model.bin`;

/**
 * The built-in 3D avatars (Microsoft Rocketbox, MIT), this package version's copies on jsDelivr. Pass one as
 * `avatarUrl`; the female one is the default. Self-host them like the model (`@interviewflowai/talking-avatar/avatars/*`).
 */
export const AVATARS = {
  female: `${PACKAGE_CDN}/avatars/female.glb`,
  male: `${PACKAGE_CDN}/avatars/male.glb`,
};

export interface TalkingAvatarOptions {
  /** Element the avatar fills. It needs a size (the canvas follows it). */
  container: HTMLElement;
  /**
   * A .glb avatar with Oculus viseme morph targets (viseme_aa, viseme_PP, …), or see `morphTargets`.
   * Default: AVATARS.female; AVATARS.male is the other built-in one.
   */
  avatarUrl?: string;
  /**
   * For avatars whose morph targets have other names: the avatar's name(s) for each standard name the SDK drives,
   * e.g. `{ viseme_PP: ["MouthClosed"], eyeBlinkLeft: "Blink_L" }`. Avatars named h_expressions.*_h are mapped
   * automatically.
   */
  morphTargets?: MorphTargetMap;
  /** Where to load the lip-sync model (viseme-model.bin) from. Default: DEFAULT_MODEL_URL. */
  modelUrl?: string;
  /**
   * How long an attached stream is delayed before it plays, in ms. The model hears each sound this long before
   * the listener does, so the mouth can move into it in time. Lower = less latency, rougher lip sync. Default 150.
   */
  streamDelayMs?: number;
  /** Errors from background work (avatar loading, audio analysis). Default: console.error. */
  onError?: (error: Error) => void;
}

const DEFAULT_STREAM_DELAY_MS = 150;
const SPEAK_START_MS = 50; // scheduling margin before a clip starts
const HISTORY_MS = 5000; // viseme events kept behind the playhead (coarticulation looks back up to ~250 ms)
const STREAM_GAP_S = 0.02; // a jump this big in captured audio time restarts the stream's viseme timeline
const ANALYSIS_CHUNK_S = 1; // speak(): analyse this much audio between yields to keep the page responsive

/** What the avatar does while it isn't speaking (speaking is detected from its audio). */
export type AvatarStatus = "listening" | "thinking";

// Hands the stream's audio from the audio thread to the model, in 1024-sample blocks stamped with context time.
const CAPTURE_PROCESSOR = "talking-avatar-capture";
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(1024); this.filled = 0; this.time = 0; }
  send() {
    this.port.postMessage({ time: this.time, samples: this.block.slice(0, this.filled) });
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    if (this.filled + input.length > this.block.length) this.send();
    if (this.filled === 0) this.time = currentTime;
    this.block.set(input, this.filled);
    this.filled += input.length;
    if (this.filled === this.block.length) this.send();
    return true;
  }
}
registerProcessor("${CAPTURE_PROCESSOR}", Capture);
`;

const models = new Map<string, Promise<VisemeModel>>();
function loadModel(url: string): Promise<VisemeModel> {
  let model = models.get(url);
  if (!model) {
    model = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`talking-avatar: viseme model ${url}: HTTP ${res.status}`);
      return res.arrayBuffer();
    }).then(parseVisemeModel);
    model.catch(() => models.delete(url)); // let a later call retry
    models.set(url, model);
  }
  return model;
}

/**
 * One audio source's viseme timeline: the attached stream's, or one speak() clip's. Events are in "heard"
 * audio-context time (ms). Each source owns its own instance, so stopping one source only drops its timeline and
 * never clears events the other source is still animating from.
 */
class Timeline {
  private events: VisemeEvent[] = [];
  private versionCounter = 0;

  /** Bumped on every mutation, so the merged render view can tell when to rebuild. */
  get version(): number {
    return this.versionCounter;
  }

  get isEmpty(): boolean {
    return this.events.length === 0;
  }

  getEvents(): readonly VisemeEvent[] {
    return this.events;
  }

  add(event: VisemeEvent, nowMs: number): void {
    const { events } = this;
    let i = events.length;
    while (i > 0 && events[i - 1].ms > event.ms) i -= 1; // keep time order when clip and stream overlap
    events.splice(i, 0, event);
    // Drop history well behind the playhead, keeping the event still in effect.
    const cutoff = nowMs - HISTORY_MS;
    let drop = 0;
    while (drop + 1 < events.length && events[drop + 1].ms < cutoff) drop += 1;
    if (drop) events.splice(0, drop);
    this.versionCounter += 1;
  }
}

/** Merge two time-ordered timelines into one time-ordered event list for the current frame. */
function mergeTimelines(a: Timeline | null, b: Timeline | null): VisemeEvent[] {
  const ea = a && !a.isEmpty ? a.getEvents() : null;
  const eb = b && !b.isEmpty ? b.getEvents() : null;
  if (!ea) return eb ? [...eb] : [];
  if (!eb) return [...ea];
  const merged: VisemeEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < ea.length || j < eb.length) {
    if (j >= eb.length || (i < ea.length && ea[i].ms <= eb[j].ms)) merged.push(ea[i++]);
    else merged.push(eb[j++]);
  }
  return merged;
}

type AttachedStream = {
  source: MediaStreamAudioSourceNode;
  delay: DelayNode;
  capture: AudioWorkletNode;
  element: HTMLAudioElement;
  detector: VisemeDetector | null;
  expectedTime: number;
  timeline: Timeline;
};

/**
 * A 3D avatar whose mouth follows any audio. Give it a container and an avatar URL, then either
 * `attachStream(mediaStream)` (live audio, e.g. WebRTC) or `speak(audio)` (a clip). The avatar plays the audio
 * itself; don't also play it elsewhere. Call those from a user gesture (or after one) so the browser allows sound.
 */
export class TalkingAvatar {
  /** Resolves when the first avatar is on screen; rejects if it fails to load. */
  readonly ready: Promise<void>;
  private readonly renderer: AvatarRenderer;
  private readonly modelUrl: string;
  private readonly streamDelayS: number;
  private readonly onError: (error: Error) => void;
  private context: AudioContext | null = null;
  private contextReady: Promise<AudioContext> | null = null;
  private stream: AttachedStream | null = null;
  private speech: AudioBufferSourceNode | null = null;
  /** Timeline of the clip currently speaking; dropped (with its residual events) when it ends or is stopped. */
  private speechTimeline: Timeline | null = null;
  private streamToken = 0;
  private speechToken = 0;
  private status: AvatarStatus = "listening";
  private disposed = false;

  // Cached merged view of the two timelines, rebuilt only when one of them changes identity or contents.
  private cacheStream: Timeline | null = null;
  private cacheSpeech: Timeline | null = null;
  private cacheStreamVersion = -1;
  private cacheSpeechVersion = -1;
  private mergedEvents: VisemeEvent[] = [];
  private mergedSegments: Segment[] = [];

  constructor(options: TalkingAvatarOptions) {
    this.modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
    this.streamDelayS = (options.streamDelayMs ?? DEFAULT_STREAM_DELAY_MS) / 1000;
    this.onError = options.onError ?? ((error) => console.error(error));
    this.renderer = this.createRenderer(options.container, () => this.frameNow());
    this.ready = this.setAvatar(options.avatarUrl ?? AVATARS.female, options.morphTargets);
    this.ready.catch(() => {}); // reported through onError; awaiting `ready` is optional
    loadModel(this.modelUrl).catch((error: Error) => this.onError(error)); // warm up
  }

  /** Construct the renderer. Overridable internally (e.g. tests) without changing the public API. */
  protected createRenderer(
    container: HTMLElement,
    getFrame: () => { visemes: Record<string, number>; mode: Mode },
  ): AvatarRenderer {
    return new AvatarRenderer(container, getFrame);
  }

  /**
   * How the avatar behaves while it isn't speaking: "listening" (default) or "thinking" (e.g. while your agent is
   * generating a reply). Speaking is detected automatically from its audio and takes priority.
   */
  setStatus(status: AvatarStatus): void {
    this.status = status;
  }

  /** Swap the avatar (with its own `morphTargets`, if it needs them). Resolves when the new one is on screen. */
  setAvatar(url: string, morphTargets?: MorphTargetMap): Promise<void> {
    return this.renderer.load(url, morphTargets).catch((error: Error) => {
      this.onError(error);
      throw error;
    });
  }

  /**
   * Lip sync a live audio stream (WebRTC, getUserMedia, captureStream…). The avatar plays it, `streamDelayMs`
   * late. Replaces any previously attached stream.
   */
  async attachStream(stream: MediaStream): Promise<void> {
    this.detachStream();
    if (!stream.getAudioTracks().length) throw new Error("talking-avatar: the stream has no audio track");
    const token = ++this.streamToken;
    const [context, model] = await Promise.all([this.audioContext(), loadModel(this.modelUrl)]);
    // A newer attachStream/detachStream (or dispose) won while we waited: never touch the audio graph.
    if (this.disposed || token !== this.streamToken) return;

    // Chrome only feeds a remote (WebRTC) stream into Web Audio while a media element is playing it.
    const element = new Audio();
    element.muted = true;
    element.srcObject = stream;
    element.play().catch(() => {});
    const source = context.createMediaStreamSource(stream);
    const delay = context.createDelay(Math.max(1, this.streamDelayS * 2));
    delay.delayTime.value = this.streamDelayS;
    source.connect(delay).connect(context.destination);
    const capture = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
    });
    source.connect(capture);

    const attached: AttachedStream = {
      source, delay, capture, element, detector: null, expectedTime: 0, timeline: new Timeline(),
    };
    capture.port.onmessage = ({ data }: MessageEvent<{ time: number; samples: Float32Array }>) => {
      if (this.disposed || this.stream !== attached) return;
      try {
        // (Re)start the timeline when capture begins or after a gap (e.g. the context was suspended).
        if (!attached.detector || Math.abs(data.time - attached.expectedTime) > STREAM_GAP_S) {
          attached.detector?.flush();
          const heardAtMs = (data.time + this.streamDelayS) * 1000;
          attached.detector = new VisemeDetector(model, context.sampleRate, heardAtMs,
            (event) => attached.timeline.add(event, this.heardMs()));
        }
        attached.detector.push(data.samples);
        attached.expectedTime = data.time + data.samples.length / context.sampleRate;
      } catch (error) {
        this.onError(error as Error);
      }
    };
    this.stream = attached;
  }

  /** Stop playing and lip syncing the attached stream. Its timeline is dropped; a speaking clip's is untouched. */
  detachStream(): void {
    this.streamToken += 1; // any attachStream still awaiting its context/model is now stale
    const attached = this.stream;
    if (!attached) return;
    this.stream = null;
    attached.capture.port.onmessage = null;
    attached.source.disconnect();
    attached.delay.disconnect();
    attached.capture.disconnect();
    attached.element.srcObject = null;
  }

  /**
   * Play a clip (URL, encoded bytes or Blob, in any format the browser decodes) with lip sync. The whole clip is
   * analysed before it starts, so the mouth anticipates every sound. Resolves when it ends or is stopped.
   */
  async speak(audio: string | ArrayBuffer | Blob): Promise<void> {
    this.stopSpeaking();
    const token = ++this.speechToken;
    const stale = () => this.disposed || token !== this.speechToken;
    let bytes: ArrayBuffer;
    if (typeof audio === "string") {
      const res = await fetch(audio);
      if (!res.ok) throw new Error(`talking-avatar: ${audio}: HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    } else {
      bytes = audio instanceof Blob ? await audio.arrayBuffer() : audio.slice(0); // decodeAudioData detaches it
    }
    if (stale()) return; // stopSpeaking/new speak/dispose happened during fetch or Blob reading
    const [context, model] = await Promise.all([this.audioContext(), loadModel(this.modelUrl)]);
    if (stale()) return;
    const buffer = await context.decodeAudioData(bytes);
    if (stale()) return;

    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i += 1) mono[i] += channel[i] / buffer.numberOfChannels;
    }
    const clipEvents: VisemeEvent[] = [];
    const detector = new VisemeDetector(model, buffer.sampleRate, 0, (event) => clipEvents.push(event));
    const chunk = Math.round(buffer.sampleRate * ANALYSIS_CHUNK_S);
    for (let i = 0; i < mono.length; i += chunk) {
      detector.push(mono.subarray(i, i + chunk));
      await new Promise((resolve) => setTimeout(resolve)); // yield between chunks
      if (stale()) return; // cancelled mid-analysis: no audio source is scheduled and no events are written
    }
    detector.flush();
    if (stale()) return;

    const timeline = new Timeline();
    const startAt = context.currentTime + SPEAK_START_MS / 1000;
    for (const event of clipEvents) timeline.add({ id: event.id, ms: startAt * 1000 + event.ms }, this.heardMs());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Resolve on both natural end and stop(), but only mutate state for a still-current clip (stale calls were
    // already cleaned up by stopSpeaking/dispose).
    const ended = new Promise<void>((resolve) => {
      source.onended = () => {
        if (!stale()) {
          this.speech = null;
          this.speechTimeline = null;
        }
        resolve();
      };
    });
    source.start(startAt);
    this.speech = source;
    this.speechTimeline = timeline;
    await ended;
  }

  /** Stop any clip started with speak(). Its residual events leave the merged view immediately; the stream's stay. */
  stopSpeaking(): void {
    this.speechToken += 1; // any speak() still fetching/analysing/scheduling is now stale
    const source = this.speech;
    if (!source) return;
    this.speech = null;
    this.speechTimeline = null;
    source.stop();
    source.disconnect();
  }

  /** Release the renderer, audio and model references. The instance can't be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpeaking();
    this.detachStream();
    this.renderer.dispose();
    void this.context?.close();
  }

  private async audioContext(): Promise<AudioContext> {
    this.contextReady ??= (async () => {
      const context = new AudioContext({ latencyHint: "interactive" });
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } catch (error) {
        void context.close(); // don't leak a context per failed attempt now that we retry
        throw error;
      } finally {
        URL.revokeObjectURL(url);
      }
      this.context = context;
      return context;
    })().catch((error) => {
      this.contextReady = null; // a failed attempt isn't cached; a later call retries (as loadModel does)
      throw error;
    });
    const context = await this.contextReady;
    if (context.state === "suspended") await context.resume();
    return context;
  }

  /** The audio-context time (ms) currently coming out of the speakers. */
  private heardMs(): number {
    const { context } = this;
    if (!context) return 0;
    const stamp = context.state === "running" ? context.getOutputTimestamp?.() : undefined;
    if (stamp?.contextTime && stamp.performanceTime) {
      return stamp.contextTime * 1000 + (performance.now() - stamp.performanceTime);
    }
    return (context.currentTime - (context.outputLatency || 0)) * 1000;
  }

  private frameNow(): { visemes: Record<string, number>; mode: Mode } {
    const streamTimeline = this.stream?.timeline ?? null;
    const speechTimeline = this.speechTimeline;
    if (streamTimeline !== this.cacheStream
      || speechTimeline !== this.cacheSpeech
      || (streamTimeline?.version ?? 0) !== this.cacheStreamVersion
      || (speechTimeline?.version ?? 0) !== this.cacheSpeechVersion) {
      this.cacheStream = streamTimeline;
      this.cacheSpeech = speechTimeline;
      this.cacheStreamVersion = streamTimeline?.version ?? 0;
      this.cacheSpeechVersion = speechTimeline?.version ?? 0;
      this.mergedEvents = mergeTimelines(streamTimeline, speechTimeline);
      this.mergedSegments = this.mergedEvents.length ? buildSegments(this.mergedEvents) : [];
    }
    if (!this.mergedEvents.length) return { visemes: {}, mode: this.status };
    const now = this.heardMs();
    return {
      visemes: mouthAt(this.mergedSegments, now),
      mode: isSpeakingAt(this.mergedEvents, now) ? "speaking" : this.status,
    };
  }
}
