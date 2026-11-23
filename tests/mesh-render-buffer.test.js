import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshRendererAdapter } from '../js/geometry/MeshRendererAdapter.js';
import { ShadingUtils } from '../js/utils/ShadingUtils.js';
import {
  buildMeshData,
  buildGeometry,
  editorDeleteFace,
  faceNormalOf,
  readNormal,
  readPosition,
  readUV,
  readIndex,
  assertNoViolations,
  approxEqualVec,
} from './helpers/meshTestUtils.js';

// 3x2 grid of quads (6 vertices, 2 faces sharing edge v2-v3):
//
//   v0 ---- v2 ---- v4      y=1
//   |  f0   |  f1   |
//   v1 ---- v3 ---- v5      y=0
//
const GRID_POINTS = [
  [0, 1, 0], // v0
  [0, 0, 0], // v1
  [1, 1, 0], // v2
  [1, 0, 0], // v3
  [2, 1, 0], // v4
  [2, 0, 0], // v5
];
const GRID_FACES = [
  [0, 1, 3, 2], // f0
  [2, 3, 5, 4], // f1
];

function makeGrid(options = { mode: 'auto', angle: 60 }) {
  const { meshData, verts } = buildMeshData(GRID_POINTS, GRID_FACES);
  const { geometry, renderBuffer } = buildGeometry(meshData, options);
  return { meshData, verts, geometry, renderBuffer };
}

describe('slot reuse after deleteFace', () => {
  let env;
  beforeEach(() => { env = makeGrid(); });

  test('deleteFace frees contiguous vertex and index slots and clears all face entries', () => {
    const { meshData, geometry, renderBuffer } = env;
    const face0Slots = [...renderBuffer.faceIdToBufferIndices.get(0)];
    const triOffset = renderBuffer.faceTriangleOffset.get(0);
    const triCount = renderBuffer.faceTriangleCount.get(0);

    const usedVBefore = renderBuffer.slotAllocator.usedCount;
    const usedIBefore = renderBuffer.indexSlotAllocator.usedCount;

    editorDeleteFace(meshData, renderBuffer, geometry, 0);

    assert.equal(renderBuffer.faceIdToBufferIndices.has(0), false);
    assert.equal(renderBuffer.faceTriangleOffset.has(0), false);
    assert.equal(renderBuffer.faceTriangleCount.has(0), false);

    // Vertex slots of face 0 (v0,v1 are unique to f0; v2,v3 shared with f1)
    for (const slot of face0Slots) {
      assert.equal(renderBuffer.bufferIndexToVertexId.has(slot), false,
        `slot ${slot} still mapped after delete`);
    }
    assert.equal(renderBuffer.vertexIdToBufferIndex.has(0), false);
    assert.equal(renderBuffer.vertexIdToBufferIndex.has(1), false);
    // Shared vertices keep their f1 corner slots
    assert.equal(renderBuffer.vertexIdToBufferIndex.has(2), true);
    assert.equal(renderBuffer.vertexIdToBufferIndex.has(3), true);

    // Allocator state
    assert.equal(renderBuffer.slotAllocator.usedCount, usedVBefore - 4);
    assert.equal(renderBuffer.indexSlotAllocator.usedCount, usedIBefore - triCount);
    const freeStarts = renderBuffer.slotAllocator.freeBlocks.map(b => b.start);
    assert.ok(freeStarts.includes(face0Slots[0]), 'freed vertex block is available');
    const freeIndexStarts = renderBuffer.indexSlotAllocator.freeBlocks.map(b => b.start);
    assert.ok(freeIndexStarts.includes(triOffset), 'freed index block is available');

    // Deleted triangles are degenerate (all three indices identical)
    for (let i = 0; i < triCount; i += 3) {
      const a = readIndex(geometry, triOffset + i);
      const b = readIndex(geometry, triOffset + i + 1);
      const c = readIndex(geometry, triOffset + i + 2);
      assert.equal(a, b);
      assert.equal(b, c);
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('addFace reuses freed vertex slots with fresh position/uv/normal, no stale data', () => {
    const { meshData, geometry, renderBuffer } = env;
    const oldSlots = [...renderBuffer.faceIdToBufferIndices.get(0)];
    const oldPositions = oldSlots.map(s => readPosition(geometry, s).clone());
    const oldNormals = oldSlots.map(s => readNormal(geometry, s).clone());

    editorDeleteFace(meshData, renderBuffer, geometry, 0);

    // New face at different coordinates (shifted up in z and x), same 4 verts
    // plus a brand-new vertex so the face key differs.
    const vNew = meshData.addVertex(new THREE.Vector3(9, 9, 9));
    const newFace = meshData.addFace([
      meshData.vertices.get(0),
      meshData.vertices.get(1),
      meshData.vertices.get(3),
      vNew,
    ]);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, newFace.id);

    const newSlots = renderBuffer.faceIdToBufferIndices.get(newFace.id);
    assert.equal(newSlots.length, 4);

    // First-fit allocation must hand back the freed block start
    assert.equal(newSlots[0], oldSlots[0],
      'new face should reuse the freed vertex slot block');

    // No dangling references: every new slot maps to the new face's vertices
    const expectedIds = newFace.vertexIds;
    newSlots.forEach((slot, i) => {
      assert.equal(renderBuffer.bufferIndexToVertexId.get(slot), expectedIds[i]);
      assert.deepEqual(
        renderBuffer.vertexIdToBufferIndex.get(expectedIds[i]).includes(slot), true
      );
    });

    // Position data in reused slots matches the new occupant, not old face
    newSlots.forEach((slot, i) => {
      const v = meshData.vertices.get(expectedIds[i]);
      const p = readPosition(geometry, slot);
      assert.ok(approxEqualVec(p, v.position),
        `slot ${slot} position is stale`);
    });

    // The slot occupied by vNew definitely never held that vertex before:
    // its position must be exactly (9,9,9), not any old grid coordinate.
    const vNewSlot = newSlots[3];
    assert.deepEqual(readPosition(geometry, vNewSlot).toArray(), [9, 9, 9]);
    const wasOldSlot = oldSlots.includes(vNewSlot);
    if (wasOldSlot) {
      assert.ok(!approxEqualVec(readPosition(geometry, vNewSlot), oldPositions[3]));
    }

    // UVs are rewritten (defaults to 0,0 here)
    for (const slot of newSlots) {
      assert.deepEqual(readUV(geometry, slot), [0, 0]);
    }

    // Normals at reused slots follow the new face, not the previous occupant.
    // The new face is tilted out of the XY plane (its normal differs from the
    // old (0,0,1)); with the old topology face gone, its unique vertices each
    // belong to one face and must resolve exactly to the new face normal.
    const newFaceNormal = faceNormalOf(meshData, newFace.id);
    assert.ok(!approxEqualVec(newFaceNormal, new THREE.Vector3(0, 0, 1), 1e-4),
      'fixture: new face must be tilted relative to the deleted one');
    for (let i = 0; i < newSlots.length; i++) {
      const n = readNormal(geometry, newSlots[i]);
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z));
      assert.ok(Math.abs(n.length() - 1) < 1e-4, `normal not unit: ${n.length()}`);
      assert.ok(approxEqualVec(n, newFaceNormal, 1e-4),
        `reused slot ${newSlots[i]} kept the old face normal instead of the new one`);
      assert.ok(!approxEqualVec(n, oldNormals[i], 1e-4),
        'stale normal from previous face occupant');
    }

    // Old face id never comes back
    assert.equal(renderBuffer.faceIdToBufferIndices.has(0), false);
    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('addVertex reuses a freed standalone slot and writes a fresh normal', () => {
    const { meshData, geometry, renderBuffer } = env;

    // Add then delete a standalone vertex to create a 1-slot hole
    const lone = meshData.addVertex(new THREE.Vector3(5, 5, 5));
    MeshRendererAdapter.addVertex(meshData, renderBuffer, geometry, lone.id);
    const loneSlot = renderBuffer.vertexIdToBufferIndex.get(lone.id)[0];
    MeshRendererAdapter.deleteVertex(meshData, renderBuffer, geometry, lone.id);
    meshData.deleteVertex(lone);
    assert.equal(renderBuffer.bufferIndexToVertexId.has(loneSlot), false);

    const next = meshData.addVertex(new THREE.Vector3(7, -2, 3));
    MeshRendererAdapter.addVertex(meshData, renderBuffer, geometry, next.id);
    const nextSlot = renderBuffer.vertexIdToBufferIndex.get(next.id)[0];

    assert.equal(nextSlot, loneSlot, 'standalone addVertex must reuse the freed slot');
    assert.deepEqual(readPosition(geometry, nextSlot).toArray(), [7, -2, 3]);
    assert.deepEqual(readNormal(geometry, nextSlot).toArray(), [0, 1, 0]);
    assert.equal(renderBuffer.bufferIndexToVertexId.get(nextSlot), next.id);

    assertNoViolations(meshData, geometry, renderBuffer);
  });
});

describe('buffer growth and allocator sync', () => {
  test('vertex buffer growth registers new slots and keeps capacity in sync', () => {
    const { meshData, geometry, renderBuffer } = makeGrid();
    const capacityBefore = renderBuffer.slotAllocator.capacity;

    // Exhaust free capacity with standalone vertices
    let created = 0;
    while (renderBuffer.slotAllocator.usedCount < capacityBefore) {
      const v = meshData.addVertex(new THREE.Vector3(created, 20, 0));
      MeshRendererAdapter.addVertex(meshData, renderBuffer, geometry, v.id);
      created++;
    }
    assert.equal(renderBuffer.slotAllocator.usedCount, capacityBefore);

    // One more forces a grow
    const overflow = meshData.addVertex(new THREE.Vector3(30, 30, 30));
    MeshRendererAdapter.addVertex(meshData, renderBuffer, geometry, overflow.id);

    assert.ok(renderBuffer.slotAllocator.capacity > capacityBefore);
    assert.equal(geometry.attributes.position.count, renderBuffer.slotAllocator.capacity);
    assert.equal(geometry.attributes.normal.count, renderBuffer.slotAllocator.capacity);
    assert.equal(geometry.attributes.uv.count, renderBuffer.slotAllocator.capacity);

    const slot = renderBuffer.vertexIdToBufferIndex.get(overflow.id)[0];
    assert.equal(renderBuffer.bufferIndexToVertexId.get(slot), overflow.id);
    assert.deepEqual(readPosition(geometry, slot).toArray(), [30, 30, 30]);

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('index buffer growth on large face keeps allocator and geometry in sync', () => {
    const { meshData, geometry, renderBuffer } = makeGrid();
    const idxCapBefore = renderBuffer.indexSlotAllocator.capacity;

    // Delete both faces to free index space, then build one big n-gon whose
    // triangle count exceeds the original capacity.
    editorDeleteFace(meshData, renderBuffer, geometry, 0);
    editorDeleteFace(meshData, renderBuffer, geometry, 1);

    const ring = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      ring.push(meshData.addVertex(new THREE.Vector3(Math.cos(a) * 5, Math.sin(a) * 5, 0)));
    }
    const big = meshData.addFace(ring);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, big.id);

    assert.ok(geometry.index.count >= idxCapBefore);
    assert.equal(geometry.index.count, renderBuffer.indexSlotAllocator.capacity);
    const triCount = renderBuffer.faceTriangleCount.get(big.id);
    assert.equal(triCount, (N - 2) * 3);
    assert.equal(renderBuffer.indexSlotAllocator.usedCount, triCount);

    // Written indices point at the face's own vertex slots
    const slots = renderBuffer.faceIdToBufferIndices.get(big.id);
    const slotSet = new Set(slots);
    const offset = renderBuffer.faceTriangleOffset.get(big.id);
    for (let i = 0; i < triCount; i++) {
      assert.ok(slotSet.has(readIndex(geometry, offset + i)),
        `index ${offset + i} points outside the new face's slots`);
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });
});

describe('normals after delete/add across shared edges', () => {
  test('auto mode: deleting a face updates shared and indirectly connected corners', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'auto', angle: 60 });

    // Bend f1 out of the XY plane so the shared edge carries a real dihedral.
    // Move v4/v5 up in z -> f1 normal tilts, angle between f0/f1 normals > 60°.
    const v4 = meshData.vertices.get(4);
    const v5 = meshData.vertices.get(5);
    v4.position.set(2, 1, 2);
    v5.position.set(2, 0, 2);
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(4)) {
      geometry.attributes.position.setXYZ(slot, 2, 1, 2);
    }
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(5)) {
      geometry.attributes.position.setXYZ(slot, 2, 0, 2);
    }
    MeshRendererAdapter.updateNormalsForAffectedFaces(
      meshData, renderBuffer, geometry, new Set([1]), new Set([4, 5])
    );

    const f0Normal = faceNormalOf(meshData, 0);
    const f1Normal = faceNormalOf(meshData, 1);
    assert.ok(f0Normal.angleTo(f1Normal) > THREE.MathUtils.degToRad(60),
      'fixture: dihedral must exceed the 60° auto threshold');

    // Snapshot f1 corner normals before deletion
    const f1SlotsBefore = new Map();
    for (const slot of renderBuffer.faceIdToBufferIndices.get(1)) {
      f1SlotsBefore.set(slot, readNormal(geometry, slot).clone());
    }

    editorDeleteFace(meshData, renderBuffer, geometry, 0);

    // After f0 is gone, f1's vertices each belong to one face, so every f1
    // corner normal equals the f1 face normal.
    for (const [slot, before] of f1SlotsBefore) {
      const after = readNormal(geometry, slot);
      assert.ok(approxEqualVec(after, f1Normal),
        `f1 corner ${slot} normal did not update after neighbor delete`);
      assert.ok(!approxEqualVec(after, before) || approxEqualVec(before, f1Normal),
        'corner normal changed as expected');
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('auto mode: adding a face re-splits smoothing groups at neighboring corners', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'auto', angle: 60 });

    editorDeleteFace(meshData, renderBuffer, geometry, 0);

    // Re-add f0 via the adapter (same topology as the original).
    const reFace = meshData.addFace([
      meshData.vertices.get(0),
      meshData.vertices.get(1),
      meshData.vertices.get(3),
      meshData.vertices.get(2),
    ]);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, reFace.id);

    // Compare against a from-scratch full build of the same mesh + settings.
    // Both builds duplicate corners in meshData.faces insertion order.
    const { geometry: refGeo, renderBuffer: refRB } =
      MeshRendererAdapter.toBufferGeometry(meshData, { mode: 'auto', angle: 60 });

    for (const [fId, slots] of renderBuffer.faceIdToBufferIndices) {
      const refFaceSlots = findRefFaceSlots(refRB, fId);
      slots.forEach((slot, i) => {
        const got = readNormal(geometry, slot);
        const want = readNormal(refGeo, refFaceSlots[i]);
        assert.ok(approxEqualVec(got, want, 1e-4),
          `face ${fId} corner ${i}: incremental normal ${got} != full build ${want}`);
      });
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('smooth mode: neighboring corners average the new face normal without a rebuild', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'smooth' });

    // Tilt f1
    const v4 = meshData.vertices.get(4);
    const v5 = meshData.vertices.get(5);
    v4.position.set(2, 1, 2);
    v5.position.set(2, 0, 2);
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(4)) {
      geometry.attributes.position.setXYZ(slot, 2, 1, 2);
    }
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(5)) {
      geometry.attributes.position.setXYZ(slot, 2, 0, 2);
    }
    MeshRendererAdapter.updateNormalsForAffectedFaces(
      meshData, renderBuffer, geometry, new Set([1]), new Set([4, 5])
    );

    // Snapshot pre-delete normals: the delete/add round trip must restore them.
    const before = new Map();
    for (const [slot, vId] of renderBuffer.bufferIndexToVertexId) {
      before.set(slot, { vId, n: readNormal(geometry, slot).clone() });
    }

    editorDeleteFace(meshData, renderBuffer, geometry, 1);
    const reFace = meshData.addFace([
      meshData.vertices.get(2),
      meshData.vertices.get(3),
      meshData.vertices.get(5),
      meshData.vertices.get(4),
    ]);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, reFace.id);

    // 1) Round-trip stability: every surviving corner returns to its prior normal
    for (const [slot, { vId, n }] of before) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), n, 1e-5),
        `vertex ${vId} corner ${slot} did not restore after delete/re-add`);
    }

    // 2) Explicit smooth semantics at the shared edge: each shared corner is
    //    the normalized unweighted average of the two incident face normals
    //    (the same rule _computeCornerNormals applies with the 180° threshold).
    const n0 = faceNormalOf(meshData, 0);
    const n1 = faceNormalOf(meshData, reFace.id);
    const expected = n0.clone().add(n1).normalize();
    for (const vId of [2, 3]) {
      for (const slot of renderBuffer.vertexIdToBufferIndex.get(vId)) {
        assert.ok(approxEqualVec(readNormal(geometry, slot), expected, 1e-5),
          `shared vertex ${vId} corner is not the smoothed average`);
      }
    }

    // 3) Vertgers unique to one face keep that face's normal
    for (const vId of [0, 1]) {
      for (const slot of renderBuffer.vertexIdToBufferIndex.get(vId)) {
        assert.ok(approxEqualVec(readNormal(geometry, slot), n0, 1e-5));
      }
    }
    for (const vId of [4, 5]) {
      for (const slot of renderBuffer.vertexIdToBufferIndex.get(vId)) {
        assert.ok(approxEqualVec(readNormal(geometry, slot), n1, 1e-5));
      }
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('flat mode: added face corners get the face normal directly', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'flat' });
    editorDeleteFace(meshData, renderBuffer, geometry, 0);

    const vNew = meshData.addVertex(new THREE.Vector3(0, 0, 4));
    const newFace = meshData.addFace([
      meshData.vertices.get(0),
      meshData.vertices.get(1),
      vNew,
    ]);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, newFace.id);

    const expected = faceNormalOf(meshData, newFace.id);
    for (const slot of renderBuffer.faceIdToBufferIndices.get(newFace.id)) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), expected, 1e-5),
        'flat added face must carry its face normal at every corner');
    }
    assertNoViolations(meshData, geometry, renderBuffer);
  });
});

describe('normalAngle and sharp changes without full rebuild', () => {
  test('updateNormalAngle re-splits existing geometry normals', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'auto', angle: 60 });

    // Tilt f1 to ~45° dihedral: smooth at angle 60, split at angle 30.
    const v4 = meshData.vertices.get(4);
    const v5 = meshData.vertices.get(5);
    v4.position.set(2, 1, 1);
    v5.position.set(2, 0, 1);
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(4)) {
      geometry.attributes.position.setXYZ(slot, 2, 1, 1);
    }
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(5)) {
      geometry.attributes.position.setXYZ(slot, 2, 0, 1);
    }
    MeshRendererAdapter.updateNormalsForAffectedFaces(
      meshData, renderBuffer, geometry, new Set([1]), new Set([4, 5])
    );

    const dihedral = faceNormalOf(meshData, 0).angleTo(faceNormalOf(meshData, 1));
    assert.ok(dihedral > THREE.MathUtils.degToRad(30));
    assert.ok(dihedral < THREE.MathUtils.degToRad(60));

    const sharedSlots = [
      ...renderBuffer.vertexIdToBufferIndex.get(2),
      ...renderBuffer.vertexIdToBufferIndex.get(3),
    ];

    // At 60°: f0/f1 corners at shared verts share one averaged normal
    const before = sharedSlots.map(s => readNormal(geometry, s).clone());
    const distinctBefore = new Set(before.map(n => `${n.x.toFixed(4)},${n.y.toFixed(4)},${n.z.toFixed(4)}`));
    assert.ok(distinctBefore.size === 1, '60° threshold should smooth across the ~45° edge');

    MeshRendererAdapter.updateNormalAngle(meshData, renderBuffer, geometry, 30);
    assert.equal(renderBuffer.normalAngle, 30);

    // At 30°: each face corner at the shared verts gets its own face normal
    const f0AtShared = cornerSlotsForVertex(meshData, renderBuffer, 0, [2, 3]);
    const f1AtShared = cornerSlotsForVertex(meshData, renderBuffer, 1, [2, 3]);

    for (const slot of f0AtShared) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), faceNormalOf(meshData, 0), 1e-4),
        'f0 corner should equal f0 face normal after angle split');
    }
    for (const slot of f1AtShared) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), faceNormalOf(meshData, 1), 1e-4),
        'f1 corner should equal f1 face normal after angle split');
    }

    // Matches a from-scratch build at 30°
    const { geometry: refGeo, renderBuffer: refRB } =
      MeshRendererAdapter.toBufferGeometry(meshData, { mode: 'auto', angle: 30 });
    for (const [fId, slots] of renderBuffer.faceIdToBufferIndices) {
      const refFaceSlots = findRefFaceSlots(refRB, fId);
      slots.forEach((slot, i) => {
        assert.ok(
          approxEqualVec(readNormal(geometry, slot), readNormal(refGeo, refFaceSlots[i]), 1e-4),
          `angle change: face ${fId} corner ${i} diverges from full build`
        );
      });
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('updateSharpEdges splits and restores normals at marked shared edges', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'smooth' });
    const sharedEdge = meshData.getEdge(2, 3);
    assert.ok(sharedEdge, 'fixture needs a shared edge between v2 and v3');

    const f0AtShared = cornerSlotsForVertex(meshData, renderBuffer, 0, [2, 3]);
    const f1AtShared = cornerSlotsForVertex(meshData, renderBuffer, 1, [2, 3]);

    // Before sharp: f0 and f1 corners at v2 share one normal (coplanar -> equal anyway).
    // Tilt f1 first to make the split observable.
    const v4 = meshData.vertices.get(4);
    const v5 = meshData.vertices.get(5);
    v4.position.set(2, 1, 2);
    v5.position.set(2, 0, 2);
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(4)) {
      geometry.attributes.position.setXYZ(slot, 2, 1, 2);
    }
    for (const slot of renderBuffer.vertexIdToBufferIndex.get(5)) {
      geometry.attributes.position.setXYZ(slot, 2, 0, 2);
    }
    MeshRendererAdapter.updateNormalsForAffectedFaces(
      meshData, renderBuffer, geometry, new Set([1]), new Set([4, 5])
    );

    const smoothN0 = readNormal(geometry, f0AtShared[0]).clone();
    const smoothN1 = readNormal(geometry, f1AtShared[0]).clone();
    assert.ok(approxEqualVec(smoothN0, smoothN1, 1e-4),
      'smooth mode shares one normal across the edge before marking sharp');

    MeshRendererAdapter.updateSharpEdges(meshData, renderBuffer, geometry, new Set([sharedEdge.id]));

    // After sharp: each side keeps its own face normal at the edge corners
    for (const slot of f0AtShared) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), faceNormalOf(meshData, 0), 1e-4),
        'f0 corner should split to f0 face normal on sharp edge');
    }
    for (const slot of f1AtShared) {
      assert.ok(approxEqualVec(readNormal(geometry, slot), faceNormalOf(meshData, 1), 1e-4),
        'f1 corner should split to f1 face normal on sharp edge');
    }

    // Clearing the sharp restores shared averaged normals
    MeshRendererAdapter.updateSharpEdges(meshData, renderBuffer, geometry, new Set());
    for (const slot of [...f0AtShared, ...f1AtShared]) {
      // All four corners now carry the same averaged normal again
      assert.ok(approxEqualVec(readNormal(geometry, slot), readNormal(geometry, f0AtShared[0]), 1e-4),
        'removing sharp should re-merge smoothing groups');
    }

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('sharp change also reaches vertices indirectly connected through shared edges', () => {
    // Three quads in a strip: f0-f1-f2. Marking the f1/f2 edge sharp must
    // also leave f0/f1 smoothing intact while splitting at the mark.
    const points = [
      [0, 1, 0], [0, 0, 0],
      [1, 1, 0], [1, 0, 0],
      [2, 1, 1], [2, 0, 1],
      [3, 1, 1], [3, 0, 1],
    ];
    const { meshData } = buildMeshData(points, [
      [0, 1, 3, 2],
      [2, 3, 5, 4],
      [4, 5, 7, 6],
    ]);
    const { geometry, renderBuffer } = buildGeometry(meshData, { mode: 'smooth' });

    const edge12 = meshData.getEdge(4, 5);
    MeshRendererAdapter.updateSharpEdges(meshData, renderBuffer, geometry, new Set([edge12.id]));

    // f0/f1 shared edge (v2,v3) remains smooth: corners at v2 share normals
    const f0v2 = cornerSlotsForVertex(meshData, renderBuffer, 0, [2]);
    const f1v2 = cornerSlotsForVertex(meshData, renderBuffer, 1, [2]);
    assert.ok(approxEqualVec(readNormal(geometry, f0v2[0]), readNormal(geometry, f1v2[0]), 1e-4),
      'unmarked shared edge must stay smooth');

    // f1/f2 edge (v4,v5) is sharp: corners diverge to face normals
    const f1v4 = cornerSlotsForVertex(meshData, renderBuffer, 1, [4]);
    const f2v4 = cornerSlotsForVertex(meshData, renderBuffer, 2, [4]);
    assert.ok(!approxEqualVec(readNormal(geometry, f1v4[0]), readNormal(geometry, f2v4[0]), 1e-3),
      'sharp edge corners must diverge');
    assert.ok(approxEqualVec(readNormal(geometry, f1v4[0]), faceNormalOf(meshData, 1), 1e-4));
    assert.ok(approxEqualVec(readNormal(geometry, f2v4[0]), faceNormalOf(meshData, 2), 1e-4));

    assertNoViolations(meshData, geometry, renderBuffer);
  });

  test('ShadingUtils.setShading angle-only change updates in place without rebuilding buffers', () => {
    // ~45° dihedral again: smoothed at 60°, split at 30°.
    const points = GRID_POINTS.map(p => [...p]);
    points[4] = [2, 1, 1];
    points[5] = [2, 0, 1];
    const { meshData } = buildMeshData(points, GRID_FACES);
    const { geometry, renderBuffer } = buildGeometry(meshData, { mode: 'auto', angle: 60 });

    const object = {
      userData: { meshData, renderBuffer, shading: 'auto', shadingAngle: 60 },
      geometry,
    };

    const geometryBefore = geometry;
    const sharedSlotBefore = renderBuffer.faceIdToBufferIndices.get(0)[3]; // f0 corner at v2

    ShadingUtils.setShading(object, { angle: 30 });

    assert.equal(object.userData.shadingAngle, 30);
    assert.equal(renderBuffer.normalAngle, 30);
    // In-place update: geometry object and slot maps survive untouched
    assert.equal(object.geometry, geometryBefore);
    assert.equal(renderBuffer.faceIdToBufferIndices.get(0)[3], sharedSlotBefore);

    // Matches a from-scratch build at the new angle
    const { geometry: refGeo, renderBuffer: refRB } =
      MeshRendererAdapter.toBufferGeometry(meshData, { mode: 'auto', angle: 30 });
    for (const [fId, slots] of renderBuffer.faceIdToBufferIndices) {
      const refFaceSlots = findRefFaceSlots(refRB, fId);
      slots.forEach((slot, i) => {
        assert.ok(
          approxEqualVec(readNormal(geometry, slot), readNormal(refGeo, refFaceSlots[i]), 1e-4),
          `ShadingUtils angle change: face ${fId} corner ${i} diverges from full build`
        );
      });
    }

    assertNoViolations(meshData, geometry, renderBuffer);

    // Mode changes still take the full-rebuild path
    ShadingUtils.setShading(object, { mode: 'flat' });
    assert.equal(object.geometry !== geometryBefore, true);
    assert.equal(object.userData.shading, 'flat');
  });
});

describe('end-to-end delete/add/reuse sequence', () => {
  test('full chain keeps mappings, slot data and normals consistent', () => {
    const { meshData, geometry, renderBuffer } = makeGrid({ mode: 'auto', angle: 60 });

    // 1) delete f0 and remember its slots
    const freedVertSlots = [...renderBuffer.faceIdToBufferIndices.get(0)];
    const freedIndexOffset = renderBuffer.faceTriangleOffset.get(0);
    editorDeleteFace(meshData, renderBuffer, geometry, 0);
    assertNoViolations(meshData, geometry, renderBuffer);

    // 2) add a standalone vertex (reuses nothing face-sized; takes 1 hole slot)
    const lone = meshData.addVertex(new THREE.Vector3(4, 4, 4));
    MeshRendererAdapter.addVertex(meshData, renderBuffer, geometry, lone.id);
    const loneSlot = renderBuffer.vertexIdToBufferIndex.get(lone.id)[0];
    assert.ok(freedVertSlots.includes(loneSlot));
    assert.deepEqual(readPosition(geometry, loneSlot).toArray(), [4, 4, 4]);

    // 3) add a replacement tri using old v0,v1 and the lone vertex; remaining
    //    freed slots get reused by the new face
    const tri = meshData.addFace([
      meshData.vertices.get(0),
      meshData.vertices.get(1),
      lone,
    ]);
    MeshRendererAdapter.addFace(meshData, renderBuffer, geometry, tri.id);
    const triSlots = renderBuffer.faceIdToBufferIndices.get(tri.id);
    assert.equal(triSlots.length, 3);
    // At least two of these slots came from the freed f0 block
    const reused = triSlots.filter(s => freedVertSlots.includes(s)).length;
    assert.ok(reused >= 2, `expected slot reuse, got ${reused}/3`);

    // Index slots: triangle count 3 fits the freed f1 quad block (6 indices)
    const triOffset = renderBuffer.faceTriangleOffset.get(tri.id);
    assert.equal(triOffset, freedIndexOffset, 'index slot block reused from deleted face');

    // Every reused slot carries new-occupant data
    triSlots.forEach((slot, i) => {
      const v = meshData.vertices.get(tri.vertexIds[i]);
      assert.ok(approxEqualVec(readPosition(geometry, slot), v.position));
      const n = readNormal(geometry, slot);
      assert.ok(Math.abs(n.length() - 1) < 1e-4);
    });

    // 4) change angle and sharp set; normals must match a full rebuild
    MeshRendererAdapter.updateNormalAngle(meshData, renderBuffer, geometry, 30);
    const edge = meshData.getEdge(2, 3);
    MeshRendererAdapter.updateSharpEdges(meshData, renderBuffer, geometry, new Set([edge.id]));

    const { geometry: refGeo, renderBuffer: refRB } = MeshRendererAdapter.toBufferGeometry(meshData, {
      mode: 'auto', angle: 30, sharps: new Set([edge.id]),
    });
    for (const [fId, slots] of renderBuffer.faceIdToBufferIndices) {
      const refSlots = findRefFaceSlots(refRB, fId);
      slots.forEach((slot, i) => {
        assert.ok(
          approxEqualVec(readNormal(geometry, slot), readNormal(refGeo, refSlots[i]), 1e-4),
          `end-to-end face ${fId} corner ${i} normal mismatch`
        );
      });
    }

    // 5) no dangling entries for the deleted face anywhere
    assert.equal(renderBuffer.faceIdToBufferIndices.has(0), false);
    assert.equal(renderBuffer.faceTriangleOffset.has(0), false);
    assert.equal(renderBuffer.faceTriangleCount.has(0), false);
    assertNoViolations(meshData, geometry, renderBuffer);
  });
});

// ---------- reference helpers ----------

// A full rebuild duplicates corners in meshData.faces insertion order, which
// matches the incremental buffer's per-face slot order.
function findRefFaceSlots(refRenderBuffer, faceId) {
  return refRenderBuffer.faceIdToBufferIndices.get(faceId);
}

function cornerSlotsForVertex(meshData, renderBuffer, faceId, vertexIds) {
  const face = meshData.faces.get(faceId);
  const slots = renderBuffer.faceIdToBufferIndices.get(faceId);
  const out = [];
  face.vertexIds.forEach((vId, i) => {
    if (vertexIds.includes(vId)) out.push(slots[i]);
  });
  return out;
}
