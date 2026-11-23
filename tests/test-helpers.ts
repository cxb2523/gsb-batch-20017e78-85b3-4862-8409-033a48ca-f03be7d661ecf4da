// ==============================================
// 测试公共辅助：可控假纹理、Events 装配、SplatFile 工厂
// ==============================================
import { DataArrayTexture } from 'three';
import { Events } from '../src/reall3d/events/Events';
import { GetDataArrayTexture } from '../src/reall3d/events/EventConstants';
import type { SplatFile } from '../src/reall3d/modeldata/SplatTiles';

export interface FakeTexture extends DataArrayTexture {
    layerUpdates: number[];
    flushUpdate(): void;
    disposed: boolean;
}

/**
 * 创建可控假纹理：
 * - 底层数据为独立 Uint32Array，写入前后可快照对比
 * - needsUpdate/onUpdate 行为模拟 three，GPU 回传需手动 flushUpdate() 触发
 * - dispose 后任何层更新都会抛错（模拟已释放纹理被触碰）
 */
export function createFakeTexture(width = 16, height = 4, depth = 8): FakeTexture {
    const data = new Uint32Array(width * height * depth * 4);
    const tex: any = new DataArrayTexture(data, width, height, depth);
    const originalAddLayerUpdate = tex.addLayerUpdate.bind(tex);
    tex.addLayerUpdate = (layer: number) => {
        if (tex.disposed) throw new Error('write into disposed texture');
        originalAddLayerUpdate(layer);
    };
    return tex as FakeTexture;
}

export function createEvents(texture: FakeTexture): Events {
    const events = new Events();
    // OnSplatLodFullUploaded 由 SplatGpuCache 构造函数自行注册，这里只提供纹理
    events.on(GetDataArrayTexture, () => texture);
    return events;
}

/** 构造含 downloadCount 个 splat（每个 32 字节）的文件，首字节写入可识别标记 */
export function createSplatFile(fileKey: string, downloadCount = 4, marker = 0xab): SplatFile {
    const downloadData = new Uint8Array(downloadCount * 32);
    for (let i = 0; i < downloadCount; i++) downloadData[i * 32] = marker;
    return {
        fileKey,
        downloadCount,
        downloadData,
        textureReady: false,
        targetLayer: 0,
        lastTime: 0,
    };
}

/** 快照纹理底层字节，用于对比是否发生写入 */
export function snapshotTextureBytes(texture: FakeTexture): Uint8Array {
    if (!texture?.image?.data) return null;
    return new Uint8Array(texture.image.data.buffer.slice(0));
}

export function countNonZero(bytes: Uint8Array): number {
    if (!bytes) return 0;
    let n = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) n++;
    return n;
}
