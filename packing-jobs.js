'use strict';

// Tracks the single active packing request. Tokens capture the input revision at
// start; input changes invalidate every in-flight token so late results cannot
// be written to the workspace.
class PackingSession {
    constructor({ Packer: packer } = {}) {
        this.Packer = packer || (typeof Packer !== 'undefined' ? Packer : null);
        this.revision = 0;
        this.latestId = 0;
        this.current = null;
        this.currentLayout = null;
        this.best = null;
        this.excludeSignature = null;
    }

    begin({ explore = false, excludeSignature = this.excludeSignature, controller = null,
        bin = null, checkStability = true, supportRatio = 0.5 } = {}) {
        this.latestId += 1;
        this.current = { id: this.latestId, revision: this.revision, explore, excludeSignature, controller,
            bin, checkStability, supportRatio, cancelled: false };
        return this.current;
    }

    // True while a newer request has not been started.
    isLatest(token) {
        return Boolean(token) && token.id === this.latestId;
    }

    // True only for the active request whose input revision is still current.
    isCurrent(token) {
        return Boolean(token) && token === this.current && this.isLatest(token) &&
            token.revision === this.revision && !token.cancelled &&
            !(token.controller && token.controller.signal.aborted);
    }

    cancel(token = this.current) {
        if (token) token.cancelled = true;
    }

    finish(token) {
        if (token === this.current) this.current = null;
    }

    // Input changed: stop any running search, drop the best solution, the visible
    // plan and the exclusion signature derived from the previous (now stale) layout.
    invalidate() {
        this.cancel();
        this.current?.controller?.abort?.();
        this.current = null;
        this.revision += 1;
        this.currentLayout = null;
        this.best = null;
        this.excludeSignature = null;
    }

    noteLayout(items) {
        this.excludeSignature = this.Packer && Array.isArray(items) ? this.Packer.layoutSignature(items) : null;
    }

    // Only a still-current, valid, genuinely different result may replace the
    // workspace and become the best solution. Everything else leaves state as-is
    // and reports why, so the caller can explain it to the user.
    apply(token, result) {
        const cancelled = Boolean(token && (token.cancelled || token.controller?.signal.aborted));
        if (!this.isCurrent(token)) return { accepted: false, reason: cancelled ? 'cancelled' : 'stale' };
        if (!result || !Array.isArray(result.items) || result.invalidLayout) return { accepted: false, reason: 'invalid' };
        // The token's bin and options are the ones the request was started with;
        // validating here keeps legality checks independent of the caller.
        if (token.bin && this.Packer && !this.Packer.validatePackingResult(
            result.items, ...token.bin, token.checkStability, token.supportRatio).valid) {
            return { accepted: false, reason: 'invalid' };
        }
        if (token.explore && token.excludeSignature && this.Packer &&
            this.Packer.layoutSignature(result.items) === token.excludeSignature) {
            return { accepted: false, reason: 'same' };
        }
        const improved = !this.best || !this.Packer ||
            this.Packer.comparePackings(result.items, this.best.items) > 0;
        // Best follows count, then volume, then height; the visible plan always
        // follows the accepted request.
        if (improved) this.best = result;
        this.currentLayout = result.items;
        this.noteLayout(result.items);
        this.current = null;
        return { accepted: true, improved, best: this.best };
    }
}

// Each job owns its workers, timers, and abort listeners, including losing searches.
const PackingJobs = {
    blobURL: null,
    activeExplore: null,
    Session: PackingSession,
    createSession(options = {}) {
        return new PackingSession(options);
    },
    createWorker() {
        if (!this.blobURL) {
            const source = `
                const EPS_OVERLAP = ${EPS_OVERLAP}, EPS_CONTACT = ${EPS_CONTACT}, EPS_STABILITY = ${EPS_STABILITY};
                const EPS_DIMENSION = ${EPS_DIMENSION}, DEFAULT_SUPPORT_RATIO = ${DEFAULT_SUPPORT_RATIO};
                const boxesOverlap = ${boxesOverlap.toString()};
                const Item = ${Item.toString()};
                const Packer = ${Packer.toString()};
                self.onmessage = ({data}) => {
                    try {
                        const items = data.items.map(it => new Item(it.id, it.name, it.w, it.h, it.d, it.color, it.weight));
                        const p = new Packer(...data.bin);
                        const result = data.layer
                            ? p.tryLayerBacktrackingPackWithPartitions(items, data.options.checkStability, data.options.supportRatio, data.start, data.end, data.options)
                            : p.runGreedyPackTrials(items, data.options, data.start, data.end - data.start);
                        self.postMessage({result});
                    } catch (error) { self.postMessage({error: error.message}); }
                };`;
            this.blobURL = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        }
        return new Worker(this.blobURL);
    },
    // Alternative searches are single-flight: a new one always cancels and
    // waits for the previous one before its own workers start.
    async run(items, bin, options = {}, context = {}) {
        if (!options.explore) return this.runCore(items, bin, options, context);
        // Re-check after every wait: a third caller that raced in may have
        // claimed the slot while we were waiting for an older search to settle.
        while (this.activeExplore) {
            const previous = this.activeExplore;
            previous.controller.abort();
            await previous.settled;
            if (this.activeExplore === previous) break;
        }
        const signal = context.signal;
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', abort, { once: true });
        const promise = this.runCore(items, bin, options, { ...context, signal: controller.signal });
        const entry = { controller, promise, settled: null };
        entry.settled = promise.catch(() => {});
        this.activeExplore = entry;
        try { return await promise; }
        finally {
            signal?.removeEventListener('abort', abort);
            if (this.activeExplore === entry) this.activeExplore = null;
        }
    },
    async runCore(items, bin, options = {}, { signal, onProgress = () => {} } = {}) {
        const abortError = () => new DOMException('计算已取消', 'AbortError');
        const checkAbort = () => { if (signal?.aborted) throw abortError(); };
        checkAbort();
        Packer.assertItems(items);
        new Packer(...bin);
        const originals = items;
        const ids = new Map(originals.map(item => [item.id, item]));
        const normalized = { checkStability: true, supportRatio: 0.5, biggerFirst: true, seed: 20260617, timeBudgetMs: 8000, workerTimeoutMs: 15000, ...options };
        const finishResult = (packed, extra = {}) => {
            const packedIds = new Set(packed.map(item => item.id));
            return { items: packed, unpacked: originals.filter(item => !packedIds.has(item.id)), ...extra };
        };
        items = items.filter(item => Packer.getUniqueOrientations(item).some(r =>
            r.rw <= bin[0] + EPS_OVERLAP && r.rh <= bin[1] + EPS_OVERLAP && r.rd <= bin[2] + EPS_OVERLAP));
        if (!items.length) return finishResult([]);
        const stoppers = new Set();
        let workerFailure = false;
        let invalidResults = 0;
        let validResults = 0;
        const accept = data => {
            if (!Array.isArray(data)) throw new TypeError('Invalid worker result');
            const seen = new Set();
            const packed = data.map(raw => {
                const original = ids.get(raw?.id);
                if (!original || seen.has(raw.id) || !Number.isInteger(raw.rotationType) || raw.rotationType < 0 || raw.rotationType > 5) throw new RangeError('Invalid worker item');
                seen.add(raw.id);
                const item = new Item(original.id, original.name, original.w, original.h, original.d, original.color, original.weight);
                item.setRotation(raw.rotationType);
                if ([item.rw - raw.rw, item.rh - raw.rh, item.rd - raw.rd].some(v => !Number.isFinite(v) || Math.abs(v) > EPS_OVERLAP)) throw new RangeError('Invalid worker dimensions');
                item.x = raw.x; item.y = raw.y; item.z = raw.z;
                return item;
            });
            if (!Packer.validatePackingResult(packed, ...bin, normalized.checkStability, normalized.supportRatio).valid) throw new RangeError('后台返回了无效布局');
            return packed;
        };
        const different = packed => !normalized.excludeSignature || Packer.layoutSignature(packed) !== normalized.excludeSignature;
        const task = data => new Promise((resolve, reject) => {
            let worker, timer, done = false;
            const finish = (error, result) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                stoppers.delete(abort);
                if (worker) {
                    // Swap in no-op handlers first so a late reply or error
                    // arriving after termination is silently discarded.
                    worker.onmessage = () => {};
                    worker.onerror = () => {};
                    worker.onmessageerror = () => {};
                    worker.terminate();
                }
                error ? reject(error) : resolve(result);
            };
            const abort = () => finish(abortError());
            stoppers.add(abort);
            try {
                checkAbort();
                worker = this.createWorker();
                signal?.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => finish(new Error('后台计算超时，请减少数量后重试')), normalized.workerTimeoutMs);
                worker.onerror = () => finish(new Error('后台计算失败，请重试'));
                worker.onmessageerror = () => finish(new Error('后台计算结果无法读取'));
                worker.onmessage = ({ data: reply }) => {
                    if (done) return;
                    if (!reply || typeof reply !== 'object') return finish(new Error('Invalid worker response'));
                    finish(reply.error ? new Error(reply.error) : null, reply.result);
                };
                worker.postMessage({ ...data, items, bin, options: normalized });
            } catch (error) { finish(error); }
        });
        const phase = (jobs, layer) => new Promise(resolve => {
            let pending = jobs.length, cursor = 0, best = null, finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                // A validated complete solution needs no slower losing searches.
                stoppers.forEach(stop => stop());
                resolve(best);
            };
            const receive = (raw, error) => {
                if (finished) return;
                if (error) workerFailure = true;
                else if (raw) {
                    try {
                        const packed = accept(layer ? raw : raw.items);
                        validResults++;
                        const eligible = different(packed) && (!normalized.explore || packed.length > 0) &&
                            (layer ? packed.length === items.length : Number.isFinite(raw.score));
                        if (eligible && (!best || Packer.comparePackings(packed, best) > 0)) best = packed;
                    } catch { workerFailure = true; invalidResults++; }
                }
                pending--;
                if (!signal?.aborted && !layer) onProgress(25 + Math.round((jobs.length - pending) / jobs.length * 70), '正在比较装箱策略');
                if (best?.length === items.length || pending === 0 || signal?.aborted) finish();
                else next();
            };
            const next = () => {
                if (finished || cursor >= jobs.length) return;
                task(jobs[cursor++]).then(result => receive(result), error => receive(null, error));
            };
            for (let i = 0; i < Math.min(cores, jobs.length); i++) next();
        });
        const cores = Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
        try {
            if (typeof Worker !== 'undefined') {
                onProgress(0, '正在搜索分层布局');
                const layers = await phase(Array.from({ length: 8 }, (_, i) => ({ layer: true, start: i * 4, end: Math.min(30, (i + 1) * 4) })), true);
                checkAbort();
                if (layers) { onProgress(100, '布局校验完成'); return finishResult(layers); }
                onProgress(25, '正在比较装箱策略');
                const perWorker = items.length > 200 ? 4 : 12;
                const offset = normalized.explore ? 18 : 0;
                const packed = await phase(Array.from({ length: cores }, (_, i) => ({ start: offset + i * perWorker, end: offset + (i + 1) * perWorker })), false);
                checkAbort();
                if (packed) { onProgress(100, '布局校验完成'); return finishResult(packed, { degraded: workerFailure }); }
                // Every worker reply that arrived was an illegal layout, and no
                // valid candidate exists: never substitute a different layout.
                if (normalized.explore && invalidResults > 0 && validResults === 0) {
                    return finishResult([], { noAlternative: true, invalidLayout: true, degraded: true });
                }
                if (normalized.explore && !workerFailure) return finishResult([], { noAlternative: true });
            }
            // shortcut: workerless browsers run two bounded trials; enable Workers for deeper search.
            onProgress(30, '后台线程不可用，正在运行基础策略');
            let best = null;
            for (let trial = 0; trial < 2; trial++) {
                await new Promise(resolve => setTimeout(resolve, 0));
                checkAbort();
                const result = new Packer(...bin).runGreedyPackTrials(items, { ...normalized, timeBudgetMs: 100 }, (normalized.explore ? 18 : 0) + trial, 1);
                if (Number.isFinite(result.score) && different(result.items) && (!best || Packer.comparePackings(result.items, best) > 0)) best = result.items;
            }
            checkAbort();
            if (!best && normalized.explore) return finishResult([], { noAlternative: true, degraded: true });
            if (!best) throw new Error('装箱计算失败，请减少数量后重试');
            onProgress(100, '基础布局校验完成');
            return finishResult(best, { degraded: true });
        } finally { stoppers.forEach(stop => stop()); }
    },
    dispose() {
        this.activeExplore?.controller.abort();
        this.activeExplore = null;
        if (this.blobURL) URL.revokeObjectURL(this.blobURL);
        this.blobURL = null;
    }
};

if (typeof module !== 'undefined') module.exports = PackingJobs;
