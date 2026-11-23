import { describe, expect, it, vi } from "vitest";
import type { Clip, MediaAsset, ProjectDocument, Track } from "@cutaway/types";
import { staticValue } from "@cutaway/types";
import { createClip, createProject, createTrack } from "@cutaway/utils";
import { resolveScene } from "../scene";
import {
  prepareSceneMedia,
  type SceneFrameDecoder,
  type SceneMediaTargets,
} from "../mediaPreparation";

function videoContent(mediaId = "m1", speed = 1, sourceInFrame = 0) {
  return {
    kind: "video" as const,
    mediaId,
    sourceInFrame,
    speed,
    volume: staticValue(1),
    muted: false,
  };
}

function imageContent(mediaId = "img1") {
  return { kind: "image" as const, mediaId };
}

function asset(id: string, kind: MediaAsset["kind"] = "video"): MediaAsset {
  return {
    id,
    name: id,
    kind,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    source: { type: "indexeddb", key: `blob-${id}` },
    metadata: {
      durationSeconds: 10,
      frameRate: kind === "video" ? 30 : null,
      dimensions: { width: 1920, height: 1080 },
      hasAudio: false,
      hasVideo: true,
      codec: null,
      sampleRate: null,
      channels: null,
      byteSize: 0,
    },
    thumbnailKey: null,
    waveformKey: null,
    importedAt: 0,
  };
}

function projectWith(tracks: Track[], clips: Clip[], media: Record<string, MediaAsset> = {}) {
  const base = createProject();
  return {
    ...base,
    entities: {
      ...base.entities,
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      clips: Object.fromEntries(clips.map((c) => [c.id, c])),
      media,
    },
    trackOrder: tracks.map((t) => t.id),
  } as ProjectDocument;
}

/** A closable fake frame recording which request it answered and whether it closed. */
class FakeFrame {
  closed = false;
  constructor(
    readonly mediaId: string,
    readonly seconds: number,
  ) {}
  close() {
    this.closed = true;
  }
}

/**
 * A decoder that mimics the real one: it keeps a per-media cursor into the
 * planned timestamps and hands back exactly the next scheduled frame, so a
 * drifting consumer would receive the wrong one.
 */
function fakeDecoder(planned: Map<string, number[]>): SceneFrameDecoder<FakeFrame> & {
  frames: FakeFrame[];
} {
  const cursors = new Map<string, number>();
  const frames: FakeFrame[] = [];
  return {
    frames,
    has: (mediaId) => planned.has(mediaId),
    next: vi.fn(async (mediaId: string, seconds: number) => {
      const times = planned.get(mediaId);
      if (!times) return null;
      const cursor = cursors.get(mediaId) ?? 0;
      const scheduled = times[cursor];
      cursors.set(mediaId, cursor + 1);
      // The real decoder replays the queued frame even if the caller's time
      // drifts; the assertion lives in the test, not here.
      expect(scheduled).toBeCloseTo(seconds, 6);
      const frame = new FakeFrame(mediaId, seconds);
      frames.push(frame);
      return frame;
    }),
  };
}

function recordingTargets(): SceneMediaTargets<FakeFrame> & {
  ensured: string[];
  drawn: { clipId: string; mediaId: string; seconds: number; closedAtDraw: boolean }[];
  loaded: string[];
  seeks: { mediaId: string; seconds: number }[];
  drewFromElement: { clipId: string; mediaId: string }[];
} {
  const ensured: string[] = [];
  const drawn: { clipId: string; mediaId: string; seconds: number; closedAtDraw: boolean }[] = [];
  const loaded: string[] = [];
  const seeks: { mediaId: string; seconds: number }[] = [];
  const drewFromElement: { clipId: string; mediaId: string }[] = [];

  return {
    ensured,
    drawn,
    loaded,
    seeks,
    drewFromElement,
    ensureTarget: (node) => {
      ensured.push(node.clipId);
    },
    drawDecoded: (node, frame) => {
      drawn.push({
        clipId: node.clipId,
        mediaId: frame.mediaId,
        seconds: frame.seconds,
        closedAtDraw: frame.closed,
      });
    },
    load: async (mediaId) => {
      loaded.push(mediaId);
    },
    seek: async (mediaId, seconds) => {
      seeks.push({ mediaId, seconds });
    },
    drawFromElement: (node, mediaId) => {
      drewFromElement.push({ clipId: node.clipId, mediaId });
    },
  };
}

describe("prepareSceneMedia", () => {
  it("draws each overlapping clip's own frame into its own target", async () => {
    // The regression: one source, two clips on screen at once, different source
    // times. Both must be drawn, each at its own time, not the last one twice.
    const track = createTrack({ kind: "video", index: 0 });
    const other = createTrack({ kind: "video", index: 1 });
    const clips = [
      createClip({
        id: "clip-a",
        trackId: track.id,
        startFrame: 0,
        durationFrames: 2,
        content: videoContent("m1"),
      }),
      createClip({
        id: "clip-b",
        trackId: other.id,
        startFrame: 0,
        durationFrames: 2,
        content: videoContent("m1", 1, 30),
      }),
    ];
    const project = projectWith([track, other], clips, { m1: asset("m1") });

    const planned = new Map<string, number[]>();
    // Derive the real plan so the decoder stays in lockstep.
    const times: number[] = [];
    for (let frame = 0; frame < 2; frame += 1) {
      for (const node of resolveScene(project, frame).nodes) {
        if (node.content.kind === "media") times.push(Math.max(0, node.content.sourceTimeSeconds));
      }
    }
    planned.set("m1", times);

    const decoder = fakeDecoder(planned);
    const targets = recordingTargets();

    for (let frame = 0; frame < 2; frame += 1) {
      await prepareSceneMedia(resolveScene(project, frame), {
        decoder,
        targets,
        media: project.entities.media,
      });
    }

    // Four requests (2 clips × 2 frames), each drawn to its own clip. Track 0
    // draws in front, so it is prepared last in each frame's node order.
    expect(targets.drawn.map((d) => `${d.clipId}@${d.seconds}`)).toEqual([
      "clip-b@1",
      "clip-a@0",
      "clip-b@1.0333333333333334",
      "clip-a@0.03333333333333333",
    ]);
    // Every clip got its own target, once per prepared frame.
    expect(targets.ensured).toEqual(["clip-b", "clip-a", "clip-b", "clip-a"]);
  });

  it("closes every decoded frame after drawing it", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "clip-a",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 3,
      content: videoContent("m1"),
    });
    const project = projectWith([track], [clip], { m1: asset("m1") });
    const decoder = fakeDecoder(new Map([["m1", [0, 1 / 30, 2 / 30]]]));
    const targets = recordingTargets();

    for (let frame = 0; frame < 3; frame += 1) {
      await prepareSceneMedia(resolveScene(project, frame), {
        decoder,
        targets,
        media: project.entities.media,
      });
    }

    expect(decoder.frames).toHaveLength(3);
    expect(decoder.frames.every((f) => f.closed)).toBe(true);
    // A frame must be closed *after* its pixels are drawn, never before.
    expect(targets.drawn.every((d) => d.closedAtDraw === false)).toBe(true);
  });

  it("closes the frame even when drawing throws", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "clip-a",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 1,
      content: videoContent("m1"),
    });
    const project = projectWith([track], [clip], { m1: asset("m1") });
    const decoder = fakeDecoder(new Map([["m1", [0]]]));
    const targets = recordingTargets();
    targets.drawDecoded = () => {
      throw new Error("texture rejected the frame");
    };

    await expect(
      prepareSceneMedia(resolveScene(project, 0), {
        decoder,
        targets,
        media: project.entities.media,
      }),
    ).rejects.toThrow("texture rejected the frame");

    expect(decoder.frames).toHaveLength(1);
    expect(decoder.frames[0]!.closed).toBe(true);
  });

  it("keeps the last picture when the stream has no frame at that time", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "clip-a",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 2,
      content: videoContent("m1"),
    });
    const project = projectWith([track], [clip], { m1: asset("m1") });
    const decoder: SceneFrameDecoder<FakeFrame> = {
      has: () => true,
      next: async () => null,
    };
    const targets = recordingTargets();

    for (let frame = 0; frame < 2; frame += 1) {
      await prepareSceneMedia(resolveScene(project, frame), {
        decoder,
        targets,
        media: project.entities.media,
      });
    }

    // Targets were registered so a later frame can still land, but nothing was
    // drawn over the previous picture.
    expect(targets.ensured).toEqual(["clip-a", "clip-a"]);
    expect(targets.drawn).toHaveLength(0);
  });

  it("falls back to element seeking per clip, still isolated by clip", async () => {
    // The decoder can't open m1, so both clips seek the shared element. Each
    // must snapshot its own frame before the next clips seeks.
    const track = createTrack({ kind: "video", index: 0 });
    const other = createTrack({ kind: "video", index: 1 });
    const clips = [
      createClip({
        id: "clip-a",
        trackId: track.id,
        startFrame: 0,
        durationFrames: 1,
        content: videoContent("m1"),
      }),
      createClip({
        id: "clip-b",
        trackId: other.id,
        startFrame: 0,
        durationFrames: 1,
        content: videoContent("m1", 1, 30),
      }),
    ];
    const project = projectWith([track, other], clips, { m1: asset("m1") });

    const decoder: SceneFrameDecoder<FakeFrame> = { has: () => false, next: async () => null };
    const targets = recordingTargets();

    await prepareSceneMedia(resolveScene(project, 0), {
      decoder,
      targets,
      media: project.entities.media,
    });

    expect(targets.loaded).toEqual(["m1", "m1"]);
    expect(targets.seeks).toEqual([
      { mediaId: "m1", seconds: 1 },
      { mediaId: "m1", seconds: 0 },
    ]);
    // Each seek is followed by a copy for that clip, so the element moving on
    // does not change what the earlier clip shows.
    expect(targets.drewFromElement).toEqual([
      { clipId: "clip-b", mediaId: "m1" },
      { clipId: "clip-a", mediaId: "m1" },
    ]);
  });

  it("prepares images through the shared texture only, with no video target", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "img-clip",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 1,
      content: imageContent("img1"),
    });
    const project = projectWith([track], [clip], { img1: asset("img1", "image") });
    const decoder: SceneFrameDecoder<FakeFrame> = { has: () => false, next: async () => null };
    const targets = recordingTargets();

    await prepareSceneMedia(resolveScene(project, 0), {
      decoder,
      targets,
      media: project.entities.media,
    });

    expect(targets.loaded).toEqual(["img1"]);
    expect(targets.ensured).toHaveLength(0);
    expect(targets.seeks).toHaveLength(0);
    expect(targets.drewFromElement).toHaveLength(0);
  });

  it("ignores media with no resolvable asset instead of throwing", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "clip-a",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 1,
      content: videoContent("missing"),
    });
    // No media entry for "missing" at all.
    const project = projectWith([track], [clip]);
    const decoder: SceneFrameDecoder<FakeFrame> = { has: () => false, next: async () => null };
    const targets = recordingTargets();

    await expect(
      prepareSceneMedia(resolveScene(project, 0), {
        decoder,
        targets,
        media: project.entities.media,
      }),
    ).resolves.toBeUndefined();

    expect(targets.loaded).toHaveLength(0);
    expect(targets.ensured).toHaveLength(0);
  });

  it("skips invisible media, matching what the renderer draws", async () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      id: "clip-a",
      trackId: track.id,
      startFrame: 2,
      durationFrames: 2,
      content: videoContent("m1"),
    });
    const project = projectWith([track], [clip], { m1: asset("m1") });
    const decoder = fakeDecoder(new Map([["m1", [0, 1 / 30]]]));
    const targets = recordingTargets();

    // Frame 0 is before the clip; nothing should be prepared.
    await prepareSceneMedia(resolveScene(project, 0), {
      decoder,
      targets,
      media: project.entities.media,
    });

    expect(decoder.next).not.toHaveBeenCalled();
    expect(targets.drawn).toHaveLength(0);
  });
});
