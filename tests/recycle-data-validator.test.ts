// ==============================================
// recycleMap 回收恢复校验本地验证
// 运行: node --experimental-transform-types --import ./tests/register-stubs.ts tests/run.ts
// ==============================================
import { test } from './harness';
import assert from 'node:assert/strict';
import { isRecycleDataValid, RecycleSplatFileLike } from '../src/reall3d/meshs/splatmesh/RecycleDataValidator';
import { createFakeTexture } from './test-helpers';
import type { FakeTexture } from './test-helpers';

const WIDTH = 16,
    HEIGHT = 4,
    DEPTH = 8;

function makeTexture(): FakeTexture {
    return createFakeTexture(WIDTH, HEIGHT, DEPTH);
}

function makeRecycled(overrides: Partial<RecycleSplatFileLike> = {}): RecycleSplatFileLike {
    const downloadCount = 4;
    return {
        fileKey: 'tile-1',
        offset: 0,
        downloadCount,
        downloadData: new Uint8Array(downloadCount * 32),
        xyz: new Float32Array(downloadCount * 3),
        texWidth: WIDTH,
        texHeight: HEIGHT,
        texDepth: DEPTH,
        recycleLayer: 2,
        ...overrides,
    };
}

test('尺寸与槽位均匹配时允许恢复', () => {
    const texture = makeTexture();
    const recycled = makeRecycled();
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), true);
});

test('目标文件尚未分配层(targetLayer=-9)时不阻断恢复', () => {
    const texture = makeTexture();
    const recycled = makeRecycled();
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: -9 };
    assert.equal(isRecycleDataValid(recycled, target, texture), true);
});

test('纹理宽度不匹配时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ texWidth: WIDTH * 2 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('纹理高度不匹配时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ texHeight: HEIGHT + 2 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('纹理深度(槽位总数)不匹配时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ texDepth: DEPTH + 4 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('文件被重新分配到其它层(槽位不匹配)时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ recycleLayer: 2 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 5 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('回收槽位超出当前纹理深度时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ recycleLayer: DEPTH + 1, texDepth: DEPTH + 2 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: DEPTH + 1 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('偏移区间超出纹理容量时丢弃旧数据', () => {
    const texture = makeTexture();
    const recycled = makeRecycled({ offset: 999999 });
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('纹理已释放(image.data 为空)时丢弃', () => {
    const texture = makeTexture();
    texture.image.data = null;
    const recycled = makeRecycled();
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };
    assert.equal(isRecycleDataValid(recycled, target, texture), false);
});

test('回收数据不完整(缺 downloadData/xyz/字节长度不符)时丢弃', () => {
    const texture = makeTexture();
    const target: RecycleSplatFileLike = { fileKey: 'tile-1', targetLayer: 2 };

    assert.equal(isRecycleDataValid(makeRecycled({ downloadData: null }), target, texture), false);
    assert.equal(isRecycleDataValid(makeRecycled({ xyz: null }), target, texture), false);
    assert.equal(isRecycleDataValid(makeRecycled({ downloadCount: 0 }), target, texture), false);

    const badLength = makeRecycled();
    badLength.downloadData = new Uint8Array(10); // 与 downloadCount*32 不符
    assert.equal(isRecycleDataValid(badLength, target, texture), false);
});

test('端到端: 模拟回收-换纹理-恢复，尺寸不匹配旧数据被丢弃并走重新下载', () => {
    // 复刻 SetupWorkerLod 的 recycleMap 存取流程
    const recycleMap = new Map<string, RecycleSplatFileLike>();

    // 1) 在旧纹理（16x4x8）上回收 tile-x，记录尺寸与槽位
    const oldTexture = createFakeTexture(16, 4, 8);
    const downloadCount = 4;
    const offset = 0;
    const downloadData = new Uint8Array(oldTexture.image.data.buffer).slice(offset * 32, (offset + downloadCount) * 32);
    // 写入可识别标记
    downloadData[0] = 0x77;
    recycleMap.set('tile-x', {
        fileKey: 'tile-x',
        offset,
        downloadCount,
        downloadData,
        xyz: new Float32Array(downloadCount * 3),
        texWidth: oldTexture.image.width,
        texHeight: oldTexture.image.height,
        texDepth: oldTexture.image.depth,
        recycleLayer: 2,
    });

    // 2) 模型切换后纹理尺寸改变（32x8x16）
    const newTexture = createFakeTexture(32, 8, 16);
    const target: RecycleSplatFileLike = { fileKey: 'tile-x', targetLayer: 2 };

    // 3) 恢复时校验：尺寸不匹配，必须丢弃
    const recycled = recycleMap.get('tile-x');
    assert.equal(isRecycleDataValid(recycled, target, newTexture), false, '纹理尺寸变化后旧回收数据必须丢弃');

    // 4) 丢弃后不得把旧字节写入新纹理
    const before = new Uint8Array(newTexture.image.data.buffer.slice(0));
    const wouldWrite = isRecycleDataValid(recycled, target, newTexture);
    if (wouldWrite) new Uint8Array(newTexture.image.data.buffer).set(recycled.downloadData, recycled.offset * 32);
    assert.deepEqual(new Uint8Array(newTexture.image.data.buffer), before, '被判定丢弃的数据不得写入新纹理');
});

test('端到端: 同尺寸同槽位回收数据可恢复并写回正确偏移', () => {
    const recycleMap = new Map<string, RecycleSplatFileLike>();
    const texture = createFakeTexture(16, 4, 8);
    const downloadCount = 4;
    const offset = 6; // 模拟非零偏移
    const downloadData = new Uint8Array(downloadCount * 32).fill(0x99);
    recycleMap.set('tile-y', {
        fileKey: 'tile-y',
        offset,
        downloadCount,
        downloadData,
        xyz: new Float32Array(downloadCount * 3),
        texWidth: texture.image.width,
        texHeight: texture.image.height,
        texDepth: texture.image.depth,
        recycleLayer: 3,
    });

    const target: RecycleSplatFileLike = { fileKey: 'tile-y', targetLayer: 3 };
    const recycled = recycleMap.get('tile-y');
    assert.equal(isRecycleDataValid(recycled, target, texture), true, '尺寸槽位匹配时应允许恢复');

    // 恢复写回
    const restored: RecycleSplatFileLike = { fileKey: 'tile-y' };
    restored.downloadData = recycled.downloadData;
    restored.offset = recycled.offset;
    new Uint8Array(texture.image.data.buffer).set(restored.downloadData, restored.offset * 32);

    const ui8 = new Uint8Array(texture.image.data.buffer);
    assert.equal(ui8[offset * 32], 0x99, '数据应写回到回收时记录的偏移');
    assert.equal(ui8[offset * 32 - 1], 0, '偏移之前的区域不应被污染');
});
