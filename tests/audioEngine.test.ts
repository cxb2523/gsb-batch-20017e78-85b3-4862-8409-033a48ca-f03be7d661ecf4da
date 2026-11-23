import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal browser shims so AudioEngine can run under Node with no real speech
// synthesis. Nothing here talks to the OS voice synthesizer.
// ---------------------------------------------------------------------------

interface FakeGainParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
}

class FakeAudioContext {
  public currentTime = 0;
  public state: 'running' | 'suspended' = 'running';
  public destination = {};
  public sampleRate = 48000;
  public gains: FakeGainParam[] = [];

  createGain() {
    const param: FakeGainParam = {
      value: 1,
      setValueAtTime(v: number) {
        param.value = v;
      },
      linearRampToValueAtTime(v: number) {
        param.value = v;
      },
      exponentialRampToValueAtTime(v: number) {
        param.value = Math.max(0.0001, v);
      },
      cancelScheduledValues() {},
    };
    this.gains.push(param);
    return { gain: param, connect() {}, disconnect() {} };
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    };
  }
  createBiquadFilter() {
    return {
      type: 'lowpass',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      Q: { value: 1 },
      connect() {},
    };
  }
  createBuffer(_ch: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {} };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onboundary: ((e: { name: string; charIndex: number; charLength?: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSpeechSynthesis {
  public spoken: FakeUtterance[] = [];
  public cancels = 0;
  getVoices() {
    return [];
  }
  speak(u: FakeUtterance) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancels++;
  }
}

class FakeAudioElement {
  public src: string;
  public currentTime = 0;
  public paused = false;
  public onended: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public static instances: FakeAudioElement[] = [];
  constructor(src: string) {
    this.src = src;
    FakeAudioElement.instances.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const audioEngineModule = await import('../src/utils/audioEngine');
const { AudioEngine } = audioEngineModule;

function installBrowserShims() {
  const ctx = new FakeAudioContext();
  const speech = new FakeSpeechSynthesis();
  (globalThis as any).window = {
    AudioContext: function () {
      return ctx;
    },
    speechSynthesis: speech,
  };
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as any).Audio = FakeAudioElement;
  FakeAudioElement.instances = [];
  return { ctx, speech };
}

function removeBrowserShims() {
  delete (globalThis as any).window;
  delete (globalThis as any).SpeechSynthesisUtterance;
  delete (globalThis as any).Audio;
}

/** Flush pending fake timer ticks without waiting on wall clock. */
function tick(context: any, ms: number) {
  context.mock.timers.tick(ms);
}

describe('AudioEngine narration sessions', () => {
  let engine: InstanceType<typeof AudioEngine>;
  let shims: ReturnType<typeof installBrowserShims>;

  beforeEach(() => {
    shims = installBrowserShims();
    engine = new AudioEngine();
  });

  afterEach(() => {
    engine.dispose();
    removeBrowserShims();
  });

  test('speak starts a session, ducks music, and stop restores volume', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const words: Array<[string, number]> = [];
    const id = engine.speakNarration('alpha beta gamma', (w, _c, i) => words.push([w, i]));

    assert.ok(id > 0);
    assert.equal(engine.isSpeaking(), true);
    assert.equal(engine.isNarrationActive(), true);
    assert.equal(engine.isDuckingActive(), true);
    assert.equal(shims.speech.spoken.length, 1);

    engine.stopNarration();
    assert.equal(engine.isNarrationActive(), false);
    assert.equal(engine.isDuckingActive(), false, 'music must be restored when narration stops');
    assert.equal(engine.getMusicGainTarget(), audioEngineModule.MUSIC_LEVEL);

    // The fallback timer must be gone: ticking further produces no extra words.
    const before = words.length;
    tick(t, 1000);
    assert.equal(words.length, before);
  });

  test('fallback timer reports words when the OS sends no boundaries', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const words: Array<[string, number]> = [];
    engine.speakNarration('alpha beta gamma delta', (w, _c, i) => words.push([w, i]));

    tick(t, 400);
    tick(t, 400);
    assert.deepEqual(
      words.map(([w]) => w),
      ['alpha', 'beta']
    );
    assert.deepEqual(
      words.map(([, i]) => i),
      [0, 1]
    );
  });

  test('starting a new narration invalidates the previous fallback timer and callbacks', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const firstWords: string[] = [];
    const secondWords: Array<[string, number]> = [];

    engine.speakNarration('one two three', (w) => firstWords.push(w));
    tick(t, 400);
    const firstCount = firstWords.length;
    assert.ok(firstCount >= 1);

    engine.speakNarration('uno dos tres', (w, _c, i) => secondWords.push([w, i]));
    tick(t, 600);

    assert.equal(firstWords.length, firstCount, 'old scene timer must not keep firing');
    assert.ok(secondWords.length >= 1);
    assert.ok(secondWords.every(([, i]) => i < 3));
  });

  test('late onend / onerror from an old utterance cannot touch the new session', () => {
    let oldEnd = 0;
    const oldId = engine.speakNarration('old scene words', undefined, () => oldEnd++);
    const oldUtterance = shims.speech.spoken[0];

    let newEnd = 0;
    const newId = engine.speakNarration('new scene words', undefined, () => newEnd++);
    assert.notEqual(oldId, newId);
    assert.equal(engine.isDuckingActive(), true);
    // Superseding a narration notifies its owner exactly once so it can drop stale state.
    assert.equal(oldEnd, 1);

    oldUtterance.onend?.();
    oldUtterance.onerror?.();
    assert.equal(oldEnd, 1, 'stale end/error callbacks must be ignored');
    assert.equal(newEnd, 0);
    assert.equal(engine.getActiveSessionId(), newId);
    assert.equal(engine.isDuckingActive(), true, 'stale end must not un-duck the new session');
  });

  test('native word boundary cancels the fallback timer and updates the word index', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const seen: Array<[string, number]> = [];
    engine.speakNarration('create a database cluster', (w, _c, i) => seen.push([w, i]));
    const utterance = shims.speech.spoken[0];

    utterance.onboundary?.({ name: 'word', charIndex: 9 });
    assert.deepEqual(seen, [['database', 2]]);
    assert.equal(engine.getCurrentWord().index, 2);

    const count = seen.length;
    tick(t, 2000);
    assert.equal(seen.length, count, 'fallback timer cancelled after a native boundary');
  });

  test('startWordIndex offsets the reported word indices', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const seen: number[] = [];
    engine.speakNarration('one two three four five', (_w, _c, i) => seen.push(i), undefined, 1, 1, {
      startWordIndex: 3,
    });
    tick(t, 400);
    assert.deepEqual(seen, [3]);
    assert.equal(shims.speech.spoken[0].text, 'four five');
  });
});

describe('AudioEngine ducking + music coordination', () => {
  let engine: InstanceType<typeof AudioEngine>;
  let shims: ReturnType<typeof installBrowserShims>;

  beforeEach(() => {
    shims = installBrowserShims();
    engine = new AudioEngine();
  });

  afterEach(() => {
    engine.dispose();
    removeBrowserShims();
  });

  test('music never stays ducked without narration', () => {
    engine.setDucking(true);
    assert.equal(engine.isDuckingActive(), false);
    assert.equal(engine.getMusicGainTarget(), audioEngineModule.MUSIC_LEVEL);
  });

  test('autoDuck off means narration does not duck, and turning it on ducks mid-speech', () => {
    engine.setAutoDuck(false);
    engine.speakNarration('hello world');
    assert.equal(engine.isDuckingActive(), false);

    engine.setAutoDuck(true);
    assert.equal(engine.isDuckingActive(), true);
    assert.equal(engine.getMusicGainTarget(), audioEngineModule.MUSIC_DUCK_LEVEL);

    engine.setAutoDuck(false);
    assert.equal(engine.isDuckingActive(), false);
    assert.equal(engine.getMusicGainTarget(), audioEngineModule.MUSIC_LEVEL);
  });

  test('startMusic is idempotent and stopMusic clears the chord interval', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    engine.startMusic('lofi');
    assert.equal(engine.isMusicActive(), true);
    engine.startMusic('lofi');
    assert.equal(engine.isMusicActive(), true);

    engine.stopMusic();
    assert.equal(engine.isMusicActive(), false);

    // Starting again after a stop works (music toggle off -> on).
    engine.startMusic('tech');
    assert.equal(engine.isMusicActive(), true);
    assert.equal(engine.getCurrentTrack(), 'tech');
  });

  test('custom audio uses the session model and ignores stale ended events', () => {
    let firstEnd = 0;
    const first = engine.playCustomAudio('blob:first', () => firstEnd++);
    const firstEl = FakeAudioElement.instances[0];
    assert.ok(first > 0);
    assert.equal(engine.isDuckingActive(), true);

    let secondEnd = 0;
    const second = engine.playCustomAudio('blob:second', () => secondEnd++);
    assert.notEqual(first, second);
    assert.equal(firstEl.paused, true, 'previous clip is paused by the new session');

    // Stopping the first clip already notified its owner exactly once; the
    // browser's late `ended` event must not fire it a second time.
    const firstEndAfterStop = firstEnd;
    assert.equal(firstEndAfterStop, 1);
    firstEl.onended?.();
    assert.equal(firstEnd, firstEndAfterStop);
    assert.equal(engine.getActiveSessionId(), second);

    const secondEl = FakeAudioElement.instances[1];
    secondEl.onended?.();
    assert.equal(secondEnd, 1);
    assert.equal(engine.isNarrationActive(), false);
    assert.equal(engine.isDuckingActive(), false);
  });

  test('stopNarration tears down the custom clip and restores music', () => {
    engine.playCustomAudio('blob:clip');
    const el = FakeAudioElement.instances[0];
    engine.stopNarration();
    assert.equal(el.paused, true);
    assert.equal(el.currentTime, 0);
    assert.equal(engine.isNarrationActive(), false);
    assert.equal(engine.isDuckingActive(), false);
  });

  test('speaking with no speech support ends immediately without ducking', () => {
    removeBrowserShims();
    installBrowserShims();
    delete (globalThis as any).window.speechSynthesis;
    delete (globalThis as any).SpeechSynthesisUtterance;

    let ended = 0;
    const id = engine.speakNarration('no tts here', undefined, () => ended++);
    assert.equal(id, 0);
    assert.equal(ended, 1);
    assert.equal(engine.isDuckingActive(), false);
  });
});
