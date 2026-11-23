// The interval between tokens that the per-token animations (1, 2 and 4)
// size themselves by: an average of the last few, so that the jitter of the
// paint loop and the network at a steady speed does not switch an animation
// on and off from one token to the next. A gap over a second (a pause, the
// first token) is used as it is and starts the average again.

const ALPHA = 0.25;
const RESET_MS = 1000;

export class Pace {
  private last = -Infinity;
  private avg = NaN;

  // A token arrived at `now` (ms): the interval to size its animation by.
  next(now: number): number {
    const gap = now - this.last;
    this.last = now;
    if (!(gap <= RESET_MS)) {
      this.avg = NaN;
      return gap;
    }
    this.avg = Number.isNaN(this.avg) ? gap : this.avg + ALPHA * (gap - this.avg);
    return this.avg;
  }
}
