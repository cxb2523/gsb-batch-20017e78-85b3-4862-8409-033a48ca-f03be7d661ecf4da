import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MediaPipeProvider from "./mediapipeProvider";

vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: vi.fn() },
  HandLandmarker: { createFromOptions: vi.fn() },
  FaceLandmarker: { createFromOptions: vi.fn() },
  PoseLandmarker: { createFromOptions: vi.fn() },
}));

const video = {} as HTMLVideoElement;

beforeEach(() => {
  // mockReset clears implementations between tests, so re-establish them
  vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValue(
    {} as Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  );
  const model = { close: vi.fn() };
  vi.mocked(HandLandmarker.createFromOptions).mockResolvedValue(
    model as unknown as HandLandmarker,
  );
  vi.mocked(FaceLandmarker.createFromOptions).mockResolvedValue(
    model as unknown as FaceLandmarker,
  );
  vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValue(
    model as unknown as PoseLandmarker,
  );
});

describe("MediaPipeProvider task gating", () => {
  it("loads only the hand landmarker when tasks=['hands']", async () => {
    const provider = new MediaPipeProvider({ tasks: ["hands"], useGpu: false });
    await provider.initialize(video);

    expect(HandLandmarker.createFromOptions).toHaveBeenCalledOnce();
    expect(FaceLandmarker.createFromOptions).not.toHaveBeenCalled();
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled();
  });

  it("loads only the requested subset when tasks=['faces','poses']", async () => {
    const provider = new MediaPipeProvider({
      tasks: ["faces", "poses"],
      useGpu: false,
    });
    await provider.initialize(video);

    expect(HandLandmarker.createFromOptions).not.toHaveBeenCalled();
    expect(FaceLandmarker.createFromOptions).toHaveBeenCalledOnce();
    expect(PoseLandmarker.createFromOptions).toHaveBeenCalledOnce();
  });

  it("loads all three when tasks is unspecified", async () => {
    const provider = new MediaPipeProvider({ useGpu: false });
    await provider.initialize(video);

    expect(HandLandmarker.createFromOptions).toHaveBeenCalledOnce();
    expect(FaceLandmarker.createFromOptions).toHaveBeenCalledOnce();
    expect(PoseLandmarker.createFromOptions).toHaveBeenCalledOnce();
  });

  it("disables the pose segmentation mask by default", async () => {
    const provider = new MediaPipeProvider({ tasks: ["poses"], useGpu: false });
    await provider.initialize(video);

    const opts = vi.mocked(PoseLandmarker.createFromOptions).mock.calls[0][1];
    expect(opts.outputSegmentationMasks).toBe(false);
  });
});

describe("MediaPipeProvider fatal errors", () => {
  const liveVideo = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

  const handModel = (detect: () => unknown, close = vi.fn()) => {
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValue({
      detectForVideo: vi.fn(detect),
      close,
    } as unknown as HandLandmarker);
  };

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops and reports once when the MediaPipe runtime traps", async () => {
    const trap = new WebAssembly.RuntimeError("index out of bounds");
    handModel(() => {
      throw trap;
    });
    const provider = new MediaPipeProvider({ tasks: ["hands"], useGpu: false });
    const onError = vi.fn();
    provider.onError?.(onError);
    await provider.initialize(liveVideo);

    provider.startDetection();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].cause).toBe(trap);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("keeps processing after a recoverable error", async () => {
    handModel(() => {
      throw new Error("transient");
    });
    const provider = new MediaPipeProvider({ tasks: ["hands"], useGpu: false });
    const onError = vi.fn();
    provider.onError?.(onError);
    await provider.initialize(liveVideo);

    provider.startDetection();

    expect(onError).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it("disposes cleanly when a crashed model throws on close", async () => {
    handModel(
      () => ({ landmarks: [] }),
      vi.fn(() => {
        throw new WebAssembly.RuntimeError("index out of bounds");
      }),
    );
    const provider = new MediaPipeProvider({ tasks: ["hands"], useGpu: false });
    await provider.initialize(liveVideo);

    expect(() => provider.dispose()).not.toThrow();
  });
});

describe("MediaPipeProvider wasm source", () => {
  it("loads the wasm matching the supported MediaPipe major by default", async () => {
    const provider = new MediaPipeProvider({ tasks: ["hands"], useGpu: false });
    await provider.initialize(video);

    expect(FilesetResolver.forVisionTasks).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1/wasm",
    );
  });

  it("loads the wasm from `mediapipe.wasmBasePath` when set", async () => {
    const provider = new MediaPipeProvider({
      tasks: ["hands"],
      useGpu: false,
      mediapipe: { wasmBasePath: "/mediapipe/wasm" },
    });
    await provider.initialize(video);

    expect(FilesetResolver.forVisionTasks).toHaveBeenCalledWith(
      "/mediapipe/wasm",
    );
  });
});

describe("MediaPipeProvider stop/restart lifecycle", () => {
  const liveVideo = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

  /**
   * rAF mock that stores callbacks so tests can pump frames manually. Each
   * `pump` runs one scheduled callback (mirroring a real rAF tick). The clock
   * starts at 0 and advances 100ms per pump, clearing the 16ms throttle.
   */
  const pumpableRaf = () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      queue.length = 0;
    });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    let t = 0;
    const pump = () => {
      t += 100;
      clock.mockReturnValue(t);
      queue.shift()?.(t);
    };
    return { pump };
  };

  const handModelThatDetects = () => {
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValue({
      detectForVideo: vi.fn(() => ({ landmarks: [], handednesses: [] })),
      close: vi.fn(),
    } as unknown as HandLandmarker);
  };

  it("dispatches no frames after stopDetection", async () => {
    handModelThatDetects();
    const { pump } = pumpableRaf();
    const provider = new MediaPipeProvider({
      tasks: ["hands"],
      useGpu: false,
    });
    await provider.initialize(liveVideo);
    const frames = vi.fn();
    provider.onDetection(frames);

    provider.startDetection();
    pump();
    expect(frames).toHaveBeenCalledOnce();

    provider.stopDetection();
    pump();
    pump();

    expect(frames).toHaveBeenCalledOnce();
  });

  it("resumes dispatching after startDetection is called again", async () => {
    handModelThatDetects();
    const { pump } = pumpableRaf();
    const provider = new MediaPipeProvider({
      tasks: ["hands"],
      useGpu: false,
    });
    await provider.initialize(liveVideo);
    const frames = vi.fn();
    provider.onDetection(frames);

    provider.startDetection();
    pump();
    provider.stopDetection();
    expect(frames).toHaveBeenCalledOnce();

    // Resuming runs a frame inline immediately, then continues per tick
    provider.startDetection();
    expect(frames).toHaveBeenCalledTimes(2);
    pump();
    expect(frames).toHaveBeenCalledTimes(3);
  });

  it("never calls back after dispose, even from a queued frame", async () => {
    handModelThatDetects();
    const { pump } = pumpableRaf();
    const provider = new MediaPipeProvider({
      tasks: ["hands"],
      useGpu: false,
    });
    await provider.initialize(liveVideo);
    const frames = vi.fn();
    provider.onDetection(frames);

    provider.startDetection();
    pump();
    provider.dispose();
    pump();
    pump();

    expect(frames).toHaveBeenCalledOnce();
  });

  it("releases models that finish loading after dispose", async () => {
    // Re-establish every mock inside the test: the vitest config's mockReset
    // clears implementations shared via the file-level beforeEach.
    vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValue(
      {} as Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    );
    const close = vi.fn();
    let resolveModel: (model: HandLandmarker) => void = () => {};
    vi.mocked(HandLandmarker.createFromOptions).mockReturnValue(
      new Promise<HandLandmarker>((resolve) => {
        resolveModel = resolve;
      }),
    );

    const provider = new MediaPipeProvider({
      tasks: ["hands"],
      useGpu: false,
    });
    const init = provider.initialize(liveVideo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    provider.dispose();
    resolveModel({ close } as unknown as HandLandmarker);
    await init;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(close).toHaveBeenCalled();
  });
});
