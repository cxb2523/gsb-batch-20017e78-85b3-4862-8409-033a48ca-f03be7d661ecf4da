// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { Events } from '../../events/Events';
import { ModelStatus, SplatModel } from '../ModelData';
import {
    WorkerDispose,
    SplatDataFetcher,
    Information,
    NotifyWkA09SortPart,
    GetMeta,
    SplatUploadTextureGpuCache,
    GetOptions,
    GetSplatTiles,
    LodDownloadAddLodMeta,
    RunLoopByFrame,
    GetViewProjectionMatrix,
    GetCameraPosition,
    GetLodDataInfo,
    NotifyWkA01BackXyzIndex,
    NotifyWkA01BackXyz,
    OnFetchStart,
    OnFetchStop,
    NotifyWkA01SetTextureSize,
    NotifyWkA01CalcTargetLayer,
    Flying,
    MarkUpdateVisible,
    SplatUpdateDblTexture,
    NotifyWkA01BackSplatBuffer,
    OnUploadDblIndexDone,
    IsBigSceneMode,
    TriggerWkA01Refresh,
    SetTexdataChangeLastTime,
    GetMaxRenderCount,
    GetLodActiveXyz,
    SplatUpdateBoundBox,
    GetDataArrayTexture,
    OnStartLodShown,
    GetSortType,
    WorkerUpdateParams,
} from '../../events/EventConstants';
import {
    WkA10Information,
    WkA10SortPartXyz,
    WkA01FetchNG,
    WkA01FetchOkGpuCache,
    WkA10Download,
    WkDownloadCount,
    WkDownloadData,
    WkFileKey,
    WkA10SplatTilesReady,
    WkXyz,
    WkJson,
    WkXyzIndex,
    WkOffset,
    WkA01Init,
    WkA01Refresh,
    WkViewProjection,
    WkCameraPosition,
    WkA01BackXyz,
    WkA01BackXyzIndex,
    WkA01SetTextureSize,
    WkA10ReturnLayer,
    WkA01CalcTargetLayer,
    WkLayer,
    WkA01Dispose,
    WkA01FetchOkMemCache,
    WkA10UpdateDblTexture,
    WkTexData,
    WkA01BackSplatBuffer,
    WkIndex,
    WkA01DblActive,
    WkA10BoundBox,
    WkBox,
    WkA10Recycle,
    WkA01UpdateParams,
    WkSortType,
} from './WkConstants';
import { MetaData } from '../MetaData';
import { DataStatus, SplatFile, SplatTiles } from '../SplatTiles';
import { SplatMeshOptions } from '../../meshs/splatmesh/SplatMeshOptions';
import { sleep } from '../../utils/CommonUtils';
import { ModelOptions } from '../ModelOptions';
import { DataArrayTexture, Matrix4, Vector3 } from 'three';
import { isRecycleDataValid } from '../../meshs/splatmesh/RecycleDataValidator';

export function setupWorkerLod(events: Events) {
    let disposed = false;
    const on = (key: number, fn?: Function, multiFn?: boolean): Function | Function[] => events.on(key, fn, multiFn);
    const fire = (key: number, ...args: any): any => events.fire(key, ...args);

    const worker = new Worker(new URL('./WorkerLod.ts', import.meta.url), { type: 'module' });
    let splatTiles: SplatTiles = null;
    let isFullCache = false;
    let flyOnceDone = false;

    const oSetFileKey = new Set<string>();
    const mapCalcLayer = new Map<string, Function>();
    const recycleMap = new Map<string, SplatFile>();

    let fnResolveSplatTiles: Function;
    const primoseSplatTiles = new Promise(res => (fnResolveSplatTiles = res));

    let fnResolveTextureSize: Function;
    const texSizeReady = new Promise(res => (fnResolveTextureSize = res));

    let lodActiveXyzBuffer: Float32Array = null;
    let lodActiveXyz: Float32Array = null;

    on(LodDownloadAddLodMeta, async (opts: ModelOptions, sceneMeta: MetaData) => postWkA01Init(opts, sceneMeta));
    on(NotifyWkA01SetTextureSize, (oSize: any) => postWkA01SetTextureSize(oSize));
    on(NotifyWkA01BackXyz, (xyz: Float32Array) => postWkA01BackXyz(xyz));
    on(NotifyWkA01BackXyzIndex, (xyzIndex: Uint32Array) => postWkA01BackXyzIndex(xyzIndex));
    on(NotifyWkA01BackSplatBuffer, (dataArray: Uint32Array) => postWkA01BackSplatBuffer(dataArray));
    on(NotifyWkA01CalcTargetLayer, (fileKey: string): Promise<number> => {
        const p = new Promise<number>(resolve => mapCalcLayer.set(fileKey, resolve));
        postWkA01CalcTargetLayer(fileKey);
        return p;
    });

    on(GetSplatTiles, async () => {
        await primoseSplatTiles;
        return splatTiles;
    });

    on(GetLodActiveXyz, () => lodActiveXyz);

    on(GetLodDataInfo, async (): Promise<any> => {
        await fire(GetSplatTiles);
        const lodTargetsTotalCount = splatTiles.lodTargetsTotalCount;
        const lodTargetsFileCount = splatTiles.lodTargetsFileCount;
        const maxFileSplatCount = splatTiles.maxFileSplatCount;
        const totalCount = splatTiles.totalCount;
        return { totalCount, lodTargetsTotalCount, lodTargetsFileCount, maxFileSplatCount };
    });

    on(WorkerUpdateParams, async () => worker.postMessage({ [WkA01UpdateParams]: true, [WkSortType]: fire(GetSortType) }), true);

    let lastIndex = -1;
    on(OnUploadDblIndexDone, (index: number) => {
        if (lastIndex === index) return;
        lastIndex = index;

        if (fire(IsBigSceneMode) && !(fire(GetMeta) as MetaData).useGpuCache) {
            worker.postMessage({ [WkA01DblActive]: true, [WkIndex]: index });
        }
    });

    let triggerDone = false;
    on(TriggerWkA01Refresh, () => {
        !triggerDone &&
            fire(
                RunLoopByFrame,
                () => postWkA01Refresh(),
                () => !disposed,
                20,
            );
        triggerDone = true;
    });

    function onWkA10SplatTilesReady(wkJson: string) {
        splatTiles = JSON.parse(wkJson);
        fnResolveSplatTiles();
        (async () => !lodActiveXyzBuffer && (lodActiveXyzBuffer = new Float32Array((await fire(GetMaxRenderCount)) * 3)))();
    }

    function onWkA10Download(fileKey: string) {
        if (oSetFileKey.has(fileKey)) return;

        const splatFile = splatTiles.files[fileKey];
        splatFile.textureReady = false;
        splatFile.downloadCount = 0;
        splatFile.status = DataStatus.WaitFetch;
        splatFile.downloadData = null;
        splatFile.xyz = null;
        splatFile.targetLayer = -9;

        oSetFileKey.add(fileKey);
        fire(OnFetchStart);
    }

    function onWkA10SortPartXyz(wkJson: string, wkXyz: Float32Array, xyzIndex: Uint32Array) {
        fire(SetTexdataChangeLastTime, Date.now());
        const texture = JSON.parse(wkJson) as SplatTexdata;
        lodActiveXyzBuffer.set(wkXyz.subarray(0, texture.renderSplatCount * 3));
        lodActiveXyz = lodActiveXyzBuffer.subarray(0, texture.renderSplatCount * 3); // TODO 应不含环境水印
        texture.xyz = wkXyz;
        texture.xyzIndex = xyzIndex;
        fire(NotifyWkA09SortPart, texture);

        if (!flyOnceDone && texture.renderSplatCount > 0) {
            flyOnceDone = true;
            setTimeout(() => {
                if (disposed) return;
                const opts: SplatMeshOptions = fire(GetOptions);
                opts?.viewerEvents?.fire(Flying, true);
                (fire(GetMeta) as MetaData).showMark !== false && opts.viewerEvents?.fire(MarkUpdateVisible);
                fire(OnStartLodShown);
            }, 2000);
        }
    }

    function onWkA10UpdateDblTexture(wkJson: string, wkSplatBuffer: Uint32Array, wkXyz: Float32Array) {
        const texture: SplatTexdata = JSON.parse(wkJson);
        lodActiveXyzBuffer.set(wkXyz.subarray(0, texture.renderSplatCount * 3));
        lodActiveXyz = lodActiveXyzBuffer.subarray(0, texture.renderSplatCount * 3);
        texture.texdata = wkSplatBuffer;
        texture.xyz = wkXyz;
        fire(SplatUpdateDblTexture, texture);

        if (!flyOnceDone && texture.renderSplatCount > 0) {
            flyOnceDone = true;
            setTimeout(() => {
                if (disposed) return;
                const opts: SplatMeshOptions = fire(GetOptions);
                opts.viewerEvents?.fire(Flying, true);
                (fire(GetMeta) as MetaData).showMark !== false && opts.viewerEvents?.fire(MarkUpdateVisible);
                fire(OnStartLodShown);
            }, 1000);
        }
    }

    function onWkA10ReturnLayer(fileKey: string, targetLayer: number) {
        const splatFile = splatTiles.files[fileKey];
        splatFile.targetLayer = targetLayer;
    }

    function onWkA10BoundBox(wkBox: number[]) {
        fire(SplatUpdateBoundBox, ...wkBox);
    }

    function onWkA10Recycle(fileKey: string, offset: number, downloadCount: number, xyz: Float32Array, targetLayer?: number) {
        if (disposed) return;
        const dataTexture: DataArrayTexture = fire(GetDataArrayTexture);
        // 纹理不存在或已释放时无法回收，直接丢弃
        if (!dataTexture?.image?.data) return;

        const byteStart = offset * 32;
        const byteEnd = (offset + downloadCount) * 32;
        // 偏移区间与当前纹理容量不匹配的旧数据直接丢弃，禁止越界读取
        if (offset < 0 || !downloadCount || byteStart < 0 || byteEnd > dataTexture.image.data.byteLength) return;

        const downloadData = new Uint8Array(dataTexture.image.data.buffer).slice(byteStart, byteEnd);
        // 记录回收时的纹理尺寸与槽位，恢复时据此校验，尺寸或槽位不匹配则丢弃
        recycleMap.set(fileKey, {
            fileKey,
            offset,
            targetLayer,
            downloadCount,
            xyz,
            downloadData,
            texWidth: dataTexture.image.width,
            texHeight: dataTexture.image.height,
            texDepth: dataTexture.image.depth,
            recycleLayer: targetLayer,
            lastTime: Date.now(),
        });
    }

    /** 正常网络下载流程（回收恢复失败或无缓存时使用） */
    async function downloadSplatFile(splatFile: SplatFile) {
        splatFile.status = DataStatus.WaitFetch | DataStatus.Fetching;

        const warpModel = new SplatModel({ url: splatFile.url });
        warpModel.abortController = new AbortController();
        await fire(SplatDataFetcher, warpModel);

        if (warpModel.status === ModelStatus.FetchDone) {
            // 下载成功，设定数据
            splatFile.downloadData = warpModel.splatData;
            splatFile.xyz = warpModel.xyz;
            splatFile.downloadCount = warpModel.downloadSplatCount;
            splatFile.status |= DataStatus.FetchDone;
        } else {
            // 下载失败
            splatFile.status |= DataStatus.FetchFailed;
        }
    }

    async function processDownload() {
        const dataTexture: DataArrayTexture = fire(GetDataArrayTexture);
        oSetFileKey.forEach(async fileKey => {
            const splatFile = splatTiles.files[fileKey];
            if (splatFile.status === DataStatus.WaitFetch) {
                if (recycleMap.has(fileKey)) {
                    // 尝试从缓存恢复取数据，先校验尺寸与槽位是否仍匹配
                    const tmpFile = recycleMap.get(fileKey);
                    recycleMap.delete(fileKey);

                    if (isRecycleDataValid(tmpFile, splatFile, dataTexture)) {
                        splatFile.downloadData = tmpFile.downloadData;
                        splatFile.xyz = tmpFile.xyz;
                        splatFile.downloadCount = tmpFile.downloadCount;
                        splatFile.offset = tmpFile.offset;
                        splatFile.status = DataStatus.WaitFetch | DataStatus.Fetching | DataStatus.FetchDone;
                    } else {
                        // 尺寸或槽位不匹配的旧数据直接丢弃，按正常下载流程重新获取
                        tmpFile.downloadData = null;
                        tmpFile.xyz = null;
                        await downloadSplatFile(splatFile);
                    }
                } else {
                    // 下载
                    await downloadSplatFile(splatFile);
                }
            }
        });

        // 缓存检查清理
        while (recycleMap.size > 30) {
            let file: SplatFile;
            for (let item of recycleMap.values()) {
                if (!file || item.lastTime < file.lastTime) file = item;
            }
            recycleMap.delete(file.fileKey);
        }
    }

    async function processCalcTargetLayerGpuCache() {
        if (isFullCache) return;
        oSetFileKey.forEach(fileKey => {
            const splatFile = splatTiles.files[fileKey];
            if ((splatFile.status & DataStatus.FetchDone) > 0 && splatFile.targetLayer < -1) {
                splatFile.targetLayer = -1;
                postWkA01CalcTargetLayer(splatFile.fileKey);
            }
        });
    }

    async function processUploadTextureGpuCache() {
        if (disposed || !(fire(GetMeta) as MetaData).useGpuCache) return;
        const fileKeys = [...oSetFileKey];
        for (let i = 0; i < fileKeys.length; i++) {
            if (disposed) return; // 销毁后立即停止，不再排队新的纹理上传
            const fileKey = fileKeys[i];
            const splatFile = splatTiles.files[fileKey];
            if (splatFile.downloadCount && (isFullCache || splatFile.targetLayer >= 0)) {
                await fire(SplatUploadTextureGpuCache, splatFile); // 会更新splatFile状态
                await sleep(20);
            }
        }
    }
    async function processWkA01FetchDone() {
        (fire(GetMeta) as MetaData).useGpuCache ? await processWkA01FetchDoneGpuCache() : await processWkA01FetchDoneMemCache();
    }

    async function processWkA01FetchDoneGpuCache() {
        const dones: string[] = [];
        oSetFileKey.forEach(fileKey => {
            const splatFile = splatTiles.files[fileKey];
            if (splatFile.textureReady) {
                postWkA01FetchOkGpuCache(splatFile); // 转发
                dones.push(fileKey);
            } else if ((splatFile.status & DataStatus.FetchFailed) > 0) {
                postWkA01FetchNg(fileKey);
                dones.push(fileKey);
            }
        });
        dones.forEach(fileKey => oSetFileKey.delete(fileKey));
        !oSetFileKey.size && fire(OnFetchStop, 100);
    }

    async function processWkA01FetchDoneMemCache() {
        const dones: string[] = [];
        oSetFileKey.forEach(fileKey => {
            const splatFile = splatTiles.files[fileKey];
            if (splatFile.downloadCount) {
                postWkA01FetchOkMemCache(splatFile); // 转发
                dones.push(fileKey);
            } else if ((splatFile.status & DataStatus.FetchFailed) > 0) {
                postWkA01FetchNg(fileKey);
                dones.push(fileKey);
            }
        });
        dones.forEach(fileKey => oSetFileKey.delete(fileKey));
        !oSetFileKey.size && fire(OnFetchStop, 100);
    }

    function postWkA01Init(opts: ModelOptions, sceneMeta: MetaData) {
        worker.postMessage({ [WkA01Init]: true, [WkJson]: JSON.stringify(sceneMeta), [WkSortType]: fire(GetSortType) });
        fire(TriggerWkA01Refresh);
    }

    function postWkA01SetTextureSize(oTexSize: any) {
        isFullCache = !!oTexSize.fullCache;
        worker.postMessage({ [WkA01SetTextureSize]: true, [WkJson]: JSON.stringify(oTexSize) });
        fnResolveTextureSize();
    }

    let doingRefresh = false;
    async function postWkA01Refresh() {
        if (doingRefresh || disposed) return;
        doingRefresh = true;
        await texSizeReady;

        await processWkA01FetchDone();
        await processUploadTextureGpuCache();
        await processCalcTargetLayerGpuCache();
        await processDownload();

        const viewProjMatrix: number[] = (fire(GetViewProjectionMatrix) as Matrix4)?.toArray();
        const cameraPosition: number[] = (fire(GetCameraPosition) as Vector3)?.toArray();
        worker.postMessage({ [WkA01Refresh]: true, [WkViewProjection]: viewProjMatrix, [WkCameraPosition]: cameraPosition });
        doingRefresh = false;
    }

    function postWkA01FetchOkGpuCache(splatFile: SplatFile) {
        const { fileKey, offset, xyz, downloadCount, targetLayer } = splatFile;
        splatFile.downloadData = null;
        splatFile.xyz = null;
        splatFile.abortController = null;
        worker.postMessage(
            { [WkA01FetchOkGpuCache]: true, [WkFileKey]: fileKey, [WkOffset]: offset, [WkLayer]: targetLayer, [WkDownloadCount]: downloadCount, [WkXyz]: xyz },
            [xyz.buffer],
        );
    }

    function postWkA01FetchOkMemCache(splatFile: SplatFile) {
        const { fileKey, xyz, downloadCount, downloadData } = splatFile;
        splatFile.downloadData = null;
        splatFile.xyz = null;
        splatFile.abortController = null;
        worker.postMessage(
            { [WkA01FetchOkMemCache]: true, [WkFileKey]: fileKey, [WkDownloadCount]: downloadCount, [WkDownloadData]: downloadData, [WkXyz]: xyz },
            [downloadData.buffer, xyz.buffer],
        );
    }

    function postWkA01FetchNg(fileKey: string) {
        worker.postMessage({ [WkA01FetchNG]: true, [WkFileKey]: fileKey });
    }

    function postWkA01BackXyz(xyz: Float32Array) {
        worker.postMessage({ [WkA01BackXyz]: true, [WkXyz]: xyz }, [xyz.buffer]);
    }

    function postWkA01BackXyzIndex(xyzIndex: Uint32Array) {
        worker.postMessage({ [WkA01BackXyzIndex]: true, [WkXyzIndex]: xyzIndex }, [xyzIndex.buffer]);
    }

    function postWkA01CalcTargetLayer(fileKey: string) {
        worker.postMessage({ [WkA01CalcTargetLayer]: true, [WkFileKey]: fileKey });
    }

    function postWkA01BackSplatBuffer(dataArray: Uint32Array) {
        worker.postMessage({ [WkA01BackSplatBuffer]: true, [WkTexData]: dataArray }, [dataArray.buffer]);
    }

    on(
        WorkerDispose,
        () => {
            disposed = true;
            // 销毁后丢弃全部回收缓存，避免旧数据被塞回新的纹理槽位
            recycleMap.clear();
            worker.postMessage({ [WkA01Dispose]: true });
            worker.terminate();
        },
        true,
    );

    worker.onmessage = (e: any) => {
        if (disposed) return;
        const data: any = e.data;
        if (data[WkA10SplatTilesReady]) {
            // 就绪
            onWkA10SplatTilesReady(data[WkJson]);
        } else if (data[WkA10Download]) {
            // 安排下载
            onWkA10Download(data[WkFileKey]);
        } else if (data[WkA10ReturnLayer]) {
            // 目标层级
            onWkA10ReturnLayer(data[WkFileKey], data[WkLayer]);
        } else if (data[WkA10SortPartXyz]) {
            // 转发排序
            onWkA10SortPartXyz(data[WkJson], data[WkXyz], data[WkXyzIndex]);
        } else if (data[WkA10UpdateDblTexture]) {
            // 更新双缓冲纹理
            onWkA10UpdateDblTexture(data[WkJson], data[WkTexData], data[WkXyz]);
        } else if (data[WkA10Recycle]) {
            // 回收数据
            onWkA10Recycle(data[WkFileKey], data[WkOffset], data[WkDownloadCount], data[WkXyz], data[WkLayer]);
        } else if (data[WkA10BoundBox]) {
            // 更新包围盒
            onWkA10BoundBox(data[WkBox]);
        } else if (data[WkA10Information]) {
            // 信息
            fire(Information, JSON.parse(data[WkJson]));
        }
    };
}
