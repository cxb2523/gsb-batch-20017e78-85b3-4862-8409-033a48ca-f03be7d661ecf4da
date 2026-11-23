"use client";

import { Texture } from "pixi.js";
import type { MediaBlobStore } from "@cutaway/media-engine";
import type { Id } from "@cutaway/types";

/**
 * Resolves media ids to Pixi textures, backed by the blob store.
 *
 * Caching is essential rather than an optimization: a clip appears on every
 * frame, and decoding its image or re-creating its video element sixty times a
 * second would make the preview unusable. Entries are keyed by media id and
 * live until explicitly released.
 */

interface VideoEntry {
  kind: "video";
  element: HTMLVideoElement;
  texture: Texture;
  objectUrl: string;
}

interface ImageEntry {
  kind: "image";
  texture: Texture;
  objectUrl: string;
}

/**
 * A video whose frames arrive from an external decoder instead of a `<video>`
 * element. Export uses this so it can draw exactly-decoded frames through the
 * same texture lookup the preview uses — the renderer never learns the
 * difference. Scoped entries only ever hold this kind.
 */
interface CanvasVideoEntry {
  kind: "canvas-video";
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: Texture;
}

type CacheEntry = VideoEntry | ImageEntry;

/** A decoded frame that can paint itself and release its own GPU resources. */
export interface DrawableVideoFrame {
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
}

export class MediaTextureCache {
  private readonly entries = new Map<Id, CacheEntry>();
  /**
   * Export-only, scoped by clip rather than by media.
   *
   * Two clips can show the same source on the same frame — an overlap, or a
   * transition tail — at *different* source times. Sharing one per-media canvas
   * for those means the second clip's draw overwrites the first's, so both end
   * up showing the same picture. A target per clip is what keeps them apart.
   * The preview never populates this map, so its per-media lookup is unchanged.
   */
  private readonly scopedEntries = new Map<Id, CanvasVideoEntry>();
  /** Tracks in-flight loads so concurrent requests share one decode. */
  private readonly loading = new Map<Id, Promise<CacheEntry | null>>();

  constructor(private readonly store: MediaBlobStore) {}

  /**
   * Returns a texture if already loaded. Never triggers a load.
   *
   * When `scopeId` is supplied (export passes the clip id), a scoped target wins
   * over the media-level texture, so each clip reads its own pixels.
   */
  peek(mediaId: Id, scopeId?: Id): Texture | null {
    if (scopeId) {
      const scoped = this.scopedEntries.get(scopeId);
      if (scoped) return scoped.texture;
    }
    return this.entries.get(mediaId)?.texture ?? null;
  }

  /** True when this scope (clip) has its own decoded-frame target. */
  hasScopedTexture(scopeId: Id): boolean {
    return this.scopedEntries.has(scopeId);
  }

  getVideoElement(mediaId: Id): HTMLVideoElement | null {
    const entry = this.entries.get(mediaId);
    return entry?.kind === "video" ? entry.element : null;
  }

  /**
   * Registers a clip-scoped video whose frames come from a decoder (or from
   * seeking a shared `<video>` element), and returns its texture.
   *
   * The target is keyed by the clip, not the media, so two clips of one source
   * never share a canvas. Call {@link drawDecodedFrame} to publish each frame.
   */
  registerScopedVideo(scopeId: Id, width: number, height: number): Texture | null {
    const existing = this.scopedEntries.get(scopeId);
    if (existing) return existing.texture;

    const entry = this.createCanvasEntry(width, height);
    if (!entry) return null;
    this.scopedEntries.set(scopeId, entry);
    return entry.texture;
  }

  /**
   * Publishes a decoded frame to a clip's own target.
   *
   * The frame is copied into the entry's canvas rather than swapped in, so the
   * texture identity stays stable across frames (Pixi would otherwise have to
   * rebuild the GPU resource). The caller owns `frame` — including closing it —
   * because the cache only borrows the pixels for the duration of this call.
   */
  drawDecodedFrame(scopeId: Id, frame: DrawableVideoFrame): void {
    const entry = this.scopedEntries.get(scopeId);
    if (!entry) return;

    const { canvas, context, texture } = entry;
    // Clear first: a frame with transparency must not show the previous one
    // through its transparent regions.
    context.clearRect(0, 0, canvas.width, canvas.height);
    frame.draw(context, canvas.width, canvas.height);
    texture.source.update();
  }

  /**
   * Publishes the current frame of a media's `<video>` element to a clip's own
   * target. This is the element-seeking export fallback: the element is shared
   * (there is one decoder), but each clip gets its own copy of the pixels, so
   * isolation holds on that path too.
   */
  drawVideoElement(scopeId: Id, mediaId: Id): void {
    const source = this.entries.get(mediaId);
    const target = this.scopedEntries.get(scopeId);
    if (source?.kind !== "video" || !target) return;
    if (source.element.readyState < 2) return; // no frame to copy yet

    const { canvas, context, texture } = target;
    context.clearRect(0, 0, canvas.width, canvas.height);
    try {
      context.drawImage(source.element, 0, 0, canvas.width, canvas.height);
    } catch {
      // An element without a decodable frame draws nothing; the previous frame
      // (or transparency) stays, which is the documented degradation.
      return;
    }
    texture.source.update();
  }

  private createCanvasEntry(width: number, height: number): CanvasVideoEntry | null {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    // `alpha` keeps transparent video transparent; without it the canvas would
    // composite every frame onto opaque black.
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return null;

    return { kind: "canvas-video", canvas, context, texture: Texture.from(canvas) };
  }

  /**
   * Loads and caches a texture.
   *
   * Returns `null` when the media cannot be resolved — a missing asset must
   * degrade to an empty frame, never crash the render loop.
   */
  async load(
    mediaId: Id,
    blobKey: string,
    kind: "video" | "image" | "gif",
  ): Promise<Texture | null> {
    const cached = this.entries.get(mediaId);
    if (cached) return cached.texture;

    const inFlight = this.loading.get(mediaId);
    if (inFlight) return (await inFlight)?.texture ?? null;

    const promise = this.createEntry(mediaId, blobKey, kind);
    this.loading.set(mediaId, promise);

    try {
      const entry = await promise;
      if (entry) this.entries.set(mediaId, entry);
      return entry?.texture ?? null;
    } finally {
      this.loading.delete(mediaId);
    }
  }

  private async createEntry(
    mediaId: Id,
    blobKey: string,
    kind: "video" | "image" | "gif",
  ): Promise<CacheEntry | null> {
    const blob = await this.store.get(blobKey);
    if (!blob) return null;

    const objectUrl = URL.createObjectURL(blob);

    try {
      if (kind === "video") {
        const element = document.createElement("video");
        element.src = objectUrl;
        element.muted = true;
        element.playsInline = true;
        element.loop = false;
        element.preload = "auto";
        // Required before a frame exists to upload as a texture.
        await new Promise<void>((resolve, reject) => {
          element.onloadeddata = () => resolve();
          element.onerror = () => reject(new Error("Video failed to load"));
        });

        return { kind: "video", element, texture: Texture.from(element), objectUrl };
      }

      const image = new Image();
      image.src = objectUrl;
      await image.decode();

      return { kind: "image", texture: Texture.from(image), objectUrl };
    } catch {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
  }

  /** Releases one entry's GPU and blob resources. */
  release(mediaId: Id): void {
    const entry = this.entries.get(mediaId);
    if (!entry) return;

    entry.texture.destroy(true);
    if (entry.kind === "video") {
      URL.revokeObjectURL(entry.objectUrl);
      entry.element.pause();
      entry.element.removeAttribute("src");
      entry.element.load();
    } else if (entry.kind === "image") {
      URL.revokeObjectURL(entry.objectUrl);
    }

    this.entries.delete(mediaId);
  }

  /** Releases one clip-scoped target's texture (and with it the canvas). */
  releaseScoped(scopeId: Id): void {
    const entry = this.scopedEntries.get(scopeId);
    if (!entry) return;
    entry.texture.destroy(true);
    this.scopedEntries.delete(scopeId);
  }

  destroy(): void {
    for (const mediaId of [...this.entries.keys()]) this.release(mediaId);
    for (const scopeId of [...this.scopedEntries.keys()]) this.releaseScoped(scopeId);
  }
}
