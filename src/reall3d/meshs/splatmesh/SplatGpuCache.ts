// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { DataArrayTexture } from 'three';
import { GetDataArrayTexture, OnSplatLodFullUploaded } from '../../events/EventConstants';
import { Events } from '../../events/Events';
import { SplatFile } from '../../modeldata/SplatTiles';
import { calcPartDepthRange, extractSplatXYZ } from '../../utils/CommonUtils';

export class SplatGpuCache {
    protected disposed = false;
    protected events: Events;
    private layerWidth: number;
    private layerHeight: number;
    private fullCache: boolean;
    private texture: DataArrayTexture;
    private offset: number = 0;
    private dataCount: number = 0;
    // 正在上传中的文件 key，避免同一文件被并发重复上传、重复写纹理
    private readonly uploadingKeys = new Set<string>();
    // 正在等待 GPU 回传 onUpdate 的回调，dispose 时主动解套，避免悬挂
    private readonly pendingResolvers: Array<() => void> = [];

    constructor(events: Events, width: number, height: number, depth: number, dataCount: number, fullCache: boolean) {
        const that = this;
        that.events = events;
        that.layerWidth = width;
        that.layerHeight = height;
        that.dataCount = dataCount;
        that.fullCache = fullCache;
        that.texture = events.fire(GetDataArrayTexture);
        events.on(OnSplatLodFullUploaded, () => {
            // 销毁后纹理已释放，不再触碰
            if (that.disposed || !that.texture?.image) return;
            that.texture.image.data = null;
        });
    }

    public get isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * 上传单个分块文件到 GPU 纹理缓存
     * @returns true 表示本次确实完成上传并标记就绪；false 表示被跳过（销毁/已就绪/重复/异常）
     */
    public async uploadSplatFile(file: SplatFile): Promise<boolean> {
        const that = this;
        // 销毁后直接放弃，不触碰纹理、不标记文件就绪
        if (that.disposed || !file || file.textureReady) return false;

        // 同一文件已在上传途中时直接跳过，保证正常路径下同一文件不会被重复写入
        const key = file.fileKey;
        if (that.uploadingKeys.has(key)) return false;
        that.uploadingKeys.add(key);
        try {
            if (that.disposed) return false;
            if (that.fullCache) {
                await that.uploadSplatFileFull(file);
            } else {
                await that.uploadSplatFilePart(file);
            }
            return !that.disposed && !!file.textureReady;
        } finally {
            that.uploadingKeys.delete(key);
        }
    }

    protected async uploadSplatFileFull(file: SplatFile) {
        const that = this;
        if (that.disposed || file.textureReady) return; // 需要检查避免已就绪又重新上传
        if (!file.downloadData || !file.downloadCount) return; // 无有效数据不上传

        const dataArrayTexture = that.texture;
        if (!dataArrayTexture?.image?.data) return; // 纹理已释放

        const uploadOffset = that.offset;
        const downloadData = file.downloadData.subarray(0, file.downloadCount * 32);
        const byteOffset = uploadOffset * 32;

        // 边界校验：目标区间不得超出当前纹理容量，防止越界写入
        const texBytes = dataArrayTexture.image.data.byteLength;
        if (byteOffset + downloadData.byteLength > texBytes) return;

        const { startDepth, endDepth } = calcPartDepthRange(that.layerWidth, that.layerHeight, uploadOffset, file.downloadCount);
        const ui8sTex = new Uint8Array(dataArrayTexture.image.data.buffer);
        ui8sTex.set(downloadData, byteOffset);

        await that.waitTextureUpdate(dataArrayTexture, rangeLayers(startDepth, endDepth));

        // GPU 回传后可能已销毁：销毁后不再触碰纹理、不改变文件状态、不推进偏移
        if (that.disposed || !that.texture) return;

        file.xyz = extractSplatXYZ(downloadData);
        file.downloadData = null;

        file.lastTime = Math.max(Date.now(), file.lastTime || 0);
        file.offset = uploadOffset;
        file.textureReady = true;
        that.offset += file.downloadCount;
        that.offset >= that.dataCount && that.events.tryFire(OnSplatLodFullUploaded);
    }

    protected async uploadSplatFilePart(file: SplatFile) {
        const that = this;
        if (that.disposed || file.textureReady) return; // 避免就绪重新上传
        if (!file.downloadData || !file.downloadCount) return;
        if (file.targetLayer < 0) return; // 尚未分配纹理层槽位

        const dataArrayTexture = that.texture;
        if (!dataArrayTexture?.image?.data) return; // 纹理已释放

        const layerOffset = (that.layerWidth * that.layerHeight * file.targetLayer) / 2;
        const downloadData = file.downloadData.subarray(0, file.downloadCount * 32);
        const byteOffset = layerOffset * 32;

        // 槽位与边界校验：层级必须在当前纹理深度内，且数据区间不得越界
        if (file.targetLayer >= dataArrayTexture.image.depth) return;
        if (byteOffset + downloadData.byteLength > dataArrayTexture.image.data.byteLength) return;

        const ui8sTex = new Uint8Array(dataArrayTexture.image.data.buffer);
        ui8sTex.set(downloadData, byteOffset);

        await that.waitTextureUpdate(dataArrayTexture, [file.targetLayer]);

        // 销毁后不触碰纹理、不标记就绪，偏移与层级维持原值
        if (that.disposed || !that.texture) return;

        file.downloadData = null;
        file.lastTime = Math.max(Date.now(), file.lastTime || 0);
        file.offset = layerOffset; // 偏移与层级保持一致
        file.textureReady = true;
    }

    /**
     * 提交纹理层更新并等待 GPU 回传；dispose 时主动结束等待，避免销毁后悬挂
     */
    private waitTextureUpdate(dataArrayTexture: DataArrayTexture, layers: number[]): Promise<void> {
        const that = this;
        return new Promise<void>(resolve => {
            const done = () => {
                const idx = that.pendingResolvers.indexOf(done);
                idx >= 0 && that.pendingResolvers.splice(idx, 1);
                resolve();
            };
            that.pendingResolvers.push(done);
            for (let i = 0; i < layers.length; i++) dataArrayTexture.addLayerUpdate(layers[i]);
            dataArrayTexture.onUpdate = done;
            dataArrayTexture.needsUpdate = true;
        });
    }

    public dispose() {
        const that = this;
        if (that.disposed) return;
        that.disposed = true;
        // 解套所有在途等待，await 恢复后会因 disposed 直接返回，不再触碰纹理与文件状态
        that.pendingResolvers.splice(0).forEach(fn => {
            try {
                fn();
            } catch {
                /* 忽略等待回调异常 */
            }
        });
        that.uploadingKeys.clear();
        that.texture = null;
    }
}

function rangeLayers(startDepth: number, endDepth: number): number[] {
    const layers: number[] = [];
    for (let i = startDepth; i <= endDepth; i++) layers.push(i);
    return layers;
}
