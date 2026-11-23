// A canvas kept sharp at the device pixel ratio and resized with its box.
// Painting code works in CSS pixels.

export class Surface {
  readonly ctx: CanvasRenderingContext2D;
  w = 0; // CSS px
  h = 0;
  private readonly observer: ResizeObserver;

  constructor(
    readonly canvas: HTMLCanvasElement,
    onResize: () => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.observer = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      this.w = r.width;
      this.h = r.height;
      onResize();
    });
    this.observer.observe(canvas);
  }

  // Matches the bitmap to the box and the pixel ratio, and clears it: filled
  // with `background`, or transparent with null. Returns false while the
  // canvas has no size.
  begin(background: string | null): boolean {
    if (this.w < 1 || this.h < 1) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(this.w * dpr);
    const bh = Math.round(this.h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    const ctx = this.ctx;
    ctx.setTransform(bw / this.w, 0, 0, bh / this.h, 0, 0);
    if (background === null) {
      ctx.clearRect(0, 0, this.w, this.h);
    } else {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    return true;
  }

  dispose(): void {
    this.observer.disconnect();
  }
}
