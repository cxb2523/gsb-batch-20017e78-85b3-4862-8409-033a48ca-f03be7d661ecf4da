import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';

// The Atmosphere's bookkeeping round a renderer that does nothing: what gets
// drawn when there is no loop to draw it. A canvas here is only its numbers.

const { made, FakeRenderer, atStart } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeRenderer>[] = [];
  // whether a renderer is made with its variant already linked (compile on the spot)
  const atStart = { linked: false };
  class FakeRenderer {
    available = true;
    ready = false;
    colorSpace = 'srgb';
    cloudScale = 1;
    rays = 0;
    cumulonimbus = 'auto';
    render = vi.fn();
    prepare = vi.fn();
    probe = vi.fn();
    dispose = vi.fn();
    // what isSettled answers: flipped by the tests as variants start and land
    linked = atStart.linked;
    isSettled = vi.fn(() => this.available && this.linked);
    takeGpuTimes = (): { ms: number; pixels: number }[] => [];
    readonly canvas: HTMLCanvasElement;
    readonly opts: { onReady?: (available: boolean) => void; onLinked?: () => void };
    constructor(canvas: HTMLCanvasElement, opts: FakeRenderer['opts']) {
      this.canvas = canvas;
      this.opts = opts;
      made.push(this);
    }
    resize(w: number, h: number) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  return { made, FakeRenderer, atStart };
});

vi.mock('../src/renderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer.js')>(),
  AtmosphereRenderer: FakeRenderer,
}));

const sized = (w: number, h: number) =>
  ({ width: 0, height: 0, clientWidth: w, clientHeight: h }) as HTMLCanvasElement;

function mount(options: ConstructorParameters<typeof Atmosphere>[1], canvas = sized(640, 360)) {
  const sky = new Atmosphere(canvas, { resolutionScale: 1, ...options });
  return { sky, canvas, renderer: made[made.length - 1] };
}

function reduceMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  made.length = 0;
  atStart.linked = false;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  reduceMotion(false);
});

afterEach(() => vi.unstubAllGlobals());

it('paints the sunset into the new buffer on the frame that changes resolution', () => {
  const { sky, canvas, renderer } = mount({ adaptiveResolution: true });
  const pixels = canvas.width * canvas.height;
  renderer.takeGpuTimes = () => Array.from({ length: 12 }, () => ({ ms: 100, pixels }));
  let paintedPixels = 0;
  renderer.render.mockImplementation(() => { paintedPixels = canvas.width * canvas.height; });
  sky.jump({ time: 17.8, weather: 'fair', ground: 'sea' });
  expect(canvas.width * canvas.height).toBeLessThan(pixels);
  expect(paintedPixels).toBe(canvas.width * canvas.height);
});

describe('a still frame under reduced motion', () => {
  beforeEach(() => reduceMotion(true));

  it('is drawn again after a resize, which clears the canvas', () => {
    const { sky, canvas, renderer } = mount({});
    expect(renderer.render).toHaveBeenCalledTimes(1);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(canvas.width).toBe(800);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is not drawn again when the size has not changed', () => {
    const { sky, renderer } = mount({});
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('is the same moment each time, so a redraw moves nothing', () => {
    const { sky, canvas, renderer } = mount({});
    const wind = sky.state.timeOfDay;
    const first = renderer.render.mock.calls[0];
    const windOff = first[3], evo = first[4], time = first[0];
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    const again = renderer.render.mock.calls[1];
    expect(again[0]).toBe(time);
    expect(again[3]).toBe(windOff);
    expect(again[4]).toBe(evo);
    expect(sky.state.timeOfDay).toBe(wind);
  });

  it('is drawn again when the variant it needed has linked', () => {
    const { renderer } = mount({});
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });
});

describe('a jump() with no loop', () => {
  it('is drawn when the shader comes ready, though start() was never called', () => {
    const { sky, renderer } = mount({ autoStart: false });
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);   // too early: this one draws nothing
    renderer.opts.onReady?.(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('stays up through a resize', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    (canvas as { clientHeight: number }).clientHeight = 500;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is forgotten by stop()', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    sky.stop();
    renderer.opts.onReady?.(true);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('with nothing asked for', () => {
  it('draws nothing when the shader comes ready or the canvas resizes', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('still tells the caller the shader is ready', () => {
    const onReady = vi.fn();
    const { renderer } = mount({ autoStart: false, onReady });
    renderer.opts.onReady?.(true);
    expect(onReady).toHaveBeenCalledWith(true);
  });
});

describe('a running loop', () => {
  it('is left to its next tick', () => {
    const { sky, canvas, renderer } = mount({});
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('out of view', () => {
  let tick: (t: number) => void;
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null;
  let watching: boolean;
  const inDocument = () => ({ ...sized(640, 360), isConnected: true }) as HTMLCanvasElement;
  const view = (isIntersecting: boolean) => seen?.([{ isIntersecting }]);

  beforeEach(() => {
    seen = null;
    watching = false;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() { watching = true; }
      disconnect() { watching = false; }
    });
  });

  it('draws nothing, and draws again on the way back without waiting for a tick', () => {
    const { renderer } = mount({ fps: 60 }, inDocument());
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(false);
    tick(200);
    tick(300);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    tick(400);
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });

  it('goes on with the clocks, so the sky comes back where it would have been', () => {
    const { sky, renderer } = mount({ fps: 60 }, inDocument());
    const before = sky.state;
    tick(1000);
    const evo = renderer.render.mock.calls[0][4];
    view(false);
    for (let t = 1100; t < 3000; t += 100) tick(t);
    view(true);
    expect(renderer.render.mock.calls[1][4]).toBeGreaterThan(evo + 0.05);
    expect(sky.state.timeOfDay).toBeCloseTo(before.timeOfDay);
  });

  it('still draws what it is asked to with no loop running', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    view(false);
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('does not draw on the way back with the loop stopped', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    sky.start();
    sky.stop();
    view(false);
    view(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws on a canvas outside the document, which never intersects anything', () => {
    const { renderer } = mount({ fps: 60 });
    view(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('draws on under pauseOffscreen: false, watching nothing', () => {
    const { renderer } = mount({ fps: 60, pauseOffscreen: false }, inDocument());
    expect(watching).toBe(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('stops watching when disposed', () => {
    const { sky } = mount({}, inDocument());
    expect(watching).toBe(true);
    sky.dispose();
    expect(watching).toBe(false);
  });

  it('repaints a still jump() frame on the way back, though no loop is running', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(false);
    view(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('repaints a reduced-motion still frame on the way back', () => {
    reduceMotion(true);
    const { sky, renderer } = mount({}, inDocument());
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(false);
    view(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(sky.state).toBeDefined();
  });
});

describe('settling', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });

  /** a set() that needs a variant the renderer has not got */
  const needsNew = (renderer: InstanceType<typeof FakeRenderer>) =>
    renderer.prepare.mockImplementation(() => { renderer.linked = false; });
  /** the variant landing */
  const link = (renderer: InstanceType<typeof FakeRenderer>) => { renderer.linked = true; renderer.opts.onLinked?.(); };

  it('says so once the first variant is in and has been drawn', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    expect(sky.settled).toBe(false);
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    // (the loop draws it on its next tick, and says so then)
    expect(onSettled).not.toHaveBeenCalled();
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('goes unsettled on a set() that needs a new variant, and settles again once it is in', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);

    needsNew(renderer);
    sky.set({ weather: 'rain' });
    expect(sky.settled).toBe(false);
    const waiting = sky.whenSettled();
    frame();
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    await expect(waiting).resolves.toBe(true);
  });

  it('says nothing for a set() that needs no new variant', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    sky.set({ time: 15 });
    frame();
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles as soon as the variant lands with no loop to draw it', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, onSettled });
    needsNew(renderer);
    sky.set({ weather: 'rain' });
    link(renderer);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws a still frame again before it says so, under reduced motion', () => {
    reduceMotion(true);
    const onSettled = vi.fn(() => expect(renderer.render).toHaveBeenCalledTimes(2));
    const { sky, renderer } = mount({ onSettled });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    link(renderer);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(sky.settled).toBe(true);
  });

  it('is settled from the start where the shader compiles on the spot', async () => {
    const onSettled = vi.fn();
    atStart.linked = true;
    const { sky } = mount({ autoStart: false, onSettled });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
  });

  it('says false, and lets the waiters go, when the sky will never draw', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    const waiting = sky.whenSettled();
    renderer.available = false;
    renderer.opts.onReady?.(false);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(waiting).resolves.toBe(false);
    await expect(sky.whenSettled()).resolves.toBe(false);
    expect(sky.settled).toBe(false);
  });

  it('lets the waiters go when disposed first', async () => {
    const { sky } = mount({ fps: 60 });
    const waiting = sky.whenSettled();
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
  });
});

// A fake document for the visibilitychange listener, with the same capture
// shape as the real one: Atmosphere adds and removes one listener.
interface FakeDocument {
  visibilityState: 'visible' | 'hidden';
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  listeners: Record<string, (() => void)[]>;
  hidden(): void;
  shown(): void;
}

function fakeDocument(initial: 'visible' | 'hidden' = 'visible'): FakeDocument {
  const doc: FakeDocument = {
    visibilityState: initial,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    },
    hidden() { this.visibilityState = 'hidden'; this.listeners.visibilitychange?.forEach((f) => f()); },
    shown() { this.visibilityState = 'visible'; this.listeners.visibilitychange?.forEach((f) => f()); },
  };
  return doc;
}

describe('a background tab', () => {
  let tick: (t: number) => void;
  let doc: FakeDocument;
  let rafs: number;
  let cancelled: number[];
  let clock: number;

  beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal('document', doc);
    rafs = 0;
    cancelled = [];
    clock = 0;
    vi.stubGlobal('performance', { now: () => clock });
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return ++rafs; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); });
  });

  it('stops the loop while hidden and draws one catch-up frame on return', () => {
    const { renderer } = mount({ fps: 60 });
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);

    clock = 500;
    doc.hidden();
    expect(cancelled).toContain(rafs);
    // a hidden document gets no rAF callbacks at all, and nothing draws:
    // the loop really is off
    expect(renderer.render).toHaveBeenCalledTimes(1);

    clock = 2500;
    doc.shown();
    // immediately, without waiting for a tick
    expect(renderer.render).toHaveBeenCalledTimes(2);
    // and the loop is running again afterwards
    tick(2600);
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });

  it('makes the one frame on return cover the whole hidden interval', () => {
    const { sky, renderer } = mount({ fps: 60 });
    tick(100);
    tick(200);
    const before = sky.state;
    const evoBefore = renderer.render.mock.calls.at(-1)![4] as number;

    clock = 300;
    doc.hidden();
    clock = 5300;
    doc.shown();
    expect(renderer.render).toHaveBeenCalledTimes(3);

    // the animator moved as much as it would have across five live seconds,
    // not as across a single clamped 0.2s frame
    const evoAfter = renderer.render.mock.calls.at(-1)![4] as number;
    expect(evoAfter - evoBefore).toBeGreaterThan(0.2);
    // a continuously-ticked sky over the same five seconds lands here too:
    // the time-of-day target is fixed, so both follow it to the same place
    expect(sky.state.timeOfDay).toBeCloseTo(before.timeOfDay, 10);
  });

  it('takes no measurements while hidden and measures again on the return frame', () => {
    const { sky, renderer } = mount({ fps: 60, lightProbe: { rate: 10, smoothing: 0.3 } });
    renderer.probe.mockReturnValue(measurement([0.5, 0.5, 0.5]));
    tick(100);
    expect(renderer.probe).toHaveBeenCalledTimes(1);

    clock = 500;
    doc.hidden();
    expect(renderer.probe).toHaveBeenCalledTimes(1);

    clock = 900;
    doc.shown();
    expect(renderer.probe).toHaveBeenCalledTimes(2);
    expect(sky.light.frame).not.toBeNull();
  });

  it('does not start a loop when constructed hidden, and starts on show with the gap made up', () => {
    const hiddenDoc = fakeDocument('hidden');
    vi.stubGlobal('document', hiddenDoc);
    const { renderer } = mount({ fps: 60 });
    expect(rafs).toBe(0);
    expect(renderer.render).not.toHaveBeenCalled();

    // the whole hidden interval, including the time before the first frame:
    // the integrated clocks must move by it on the catch-up frame, not start
    // from zero (the animator begins on its target, so that movement shows up
    // in the wind/evolution offsets rather than in timeOfDay)
    clock = 4000;
    hiddenDoc.shown();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    const evo = renderer.render.mock.calls[0][4] as number;
    expect(evo).toBeGreaterThan(0.2);
    tick(4100);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('repaints a still jump() frame when the tab comes back, though no loop runs', () => {
    const { sky, renderer } = mount({ autoStart: false });
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);

    clock = 500;
    doc.hidden();
    clock = 1500;
    doc.shown();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    // a still frame is the same moment: nothing advanced while away
    const [first, again] = renderer.render.mock.calls;
    expect(again[0]).toBe(first[0]);
    expect(again[3]).toBe(first[3]);
  });

  it('repaints a reduced-motion still frame when the tab comes back', () => {
    reduceMotion(true);
    const { renderer } = mount({});
    expect(renderer.render).toHaveBeenCalledTimes(1);
    clock = 500;
    doc.hidden();
    clock = 1500;
    doc.shown();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('does nothing on show when stopped, and does not register the listener twice over start/stop', () => {
    const { sky, renderer } = mount({ fps: 60 });
    expect(doc.listeners.visibilitychange).toHaveLength(1);
    sky.stop();
    sky.start();
    sky.stop();
    expect(doc.listeners.visibilitychange).toHaveLength(1);

    clock = 500;
    doc.hidden();
    clock = 1500;
    doc.shown();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('removes the visibility listener on dispose, after which visibility changes are harmless', () => {
    const { sky } = mount({ fps: 60 });
    expect(doc.listeners.visibilitychange).toHaveLength(1);
    sky.dispose();
    expect(doc.listeners.visibilitychange).toHaveLength(0);
    expect(() => { doc.hidden(); doc.shown(); }).not.toThrow();
  });

  it('resolves a pending whenSettled() with false on dispose', async () => {
    const { sky } = mount({ fps: 60 });
    const waiting = sky.whenSettled();
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
  });
});

describe('the light probe across a pause', () => {
  let tick: (t: number) => void;
  let doc: FakeDocument;
  let clock: number;
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null;
  const inDocument = () => ({ ...sized(640, 360), isConnected: true }) as HTMLCanvasElement;
  const view = (isIntersecting: boolean) => seen?.([{ isIntersecting }]);

  beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal('document', doc);
    seen = null;
    clock = 0;
    vi.stubGlobal('performance', { now: () => clock });
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() {}
      disconnect() {}
    });
  });

  const mountProbe = (smoothing: number) =>
    mount({ fps: 60, lightProbe: { rate: 1000, smoothing } }, inDocument());

  it('smooths the first measurement back over the real hidden interval', () => {
    const { sky, renderer } = mountProbe(1);
    // the pre-pause series: a black sky, on every frame up to the hide
    renderer.probe.mockImplementation(() => measurement([0, 0, 0]));
    tick(100);
    tick(500);
    expect(renderer.probe).toHaveBeenCalled();
    expect(sky.light.frame!.average.linear[0]).toBe(0);

    // hidden for 1s — one time constant: the new reading is weighted
    // 1 - e^-1 ≈ 0.632, not treated as a frame's little step
    doc.hidden();
    clock = 1500;
    renderer.probe.mockImplementationOnce(() => measurement([1, 1, 1]));
    doc.shown();
    expect(sky.light.frame!.average.linear[0]).toBeCloseTo(1 - Math.exp(-1), 10);
  });

  it('takes the new measurement whole once the gap runs past a few time constants', () => {
    const { sky, renderer } = mountProbe(0.3);
    renderer.probe.mockImplementation(() => measurement([0, 0, 0]));
    tick(100);
    tick(500);

    // hidden for 5s — over 4× the 0.3s time constant, so no interpolation
    // across the blank
    doc.hidden();
    clock = 5500;
    renderer.probe.mockImplementationOnce(() => measurement([1, 1, 1]));
    doc.shown();
    expect(sky.light.frame!.average.linear[0]).toBe(1);
  });

  it('keeps measuring normally across an offscreen pause once it is back in view', () => {
    const { sky, renderer } = mountProbe(0.3);
    renderer.probe.mockReturnValue(measurement([0.2, 0.4, 0.6]));
    tick(100);
    const before = renderer.probe.mock.calls.length;

    view(false);
    clock = 200;
    tick(200);
    expect(renderer.probe).toHaveBeenCalledTimes(before);

    clock = 300;
    view(true);
    expect(renderer.probe).toHaveBeenCalledTimes(before + 1);
    expect(sky.light.frame!.average.linear[0]).toBeCloseTo(0.2, 10);
  });
});

/** a valid-shaped probe result whose whole frame is one linear color */
function measurement(linear: [number, number, number]) {
  const sample = { srgb: linear, linear: [...linear] as [number, number, number], luminance: linear[1] };
  return {
    frame: { average: sample, grid: { cols: 1, rows: 1, cells: [sample] } },
    environment: null,
  } as unknown as import('../src/light.js').LightMeasurement;
}
