"use client";

import type { FrameSource } from "@cutaway/export-engine";
import type { MediaBlobStore } from "@cutaway/media-engine";
import {
  planVideoDecodeSchedule,
  prepareSceneMedia,
  resolveScene,
  type SceneMediaTargets,
  type SceneNode,
} from "@cutaway/render-engine";
import type { Id, ProjectDocument, Size } from "@cutaway/types";
import { MediaTextureCache } from "@/features/preview/MediaTextureCache";
import { PixiSceneRenderer } from "@/features/preview/PixiSceneRenderer";
import { ExactVideoDecoders, type DecodedVideoFrame } from "./ExactVideoDecoders";

/**
 * A FrameSource that renders export frames with the *same* compositor the
 * preview uses.
 *
 * This is what makes the exported file match the preview rather than merely
 * resemble it: both consume `resolveScene`, and both draw through
 * `PixiSceneRenderer`. The only differences are headless ones — the canvas is
 * the full project resolution (pixel ratio 1, no display scaling) and each
 * frame is fully prepared *before* it is captured, because an export must never
 * race a texture decode the way a realtime preview tolerates.
 *
 * Video is decoded frame-exactly with WebCodecs (see {@link ExactVideoDecoders})
 * rather than by seeking a `<video>` element, so the frame encoded at each
 * timeline position is precisely the frame the timeline asked for. Media the
 * decoder can't open falls back to element seeking, which is approximate but
 * keeps the export working.
 *
 * **Per-clip isolation.** Two clips can show one source on the same frame at
 * different times — overlapping clips, or a transition's outgoing tail. The
 * preview tolerates one texture per media because both clips show the same
 * codec state; an export may not, because it prepares each clip's exact frame
 * before the frame is drawn, so a shared per-media canvas would let the second
 * clip's draw overwrite the first's and both would encode the same picture.
 * This source therefore gives every video clip its own drawable target (see
 * `MediaTextureCache.registerScopedVideo`) and the renderer looks textures up
 * by clip (`scopeByClip`). Preview is untouched: it never registers scopes.
 *
 * The per-frame preparation itself lives in {@link prepareSceneMedia}, kept
 * DOM-free so its isolation and frame-ownership rules are unit-tested.
 */
export class PixiExportFrameSource implements FrameSource<VideoFrame> {
  private disposed = false;

  private constructor(
    private readonly project: ProjectDocument,
    private readonly renderer: PixiSceneRenderer,
    private readonly cache: MediaTextureCache,
    private readonly resolution: Size,
    private readonly frameRate: number,
    private readonly decoders: ExactVideoDecoders,
  ) {}

  static async create(
    project: ProjectDocument,
    store: MediaBlobStore,
    cache: MediaTextureCache,
    resolution: Size,
    frameRate: number,
    startFrame: number,
    endFrame: number,
  ): Promise<PixiExportFrameSource> {
    const canvas = document.createElement("canvas");
    canvas.width = resolution.width;
    canvas.height = resolution.height;

    // Scoped by clip: each video node draws into its own target. Video elements
    // are seeked by this class, so the renderer must not also nudge them.
    const renderer = new PixiSceneRenderer(cache, {
      scopeByClip: true,
      driveVideoElements: false,
    });
    // Pixel ratio 1: the backing store is exactly the requested output size.
    let decoders: ExactVideoDecoders | null = null;
    try {
      await renderer.init(canvas, resolution.width, resolution.height, 1);

      // Every timestamp the export will need, planned before decoding starts —
      // the decoders require the whole ordered list to walk each stream once.
      const schedule = planVideoDecodeSchedule(project, startFrame, endFrame);
      decoders = await ExactVideoDecoders.create(project, store, schedule);
    } catch (error) {
      // Don't strand a live WebGL context if setup fails; the caller gets the
      // error, not a leaked renderer.
      renderer.destroy();
      throw error;
    }

    return new PixiExportFrameSource(project, renderer, cache, resolution, frameRate, decoders);
  }

  async renderFrame(frame: number): Promise<VideoFrame> {
    if (this.disposed) throw new Error("Export frame source has been disposed.");
    const scene = resolveScene(this.project, frame);
    await prepareSceneMedia(scene, {
      decoder: this.decoders,
      targets: this.targets(),
      media: this.project.entities.media,
    });

    // displayWidth === project width ⇒ scale 1, i.e. a full-resolution draw.
    this.renderer.render(scene, this.project.entities.media, this.resolution.width, false);

    const timestamp = Math.round((frame * 1_000_000) / this.frameRate);
    const duration = Math.round(1_000_000 / this.frameRate);
    return this.renderer.captureFrame(timestamp, duration);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Fixed order, each step independently guarded so one failure cannot skip
    // the rest:
    //  1. Decoders — stop any in-flight decode touching a texture.
    //  2. Textures — release GPU/canvas resources while the GL context is still
    //     alive, so the destruction is a real free rather than a no-op on a dead
    //     context.
    //  3. Renderer — tear down the WebGL context and stage last.
    // This is what makes a finished or cancelled export leave nothing behind,
    // including each clip's scoped canvas.
    try {
      await this.decoders.dispose();
    } catch {
      // A decoder that refuses to close must not strand the rest.
    }
    try {
      this.cache.destroy();
    } catch {
      // Texture teardown is best-effort once the export is ending.
    }
    this.renderer.destroy();
  }

  /** Binds the preparer's target operations to this export's cache and scene. */
  private targets(): SceneMediaTargets<DecodedVideoFrame> {
    return {
      ensureTarget: (node, mediaId) => this.ensureScopedTarget(node, mediaId),
      drawDecoded: (node, frame) => this.cache.drawDecodedFrame(node.clipId, frame),
      load: async (mediaId, blobKey, kind) => {
        await this.cache.load(mediaId, blobKey, kind);
      },
      seek: (mediaId, seconds) => this.seekVideo(mediaId, seconds),
      drawFromElement: (node, mediaId) => this.cache.drawVideoElement(node.clipId, mediaId),
    };
  }

  /**
   * Registers this clip's own canvas-backed texture, sized to the source where
   * known (falling back to the output resolution for media with no metadata).
   */
  private ensureScopedTarget(node: SceneNode, mediaId: Id): void {
    if (node.content.kind !== "media") return;
    if (this.cache.hasScopedTexture(node.clipId)) return;

    const dimensions = this.project.entities.media[mediaId]?.metadata.dimensions;
    // Fall back to an already-loaded element's real size (the decoder-fallback
    // path has one), then to the output size when nothing reports dimensions.
    const element = this.cache.getVideoElement(mediaId);
    const width = dimensions?.width || element?.videoWidth || this.resolution.width;
    const height = dimensions?.height || element?.videoHeight || this.resolution.height;
    this.cache.registerScopedVideo(node.clipId, width, height);
  }

  /**
   * Fallback for media the WebCodecs decoder couldn't open: seeks a cached
   * video element to `seconds` so its current frame can be copied to the clip.
   * Frame accuracy is bounded by `<video>` seeking, so this is approximate — it
   * exists so an unusual container degrades in quality rather than failing the
   * export.
   */
  private seekVideo(mediaId: Id, seconds: number): Promise<void> {
    const element = this.cache.getVideoElement(mediaId);
    if (!element) return Promise.resolve();

    const target = Math.max(0, seconds);
    const alreadyThere = Math.abs(element.currentTime - target) < 1e-3 && element.readyState >= 2;

    return new Promise<void>((resolve) => {
      if (alreadyThere) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        element.removeEventListener("seeked", finish);
        resolve();
      };
      element.addEventListener("seeked", finish, { once: true });
      element.currentTime = target;
      // Safety net: never hang the whole export on a seek that never fires.
      setTimeout(finish, 1_000);
    });
  }
}
