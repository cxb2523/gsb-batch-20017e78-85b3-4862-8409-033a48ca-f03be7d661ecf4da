import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Player from 'video.js/dist/types/player';

/**
 * Minimal fake Video.js player: a root element, a progress control whose listeners
 * we can inspect, and a fixed duration. Geometry is stubbed because jsdom has no layout.
 */
interface FakeProgressControl {
  on(event: string, handler: (e: MouseEvent) => void): void;
  off(event: string, handler: (e: MouseEvent) => void): void;
  el(): HTMLElement;
  handlers: Map<string, Set<(e: MouseEvent) => void>>;
}

interface FakePlayer {
  player: Player;
  root: HTMLElement;
  progress: FakeProgressControl;
  barRect: { left: number; width: number };
  playerRect: { left: number; width: number };
  playerWidth: number;
}

function createFakePlayer(options?: {
  playerWidth?: number;
  barLeft?: number;
  barWidth?: number;
}): FakePlayer {
  const playerWidth = options?.playerWidth ?? 800;
  const barRect = { left: options?.barLeft ?? 0, width: options?.barWidth ?? 400 };
  const playerRect = { left: 0, width: playerWidth };

  const root = document.createElement('div');
  document.body.appendChild(root);

  const progressEl = document.createElement('div');
  root.appendChild(progressEl);
  progressEl.getBoundingClientRect = () =>
    ({ left: barRect.left, width: barRect.width, top: 0, height: 10, right: barRect.left + barRect.width, bottom: 10, x: barRect.left, y: 0, toJSON() {} }) as DOMRect;

  const handlers = new Map<string, Set<(e: MouseEvent) => void>>();
  const progress: FakeProgressControl = {
    handlers,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    el: () => progressEl,
  };

  root.getBoundingClientRect = () =>
    ({ left: playerRect.left, width: playerWidth, top: 0, height: 450, right: playerWidth, bottom: 450, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(root, 'offsetWidth', { configurable: true, value: playerWidth });

  const player = {
    el: () => root,
    duration: () => 100,
    controlBar: { progressControl: progress },
  } as unknown as Player;

  return {
    player,
    root,
    progress,
    barRect,
    playerRect: { left: playerRect.left, width: playerWidth },
    playerWidth,
  };
}

/** A fetch response whose resolution we control. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FetchCall {
  url: string;
  signal: AbortSignal | undefined;
  deferred: ReturnType<typeof deferred<{ ok: boolean; status: number; text: () => Promise<string> }>>;
}

const fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;

vi.mock('video.js', () => ({
  default: {
    log: {
      createLogger: () => ({ debug() {}, warn() {}, error() {} }),
    },
  },
}));

vi.mock('../javascript/utils', () => ({
  prepareSeekThumbnailVttSrc: vi.fn(async (source: { src: string }) => {
    const url = new URL(source.src);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/ik-seek-thumbnail-track.vtt`;
    return url.toString();
  }),
}));

// Import after mocks are registered.
const { SeekThumbnailsManager } = await import(
  '../javascript/modules/seek-thumbnails/seek-thumbnails-manager'
);

const PLAYER_OPTIONS = { imagekitId: 'ik', seekThumbnails: true } as any;

function vtt(cueUrl: string): string {
  return [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:10.000',
    cueUrl,
    '',
    '00:00:10.000 --> 00:00:20.000',
    cueUrl,
    '',
  ].join('\n');
}

function respondWith(call: FetchCall, body: string, ok = true, status = 200) {
  call.deferred.resolve({
    ok,
    status,
    text: async () => body,
  });
}

/** Let queued microtasks (and the async init chain) run. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function containers(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('.thumbnail-preview'));
}

function totalListenerCount(fake: FakePlayer): number {
  let count = 0;
  for (const set of fake.progress.handlers.values()) count += set.size;
  return count;
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchImpl = (url, init) => {
    const d = deferred<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }>();
    fetchCalls.push({ url, signal: init?.signal ?? undefined, deferred: d });
    return d.promise;
  };
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  document.body.innerHTML = '';
});

describe('SeekThumbnailsManager source switching', () => {
  it('ignores an older source whose VTT returns after a newer source', async () => {
    const fake = createFakePlayer();
    const sourceA = { src: 'https://cdn.example.com/a.mp4' };
    const sourceB = { src: 'https://cdn.example.com/b.mp4' };

    const initA = SeekThumbnailsManager.initSeekThumbnails(fake.player, sourceA, PLAYER_OPTIONS);
    await flush();
    expect(fetchCalls).toHaveLength(1);

    const initB = SeekThumbnailsManager.initSeekThumbnails(fake.player, sourceB, PLAYER_OPTIONS);
    await flush();
    expect(fetchCalls).toHaveLength(2);

    // New source resolves first and takes ownership of the single container/listener pair.
    respondWith(fetchCalls[1], vtt('https://cdn.example.com/b-sprite.jpg#xywh=0,0,80,45'));
    const mgrB = await initB;
    expect(mgrB).not.toBeNull();

    // Old source resolves afterwards: it must not create anything or publish itself.
    respondWith(fetchCalls[0], vtt('https://cdn.example.com/a-sprite.jpg#xywh=0,0,80,45'));
    const mgrA = await initA;

    expect(mgrA).toBeNull();
    expect(containers(fake.root)).toHaveLength(1);
    expect(totalListenerCount(fake)).toBe(2); // one mousemove + one mouseleave

    // The surviving container renders B's sprite, never A's.
    fake.progress.handlers.get('mousemove')!.forEach((h) =>
      h(new MouseEvent('mousemove', { clientX: 100 }))
    );
    const thumb = fake.root.querySelector('.thumbnail') as HTMLDivElement;
    expect(thumb.style.backgroundImage).toContain('b-sprite.jpg');
  });

  it('does not create DOM or listeners when the request finishes after teardown', async () => {
    const fake = createFakePlayer();
    const source = { src: 'https://cdn.example.com/a.mp4' };

    const init = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();

    // Player switches away / is disposed before the VTT comes back.
    SeekThumbnailsManager.destroyForPlayer(fake.player);
    expect(fetchCalls[0].signal?.aborted).toBe(true);

    respondWith(fetchCalls[0], vtt('https://cdn.example.com/a-sprite.jpg#xywh=0,0,80,45'));
    const mgr = await init;

    expect(mgr).toBeNull();
    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);
  });

  it('reuses one container and one listener pair when the same source initializes twice', async () => {
    const fake = createFakePlayer();
    const source = { src: 'https://cdn.example.com/a.mp4' };
    const cue = 'https://cdn.example.com/a-sprite.jpg#xywh=0,0,80,45';

    const init1 = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    const init2 = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();

    // Both callers share a single VTT request.
    expect(fetchCalls).toHaveLength(1);
    respondWith(fetchCalls[0], vtt(cue));

    const [mgr1, mgr2] = await Promise.all([init1, init2]);
    expect(mgr1).not.toBeNull();
    expect(mgr2).toBe(mgr1);
    expect(containers(fake.root)).toHaveLength(1);
    expect(totalListenerCount(fake)).toBe(2);

    // A third, later init for the same source is a no-op too.
    const mgr3 = await SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    expect(mgr3).toBe(mgr1);
    expect(fetchCalls).toHaveLength(1);
    expect(containers(fake.root)).toHaveLength(1);
    expect(totalListenerCount(fake)).toBe(2);
  });

  it('leaves no thumbnails or DOM when the VTT fetch fails', async () => {
    const fake = createFakePlayer();
    const source = { src: 'https://cdn.example.com/a.mp4' };

    const init = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();
    respondWith(fetchCalls[0], 'not found', false, 404);

    expect(await init).toBeNull();
    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);
  });

  it('leaves no thumbnails or DOM when the VTT has no usable cues', async () => {
    const fake = createFakePlayer();
    const source = { src: 'https://cdn.example.com/a.mp4' };

    const init = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();
    respondWith(fetchCalls[0], 'WEBVTT\n\nNothing useful here.\n');

    expect(await init).toBeNull();
    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);
  });

  it('clamps hover position to the player and crops to the xywh region', async () => {
    // Bar starts 100px into a 500px-wide player and spans 400px, so the bar's left edge
    // maps to 100px in player space: a 240px-wide thumb (half = 120px) must be clamped.
    const fake = createFakePlayer({ playerWidth: 500, barLeft: 100, barWidth: 400 });
    const source = { src: 'https://cdn.example.com/a.mp4' };

    const init = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();
    respondWith(fetchCalls[0], vtt('https://cdn.example.com/sprite.jpg#xywh=10,20,240,135'));
    await init;

    const move = fake.progress.handlers.get('mousemove')!;
    const container = fake.root.querySelector('.thumbnail-preview') as HTMLDivElement;

    // Hover at the far left of the bar: clamped to half the thumbnail width (120px).
    move.forEach((h) => h(new MouseEvent('mousemove', { clientX: 100 })));
    expect(container.style.left).toBe('120px');
    expect(container.style.display).toBe('block');

    const thumb = container.querySelector('.thumbnail') as HTMLDivElement;
    expect(thumb.style.width).toBe('240px');
    expect(thumb.style.height).toBe('135px');
    expect(thumb.style.backgroundPosition).toBe('-10px -20px');

    // Hover at the far right of the bar: clamp to playerWidth - halfWidth (500 - 120).
    move.forEach((h) => h(new MouseEvent('mousemove', { clientX: 500 })));
    expect(container.style.left).toBe('380px');

    // Hover in the middle is not clamped: bar offset (100) + 50% of the bar (200).
    move.forEach((h) => h(new MouseEvent('mousemove', { clientX: 300 })));
    expect(container.style.left).toBe('300px');

    // Mouse leave hides the preview.
    fake.progress.handlers.get('mouseleave')!.forEach((h) => h(new MouseEvent('mouseleave')));
    expect(container.style.display).toBe('none');
  });

  it('removes the old source container as soon as a new source starts loading', async () => {
    const fake = createFakePlayer();
    const sourceA = { src: 'https://cdn.example.com/a.mp4' };
    const sourceB = { src: 'https://cdn.example.com/b.mp4' };

    const initA = SeekThumbnailsManager.initSeekThumbnails(fake.player, sourceA, PLAYER_OPTIONS);
    await flush();
    respondWith(fetchCalls[0], vtt('https://cdn.example.com/a-sprite.jpg#xywh=0,0,80,45'));
    await initA;
    expect(containers(fake.root)).toHaveLength(1);
    expect(totalListenerCount(fake)).toBe(2);

    // B starts before its VTT resolves: A's DOM and listeners must already be gone.
    const initB = SeekThumbnailsManager.initSeekThumbnails(fake.player, sourceB, PLAYER_OPTIONS);
    await flush();
    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);

    // B's fetch failing leaves the player with no thumbnails at all.
    respondWith(fetchCalls[1], 'oops', false, 500);
    expect(await initB).toBeNull();
    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);
  });

  it('removes the old container and listeners when destroyed directly', async () => {
    const fake = createFakePlayer();
    const source = { src: 'https://cdn.example.com/a.mp4' };

    const init = SeekThumbnailsManager.initSeekThumbnails(fake.player, source, PLAYER_OPTIONS);
    await flush();
    respondWith(fetchCalls[0], vtt('https://cdn.example.com/a-sprite.jpg#xywh=0,0,80,45'));
    const mgr = await init;
    expect(mgr).not.toBeNull();
    expect(containers(fake.root)).toHaveLength(1);
    expect(totalListenerCount(fake)).toBe(2);

    mgr!.destroy(fake.player);

    expect(containers(fake.root)).toHaveLength(0);
    expect(totalListenerCount(fake)).toBe(0);
  });
});
