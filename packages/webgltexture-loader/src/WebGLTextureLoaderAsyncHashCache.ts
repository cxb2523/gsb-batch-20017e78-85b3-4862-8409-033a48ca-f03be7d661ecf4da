import WebGLTextureLoader, { type TextureAndSize } from "./WebGLTextureLoader.js";

const neverEnding: Promise<never> = new Promise(() => {});

export default class WebGLTextureLoaderAsyncHashCache<T> extends WebGLTextureLoader<T> {
  inputHash(_input: T): unknown {
    return "";
  }

  loadNoCache(_input: T): {
    promise: Promise<TextureAndSize>;
    dispose: () => void;
  } {
    return {
      promise: Promise.reject(new Error("loadNoCache is not implemented")),
      dispose: () => {},
    };
  }

  disposes: Map<unknown, () => void> = new Map();
  inputs: Map<unknown, T> = new Map();
  promises: Map<unknown, Promise<TextureAndSize>> = new Map();
  results: Map<unknown, TextureAndSize> = new Map();

  _disposed = false;

  override dispose(): void {
    if (this._disposed) return;
    const { promises, results, inputs, disposes } = this;
    // Interrupt every in-flight underlying load first so it stops producing
    // GPU resources, then release the textures that made it into the cache.
    for (const d of disposes.values()) d();
    for (const result of results.values()) this.disposeTexture(result.texture);
    promises.clear();
    results.clear();
    inputs.clear();
    disposes.clear();
    this._disposed = true;
  }

  disposeTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  override load(input: T): Promise<TextureAndSize> {
    // A disposed loader must never start work, write to the cache or retain
    // textures again. Hand back a promise that simply never settles.
    if (this._disposed) return neverEnding;
    const hash = this.inputHash(input);
    const maybePromise = this.promises.get(hash);
    if (maybePromise) return maybePromise;
    const d = this.loadNoCache(input);
    this.disposes.set(hash, d.dispose);
    this.inputs.set(hash, input);
    const promise = d.promise.then(
      (result) => {
        // The entry may have been cancelled/reloaded or the whole loader
        // disposed while the underlying load was in flight. Such a stale
        // result must never reach the cache; release its texture instead.
        if (this._disposed || this.promises.get(hash) !== promise) {
          this.disposeTexture(result.texture);
          return neverEnding;
        }
        this.disposes.delete(hash);
        this.results.set(hash, result);
        return result;
      },
      (error: unknown) => {
        const isCurrent = !this._disposed && this.promises.get(hash) === promise;
        if (isCurrent) {
          // Forget a rejected load completely so the next load() retries
          // through loadNoCache rather than reusing the rejected promise.
          const dispose = this.disposes.get(hash);
          if (dispose) {
            dispose();
            this.disposes.delete(hash);
          }
          this.promises.delete(hash);
          this.inputs.delete(hash);
          throw error;
        }
        // The rejection belongs to a cancelled/disposed entry nobody waits
        // on anymore: swallow it instead of surfacing an unhandled rejection.
        return neverEnding;
      },
    );
    this.promises.set(hash, promise);
    return promise;
  }

  override get(input: T): TextureAndSize | undefined {
    return this.results.get(this.inputHash(input));
  }

  cancelLoad(input: T): void {
    const hash = this.inputHash(input);
    // A completed load owns a cached texture that stays valid until the
    // loader itself is disposed; there is nothing pending to interrupt.
    if (this.results.has(hash)) return;
    this.promises.delete(hash);
    this.inputs.delete(hash);
    const dispose = this.disposes.get(hash);
    if (dispose) {
      dispose();
      this.disposes.delete(hash);
    }
  }
}
