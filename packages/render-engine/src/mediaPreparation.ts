/**
 * Preparing a scene's media sources before a frame is drawn.
 *
 * The realtime preview tolerates a texture that isn't ready yet: it draws what
 * it has and asks for another draw when a decode lands. An export cannot — the
 * captured frame would contain a stale or blank picture — so it must block until
 * every node's exact source frame is present. This module is that preparation
 * pass, kept DOM-free so its ordering, ownership, and isolation rules are
 * unit-testable without a browser or a decoder.
 *
 * **Why a target per clip.** The preview keeps one texture per media, which is
 * correct for it: two clips of one source show the same decoder state, so
 * sharing a texture shows each clip the frame it expects. An export asks each
 * clip for the frame at *its own* source time, and two clips can be on screen at
 * once — overlapping clips, or a transition's outgoing tail. If both painted
 * into one per-media canvas, whichever was prepared second would overwrite the
 * first, and the captured frame would show the same picture twice. So
 * preparation targets are keyed by clip, and the compositor looks textures up by
 * clip too. Images and GIFs are unaffected: their texture is the asset itself.
 */

import type { Id, MediaAsset } from "@cutaway/types";
import type { Scene, SceneNode } from "./scene";

/** A decoded frame that owns a resource and must be released after use. */
export interface ClosableFrame {
  close(): void;
}

/** A source of exactly-decoded frames, one per request. */
export interface SceneFrameDecoder<TFrame extends ClosableFrame> {
  /** True when this media is decoded here rather than via element seeking. */
  has(mediaId: Id): boolean;
  /**
   * The next decoded frame for `mediaId`, which must be the one scheduled for
   * `sourceTimeSeconds`. Null means the stream has no frame there (before its
   * first frame, or past its end), in which case the previous picture is kept.
   * Ownership of a returned frame passes to the caller, which must close it.
   */
  next(mediaId: Id, sourceTimeSeconds: number): Promise<TFrame | null>;
}

/**
 * Where prepared media goes.
 *
 * Every video method takes the whole node rather than just the media id, because
 * the destination is per clip. Implementations typically key their drawable
 * targets by `node.clipId`.
 */
export interface SceneMediaTargets<TFrame extends ClosableFrame> {
  /**
   * Registers this clip's own drawable target if it has none yet. Only videos
   * need one; images and GIFs keep the shared per-media texture.
   */
  ensureTarget(node: SceneNode, mediaId: Id): void;
  /** Copies a decoded frame into this clip's target. Must not close the frame. */
  drawDecoded(node: SceneNode, frame: TFrame): void;
  /** Loads (and caches) the media-level texture; a no-op when already loaded. */
  load(mediaId: Id, blobKey: string, kind: "video" | "image" | "gif"): Promise<void>;
  /** Seeks the shared `<video>` element to `seconds`, for the fallback path. */
  seek(mediaId: Id, seconds: number): Promise<void>;
  /**
   * Copies the shared element's current frame into this clip's target, so the
   * next clip may seek the element without disturbing this clip's picture.
   */
  drawFromElement(node: SceneNode, mediaId: Id): void;
}

export interface SceneMediaPreparation<TFrame extends ClosableFrame> {
  decoder: SceneFrameDecoder<TFrame>;
  targets: SceneMediaTargets<TFrame>;
  media: Record<Id, MediaAsset>;
}

/**
 * Ensures every media node in the scene is ready to draw, sequentially in draw
 * order.
 *
 * Sequential rather than parallel for two reasons: the decoders hand back frames
 * in the planned order, so two nodes racing one stream could take each other's
 * frame; and the element fallback must snapshot one clip's frame before the next
 * clip re-seeks the shared element.
 */
export async function prepareSceneMedia<TFrame extends ClosableFrame>(
  scene: Scene,
  options: SceneMediaPreparation<TFrame>,
): Promise<void> {
  const { decoder, targets, media } = options;

  for (const node of scene.nodes) {
    if (node.content.kind !== "media") continue;
    const { mediaId, mediaKind, sourceTimeSeconds } = node.content;

    // Never negative: a timestamp before the start of the stream is not a thing
    // a decoder can seek to, and clamping matches what playback shows.
    const targetSeconds = Math.max(0, sourceTimeSeconds);

    if (mediaKind === "video" && decoder.has(mediaId)) {
      targets.ensureTarget(node, mediaId);
      const frame = await decoder.next(mediaId, targetSeconds);
      // A null frame means the stream has nothing here; leave the last frame.
      if (frame) {
        try {
          targets.drawDecoded(node, frame);
        } finally {
          // Each decoded frame pins a decoded buffer. It must be released the
          // moment its pixels are copied into the clip's canvas — including when
          // the draw throws — or a long export leaks one frame per frame.
          frame.close();
        }
      }
      continue;
    }

    const asset = media[mediaId];
    if (!asset || asset.source.type !== "indexeddb") continue;

    await targets.load(mediaId, asset.source.key, mediaKind);
    if (mediaKind !== "video") continue;

    // Fallback: the decoder couldn't open this media, so seek the element.
    // Still per clip, so an overlap on this path stays isolated too.
    targets.ensureTarget(node, mediaId);
    await targets.seek(mediaId, targetSeconds);
    targets.drawFromElement(node, mediaId);
  }
}
