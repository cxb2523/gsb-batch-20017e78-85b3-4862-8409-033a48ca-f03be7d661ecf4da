import { describe, expect, it } from 'vitest';
import { decodeFrames, NONE, ORIGIN_MODEL, ORIGIN_PROMPT } from '../source/frames';
import { Store } from '../store/store';
import { concat, config, configBody, cursor, evalFrame, hello, node, vocab } from '../testing/encode';
import { ReliefData } from './relief-data';
import { planWrite, ReliefUpload, type UploadAttribute } from './relief-upload';

interface FakeAttribute extends UploadAttribute {
  ranges: [number, number][];
}

// A stand-in for a three.js BufferAttribute: it records the ranges it is
// given, and clears them the way three.js does after an upload.
function fake(itemSize: number): FakeAttribute {
  const a: FakeAttribute = {
    itemSize,
    needsUpdate: false,
    ranges: [],
    addUpdateRange(start: number, count: number): void {
      a.ranges.push([start, count]);
    },
    clearUpdateRanges(): void {
      a.ranges.length = 0;
    },
  };
  return a;
}

function reset(attrs: readonly FakeAttribute[]): void {
  for (const a of attrs) {
    a.ranges.length = 0;
    a.needsUpdate = false;
  }
}

const ROWS = 4;

describe('planWrite', () => {
  it('writes and marks only the changed columns', () => {
    expect(planWrite(false, false, 3, 4, 10)).toEqual({ from: 3, to: 4, send: 'columns' });
  });

  it('writes nothing when no column changed', () => {
    const w = planWrite(false, false, 5, 5, 10);
    expect(w.to).toBeLessThanOrEqual(w.from);
    expect(w.send).toBe('none');
    expect(planWrite(false, false, 7, 3, 10).send).toBe('none'); // reversed
    expect(planWrite(false, false, 4, 9, 4).to).toBe(4); // past the path
  });

  it('rewrites and re-sends every column after a restore', () => {
    expect(planWrite(false, true, 3, 4, 10)).toEqual({ from: 0, to: 10, send: 'all' });
  });

  it('writes every column of a new layout without marking them', () => {
    // New arrays: three.js uploads them whole on their first draw.
    expect(planWrite(true, false, 3, 4, 10)).toEqual({ from: 0, to: 10, send: 'none' });
    // A restore arriving with the new layout is satisfied by the same write.
    expect(planWrite(true, true, 3, 4, 10)).toEqual({ from: 0, to: 10, send: 'none' });
  });
});

describe('ReliefUpload', () => {
  it('marks exactly the columns written, once per attribute', () => {
    const attrs = [fake(3), fake(4), fake(3), fake(4), fake(2)];
    const u = new ReliefUpload();
    u.layout(attrs, 256, ROWS);

    expect(u.mark(7, 8, 10)).toBe(1);
    expect(attrs[0].ranges).toEqual([[7 * ROWS * 3, ROWS * 3]]);
    expect(attrs[1].ranges).toEqual([[7 * ROWS * 4, ROWS * 4]]);
    expect(attrs[4].ranges).toEqual([[7 * ROWS * 2, ROWS * 2]]);
    for (const a of attrs) expect(a.needsUpdate).toBe(true);
  });

  it('marks nothing when nothing changed', () => {
    const attrs = [fake(3), fake(4)];
    const u = new ReliefUpload();
    u.layout(attrs, 256, ROWS);
    expect(u.mark(5, 5, 10)).toBe(0); // empty span
    expect(u.mark(6, 4, 10)).toBe(0); // reversed
    expect(u.mark(0, 10, 0)).toBe(0); // no columns in use
    for (const a of attrs) {
      expect(a.ranges).toEqual([]);
      expect(a.needsUpdate).toBe(false);
    }
  });

  it('clamps a span to the columns in use and to the layout', () => {
    const attrs = [fake(3)];
    const u = new ReliefUpload();
    u.layout(attrs, 8, 3);
    expect(u.mark(6, 100, 7)).toBe(1); // the path has 7 columns
    expect(attrs[0].ranges).toEqual([[6 * 3 * 3, 3 * 3]]);
    reset(attrs);
    expect(u.mark(0, 100, 100)).toBe(8); // never past the capacity
    expect(attrs[0].ranges).toEqual([[0, 8 * 3 * 3]]);
  });

  it('merges the columns of several writes into a single range', () => {
    const attrs = [fake(3)];
    const u = new ReliefUpload();
    u.layout(attrs, 256, ROWS);
    u.mark(3, 4, 10);
    u.mark(5, 6, 10);
    expect(attrs[0].ranges).toEqual([
      [3 * ROWS * 3, ROWS * 3],
      [5 * ROWS * 3, ROWS * 3],
    ]);
    // three.js merges the two adjacent-by-one ranges into columns 3..5; the
    // module leaves that to it, but never widens past what it was given.
  });

  it('re-sends every column in use after a restore, once', () => {
    const attrs = [fake(3), fake(4)];
    const u = new ReliefUpload();
    u.layout(attrs, 256, ROWS);
    u.mark(2, 3, 6); // an incremental write the lost frame never uploaded
    expect(u.restore(6)).toBe(6);
    for (const a of attrs) {
      expect(a.needsUpdate).toBe(true);
      // One range spanning every column, from zero; the stale one is gone.
      expect(a.ranges).toEqual([[0, 6 * ROWS * a.itemSize]]);
    }
    u.clear(); // after the frame that drew the restore
    reset(attrs);
    expect(u.mark(6, 7, 7)).toBe(1); // back to incremental, not widened
    expect(attrs[0].ranges).toEqual([[6 * ROWS * 3, ROWS * 3]]);
  });

  it('marks nothing for a restore without columns or a layout', () => {
    const u = new ReliefUpload();
    expect(u.restore(5)).toBe(0);
    const attrs = [fake(3)];
    u.layout(attrs, 4, 0);
    expect(u.restore(3)).toBe(0);
    expect(attrs[0].ranges).toEqual([]);
    expect(attrs[0].needsUpdate).toBe(false);
  });

  it('drops a stale range even when a restore has no column to send', () => {
    const attrs = [fake(3)];
    const u = new ReliefUpload();
    u.layout(attrs, 8, ROWS);
    u.mark(0, 3, 3); // marked while the context was still alive
    expect(u.restore(0)).toBe(0); // the path is empty now
    expect(attrs[0].ranges).toEqual([]); // the lost frames' range is gone
  });

  it('starts a new layout from a clean slate', () => {
    const a1 = fake(3);
    const u = new ReliefUpload();
    u.layout([a1], 256, 4);
    u.mark(0, 3, 3);
    expect(a1.ranges.length).toBe(1);
    const a2 = fake(3);
    u.layout([a2], 256, 3); // the renderer's new buffers
    expect(a2.ranges).toEqual([]); // uploaded whole on their first draw
    expect(a2.needsUpdate).toBe(false);
    // A later write of the new layout is not widened by anything older.
    expect(u.mark(2, 3, 3)).toBe(1);
    expect(a2.ranges).toEqual([[2 * 3 * 3, 3 * 3]]);
  });
});

// Prompt "<s> A" (nodes 0, 1), n_raw 4, one model.
function prompt(): Uint8Array[] {
  return [
    hello(0, 1, 1, null),
    config(0, configBody()),
    vocab(1, [0, 1, 2, 3, 4, 5, 6].map((token) => ({ token, text: `t${token}` }))),
    node(1, 0, NONE, 0, 0, ORIGIN_PROMPT),
    node(1, 1, 0, 1, 1, ORIGIN_PROMPT),
    cursor(1, 1),
  ];
}

function feed(store: Store, ...parts: Uint8Array[]): void {
  for (const f of decodeFrames(concat(...parts))) store.apply(f);
}

describe('restore with the real data cache', () => {
  it('sends every column in use once, not only the ones that changed', () => {
    const s = new Store();
    feed(s, ...prompt(), evalFrame(2, { node: 1, entries: [[2, 0.5]] }), node(2, 2, 1, 2, 2, ORIGIN_MODEL), cursor(2, 2));
    const d = new ReliefData();
    d.update(s, 'alternatives');
    const rows = d.rows;
    const attrs = [fake(3), fake(4), fake(3), fake(4), fake(2)];
    const u = new ReliefUpload();
    u.layout(attrs, d.capacity, rows);
    u.mark(d.from, d.to, d.cols);
    u.clear(); // the first frame uploaded; three.js cleared its ranges

    // A token: its column alone reaches the GPU.
    feed(s, evalFrame(3, { node: 2, entries: [[3, 0.75]] }), node(3, 3, 2, 3, 3, ORIGIN_MODEL), cursor(3, 3));
    d.update(s, 'alternatives');
    expect([d.from, d.to]).toEqual([3, 4]);
    u.mark(d.from, d.to, d.cols);
    expect(attrs[0].ranges).toEqual([[3 * rows * 3, rows * 3]]);
    reset(attrs);

    // The context comes back: the data is rebuilt and every column marked.
    d.invalidate();
    expect(d.update(s, 'alternatives')).toBe(true);
    expect([d.from, d.to]).toEqual([0, d.cols]);
    expect(u.restore(d.cols)).toBe(d.cols);
    for (const a of attrs) {
      expect(a.needsUpdate).toBe(true);
      expect(a.ranges).toEqual([[0, d.cols * rows * a.itemSize]]);
    }

    // The frame after that is incremental again.
    u.clear();
    reset(attrs);
    feed(s, evalFrame(4, { node: 3, entries: [[4, 0.5]] }), node(4, 4, 3, 4, 4, ORIGIN_MODEL), cursor(4, 4));
    d.update(s, 'alternatives');
    expect([d.from, d.to]).toEqual([4, 5]);
    u.mark(d.from, d.to, d.cols);
    expect(attrs[0].ranges).toEqual([[4 * rows * 3, rows * 3]]);
  });
});
