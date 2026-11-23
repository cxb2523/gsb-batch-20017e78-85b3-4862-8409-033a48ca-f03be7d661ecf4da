import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { AutoRigger, RigCancelledError } from '../src/core/AutoRigger';
import { JointType, SkeletonRig } from '../src/types';

function makeRig(): SkeletonRig {
  return {
    joints: {
      [JointType.Hips]: { type: JointType.Hips, position: { x: 0, y: 0, z: 0 }, confidence: 1 }
    } as any,
    hierarchy: {
      [JointType.Hips]: []
    } as any
  };
}

function makeMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

/**
 * Local mock Worker. No real ONNX model involved — it answers INIT/RIG
 * messages asynchronously and can be scripted to hang, misreply, ERROR,
 * or crash via onerror.
 */
class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;

  /** ms delay before RIG replies. */
  rigDelay = 10;
  /** When set, RIG requests are answered with this message type instead of RIG_DONE. */
  rigReplyType: string | null = null;
  /** When true, RIG requests are never answered (simulates a hung worker). */
  hangOnRig = false;
  /** When set, the next RIG request is answered with an ERROR carrying this message. */
  failNextRigWith: string | null = null;
  /** When set, INIT is answered with an ERROR carrying this message. */
  failInitWith: string | null = null;

  constructor(public url: any, public opts?: any) {
    MockWorker.instances.push(this);
  }

  postMessage(data: any, _transfers?: any) {
    if (data.type === 'INIT') {
      setTimeout(() => {
        if (this.failInitWith) {
          this.onmessage?.({ data: { type: 'ERROR', payload: this.failInitWith, msgId: data.msgId } });
        } else {
          this.onmessage?.({ data: { type: 'INIT_DONE', msgId: data.msgId } });
        }
      }, 5);
    } else if (data.type === 'RIG') {
      if (this.hangOnRig) return;
      setTimeout(() => {
        if (this.terminated) return;
        if (this.failNextRigWith) {
          const message = this.failNextRigWith;
          this.failNextRigWith = null;
          this.onmessage?.({ data: { type: 'ERROR', payload: message, msgId: data.msgId } });
          return;
        }
        const p = data.payload;
        // The real worker writes skin weights into the provided buffers
        // (shared or transferred); do the same so both paths are exercised.
        const idx = new Uint16Array(p.indicesBuffer);
        const weights = new Float32Array(p.weightsBuffer);
        for (let i = 0; i < idx.length; i++) idx[i] = 0;
        for (let i = 0; i < weights.length; i++) weights[i] = i % 4 === 0 ? 1 : 0;

        const payload: any = { rig: makeRig() };
        if (p.mode === 'TRANSFERABLE') {
          payload.indicesBuffer = p.indicesBuffer;
          payload.weightsBuffer = p.weightsBuffer;
        }
        this.onmessage?.({
          data: { type: this.rigReplyType ?? 'RIG_DONE', msgId: data.msgId, payload }
        });
      }, this.rigDelay);
    }
  }

  terminate() {
    this.terminated = true;
  }

  /** Simulate a hard worker crash (uncaught exception inside the worker). */
  crash() {
    this.onerror?.({ message: 'worker exploded' });
  }
}

function lastWorker(): MockWorker {
  return MockWorker.instances[MockWorker.instances.length - 1];
}

describe('AutoRigger lifecycle', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    // @ts-ignore
    global.Worker = MockWorker;
  });

  afterEach(() => {
    delete (globalThis as any).crossOriginIsolated;
  });

  it('rigs a mesh normally over the TRANSFERABLE path', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const skinnedMesh = await engine.rig(makeMesh());

    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinnedMesh.geometry.getAttribute('skinIndex')).toBeDefined();
    expect(skinnedMesh.geometry.getAttribute('skinWeight')).toBeDefined();
    expect(skinnedMesh.skeleton.bones.length).toBe(1);
    expect(skinnedMesh.skeleton.bones[0].name).toBe(JointType.Hips);
    // skinIndex/skinWeight must match the vertex count (2 vertices x 4 influences)
    expect(skinnedMesh.geometry.getAttribute('skinIndex').count).toBe(2);
    expect(skinnedMesh.geometry.getAttribute('skinWeight').count).toBe(2);
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('rigs a mesh normally over the SAB path when cross-origin isolated', async () => {
    (globalThis as any).crossOriginIsolated = true;
    const engine = new AutoRigger();
    await engine.init();

    const skinnedMesh = await engine.rig(makeMesh());

    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinnedMesh.geometry.getAttribute('skinIndex').count).toBe(2);
    expect(skinnedMesh.geometry.getAttribute('skinWeight').count).toBe(2);
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('cancels the previous in-flight rig when rig() is called again', async () => {
    const engine = new AutoRigger();
    await engine.init();
    lastWorker().rigDelay = 30;

    const first = engine.rig(makeMesh());
    const second = engine.rig(makeMesh());

    await expect(first).rejects.toBeInstanceOf(RigCancelledError);
    const skinnedMesh = await second;
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinnedMesh.skeleton.bones.length).toBe(1);

    // The stale RIG_DONE for the cancelled request must not leave bookkeeping behind.
    await new Promise((r) => setTimeout(r, 60));
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('cancels the previous in-flight rig on the SAB path too', async () => {
    (globalThis as any).crossOriginIsolated = true;
    const engine = new AutoRigger();
    await engine.init();
    lastWorker().rigDelay = 30;

    const first = engine.rig(makeMesh());
    const second = engine.rig(makeMesh());

    await expect(first).rejects.toBeInstanceOf(RigCancelledError);
    const skinnedMesh = await second;
    expect(skinnedMesh.geometry.getAttribute('skinIndex').count).toBe(2);

    await new Promise((r) => setTimeout(r, 60));
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('rejects all in-flight requests on worker ERROR and recovers via init()', async () => {
    const engine = new AutoRigger();
    await engine.init();
    const worker = lastWorker();

    worker.failNextRigWith = 'boom';
    await expect(engine.rig(makeMesh())).rejects.toThrow(/boom/);

    expect((engine as any).pendingRequests.size).toBe(0);
    expect(worker.terminated).toBe(true);

    // A fresh init() must establish a new worker and rig normally again.
    await engine.init();
    expect(MockWorker.instances.length).toBe(2);
    expect(lastWorker()).not.toBe(worker);

    const skinnedMesh = await engine.rig(makeMesh());
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
  });

  it('rejects in-flight requests on worker crash (onerror) and recovers via init()', async () => {
    const engine = new AutoRigger();
    await engine.init();
    const worker = lastWorker();
    worker.rigDelay = 30;

    const inFlight = engine.rig(makeMesh());
    worker.crash();

    await expect(inFlight).rejects.toThrow(/worker exploded/);
    expect((engine as any).pendingRequests.size).toBe(0);
    expect(worker.terminated).toBe(true);

    await engine.init();
    expect(MockWorker.instances.length).toBe(2);

    const skinnedMesh = await engine.rig(makeMesh());
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
  });

  it('rejects init() when the worker fails during INIT and can be retried', async () => {
    const engine = new AutoRigger();
    const initAttempt = engine.init();
    lastWorker().failInitWith = 'model load failed';

    await expect(initAttempt).rejects.toThrow(/model load failed/);
    expect((engine as any).pendingRequests.size).toBe(0);

    // Retry: a new worker is created and init succeeds.
    await engine.init();
    expect(MockWorker.instances.length).toBe(2);

    const skinnedMesh = await engine.rig(makeMesh());
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
  });

  it('never settles a RIG request with a mismatched INIT_DONE reply', async () => {
    const engine = new AutoRigger({ requestTimeoutMs: 50 });
    await engine.init();
    lastWorker().rigReplyType = 'INIT_DONE';

    await expect(engine.rig(makeMesh())).rejects.toThrow(/timed out/);
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('times out a hung RIG request and releases its bookkeeping', async () => {
    const engine = new AutoRigger({ requestTimeoutMs: 40 });
    await engine.init();
    lastWorker().hangOnRig = true;

    await expect(engine.rig(makeMesh())).rejects.toThrow(/timed out/);
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('dispose() rejects in-flight requests with a cancellation error', async () => {
    const engine = new AutoRigger();
    await engine.init();
    lastWorker().rigDelay = 30;

    const inFlight = engine.rig(makeMesh());
    engine.dispose();

    await expect(inFlight).rejects.toBeInstanceOf(RigCancelledError);
    expect((engine as any).pendingRequests.size).toBe(0);
  });
});
