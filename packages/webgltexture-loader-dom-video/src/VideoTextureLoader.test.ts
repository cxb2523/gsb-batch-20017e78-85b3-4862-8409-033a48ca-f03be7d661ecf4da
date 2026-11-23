// `VideoTextureLoader` checks `input instanceof HTMLVideoElement` and
// polls `videoWidth`. Install a minimal class on `globalThis` so the
// instanceof guard passes in plain Node.

const HTML_VIDEO_NOT_SET = Symbol("not-set");
let previousHTMLVideoElement: unknown = HTML_VIDEO_NOT_SET;
beforeAll(() => {
  const g = globalThis as { HTMLVideoElement?: unknown };
  previousHTMLVideoElement = "HTMLVideoElement" in g ? g.HTMLVideoElement : HTML_VIDEO_NOT_SET;
  if (typeof g.HTMLVideoElement !== "function") {
    g.HTMLVideoElement = class HTMLVideoElement {
      videoWidth = 0;
      videoHeight = 0;
    };
  }
});
afterAll(() => {
  const g = globalThis as { HTMLVideoElement?: unknown };
  if (previousHTMLVideoElement === HTML_VIDEO_NOT_SET) {
    delete g.HTMLVideoElement;
  } else {
    g.HTMLVideoElement = previousHTMLVideoElement;
  }
});

import VideoTextureLoader from "./VideoTextureLoader.js";

const HTMLVideoElementCtor = () =>
  (globalThis as { HTMLVideoElement: new () => HTMLVideoElement }).HTMLVideoElement;

const makeVideo = (videoWidth = 0, videoHeight = 0): HTMLVideoElement => {
  const v = new (HTMLVideoElementCtor())();
  Object.assign(v, { videoWidth, videoHeight });
  return v;
};

const mockGL = (overrides: Partial<WebGLRenderingContext> = {}) =>
  ({
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    deleteTexture: () => {},
    createTexture: () => ({}) as WebGLTexture,
    bindTexture: () => {},
    texImage2D: () => {},
    ...overrides,
  }) as unknown as WebGLRenderingContext;

test("canLoad accepts HTMLVideoElement instances and rejects others", () => {
  const loader = new VideoTextureLoader(mockGL());
  expect(loader.canLoad(makeVideo())).toBe(true);
  expect(loader.canLoad(null)).toBe(false);
  expect(loader.canLoad(undefined)).toBe(false);
  expect(loader.canLoad(0)).toBe(false);
  expect(loader.canLoad("foo")).toBe(false);
  expect(loader.canLoad({})).toBe(false);
});

test("inputHash is the video element itself and is idempotent", () => {
  const loader = new VideoTextureLoader(mockGL());
  const v = makeVideo();
  expect(loader.inputHash(v)).toBe(v);
  expect(loader.inputHash(v)).toBe(loader.inputHash(v));
});

test("loadNoCache resolves immediately when videoWidth is already set", async () => {
  const tex = { __id: "T" } as unknown as WebGLTexture;
  const binds: [number, WebGLTexture][] = [];
  const uploads: unknown[] = [];
  const gl = mockGL({
    createTexture: () => tex,
    bindTexture: ((target: number, t: WebGLTexture) => {
      binds.push([target, t]);
    }) as WebGLRenderingContext["bindTexture"],
    texImage2D: ((...args: unknown[]) => {
      uploads.push(args);
    }) as unknown as WebGLRenderingContext["texImage2D"],
  });
  const loader = new VideoTextureLoader(gl);
  const v = makeVideo(640, 360);
  const result = await loader.load(v);
  expect(result.width).toBe(640);
  expect(result.height).toBe(360);
  expect(result.texture).toBe(tex);
  expect(binds).toEqual([[gl.TEXTURE_2D, tex]]);
  expect(uploads).toHaveLength(1);
  expect((uploads[0] as unknown[])[5]).toBe(v);
});

test("loadNoCache polls via setTimeout until videoWidth becomes positive", async () => {
  jest.useFakeTimers();
  try {
    const loader = new VideoTextureLoader(mockGL());
    const v = makeVideo(0, 0);
    const promise = loader.load(v);
    // First check sees 0 → schedules a timeout.
    expect(jest.getTimerCount()).toBe(1);
    // Make the video become "ready" then drive the polling loop forward.
    v.videoWidth = 128;
    v.videoHeight = 64;
    jest.advanceTimersByTime(100);
    // After the next tick the promise resolves with the new dims.
    const result = await promise;
    expect(result.width).toBe(128);
    expect(result.height).toBe(64);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("loadNoCache.dispose clears a pending poll timeout", () => {
  jest.useFakeTimers();
  try {
    const loader = new VideoTextureLoader(mockGL());
    const v = makeVideo(0, 0);
    // Reach into the protected loadNoCache.
    const { dispose } = (
      loader as unknown as {
        loadNoCache: (input: HTMLVideoElement) => {
          promise: Promise<unknown>;
          dispose: () => void;
        };
      }
    ).loadNoCache(v);
    expect(jest.getTimerCount()).toBe(1);
    dispose();
    expect(jest.getTimerCount()).toBe(0);
    // Dispose before any timeout is scheduled is a no-op too.
    const { dispose: noopDispose } = (
      loader as unknown as {
        loadNoCache: (input: HTMLVideoElement) => {
          promise: Promise<unknown>;
          dispose: () => void;
        };
      }
    ).loadNoCache(makeVideo(2, 2));
    // videoWidth > 0 means no timer was ever set; calling dispose is safe.
    expect(jest.getTimerCount()).toBe(0);
    expect(() => noopDispose()).not.toThrow();
  } finally {
    jest.useRealTimers();
  }
});

test("update binds and re-uploads the video to the cached texture", async () => {
  const binds: [number, WebGLTexture][] = [];
  const uploads: unknown[] = [];
  const tex = { __id: "T" } as unknown as WebGLTexture;
  const gl = mockGL({
    createTexture: () => tex,
    bindTexture: ((target: number, t: WebGLTexture) => {
      binds.push([target, t]);
    }) as WebGLRenderingContext["bindTexture"],
    texImage2D: ((...args: unknown[]) => {
      uploads.push(args);
    }) as unknown as WebGLRenderingContext["texImage2D"],
  });
  const loader = new VideoTextureLoader(gl);
  const v = makeVideo(2, 2);
  await loader.load(v);
  binds.length = 0;
  uploads.length = 0;
  loader.update(v);
  expect(binds).toEqual([[gl.TEXTURE_2D, tex]]);
  expect(uploads).toHaveLength(1);
  expect((uploads[0] as unknown[])[5]).toBe(v);
});

test("update is a no-op when the video has not been loaded yet", () => {
  const binds: unknown[] = [];
  const uploads: unknown[] = [];
  const gl = mockGL({
    bindTexture: ((..._args: unknown[]) => {
      binds.push(_args);
    }) as WebGLRenderingContext["bindTexture"],
    texImage2D: ((..._args: unknown[]) => {
      uploads.push(_args);
    }) as unknown as WebGLRenderingContext["texImage2D"],
  });
  const loader = new VideoTextureLoader(gl);
  loader.update(makeVideo(1, 1));
  expect(binds).toEqual([]);
  expect(uploads).toEqual([]);
});

test("dispose deletes every cached texture", async () => {
  const deleted: WebGLTexture[] = [];
  let i = 0;
  const gl = mockGL({
    createTexture: () => ({ __id: i++ }) as unknown as WebGLTexture,
    deleteTexture: ((t: WebGLTexture) => {
      deleted.push(t);
    }) as WebGLRenderingContext["deleteTexture"],
  });
  const loader = new VideoTextureLoader(gl);
  const a = await loader.load(makeVideo(2, 2));
  const b = await loader.load(makeVideo(3, 3));
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const expectPending = async (p: Promise<unknown>) => {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushMicrotasks();
  expect(settled).toBe(false);
};

test("cancelLoad during polling clears the timer so no poll fires afterwards", () => {
  jest.useFakeTimers();
  try {
    const loader = new VideoTextureLoader(mockGL());
    const v = makeVideo(0, 0);
    loader.load(v);
    expect(jest.getTimerCount()).toBe(1);
    loader.cancelLoad(v);
    expect(jest.getTimerCount()).toBe(0);
    // Even driving time far beyond the poll interval must not reschedule.
    jest.advanceTimersByTime(1000);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("a cancelled load never caches and stays pending even if the video becomes ready", async () => {
  jest.useFakeTimers();
  try {
    const deleted: WebGLTexture[] = [];
    const firstTex = { __id: "first" } as unknown as WebGLTexture;
    const retryTex = { __id: "retry" } as unknown as WebGLTexture;
    let nextTex: WebGLTexture = firstTex;
    const gl = mockGL({
      createTexture: () => nextTex,
      deleteTexture: ((t: WebGLTexture) => {
        deleted.push(t);
      }) as WebGLRenderingContext["deleteTexture"],
    });
    const loader = new VideoTextureLoader(gl);
    const v = makeVideo(0, 0);
    const p = loader.load(v);
    // Cancel while the video is still not ready: the timer is the only
    // thing keeping the load alive.
    loader.cancelLoad(v);
    expect(jest.getTimerCount()).toBe(0);
    // The video becomes ready afterwards; no tick must run any more.
    v.videoWidth = 16;
    v.videoHeight = 9;
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(loader.get(v)).toBeUndefined();
    await expectPending(p);
    expect(jest.getTimerCount()).toBe(0);
    expect(deleted).toEqual([]);
    // A fresh load of the same video starts a brand-new underlying load.
    // The video is already ready, so it resolves immediately without a
    // new poll timer.
    nextTex = retryTex;
    const retry = loader.load(v);
    expect(jest.getTimerCount()).toBe(0);
    const result = await retry;
    expect(result.texture).toBe(retryTex);
    expect(loader.get(v)).toBe(result);
    loader.dispose();
    expect(deleted).toEqual([retryTex]);
  } finally {
    jest.useRealTimers();
  }
});

test("reload after cancel starts a fresh poll that resolves and caches", async () => {
  jest.useFakeTimers();
  try {
    const gl = mockGL();
    const loader = new VideoTextureLoader(gl);
    const v = makeVideo(0, 0);
    const first = loader.load(v);
    expect(jest.getTimerCount()).toBe(1);
    loader.cancelLoad(v);
    expect(jest.getTimerCount()).toBe(0);
    // A new load starts polling from scratch.
    const second = loader.load(v);
    expect(second).not.toBe(first);
    expect(jest.getTimerCount()).toBe(1);
    v.videoWidth = 32;
    v.videoHeight = 24;
    jest.advanceTimersByTime(100);
    const result = await second;
    expect(result.width).toBe(32);
    expect(result.height).toBe(24);
    expect(loader.get(v)).toBe(result);
    expect(jest.getTimerCount()).toBe(0);
    loader.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test("dispose during polling clears timers and a later load starts nothing", async () => {
  jest.useFakeTimers();
  try {
    const gl = mockGL();
    const loader = new VideoTextureLoader(gl);
    const v = makeVideo(0, 0);
    const p = loader.load(v);
    expect(jest.getTimerCount()).toBe(1);
    loader.dispose();
    expect(jest.getTimerCount()).toBe(0);
    // The video becomes ready afterwards; the disposed load must not
    // resolve, cache or reschedule anything.
    v.videoWidth = 8;
    v.videoHeight = 8;
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(jest.getTimerCount()).toBe(0);
    expect(loader.get(v)).toBeUndefined();
    await expectPending(p);
    // A disposed loader never starts a new underlying load.
    const afterDispose = loader.load(v);
    expect(jest.getTimerCount()).toBe(0);
    await expectPending(afterDispose);
  } finally {
    jest.useRealTimers();
  }
});

test("texture upload failure clears polling, releases the texture and rejects; retry reloads", async () => {
  jest.useFakeTimers();
  try {
    const deleted: WebGLTexture[] = [];
    const tex = { __id: "broken" } as unknown as WebGLTexture;
    let shouldThrow = true;
    const gl = mockGL({
      createTexture: () => tex,
      texImage2D: (() => {
        if (shouldThrow) throw new Error("upload boom");
      }) as unknown as WebGLRenderingContext["texImage2D"],
      deleteTexture: ((t: WebGLTexture) => {
        deleted.push(t);
      }) as WebGLRenderingContext["deleteTexture"],
    });
    const loader = new VideoTextureLoader(gl);
    const v = makeVideo(0, 0);
    const p = loader.load(v);
    expect(jest.getTimerCount()).toBe(1);
    v.videoWidth = 4;
    v.videoHeight = 4;
    jest.advanceTimersByTime(100);
    await expect(p).rejects.toThrow(/upload boom/);
    // Failure cleaned up both the timer and the partially created texture.
    expect(jest.getTimerCount()).toBe(0);
    expect(deleted).toEqual([tex]);
    expect(loader.get(v)).toBeUndefined();
    // The rejected promise is not reused: retry drives a fresh load.
    shouldThrow = false;
    const retry = loader.load(v);
    const result = await retry;
    expect(result.texture).toBe(tex);
    expect(loader.get(v)).toBe(result);
    expect(jest.getTimerCount()).toBe(0);
    loader.dispose();
    expect(deleted).toEqual([tex, tex]);
  } finally {
    jest.useRealTimers();
  }
});

test("immediate upload failure also releases the texture without leaving timers", async () => {
  const deleted: WebGLTexture[] = [];
  const tex = { __id: "broken-now" } as unknown as WebGLTexture;
  const gl = mockGL({
    createTexture: () => tex,
    texImage2D: (() => {
      throw new Error("instant boom");
    }) as unknown as WebGLRenderingContext["texImage2D"],
    deleteTexture: ((t: WebGLTexture) => {
      deleted.push(t);
    }) as WebGLRenderingContext["deleteTexture"],
  });
  const loader = new VideoTextureLoader(gl);
  const v = makeVideo(2, 2);
  await expect(loader.load(v)).rejects.toThrow(/instant boom/);
  expect(deleted).toEqual([tex]);
  expect(loader.get(v)).toBeUndefined();
});

test("cancelling while an upload is in flight leaves nothing cached and never restarts the poll", async () => {
  jest.useFakeTimers();
  try {
    const deleted: WebGLTexture[] = [];
    const tex = { __id: "stale" } as unknown as WebGLTexture;
    // The upload never settles within the test, modelling a stuck source.
    const gl = mockGL({
      createTexture: () => tex,
      texImage2D: (() =>
        new Promise<void>(() => {})) as unknown as WebGLRenderingContext["texImage2D"],
      deleteTexture: ((t: WebGLTexture) => {
        deleted.push(t);
      }) as WebGLRenderingContext["deleteTexture"],
    });
    const loader = new VideoTextureLoader(gl);
    const v = makeVideo(0, 0);
    const p = loader.load(v);
    v.videoWidth = 10;
    v.videoHeight = 10;
    jest.advanceTimersByTime(100);
    // The tick created the texture and is now blocked inside the upload;
    // there is no poll timer pending.
    expect(jest.getTimerCount()).toBe(0);
    loader.cancelLoad(v);
    await flushMicrotasks();
    // Nothing was cached and no new timer got scheduled by the cancellation.
    expect(loader.get(v)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    await expectPending(p);
    // Releasing time changes nothing: the cancelled entry stays inert.
    jest.advanceTimersByTime(1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(loader.get(v)).toBeUndefined();
    // The texture that reached the cache layer as a stale result was
    // released exactly once (never double-deleted, never cached).
    expect(deleted).toEqual([tex]);
  } finally {
    jest.useRealTimers();
  }
});
