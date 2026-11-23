// Which part of the relief's vertex buffers must reach the GPU again,
// without three.js or the DOM: the bookkeeping behind Relief's uploads
// (render/relief.ts).
//
// The attributes hold `capacity × rows` vertices, column by column (see
// relief-data.ts: vertex = column * rows + row), so the vertices of the
// columns [from, to) are one contiguous stretch of every attribute, starting
// at element `from * rows * itemSize`. A write marks exactly the columns it
// rewrote: a new token costs one column, never the whole path, and a frame
// that changed nothing marks nothing at all.
//
// After the context comes back the GPU holds no buffer at all, and the
// ranges marked while the context was lost were never uploaded (nothing is
// drawn then). So `restore` drops those stale ranges and marks every column
// in use again, from zero: the whole surface is sent once. three.js clears
// the ranges of an attribute after it applies them, so a full range does not
// linger to widen a later incremental write.
//
// A new layout brings new attribute arrays, which three.js creates whole on
// their first draw: `layout` only records the new geometry, nothing is
// marked, and no range of the old layout can be inherited.

// What an upload needs of a three.js BufferAttribute.
export interface UploadAttribute {
  readonly itemSize: number;
  needsUpdate: boolean;
  addUpdateRange(start: number, count: number): void;
  clearUpdateRanges(): void;
}

// What a frame writes into the arrays and sends to the GPU.
export interface WritePlan {
  from: number; // first column to write; to <= from means nothing to write
  to: number;
  send: 'none' | 'columns' | 'all'; // what to mark: nothing, [from,to), or every column in use
}

// The columns one frame writes, given a new layout (new source, row count or
// model in front), a context restore, and the span ReliefData reports
// changed. A layout or a restore means the whole grid; otherwise only the
// changed columns, and none when the span is empty.
export function planWrite(relaid: boolean, restored: boolean, from: number, to: number, cols: number): WritePlan {
  // A new layout: its arrays are new, so three.js uploads them whole on their
  // first draw — writing them all is enough, nothing must be marked.
  if (relaid) return { from: 0, to: cols, send: 'none' };
  // The GPU lost every buffer: all columns are written and marked again.
  if (restored) return { from: 0, to: cols, send: 'all' };
  const end = Math.min(to, cols);
  return end > from ? { from, to: end, send: 'columns' } : { from: end, to: end, send: 'none' };
}

export class ReliefUpload {
  private attrs: readonly UploadAttribute[] = [];
  private rows = 0; // vertices per column
  private capacity = 0; // columns the arrays hold

  // Adopts the attributes of a new layout: `capacity` columns of `rows` rows.
  // Their arrays are new, so three.js creates each buffer whole on its first
  // draw; any range left over from the old layout is dropped.
  layout(attrs: readonly UploadAttribute[], capacity: number, rows: number): void {
    this.attrs = attrs;
    this.capacity = capacity;
    this.rows = rows;
    this.clear();
  }

  // Columns [from, to) of a path `cols` columns long changed. Returns how
  // many columns were marked; 0 (and no attribute touched) for an empty,
  // reversed or out-of-range span.
  mark(from: number, to: number, cols: number): number {
    const start = Math.max(0, Math.min(from, cols, this.capacity));
    const end = Math.max(0, Math.min(to, cols, this.capacity));
    const n = end - start;
    if (n <= 0 || this.rows <= 0) return 0;
    for (const a of this.attrs) {
      a.addUpdateRange(start * this.rows * a.itemSize, n * this.rows * a.itemSize);
      a.needsUpdate = true;
    }
    return n;
  }

  // Every column in use, after the GPU lost its buffers with the context:
  // one range from zero, so its whole array reaches the GPU again. Returns
  // how many columns were marked.
  restore(cols: number): number {
    if (this.rows <= 0) return 0;
    const n = Math.max(0, Math.min(cols, this.capacity));
    this.clear(); // the ranges of the lost frames were never uploaded
    if (n <= 0) return 0;
    for (const a of this.attrs) {
      a.addUpdateRange(0, n * this.rows * a.itemSize);
      a.needsUpdate = true;
    }
    return n;
  }

  // Forgets every pending range: the buffers have reached the GPU (whole,
  // when they were just created), so nothing of them remains to send.
  clear(): void {
    for (const a of this.attrs) a.clearUpdateRanges();
  }
}
