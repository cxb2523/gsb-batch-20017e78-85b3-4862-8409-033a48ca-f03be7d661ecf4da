import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
    const resource = (descriptor: { size?: number | { width: number; height: number }; label?: string } = {}) => {
        const size = typeof descriptor.size === 'object' ? descriptor.size : undefined;
        return {
            label: descriptor.label,
            width: size?.width ?? 16,
            height: size?.height ?? 16,
            sampleCount: 1,
            format: 'rgba16float',
            getBindGroupLayout: () => ({}),
            createView: () => ({}),
            getMappedRange: () => new ArrayBuffer(typeof descriptor.size === 'number' ? descriptor.size : 4),
            unmap: () => {},
            destroy: vi.fn(),
        };
    };
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: resource,
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, encoder, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates the published set through the allocator and returns its handles', async () => {
        const { device } = mockDevice();
        const allocated: CoreTextureDescriptor[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            allocated.push(descriptor);
            return { gpu: device.createTexture() as unknown as GPUTexture, handle: { name: descriptor.label }, destroy: vi.fn() };
        };
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, allocateTexture });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        expect(core.output).toEqual({ name: 'upscale-output' });
        expect(core.guides.dilatedMotion).toEqual({ name: 'upscale-dilated-motion' });
        expect(core.guides.history).toEqual({ name: 'upscale-history-0' });
        const byLabel = new Map(allocated.map((d) => [d.label, d]));
        expect(byLabel.get('upscale-output')).toMatchObject({ width: 64, height: 32, format: 'rgba16float' });
        expect(byLabel.get('upscale-dilated-depth-0')).toMatchObject({ width: 32, height: 16, format: 'r32float' });
        expect(byLabel.get('upscale-masks')).toMatchObject({ format: 'rgba8unorm' });
    });

    it('defaults to raw GPUTexture handles', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.output).toMatchObject({ label: 'upscale-output' });
    });

    it('stages camera facts from plain frame data', async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET))
            .toBe(FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET);

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET)).toBe(0);
    });

    it("reads the projection type from a denoiser-style camera's matrix", async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        const perspective = new Float32Array(16);
        perspective[11] = -1; // w = −z
        const orthographic = new Float32Array(16);
        orthographic[15] = 1;

        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: perspective });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: orthographic });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(0);
        expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100 })).toThrow(/perspective/);
    });

    it('encodes into a host encoder without submitting', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
    });

    it('advances jitter only on the temporal path with jitter on', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        expect(core.beginFrame()).toBe(core.jitter);
        expect(core.jitterPhase).toBe(1);
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.beginFrame()).toBeNull();
    });

    //* Reconfigure while a split frame is in flight — the half-frame state
    //* must be finalized so the new configuration starts a clean frame and a
    //* stale dispatchUpscale() is rejected rather than written into it.
    it('terminates a split frame on configure so a new split frame can complete', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(
            encoder as unknown as GPUCommandEncoder,
            { depth: gpu('depth'), velocity: gpu('velocity') },
            camera,
        );
        expect(core.guidesPending).toBe(true);

        // Reconfigure mid-split (path change): the pending frame is dropped.
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.guidesPending).toBe(false);

        // A residual late dispatch against the abandoned frame is an error,
        // never a silent write into the spatial path's fresh textures.
        expect(() =>
            core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera),
        ).toThrow(/temporal path|dispatchGuides\(\) first/);
        expect(core.guidesPending).toBe(false);

        // Back on temporal: a fresh split frame starts and completes normally.
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        core.encodeGuides(
            encoder as unknown as GPUCommandEncoder,
            { depth: gpu('depth-2'), velocity: gpu('velocity-2') },
            camera,
        );
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color-2') }, camera);
        expect(core.guidesPending).toBe(false);
    });

    it('rejects a residual dispatchUpscale after a mid-split path switch with an explicit error', async () => {
        const { device, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        // Switch to the guides-only path while the temporal split is half open.
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'guides' });
        expect(core.guidesPending).toBe(false);

        // A residual late dispatch is rejected with an explicit error — on the
        // guides-only path the path guard names the mismatch; on a temporal
        // reconfigure the guidesPending guard would name the missing frame.
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera))
            .toThrow(/requires the temporal path|dispatchGuides\(\) first/);
        expect(device.queue.submit).toHaveBeenCalledTimes(1); // only the guides submit ran

        // The guides-only path itself starts clean frames after the switch.
        await core.prepare();
        core.dispatchGuides({ depth: gpu('depth-2'), velocity: gpu('velocity-2') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.queue.submit).toHaveBeenCalledTimes(2);
    });

    it('starts the shading-change block memory from an empty state after path and resolution changes', async () => {
        const { device, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        // Run a temporal frame so the block memory genuinely accumulates means.
        core.dispatch(inputs, camera);
        const oldMemory = device.createTexture.mock.calls
            .map(([descriptor]) => descriptor as { label?: string })
            .filter((descriptor) => descriptor.label === 'upscale-shading-memory-0');
        expect(oldMemory).toHaveLength(1);

        // Leave the temporal path entirely: the detector state is destroyed.
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.guidesPending).toBe(false);

        // Return at a different resolution: fresh, zero-sized block memory is
        // allocated for the new dimensions — nothing from the old path/size.
        core.configure({ displayWidth: 96, displayHeight: 48, customUpscaleRatio: 2 });
        await core.prepare();
        const newMemoryDescriptors = device.createTexture.mock.calls
            .map(([descriptor]) => descriptor as { label?: string; size?: { width: number; height: number } })
            .filter((descriptor) => descriptor.label === 'upscale-shading-memory-0');
        expect(newMemoryDescriptors).toHaveLength(2);
        // Render size is 48×24 at ratio 2 → memory covers 4×4 blocks plus 8×8 rows.
        expect(newMemoryDescriptors[1].size).toEqual({ width: 12, height: 9 });

        device.queue.writeTexture.mockClear();
        core.dispatch(
            { color: gpu('color-big'), depth: gpu('depth-big'), velocity: gpu('velocity-big') },
            camera,
        );
        // The first detector run on the new configuration explicitly zeroes the
        // block memory, so it restarts from empty instead of reusing old means.
        expect(device.queue.writeTexture).toHaveBeenCalledTimes(1);
        const zeroCall = device.queue.writeTexture.mock.calls[0];
        const zeroData = zeroCall[1] as Uint8Array;
        expect(zeroData.every((byte) => byte === 0)).toBe(true);
        const zeroLayout = zeroCall[2] as { bytesPerRow: number };
        const zeroExtent = zeroCall[3] as { width: number; height: number };
        expect(zeroLayout.bytesPerRow).toBe(12 * 16);
        expect(zeroExtent).toEqual({ width: 12, height: 9 });
        expect(zeroData.byteLength).toBe(12 * 9 * 16);
    });

    it('rejects every stateful call after dispose instead of reviving the instance', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        // Dispose with a split frame in flight: it is finalized too.
        core.encodeGuides(
            encoder as unknown as GPUCommandEncoder,
            { depth: gpu('depth'), velocity: gpu('velocity') },
            camera,
        );
        expect(core.guidesPending).toBe(true);
        core.dispose();
        expect(core.guidesPending).toBe(false);
        expect(core.isReady).toBe(false);

        const disposed = /disposed/;
        expect(() => core.configure({ displayWidth: 32, displayHeight: 16, customUpscaleRatio: 2 })).toThrow(disposed);
        expect(() => core.beginFrame()).toThrow(disposed);
        expect(() => core.resetHistory()).toThrow(disposed);
        expect(() => core.dispatch({ color: gpu('color'), depth: gpu('d'), velocity: gpu('v') }, camera)).toThrow(disposed);
        expect(() =>
            core.encode(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera),
        ).toThrow(disposed);
        expect(() => core.dispatchGuides({ depth: gpu('d'), velocity: gpu('v') }, camera)).toThrow(disposed);
        expect(() =>
            core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('d'), velocity: gpu('v') }, camera),
        ).toThrow(disposed);
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera)).toThrow(disposed);
        expect(() =>
            core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera),
        ).toThrow(disposed);
        expect(() => { core.gpuTiming = true; }).toThrow(disposed);
        await expect(core.prepare()).rejects.toThrow(disposed);

        // Nothing was encoded against the destroyed resources.
        expect(device.queue.submit).toHaveBeenCalledTimes(0);
        // Disposal is idempotent.
        expect(() => core.dispose()).not.toThrow();
    });
});
