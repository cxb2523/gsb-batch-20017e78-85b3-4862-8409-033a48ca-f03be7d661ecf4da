// ==============================================
// 上传链路集成验证：SplatGpuCache + GpuCacheUploadQueue 协同，
// 复刻 SetupSplatMesh 中 SplatUploadTextureGpuCache 的排队/销毁语义。
// 运行: node --experimental-transform-types --import ./tests/register-stubs.ts tests/run.ts
// ==============================================
import { test } from './harness';
import assert from 'node:assert/strict';
import { SplatGpuCache } from '../src/reall3d/meshs/splatmesh/SplatGpuCache';
import { GpuCacheUploadQueue } from '../src/reall3d/meshs/splatmesh/GpuCacheUploadQueue';
import { createFakeTexture, createEvents, createSplatFile, snapshotTextureBytes } from './test-helpers';
import type { FakeTexture } from './test-helpers';
import type { SplatFile } from '../src/reall3d/modeldata/SplatTiles';

const tick = (ms = 2) => new Promise(r => setTimeout(r, ms));

/**
 * 复刻 SetupSplatMesh 的 SplatUploadTextureGpuCache 处理器：
 * 销毁感知 + 队列串行 + 仅在真正就绪后刷新。
 */
function createUploadHandler(cache: SplatGpuCache, queue: GpuCacheUploadQueue, isDisposed: () => boolean) {
    const refreshCalls: number[] = [];
    const handler = async (splatFile: SplatFile) => {
        if (isDisposed() || cache.isDisposed || splatFile.textureReady) return;
        const handled = await queue.enqueue(splatFile, async (file: SplatFile) => {
            if (isDisposed() || cache.isDisposed) return;
            await cache.uploadSplatFile(file);
        });
        if (handled && !isDisposed() && splatFile.textureReady) refreshCalls.push(1);
    };
    return { handler, refreshCalls };
}

test('集成: 销毁后触发上传与排队请求，纹理零写入、无异常、无就绪标记', async () => {
    const texture: FakeTexture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, false);
    const queue = new GpuCacheUploadQueue();
    let disposed = false;
    const { handler } = createUploadHandler(cache, queue, () => disposed);

    // 第一个请求占住上传位（不 flush，保持在途）
    const first = createSplatFile('q-first', 4);
    first.targetLayer = 0;
    const p1 = handler(first);
    await tick();

    // 第二个请求进入排队
    const second = createSplatFile('q-second', 4);
    second.targetLayer = 1;
    const p2 = handler(second);
    await tick();
    assert.equal(queue.size, 1, '第二个请求应在排队等待');

    // 销毁网格：缓存与队列一并释放，纹理标记为已释放
    disposed = true;
    cache.dispose();
    queue.dispose();
    texture.disposed = true;

    const before = snapshotTextureBytes(texture);
    // 销毁后再来的新请求
    const third = createSplatFile('q-third', 4);
    third.targetLayer = 2;
    await assert.doesNotReject(() => handler(third));

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, undefined); // 处理器无返回值，关键是不抛异常
    assert.equal(r2, undefined);

    // 纹理在销毁后不得再被写入（disposed 的假纹理 addLayerUpdate 会抛错，未抛即未触碰）
    assert.deepEqual(snapshotTextureBytes(texture), before);
    assert.equal(first.textureReady, false, '在途请求销毁后不得标记就绪');
    assert.equal(second.textureReady, false, '排队请求销毁后不得标记就绪');
    assert.equal(third.textureReady, false, '销毁后新请求不得标记就绪');
    assert.equal(third.downloadData !== null, true, '销毁后不应产生任何文件状态变更');
});

test('集成: 正常上传一次后文件就绪，二次调用不重复写纹理', async () => {
    const texture: FakeTexture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, true);
    const queue = new GpuCacheUploadQueue();
    const { handler, refreshCalls } = createUploadHandler(cache, queue, () => false);

    const file = createSplatFile('once-integ', 4, 0x55);
    const p1 = handler(file);
    await tick();
    texture.flushUpdate();
    await p1;

    assert.equal(file.textureReady, true, '首次上传后应标记就绪');
    assert.equal(file.offset, 0);
    const bytesAfterFirst = snapshotTextureBytes(texture);
    const layerUpdatesAfterFirst = texture.layerUpdates.length;
    assert.equal(refreshCalls.length, 1, '就绪后应触发一次刷新');

    // 二次调用：处理器与缓存两层都会拦截，不重复写
    await handler(file);
    await tick();
    assert.equal(texture.layerUpdates.length, layerUpdatesAfterFirst, '二次调用不得再提交层更新');
    assert.deepEqual(snapshotTextureBytes(texture), bytesAfterFirst, '二次调用不得再写纹理');
    assert.equal(refreshCalls.length, 1, '二次调用不得重复刷新');
});
