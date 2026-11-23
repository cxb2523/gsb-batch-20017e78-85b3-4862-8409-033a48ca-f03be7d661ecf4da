import { describe, expect, it } from 'vitest';

import { MAX_ORBIT_MAGNIFICATION, orbitPivotDistance } from '../camera-orbit';
import {
  FALLBACK_SCENE_DEPTH,
  PLACEMENT_TRANSITION_THRESHOLD,
  interpolatePlacement,
  needsPlacementTransition,
  placementsEquivalent,
  referenceSceneDepth,
  resolveParallaxBudget,
  stereoBaselineForPlacement,
} from '../parallax-budget';
import { computeWindowPlacement, type WindowPlacement } from '../window-placement';

// The measured scene the orbit bound was chosen for: nearest 1.20 units,
// median 57.83. Reused here because the budget must reproduce the bound, not
// reinvent it.
const MEASURED_NEAREST = 1.2;
const MEASURED_MEDIAN = 57.83;

const baseInput = {
  medianDepth: MEASURED_MEDIAN,
  nearestDepth: MEASURED_NEAREST,
  captureTangent: 0.4,
  anchorDistance: MEASURED_NEAREST,
  baseline: 0.12,
  compression: 1,
  clampPx: 10,
  eyeViewportWidthPx: 960,
  aspect: 0.46,
};

/** The background's separation, in pixels of one eye's viewport. */
function separationPx(baseline: number, placement: WindowPlacement, aspect: number, eyeWidthPx: number) {
  const halfWidth = placement.windowHalfHeight * aspect;
  return (baseline / halfWidth / 2) * eyeWidthPx;
}

describe('the shared reference depth', () => {
  it('is the nearest depth when that is usable', () => {
    expect(referenceSceneDepth(MEASURED_MEDIAN, MEASURED_NEAREST)).toBe(MEASURED_NEAREST);
  });

  it('falls back to the median for anything that is not a depth', () => {
    for (const nearest of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(referenceSceneDepth(12, nearest)).toBe(12);
    }
  });
});

describe('one budget across pivot, baseline and window scale', () => {
  it('bounds the pivot by the nearest depth exactly as the orbit rule does', () => {
    const budget = resolveParallaxBudget(baseInput);
    expect(budget.referenceDepth).toBe(MEASURED_NEAREST);
    expect(budget.pivotDistance).toBeLessThanOrEqual(MEASURED_NEAREST * MAX_ORBIT_MAGNIFICATION + 1e-12);
    expect(budget.pivotDistance).toBeLessThanOrEqual(MEASURED_MEDIAN);
    expect(budget.pivotDistance).toBe(orbitPivotDistance(MEASURED_MEDIAN, MEASURED_NEAREST));
  });

  it('clamps the stereo baseline against the placement it is returned with', () => {
    const budget = resolveParallaxBudget(baseInput);
    // The clamp is expressed in pixels of one eye's viewport, and it is the
    // placement's own window that the pixels are measured across.
    expect(separationPx(budget.stereoBaseline, budget.placement, baseInput.aspect, 960))
      .toBeLessThanOrEqual(baseInput.clampPx + 1e-9);
    // With this baseline the pixel clamp is the binding limit.
    expect(budget.stereoBaseline).toBeLessThan(baseInput.baseline);
  });

  it('lets compression win when it is the tighter of the two', () => {
    const budget = resolveParallaxBudget({ ...baseInput, compression: 0.1, clampPx: 10000 });
    expect(budget.stereoBaseline).toBeCloseTo(0.012, 12);
  });

  it('keeps the anchor on or behind the glass however hard the budget bites', () => {
    // A huge requested baseline against a tiny pixel allowance: the size cap
    // alone would shrink the miniature past the point where its anchor comes
    // through the glass, and the floor is what stops it.
    const budget = resolveParallaxBudget({
      ...baseInput, sizeScale: 3, clampPx: 2, baseline: 4,
    });
    expect(budget.placement.anchorDepth).toBeLessThanOrEqual(1e-9);
    // The anchor-on-glass floor is a size of one in photo mode.
    const onGlass = computeWindowPlacement({
      captureTangent: baseInput.captureTangent,
      anchorDistance: baseInput.anchorDistance,
      sizeScale: 1,
    });
    expect(budget.placement.scale).toBeCloseTo(onGlass.scale, 12);
  });

  it('caps the miniature size when the requested baseline would burst the budget', () => {
    // Median close enough to the anchor that the cap lands above the glass
    // floor: requested size 3, allowed 2.
    const input = {
      ...baseInput,
      medianDepth: 3,
      anchorDistance: 1.2,
      nearestDepth: 1.2,
      baseline: 0.05,
      clampPx: 40,
      eyeViewportWidthPx: 1000,
      aspect: 1,
      sizeScale: 3,
    };
    const budget = resolveParallaxBudget(input);
    const uncapped = computeWindowPlacement({
      captureTangent: input.captureTangent,
      anchorDistance: input.anchorDistance,
      sizeScale: 2,
    });
    expect(budget.placement.scale).toBeCloseTo(uncapped.scale, 9);
    expect(budget.placement.anchorDepth).toBeLessThanOrEqual(1e-9);
    // A request inside the cap is left alone.
    const inside = resolveParallaxBudget({ ...input, sizeScale: 1.5 });
    expect(inside.placement.scale).toBeCloseTo(
      computeWindowPlacement({
        captureTangent: input.captureTangent,
        anchorDistance: input.anchorDistance,
        sizeScale: 1.5,
      }).scale,
      12,
    );
  });

  it('leaves the placement alone when there is no pixel budget to spend', () => {
    const budget = resolveParallaxBudget({ ...baseInput, clampPx: 0, sizeScale: 2.5 });
    expect(budget.placement.scale).toBeCloseTo(
      computeWindowPlacement({
        captureTangent: baseInput.captureTangent,
        anchorDistance: baseInput.anchorDistance,
        sizeScale: 2.5,
      }).scale,
      12,
    );
  });

  it('never caps a True Window miniature, whose uniform scale changes no separation', () => {
    const budget = resolveParallaxBudget({
      ...baseInput, trueWindow: true, sizeScale: 2, baseline: 4, clampPx: 1,
    });
    expect(budget.placement.windowHalfHeight).toBe(1);
    expect(budget.placement.anchorDepth).toBeCloseTo(0, 12);
    const plain = resolveParallaxBudget({ ...baseInput, trueWindow: true, sizeScale: 2, clampPx: 0 });
    expect(budget.placement.scale).toBeCloseTo(plain.placement.scale, 12);
  });
});

describe('falling back when the nearest depth is missing or nonsense', () => {
  it('falls back to the median logic and never throws', () => {
    for (const nearest of [null, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = resolveParallaxBudget({ ...baseInput, nearestDepth: nearest });
      expect(budget.referenceDepth).toBe(MEASURED_MEDIAN);
      expect(budget.pivotDistance).toBe(MEASURED_MEDIAN);
      expect(Number.isFinite(budget.stereoBaseline)).toBe(true);
      expect(Number.isFinite(budget.placement.scale)).toBe(true);
    }
  });

  it('anchors on the reference depth when the anchor itself is unusable', () => {
    const budget = resolveParallaxBudget({ ...baseInput, anchorDistance: Number.NaN });
    expect(budget.placement.translation.z).toBeCloseTo(1 / baseInput.captureTangent, 12);
    expect(budget.placement.anchorDepth).toBeCloseTo(0, 9);
  });

  it('still answers when no depth can be measured at all', () => {
    const budget = resolveParallaxBudget({
      ...baseInput,
      medianDepth: Number.NaN,
      nearestDepth: null,
      anchorDistance: 0,
    });
    expect(budget.referenceDepth).toBe(FALLBACK_SCENE_DEPTH);
    expect(Number.isFinite(budget.placement.scale)).toBe(true);
  });
});

describe('the stereo baseline read off a placement', () => {
  const placement = computeWindowPlacement({
    captureTangent: 0.4, anchorDistance: 1.2, zoom: 2,
  });

  it('applies compression and the pixel clamp, the tighter winning', () => {
    const args = { baseline: 0.12, eyeViewportWidthPx: 960, aspect: 0.46, placement };
    expect(stereoBaselineForPlacement({ ...args, compression: 0.5, clampPx: 10000 }))
      .toBeCloseTo(0.06, 12);
    const clamped = stereoBaselineForPlacement({ ...args, compression: 1, clampPx: 10 });
    expect(separationPx(clamped, placement, 0.46, 960)).toBeCloseTo(10, 6);
    expect(stereoBaselineForPlacement({ ...args, compression: 0.01, clampPx: 10 }))
      .toBeCloseTo(0.0012, 12);
  });

  it('measures the clamp against the placement’s own window, so zoom moves the limit', () => {
    const zoomedOut = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.2, zoom: 0.5 });
    const zoomedIn = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.2, zoom: 2 });
    const args = { baseline: 0.12, compression: 1, clampPx: 10, eyeViewportWidthPx: 960, aspect: 0.46 };
    expect(stereoBaselineForPlacement({ ...args, placement: zoomedOut }))
      .toBeGreaterThan(stereoBaselineForPlacement({ ...args, placement: zoomedIn }));
  });
});

describe('switching modes without a visible jump', () => {
  const photo = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.97, zoom: 0.5 });
  const cropped = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.97, zoom: 2 });

  it('flags a change in visible fraction past the threshold, and only that', () => {
    expect(needsPlacementTransition(photo, cropped)).toBe(true);
    expect(needsPlacementTransition(cropped, photo)).toBe(true);
    const near = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.97, zoom: 1.05 });
    const whole = computeWindowPlacement({ captureTangent: 0.4, anchorDistance: 1.97 });
    expect(needsPlacementTransition(whole, near)).toBe(false);
    expect(needsPlacementTransition(null, photo)).toBe(false);
    // The threshold itself is what it says: a tenth of the larger fraction.
    expect(PLACEMENT_TRANSITION_THRESHOLD).toBeCloseTo(0.1, 12);
  });

  it('interpolates between the endpoints, geometrically on the scale-like quantities', () => {
    expect(interpolatePlacement(photo, cropped, 0)).toEqual(photo);
    expect(interpolatePlacement(photo, cropped, 1)).toEqual(cropped);
    const mid = interpolatePlacement(photo, cropped, 0.5);
    expect(mid.windowHalfHeight)
      .toBeCloseTo(Math.sqrt(photo.windowHalfHeight * cropped.windowHalfHeight), 12);
    expect(mid.scale).toBeCloseTo(Math.sqrt(photo.scale * cropped.scale), 12);
    expect(mid.translation.z).toBeCloseTo((photo.translation.z + cropped.translation.z) / 2, 12);
    // Out-of-range and nonsense times clamp rather than escaping the segment.
    expect(interpolatePlacement(photo, cropped, -1)).toEqual(photo);
    expect(interpolatePlacement(photo, cropped, 2)).toEqual(cropped);
    expect(interpolatePlacement(photo, cropped, Number.NaN)).toEqual(photo);
  });

  it('keeps every intermediate frame inside the pixel clamp when the baseline is recomputed', () => {
    // A baseline the zoomed-out window admits and the zoomed-in one does not.
    const aspect = 1;
    const eyeWidthPx = 1000;
    const clampPx = 20;
    const baseline = 0.05;
    expect(separationPx(baseline, photo, aspect, eyeWidthPx)).toBeLessThan(clampPx);
    // ...so a baseline carried unchanged across the switch would burst the
    // clamp at the far end, which is exactly the bug the recompute exists for.
    expect(separationPx(baseline, cropped, aspect, eyeWidthPx)).toBeGreaterThan(clampPx);

    for (let t = 0; t <= 1.0001; t += 0.125) {
      const frame = interpolatePlacement(photo, cropped, t);
      const frameBaseline = stereoBaselineForPlacement({
        baseline,
        compression: 1,
        clampPx,
        eyeViewportWidthPx: eyeWidthPx,
        aspect,
        placement: frame,
      });
      expect(separationPx(frameBaseline, frame, aspect, eyeWidthPx))
        .toBeLessThanOrEqual(clampPx + 1e-9);
    }
  });

  it('knows when two placements are the same, so a transition is not restarted', () => {
    expect(placementsEquivalent(photo, { ...photo })).toBe(true);
    expect(placementsEquivalent(photo, cropped)).toBe(false);
    expect(placementsEquivalent(photo, {
      ...photo, translation: { ...photo.translation, x: photo.translation.x + 1e-9 },
    })).toBe(true);
  });
});
