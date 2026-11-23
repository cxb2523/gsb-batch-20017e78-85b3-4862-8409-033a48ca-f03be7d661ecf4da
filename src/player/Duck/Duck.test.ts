import { describe, expect, it } from 'vitest';
import { vec3 } from '../../math/vec3';
import { brushFromAABB } from '../../physics/Collision/Collision';
import { World } from '../../physics/World/World';
import { DEFAULT_SETTINGS } from '../../settings/Settings';
import { PlayerController } from '../PlayerController';
import { AIR_DUCK_ORIGIN_SHIFT, HULL_DUCK_HEIGHT, HULL_STAND_HEIGHT } from './Duck.config';
import { updateDuck, applyDuckHull } from './Duck';
import { DUCK_IN_SPEED_FACTOR, DUCK_SPEED_IDEAL, EYE_DUCK, EYE_STAND, TIME_BETWEEN_DUCKS } from './Duck.config';
import { currentMaxSpeed } from '../CurrentMaxSpeed/CurrentMaxSpeed';

const DT = 1 / 128;

// CCSGameMovement::FinishDuck/FinishUnDuck: on the ground the stand and duck
// hull mins are identical so nothing moves; in the air the feet move by half
// the hull-height difference (9u), up when ducking and back down when standing.

function airbornePlayer(world = new World()): PlayerController {
  return new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 500, 0));
}

describe('airborne duck origin shift', () => {
  it('is 9 units (half of 72 - 54)', () => {
    expect(AIR_DUCK_ORIGIN_SHIFT).toBe(9);
  });

  it('ducking in the air raises the feet by 9; standing again drops them by 9', () => {
    const p = airbornePlayer();
    p.input.duck = true;
    updateDuck(p, DT);
    expect(p.ducked).toBe(true);
    expect(p.origin.y).toBe(509);

    p.input.duck = false;
    updateDuck(p, DT);
    expect(p.ducked).toBe(false);
    expect(p.origin.y).toBe(500);
  });

  it('does not move the origin when ducking or standing on the ground', () => {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-512, -16, -512), vec3(512, 0, 512)));
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    p.onGround = true;
    p.input.duck = true;
    for (let i = 0; i < 40; i++) updateDuck(p, DT);
    expect(p.ducked).toBe(true);
    expect(p.origin.y).toBe(0.03125);
    p.input.duck = false;
    for (let i = 0; i < 40; i++) updateDuck(p, DT);
    expect(p.ducked).toBe(false);
    expect(p.origin.y).toBe(0.03125);
  });

  it('refuses to stand in the air when the standing hull cannot sweep down 9u', () => {
    const world = new World();
    // Ceiling-free, but a floor 5u under the ducked feet blocks the standing hull's 9u drop.
    world.solids.push(brushFromAABB(vec3(-512, 490, -512), vec3(512, 504, 512)));
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 505, 0));
    p.ducked = true;
    p.duckFrac = 1;
    p.duckFlag = true;
    p.input.duck = false;
    updateDuck(p, DT);
    expect(p.ducked).toBe(true);
    expect(p.origin.y).toBe(505);
  });

  it('refuses to stand on the ground under a low ceiling', () => {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-512, -16, -512), vec3(512, 0, 512)));
    world.solids.push(brushFromAABB(vec3(-512, 60, -512), vec3(512, 80, 512)));
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    p.onGround = true;
    p.ducked = true;
    p.duckFrac = 1;
    p.duckFlag = true;
    p.input.duck = false;
    updateDuck(p, DT);
    expect(p.ducked).toBe(true);
  });
});

function groundPlayer(): PlayerController {
  const world = new World();
  world.solids.push(brushFromAABB(vec3(-512, -16, -512), vec3(512, 0, 512)));
  const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
  p.onGround = true;
  return p;
}

describe('timed ground duck (CCSGameMovement::Duck)', () => {
  it('ramps the duck amount at duckSpeed * 0.8 per second and switches hull on arrival', () => {
    const p = groundPlayer();
    p.input.duck = true;
    updateDuck(p, DT);
    // The key press costs 2 duck speed (CheckParameters), then Duck() recovers 3/s of it.
    expect(p.duckFrac).toBeCloseTo((DUCK_SPEED_IDEAL - 2 + 3 * DT) * DUCK_IN_SPEED_FACTOR * DT, 6);
    expect(p.ducked).toBe(false); // hull stays standing mid-transition

    let ticks = 1;
    while (!p.ducked && ticks < 400) {
      updateDuck(p, DT);
      ticks++;
    }
    expect(p.ducked).toBe(true);
    expect(p.duckFrac).toBe(1);
    expect(ticks).toBeGreaterThan(20); // not instant
  });

  it('eases the max-speed crop in with the duck amount', () => {
    const p = groundPlayer();
    p.duckHeld = true;
    p.ducking = true;
    p.duckFrac = 0.5;
    const full = DEFAULT_SETTINGS.crouchSpeed / DEFAULT_SETTINGS.runSpeed;
    expect(currentMaxSpeed(p)).toBeCloseTo(DEFAULT_SETTINGS.runSpeed * (full * 0.5 + 0.5), 6);
    p.duckFrac = 1;
    p.ducked = true;
    expect(currentMaxSpeed(p)).toBeCloseTo(DEFAULT_SETTINGS.crouchSpeed, 6);
  });

  it('ignores the duck key once mashing has spent the duck speed', () => {
    const p = groundPlayer();
    // Every raw press/release costs 2 of the 8 duck speed.
    for (let i = 0; i < 6; i++) {
      p.input.duck = !p.input.duck;
      updateDuck(p, DT);
    }
    expect(p.duckSpeed).toBeLessThan(1.5);
    p.input.duck = true;
    updateDuck(p, DT);
    expect(p.duckHeld).toBe(false);
  });

  it(`refuses to start a duck within ${TIME_BETWEEN_DUCKS}s of the last finished one`, () => {
    const p = groundPlayer();
    p.lastDuckTime = p.time;
    p.input.duck = true;
    updateDuck(p, DT);
    expect(p.duckHeld).toBe(false);
    p.time += TIME_BETWEEN_DUCKS;
    updateDuck(p, DT);
    expect(p.duckHeld).toBe(true);
  });
});

describe('continuous duck-transition hull', () => {
  it('interpolates the collision hull head height with duckFrac, with no jump on the ducked flip', () => {
    const p = groundPlayer();
    p.input.duck = true;

    // Snapshot the first tick that lands strictly inside the transition.
    let midFrac = 0;
    let midHeight = 0;
    let wasDuckedAtMid = true;
    for (let i = 0; i < 400 && !p.ducked; i++) {
      updateDuck(p, DT);
      if (p.duckFrac > 0 && p.duckFrac < 1 && midFrac === 0) {
        midFrac = p.duckFrac;
        midHeight = p.maxs.y;
        wasDuckedAtMid = p.ducked;
      }
    }
    expect(midFrac).toBeGreaterThan(0);

    // Mid-transition the hull head height is strictly between stand and duck
    // heights and tracks the duck amount linearly.
    expect(midHeight).toBeGreaterThan(HULL_DUCK_HEIGHT);
    expect(midHeight).toBeLessThan(HULL_STAND_HEIGHT);
    expect(midHeight).toBeCloseTo(HULL_STAND_HEIGHT + (HULL_DUCK_HEIGHT - HULL_STAND_HEIGHT) * midFrac, 6);
    // Before the flip the hull was already partway down — not the old
    // standing hull waiting for `ducked` to change.
    expect(wasDuckedAtMid).toBe(false);

    expect(p.duckFrac).toBe(1);
    expect(p.maxs.y).toBe(HULL_DUCK_HEIGHT);
  });

  it('varies the hull head height monotonically through stand -> duck -> stand, in sync with the eye', () => {
    const p = groundPlayer();

    const heights: number[] = [];
    const eyes: number[] = [];
    const fracs: number[] = [];

    p.input.duck = true;
    for (let i = 0; i < 400 && p.duckFrac < 1; i++) {
      updateDuck(p, DT);
      heights.push(p.maxs.y);
      eyes.push(p.eyeHeight);
      fracs.push(p.duckFrac);
    }
    expect(p.ducked).toBe(true);

    p.input.duck = false;
    for (let i = 0; i < 400 && p.duckFrac > 0; i++) {
      updateDuck(p, DT);
      heights.push(p.maxs.y);
      eyes.push(p.eyeHeight);
      fracs.push(p.duckFrac);
    }
    expect(p.ducked).toBe(false);
    expect(p.maxs.y).toBe(HULL_STAND_HEIGHT);

    // Every recorded tick's hull matches the fraction exactly.
    for (let i = 0; i < heights.length; i++) {
      expect(heights[i]).toBeCloseTo(HULL_STAND_HEIGHT + (HULL_DUCK_HEIGHT - HULL_STAND_HEIGHT) * fracs[i], 6);
    }

    // Down then up: strictly monotonic on each leg, never a discrete jump.
    const peak = Math.max(...heights);
    const min = Math.min(...heights);
    const turn = heights.indexOf(min);
    expect(peak).toBe(HULL_STAND_HEIGHT);
    expect(min).toBe(HULL_DUCK_HEIGHT);
    for (let i = 1; i <= turn; i++) expect(heights[i]).toBeLessThanOrEqual(heights[i - 1]);
    for (let i = turn + 1; i < heights.length; i++) expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
    const largestStep = Math.max(...heights.map((h, i) => (i === 0 ? 0 : Math.abs(h - heights[i - 1]))));
    expect(largestStep).toBeLessThan(HULL_STAND_HEIGHT - HULL_DUCK_HEIGHT); // no full 18u jump in one tick

    // The eye height moves with the hull on the same schedule (monotonic,
    // bounded by its stand/duck offsets).
    expect(eyes[0]).toBeLessThan(EYE_STAND);
    for (let i = 1; i <= turn; i++) expect(eyes[i]).toBeLessThanOrEqual(eyes[i - 1]);
    for (let i = turn + 1; i < eyes.length; i++) expect(eyes[i]).toBeGreaterThanOrEqual(eyes[i - 1]);
    expect(Math.min(...eyes)).toBeCloseTo(EYE_DUCK, 6);
    expect(p.eyeHeight).toBeCloseTo(EYE_STAND, 6);
  });

  function lowCeilingWorld(ceilingBottom: number): World {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-512, -16, -512), vec3(512, 0, 512)));
    world.solids.push(brushFromAABB(vec3(-512, ceilingBottom, -512), vec3(512, ceilingBottom + 32, 512)));
    return world;
  }

  it('never embeds the player while ducking under a ceiling that only fits the ducked hull', () => {
    // Duck fully while the ceiling is still high, then drop it to 58: the
    // standing 72 hull never fits there, the ducked 54 hull does. A standing
    // player could never be under that ceiling in the first place.
    const world = lowCeilingWorld(128);
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    p.onGround = true;
    p.input.duck = true;
    for (let i = 0; i < 200; i++) updateDuck(p, DT);
    expect(p.ducked).toBe(true);

    world.solids[1] = brushFromAABB(vec3(-512, 58, -512), vec3(512, 90, 512));

    // Keep holding/releasing the key under the low ceiling: every hull the
    // transition can produce must stay out of solid.
    for (let i = 0; i < 256; i++) {
      p.input.duck = i % 64 < 32;
      updateDuck(p, DT);
      expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
    }
    expect(p.maxs.y).toBe(HULL_DUCK_HEIGHT);
    expect(p.origin.y).toBe(0.03125); // no origin drift on the ground
  });

  it('grows the hull through every intermediate height, all free, when unducking under a just-fitting ceiling', () => {
    // 60 clearance: the fully ducked hull (54) fits, but the standing hull
    // (72) does not, so the unduck must be refused; while the ceiling stays,
    // the hull never crosses into solid.
    const world = lowCeilingWorld(128);
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    p.onGround = true;
    p.input.duck = true;
    for (let i = 0; i < 200; i++) updateDuck(p, DT);
    expect(p.ducked).toBe(true);

    world.solids[1] = brushFromAABB(vec3(-512, 60, -512), vec3(512, 92, 512));
    p.input.duck = false;
    for (let i = 0; i < 256; i++) {
      updateDuck(p, DT);
      expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
    }
    expect(p.ducked).toBe(true);
    expect(p.duckFrac).toBe(1);

    // Open the ceiling up fully: the unduck now runs, every intermediate
    // hull remaining collision-free.
    world.solids.length = 1;
    const heights: number[] = [];
    for (let i = 0; i < 400 && p.duckFrac > 0; i++) {
      updateDuck(p, DT);
      expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
      heights.push(p.maxs.y);
    }
    expect(p.ducked).toBe(false);
    expect(p.duckFrac).toBe(0);
    expect(p.maxs.y).toBe(HULL_STAND_HEIGHT);
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
  });

  it('cannot enter a stuck solid state under a low ceiling and stands back up once the ceiling is gone', () => {
    const world = lowCeilingWorld(58);
    const p = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    p.onGround = true;
    p.ducked = true;
    p.ducking = false;
    p.duckFlag = true;
    p.duckFrac = 1;
    applyDuckHull(p); // resync the hull to the forced fully-ducked state
    expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);

    // Releasing the key under the ceiling must not grow the hull into solid:
    // the unduck is refused and the player stays fully ducked.
    p.input.duck = false;
    for (let i = 0; i < 128; i++) {
      updateDuck(p, DT);
      expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
    }
    expect(p.ducked).toBe(true);
    expect(p.duckFrac).toBe(1);
    expect(p.maxs.y).toBe(HULL_DUCK_HEIGHT);

    // Remove the ceiling: the released key now lets the unduck complete.
    world.solids.length = 1;
    for (let i = 0; i < 400 && p.duckFrac > 0; i++) {
      updateDuck(p, DT);
      expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
    }
    expect(p.ducked).toBe(false);
    expect(p.duckFrac).toBe(0);
    expect(p.maxs.y).toBe(HULL_STAND_HEIGHT);
    expect(world.isPositionFree(p.origin, p.mins, p.maxs)).toBe(true);
  });

  it('keeps every intermediate hull free of solid across a full tick-level duck/unduck cycle', () => {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-512, -16, -512), vec3(512, 0, 512)));
    const player = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(0, 0.03125, 0));
    player.onGround = true;

    player.input.duck = true;
    for (let i = 0; i < 256; i++) player.tick(DT);
    expect(player.ducked).toBe(true);

    player.input.duck = false;
    for (let i = 0; i < 256; i++) {
      player.tick(DT);
      expect(world.isPositionFree(player.origin, player.mins, player.maxs)).toBe(true);
    }
    expect(player.ducked).toBe(false);
    expect(player.maxs.y).toBe(HULL_STAND_HEIGHT);
  });
});

