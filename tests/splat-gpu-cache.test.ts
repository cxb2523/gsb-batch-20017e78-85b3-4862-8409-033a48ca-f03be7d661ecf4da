// ==============================================
// SplatGpuCache 本地验证
// 运行: node --experimental-transform-types --import ./tests/register-stubs.ts tests/run.ts
// ==============================================
import { test } from './harness';
import assert from 'node:assert/strict';
import { SplatGpuCache } from '../src/reall3d/meshs/splatmesh/SplatGpuCache';
import { createFakeTexture, createEvents, createSplatFile, snapshotTextureBytes, countNonZero } from './test-helpers';

/** 等待一个微任务/宏任务回合，确保异步链路推进 */
const tick = (ms = 2) => new Promise(r => setTimeout(r, ms));

test('整块上传(fullCache): 销毁后触发上传不写纹理、不标记就绪、无异常', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    // dataCount 足够大，避免触发满缓存事件
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, true);
    const file = createSplatFile('full-dispose', 4);

    const before = snapshotTextureBytes(texture);
    cache.dispose();
    texture.disposed = true; // 模拟真实纹理对象一并释放

    let handled: boolean;
    await assert.doesNotReject(async () => {
        handled = await cache.uploadSplatFile(file);
    });
    await tick();

    assert.equal(handled, false);
    assert.equal(file.textureReady, false, '销毁后不得标记文件就绪');
    assert.equal(file.offset, undefined, '销毁后不得写入偏移');
    assert.equal(file.downloadData !== null, true, '销毁后不应清空下载数据（不产生任何状态变更）');
    assert.deepEqual(snapshotTextureBytes(texture), before, '销毁后纹理不得有任何写入');
    assert.equal(countNonZero(snapshotTextureBytes(texture)), 0);
});

test('按层上传(partCache): 销毁后触发上传不写纹理、不标记就绪、无异常', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, false);
    const file = createSplatFile('part-dispose', 4);
    file.targetLayer = 2;

    const before = snapshotTextureBytes(texture);
    cache.dispose();
    texture.disposed = true;

    const handled = await cache.uploadSplatFile(file);
    await tick();

    assert.equal(handled, false);
    assert.equal(file.textureReady, false);
    assert.equal(file.offset, undefined);
    assert.deepEqual(snapshotTextureBytes(texture), before);
    assert.equal(texture.layerUpdates.length, 0, '销毁后不得提交任何层更新');
});

test('上传途中销毁: GPU 回传后不触碰已释放纹理、不标记就绪', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, false);
    const file = createSplatFile('inflight', 4);
    file.targetLayer = 1;

    // 启动上传但不 flush，模拟上传在途
    const uploadPromise = cache.uploadSplatFile(file);
    await tick();
    assert.equal(texture.needsUpdate, true, '上传应已提交纹理更新');
    assert.equal(texture.layerUpdates.includes(1), true);

    // 上传途中销毁网格/纹理
    cache.dispose();
    texture.disposed = true;
    await tick(5); // dispose 会主动解套在途等待

    // 即使稍后 GPU 才回传 onUpdate，也不应产生异常或状态写入
    assert.doesNotThrow(() => texture.flushUpdate());
    const handled = await uploadPromise;

    assert.equal(handled, false);
    assert.equal(file.textureReady, false, '在途上传被销毁后不得标记就绪');
    assert.equal(file.offset, undefined, '在途上传被销毁后不得提交偏移');
    assert.equal(file.downloadData !== null, true);
});

test('正常整块上传: 一次完成后文件就绪，偏移/层级/就绪标记一致', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, true);
    const file = createSplatFile('full-ok', 4, 0x11);

    const p = cache.uploadSplatFile(file);
    await tick();
    texture.flushUpdate(); // 模拟 GPU 回传
    const handled = await p;

    assert.equal(handled, true);
    assert.equal(file.textureReady, true);
    assert.equal(file.offset, 0, '首块偏移应为 0');
    assert.equal(file.downloadData, null, '上传完成后下载数据应释放');
    assert.ok(file.xyz instanceof Float32Array && file.xyz.length === 4 * 3, 'xyz 应被提取');
    assert.ok(countNonZero(snapshotTextureBytes(texture)) > 0, '纹理应已写入数据');
});

test('正常按层上传: 偏移与目标层级保持一致', async () => {
    const width = 16,
        height = 4;
    const texture = createFakeTexture(width, height, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, width, height, 8, 1024, false);
    const file = createSplatFile('part-ok', 4, 0x22);
    file.targetLayer = 3;

    const p = cache.uploadSplatFile(file);
    await tick();
    texture.flushUpdate();
    const handled = await p;

    const expectedOffset = (width * height * file.targetLayer) / 2;
    assert.equal(handled, true);
    assert.equal(file.textureReady, true);
    assert.equal(file.offset, expectedOffset, '文件偏移必须与目标层级一致');
});

test('幂等: 正常上传一次后，二次调用不重复写纹理', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, true);
    const file = createSplatFile('once', 4, 0x33);

    const p1 = cache.uploadSplatFile(file);
    await tick();
    texture.flushUpdate();
    assert.equal(await p1, true);

    const layerUpdatesAfterFirst = texture.layerUpdates.length;
    const bytesAfterFirst = snapshotTextureBytes(texture);

    // 二次调用：已就绪，直接跳过
    const handled2 = await cache.uploadSplatFile(file);
    await tick();
    assert.equal(handled2, false, '已就绪文件不应再次上传');
    assert.equal(texture.layerUpdates.length, layerUpdatesAfterFirst, '二次调用不得再提交层更新');
    assert.deepEqual(snapshotTextureBytes(texture), bytesAfterFirst, '二次调用不得再写纹理');
});

test('并发去重: 同一文件并发调用只写一次', async () => {
    const texture = createFakeTexture(16, 4, 8);
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 16, 4, 8, 1024, true);
    const file = createSplatFile('dup', 4, 0x44);

    const p1 = cache.uploadSplatFile(file);
    // 第一次尚在途时再次调用同一文件
    const p2 = cache.uploadSplatFile(file);
    await tick();
    texture.flushUpdate();

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, true);
    assert.equal(r2, false, '并发重复调用应被跳过');
    assert.equal(file.textureReady, true);
});

test('越界保护: 数据超出纹理容量时放弃写入且不标记就绪', async () => {
    const texture = createFakeTexture(4, 1, 2); // 容量很小
    const events = createEvents(texture);
    const cache = new SplatGpuCache(events, 4, 1, 2, 1024, true);
    const file = createSplatFile('overflow', 32); // 32 个 splat 远超容量
    const before = snapshotTextureBytes(texture);

    const handled = await cache.uploadSplatFile(file);
    assert.equal(handled, false);
    assert.equal(file.textureReady, false);
    assert.deepEqual(snapshotTextureBytes(texture), before);
});
