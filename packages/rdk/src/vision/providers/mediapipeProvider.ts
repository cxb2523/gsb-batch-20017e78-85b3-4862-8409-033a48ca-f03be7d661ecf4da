// MediaPipe provider - handles hand/face/pose detection on the main thread
//
// Runs inference inline rather than in a Web Worker. MediaPipe's
// `detectForVideo` accepts the HTMLVideoElement directly, avoiding
// ImageBitmap serialisation issues that silently break detection on
// mobile browsers.

import VisionStoppedError from "./visionStoppedError";

import type {
  LandmarkDetection,
  VisionFrame,
  VisionProvider,
  VisionSessionOptions,
} from "../types";

type Models = {
  // biome-ignore lint/suspicious/noExplicitAny: MediaPipe model instances
  handLandmarker?: any;
  // biome-ignore lint/suspicious/noExplicitAny: MediaPipe model instances
  faceLandmarker?: any;
  // biome-ignore lint/suspicious/noExplicitAny: MediaPipe model instances
  poseLandmarker?: any;
};

// keep the major in sync with the `@mediapipe/tasks-vision` peer range, since
// the JS bundle and wasm must come from the same release
const DEFAULT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1/wasm";

class MediaPipeProvider implements VisionProvider {
  readonly type = "mediapipe" as const;

  private models: Models = {};
  private isInitialized = false;
  private isProcessing = false;
  private isDisposed = false;
  /**
   * Resumable pause flag: `stopDetection` sets it, `startDetection` clears it.
   * While set, the frame loop exits without scheduling and no frame — even one
   * already being computed — is dispatched.
   */
  private isStopped = false;
  /** A fatal runtime trap has stopped detection for good */
  private hasFailed = false;
  private videoElement: HTMLVideoElement | null = null;
  private animationId: number | null = null;
  private lastProcessTime = 0;
  private callbacks: Array<(frame: VisionFrame) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private options: VisionSessionOptions;

  constructor(options: VisionSessionOptions) {
    this.options = options;
  }

  async initialize(video: HTMLVideoElement): Promise<void> {
    this.videoElement = video;

    const { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker } =
      await import("@mediapipe/tasks-vision");

    // A dispose during the dynamic import or model downloads must not leave
    // a half-built provider behind.
    if (this.isDisposed) return;

    const vision = await FilesetResolver.forVisionTasks(
      this.options.mediapipe?.wasmBasePath ?? DEFAULT_WASM_BASE_PATH,
    );

    if (this.isDisposed) return;

    const delegate = (this.options.useGpu ?? true) ? "GPU" : "CPU";

    const createWithFallback = async <T>(
      create: (d: "GPU" | "CPU") => Promise<T>,
    ): Promise<T> => {
      if (delegate === "CPU") return create("CPU");
      try {
        return await create("GPU");
      } catch {
        console.warn("MediaPipe GPU delegate failed, falling back to CPU");
        return create("CPU");
      }
    };

    // Only load (and later run) the landmarkers for the requested tasks. Loading
    // and running all three per frame is ~3x the necessary main-thread work.
    const tasks = new Set(this.options.tasks ?? ["hands", "faces", "poses"]);
    const steps = (["hands", "faces", "poses"] as const).filter((t) =>
      tasks.has(t),
    );
    let step = 0;

    if (tasks.has("hands")) {
      this.options.onProgress?.({
        step: ++step,
        total: steps.length,
        label: "hand landmarker",
      });
      const handLandmarker = await createWithFallback((d) =>
        HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: d,
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.7,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      );
      if (this.isDisposed) {
        this.closeQuietly(handLandmarker);
        return;
      }
      this.models.handLandmarker = handLandmarker;
    }

    if (tasks.has("faces")) {
      this.options.onProgress?.({
        step: ++step,
        total: steps.length,
        label: "face landmarker",
      });
      const faceLandmarker = await createWithFallback((d) =>
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: d,
          },
          runningMode: "VIDEO",
          numFaces: 1,
          minFaceDetectionConfidence: 0.7,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        }),
      );
      if (this.isDisposed) {
        this.closeQuietly(faceLandmarker);
        return;
      }
      this.models.faceLandmarker = faceLandmarker;
    }

    if (tasks.has("poses")) {
      this.options.onProgress?.({
        step: ++step,
        total: steps.length,
        label: "pose landmarker",
      });
      const poseLandmarker = await createWithFallback((d) =>
        PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: d,
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.7,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: this.options.segmentation ?? false,
        }),
      );
      if (this.isDisposed) {
        this.closeQuietly(poseLandmarker);
        return;
      }
      this.models.poseLandmarker = poseLandmarker;
    }

    this.isInitialized = true;
    this.options.onProgress?.(null);
  }

  startDetection(): void {
    if (this.isDisposed || this.hasFailed) return;
    if (!this.isInitialized || !this.videoElement) return;
    // A frame loop is already running; nothing to resume
    if (this.isProcessing) return;

    this.isStopped = false;
    // The first frame of a resumed session must not lose to the throttle
    // timestamp left by the frame that ran just before the pause
    this.lastProcessTime = 0;
    this.isProcessing = true;
    this.processFrame();
  }

  /**
   * Resumable pause: stop the frame loop so no new frames run and any frame
   * whose inference is still finishing is discarded. Calling
   * `startDetection` afterwards resumes detection.
   */
  stopDetection(): void {
    this.isStopped = true;
    this.isProcessing = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  onDetection(callback: (frame: VisionFrame) => void): () => void {
    this.callbacks.push(callback);

    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index > -1) this.callbacks.splice(index, 1);
    };
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.push(callback);

    return () => {
      const index = this.errorCallbacks.indexOf(callback);
      if (index > -1) this.errorCallbacks.splice(index, 1);
    };
  }

  dispose(): void {
    this.isDisposed = true;
    this.stopDetection();

    for (const model of Object.values(this.models)) {
      this.closeQuietly(model);
    }
    this.models = {};

    this.videoElement = null;
    this.callbacks = [];
    this.errorCallbacks = [];
    this.isInitialized = false;
    this.isProcessing = false;
  }

  /** Close a model without throwing (a trapped runtime rejects close) */
  private closeQuietly(model: Models[keyof Models]): void {
    try {
      model?.close();
    } catch {
      // a model whose runtime already trapped throws on close; nothing is left to release
    }
  }

  private processFrame = () => {
    if (
      !this.isProcessing ||
      this.isStopped ||
      this.hasFailed ||
      !this.videoElement ||
      this.isDisposed
    ) {
      return;
    }

    const now = performance.now();
    const throttle = this.options.throttle ?? 16;
    if (now - this.lastProcessTime < throttle) {
      this.animationId = requestAnimationFrame(this.processFrame);
      return;
    }

    const { videoWidth, videoHeight } = this.videoElement;
    if (videoWidth === 0 || videoHeight === 0) {
      this.animationId = requestAnimationFrame(this.processFrame);
      return;
    }

    this.lastProcessTime = now;
    const timestamp = now;

    try {
      const result: VisionFrame = {
        hands: [],
        faces: [],
        poses: [],
        objects: [],
        timestamp,
        frameSize: { width: videoWidth, height: videoHeight },
      };

      if (this.models.handLandmarker) {
        const raw = this.models.handLandmarker.detectForVideo(
          this.videoElement,
          timestamp,
        );
        result.hands = raw.landmarks.map(
          // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
          (landmarks: any[], index: number) => ({
            // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
            landmarks: landmarks.map((l: any) => ({
              x: l.x,
              y: l.y,
              z: l.z || 0,
            })),
            confidence: raw.handednesses?.[index]?.[0]?.score || 0.5,
          }),
        );
      }

      if (this.models.faceLandmarker) {
        const raw = this.models.faceLandmarker.detectForVideo(
          this.videoElement,
          timestamp,
        );
        // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
        result.faces = raw.faceLandmarks.map((landmarks: any[]) => {
          // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
          const xs = landmarks.map((l: any) => l.x as number);
          // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
          const ys = landmarks.map((l: any) => l.y as number);
          const bboxWidth = Math.max(...xs) - Math.min(...xs);
          const bboxHeight = Math.max(...ys) - Math.min(...ys);
          const bboxArea = bboxWidth * bboxHeight;
          const confidence = Math.min(0.95, Math.max(0.6, bboxArea * 4));

          return {
            // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
            landmarks: landmarks.map((l: any) => ({
              x: l.x,
              y: l.y,
              z: l.z || 0,
            })),
            confidence,
          } satisfies LandmarkDetection;
        });
      }

      if (this.models.poseLandmarker) {
        const raw = this.models.poseLandmarker.detectForVideo(
          this.videoElement,
          timestamp,
        );
        // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
        result.poses = raw.landmarks.map((landmarks: any[]) => {
          let visibilitySum = 0;
          let visibilityCount = 0;
          for (const landmark of landmarks) {
            if (typeof landmark.visibility === "number") {
              visibilitySum += landmark.visibility;
              visibilityCount++;
            }
          }
          const confidence =
            visibilityCount > 0 ? visibilitySum / visibilityCount : 0.5;

          return {
            // biome-ignore lint/suspicious/noExplicitAny: MediaPipe landmark type
            landmarks: landmarks.map((l: any) => ({
              x: l.x,
              y: l.y,
              z: l.z || 0,
            })),
            confidence,
          } satisfies LandmarkDetection;
        });

        // Extract segmentation mask from pose result
        const segMask = raw.segmentationMasks?.[0];
        if (segMask) {
          const canvas = new OffscreenCanvas(segMask.width, segMask.height);
          // biome-ignore lint/style/noNonNullAssertion: guaranteed by OffscreenCanvas support
          const ctx = canvas.getContext("2d")!;
          const maskData = segMask.getAsFloat32Array();
          const imageData = ctx.createImageData(segMask.width, segMask.height);
          for (let i = 0; i < maskData.length; i++) {
            const v = maskData[i] * 255;
            imageData.data[i * 4] = v;
            imageData.data[i * 4 + 1] = v;
            imageData.data[i * 4 + 2] = v;
            imageData.data[i * 4 + 3] = 255;
          }
          result.segmentationMask = imageData;
        }
      }

      this.handleResult(result);
    } catch (error) {
      // a trap leaves the MediaPipe runtime unusable, so retrying every frame
      // only spins (and can hang the tab); stop and report it once instead
      if (error instanceof WebAssembly.RuntimeError) {
        this.fail(error);
        return;
      }

      console.error("Vision processing error:", error);
    }

    this.animationId = requestAnimationFrame(this.processFrame);
  };

  /**
   * Stop detection for good and notify error subscribers.
   */
  private fail(cause: unknown): void {
    if (this.hasFailed || this.isDisposed) return;

    this.hasFailed = true;
    this.stopDetection();
    console.error("Vision processing stopped:", cause);

    const error = new VisionStoppedError(
      "Vision tracking stopped because this browser blocked a graphics feature it needs. Strict fingerprinting protection is a common cause.",
      cause,
    );

    for (const callback of this.errorCallbacks) callback(error);
  }

  private handleResult(result: VisionFrame): void {
    // A paused, failed or disposed session never dispatches a frame, even if
    // inference for it finished just after stopDetection/dispose.
    if (this.isStopped || this.hasFailed || this.isDisposed) return;

    const minConfidence = this.options.minConfidence ?? 0.7;
    const maxResults = this.options.maxResults ?? 2;

    const filtered: VisionFrame = {
      ...result,
      hands: result.hands
        .filter((h) => h.confidence >= minConfidence)
        .slice(0, maxResults),
      faces: result.faces
        .filter((f) => f.confidence >= minConfidence)
        .slice(0, maxResults),
      poses: result.poses
        .filter((p) => p.confidence >= minConfidence)
        .slice(0, maxResults),
      objects: [],
    };

    for (const callback of this.callbacks) {
      try {
        callback(filtered);
      } catch (error) {
        console.error("Error in vision callback:", error);
      }
    }
  }
}

export default MediaPipeProvider;
