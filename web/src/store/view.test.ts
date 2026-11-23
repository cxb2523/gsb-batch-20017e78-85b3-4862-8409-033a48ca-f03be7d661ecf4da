import { beforeEach, describe, expect, it } from 'vitest';
import { concat, config, cursor, hello, node, vocab } from '../testing/encode';
import { decodeFrames, NONE, ORIGIN_MODEL, ORIGIN_PROMPT } from '../source/frames';
import { Store } from './store';
import { View } from './view';

function feed(store: Store, ...parts: Uint8Array[]): void {
  for (const f of decodeFrames(concat(...parts))) store.apply(f);
}

// A path of five nodes: 0..4.
function chain(store: Store): void {
  feed(store, hello(0), config(0), vocab(0, [{ token: 0, text: 'a' }]), node(0, 0, NONE, 0, 0, ORIGIN_PROMPT));
  for (let i = 1; i < 5; i++) feed(store, node(i, i, i - 1, 0, i, ORIGIN_MODEL));
  feed(store, cursor(5, 4));
}

describe('View', () => {
  let store: Store;
  let view: View;

  beforeEach(() => {
    store = new Store();
    view = new View(store);
  });

  it('selects nothing on an empty path', () => {
    expect(view.selected()).toBe(-1);
    view.setHover(2);
    view.pin(2);
    expect(view.hoveredIndex()).toBeNull();
    expect(view.pinnedIndex()).toBeNull();
    expect(view.selected()).toBe(-1);
  });

  it('selects the last token by default and follows the path as it grows', () => {
    chain(store);
    expect(view.selected()).toBe(4);
    feed(store, node(6, 5, 4, 0, 5, ORIGIN_MODEL), cursor(6, 5));
    expect(view.selected()).toBe(5);
  });

  it('prefers the pinned token, then the hovered one', () => {
    chain(store);
    view.setHover(1);
    expect(view.selected()).toBe(1);
    view.pin(3);
    expect(view.selected()).toBe(3);
    view.setHover(2);
    expect(view.selected()).toBe(3);
    view.unpin();
    expect(view.selected()).toBe(2);
    view.setHover(null);
    expect(view.selected()).toBe(4);
  });

  it('flags the panels on every change', () => {
    chain(store);
    store.dirty.stream = store.dirty.candidates = store.dirty.gates = store.dirty.timeline = store.dirty.relief = false;
    view.setHover(1);
    expect(store.dirty.stream && store.dirty.candidates && store.dirty.gates && store.dirty.timeline && store.dirty.relief).toBe(true);
    store.dirty.stream = false;
    view.setHover(1); // no change, no flag
    expect(store.dirty.stream).toBe(false);
  });

  it('moves the pinned selection within the path', () => {
    chain(store);
    view.move(-1); // nothing pinned: no-op
    expect(view.pinnedIndex()).toBeNull();
    view.pin(2);
    view.move(1);
    expect(view.pinnedIndex()).toBe(3);
    view.move(10);
    expect(view.pinnedIndex()).toBe(4);
    view.move(-10);
    expect(view.pinnedIndex()).toBe(0);
  });

  it('clamps indexes to the path', () => {
    chain(store);
    view.pin(99);
    expect(view.pinnedIndex()).toBe(4);
    view.pin(-3);
    expect(view.pinnedIndex()).toBe(0);
    view.setHover(1.6);
    expect(view.hoveredIndex()).toBe(2);
  });

  it('drops the selection when the path changes beyond the kept prefix', () => {
    chain(store);
    view.pin(1);
    view.setHover(2);
    // Extending the path keeps it.
    feed(store, node(6, 5, 4, 0, 5, ORIGIN_MODEL), cursor(6, 5));
    expect(view.pinnedIndex()).toBe(1);
    expect(view.hoveredIndex()).toBe(2);
    // Another branch from node 2 keeps tokens 0..2: the pin stays, the hover goes.
    feed(store, node(7, 6, 2, 0, 3, ORIGIN_MODEL), cursor(7, 6));
    expect(store.pathKept).toBe(3);
    expect(view.pinnedIndex()).toBe(1);
    expect(view.hoveredIndex()).toBeNull();
    // A pin on the last kept token survives; one on the first new token does not.
    view.pin(2);
    feed(store, node(8, 7, 2, 0, 3, ORIGIN_MODEL), cursor(8, 7));
    expect(view.pinnedIndex()).toBe(2);
    view.pin(3);
    feed(store, cursor(9, 6));
    expect(view.pinnedIndex()).toBeNull();
    expect(view.selected()).toBe(3);
    // Choosing a branch by hand follows the same rule.
    view.pin(1);
    store.viewNode(7);
    expect(view.pinnedIndex()).toBe(1);
    // Two replacements before the view looks: nothing is known to survive.
    store.viewNode(6);
    store.viewNode(5);
    expect(view.pinnedIndex()).toBeNull();
    // So does a new session.
    view.pin(0);
    feed(store, hello(8));
    expect(view.pinnedIndex()).toBeNull();
    expect(view.selected()).toBe(-1);
  });

  it('shows raw by default and keeps the selected gate across tokens and paths', () => {
    chain(store);
    expect(view.selectedGate()).toBe(-1);
    expect(view.shownGate(3)).toBe(-1);

    store.dirty.stream = store.dirty.candidates = store.dirty.gates = store.dirty.timeline = store.dirty.relief = false;
    view.selectGate(1);
    expect(view.selectedGate()).toBe(1);
    expect(store.dirty.candidates && store.dirty.gates).toBe(true);
    expect(store.dirty.stream || store.dirty.timeline).toBe(false);

    store.dirty.candidates = store.dirty.gates = false;
    view.selectGate(1); // no change, no flag
    expect(store.dirty.gates).toBe(false);

    view.pin(2);
    expect(view.selectedGate()).toBe(1);
    feed(store, node(7, 6, 2, 0, 3, ORIGIN_MODEL), cursor(7, 6)); // another branch
    expect(view.selectedGate()).toBe(1);
  });

  it('shows raw for a decision with fewer gates than the selected one', () => {
    view.selectGate(2);
    expect(view.shownGate(3)).toBe(2);
    expect(view.shownGate(2)).toBe(-1);
    expect(view.shownGate(0)).toBe(-1);
    expect(view.selectedGate()).toBe(2);
    view.selectGate(-5);
    expect(view.selectedGate()).toBe(-1);
  });
});
