// ONNX provider - supports ONNX models like RF-DETR and YOLO

import VisionStoppedError from "./visionStoppedError";

import type {
  ONNXModelConfig,
  VisionFrame,
  VisionProvider,
  VisionSessionOptions,
} from "../types";
import type {
  ONNXWorkerRequest,
  ONNXWorkerResponse,
  ONNXWorkerResult,
} from "../worker/types";

/**
 * Timeout before treating a frame as stalled. With `onnx.webgpu` a stall
 * restarts the worker on the CPU (some GPU and driver setups hang on WebGPU
 * inference); on the CPU it just resets.
 */
const PROCESSING_STALL_TIMEOUT = 5000;

/** Rejection used when a worker is torn down before it finished initializing */
class WorkerGoneError extends Error {
  constructor() {
    super("ONNX worker was stopped before it finished initializing");
    this.name = "WorkerGoneError";
  }
}

class ONNXProvider implements VisionProvider {
  readonly type = "onnx" as const;

  private worker: Worker | null = null;
  /**
   * Bumped every time the worker is replaced. Every message carries the
   * generation of the worker that sent it, so responses from a terminated
   * worker can never affect the current session.
   */
  private workerGeneration = 0;
  private isInitialized = false;
  private isDisposed = false;
  private isProcessing = false;
  private videoElement: HTMLVideoElement | null = null;
  private animationId: number | null = null;
  private loadedModels = new Map<string, ONNXModelConfig>();
  private lastProcessTime = 0;
  private processingStartTime = 0;
  private callbacks: Array<(frame: VisionFrame) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  /**
   * Resumable pause flag: `stopDetection` sets it, `startDetection` clears it.
   * While set, no frames are dispatched or queued and in-flight results are
   * dropped.
   */
  private isStopped = false;
  /** A fatal failure has stopped detection for good; restart cannot resume */
  private hasFailed = false;
  /** Run on the CPU (wasm) only: the default, and after a WebGPU stall */
  private cpuOnly: boolean;
  private isRestarting = false;
  private options: VisionSessionOptions;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private pendingModelCallbacks = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  constructor(options: VisionSessionOptions) {
    this.options = options;
    this.cpuOnly = !options.onnx?.webgpu;
  }

  /** Post a typed request to the worker, with an optional transfer list */
  private post(message: ONNXWorkerRequest, transfer?: Transferable[]): void {
    if (transfer) {
      this.worker?.postMessage(message, transfer);
    } else {
      this.worker?.postMessage(message);
    }
  }

  async initialize(video: HTMLVideoElement): Promise<void> {
    this.videoElement = video;

    await this.startWorker();
  }

  /**
   * Create the worker, wait for it to initialize, and load the configured
   * models.
   */
  private async startWorker(): Promise<void> {
    const generation = ++this.workerGeneration;
    this.worker = new Worker(
      new URL("../worker/onnxWorker.ts", import.meta.url),
      { type: "module" },
    );

    // Single persistent message handler for all worker messages. It captures
    // the worker's generation so a worker that has since been replaced can
    // never drive state or callbacks.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ONNX worker initialization timeout"));
      }, 10000);

      this.initReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      this.messageHandler = (event: MessageEvent) => {
        // Stale worker: it was terminated (stall fallback or dispose) but a
        // queued message still arrived. Ignore everything it has to say.
        if (generation !== this.workerGeneration) return;

        const data = event.data as ONNXWorkerResponse;

        switch (data.type) {
          case "initialized": {
            clearTimeout(timeout);
            this.initReject = null;
            this.isInitialized = true;
            resolve();
            break;
          }
          case "result": {
            this.isProcessing = false;
            this.handleResult(data.result);
            break;
          }
          case "skipped": {
            this.isProcessing = false;
            break;
          }
          case "modelLoaded": {
            const pending = this.pendingModelCallbacks.get(data.modelName);
            if (pending) {
              this.pendingModelCallbacks.delete(data.modelName);
              pending.resolve();
            }
            break;
          }
          case "modelError": {
            const pending = this.pendingModelCallbacks.get(data.modelName);
            if (pending) {
              this.pendingModelCallbacks.delete(data.modelName);
              pending.reject(new Error(data.error));
            }
            break;
          }
          case "error": {
            this.isProcessing = false;
            if (!this.isInitialized) {
              clearTimeout(timeout);
              reject(new Error(data.error));
            } else if (data.fatal) {
              this.fail(
                data.error,
                "Vision tracking stopped because this browser blocked reading camera frames. Allow canvas access for this site, or turn off strict fingerprinting protection.",
              );
            } else {
              console.error("ONNX worker error:", data.error);
            }
            break;
          }
        }
      };

      this.worker?.addEventListener("message", this.messageHandler);
      this.post({ type: "init" });
    });

    // Load configured models
    const models = this.options.onnx?.models ?? [];
    for (const model of models) {
      await this.loadModel(model);
    }
  }

  startDetection(): void {
    if (this.isDisposed || this.hasFailed) return;

    // A CPU-fallback restart is still rebuilding the worker. Record the
    // resume intent; restartOnCpu starts the frame loop once it is ready.
    if (this.isRestarting) {
      this.isStopped = false;
      return;
    }

    if (!this.isInitialized || !this.videoElement) {
      console.warn("ONNX provider not initialized");
      return;
    }

    // A restart may already be driving the frame loop
    if (this.animationId !== null) return;

    this.isStopped = false;

    const processFrame = () => {
      if (
        !this.videoElement ||
        !this.isInitialized ||
        this.isStopped ||
        this.isDisposed ||
        this.hasFailed
      ) {
        return;
      }

      const now = Date.now();
      const throttle = this.options.throttle ?? 100;
      if (now - this.lastProcessTime < throttle) {
        this.animationId = requestAnimationFrame(processFrame);
        return;
      }

      // Stall recovery: the worker hasn't responded to the last frame
      if (
        this.isProcessing &&
        this.processingStartTime > 0 &&
        now - this.processingStartTime > PROCESSING_STALL_TIMEOUT
      ) {
        if (!this.cpuOnly) {
          void this.restartOnCpu();
          return;
        }

        console.warn("ONNX processing stall detected, resetting");
        this.isProcessing = false;
      }

      if (!this.isProcessing) {
        this.processCurrentFrame();
      }

      this.animationId = requestAnimationFrame(processFrame);
    };

    processFrame();
  }

  /**
   * Resumable pause: cancel the frame loop so no new frames are queued and
   * drop any inference still in flight — its result must not reach
   * subscribers. Calling `startDetection` afterwards resumes detection.
   */
  stopDetection(): void {
    this.isStopped = true;
    this.cancelFrameLoop();
  }

  /**
   * Internal loop teardown that does not flip the user-facing pause flag, so
   * the WebGPU fallback restart can suspend scheduling without being mistaken
   * for an explicit stop.
   */
  private cancelFrameLoop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // The in-flight frame belongs to the paused session; when its result
    // arrives `handleResult` discards it because the session is stopped.
    this.isProcessing = false;
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

  /**
   * Stop detection for good and notify error subscribers once.
   */
  private fail(cause: unknown, message: string): void {
    if (this.hasFailed || this.isDisposed) return;

    this.hasFailed = true;
    this.stopDetection();
    console.error("Vision processing stopped:", cause);

    const error = new VisionStoppedError(message, cause);

    for (const callback of this.errorCallbacks) callback(error);
  }

  dispose(): void {
    this.isDisposed = true;
    this.stopDetection();
    this.teardownWorker();

    this.videoElement = null;
    this.callbacks.length = 0;
    this.errorCallbacks.length = 0;
  }

  /**
   * Terminate the worker (cancelling any in-flight inference), detach its
   * message listener, and forget its models. Bumping the generation means any
   * message a terminated worker still delivers is ignored.
   */
  private teardownWorker(): void {
    if (this.worker) {
      if (this.messageHandler) {
        this.worker.removeEventListener("message", this.messageHandler);
        this.messageHandler = null;
      }
      this.post({ type: "dispose" });
      this.worker.terminate();
      this.worker = null;
    }

    // A startWorker() awaiting this worker can never finish; reject it rather
    // than leaving the promise pending forever.
    this.initReject?.(new WorkerGoneError());
    this.initReject = null;

    for (const pending of this.pendingModelCallbacks.values()) {
      pending.reject(new WorkerGoneError());
    }

    this.workerGeneration += 1;
    this.loadedModels.clear();
    this.pendingModelCallbacks.clear();
    this.isInitialized = false;
    this.isProcessing = false;
  }

  /**
   * Replace a worker stuck on WebGPU inference with one that runs on the CPU,
   * then resume detection — unless the session was stopped or disposed while
   * the restart was in flight.
   */
  private async restartOnCpu(): Promise<void> {
    if (this.isRestarting || this.isDisposed || this.hasFailed) return;

    this.isRestarting = true;
    this.cpuOnly = true;
    console.warn("ONNX inference stalled on WebGPU, falling back to the CPU");

    // Suspend the frame loop and fully retire the stuck worker. This is an
    // internal restart, not a user pause: isStopped keeps its previous value
    // (false while detection was running), so only an explicit stopDetection
    // during the restart can suppress the auto-resume below. The worker's
    // listener is detached and its generation retired, so any late result or
    // error is isolated from the replacement worker's session.
    this.cancelFrameLoop();
    this.teardownWorker();

    try {
      await this.startWorker();
    } catch (error) {
      this.fail(
        error,
        "Vision tracking stopped because object detection could not restart.",
      );
      return;
    } finally {
      this.isRestarting = false;
    }

    // The session may have been stopped or disposed while the new worker was
    // starting; never auto-resume in that case.
    if (this.isDisposed) {
      this.teardownWorker();
      return;
    }

    if (!this.isStopped && !this.hasFailed) this.startDetection();
  }

  private async loadModel(model: ONNXModelConfig): Promise<void> {
    if (!this.worker) throw new Error("Worker not initialized");

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingModelCallbacks.set(model.name, { resolve, reject });
    });

    this.post({ type: "loadModel", model, cpuOnly: this.cpuOnly });

    await promise;
    this.loadedModels.set(model.name, model);
  }

  private processCurrentFrame(): void {
    if (!this.videoElement || !this.worker || this.isProcessing) return;

    const now = Date.now();
    this.isProcessing = true;
    this.lastProcessTime = now;
    this.processingStartTime = now;

    const { videoWidth, videoHeight } = this.videoElement;
    // Capture the generation this frame belongs to so a bitmap resolving
    // after a worker replacement is never posted to the wrong worker.
    const generation = this.workerGeneration;

    // Send the full-resolution frame; the worker letterboxes to the model's
    // input size so aspect ratio is preserved and boxes map back correctly.
    createImageBitmap(this.videoElement).then(
      (bitmap) => {
        // The frame was queued before a pause, worker replacement or dispose:
        // never post it (its result could never be dispatched) and release the
        // bitmap instead of leaking it.
        if (
          this.isDisposed ||
          this.isStopped ||
          generation !== this.workerGeneration
        ) {
          bitmap.close();
          return;
        }

        this.post(
          {
            type: "process",
            imageBitmap: bitmap,
            sourceWidth: videoWidth,
            sourceHeight: videoHeight,
            options: {
              minConfidence: this.options.minConfidence ?? 0.5,
              maxResults: this.options.maxResults ?? 100,
            },
          },
          [bitmap],
        );
      },
      (error) => {
        if (this.isDisposed || this.isStopped) return;
        if (generation !== this.workerGeneration) return;
        this.isProcessing = false;
        console.error("Error creating ImageBitmap:", error);
      },
    );
  }

  private handleResult(result: ONNXWorkerResult): void {
    // A paused, failed or disposed session never dispatches: results for
    // frames sent before stopDetection/dispose are dropped on the floor.
    if (this.isStopped || this.isDisposed || this.hasFailed) return;

    const minConfidence = this.options.minConfidence ?? 0.5;
    const maxResults = this.options.maxResults ?? 100;

    // Filter and limit
    const objects = result.detections
      .filter((d) => d.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxResults);

    const frame: VisionFrame = {
      hands: [],
      faces: [],
      poses: [],
      objects,
      masks: result.masks.length > 0 ? result.masks : undefined,
      timestamp: result.timestamp,
      frameSize: result.frameSize,
      processingTime: result.processingTime,
    };

    for (const callback of this.callbacks) {
      try {
        callback(frame);
      } catch (error) {
        console.error("Error in ONNX detection callback:", error);
      }
    }
  }
}

export default ONNXProvider;
