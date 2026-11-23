// ==============================================
// GpuCacheUploadQueue 本地验证
// 对应 SetupSplatMesh 中排队等待缓存上传的请求在销毁后应直接丢弃，而不是继续重试。
// 运行: node --experimental-transform-types --import ./tests/register-stubs.ts tests/run.ts
// ==============================================
import { test } from './harness';
import assert from 'node:assert/strict';
import { GpuCacheUploadQueue, UploadSplatFileLike } from '../src/reall3d/meshs/splatmesh/GpuCacheUploadQueue';

const tick = (ms = 2) => new Promise(r => setTimeout(r, ms));

function file(key: string): UploadSplatFileLike {
    return { fileKey: key, textureReady: false };
}

test('销毁后新请求直接丢弃，upload 不会被调用、无异常', async () => {
    const queue = new GpuCacheUploadQueue();
    let uploadCalls = 0;
    queue.dispose();

    const handled = await queue.enqueue(file('a'), async () => {
        uploadCalls++;
    });

    assert.equal(handled, false);
    assert.equal(uploadCalls, 0, '销毁后不得触发上传');
});

test('排队中的请求在销毁后全部丢弃，不重试、不调用 upload', async () => {
    const queue = new GpuCacheUploadQueue();
    const uploadCalls: string[] = [];

    // 第一个请求占据上传位，手动控制其完成时机
    let releaseFirst: () => void;
    const firstBlocked = new Promise<void>(r => (releaseFirst = r));
    const p1 = queue.enqueue(file('first'), async f => {
        uploadCalls.push(f.fileKey);
        await firstBlocked;
    });

    // 后续两个请求进入排队
    const p2 = queue.enqueue(file('second'), async f => {
        uploadCalls.push(f.fileKey);
    });
    const p3 = queue.enqueue(file('third'), async f => {
        uploadCalls.push(f.fileKey);
    });
    await tick();
    assert.equal(queue.size, 2, '应有两个请求排队等待');

    // 上传途中销毁网格
    queue.dispose();
    releaseFirst!();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1, false, '销毁时在途请求也视为丢弃');
    assert.equal(r2, false);
    assert.equal(r3, false);
    assert.deepEqual(uploadCalls, ['first'], '排队请求不得被执行，更不会重试');
});

test('正常路径: FIFO 串行执行，每个文件只上传一次', async () => {
    const queue = new GpuCacheUploadQueue();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const upload = (f: UploadSplatFileLike) =>
        new Promise<void>(resolve => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            order.push(f.fileKey);
            setTimeout(() => {
                concurrent--;
                resolve();
            }, 5);
        });

    const results = await Promise.all([queue.enqueue(file('f1'), upload), queue.enqueue(file('f2'), upload), queue.enqueue(file('f3'), upload)]);

    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(order, ['f1', 'f2', 'f3'], '必须按 FIFO 顺序串行上传');
    assert.equal(maxConcurrent, 1, '同一时刻只允许一个上传');
});

test('销毁后队列不再接收新请求（销毁幂等）', async () => {
    const queue = new GpuCacheUploadQueue();
    queue.dispose();
    queue.dispose(); // 重复销毁无异常
    let called = 0;
    const r = await queue.enqueue(file('x'), async () => called++);
    assert.equal(r, false);
    assert.equal(called, 0);
    assert.equal(queue.isDisposed, true);
});
