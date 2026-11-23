import { renderSeamlessLoopFrames } from './LoopFrames.js';

const DEFAULT_FRAME_COUNT = 8;
const DEFAULT_FRAME_DURATION = 1.25;
const DEFAULT_PREVIEW_DIMENSION = 160;
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 512;
const MIN_FRAME_COUNT = 1;
const MAX_FRAME_COUNT = 120;

const boundedNumber = (value, fallback, minimum, maximum) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
};

const boundedFrameCount = (value, fallback = DEFAULT_FRAME_COUNT) => (
    Math.round(boundedNumber(value, fallback, MIN_FRAME_COUNT, MAX_FRAME_COUNT))
);

const boundedDimension = (value, fallback) => (
    Math.round(boundedNumber(value, fallback, MIN_DIMENSION, MAX_DIMENSION))
);

const createAbortError = (message = 'Preview rebuild superseded.') => {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
};

const isAbortError = (error) => error?.name === 'AbortError';

// Configs are plain-data objects, but external callers may hand us nested
// structures (or a config that was mutated in place after an export started).
// A deep clone is the recipe snapshot boundary for preview and export alike.
const cloneConfig = (config) => {
    try {
        return structuredClone(config ?? {});
    } catch {
        return JSON.parse(JSON.stringify(config ?? {}));
    }
};

export default class Renderer {
    constructor(canvas, emitter, options = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.context.imageSmoothingEnabled = false;
        this.emitter = emitter;
        this.showTarget = options.showTarget ?? true;
        this.showOriginDot = options.showOriginDot ?? true;
        this.continuous = options.continuous ?? true;
        this.lastTime = 0;
        this.running = false;
        this.onFrame = options.onFrame || (() => {});
        this.blendMode = 'source-over';
        this.timeScale = 1.0;

        // Injectable so verification pages (or alternate encoders) can drive the
        // frame renderer without reaching into the animation loop.
        this._renderFrames = options.renderFrames || renderSeamlessLoopFrames;
        this._onPreviewStateChange = options.onPreviewStateChange || null;

        this.framePreviewMode = false;
        this.frameCount = DEFAULT_FRAME_COUNT;
        this.frameDuration = DEFAULT_FRAME_DURATION;
        this.previewTime = 0;

        // Preview rebuild lifecycle. At most one *current* request exists per
        // invalidation; a newer one aborts and detaches the old request, drops the
        // cache and becomes the single pending build, so rapid changes never queue
        // a backlog of renders. Superseded results are discarded by token.
        this._previewStatus = 'idle';
        this._previewError = null;
        this._previewFrames = null;
        this._previewMeta = null;
        this._previewGeneration = 0;
        this._previewToken = 0;
        this._previewActive = null;
        this._previewScheduled = false;
        this._previewTarget = null;

        // Retained for callers that inspected the previous implementation.
        this._previewDirty = true;
        this._rebuilding = false;
        this._theme = null;
    }

    // getComputedStyle forces a style recalculation; the theme is static for a
    // mounted canvas, so resolve these custom properties once and cache them.
    readTheme() {
        if (!this._theme) {
            const styles = getComputedStyle(this.canvas);
            this._theme = {
                accent: styles.getPropertyValue('--accent').trim() || '#32d7ff',
                muted: styles.getPropertyValue('--text-muted').trim() || '#9aa3b2'
            };
        }
        return this._theme;
    }

    refreshTheme() {
        this._theme = null;
    }

    get previewStatus() {
        return this._previewStatus;
    }

    get previewError() {
        return this._previewError;
    }

    get previewGeneration() {
        return this._previewGeneration;
    }

    // Read-only view of the cached ImageData frames. Null while the preview is
    // being rebuilt or after a failed rebuild, so callers can never mistake a
    // frame from an older recipe for the current one.
    get previewFrames() {
        return this._previewFrames;
    }

    // Snapshot metadata for the frames currently in the cache.
    get previewMeta() {
        return this._previewMeta ? { ...this._previewMeta } : null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        requestAnimationFrame((time) => this.loop(time));
    }

    stop() {
        this.running = false;
    }

    loop(time) {
        if (!this.running) return;

        const deltaTime = (Math.min((time - this.lastTime) / 1000 || 0, 1 / 30)) * this.timeScale;
        this.lastTime = time;

        this.renderTick(deltaTime);

        requestAnimationFrame((nextTime) => this.loop(nextTime));
    }

    // One animation step. Exposed so verification pages can drive preview
    // playback deterministically instead of depending on requestAnimationFrame.
    renderTick(deltaTime = 0) {
        if (this.framePreviewMode) {
            this._syncPreviewTarget();
            this.clear();

            if (this._previewStatus === 'ready' && this._previewFrames?.length) {
                this.previewTime += deltaTime;
                if (this.previewTime >= this.frameDuration) {
                    this.previewTime -= this.frameDuration;
                }
                let frameIndex = Math.floor((this.previewTime / this.frameDuration) * this._previewFrames.length);
                frameIndex = Math.min(this._previewFrames.length - 1, Math.max(0, frameIndex));
                this.context.putImageData(this._previewFrames[frameIndex], 0, 0);
                this.onFrame(this.emitter.particles.length);
            } else if (this._previewStatus === 'building') {
                // Fallback in case a microtask-scheduled rebuild was dropped.
                this._ensurePreviewBuild();
            }

            this.drawTargetDummy();
            this.drawViewportGuides();

            if (this._previewStatus === 'building') {
                this._drawPreviewBuildingOverlay();
            } else if (this._previewStatus === 'error') {
                this._drawPreviewErrorOverlay();
            }
        } else {
            this.clear();
            this.drawTargetDummy();
            this.drawViewportGuides();
            this.emitter.update(deltaTime, this.continuous);

            this.context.globalCompositeOperation = this.blendMode;
            this.emitter.draw(this.context);
            this.context.globalCompositeOperation = 'source-over';

            this.onFrame(this.emitter.particles.length);
        }
    }

    _currentTarget() {
        return {
            // Clamp to the frame renderer's own bounds so the request dimensions
            // always match the frames it returns back.
            width: boundedDimension(this.canvas.width, DEFAULT_PREVIEW_DIMENSION),
            height: boundedDimension(this.canvas.height, DEFAULT_PREVIEW_DIMENSION),
            frameCount: boundedFrameCount(this.frameCount)
        };
    }

    _syncPreviewTarget() {
        if (!this.framePreviewMode) return;
        const target = this._currentTarget();
        const previous = this._previewTarget;
        if (!previous
            || previous.width !== target.width
            || previous.height !== target.height
            || previous.frameCount !== target.frameCount) {
            this.markPreviewDirty();
        }
    }

    _setPreviewStatus(status, error = null) {
        const nextError = status === 'error' ? error : null;
        const changed = this._previewStatus !== status
            || (status === 'error' && this._previewError !== nextError);
        this._previewStatus = status;
        this._previewError = nextError;
        this._rebuilding = status === 'building';
        this._previewDirty = status === 'building';

        if (!changed || !this._onPreviewStateChange) return;
        try {
            this._onPreviewStateChange({
                status,
                error: this._previewError,
                generation: this._previewGeneration,
                frameCount: status === 'ready' ? this._previewFrames?.length ?? 0 : 0
            });
        } catch {
            // A diagnostic listener must never break the render loop.
        }
    }

    _schedulePreviewBuild() {
        if (this._previewScheduled) return;
        this._previewScheduled = true;
        queueMicrotask(() => {
            this._previewScheduled = false;
            this._startPreviewBuild();
        });
    }

    _ensurePreviewBuild() {
        if (!this.framePreviewMode || this._previewStatus !== 'building') return;
        if (this._previewActive || this._previewScheduled) return;
        this._schedulePreviewBuild();
    }

    _startPreviewBuild() {
        if (!this.framePreviewMode || this._previewStatus !== 'building') return Promise.resolve();
        // One build at a time. A newer invalidation detaches (and aborts) the
        // active request, so this slot is free for the coalesced latest request
        // without waiting on a renderer that may ignore the abort signal.
        if (this._previewActive) return this._previewActive.promise || Promise.resolve();

        const target = this._currentTarget();
        const request = {
            token: this._previewToken += 1,
            generation: this._previewGeneration,
            width: target.width,
            height: target.height,
            frameCount: target.frameCount,
            config: cloneConfig(this.emitter?.config),
            controller: new AbortController()
        };
        this._previewActive = request;
        this._previewTarget = target;

        let pending;
        try {
            // Snapshot the config before the first await: the async renderer can
            // never observe control changes made after this request started.
            pending = this._renderFrames({
                config: request.config,
                width: request.width,
                height: request.height,
                frameCount: request.frameCount,
                signal: request.controller.signal
            });
        } catch (error) {
            this._failPreviewBuild(request, error);
            request.promise = Promise.resolve();
            return request.promise;
        }

        request.promise = Promise.resolve(pending).then(
            (result) => this._completePreviewBuild(request, result),
            (error) => this._failPreviewBuild(request, error)
        );
        return request.promise;
    }

    // Backwards-compatible entry point for callers that used to trigger a build
    // directly. It only renders when a rebuild is actually pending, and returns
    // the in-flight promise so callers can await the current request.
    _rebuildPreviewFrames() {
        if (!this.framePreviewMode || this._previewStatus !== 'building') {
            return Promise.resolve();
        }
        if (this._previewActive) return this._previewActive.promise || Promise.resolve();
        return this._startPreviewBuild() || Promise.resolve();
    }

    _isCurrentRequest(request) {
        if (!this.framePreviewMode
            || request.token !== this._previewToken
            || request.generation !== this._previewGeneration) return false;
        const target = this._currentTarget();
        return request.width === target.width
            && request.height === target.height
            && request.frameCount === target.frameCount;
    }

    _resumePendingBuild() {
        if (this.framePreviewMode && this._previewStatus === 'building') {
            this._schedulePreviewBuild();
        }
    }

    _normalizeFrames(frames, request) {
        if (!Array.isArray(frames)) {
            throw new Error('Preview renderer returned no frame sequence.');
        }
        if (frames.length !== request.frameCount) {
            throw new Error(`Preview renderer returned ${frames.length} frames, expected ${request.frameCount}.`);
        }
        return frames.map((frame, index) => {
            if (!frame
                || typeof frame.getContext !== 'function'
                || frame.width !== request.width
                || frame.height !== request.height) {
                throw new Error(`Preview frame ${index} does not match the requested canvas size.`);
            }
            return frame.getContext('2d').getImageData(0, 0, request.width, request.height);
        });
    }

    _completePreviewBuild(request, result) {
        if (this._previewActive === request) this._previewActive = null;

        if (!this._isCurrentRequest(request)) {
            this._resumePendingBuild();
            return;
        }

        let imageFrames;
        try {
            imageFrames = this._normalizeFrames(result?.frames, request);
        } catch (error) {
            this._failPreviewBuild(request, error);
            return;
        }

        this._previewFrames = imageFrames;
        this._previewMeta = {
            config: request.config,
            width: request.width,
            height: request.height,
            frameCount: request.frameCount,
            generation: request.generation
        };
        this.previewTime = 0;
        this._setPreviewStatus('ready');
    }

    _failPreviewBuild(request, error) {
        if (this._previewActive === request) this._previewActive = null;

        // Late failures from an aborted or superseded request are expected; they
        // must neither surface as an error state nor leave the latest request stuck.
        if (isAbortError(error) || !this._isCurrentRequest(request)) {
            this._resumePendingBuild();
            return;
        }

        this._previewFrames = null;
        this._previewMeta = null;
        this._setPreviewStatus('error', error || new Error('Preview rebuild failed.'));
    }

    markPreviewDirty() {
        this._previewGeneration += 1;
        this._previewFrames = null;
        this._previewMeta = null;
        this._previewError = null;
        this.previewTime = 0;
        this._previewTarget = this._currentTarget();

        // Invalidate whatever is in flight. Detaching the request lets the latest
        // one start right away even if a superseded renderer ignores the abort;
        // its eventual result is discarded by token and generation, so at most
        // one *current* request exists and rapid edits never build a queue.
        if (this._previewActive) {
            const superseded = this._previewActive;
            this._previewActive = null;
            superseded.controller.abort(createAbortError());
        }

        if (!this.framePreviewMode) {
            this._setPreviewStatus('idle');
            return;
        }

        this._setPreviewStatus('building');
        this._schedulePreviewBuild();
    }

    retryPreview() {
        if (!this.framePreviewMode) return false;
        this.markPreviewDirty();
        return true;
    }

    // Detect a canvas resize (or a frame-count change applied elsewhere) and
    // invalidate the cached sequence. The animation loop calls this every tick;
    // it is exposed so headless checks can drive the same path deterministically.
    syncPreviewTarget() {
        this._syncPreviewTarget();
        this._ensurePreviewBuild();
    }

    clear() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    setEmitter(emitter) {
        this.emitter = emitter;
        this.markPreviewDirty();
    }

    setShowTarget(value) {
        this.showTarget = value;
    }

    setShowOriginDot(value) {
        this.showOriginDot = value;
    }

    setContinuous(value) {
        this.continuous = value;
    }

    setBlendMode(mode) {
        this.blendMode = mode;
    }

    setTimeScale(value) {
        this.timeScale = value;
    }

    setFramePreviewMode(enabled, frameCount, frameDuration) {
        const nextEnabled = Boolean(enabled);
        const nextFrameCount = frameCount === undefined
            ? this.frameCount
            : boundedFrameCount(frameCount, this.frameCount);
        const nextFrameDuration = frameDuration === undefined
            ? this.frameDuration
            : boundedNumber(frameDuration, this.frameDuration, 0.05, 30);

        const countChanged = nextFrameCount !== this.frameCount;
        const enabledChanged = nextEnabled !== this.framePreviewMode;

        this.framePreviewMode = nextEnabled;
        this.frameCount = nextFrameCount;
        this.frameDuration = nextFrameDuration;

        // Duration only changes playback pacing; recipe, frame count and canvas
        // geometry changes invalidate the cached sequence.
        if (enabledChanged || countChanged || !nextEnabled) {
            this.markPreviewDirty();
        }
    }

    // Render a frame sequence from a recipe/config snapshot taken at call time.
    // The result never touches the preview cache, so export and preview can run
    // concurrently without one mutating the other.
    async exportFrames(options = {}) {
        const width = boundedDimension(options.width ?? this.canvas.width, this.canvas.width);
        const height = boundedDimension(options.height ?? this.canvas.height, this.canvas.height);
        const frameCount = boundedFrameCount(options.frameCount ?? this.frameCount, this.frameCount);
        const config = cloneConfig(this.emitter?.config);

        const result = await this._renderFrames({
            config,
            width,
            height,
            frameCount,
            signal: options.signal
        });

        if (!Array.isArray(result?.frames) || result.frames.length !== frameCount) {
            throw new Error('Export renderer returned an unexpected frame sequence.');
        }

        return { frames: result.frames, config, frameCount, width, height };
    }

    exportPng(filename = `pixel-fx-${Date.now()}.png`) {
        const link = document.createElement('a');
        link.download = filename;
        link.href = this.canvas.toDataURL('image/png');
        link.click();
    }

    _drawPreviewBuildingOverlay() {
        const context = this.context;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const muted = this.readTheme().muted;

        context.save();
        context.fillStyle = muted;
        context.font = `${Math.max(7, Math.round(w / 16))}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(w < 100 ? 'Building…' : '⟳ Building preview…', w / 2, h / 2);
        context.restore();
    }

    _drawPreviewErrorOverlay() {
        const context = this.context;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const muted = this.readTheme().muted;

        context.save();
        context.fillStyle = muted;
        context.font = `${Math.max(7, Math.round(w / 16))}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('Preview failed', w / 2, h / 2);
        context.restore();
    }

    drawTargetDummy() {
        if (!this.showTarget) return;

        const context = this.context;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const cx = w / 2;
        const cy = h / 2;

        const scale = w / 160;
        const headRadius = 10 * scale;
        const bodyWidth = 18 * scale;
        const bodyHeight = 38 * scale;
        const legHeight = 26 * scale;

        const bodyTop = cy - bodyHeight / 2;
        const bodyBottom = bodyTop + bodyHeight;
        const headCenterY = bodyTop - headRadius;

        context.fillStyle = 'rgba(255,255,255,0.07)';

        context.beginPath();
        context.arc(cx, headCenterY, headRadius, 0, Math.PI * 2);
        context.fill();

        context.fillRect(cx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);

        const legWidth = bodyWidth / 2.6;
        context.fillRect(cx - bodyWidth / 2, bodyBottom, legWidth, legHeight);
        context.fillRect(cx + bodyWidth / 2 - legWidth, bodyBottom, legWidth, legHeight);
    }

    drawViewportGuides() {
        const context = this.context;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const cx = w / 2;
        const cy = h / 2;

        context.save();
        context.strokeStyle = 'rgba(255,255,255,0.04)';
        context.setLineDash([2, 4]);

        context.beginPath();
        context.moveTo(0, cy);
        context.lineTo(w, cy);
        context.stroke();

        context.beginPath();
        context.moveTo(cx, 0);
        context.lineTo(cx, h);
        context.stroke();

        context.setLineDash([]);
        context.restore();

        if (this.showOriginDot) {
            const accent = this.readTheme().accent;
            const ox = Math.round(this.emitter.originX);
            const oy = Math.round(this.emitter.originY);
            context.fillStyle = accent;
            context.fillRect(ox - 1, oy - 1, 3, 3);
        }
    }
}
