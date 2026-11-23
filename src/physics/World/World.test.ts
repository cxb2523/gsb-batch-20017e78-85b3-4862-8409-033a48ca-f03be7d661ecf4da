import { describe, expect, it } from 'vitest';
import { vec3, type Vec3 } from '../../math/vec3';
import { brushFromAABB, brushFromOrientedBox, traceBox } from '../Collision/Collision';
import type { LadderVolume } from '../Collision/Collision.types';
import { GRID_MIN_BRUSHES } from '../SpatialGrid/SpatialGrid.config';
import { World } from './World';

const MINS = vec3(-16, 0, -16);
const MAXS = vec3(16, 72, 16);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function scatteredWorld(count: number, seed: number): World {
  const rand = lcg(seed);
  const world = new World();
  world.solids.push(brushFromAABB(vec3(-4000, -16, -4000), vec3(4000, 0, 4000))); // oversized: never binned
  for (let i = 0; i < count; i++) {
    const cx = (rand() * 2 - 1) * 1500;
    const cz = (rand() * 2 - 1) * 1500;
    if (rand() < 0.4) {
      const t = 0.3 + rand() * 0.6;
      const c = Math.sqrt(1 - t * t);
      world.solids.push(
        brushFromOrientedBox(vec3(cx, 60 + rand() * 60, cz), vec3(90, 6, 90), vec3(1, 0, 0), vec3(0, c, t), vec3(0, -t, c)),
      );
    } else {
      const w = 16 + rand() * 90;
      world.solids.push(brushFromAABB(vec3(cx - w, 0, cz - w), vec3(cx + w, 8 + rand() * 60, cz + w)));
    }
  }
  return world;
}

function randomPoint(rand: () => number): ReturnType<typeof vec3> {
  return vec3((rand() * 2 - 1) * 1600, rand() * 160, (rand() * 2 - 1) * 1600);
}

describe('World spatial index', () => {
  it('indexes only above the brush-count threshold', () => {
    expect(GRID_MIN_BRUSHES).toBeGreaterThan(1);
  });

  it('traces identically to a linear scan of every brush', () => {
    const world = scatteredWorld(400, 7);
    const rand = lcg(99);
    for (let i = 0; i < 3000; i++) {
      const start = randomPoint(rand);
      const long = rand() < 0.1; // a few sweeps wide enough to hit the linear fallback
      const reach = long ? 3000 : 120;
      const end = vec3(start.x + (rand() * 2 - 1) * reach, start.y + (rand() * 2 - 1) * 120, start.z + (rand() * 2 - 1) * reach);
      const indexed = world.trace(start, end, MINS, MAXS);
      const linear = traceBox(start, end, MINS, MAXS, world.solids);
      expect(indexed).toEqual(linear);
      expect(indexed.normal).toBe(linear.normal); // same plane object, not just an equal one
    }
  });

  it('isPositionFree matches a linear startSolid check', () => {
    const world = scatteredWorld(400, 11);
    const rand = lcg(5);
    let blocked = 0;
    for (let i = 0; i < 3000; i++) {
      const p = randomPoint(rand);
      const expected = !traceBox(p, p, MINS, MAXS, world.solids).startSolid;
      if (!expected) blocked++;
      expect(world.isPositionFree(p, MINS, MAXS)).toBe(expected);
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('picks up brushes pushed after the first query', () => {
    const world = scatteredWorld(200, 3);
    const start = vec3(0, 200, 0);
    const end = vec3(0, 100, 0);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBe(1);
    world.solids.push(brushFromAABB(vec3(-50, 120, -50), vec3(50, 140, 50)));
    expect(world.trace(start, end, MINS, MAXS).fraction).toBeLessThan(1);
  });

  it('rebuildIndex picks up in-place brush edits', () => {
    const world = scatteredWorld(200, 3);
    const start = vec3(0, 200, 0);
    const end = vec3(0, 100, 0);
    const slab = brushFromAABB(vec3(5000, 120, 5000), vec3(5100, 140, 5100));
    world.solids.push(slab);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBe(1);
    const moved = brushFromAABB(vec3(-50, 120, -50), vec3(50, 140, 50));
    world.solids[world.solids.length - 1] = moved;
    world.rebuildIndex();
    expect(world.trace(start, end, MINS, MAXS).fraction).toBeLessThan(1);
  });

  // -- In-place invalidation: indexed vs. linear must agree after rebuild ---

  /** A world large enough that the grid path is actually taken. */
  function indexedWorld(): World {
    const world = scatteredWorld(GRID_MIN_BRUSHES + 20, 23);
    expect(world.solids.length).toBeGreaterThanOrEqual(GRID_MIN_BRUSHES);
    // Prime the index so later edits are true in-place mutations of an
    // already-built grid.
    world.trace(vec3(0, 400, 0), vec3(0, 300, 0), MINS, MAXS);
    return world;
  }

  /** Index of the first axis-aligned brush other than the oversized floor at 0. */
  function aabbBrushIndex(world: World): number {
    for (let i = 1; i < world.solids.length; i++) {
      const axisAligned = world.solids[i].planes.every(
        (p) => Math.abs(p.normal.x) === 1 || Math.abs(p.normal.y) === 1 || Math.abs(p.normal.z) === 1,
      );
      if (axisAligned) return i;
    }
    throw new Error('no AABB brush in world');
  }

  function expectIndexedMatchesLinear(world: World, start: Vec3, end: Vec3, probe: Vec3): void {
    const indexed = world.trace(start, end, MINS, MAXS);
    const linear = traceBox(start, end, MINS, MAXS, world.solids);
    expect(indexed).toEqual(linear);
    expect(indexed.normal).toBe(linear.normal); // same plane object, not just an equal one
    const expectedFree = !traceBox(probe, probe, MINS, MAXS, world.solids).startSolid;
    expect(world.isPositionFree(probe, MINS, MAXS)).toBe(expectedFree);
  }

  it('trace and isPositionFree through the index match the linear path after an in-place brush move + rebuildIndex', () => {
    const world = indexedWorld();
    const start = vec3(0, 200, 0);
    const end = vec3(0, 100, 0);
    const probe = vec3(0, 130, 0);

    // Far away: nothing on the segment or at the probe.
    expectIndexedMatchesLinear(world, start, end, probe);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBe(1);

    // Move an existing brush onto the segment in place: relocate its AABB
    // (min/max) together with the planes that define the solid.
    const brush = world.solids[aabbBrushIndex(world)];
    const moved = brushFromAABB(vec3(-40, 120, -40), vec3(40, 140, 40));
    brush.planes = moved.planes;
    brush.min = moved.min;
    brush.max = moved.max;
    expect(world.solids.length).toBeGreaterThanOrEqual(GRID_MIN_BRUSHES);

    // Length unchanged and no rebuild yet: queries must still behave (stale
    // index allowed, but no crash) while the linear path sees the edit.
    expect(() => world.trace(start, end, MINS, MAXS)).not.toThrow();
    expect(() => world.isPositionFree(probe, MINS, MAXS)).not.toThrow();
    expect(traceBox(start, end, MINS, MAXS, world.solids).fraction).toBeLessThan(1);
    expect(traceBox(probe, probe, MINS, MAXS, world.solids).startSolid).toBe(true);

    world.rebuildIndex();

    // The index must now observe the moved brush: hit fraction and the
    // isPositionFree verdict both agree with a full linear scan.
    expectIndexedMatchesLinear(world, start, end, probe);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBeLessThan(1);
    expect(world.isPositionFree(probe, MINS, MAXS)).toBe(false);
  });

  it('stays consistent when only an AABB brush min/max are mutated and the index is rebuilt', () => {
    // Narrowphase planes are untouched, so the trace cannot gain a new hit —
    // but the broadphase AABBs changed, so after rebuildIndex the indexed and
    // linear paths must still return identical verdicts on a batch of probes.
    const world = indexedWorld();
    const rand = lcg(77);
    const brush = world.solids[aabbBrushIndex(world)];
    brush.min.x += 120; brush.min.y += 5; brush.min.z -= 90;
    brush.max.x -= 60; brush.max.y += 30; brush.max.z += 110;
    world.rebuildIndex();

    for (let i = 0; i < 500; i++) {
      const p = vec3((rand() * 2 - 1) * 1600, rand() * 200, (rand() * 2 - 1) * 1600);
      const end = vec3(p.x + (rand() * 2 - 1) * 200, p.y + (rand() * 2 - 1) * 120, p.z + (rand() * 2 - 1) * 200);
      expectIndexedMatchesLinear(world, p, end, p);
    }
  });

  it('agrees with the linear path after a same-length entry replacement + rebuildIndex', () => {
    const world = indexedWorld();
    const start = vec3(300, 250, -300);
    const end = vec3(300, 50, -300);
    const probe = vec3(300, 130, -300);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBe(1);

    const replacement = brushFromAABB(vec3(260, 100, -340), vec3(340, 160, -260));
    const index = world.solids.length - 2;
    world.solids[index] = replacement; // swap, no length change
    world.rebuildIndex();

    expectIndexedMatchesLinear(world, start, end, probe);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBeLessThan(1);
  });

  it('agrees with the linear path after a length change without an explicit rebuildIndex', () => {
    const world = indexedWorld();
    const start = vec3(-250, 300, 250);
    const end = vec3(-250, 50, 250);
    const probe = vec3(-250, 150, 250);

    world.solids.push(brushFromAABB(vec3(-290, 120, 210), vec3(-210, 180, 290)));
    expect(world.solids.length).toBeGreaterThanOrEqual(GRID_MIN_BRUSHES);
    // No rebuildIndex call: the length change alone must invalidate.
    expectIndexedMatchesLinear(world, start, end, probe);
    expect(world.trace(start, end, MINS, MAXS).fraction).toBeLessThan(1);
  });

  it('keeps serving valid results from a stale index when length is unchanged and rebuildIndex is skipped', () => {
    const world = indexedWorld();
    const brush = world.solids[aabbBrushIndex(world)];
    const moved = brushFromAABB(vec3(700, 120, 700), vec3(780, 140, 780));
    brush.planes = moved.planes;
    brush.min = moved.min;
    brush.max = moved.max;

    // The contract here is only "do not crash": the stale grid may miss the
    // edit, but every call still returns a well-formed result.
    const tr = world.trace(vec3(0, 200, 0), vec3(0, 100, 0), MINS, MAXS);
    expect(tr.fraction).toBeGreaterThanOrEqual(0);
    expect(tr.fraction).toBeLessThanOrEqual(1);
    expect(typeof world.isPositionFree(vec3(0, 130, 0), MINS, MAXS)).toBe('boolean');

    // Rebuilding restores agreement with the linear path.
    world.rebuildIndex();
    expectIndexedMatchesLinear(world, vec3(0, 200, 0), vec3(0, 100, 0), vec3(740, 130, 740));
    expect(world.isPositionFree(vec3(740, 130, 740), MINS, MAXS)).toBe(false);
  });

  it('leaves ladder queries untouched by index invalidation', () => {
    const world = indexedWorld();
    const volume: LadderVolume = {
      ...brushFromAABB(vec3(60, 0, -24), vec3(100, 300, 24)),
      facing: vec3(-1, 0, 0),
    };
    world.ladders.push(volume);

    // Mutate a solid and rebuild: ladderAt reads the ladders list only, so
    // the ladder is found regardless of the solids index state.
    world.solids[3].max.y += 200;
    world.rebuildIndex();
    expect(world.ladderAt(vec3(80, 50, 0), MINS, MAXS)).toBe(volume);
    expect(world.ladderAt(vec3(0, 50, 0), MINS, MAXS)).toBeNull();
  });

  it('reuses a caller-provided result object', () => {
    const world = scatteredWorld(100, 1);
    const out = world.trace(vec3(0, 50, 0), vec3(0, -50, 0), MINS, MAXS);
    expect(world.trace(vec3(0, 50, 0), vec3(0, -50, 0), MINS, MAXS, out)).toBe(out);
  });
});
