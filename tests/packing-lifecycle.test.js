'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jobsSource = fs.readFileSync(path.join(__dirname, '../packing-jobs.js'), 'utf8');
const packerSource = fs.readFileSync(path.join(__dirname, '../packer.js'), 'utf8');

// Build an isolated PackingJobs with controllable workers and timers.
function setup({ respond } = {}) {
    const workers = [], timers = new Map(), armed = [];
    let nextTimer = 1;
    let activeMaximum = 0;
    class Worker {
        constructor() { this.terminated = false; this.live = true; workers.push(this);
            activeMaximum = Math.max(activeMaximum, workers.filter(worker => !worker.terminated).length); }
        postMessage(data) { queueMicrotask(() => { if (this.live) respond?.(this, data); }); }
        terminate() { this.terminated = true; this.live = false; }
    }
    // Timers are tracked so a settled job must leave none behind, and any
    // captured callback fired afterwards must be a no-op.
    const setTimeoutFn = (fn, ms) => {
        const id = nextTimer++;
        const handle = setTimeout(() => { timers.delete(id); fn(); }, ms);
        timers.set(id, { handle, ms, fn });
        armed.push(fn);
        return id;
    };
    const clearTimeoutFn = id => {
        const entry = timers.get(id);
        if (entry?.handle) clearTimeout(entry.handle);
        timers.delete(id);
    };
    const context = {
        module: { exports: {} }, performance, DOMException, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn,
        AbortController, navigator: { hardwareConcurrency: 3 }, Worker, console
    };
    vm.createContext(context);
    // packer.js defines the constants and classes PackingJobs interpolates into
    // its worker source; load it into the same context first and capture them
    // before packing-jobs.js replaces module.exports.
    vm.runInContext(packerSource, context);
    const { Item, Packer } = vm.runInContext('({ Item, Packer })', context);
    vm.runInContext(jobsSource, context);
    const jobs = context.module.exports;
    jobs.createWorker = () => new Worker();
    return { jobs, workers, timers, armed, context, Worker, Item, Packer, activeMaximum: () => activeMaximum };
}

const twoItems = Item => [new Item('a', 'A', 2, 2, 2), new Item('b', 'B', 2, 2, 2)];

// Two identical boxes side by side inside a 4x4x4 bin: a legal layout.
function packedLayout(Item, Packer, bin = [4, 4, 4]) {
    return new Packer(...bin).runGreedyPackTrials(twoItems(Item), {}, 0, 1).items;
}

// A different but still legal layout: stack the second box on the first.
function stackedLayout(Item) {
    const items = twoItems(Item);
    items[0].x = 0; items[0].y = 0; items[0].z = 0;
    items[1].x = 0; items[1].y = 2; items[1].z = 0;
    return items;
}

test('cancelling an alternative search terminates its worker and drops late replies', async () => {
    const { jobs, workers, Item } = setup({ respond: () => {} }); // worker never answers
    const controller = new AbortController();
    const pending = jobs.run(twoItems(Item), [4, 4, 4], { explore: true }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(workers.length > 0, 'started at least one worker');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(workers.every(worker => worker.terminated), 'every worker was terminated');
    assert.equal(jobs.activeExplore, null, 'the single search slot was released');
    // A late reply delivered to a terminated worker is ignored, not resolved.
    for (const worker of workers) assert.doesNotThrow(() => worker.onmessage?.({ data: { result: [] } }));
});

test('a new alternative search cancels the previous one before starting workers', async () => {
    const { jobs, workers, Item } = setup({ respond: () => {} });
    const first = jobs.run(twoItems(Item), [4, 4, 4], { explore: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    const firstWorkers = workers.slice();
    const firstOutcome = first.then(() => 'resolved', error => error);
    const second = jobs.run(twoItems(Item), [4, 4, 4], { explore: true, seed: 99 });
    assert.equal((await firstOutcome).name, 'AbortError');
    assert.ok(firstWorkers.every(worker => worker.terminated), 'first search workers were terminated');
    jobs.activeExplore?.controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
});

test('a timed-out search terminates its worker, clears timers and ignores later timer callbacks', async () => {
    const { jobs, workers, timers, armed, Item, Packer } = setup({ respond: () => {} });
    const result = await jobs.run(twoItems(Item), [4, 4, 4], { explore: true, workerTimeoutMs: 5 });
    // The silent workers time out, the job falls back to a bounded main-thread
    // trial, and the returned layout is still valid.
    assert.equal(Packer.validatePackingResult(result.items, 4, 4, 4).valid, true);
    assert.equal(result.degraded, true);
    assert.ok(workers.every(worker => worker.terminated), 'timed-out workers were terminated');
    assert.equal(timers.size, 0, 'no timer remains scheduled after the job settles');
    // Fired callbacks captured before cancellation must be inert (guarded by `done`).
    for (const fire of armed) assert.doesNotThrow(fire);
});

test('every worker supplying an illegal layout is rejected as invalid, not relabelled', async () => {
    const { jobs, Item } = setup({ respond: (worker, data) => {
        // Both boxes at the origin overlap; the packer must reject them.
        const illegal = data.items.map(item => ({ ...item, x: 0, y: 0, z: 0, rotationType: 0 }));
        worker.onmessage({ data: { result: data.layer ? illegal : { items: illegal, score: 1e9 } } });
    } });
    const result = await jobs.run(twoItems(Item), [4, 4, 4], { explore: true });
    assert.equal(result.items.length, 0);
    assert.equal(result.invalidLayout, true);
    assert.equal(result.noAlternative, true);
});

test('the session keeps input revision, best solution and excluded signature consistent', () => {
    const { jobs, Item, Packer } = setup();
    const session = jobs.createSession({ Packer });
    const layoutA = packedLayout(Item, Packer);
    const layoutB = stackedLayout(Item);

    // Normal (non-explore) result becomes both visible and best.
    const applied = session.apply(session.begin({ bin: [4, 4, 4] }), { items: layoutA, unpacked: [] });
    assert.equal(applied.accepted, true);
    assert.equal(applied.improved, true);
    assert.equal(session.best.items, layoutA);
    assert.equal(session.currentLayout, layoutA);
    assert.equal(session.excludeSignature, Packer.layoutSignature(layoutA));

    // A different but not better alternative is shown without displacing the
    // best solution (same count and volume, taller stack loses on height).
    const explore = session.begin({ explore: true, excludeSignature: session.excludeSignature, bin: [4, 4, 4] });
    const alternative = session.apply(explore, { items: layoutB, unpacked: [] });
    assert.equal(alternative.accepted, true);
    assert.equal(alternative.improved, false);
    assert.equal(session.currentLayout, layoutB, 'the visible plan follows the accepted request');
    assert.equal(session.best.items, layoutA, 'the best solution follows count/volume/height');

    // Cancelling leaves the visible plan and best untouched.
    const cancelled = new AbortController();
    const cancelledToken = session.begin({ explore: true, controller: cancelled, bin: [4, 4, 4] });
    cancelled.abort();
    assert.equal(session.apply(cancelledToken, { items: layoutA, unpacked: [] }).reason, 'cancelled');
    assert.equal(session.currentLayout, layoutB);
    assert.equal(session.best.items, layoutA);

    // A stale token (superseded by a newer request) cannot write either.
    const stale = session.begin({ bin: [4, 4, 4] });
    session.begin({ bin: [4, 4, 4] });
    assert.equal(session.apply(stale, { items: layoutA, unpacked: [] }).reason, 'stale');
    assert.equal(session.currentLayout, layoutB);

    // Input changes clear best, signature and visible plan so restoration is unavailable.
    session.invalidate();
    assert.equal(session.best, null);
    assert.equal(session.excludeSignature, null);
    assert.equal(session.currentLayout, null);
});

test('a result with more packed items becomes the best solution', () => {
    const { jobs, Item, Packer } = setup();
    const session = jobs.createSession({ Packer });
    const small = Packer.layoutSignature ? new Packer(4, 4, 4).runGreedyPackTrials([new Item('a', 'A', 2, 2, 2)], {}, 0, 1).items : [];
    session.apply(session.begin({ bin: [4, 4, 4] }), { items: small, unpacked: [] });
    const improved = session.apply(session.begin({ explore: true, bin: [4, 4, 4] }), { items: packedLayout(Item, Packer), unpacked: [] });
    assert.equal(improved.accepted, true);
    assert.equal(improved.improved, true);
    assert.equal(session.best.items.length, 2);
});

test('the session rejects an illegal layout and preserves the current plan', () => {
    const { jobs, Item, Packer } = setup();
    const session = jobs.createSession({ Packer });
    session.apply(session.begin({ bin: [4, 4, 4] }), { items: packedLayout(Item, Packer), unpacked: [] });
    const before = session.currentLayout;

    const illegal = twoItems(Item).map(item => { item.x = 0; item.y = 0; item.z = 0; return item; });
    const result = session.apply(session.begin({ explore: true, bin: [4, 4, 4] }), { items: illegal, unpacked: [] });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid');
    assert.equal(session.currentLayout, before, 'illegal layout did not replace the workspace');
    assert.equal(session.best.items, before, 'illegal layout did not replace the best solution');
});

test('an identical layout cannot be accepted as a different alternative', () => {
    const { jobs, Item, Packer } = setup();
    const session = jobs.createSession({ Packer });
    const layout = packedLayout(Item, Packer);
    session.apply(session.begin({ bin: [4, 4, 4] }), { items: layout, unpacked: [] });
    const explore = session.begin({ explore: true, excludeSignature: session.excludeSignature, bin: [4, 4, 4] });
    assert.equal(session.apply(explore, { items: layout, unpacked: [] }).reason, 'same');
    assert.equal(session.best.items, layout);
});
