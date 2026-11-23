// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================

/**
 * 回收缓存条目所需的最小文件结构（与 modeldata/SplatTiles 的 SplatFile 结构兼容）
 */
export interface RecycleSplatFileLike {
    fileKey: string;
    textureReady?: boolean;
    offset?: number;
    downloadCount?: number;
    downloadData?: Uint8Array;
    xyz?: Float32Array;
    targetLayer?: number;
    texWidth?: number;
    texHeight?: number;
    texDepth?: number;
    recycleLayer?: number;
}

/**
 * 回收缓存（recycleMap）恢复校验
 *
 * 回收数据必须与当前纹理尺寸、槽位及文件状态匹配；
 * 尺寸或槽位不匹配的旧数据应被丢弃，而不是写回纹理。
 *
 * @param recycled 回收缓存中的旧文件数据
 * @param target 当前待恢复的文件
 * @param texture 当前 DataArrayTexture（测试中可为假纹理）
 * @returns true 表示可恢复；false 表示应丢弃并重新下载
 */
export function isRecycleDataValid(recycled: RecycleSplatFileLike, target: RecycleSplatFileLike, texture: any): boolean {
    // 回收数据本身不完整
    if (!recycled || !recycled.downloadData || !recycled.downloadCount || !recycled.xyz) return false;
    // 数据字节长度与声明的点数不一致
    if (recycled.downloadData.byteLength !== recycled.downloadCount * 32) return false;
    // 当前纹理已释放，无法恢复
    if (!texture?.image?.data) return false;

    const image = texture.image;
    // 回收时与当前的纹理尺寸（宽/高/深）不一致，旧数据丢弃
    if (
        recycled.texWidth !== undefined &&
        (recycled.texWidth !== image.width || recycled.texHeight !== image.height || recycled.texDepth !== image.depth)
    ) {
        return false;
    }

    // 偏移区间必须落在当前纹理容量内
    const byteStart = (recycled.offset || 0) * 32;
    if (byteStart + recycled.downloadData.byteLength > image.data.byteLength) return false;

    // 槽位匹配：回收的层槽位仍在当前纹理深度内；文件已被重新分配到其它层时旧槽位失效
    if (recycled.recycleLayer !== undefined) {
        if (recycled.recycleLayer < 0 || recycled.recycleLayer >= image.depth) return false;
        if (target.targetLayer !== undefined && target.targetLayer >= 0 && target.targetLayer !== recycled.recycleLayer) return false;
    }
    return true;
}
