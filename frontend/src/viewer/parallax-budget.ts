// One parallax budget for every way of looking at the scene.
//
// The viewer has three independent ways of presenting depth, and each used to
// decide its geometry on its own: the orbit camera bounded its pivot by the
// nearest gaussian, the window placement scaled the miniature from the anchor
// depth, and the stereo pair clipped its baseline against a pixel limit. The
// three limits were consistent only by luck, so the same scene could jump in
// apparent depth when the user dragged, pinched, or switched between photo and
// True Window modes -- the switch being the worst, because the two placements
// disagreed about everything at once.
//
// This module is the single place the trade-off is made. Everything is derived
// from one set of inputs -- the scene's nearest depth (with the median as the
// long-standing fallback), the current window placement parameters, and the
// per-eye viewport size -- so a change that tightens one output tightens the
// others in the same frame instead of at the next interaction.
//
// The budget itself is the largest horizontal separation the far field may
// present, expressed as a fraction of one eye's half-width. It is the same
// quantity `effectiveBaseline` clamps against; here it also bounds how large
// (and therefore how deep-running) the window miniature may be, and the same
// nearest depth that bounds the orbit pivot anchors the window.

import { MAX_ORBIT_MAGNIFICATION, orbitPivotDistance } from './camera-orbit';
import { clampBaselineToPixelBudget } from './off-axis';
import {
  computeTrueWindowPlacement,
  computeWindowPlacement,
  type WindowPlacement,
} from './window-placement';

/**
 * Used when neither the nearest nor the median depth can be measured, so the
 * budget still produces a placement at a plausible arm's length rather than
 * throwing. Matches the viewer's own fallback subject distance.
 */
export const FALLBACK_SCENE_DEPTH = 3;

/**
 * The depth every output is measured against.
 *
 * The nearest gaussian when it is known and usable, the median otherwise --
 * exactly the fallback the orbit pivot and the window anchor each used to
 * apply separately. A nearest depth of null, zero, negative, NaN or infinite
 * is not a depth at all, and falling back is the established behaviour rather
 * than an error.
 */
export function referenceSceneDepth(
  medianDepth: number,
  nearestDepth: number | null,
): number {
  if (nearestDepth !== null && Number.isFinite(nearestDepth) && nearestDepth > 0) {
    return nearestDepth;
  }
  return medianDepth;
}

function usableDepth(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export type ParallaxBudgetInput = {
  /** Median gaussian distance, carrying the caller's own fallback. */
  medianDepth: number;
  /** Nearest gaussian depth, when it could be measured. */
  nearestDepth: number | null;
  /** Tangent of half the capture camera's vertical field of view. */
  captureTangent: number;
  /**
   * The depth that lands in the plane of the window, in scene units. When it
   * is missing or unusable the shared reference depth is anchored instead, so
   * a lost nearest-depth estimate cannot throw here.
   */
  anchorDistance?: number;
  /** How large to make the miniature. Larger is bigger, and flatter. */
  sizeScale?: number;
  /** Photo-mode frame crop; folds into the model scale in True Window. */
  zoom?: number;
  /** Place a physical miniature behind a literal window instead. */
  trueWindow?: boolean;
  /** Requested stereo baseline, in scene units. */
  baseline: number;
  /** Scales the requested baseline, exactly as in `effectiveBaseline`. */
  compression?: number;
  /** The most the background may separate, in pixels of one eye's viewport. */
  clampPx?: number;
  /** Width of one eye's viewport in pixels -- half the canvas side-by-side. */
  eyeViewportWidthPx: number;
  /** Width divided by height of one eye's viewport. */
  aspect: number;
};

export type ParallaxBudget = {
  /** The depth every output was measured against. */
  referenceDepth: number;
  /**
   * Where the orbit pivot sits: never further than the nearest depth times
   * MAX_ORBIT_MAGNIFICATION, never further than the median.
   */
  pivotDistance: number;
  /** The window placement after the budget has had its say on the scale. */
  placement: WindowPlacement;
  /** The stereo baseline after compression and the per-eye pixel clamp. */
  stereoBaseline: number;
};

/**
 * The stereo baseline the shared budget allows against a window placement.
 *
 * This is `effectiveBaseline` with the zero-parallax plane read off the
 * placement rather than off an orbit distance: the plane of the window is
 * where parallax is zero, and its half-width is `windowHalfHeight * aspect`.
 * Compression and the pixel clamp both apply and the tighter one wins, exactly
 * as in the orbit path -- the clamp is expressed in pixels of ONE eye's
 * viewport, so side-by-side and mono need no special cases.
 */
export function stereoBaselineForPlacement({
  baseline,
  compression = 1,
  clampPx = 0,
  eyeViewportWidthPx,
  aspect,
  placement,
}: {
  baseline: number;
  compression?: number;
  clampPx?: number;
  eyeViewportWidthPx: number;
  aspect: number;
  placement: WindowPlacement;
}): number {
  const requested = Number.isFinite(baseline) ? baseline : 0;
  const scaled = Math.max(0, requested
    * (Number.isFinite(compression) ? Math.max(0, compression as number) : 1));
  return clampBaselineToPixelBudget({
    baseline: scaled,
    clampPx,
    eyeViewportWidthPx,
    halfWidth: placement.windowHalfHeight * aspect,
  });
}

/**
 * The largest photo-mode size the budget allows, or Infinity for no limit.
 *
 * The miniature's anchor sits on the glass and its deeper content sits behind
 * it, so a head movement of `baseline` separates the median-depth content from
 * the glass by `baseline * D / ((eye + D) * halfWidth)`, where D is how far
 * behind the glass that content lies. D grows with the size scale, so a
 * requested baseline that would burst the pixel budget can be answered two
 * ways: clamp the baseline (which `stereoBaselineForPlacement` does) and cap
 * the size so the relief itself respects the budget. Doing both is what keeps
 * the stereo view and the window view of one scene inside the same envelope.
 *
 * True Window needs no cap: it scales the miniature and its capture viewpoint
 * uniformly, which leaves every separation unchanged, so the size control
 * there is purely how large the miniature looks.
 */
function photoSizeBudgetCap({
  baseline,
  clampPx,
  eyeViewportWidthPx,
  aspect,
  windowHalfHeight,
  apex,
  anchorDistance,
  medianDepth,
}: {
  baseline: number;
  clampPx: number;
  eyeViewportWidthPx: number;
  aspect: number;
  windowHalfHeight: number;
  apex: number;
  anchorDistance: number;
  medianDepth: number;
}): number {
  if (!(clampPx > 0) || !(eyeViewportWidthPx > 0) || !(aspect > 0)) return Infinity;
  if (!(apex > 0) || !(anchorDistance > 0)) return Infinity;
  // No relief deeper than the anchor means nothing for the budget to bound.
  if (!(medianDepth > anchorDistance)) return Infinity;
  const halfWidth = windowHalfHeight * aspect;
  const budgetFraction = clampPx / eyeViewportWidthPx;
  if (!(baseline > budgetFraction * halfWidth)) return Infinity;
  // Solve baseline * D / ((apex + D) * halfWidth) = budgetFraction for D.
  const maxDepthBehindGlass =
    (budgetFraction * halfWidth * apex) / (baseline - budgetFraction * halfWidth);
  // D = apex * (size * median / anchor - 1); invert for the size.
  return ((maxDepthBehindGlass / apex) + 1) * (anchorDistance / medianDepth);
}

/**
 * Decide the orbit pivot, the window placement and the stereo baseline
 * together, from one set of inputs.
 *
 * The guarantees this makes are the ones the separate computations used to
 * make only within themselves:
 *
 *  - the pivot never exceeds the nearest depth times MAX_ORBIT_MAGNIFICATION;
 *  - the stereo baseline honours compression and the per-eye pixel clamp, the
 *    tighter winning, measured against the placement it is returned with;
 *  - the budget never pushes the window's anchor in front of the glass: when
 *    the size cap would, the size stops at the anchor-on-glass floor instead;
 *  - a missing or non-finite nearest depth falls back to the median logic and
 *    never throws.
 */
export function resolveParallaxBudget({
  medianDepth,
  nearestDepth,
  captureTangent,
  anchorDistance,
  sizeScale = 1,
  zoom = 1,
  trueWindow = false,
  baseline,
  compression = 1,
  clampPx = 0,
  eyeViewportWidthPx,
  aspect,
}: ParallaxBudgetInput): ParallaxBudget {
  // The pivot rule is the established one; sharing it is what makes the orbit
  // and the window agree about how close the scene comes. When not even the
  // median is a usable depth the established rule has nothing to say, and the
  // budget answers with the same arm's-length fallback as the anchor rather
  // than handing back a NaN the camera would orbit at.
  const rawReference = referenceSceneDepth(medianDepth, nearestDepth);
  const referenceDepth = usableDepth(rawReference) ? rawReference : FALLBACK_SCENE_DEPTH;
  const rawPivot = orbitPivotDistance(medianDepth, nearestDepth);
  const pivotDistance = usableDepth(rawPivot) ? rawPivot : referenceDepth;
  const anchor = usableDepth(anchorDistance as number)
    ? (anchorDistance as number)
    : referenceDepth;

  const requestedSize = Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;
  const requestedBaseline = Math.max(0, (Number.isFinite(baseline) ? baseline : 0)
    * (Number.isFinite(compression) ? Math.max(0, compression) : 1));

  let placement: WindowPlacement;
  if (trueWindow) {
    // A literal window: pinch is a physical model scale, the aperture never
    // changes, and uniform scaling cannot change any separation -- so there is
    // no size cap to apply, and the anchor is on the glass by construction.
    placement = computeTrueWindowPlacement({
      captureTangent,
      anchorDistance: anchor,
      modelScale: requestedSize * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1),
    });
  } else {
    placement = computeWindowPlacement({
      captureTangent,
      anchorDistance: anchor,
      sizeScale: requestedSize,
      zoom,
    });
    const cap = photoSizeBudgetCap({
      baseline: requestedBaseline,
      clampPx: Number.isFinite(clampPx) ? clampPx : 0,
      eyeViewportWidthPx,
      aspect,
      windowHalfHeight: placement.windowHalfHeight,
      apex: placement.translation.z,
      anchorDistance: anchor,
      medianDepth: usableDepth(medianDepth) ? medianDepth : anchor,
    });
    if (requestedSize > cap) {
      // The floor, not the cap, when the two disagree: a size below one lifts
      // the anchor off the glass toward the eye, and the budget exists to keep
      // parallax bounded, not to push content through the window.
      const size = Math.max(cap, 1);
      placement = computeWindowPlacement({
        captureTangent,
        anchorDistance: anchor,
        sizeScale: size,
        zoom,
      });
    }
  }

  const stereoBaseline = stereoBaselineForPlacement({
    baseline,
    compression,
    clampPx,
    eyeViewportWidthPx,
    aspect,
    placement,
  });

  return { referenceDepth, pivotDistance, placement, stereoBaseline };
}

/**
 * How different two placements' visible fractions may be before switching
 * between them would read as a jump, as a fraction of the larger one.
 *
 * Below this the change is within what an ordinary head movement already
 * produces, and snapping is invisible; above it the switch is run as a short
 * continuous transition instead.
 */
export const PLACEMENT_TRANSITION_THRESHOLD = 0.1;

/**
 * Whether changing straight from one placement to another would be a visible
 * jump. Only the visible fraction is judged: pan and spin move every frame
 * already, and a scale change that leaves the visible fraction alone is
 * exactly the at-the-apex rescaling the window construction makes invisible.
 */
export function needsPlacementTransition(
  from: WindowPlacement | null,
  to: WindowPlacement | null,
  threshold: number = PLACEMENT_TRANSITION_THRESHOLD,
): boolean {
  if (!from || !to) return false;
  const a = from.visibleFraction;
  const b = to.visibleFraction;
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(b - a) / Math.max(a, b) > threshold;
}

/**
 * A placement part-way between two others.
 *
 * Scale-like quantities interpolate geometrically -- halfway between a window
 * twice as tall and one half as tall is the original, not three quarters --
 * and the translation interpolates linearly. The result is a real placement,
 * so anything derived from a placement, the stereo baseline included, can be
 * recomputed from it frame by frame and never exceeds what either endpoint
 * allowed.
 */
export function interpolatePlacement(
  from: WindowPlacement,
  to: WindowPlacement,
  t: number,
): WindowPlacement {
  const u = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1);
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const lerpLog = (a: number, b: number) => (a > 0 && b > 0
    ? Math.exp(lerp(Math.log(a), Math.log(b)))
    : lerp(a, b));
  return {
    scale: lerpLog(from.scale, to.scale),
    translation: {
      x: lerp(from.translation.x, to.translation.x),
      y: lerp(from.translation.y, to.translation.y),
      z: lerp(from.translation.z, to.translation.z),
    },
    windowHalfHeight: lerpLog(from.windowHalfHeight, to.windowHalfHeight),
    anchorDepth: lerp(from.anchorDepth, to.anchorDepth),
    visibleFraction: lerpLog(from.visibleFraction, to.visibleFraction),
  };
}

/**
 * Whether two placements are the same for every purpose the viewer has.
 *
 * Used to tell a retargeted transition ("keep going") from a new one. Relative
 * on the scale-like quantities, which span orders of magnitude, absolute on
 * the translation, which is in window units of order one.
 */
export function placementsEquivalent(
  a: WindowPlacement,
  b: WindowPlacement,
  epsilon = 1e-6,
): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= epsilon * Math.max(1, Math.abs(x), Math.abs(y));
  return close(a.scale, b.scale)
    && close(a.windowHalfHeight, b.windowHalfHeight)
    && close(a.visibleFraction, b.visibleFraction)
    && close(a.anchorDepth, b.anchorDepth)
    && close(a.translation.x, b.translation.x)
    && close(a.translation.y, b.translation.y)
    && close(a.translation.z, b.translation.z);
}

// Re-exported so callers of the budget see the whole vocabulary of the
// trade-off in one place: the pivot cap is part of the same constraint.
export { MAX_ORBIT_MAGNIFICATION };
