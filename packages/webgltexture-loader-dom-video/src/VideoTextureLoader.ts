import {
  createTexture,
  globalRegistry,
  WebGLTextureLoaderAsyncHashCache,
} from "webgltexture-loader";

export default class VideoTextureLoader extends WebGLTextureLoaderAsyncHashCache<HTMLVideoElement> {
  override canLoad(input: unknown): boolean {
    return input instanceof HTMLVideoElement;
  }

  override inputHash(input: HTMLVideoElement) {
    return input;
  }

  override loadNoCache(input: HTMLVideoElement) {
    const { gl } = this;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let texture: WebGLTexture | undefined;
    // Whether the load promise has settled. Once settled, the texture is
    // owned by the cache layer, which releases it when the entry is later
    // cancelled/disposed or turns out to be stale; the local dispose() must
    // then no longer touch it, otherwise the same texture is deleted twice.
    let settled = false;

    const clearPoll = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const promise = new Promise<{
      texture: WebGLTexture;
      width: number;
      height: number;
    }>((resolve, reject) => {
      const checkVideoReady = () => {
        timeout = undefined;
        if (input.videoWidth > 0) {
          try {
            const { videoWidth: width, videoHeight: height } = input;
            texture = createTexture(gl);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
            settled = true;
            resolve({ texture, width, height });
          } catch (e) {
            settled = true;
            reject(e);
          }
        } else {
          timeout = setTimeout(checkVideoReady, 100);
        }
      };
      checkVideoReady();
    }).catch((error: unknown) => {
      // Failure paths must leave no timer and no partially created texture
      // (e.g. createTexture succeeded but texImage2D threw synchronously).
      clearPoll();
      if (texture !== undefined) {
        this.disposeTexture(texture);
        texture = undefined;
      }
      throw error;
    });

    const dispose = () => {
      clearPoll();
      // Only release a texture the load still owns. A settled texture is
      // the cache layer's responsibility.
      if (!settled && texture !== undefined) {
        this.disposeTexture(texture);
        texture = undefined;
      }
    };

    return { dispose, promise };
  }

  override update(input: HTMLVideoElement): void {
    const { gl } = this;
    const res = this.get(input);
    if (!res) return;
    gl.bindTexture(gl.TEXTURE_2D, res.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
  }
}

globalRegistry.add(VideoTextureLoader);
