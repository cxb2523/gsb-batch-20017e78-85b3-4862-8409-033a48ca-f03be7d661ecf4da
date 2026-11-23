import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ONNXProvider from "./onnxProvider";

import type { ONNXWorkerResponse, ONNXWorkerResult } from "../worker/types";

/**
 * Minimal stand-in for the ONNX worker that answers `init` and lets tests push
 * responses.
 */
class FakeWorker {
  static last: FakeWorker | null = null;
  static all: FakeWorker[] = [];

  private listeners: Array<(event: MessageEvent) => void> = [];
  posted: Array<{ type: string; [key: string]: unknown }> = [];
  isTerminated = false;

  constructor() {
    FakeWorker.last = this;
    FakeWorker.all.push(this);
  }

  /** Number of live message listeners (a retired worker must have none) */
  get listenerCount(): number {
    return this.listeners.length;
  }

  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.push(listener);
  }

  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  postMessage(message: { type: string; model?: { name: string } }) {
    this.posted.push(message);

    if (message.type === "init") {
      queueMicrotask(() => this.emit({ type: "initialized" }));
    }

    if (message.type === "loadModel" && message.model) {
      const modelName = message.model.name;
      queueMicrotask(() => this.emit({ type: "modelLoaded", modelName }));
    }
  }

  terminate() {
    this.isTerminated = true;
  }

  emit(data: ONNXWorkerResponse) {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent);
    }
  }
}

const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

let frameCallback: FrameRequestCallback | null = null;

/** Let queued microtasks and resolved promises settle */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWorker.all = [];
  frameCallback = null;
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ close: vi.fn() })),
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frameCallback = cb;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ONNXProvider fatal errors", () => {
  it("stops and reports once when the worker reports a fatal error", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    const onError = vi.fn();
    provider.onError?.(onError);
    await provider.initialize(video);

    FakeWorker.last?.emit({ type: "error", error: "blocked", fatal: true });
    FakeWorker.last?.emit({ type: "error", error: "blocked", fatal: true });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toMatch(/blocked/i);
  });

  it("keeps going after a recoverable worker error", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    const onError = vi.fn();
    provider.onError?.(onError);
    await provider.initialize(video);

    FakeWorker.last?.emit({ type: "error", error: "transient" });

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("ONNXProvider execution backend", () => {
  const model = { name: "yolo", path: "yolo.onnx" };

  it("runs on the CPU by default", async () => {
    const provider = new ONNXProvider({ onnx: { models: [model] } });
    await provider.initialize(video);

    expect(FakeWorker.last?.posted).toContainEqual({
      type: "loadModel",
      model,
      cpuOnly: true,
    });
  });

  it("allows WebGPU when `onnx.webgpu` is set", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);

    expect(FakeWorker.last?.posted).toContainEqual({
      type: "loadModel",
      model,
      cpuOnly: false,
    });
  });
});

describe("ONNXProvider WebGPU stall fallback", () => {
  const model = { name: "yolo", path: "yolo.onnx" };

  /** Start detection, send one frame, then let it stall past the timeout */
  const stallFirstFrame = async (provider: ONNXProvider) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);
    await flush();
    await flush();
  };

  it("restarts the worker on the CPU when a WebGPU frame stalls", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);
    const [gpuWorker] = FakeWorker.all;

    await stallFirstFrame(provider);

    expect(FakeWorker.all).toHaveLength(2);
    expect(gpuWorker.isTerminated).toBe(true);
    expect(gpuWorker.posted).toContainEqual({
      type: "loadModel",
      model,
      cpuOnly: false,
    });
    expect(FakeWorker.all[1].posted).toContainEqual({
      type: "loadModel",
      model,
      cpuOnly: true,
    });
  });

  it("only resets a stalled frame once already on the CPU", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);

    await stallFirstFrame(provider);
    await stallFirstFrame(provider);

    expect(FakeWorker.all).toHaveLength(2);
  });

  it("sends the next frame after the worker skips one", async () => {
    const provider = new ONNXProvider({ onnx: { models: [model] } });
    await provider.initialize(video);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    FakeWorker.last?.emit({ type: "skipped" });
    now.mockReturnValue(10_500);
    frameCallback?.(0);
    await flush();

    const frames = FakeWorker.last?.posted.filter((m) => m.type === "process");
    expect(frames).toHaveLength(2);
  });
});

describe("ONNXProvider CPU stalls", () => {
  it("never restarts the worker when already on the CPU", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [{ name: "yolo", path: "yolo.onnx" }] },
    });
    await provider.initialize(video);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);
    await flush();

    expect(FakeWorker.all).toHaveLength(1);
  });
});

/** A valid worker result payload; detections stay above the 0.5 default */
const workerResult = (): { type: "result"; result: ONNXWorkerResult } => ({
  type: "result",
  result: {
    detections: [
      {
        label: "cat",
        confidence: 0.9,
        bbox: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
    masks: [],
    frameSize: { width: 640, height: 480 },
    timestamp: 123,
  },
});

/** Subscribe and run one frame through to a posted `process` request */
const startWithOneFrame = async (provider: ONNXProvider) => {
  const frames = vi.fn();
  provider.onDetection(frames);
  provider.startDetection();
  await flush();
  expect(FakeWorker.last?.posted.some((m) => m.type === "process")).toBe(true);
  return frames;
};

describe("ONNXProvider stop/restart lifecycle", () => {
  it("dispatches no frames after stopDetection", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    const frames = await startWithOneFrame(provider);

    provider.stopDetection();
    FakeWorker.last?.emit(workerResult());
    await flush();

    expect(frames).not.toHaveBeenCalled();

    // No new frame is queued while paused
    const postedBefore = FakeWorker.last?.posted.length ?? 0;
    frameCallback?.(0);
    await flush();
    expect(FakeWorker.last?.posted).toHaveLength(postedBefore);
  });

  it("resumes dispatching after startDetection is called again", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    const frames = await startWithOneFrame(provider);

    provider.stopDetection();
    FakeWorker.last?.emit(workerResult());
    expect(frames).not.toHaveBeenCalled();

    provider.startDetection();
    await flush();
    FakeWorker.last?.emit(workerResult());

    expect(frames).toHaveBeenCalledOnce();
    expect(frames.mock.calls[0][0].objects[0].label).toBe("cat");
  });

  it("drops an in-flight result that arrives after stopDetection", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    const frames = await startWithOneFrame(provider);

    // The frame is already with the worker when detection is paused
    provider.stopDetection();
    FakeWorker.last?.emit(workerResult());
    FakeWorker.last?.emit({ type: "skipped" });

    expect(frames).not.toHaveBeenCalled();

    // Resuming starts a fresh frame rather than replaying the dropped one
    provider.startDetection();
    await flush();
    expect(frames).not.toHaveBeenCalled();
    FakeWorker.last?.emit(workerResult());
    expect(frames).toHaveBeenCalledOnce();
  });

  it("closes an ImageBitmap that resolves while stopped instead of posting it", async () => {
    const bitmap = { close: vi.fn() };
    let resolveBitmap: (b: typeof bitmap) => void = () => {};
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveBitmap = resolve;
          }),
      ),
    );
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    provider.startDetection();
    provider.stopDetection();
    resolveBitmap(bitmap);
    await flush();

    expect(bitmap.close).toHaveBeenCalled();
    expect(FakeWorker.last?.posted.some((m) => m.type === "process")).toBe(
      false,
    );
  });
});

describe("ONNXProvider WebGPU fallback isolation", () => {
  const model = { name: "yolo", path: "yolo.onnx" };

  /** Stall the first WebGPU frame until the CPU worker has replaced it */
  const stallAndRestart = async (provider: ONNXProvider) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);
    await flush();
    await flush();

    expect(FakeWorker.all).toHaveLength(2);
  };

  it("terminates the old worker and detaches its message listener", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);
    const [gpuWorker] = FakeWorker.all;

    await stallAndRestart(provider);

    expect(gpuWorker.isTerminated).toBe(true);
    expect(gpuWorker.listenerCount).toBe(0);
  });

  it("ignores late results and errors from the old worker", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);
    const frames = vi.fn();
    const onError = vi.fn();
    provider.onDetection(frames);
    provider.onError(onError);

    await stallAndRestart(provider);

    const [gpuWorker, cpuWorker] = FakeWorker.all;

    // Messages the stuck GPU worker delivers after retirement
    gpuWorker.emit(workerResult());
    gpuWorker.emit({ type: "error", error: "late gpu failure", fatal: true });
    await flush();

    expect(frames).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Only the replacement CPU worker's results reach subscribers
    provider.startDetection();
    await flush();
    cpuWorker.emit(workerResult());
    expect(frames).toHaveBeenCalledOnce();
  });

  it("does not auto-resume when the session was stopped during restart", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);
    const [gpuWorker] = FakeWorker.all;

    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);

    // The restart is now in flight (old worker already torn down). Pausing
    // before the replacement worker finishes must suppress the auto-resume.
    expect(gpuWorker.isTerminated).toBe(true);
    provider.stopDetection();
    await flush();
    await flush();

    const [, cpuWorker] = FakeWorker.all;
    expect(cpuWorker.posted.some((m) => m.type === "process")).toBe(false);

    cpuWorker.emit(workerResult());
    const frames = vi.fn();
    provider.onDetection(frames);
    expect(frames).not.toHaveBeenCalled();
  });

  it("honors an explicit startDetection requested during the restart", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);

    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);

    // The restart is now suspended awaiting the replacement worker's init.
    // A stop followed by an explicit resume must leave the session running.
    provider.stopDetection();
    provider.startDetection();

    await flush();
    await flush();

    const [, cpuWorker] = FakeWorker.all;
    expect(cpuWorker.posted.some((m) => m.type === "process")).toBe(true);
  });

  it("tears down the replacement worker when disposed during restart", async () => {
    const provider = new ONNXProvider({
      onnx: { models: [model], webgpu: true },
    });
    await provider.initialize(video);

    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    provider.startDetection();
    await flush();

    now.mockReturnValue(16_000);
    frameCallback?.(0);
    await flush();

    provider.dispose();
    await flush();
    await flush();

    const [gpuWorker, cpuWorker] = FakeWorker.all;
    expect(gpuWorker.isTerminated).toBe(true);
    expect(cpuWorker.isTerminated).toBe(true);
    expect(cpuWorker.listenerCount).toBe(0);

    // Nothing the late workers deliver can touch the disposed session
    expect(() => {
      gpuWorker.emit(workerResult());
      cpuWorker.emit(workerResult());
      cpuWorker.emit({ type: "error", error: "late", fatal: true });
    }).not.toThrow();
  });
});

describe("ONNXProvider dispose isolation", () => {
  it("ignores late worker messages after dispose without side effects", async () => {
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    const frames = vi.fn();
    const onError = vi.fn();
    provider.onDetection(frames);
    provider.onError(onError);
    const worker = FakeWorker.last;

    provider.dispose();

    expect(worker?.isTerminated).toBe(true);
    expect(worker?.listenerCount).toBe(0);

    // Even if a queued message somehow reached a detached handler, state and
    // subscribers must stay untouched
    worker?.emit(workerResult());
    worker?.emit({ type: "error", error: "post-dispose", fatal: true });
    worker?.emit({ type: "skipped" });
    worker?.emit({ type: "modelLoaded", modelName: "yolo" });
    await flush();

    expect(frames).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects initialization awaiting a worker that gets disposed", async () => {
    // Replace the auto-initializing fake so init never answers
    class QuietWorker extends FakeWorker {
      override postMessage(message: { type: string }) {
        this.posted.push(message);
      }
    }
    vi.stubGlobal("Worker", QuietWorker);

    const provider = new ONNXProvider({ provider: "onnx" });
    const init = provider.initialize(video);
    await flush();
    provider.dispose();

    await expect(init).rejects.toThrow(/stopped before it finished/);
  });

  it("releases a late ImageBitmap instead of posting it after dispose", async () => {
    const bitmap = { close: vi.fn() };
    let resolveBitmap: (b: typeof bitmap) => void = () => {};
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveBitmap = resolve;
          }),
      ),
    );
    const provider = new ONNXProvider({ provider: "onnx" });
    await provider.initialize(video);
    provider.startDetection();
    await flush();
    provider.dispose();
    resolveBitmap(bitmap);
    await flush();

    expect(bitmap.close).toHaveBeenCalled();
  });
});
