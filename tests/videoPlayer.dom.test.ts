/**
 * DOM-level integration test for the real <VideoPlayer /> component.
 *
 * It runs under jsdom with fake speechSynthesis / AudioContext injected, so no
 * real text-to-speech is used. It verifies the component actually wires the
 * player UI to the audio lifecycle (play/pause/seek/mute/music/scene).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// Browser environment (must exist before React is imported)
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});

const { window } = dom;
const g = globalThis as any;

g.window = window;
g.document = window.document;
Object.defineProperty(g, 'navigator', { value: window.navigator, configurable: true });
g.HTMLElement = window.HTMLElement;
g.HTMLCanvasElement = window.HTMLCanvasElement;
g.HTMLInputElement = window.HTMLInputElement;
g.Event = window.Event;
g.PointerEvent = window.PointerEvent ?? window.Event;
g.getComputedStyle = window.getComputedStyle.bind(window);
g.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

// Silence jsdom's "canvas not implemented" noise.
const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = String(args[0] ?? '');
  if (first.includes('Not implemented: HTMLCanvasElement')) return;
  originalError(...args);
};

// --- fake speech synthesis -------------------------------------------------
const spoken: any[] = [];
let currentUtterance: any = null;

const speech = {
  speaking: false,
  paused: false,
  pending: false,
  onvoiceschanged: null,
  getVoices: () => [],
  speak(u: any) {
    spoken.push(u);
    currentUtterance = u;
    speech.speaking = true;
  },
  cancel() {
    speech.speaking = false;
    currentUtterance = null;
  },
  pause() {},
  resume() {},
};

class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onboundary: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true });
(g as any).SpeechSynthesisUtterance = FakeUtterance;

// --- fake AudioContext -----------------------------------------------------
class FakeParam {
  value = 1;
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = Math.max(0.0001, v);
  }
  cancelScheduledValues() {}
}
let musicGainParam: FakeParam | null = null;
let gainCount = 0;

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  sampleRate = 8000;
  createGain() {
    const gain = new FakeParam();
    gainCount++;
    if (gainCount === 2) musicGainParam = gain; // master, then music
    return { gain, connect() {}, disconnect() {} };
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
  createBuffer(_c: number, len: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {} };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}
(window as any).AudioContext = FakeAudioContext;

const makePointerEvent = (type: string, init: any = {}) => {
  const Ctor = (window as any).PointerEvent ?? window.MouseEvent;
  try {
    return new Ctor(type, init);
  } catch {
    return new window.MouseEvent(type, init);
  }
};

// --- test helpers ----------------------------------------------------------
const fireWord = (charIndex: number) => {
  currentUtterance?.onboundary?.({ name: 'word', charIndex, charLength: 0 });
};
const finishSpeech = () => {
  const u = currentUtterance;
  currentUtterance = null;
  u?.onend?.();
};
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('VideoPlayer DOM integration', () => {
  let React: typeof import('react');
  let createRoot: typeof import('react-dom/client').createRoot;
  let act: any;
  let VideoPlayer: any;
  let audioEngine: any;
  let container: HTMLDivElement;
  let root: any;

  const sceneA = {
    id: 'scene-a',
    title: 'Scene A',
    narration: 'alpha beta gamma delta epsilon zeta',
    elements: [
      { id: 'el-1', type: 'client', x: 10, y: 10, width: 100, height: 60, color: '#000', strokeWidth: 2, animation: 'pop', triggerTimeSec: 2 },
    ],
    durationSeconds: 6,
  };
  const sceneB = {
    id: 'scene-b',
    title: 'Scene B',
    narration: 'one two three four five six',
    elements: [],
    durationSeconds: 6,
  };

  const baseProps = {
    theme: 'whiteboard',
    selectedElementId: null,
    onSelectElement: () => {},
    onUpdateElementPosition: () => {},
    currentSceneIndex: 0,
    totalScenes: 2,
    onPrevScene: () => {},
    onNextScene: () => {},
    musicTrack: 'lofi',
    autoDuck: true,
    voiceRate: 1,
    voicePitch: 1,
    musicVolume: 0.25,
  };

  const render = async (props: any) => {
    await act(async () => {
      root.render(React.createElement(VideoPlayer, props));
    });
    await wait();
  };

  const buttonByTitle = (title: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === title
    ) as HTMLButtonElement | undefined;

  const click = async (title: string) => {
    const btn = buttonByTitle(title);
    assert.ok(btn, `expected button with title "${title}"`);
    await act(async () => {
      btn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await wait(40);
  };

  const activeWordIndex = (): number => {
    const spans = Array.from(container.querySelectorAll('p span'));
    return spans.findIndex((s) => (s as HTMLElement).className.includes('bg-amber-400'));
  };

  before(async () => {
    React = await import('react');
    const client = await import('react-dom/client');
    createRoot = client.createRoot;
    act = React.act;
    ({ VideoPlayer } = await import('../src/components/explainroo/VideoPlayer'));
    ({ audioEngine } = await import('../src/utils/audioEngine'));

    container = window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  after(async () => {
    await act(async () => root?.unmount());
    audioEngine.dispose();
    dom.window.close();
  });

  test('playing starts one narration and ducks music', async () => {
    spoken.length = 0;
    await render({ ...baseProps, scene: sceneA });
    await click('Play (Space)');

    assert.equal(spoken.length, 1, 'exactly one utterance started');
    assert.equal(audioEngine.isDuckingActive(), true);
    assert.ok(musicGainParam && musicGainParam.value < 0.2, `music gain ${musicGainParam?.value}`);
  });

  test('word boundary moves the subtitle highlight', async () => {
    await act(async () => {
      fireWord(18); // "gamma"
    });
    await wait(40);
    assert.ok(activeWordIndex() >= 1, `active index was ${activeWordIndex()}`);
  });

  test('pause stops narration and restores music', async () => {
    await click('Pause (Space)');
    assert.equal(audioEngine.isNarrationActive(), false);
    assert.equal(audioEngine.isDuckingActive(), false);
    assert.ok(musicGainParam && musicGainParam.value > 0.2, `music gain ${musicGainParam?.value}`);
  });

  test('resume does not stack narrations', async () => {
    const before = spoken.length;
    await click('Play (Space)');
    await click('Pause (Space)');
    await click('Play (Space)');
    assert.equal(spoken.length, before + 2, 'one utterance per resume');
    assert.equal(audioEngine.isNarrationActive(), true);
    await click('Pause (Space)');
  });

  test('seek restarts narration at the new word and moves the highlight', async () => {
    await click('Play (Space)');
    const before = spoken.length;
    const input = container.querySelector('input[type=range]') as HTMLInputElement;
    assert.ok(input);
    await act(async () => {
      input.dispatchEvent(makePointerEvent('pointerdown', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '5');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      input.dispatchEvent(makePointerEvent('pointerup', { bubbles: true }));
    });
    await wait(60);
    assert.equal(spoken.length, before + 1, 'exactly one restart after the drag ends');
    assert.ok(activeWordIndex() >= 3, `highlight followed the seek (${activeWordIndex()})`);
    assert.equal(audioEngine.isDuckingActive(), true);
    await click('Pause (Space)');
  });

  test('cue jump seeks without leaving the old word highlighted', async () => {
    await click('Play (Space)');
    await act(async () => {
      fireWord(30);
    });
    const cue = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.getAttribute('title') || '').startsWith('Jump to')
    ) as HTMLButtonElement;
    assert.ok(cue);
    await act(async () => {
      cue.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await wait(60);
    const idx = activeWordIndex();
    // trigger is 2s of 6s -> word index 2
    assert.equal(idx, 2, `expected highlight at word 2, got ${idx}`);
    await click('Pause (Space)');
  });

  test('scene change resets and rebinds narration', async () => {
    await click('Play (Space)');
    const before = spoken.length;
    await render({ ...baseProps, scene: sceneB, currentSceneIndex: 1 });
    assert.equal(spoken.length, before + 1, 'new scene starts its own narration');
    assert.equal(audioEngine.getActiveSessionId() !== 0, true);
    await click('Pause (Space)');
    assert.equal(audioEngine.isNarrationActive(), false);
    assert.equal(audioEngine.isDuckingActive(), false);
  });

  test('stale utterance callbacks from the previous scene cannot move the highlight', async () => {
    await render({ ...baseProps, scene: sceneA, currentSceneIndex: 0 });
    await click('Play (Space)');
    const staleUtterance = currentUtterance;

    await act(async () => {
      await Promise.resolve();
    });
    await render({ ...baseProps, scene: sceneB, currentSceneIndex: 1 });
    assert.notEqual(currentUtterance, staleUtterance, 'scene B has a fresh utterance');

    // Late boundary from scene A.
    await act(async () => {
      staleUtterance?.onboundary?.({ name: 'word', charIndex: 30, charLength: 0 });
    });
    await wait(40);
    assert.equal(activeWordIndex(), 0, 'stale word must not highlight scene B words');
    await click('Pause (Space)');
  });

  test('muting voice stops narration and unmuting restarts it once', async () => {
    await click('Play (Space)');
    await click('Voiceover Active');
    assert.equal(audioEngine.isNarrationActive(), false);
    assert.equal(audioEngine.isDuckingActive(), false);

    const before = spoken.length;
    await click('Voiceover Muted');
    assert.equal(spoken.length, before + 1);
    assert.equal(audioEngine.isNarrationActive(), true);
    await click('Pause (Space)');
  });

  test('disabling music stops narration; re-enabling restores music without stacking speech', async () => {
    await click('Play (Space)');
    await click('Music Enabled (Auto-Ducked)');
    assert.equal(audioEngine.isMusicActive(), false);
    assert.equal(audioEngine.isNarrationActive(), false);
    assert.equal(audioEngine.isDuckingActive(), false);

    const before = spoken.length;
    await click('Music Disabled');
    assert.equal(audioEngine.isMusicActive(), true);
    assert.equal(spoken.length, before, 're-enabling music does not restart narration');
    assert.equal(audioEngine.isNarrationActive(), false);
    await click('Pause (Space)');
  });

  test('rewind restarts narration from word zero', async () => {
    await click('Play (Space)');
    const before = spoken.length;
    await click('Rewind to start');
    assert.equal(spoken.length, before + 1);
    assert.equal(currentUtterance?.text, sceneB.narration);
    assert.equal(audioEngine.isNarrationActive(), true);
    await click('Pause (Space)');
  });
});
