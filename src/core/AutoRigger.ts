import * as THREE from 'three';
import { MeshAnalyzer } from '../topology/MeshAnalyzer';
import { ProceduralIK } from '../ik/ProceduralIK';
import { RiggingOptions, IKTarget, SkeletonRig } from '../types';

/**
 * Error used to settle a rig request that was superseded by a newer one
 * (or explicitly cancelled). Distinct from worker/infrastructure failures so
 * callers can tell "my request was replaced" apart from "the engine broke".
 */
export class RigCancelledError extends Error {
  constructor(message = '[AutoRig] Rig request was cancelled: superseded by a newer rig request.') {
    super(message);
    this.name = 'RigCancelledError';
  }
}

/** Expected worker reply type for each request type. */
const RESPONSE_TYPES: Record<string, string> = {
  INIT: 'INIT_DONE',
  RIG: 'RIG_DONE',
};

interface PendingRequest {
  type: string;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  /** Releases buffers/placeholders held by this request (cancel/failure path). */
  cleanup?: () => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class AutoRigger {
  private analyzer: MeshAnalyzer;
  private ikSolver: ProceduralIK;
  private worker: Worker | null = null;
  private isInitialized = false;
  private msgIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private activeSkeleton?: THREE.Skeleton;

  constructor(private options: RiggingOptions = {}) {
    this.analyzer = new MeshAnalyzer();
    this.ikSolver = new ProceduralIK(options.ikIterations ?? 15);
  }

  async init(): Promise<void> {
    if (this.isInitialized && this.worker) return;

    // Drop any broken/half-initialized worker before establishing a new one.
    this.teardownWorker();

    // Fallback URL resolving for both Vite and plain build output
    const workerUrl = new URL(
      // @ts-ignore
      import.meta.env ? '../worker/rigWorker.ts' : './worker/rigWorker.js',
      import.meta.url
    );
    const worker = new Worker(workerUrl, { type: 'module' });
    this.worker = worker;

    worker.onmessage = (e) => this.handleWorkerMessage(e);
    worker.onerror = (e) => {
      const message = (e as ErrorEvent)?.message ?? 'unknown worker error';
      this.handleWorkerFailure(new Error(`[AutoRig] Worker error: ${message}`));
    };

    console.log('[AutoRig] Initializing ML Engine in Worker...');

    // If the worker answers INIT with ERROR (or crashes), handleWorkerFailure
    // rejects this promise and resets state, so init() can simply be retried.
    await this.postWorkerMessage('INIT', {
      modelPath: this.options.modelPath || '/models/joint_estimator_v1.onnx'
    });

    this.isInitialized = true;
    console.log('[AutoRig] Ready.');
  }

  private handleWorkerMessage(e: MessageEvent) {
    const { type, payload, msgId } = e.data ?? {};

    if (type === 'ERROR') {
      // Any ERROR from the worker is treated as fatal: reject every in-flight
      // request, drop all bookkeeping, and tear the worker down so the next
      // init() establishes a fresh one.
      this.handleWorkerFailure(new Error(`[AutoRig] Worker failed: ${payload ?? 'unknown error'}`));
      return;
    }

    const req = this.pendingRequests.get(msgId);
    if (!req) return; // stale reply for a cancelled/already-settled request

    const expected = RESPONSE_TYPES[req.type];
    if (expected && type !== expected) {
      // Never settle a request with a mismatched reply (e.g. an INIT_DONE
      // must not resolve a RIG request with a skeleton-shaped hole).
      console.warn(
        `[AutoRig] Ignoring mismatched worker reply '${type}' for pending '${req.type}' request ${msgId}.`
      );
      return;
    }

    if (req.timeoutId) clearTimeout(req.timeoutId);
    this.pendingRequests.delete(msgId);
    req.resolve(payload);
  }

  /**
   * Fatal-failure convergence: reject and clear ALL in-flight requests,
   * release their buffers, and tear down the worker so a later init()
   * re-establishes a clean engine.
   */
  private handleWorkerFailure(error: Error) {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();

    for (const req of pending) {
      if (req.timeoutId) clearTimeout(req.timeoutId);
      try { req.cleanup?.(); } catch { /* best-effort release */ }
      req.reject(error);
    }

    this.teardownWorker();
    this.isInitialized = false;
  }

  private teardownWorker(): void {
    if (this.worker) {
      try {
        if (typeof this.worker.terminate === 'function') this.worker.terminate();
      } catch { /* ignore teardown errors */ }
      this.worker = null;
    }
  }

  /**
   * Cancel every in-flight RIG request (by construction there is at most one):
   * the old call rejects with a RigCancelledError instead of silently
   * resolving with a skeleton that belongs to a newer request.
   */
  private cancelInFlightRigs(reason?: string): void {
    for (const [msgId, req] of this.pendingRequests) {
      if (req.type !== 'RIG') continue;
      if (req.timeoutId) clearTimeout(req.timeoutId);
      this.pendingRequests.delete(msgId);
      try { req.cleanup?.(); } catch { /* best-effort release */ }
      req.reject(new RigCancelledError(reason));
    }
  }

  private postWorkerMessage(
    type: string,
    payload: any,
    transfers: Transferable[] = [],
    cleanup?: () => void
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        try { cleanup?.(); } catch { /* best-effort release */ }
        reject(new Error('[AutoRig] Worker is not available.'));
        return;
      }

      const msgId = ++this.msgIdCounter;
      const req: PendingRequest = { type, resolve, reject, cleanup };

      const timeoutMs = this.options.requestTimeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        req.timeoutId = setTimeout(() => {
          if (!this.pendingRequests.delete(msgId)) return;
          try { req.cleanup?.(); } catch { /* best-effort release */ }
          reject(new Error(`[AutoRig] ${type} request ${msgId} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }

      this.pendingRequests.set(msgId, req);

      try {
        worker.postMessage({ type, payload, msgId }, transfers);
      } catch (err) {
        // postMessage itself failed (e.g. detached/uncloneable payload):
        // settle immediately instead of leaking a pending entry.
        if (req.timeoutId) clearTimeout(req.timeoutId);
        this.pendingRequests.delete(msgId);
        try { req.cleanup?.(); } catch { /* best-effort release */ }
        reject(err);
      }
    });
  }

  /**
   * Dual-Pipe Autonomous Auto-Rigging:
   * 1. If crossOriginIsolated & SharedArrayBuffer are available: zero-copy shared memory.
   * 2. Otherwise: zero-copy Transferable ArrayBuffers (works anywhere without COOP/COEP headers).
   *
   * Only one RIG request is ever in flight: calling rig() again cancels the
   * previous request, which rejects with a RigCancelledError.
   */
  async rig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    if (!this.isInitialized || !this.worker) throw new Error('[AutoRig] Engine not initialized.');

    // Supersede any in-flight rig before posting a new one.
    this.cancelInFlightRigs();

    console.log('[AutoRig] Analyzing topology & detecting joints in Worker...');

    const geometry = mesh.geometry;
    const positions = geometry.attributes.position.array as Float32Array;
    const vertexCount = positions.length / 3;

    const isSABSupported = typeof SharedArrayBuffer !== 'undefined' &&
      (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

    if (isSABSupported) {
      // Tier 1: SharedArrayBuffer Zero-Copy
      let posBuffer: SharedArrayBuffer | null = new SharedArrayBuffer(positions.length * Float32Array.BYTES_PER_ELEMENT);
      new Float32Array(posBuffer).set(positions);

      let indicesBuffer: SharedArrayBuffer | null = new SharedArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      let weightsBuffer: SharedArrayBuffer | null = new SharedArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      // On cancel/failure, drop every reference to the shared placeholders so
      // they can be reclaimed and no stale weights are ever bound to a mesh.
      const releaseBuffers = () => {
        posBuffer = null;
        indicesBuffer = null;
        weightsBuffer = null;
      };

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'SAB',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff: this.options.skinningFalloff ?? 2.0
      }, [], releaseBuffers);

      const rig = payload.rig as SkeletonRig;
      console.log('[AutoRig] Applying procedural skin weights (SAB mode)...');
      const skinnedMesh = this.analyzer.bindSkeletonWithWeights(
        mesh,
        rig,
        new Uint16Array(indicesBuffer!),
        new Float32Array(weightsBuffer!)
      );
      this.activeSkeleton = skinnedMesh.skeleton;
      return skinnedMesh;
    } else {
      // Tier 2: Universal Transferable ArrayBuffer Zero-Copy (No CORS/Spectre headers required)
      let posBuffer: ArrayBuffer | null = new Float32Array(positions).buffer;
      let indicesBuffer: ArrayBuffer | null = new ArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      let weightsBuffer: ArrayBuffer | null = new ArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      // The buffers are transferred to the worker on postMessage; on
      // cancel/failure we must not keep (neutered) references around.
      const releaseBuffers = () => {
        posBuffer = null;
        indicesBuffer = null;
        weightsBuffer = null;
      };

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'TRANSFERABLE',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff: this.options.skinningFalloff ?? 2.0
      }, [posBuffer, indicesBuffer, weightsBuffer], releaseBuffers);

      const rig = payload.rig as SkeletonRig;
      const resultIndices = new Uint16Array(payload.indicesBuffer);
      const resultWeights = new Float32Array(payload.weightsBuffer);

      const skinnedMesh = this.analyzer.bindSkeletonWithWeights(mesh, rig, resultIndices, resultWeights);
      this.activeSkeleton = skinnedMesh.skeleton;
      return skinnedMesh;
    }
  }

  /**
   * Alias for rig(mesh) for backward compatibility.
   */
  async autoRig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    return this.rig(mesh);
  }

  animate(): void {
    if (this.activeSkeleton) {
      this.ikSolver.solve(this.activeSkeleton);
    }
  }

  setIKTarget(target: IKTarget): void {
    this.ikSolver.addTarget(target);
  }

  /**
   * Reject all in-flight requests and tear down the worker. The engine can be
   * brought back with a fresh init().
   */
  dispose(): void {
    this.handleWorkerFailure(new RigCancelledError('[AutoRig] Engine disposed.'));
  }
}

export { AutoRigger as RiggingEngine };
