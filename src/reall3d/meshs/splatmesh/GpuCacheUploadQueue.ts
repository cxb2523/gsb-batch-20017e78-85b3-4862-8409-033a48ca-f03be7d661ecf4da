// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================

/**
 * 上传队列所需的最小文件结构（与 modeldata/SplatTiles 的 SplatFile 结构兼容）
 */
export interface UploadSplatFileLike {
    fileKey: string;
    textureReady?: boolean;
}

interface QueueWaiter {
    file: UploadSplatFileLike;
    resolve: (handled: boolean) => void;
}

/**
 * GPU 纹理缓存上传队列
 *
 * 串行化同一时刻只允许一个文件上传；排队中的请求在队列或所属网格销毁后直接丢弃，
 * 不再重试，也不会触碰已释放的纹理。
 */
export class GpuCacheUploadQueue {
    private doing = false;
    private disposed = false;
    private readonly waiters: QueueWaiter[] = [];

    /** 标记队列销毁，排队中以及后续的请求全部丢弃并立即返回 */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const pending = this.waiters.splice(0);
        pending.forEach(w => w.resolve(false));
    }

    public get isDisposed(): boolean {
        return this.disposed;
    }

    public get isDoing(): boolean {
        return this.doing;
    }

    /** 排队中（不含正在上传）的请求数量 */
    public get size(): number {
        return this.waiters.length;
    }

    /**
     * 加入上传队列并等待调度
     * @param file 待上传文件
     * @param upload 实际上传处理（由 SplatGpuCache 提供，内部自行保证幂等与销毁感知）
     * @returns true 表示已执行上传；false 表示销毁后被丢弃
     */
    public async enqueue(file: UploadSplatFileLike, upload: (file: UploadSplatFileLike) => Promise<void>): Promise<boolean> {
        if (this.disposed || !file) return false;

        // 已有上传在途或前面还有排队请求时，按 FIFO 排队等待
        if (this.doing || this.waiters.length) {
            const waited = await new Promise<boolean>(resolve => this.waiters.push({ file, resolve }));
            if (!waited) return false; // dispose 时被直接丢弃
        }

        if (this.disposed) return false;
        this.doing = true;
        try {
            if (this.disposed) return false;
            await upload(file);
            return !this.disposed;
        } finally {
            this.doing = false;
            // 唤醒下一个排队请求；若已销毁则全部丢弃
            const next = this.disposed ? this.waiters.splice(0) : this.waiters.splice(0, 1);
            next.forEach(w => w.resolve(!this.disposed));
        }
    }
}
