import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FakeAudioContext, FakeMediaStream, FakeRenderer, SAMPLE_RATE, flushMicrotasks, resetFakes,
  type Frame,
} from "./audioFakes.ts";
import { parityAudio } from "./helpers.ts";
import { TalkingAvatar, type TalkingAvatarOptions } from "../src/TalkingAvatar.ts";
import type { AvatarRenderer, Mode } from "../src/renderer.ts";

// TalkingAvatar with the WebGL renderer swapped for FakeRenderer; the public API is untouched.
class TestAvatar extends TalkingAvatar {
  protected createRenderer(
    container: HTMLElement,
    getFrame: () => { visemes: Record<string, number>; mode: Mode },
  ): AvatarRenderer {
    return new FakeRenderer(container, getFrame) as unknown as AvatarRenderer;
  }

  frame(): Frame {
    // Reach the private renderer field without widening the production API.
    const renderer = (this as unknown as { renderer: FakeRenderer }).renderer;
    return renderer.frame();
  }
}

const newAvatar = (options: Partial<TalkingAvatarOptions> = {}) =>
  new TestAvatar({ container: {} as HTMLElement, modelUrl: "https://test/viseme-model.bin", ...options });

const hasMouthMovement = (frame: Frame) =>
  Object.values(frame.visemes).some((weight) => weight > 0.05);

const context = () => {
  assert.equal(FakeAudioContext.instances.length, 1, "exactly one AudioContext");
  return FakeAudioContext.instances[0];
};

/** "Encoded" clip: mono Float32 PCM that decodeAudioData in the fake turns back into an AudioBuffer. */
const clip = (samples: Float32Array) => samples.buffer.slice(0) as ArrayBuffer;

/** Wait until `predicate` holds, draining the event loop; fails the test if it never does within the budget. */
async function waitUntil(predicate: () => boolean, budgetMs = 10000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not met within the wait budget");
}

const waitForSource = () => waitUntil(() => context().bufferSources.length > 0);

test.beforeEach(() => resetFakes());

// ---------------------------------------------------------------------------
// Required scenarios
// ---------------------------------------------------------------------------

test("detachStream during a playing clip does not clear the clip's mouth", async () => {
  const avatar = newAvatar();
  const speaking = avatar.speak(clip(parityAudio)); // ~3 s of TTS at 16 kHz
  await waitForSource();
  const source = context().bufferSources[0];

  const ctx = context();
  ctx.setTime(source.startedAt! + 1); // one second into the clip, while it is sounding
  const clipFrame = avatar.frame();
  assert.equal(clipFrame.mode, "speaking");
  assert.ok(hasMouthMovement(clipFrame), "clip drives the mouth before detach");

  avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  await flushMicrotasks(2);
  avatar.detachStream(); // stream gone; clip still playing

  const afterDetach = avatar.frame();
  assert.equal(afterDetach.mode, "speaking", "clip still counts as speaking");
  assert.ok(hasMouthMovement(afterDetach), "clip visemes survived detachStream");
  assert.deepEqual(
    Object.keys(afterDetach.visemes).sort(), Object.keys(clipFrame.visemes).sort(),
    "the same clip timeline is still rendered",
  );

  source.onended!(); // clip finishes naturally
  await speaking;
  assert.equal(avatar.frame().mode, "listening", "natural end clears the clip timeline");
  avatar.dispose();
});

test("stopSpeaking during an attached stream does not clear the stream's mouth", async () => {
  const avatar = newAvatar();
  await avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  const ctx = context();
  const capture = ctx.captureNodes.at(-1)!;

  // Feed two blocks of real speech so the detector emits non-silence visemes.
  const block = 1024;
  for (let i = 0; i < 2; i += 1) {
    capture.port.onmessage!({ data: { time: i * block / ctx.sampleRate, samples: parityAudio.subarray(i * block, (i + 1) * block) } });
  }
  ctx.setTime(1.5); // well past the captured blocks' heard times
  const streamFrame = avatar.frame();
  assert.ok(hasMouthMovement(streamFrame), "stream drives the mouth");

  // A clip is started and immediately stopped: neither it nor stopSpeaking may touch stream events.
  const speakPromise = avatar.speak(clip(new Float32Array(1.5 * ctx.sampleRate)));
  avatar.stopSpeaking();
  await flushMicrotasks(2);
  await speakPromise;

  const afterStop = avatar.frame();
  assert.ok(hasMouthMovement(afterStop), "stream visemes survived stopSpeaking");
  assert.deepEqual(
    Object.keys(afterStop.visemes).sort(), Object.keys(streamFrame.visemes).sort(),
    "the same stream timeline is still rendered",
  );

  avatar.detachStream();
  assert.equal(hasMouthMovement(avatar.frame()), false, "detaching the stream clears its timeline");
  avatar.dispose();
});

test("two consecutive attachStream calls: only the last one stays attached", async () => {
  const avatar = newAvatar();
  await avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  const ctx = context();
  const firstCapture = ctx.captureNodes.at(-1)!;

  await avatar.attachStream(new FakeMediaStream() as unknown as MediaStream); // replaces the first, once it has fully attached
  const secondCapture = ctx.captureNodes.at(-1)!;
  assert.notEqual(firstCapture, secondCapture);
  assert.equal(firstCapture.port.onmessage, null, "the superseded stream's listener was detached");
  assert.notEqual(secondCapture.port.onmessage, null, "the latest stream is live");

  // A late block from the old (detached) stream must be ignored.
  const before = avatar.frame();
  const lateHandler = firstCapture.port.onmessage as ((event: { data: { time: number; samples: Float32Array } }) => void) | null;
  lateHandler?.({ data: { time: 0, samples: parityAudio.subarray(0, 1024) } });
  assert.deepEqual(avatar.frame(), before, "old stream cannot write events after replacement");

  avatar.detachStream();
  assert.equal(secondCapture.port.onmessage, null);
  avatar.dispose();
});

test("attachStream calls issued without awaiting: the stale call never attaches audio nodes", async () => {
  const avatar = newAvatar();
  const first = avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  const second = avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  await Promise.allSettled([first, second]);
  await flushMicrotasks();

  const ctx = context();
  const live = ctx.captureNodes.filter((node) => node.port.onmessage !== null);
  assert.equal(live.length, 1, "exactly one stream is live");
  // The destination has exactly one incoming edge: the winning stream's delay. Any node the suppressed
  // (stale) call created was either never connected or disconnected again.
  assert.equal(ctx.destination.incoming.length, 1, "only the winning stream reaches the destination");
  avatar.dispose();
});

test("attachStream racing a newer attachStream/detachStream never attaches the stale call", async () => {
  const avatar = newAvatar();
  const first = avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  const second = avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  avatar.detachStream(); // third operation before either promise resumed
  await flushMicrotasks(4);
  await Promise.allSettled([first, second]);

  const ctx = context();
  assert.equal(ctx.destination.incoming.length, 0, "stale calls never connect into the destination");
  avatar.dispose();
});

test("speak() cancelled during analysis schedules no audio and writes no events", async () => {
  const avatar = newAvatar();
  const eightSeconds = new Float32Array(1.5 * SAMPLE_RATE); // > 1 s analysis chunk -> yields to the loop

  // (a) stopSpeaking lands after the first analysis chunk.
  const speaking = avatar.speak(clip(eightSeconds));
  await waitUntil(() => FakeAudioContext.instances.length === 1);
  const ctx = context();
  await new Promise((resolve) => setTimeout(resolve, 0)); // speak() reaches its first inter-chunk yield
  avatar.stopSpeaking();
  await flushMicrotasks(3);
  await speaking;
  assert.equal(ctx.bufferSources.length, 0, "cancelled speak never schedules a buffer source");
  assert.equal(hasMouthMovement(avatar.frame()), false, "no viseme events were published");

  // (b) a newer speak() supersedes the pending one; only the newer clip may ever schedule.
  const stale = avatar.speak(clip(new Float32Array(1.5 * SAMPLE_RATE)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = avatar.speak(clip(parityAudio));
  await waitUntil(() => ctx.bufferSources.length === 1); // the stale one never schedules
  assert.equal(ctx.bufferSources.length, 1, "only the replacing clip scheduled audio");
  ctx.bufferSources[0].onended!(); // the audio thread would fire this when the clip finishes
  await Promise.all([stale, replacement]);
  avatar.dispose();
});

test("speak() stopped synchronously before any await schedules nothing", async () => {
  const avatar = newAvatar();
  const promise = avatar.speak(clip(parityAudio));
  avatar.stopSpeaking(); // races the fetch/decode microtasks
  await flushMicrotasks(8);
  await promise;
  assert.equal(context().bufferSources.length, 0);
  assert.equal(hasMouthMovement(avatar.frame()), false);
  avatar.dispose();
});

// ---------------------------------------------------------------------------
// Lifecycle / disposal races
// ---------------------------------------------------------------------------

test("dispose while attachStream is pending: the late callback changes nothing", async () => {
  const avatar = newAvatar();
  const pending = avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  avatar.dispose();
  await flushMicrotasks(4);
  await pending;
  const ctx = context();
  assert.equal(ctx.destination.incoming.length, 0, "no audio nodes attached after dispose");
  assert.equal(hasMouthMovement(avatar.frame()), false, "render view stays neutral");
});

test("dispose while speak() is analysing: no source, no events, no state mutation", async () => {
  const avatar = newAvatar();
  const pending = avatar.speak(clip(new Float32Array(1.5 * SAMPLE_RATE)));
  await waitUntil(() => FakeAudioContext.instances.length === 1);
  const ctx = context();
  await new Promise((resolve) => setTimeout(resolve, 0));
  avatar.dispose();
  await flushMicrotasks(4);
  await pending;
  assert.equal(ctx.bufferSources.length, 0);
  assert.equal(hasMouthMovement(avatar.frame()), false);
});

test("a clip's late onended after disposal does not revive its timeline", async () => {
  const avatar = newAvatar();
  const speaking = avatar.speak(clip(parityAudio));
  await waitForSource();
  const source = context().bufferSources[0];
  avatar.dispose(); // stopSpeaking runs inside dispose; onended is left to fire on the stopped source
  source.onended!(); // late, e.g. delivered by the audio thread after close()
  await speaking;
  assert.equal(hasMouthMovement(avatar.frame()), false);
});

// ---------------------------------------------------------------------------
// Merged-timeline semantics
// ---------------------------------------------------------------------------

test("stream and clip timelines merge while overlapping and separate cleanly", async () => {
  const avatar = newAvatar();
  await avatar.attachStream(new FakeMediaStream() as unknown as MediaStream);
  const ctx = context();
  const capture = ctx.captureNodes.at(-1)!;
  const block = 1024;
  for (let i = 0; i < 2; i += 1) {
    capture.port.onmessage!({
      data: { time: i * block / ctx.sampleRate, samples: parityAudio.subarray(i * block, (i + 1) * block) },
    });
  }

  const clipSpeaking = avatar.speak(clip(parityAudio));
  await waitUntil(() => ctx.bufferSources.length > 0);
  const source = ctx.bufferSources[0];

  ctx.setTime(Math.max(1.5, source.startedAt! + 1));
  const merged = avatar.frame();
  assert.equal(merged.mode, "speaking");
  assert.ok(hasMouthMovement(merged), "merged view animates while both sources are active");

  avatar.detachStream(); // stream stops; the clip's own mouth must keep moving
  const clipOnly = avatar.frame();
  assert.equal(clipOnly.mode, "speaking");
  assert.ok(hasMouthMovement(clipOnly), "clip timeline unaffected by the stream stopping");

  source.onended!();
  await clipSpeaking;
  assert.equal(hasMouthMovement(avatar.frame()), false, "nothing remains after both sources stop");
  avatar.dispose();
});

test("stopSpeaking removes residual clip events within the same frame", async () => {
  const avatar = newAvatar();
  const speaking = avatar.speak(clip(parityAudio));
  const ctx = context();
  await waitUntil(() => ctx.bufferSources.length > 0);
  ctx.setTime(ctx.bufferSources[0].startedAt! + 1);
  assert.ok(hasMouthMovement(avatar.frame()));

  avatar.stopSpeaking();
  assert.equal(hasMouthMovement(avatar.frame()), false, "clip events leave the merged view immediately");
  assert.equal(avatar.frame().mode, "listening");
  await speaking;
  avatar.dispose();
});

test("speak() resolves when the source's end event arrives, not before", async () => {
  const avatar = newAvatar();
  const speaking = avatar.speak(clip(parityAudio));
  await waitForSource();
  const source = context().bufferSources[0];

  let resolved = false;
  void speaking.then(() => { resolved = true; });
  await flushMicrotasks(2);
  assert.equal(resolved, false, "the promise stays pending while the clip is still sounding");
  source.onended!(); // natural end delivered by the audio thread
  await speaking;
  assert.equal(resolved, true);
  avatar.dispose();
});

test("stopSpeaking and detachStream are synchronous void and speak resolves on the resulting end event", async () => {
  const avatar = newAvatar();
  const speaking = avatar.speak(clip(parityAudio));
  await waitForSource();
  assert.equal(avatar.stopSpeaking(), undefined, "stopSpeaking returns void");
  await speaking; // the source's end event (emulated asynchronously by the audio thread) resolves it
  assert.equal(avatar.detachStream(), undefined, "detachStream returns void");
  avatar.dispose();
});
