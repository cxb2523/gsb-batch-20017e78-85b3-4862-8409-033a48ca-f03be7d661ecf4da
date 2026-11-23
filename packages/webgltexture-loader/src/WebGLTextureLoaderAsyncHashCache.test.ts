import WebGLTextureLoaderAsyncHashCache from "./WebGLTextureLoaderAsyncHashCache.js";

const mockGL = (deleted: WebGLTexture[] = []) =>
  ({
    deleteTexture: (t: WebGLTexture) => {
      deleted.push(t);
    },
  }) as unknown as WebGLRenderingContext;

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  loadNoCacheCalls = 0;
  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(input: number) {
    this.loadNoCacheCalls++;
    return {
      promise: Promise.resolve({
        texture: { id: input } as unknown as WebGLTexture,
        width: 2,
        height: 2,
      }),
      dispose: () => {},
    };
  }
}

test("load resolves and get returns the same value afterwards", async () => {
  const loader = new FakeLoader(mockGL());
  const res = await loader.load(42);
  expect(res).toMatchObject({ width: 2, height: 2 });
  expect(loader.get(42)).toBe(res);
  expect(loader.get(43)).toBeUndefined();
  loader.dispose();
});

test("load is idempotent: same input returns the exact same Promise", () => {
  const loader = new FakeLoader(mockGL());
  const p1 = loader.load(42);
  const p2 = loader.load(42);
  expect(p1).toBe(p2);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.dispose();
});

test("cancelLoad invokes the underlying dispose and clears the promise", () => {
  let underlyingDisposed = false;
  class CancelableLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>(() => {}),
        dispose: () => {
          underlyingDisposed = true;
        },
      };
    }
  }
  const loader = new CancelableLoader(mockGL());
  loader.load(42);
  loader.cancelLoad(42);
  expect(underlyingDisposed).toBe(true);
  // After cancel, a fresh load() must call loadNoCache again.
  underlyingDisposed = false;
  loader.load(42);
  expect(underlyingDisposed).toBe(false);
});

test("dispose during pending load: pending load resolves but result is dropped", async () => {
  let resolveLoad!: (v: { texture: WebGLTexture; width: number; height: number }) => void;
  class SlowLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>((r) => {
          resolveLoad = r;
        }),
        dispose: () => {},
      };
    }
  }
  const loader = new SlowLoader(mockGL());
  const p = loader.load(42);
  loader.dispose();
  resolveLoad({
    texture: {} as WebGLTexture,
    width: 1,
    height: 1,
  });
  // The promise should never resolve (dispose drops the result).
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
});

test("dispose deletes every cached texture exactly once", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  const a = await loader.load(1);
  const b = await loader.load(2);
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});

test("loadNoCache rejection propagates", async () => {
  class FailingLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: Promise.reject(new Error("boom")),
        dispose: () => {},
      };
    }
  }
  const loader = new FailingLoader(mockGL());
  await expect(loader.load(42)).rejects.toThrow(/boom/);
});

type PendingResult = { texture: WebGLTexture; width: number; height: number };

/** A loader whose in-flight load can be resolved/rejected/disposed on demand. */
class ControllableLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  loadNoCacheCalls = 0;
  underlyingDisposes = 0;
  // One entry per loadNoCache call, keyed by call index.
  attempts: {
    resolve: (r: PendingResult) => void;
    reject: (e: unknown) => void;
  }[] = [];

  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(_input: number) {
    this.loadNoCacheCalls++;
    const entry: {
      resolve: (r: PendingResult) => void;
      reject: (e: unknown) => void;
    } = {
      resolve: () => {},
      reject: () => {},
    };
    this.attempts.push(entry);
    const promise = new Promise<PendingResult>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    const dispose = () => {
      this.underlyingDisposes++;
    };
    return { promise, dispose };
  }
}

test("a rejected load is forgotten: load() retries loadNoCache instead of reusing the rejected promise", async () => {
  const loader = new ControllableLoader(mockGL());
  const first = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(1);
  // Concurrent callers still share the same promise while the load is pending.
  expect(loader.load(42)).toBe(first);
  loader.attempts[0].reject(new Error("boom"));
  await expect(first).rejects.toThrow(/boom/);
  // A new load() must start a fresh underlying load rather than hand back
  // the already rejected promise.
  const second = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(2);
  expect(second).not.toBe(first);
  const replacement: PendingResult = {
    texture: { id: "ok" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[1].resolve(replacement);
  const result = await second;
  expect(result).toBe(replacement);
  // get() stays consistent with load()'s resolved value.
  expect(loader.get(42)).toBe(replacement);
  loader.dispose();
});

test("cancelLoad interrupts the underlying load and a late result is deleted instead of cached", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new ControllableLoader(mockGL(deleted));
  const p = loader.load(42);
  loader.cancelLoad(42);
  expect(loader.underlyingDisposes).toBe(1);
  expect(loader.get(42)).toBeUndefined();
  // The underlying load still settles late (e.g. a poll tick already fired).
  const late: PendingResult = {
    texture: { id: "late" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[0].resolve(late);
  await flushMicrotasks();
  // The pending promise never resolves...
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
  // ...the stale texture is released and the cache stays empty.
  expect(deleted).toEqual([late.texture]);
  expect(loader.get(42)).toBeUndefined();
});

test("dispose interrupts in-flight loads and deletes textures that settle afterwards", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new ControllableLoader(mockGL(deleted));
  const pending = loader.load(1);
  const done: PendingResult = {
    texture: { id: "done" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[0].resolve(done);
  await flushMicrotasks();
  // Second input stays pending across dispose.
  const pending2 = loader.load(2);
  loader.dispose();
  expect(loader.underlyingDisposes).toBe(1);
  const late: PendingResult = {
    texture: { id: "late" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[1].resolve(late);
  await flushMicrotasks();
  // The already cached texture is deleted once; the late texture is also
  // deleted and never reaches the cache.
  expect(deleted).toEqual([done.texture, late.texture]);
  expect(loader.get(1)).toBeUndefined();
  expect(loader.get(2)).toBeUndefined();
  const winner = await Promise.race([
    Promise.all([pending, pending2]).then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
});

test("after dispose, load() starts nothing, never caches and never retains textures", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new ControllableLoader(mockGL(deleted));
  loader.dispose();
  const p = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(0);
  // Even if an external holder settles something, the disposed loader has
  // no entry for it; nothing lands in the cache.
  expect(loader.get(42)).toBeUndefined();
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
  expect(deleted).toEqual([]);
  // A second dispose is a safe no-op.
  expect(() => loader.dispose()).not.toThrow();
});

test("a rejection that arrives after cancel is swallowed without retrying or writing the cache", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new ControllableLoader(mockGL(deleted));
  const p = loader.load(42);
  loader.cancelLoad(42);
  loader.attempts[0].reject(new Error("late boom"));
  await flushMicrotasks();
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
  // The stale rejection must not evict anything, delete anything or spawn
  // a new attempt.
  expect(loader.loadNoCacheCalls).toBe(1);
  expect(deleted).toEqual([]);
  expect(loader.get(42)).toBeUndefined();
  // A subsequent load starts cleanly from scratch.
  const retry = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(2);
  const ok: PendingResult = {
    texture: { id: "ok" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[1].resolve(ok);
  await expect(retry).resolves.toBe(ok);
  expect(loader.get(42)).toBe(ok);
  loader.dispose();
});

test("cancelLoad on a completed load leaves the cached texture in place", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new ControllableLoader(mockGL(deleted));
  const p = loader.load(42);
  const ok: PendingResult = {
    texture: { id: "ok" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  };
  loader.attempts[0].resolve(ok);
  const result = await p;
  loader.cancelLoad(42);
  expect(loader.underlyingDisposes).toBe(0);
  expect(loader.get(42)).toBe(result);
  expect(deleted).toEqual([]);
  // The completed load stays idempotent and resolves to the same value.
  await expect(loader.load(42)).resolves.toBe(result);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.dispose();
  expect(deleted).toEqual([ok.texture]);
});
