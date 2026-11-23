'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal DOM surface: enough for app.js to load and for calculatePacking to
// run with rendering, progress and modal side effects replaced by spies.
function makeElement() {
    const listeners = {};
    const classList = new Set();
    const element = {
        listeners,
        style: {},
        dataset: {},
        attributes: {},
        children: [],
        innerHTML: '',
        innerText: '',
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        max: '',
        isConnected: true,
        labels: [{ textContent: 'field' }],
        addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
        removeEventListener() {},
        dispatch(type, event = {}) { (listeners[type] || []).forEach(handler => handler({ target: element, currentTarget: element, ...event })); },
        click() { element.dispatch('click'); },
        setAttribute(name, value) { element.attributes[name] = String(value); },
        getAttribute(name) { return element.attributes[name]; },
        removeAttribute(name) { delete element.attributes[name]; },
        appendChild(child) { element.children.push(child); return child; },
        remove() {},
        focus() {},
        blur() {},
        setCustomValidity() {},
        scrollIntoView() {},
        matches() { return false; },
        contains() { return false; },
        closest() { return makeElement(); },
        querySelector() { return makeElement(); },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; },
        classList: {
            add: name => classList.add(name),
            remove: name => classList.delete(name),
            toggle: (name, force) => {
                const on = force === undefined ? !classList.has(name) : force;
                if (on) classList.add(name); else classList.delete(name);
                return on;
            },
            contains: name => classList.has(name)
        },
        parentElement: null
    };
    return element;
}

module.exports = function appRuntime(root = path.resolve(__dirname, '../..')) {
    const elements = new Map();
    const parent = makeElement();
    const getElement = id => {
        if (!elements.has(id)) {
            const element = makeElement();
            element.parentElement = parent;
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const document = {
        hidden: false,
        activeElement: null,
        body: makeElement(),
        documentElement: makeElement(),
        getElementById: getElement,
        createElement: () => makeElement(),
        querySelector: () => makeElement(),
        querySelectorAll: () => [],
        addEventListener() {}
    };
    const windowListeners = {};
    const window = {
        addEventListener(type, handler) { (windowListeners[type] = windowListeners[type] || []).push(handler); },
        removeEventListener() {},
        innerWidth: 1440,
        innerHeight: 900,
        location: { href: 'http://localhost/index.html', search: '' }
    };

    const context = vm.createContext({
        module: { exports: {} }, performance, DOMException, setTimeout, clearTimeout, clearInterval, setInterval,
        AbortController, console,
        navigator: { hardwareConcurrency: 5 },
        Blob: class { constructor(parts) { this.source = parts.join(''); } },
        URL: { createObjectURL: blob => blob.source, revokeObjectURL() {} },
        URLSearchParams,
        Worker: class {
            constructor() { this.terminated = false; }
            postMessage() {}
            terminate() { this.terminated = true; }
        },
        document, window,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }),
        localStorage: { getItem: () => null, setItem() {} },
        matchMedia: () => ({ matches: false, addEventListener() {} })
    });
    context.globalThis = context;
    context.self = context;

    for (const file of ['packer.js', 'cargo.js', 'packing-jobs.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }

    const probe = vm.runInContext(`(() => {
        const spies = { displayed: [], warnings: [], parallel: [], overlays: [] };
        displayAutoResult = result => {
            spies.displayed.push(result);
            autoPackedItems = result.items;
            autoUnpackedItems = result.unpacked || [];
        };
        showWarningModal = (type, title, message) => spies.warnings.push({ type, title, message });
        openOverlay = id => spies.overlays.push(id);
        closeOverlay = () => {};
        return {
            spies,
            PackingJobs, PackingSession, packingSession, Item, Packer,
            calculatePacking, invalidateAutoLayout, cancelPacking,
            state: () => ({ bestAutoResult, autoPackedItems, autoUnpackedItems,
                packingController, activeMode, solutionAttempt, packingSeed,
                sessionBest: packingSession.best, signature: packingSession.excludeSignature }),
            setInventory: value => { inventory = value; },
            setBest: value => { bestAutoResult = value; },
            setCurrentLayout: value => { packingSession.currentLayout = value; },
            setExcludeSignature: value => { packingSession.excludeSignature = value; },
            invalidateSession: () => { packingSession.invalidate(); },
            setParallel: fn => { performParallelPacking = (...args) => {
                spies.parallel.push({ options: args[4], signal: args[5] });
                return fn(...args);
            }; }
        };
    })()`, context);

    return {
        context,
        app: probe,
        getElement,
        click(id) { getElement(id).click(); },
        status: () => getElement('workspace-status').textContent,
        tick: (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
    };
};
