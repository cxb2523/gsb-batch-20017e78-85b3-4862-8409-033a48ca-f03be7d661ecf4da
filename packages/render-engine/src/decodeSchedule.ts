/**
 * Planning which video frames an export will need, before it needs them.
 *
 * A frame-exact exporter decodes video with WebCodecs rather than by seeking a
 * `<video>` element, and the efficient decoding paths want the *whole* list of
 * wanted timestamps up front: given them in order, a decoder walks the stream
 * once and decodes each packet at most once, instead of re-decoding from a
 * keyframe for every single frame.
 *
 * So this walks the export's frame range ahead of time and records, per video
 * media, the source timestamps that will be asked for and the order they'll be
 * asked in. It is pure and derived from the same `resolveScene` the render loop
 * uses, which is what guarantees the schedule matches what the loop actually
 * requests — one entry per request, in the same sequence.
 */

import type { Frame, Id, ProjectDocument } from "@cutaway/types";
import { resolveScene } from "./scene";

/**
 * Source timestamps (seconds) each video media will be asked for, in request
 * order. Keyed by media id; only videos appear — images and GIFs aren't decoded
 * frame by frame.
 */
export type VideoDecodeSchedule = Map<Id, number[]>;

/**
 * One decode request the render loop will make: a single clip asking its source
 * media for the frame at a source time.
 *
 * `clipId` matters as much as `mediaId`: two clips can show the *same* media at
 * different source times on the same frame (an overlap, or a transition tail).
 * Those are two separate requests, and each must be drawn to its own target —
 * keying only by media would collapse them into one picture.
 */
export interface VideoDecodeRequest {
  clipId: Id;
  mediaId: Id;
  /** Already clamped to >= 0, matching what the render loop asks for. */
  sourceTimeSeconds: number;
}

/**
 * Builds the ordered request list for the half-open range `[startFrame, endFrame)`.
 *
 * The order is exactly the order the render loop will make the requests in:
 * frame by frame, then `resolveScene`'s node order within a frame. That is what
 * lets a consumer pull one decoded frame per request and stay in lockstep.
 */
export function planVideoDecodeRequests(
  project: ProjectDocument,
  startFrame: Frame,
  endFrame: Frame,
): VideoDecodeRequest[] {
  const requests: VideoDecodeRequest[] = [];

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (const node of resolveScene(project, frame).nodes) {
      if (node.content.kind !== "media" || node.content.mediaKind !== "video") continue;

      requests.push({
        clipId: node.clipId,
        mediaId: node.content.mediaId,
        // Never negative: a timestamp before the start of the stream is not a
        // thing a decoder can seek to, and clamping matches what playback shows.
        sourceTimeSeconds: Math.max(0, node.content.sourceTimeSeconds),
      });
    }
  }

  return requests;
}

/**
 * Builds the decode schedule for the half-open frame range `[startFrame, endFrame)`.
 *
 * A media that appears on several frames gets one entry per frame, and a media
 * used by two clips at once gets one entry per clip — the schedule mirrors
 * requests, not distinct times, so the consumer can pull exactly one decoded
 * frame per request and stay in lockstep.
 */
export function planVideoDecodeSchedule(
  project: ProjectDocument,
  startFrame: Frame,
  endFrame: Frame,
): VideoDecodeSchedule {
  const schedule: VideoDecodeSchedule = new Map();

  for (const request of planVideoDecodeRequests(project, startFrame, endFrame)) {
    const times = schedule.get(request.mediaId);
    if (times) times.push(request.sourceTimeSeconds);
    else schedule.set(request.mediaId, [request.sourceTimeSeconds]);
  }

  return schedule;
}
