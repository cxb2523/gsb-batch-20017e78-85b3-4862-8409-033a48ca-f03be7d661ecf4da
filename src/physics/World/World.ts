/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Vec3 } from '../../math/vec3.js';
import { boxInBrush, createTraceResult, sweepBounds, traceBox, traceBoxCandidates } from '../Collision/Collision.js';
import type { Brush, LadderVolume, TraceResult } from '../Collision/Collision.types.js';
import { GRID_MIN_BRUSHES } from '../SpatialGrid/SpatialGrid.config.js';
import { SpatialGrid } from '../SpatialGrid/SpatialGrid.js';

export class World {
  solids: Brush[] = [];
  ladders: LadderVolume[] = [];

  private grid: SpatialGrid | null = null;
  /** Length of `solids` the current grid was built for. */
  private gridBrushCount = -1;
  /**
   * Invalidation version of the current grid. Bumped by rebuildIndex(); the
   * grid also goes stale implicitly when solids.length changes. This is what
   * makes in-place edits (mutating a brush's min/max, or swapping an entry)
   * observable: a version mismatch forces a rebuild on the next query.
   */
  private gridVersion = 0;
  private solidsVersion = 0;
  private readonly bounds = new Float64Array(6);

  /**
   * Drops the broadphase index and bumps its invalidation version. The next
   * trace/isPositionFree rebuilds against the current brushes, so call this
   * after editing an existing brush in place (moving its min/max, or swapping
   * an entry for another brush). Length changes are picked up automatically.
   */
  rebuildIndex(): void {
    this.grid = null;
    this.gridBrushCount = -1;
    this.solidsVersion++;
  }

  private index(): SpatialGrid | null {
    if (this.solids.length < GRID_MIN_BRUSHES) return null;
    if (this.grid === null || this.gridBrushCount !== this.solids.length || this.gridVersion !== this.solidsVersion) {
      this.grid = new SpatialGrid(this.solids);
      this.gridBrushCount = this.solids.length;
      this.gridVersion = this.solidsVersion;
    }
    return this.grid;
  }

  /** Pass `out` to reuse a result object instead of allocating one. */
  trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, out: TraceResult = createTraceResult()): TraceResult {
    const grid = this.index();
    if (grid !== null) {
      sweepBounds(start, end, mins, maxs, this.bounds);
      if (grid.query(this.bounds)) {
        return traceBoxCandidates(start, end, mins, maxs, this.solids, grid.ids, grid.count, this.bounds, out);
      }
    }
    return traceBox(start, end, mins, maxs, this.solids, out);
  }

  /** Can a hull of mins/maxs exist at origin without intersecting the world? */
  isPositionFree(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
    const grid = this.index();
    if (grid !== null) {
      sweepBounds(origin, origin, mins, maxs, this.bounds);
      if (grid.query(this.bounds)) {
        for (let i = 0; i < grid.count; i++) {
          if (boxInBrush(origin, mins, maxs, this.solids[grid.ids[i]])) return false;
        }
        return true;
      }
    }
    // Linear fallback: a cheap AABB reject first, as traceBox's broadphase does.
    const loX = origin.x + mins.x, hiX = origin.x + maxs.x;
    const loY = origin.y + mins.y, hiY = origin.y + maxs.y;
    const loZ = origin.z + mins.z, hiZ = origin.z + maxs.z;
    const solids = this.solids;
    for (let i = 0; i < solids.length; i++) {
      const brush = solids[i];
      if (
        brush.min.x > hiX || brush.max.x < loX ||
        brush.min.y > hiY || brush.max.y < loY ||
        brush.min.z > hiZ || brush.max.z < loZ
      ) {
        continue;
      }
      if (boxInBrush(origin, mins, maxs, brush)) return false;
    }
    return true;
  }

  ladderAt(origin: Vec3, mins: Vec3, maxs: Vec3): LadderVolume | null {
    for (const ladder of this.ladders) {
      if (boxInBrush(origin, mins, maxs, ladder)) return ladder;
    }
    return null;
  }
}
