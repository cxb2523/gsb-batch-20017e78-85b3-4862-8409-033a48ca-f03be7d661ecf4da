import { describe, expect, it, vi } from "vitest";

/**
 * A minimal stand-in for a 2D canvas.
 *
 * Pixi's `Texture.from` cannot run without a real canvas source, so the cache
 * tests replace the `pixi.js` module (below) with a fake `Texture` that records
 * what was drawn and destroyed. That keeps the tests focused on what the cache
 * actually promises — per-clip isolation and resource release — rather than on
 * WebGL.
 */
class FakeContext2D {
  drawImage = vi.fn();
  clearRect = vi.fn();
}

class FakeCanvas {
  width: number;
  height: number;
  readonly context = new FakeContext2D();
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return this.context;
  }
}

interface FakeTexture {
  source: { update: () => void; resource: FakeCanvas };
  destroyed: boolean;
  destroy: (destroySource?: boolean) => void;
}

function makeFakeTexture(canvas: FakeCanvas): FakeTexture {
  const texture: FakeTexture = {
    source: { update: vi.fn(), resource: canvas },
    destroyed: false,
    destroy: vi.fn(() => {
      texture.destroyed = true;
    }),
  };
  return texture;
}

const textures = new Map<FakeCanvas, FakeTexture>();

// The cache creates canvases through `document.createElement`. This suite runs
// in Node without a DOM, so a tiny stub is enough — the fake `Texture` above
// never inspects the canvas beyond its 2D context.
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
    return new FakeCanvas();
  },
};

vi.mock("pixi.js", () => ({
  Texture: {
    from: (resource: FakeCanvas) => {
      const existing = textures.get(resource);
      if (existing) return existing;
      const texture = makeFakeTexture(resource);
      textures.set(resource, texture);
      return texture;
    },
  },
}));

// Imported after the mock so the cache sees the fake Texture.
const { MediaTextureCache } = await import("../MediaTextureCache");

type Cache = InstanceType<typeof MediaTextureCache>;

function onlyCanvasScope(cache: Cache, scopeId: string): FakeCanvas {
  const texture = cache.peek("unused-media", scopeId) as unknown as FakeTexture | null;
  expect(texture).not.toBeNull();
  return texture!.source.resource;
}

describe("MediaTextureCache — per-clip decoded-video targets", () => {
  const store = { put: vi.fn(), get: vi.fn(), delete: vi.fn(), keys: vi.fn(), clear: vi.fn() };

  it("gives two clips of one media separate textures and canvases", () => {
    // The regression this guards: sharing a per-media canvas means the second
    // clip's draw overwrites the first's, and both show the same picture.
    const cache = new MediaTextureCache(store as never);
    const a = cache.registerScopedVideo("clip-a", 1920, 1080);
    const b = cache.registerScopedVideo("clip-b", 1920, 1080);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(cache.peek("m1", "clip-a")).toBe(a);
    expect(cache.peek("m1", "clip-b")).toBe(b);
  });

  it("draws each clip's decoded frame into its own canvas only", () => {
    const cache = new MediaTextureCache(store as never);
    cache.registerScopedVideo("clip-a", 640, 360);
    cache.registerScopedVideo("clip-b", 640, 360);
    const canvasA = onlyCanvasScope(cache, "clip-a");
    const canvasB = onlyCanvasScope(cache, "clip-b");

    const frameA = { draw: vi.fn(), close: vi.fn() };
    cache.drawDecodedFrame("clip-a", frameA);

    // Only A's context was touched, and only A's texture was re-uploaded.
    expect(canvasA.context.drawImage).not.toHaveBeenCalled(); // frame.draw owns the call
    expect(frameA.draw).toHaveBeenCalledWith(canvasA.context, 640, 360);
    expect(canvasB.context.clearRect).not.toHaveBeenCalled();

    const frameB = { draw: vi.fn(), close: vi.fn() };
    cache.drawDecodedFrame("clip-b", frameB);
    expect(frameB.draw).toHaveBeenCalledWith(canvasB.context, 640, 360);
  });

  it("does not close the frame — the caller owns its lifetime", () => {
    const cache = new MediaTextureCache(store as never);
    cache.registerScopedVideo("clip-a", 100, 100);
    const frame = { draw: vi.fn(), close: vi.fn() };

    cache.drawDecodedFrame("clip-a", frame);

    expect(frame.close).not.toHaveBeenCalled();
  });

  it("releases a scoped texture (and its canvas) on releaseScoped", () => {
    const cache = new MediaTextureCache(store as never);
    const texture = cache.registerScopedVideo("clip-a", 100, 100) as unknown as FakeTexture;

    cache.releaseScoped("clip-a");

    expect(texture.destroy).toHaveBeenCalledWith(true);
    expect(cache.hasScopedTexture("clip-a")).toBe(false);
    expect(cache.peek("m1", "clip-a")).toBeNull();
  });

  it("destroys every scoped texture along with the media-level entries", () => {
    const cache = new MediaTextureCache(store as never);
    const a = cache.registerScopedVideo("clip-a", 100, 100) as unknown as FakeTexture;
    const b = cache.registerScopedVideo("clip-b", 100, 100) as unknown as FakeTexture;

    cache.destroy();

    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(cache.hasScopedTexture("clip-a")).toBe(false);
    expect(cache.hasScopedTexture("clip-b")).toBe(false);
  });

  it("falls back to the media-level texture when a clip has no scope", () => {
    // The preview path: no scope registered, so lookup is unchanged.
    const cache = new MediaTextureCache(store as never);
    expect(cache.peek("m1")).toBeNull();
    expect(cache.peek("m1", "preview-clip")).toBeNull();
  });

  it("draws an element's current frame into a clip's own canvas for the fallback path", () => {
    const cache = new MediaTextureCache(store as never);
    cache.registerScopedVideo("clip-a", 320, 180);
    const canvasA = onlyCanvasScope(cache, "clip-a");

    // Simulate the shared element entry the cache holds for a fallen-back video.
    const element = { readyState: 2, videoWidth: 320, videoHeight: 180 };
    // The cache keeps element entries private; injecting one through its internal
    // map is the least invasive way to exercise drawVideoElement here.
    (cache as unknown as { entries: Map<string, unknown> }).entries.set("m1", {
      kind: "video",
      element,
      texture: makeFakeTexture(new FakeCanvas(320, 180)),
      objectUrl: "blob:fake",
    });

    cache.drawVideoElement("clip-a", "m1");

    expect(canvasA.context.clearRect).toHaveBeenCalled();
    expect(canvasA.context.drawImage).toHaveBeenCalledWith(element, 0, 0, 320, 180);
  });
});
