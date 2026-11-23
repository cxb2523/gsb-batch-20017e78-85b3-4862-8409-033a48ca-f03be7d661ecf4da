'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const appRuntime = require('./helpers/app-runtime.cjs');

const BIN = { 'bin-l': '5', 'bin-w': '5', 'bin-h': '5',
    'bin-empty-weight': '1.5', 'bin-max-weight': '21', 'bin-divisor': '8000' };

function boot() {
    const runtime = appRuntime();
    for (const [id, value] of Object.entries(BIN)) runtime.getElement(id).value = value;
    runtime.app.setInventory([
        { id: 'p1', name: 'A', l: 2, w: 2, h: 2, qty: 2, color: '#6366f1', weight: 0.5, ratio: 0, minQty: 0 }
    ]);
    runtime.getElement('cfg-stability').checked = true;
    runtime.getElement('cfg-bigger-first').checked = true;
    return runtime;
}

// Build `count` legal boxes inside a 5x5x5 bin, as the UI would receive them.
function layout(Item, positions) {
    return positions.map((position, index) => {
        const item = new Item('auto_p1_' + index, 'A', 2, 2, 2, '#6366f1', 0.5);
        item.x = position[0]; item.y = position[1]; item.z = position[2];
        return item;
    });
}

test('a normal alternative updates the current plan and best solution', async () => {
    const { app, status, spies } = boot();
    // Initial run: two boxes stacked (taller).
    const stacked = [ [0, 0, 0], [0, 2, 0] ];
    // Alternative: two boxes side by side (shorter, same count/volume).
    const sideBySide = [ [0, 0, 0], [2, 0, 0] ];

    app.setParallel(() => ({ items: layout(app.Item, stacked), unpacked: [] }));
    await app.calculatePacking();
    const firstBest = app.state().bestAutoResult;
    assert.equal(firstBest.items.length, 2);

    let exploreOptions;
    app.setParallel(async (items, binW, binH, binL, options) => {
        exploreOptions = options;
        return { items: layout(app.Item, sideBySide), unpacked: [] };
    });
    await app.calculatePacking(true);
    const state = app.state();
    assert.equal(exploreOptions.explore, true);
    assert.ok(exploreOptions.excludeSignature, 'the previous layout is excluded');
    assert.equal(app.Packer.layoutSignature(state.autoPackedItems),
        app.Packer.layoutSignature(layout(app.Item, sideBySide)), 'visible plan updated');
    assert.equal(app.Packer.layoutSignature(state.bestAutoResult.items),
        app.Packer.layoutSignature(layout(app.Item, sideBySide)), 'better best solution updated');
    assert.equal(state.sessionBest, state.bestAutoResult);
});

test('a late result after cancellation never changes the workspace', async () => {
    const { app, status, spies } = boot();
    const initial = [ [0, 0, 0], [2, 0, 0] ];
    app.setParallel(() => ({ items: layout(app.Item, initial), unpacked: [] }));
    await app.calculatePacking();
    const before = app.Packer.layoutSignature(app.state().autoPackedItems);

    let release;
    app.setParallel(() => new Promise(resolve => { release = resolve; }));
    const pending = app.calculatePacking(true);
    await Promise.resolve();
    app.cancelPacking();
    // The worker "finishes" after cancellation with a valid but different layout.
    release({ items: layout(app.Item, [ [0, 0, 0], [0, 2, 0] ]), unpacked: [] });
    await pending;

    assert.equal(app.Packer.layoutSignature(app.state().autoPackedItems), before, 'late result was discarded');
    assert.equal(app.state().packingController, null, 'controller released');
});

test('an illegal layout is rejected and the current plan is preserved with a visible message', async () => {
    const { app, status, spies } = boot();
    const initial = [ [0, 0, 0], [2, 0, 0] ];
    app.setParallel(() => ({ items: layout(app.Item, initial), unpacked: [] }));
    await app.calculatePacking();
    const before = app.Packer.layoutSignature(app.state().autoPackedItems);

    // Overlapping boxes: geometrically illegal but shaped like a real result.
    app.setParallel(() => ({ items: layout(app.Item, [ [0, 0, 0], [0, 0, 0] ]), unpacked: [] }));
    await app.calculatePacking(true);

    assert.equal(app.Packer.layoutSignature(app.state().autoPackedItems), before, 'illegal layout rejected');
    assert.match(status(), /未通过校验/);
    assert.ok(app.spies.warnings.some(warning => /布局校验未通过/.test(warning.title)), 'user sees an explanation');
});

test('changing the input clears the best solution and exclusion signature', async () => {
    const { app, status, spies } = boot();
    app.setParallel(() => ({ items: layout(app.Item, [ [0, 0, 0], [2, 0, 0] ]), unpacked: [] }));
    await app.calculatePacking();
    assert.ok(app.state().bestAutoResult);
    assert.ok(app.state().signature);

    app.invalidateAutoLayout();
    const state = app.state();
    assert.equal(state.bestAutoResult, null, 'best solution cleared');
    assert.equal(state.sessionBest, null, 'session best solution cleared');
    assert.equal(state.signature, null, 'exclusion signature cleared');
    assert.equal(state.autoPackedItems.length, 0);
});

test('restore best is unavailable once the input has changed', async () => {
    const { app, click, getElement } = boot();
    app.setParallel(() => ({ items: layout(app.Item, [ [0, 0, 0], [2, 0, 0] ]), unpacked: [] }));
    await app.calculatePacking();
    assert.ok(app.state().bestAutoResult);

    // Input change invalidates the best solution, clears the workspace and
    // hides the restore control; clicking it must not repopulate anything.
    app.invalidateAutoLayout();
    assert.equal(getElement('restore-best-btn').hidden, true);
    click('restore-best-btn');
    assert.equal(app.state().autoPackedItems.length, 0, 'no stale plan restored');
});

test('restore best also refuses a stale best that the session has invalidated', async () => {
    const { app, click, getElement, status } = boot();
    app.setParallel(() => ({ items: layout(app.Item, [ [0, 0, 0], [2, 0, 0] ]), unpacked: [] }));
    await app.calculatePacking();
    const best = app.state().bestAutoResult;
    const shown = app.Packer.layoutSignature(app.state().autoPackedItems);

    // Defensive case: the UI still holds the best reference while the session's
    // revision has moved on (an invalidation racing a restore click).
    app.setBest(best);
    app.invalidateSession();
    getElement('restore-best-btn').hidden = false;
    click('restore-best-btn');

    assert.equal(app.Packer.layoutSignature(app.state().autoPackedItems), shown, 'stale plan was not restored');
    assert.match(status(), /输入已变更/);
    assert.equal(getElement('restore-best-btn').hidden, true);
});
