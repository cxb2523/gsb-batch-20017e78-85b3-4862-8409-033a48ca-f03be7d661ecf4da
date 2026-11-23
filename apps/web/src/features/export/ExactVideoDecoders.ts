"use client";

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { MediaBlobStore } from "@cutaway/media-engine";
import type { ClosableFrame, VideoDecodeSchedule } from "@cutaway/render-engine";
import type { Id, ProjectDocument } from "@cutaway/types";
import type { DrawableVideoFrame } from "@/features/preview/MediaTextureCache";

/**
 * A decoded frame handed to the exporter, which owns it until it closes it.
 *
 * The explicit `close()` is the point: a decoded frame pins a GPU/CPU buffer
 * (usually a `VideoFrame`), and an export that renders thousands of them leaks
 * the whole video's worth of memory if each is left to GC. The caller draws the
 * frame and closes it immediately, in a `finally`. It satisfies both the
 * render engine's `ClosableFrame` (so the preparation pass can close it) and the
 * texture cache's {@link DrawableVideoFrame} (so the cache can draw it).
 */
export type DecodedVideoFrame = ClosableFrame & DrawableVideoFrame;

/**
 * Frame-exact video decoding for export.
 *
 * Seeking a `<video>` element is the wrong tool for an exporter twice over: the
 * frame you get back is whatever the element settled on (and if the seek is slow
 * you may capture the *previous* one), and every seek re-decodes from the
 * nearest keyframe, so an export pays that cost once per frame.
 *
 * This decodes with WebCodecs instead, driven from a schedule computed up front.
 * Handed all the timestamps in order, the decoder walks each stream once and
 * decodes each packet at most once — so frames are both exactly right and far
 * cheaper than seeking. Feeding the schedule lazily is not an option: the
 * decoding pipeline only emits a frame once it knows the *next* timestamp, so a
 * one-at-a-time feed would deadlock. Hence the planning pass.
 *
 * Because the schedule and the render loop are both derived from `resolveScene`
 * over the same frames, the two stay in lockstep — one decoded frame per
 * request. {@link ExactVideoDecoders.next} still verifies that, and falls back
 * to a direct (slower) fetch if they ever disagree, so a drift becomes a slow
 * frame rather than a wrong one.
 */
export class ExactVideoDecoders {
  private constructor(private readonly tracks: Map<Id, DecoderTrack>) {}

  /**
   * Opens a decoder for every video in `schedule`.
   *
   * A media that can't be demuxed (an exotic container, a corrupt file) is
   * simply absent from the result: the caller then falls back to element
   * seeking for it, so one awkward file degrades quality instead of failing
   * the whole export.
   */
  static async create(
    project: ProjectDocument,
    store: MediaBlobStore,
    schedule: VideoDecodeSchedule,
  ): Promise<ExactVideoDecoders> {
    const tracks = new Map<Id, DecoderTrack>();

    await Promise.all(
      [...schedule].map(async ([mediaId, timestamps]) => {
        const asset = project.entities.media[mediaId];
        if (!asset || asset.source.type !== "indexeddb") return;

        const blob = await store.get(asset.source.key);
        if (!blob) return;

        const track = await DecoderTrack.open(blob, timestamps);
        if (track) tracks.set(mediaId, track);
      }),
    );

    return new ExactVideoDecoders(tracks);
  }

  /** True when this media is being decoded exactly (rather than seeked). */
  has(mediaId: Id): boolean {
    return this.tracks.has(mediaId);
  }

  /**
   * The next decoded frame for `mediaId`, which must be the one scheduled for
   * `expectedSeconds`. Returns null when the media isn't decoded here or the
   * stream has no frame at that time (before the first frame, or past the end).
   *
   * Ownership of a returned frame passes to the caller, which must `close()` it
   * once drawn.
   */
  next(mediaId: Id, expectedSeconds: number): Promise<DecodedVideoFrame | null> {
    const track = this.tracks.get(mediaId);
    return track ? track.next(expectedSeconds) : Promise.resolve(null);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.tracks.values()].map((track) => track.dispose()));
    this.tracks.clear();
  }
}

/** One video stream, plus the cursor into its planned timestamps. */
class DecoderTrack {
  private cursor = 0;

  private constructor(
    private readonly input: Input,
    private readonly sink: VideoSampleSink,
    private readonly timestamps: readonly number[],
    private iterator: AsyncGenerator<VideoSample | null> | null,
  ) {}

  static async open(blob: Blob, timestamps: number[]): Promise<DecoderTrack | null> {
    let input: Input | null = null;
    try {
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) {
        await input.dispose();
        return null;
      }

      // A sample sink yields the decoded frames themselves, so the caller can
      // draw and then close each one — unlike a canvas sink, whose pooled
      // canvases are reused out from under a frame that is still referenced.
      const sink = new VideoSampleSink(track);
      const iterator = sink.samplesAtTimestamps(timestamps);

      return new DecoderTrack(input, sink, timestamps, iterator);
    } catch {
      // Unreadable or unsupported — the caller falls back to element seeking.
      // Dispose any half-open input so a failed attempt leaks no demuxer.
      try {
        await input?.dispose();
      } catch {
        // Best-effort: we are already on the failure path.
      }
      return null;
    }
  }

  async next(expectedSeconds: number): Promise<DecodedVideoFrame | null> {
    const scheduled = this.timestamps[this.cursor];

    // Out of step with the plan (or past its end): fetch this one directly
    // rather than handing back a frame from the wrong moment. Correctness first;
    // this path is not expected to run.
    if (scheduled === undefined || Math.abs(scheduled - expectedSeconds) > 1e-6) {
      return this.fetchDirectly(expectedSeconds);
    }

    this.cursor += 1;
    const result = await this.iterator?.next();
    if (!result || result.done) return null;
    return wrap(result.value);
  }

  /** Random access for the off-schedule case; re-decodes from a keyframe. */
  private async fetchDirectly(seconds: number): Promise<DecodedVideoFrame | null> {
    const sample = await this.sink.getSample(seconds);
    return wrap(sample);
  }

  async dispose(): Promise<void> {
    await this.iterator?.return(undefined);
    this.iterator = null;
    await this.input.dispose();
  }
}

/**
 * Wraps a mediabunny sample as a closable frame.
 *
 * The sample's `draw()` already applies rotation metadata and stretches to the
 * destination box, matching the fit the compositor expects for a full-frame
 * video sprite.
 */
function wrap(sample: VideoSample | null): DecodedVideoFrame | null {
  if (!sample) return null;

  return {
    draw(context, width, height) {
      sample.draw(context, 0, 0, width, height);
    },
    close() {
      sample.close();
    },
  };
}
