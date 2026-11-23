import * as THREE from 'three';
import nodeAssert from 'node:assert/strict';
import { MeshData } from '../../js/core/MeshData.js';
import { MeshRendererAdapter } from '../../js/geometry/MeshRendererAdapter.js';

/**
 * Build a MeshData from point + face specs.
 * points: [[x,y,z], ...]
 * faceSpecs: [[vIndex, vIndex, ...], ...]
 */
export function buildMeshData(points, faceSpecs) {
  const meshData = new MeshData();
  const verts = points.map(p => meshData.addVertex(new THREE.Vector3(p[0], p[1], p[2])));
  for (const spec of faceSpecs) {
    meshData.addFace(spec.map(i => verts[i]));
  }
  return { meshData, verts };
}

export function buildGeometry(meshData, options) {
  const { geometry, renderBuffer } = MeshRendererAdapter.toBufferGeometry(meshData, options);
  return { geometry, renderBuffer };
}

export function faceNormalOf(meshData, faceId) {
  const face = meshData.faces.get(faceId);
  const verts = face.vertexIds.map(id => meshData.vertices.get(id));
  // Newell's method, same as computePlaneNormal, kept local to avoid extra import cycles
  const n = new THREE.Vector3();
  for (let i = 0; i < verts.length; i++) {
    const cur = verts[i].position;
    const nxt = verts[(i + 1) % verts.length].position;
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  return n.normalize();
}

export function readNormal(geometry, slot) {
  const a = geometry.attributes.normal.array;
  return new THREE.Vector3(a[slot * 3], a[slot * 3 + 1], a[slot * 3 + 2]);
}

export function readPosition(geometry, slot) {
  const a = geometry.attributes.position.array;
  return new THREE.Vector3(a[slot * 3], a[slot * 3 + 1], a[slot * 3 + 2]);
}

export function readUV(geometry, slot) {
  const a = geometry.attributes.uv.array;
  return [a[slot * 2], a[slot * 2 + 1]];
}

export function readIndex(geometry, slot) {
  return geometry.index.getX(slot);
}

// Mirrors VertexEditor.deleteFace: the render buffer is updated first, then
// the topology face is removed so subsequent normal recomputes never see it.
export function editorDeleteFace(meshData, renderBuffer, geometry, faceId) {
  const face = meshData.faces.get(faceId);
  MeshRendererAdapter.deleteFace(meshData, renderBuffer, geometry, faceId);
  meshData.deleteFace(face);
  return face;
}

/**
 * Inverse-map check: every registered buffer slot maps back to a live vertex,
 * every vertex entry points only at live slots, and every face entry is
 * internally consistent. Returns a list of human-readable violations.
 */
export function findMappingViolations(meshData, renderBuffer) {
  const violations = [];
  const {
    vertexIdToBufferIndex,
    bufferIndexToVertexId,
    faceIdToBufferIndices,
    faceTriangleOffset,
    faceTriangleCount,
  } = renderBuffer;

  // vertexIdToBufferIndex <-> bufferIndexToVertexId
  for (const [vId, slots] of vertexIdToBufferIndex) {
    if (!meshData.vertices.has(vId)) {
      violations.push(`vertexIdToBufferIndex holds deleted vertex ${vId}`);
    }
    if (slots.length === 0) {
      violations.push(`vertexIdToBufferIndex has empty slot list for vertex ${vId}`);
    }
    for (const slot of slots) {
      if (bufferIndexToVertexId.get(slot) !== vId) {
        violations.push(`slot ${slot} does not map back to vertex ${vId}`);
      }
    }
  }

  for (const [slot, vId] of bufferIndexToVertexId) {
    if (!meshData.vertices.has(vId)) {
      violations.push(`bufferIndexToVertexId slot ${slot} points at deleted vertex ${vId}`);
    }
    const slots = vertexIdToBufferIndex.get(vId);
    if (!slots || !slots.includes(slot)) {
      violations.push(`bufferIndexToVertexId slot ${slot} -> ${vId} missing from reverse map`);
    }
  }

  // face maps
  for (const [fId, slots] of faceIdToBufferIndices) {
    if (!meshData.faces.has(fId)) {
      violations.push(`faceIdToBufferIndices holds deleted face ${fId}`);
      continue;
    }
    const face = meshData.faces.get(fId);
    if (slots.length !== face.vertexIds.length) {
      violations.push(`face ${fId} slot count ${slots.length} != vertex count ${face.vertexIds.length}`);
    }
    slots.forEach((slot, i) => {
      if (bufferIndexToVertexId.get(slot) !== face.vertexIds[i]) {
        violations.push(`face ${fId} corner ${i} slot ${slot} maps to wrong vertex`);
      }
    });
    if (!faceTriangleOffset.has(fId)) violations.push(`face ${fId} missing triangle offset`);
    if (!faceTriangleCount.has(fId)) violations.push(`face ${fId} missing triangle count`);
  }

  for (const fId of faceTriangleOffset.keys()) {
    if (!faceIdToBufferIndices.has(fId)) {
      violations.push(`faceTriangleOffset holds deleted face ${fId}`);
    }
  }
  for (const fId of faceTriangleCount.keys()) {
    if (!faceIdToBufferIndices.has(fId)) {
      violations.push(`faceTriangleCount holds deleted face ${fId}`);
    }
  }

  return violations;
}

/**
 * Allocator bookkeeping invariant: usedCount equals the number of mapped
 * vertex/index slots, and free blocks cover exactly the unused range.
 */
export function findAllocatorViolations(geometry, renderBuffer) {
  const violations = [];
  const { slotAllocator, indexSlotAllocator } = renderBuffer;

  if (slotAllocator.capacity !== geometry.attributes.position.count) {
    violations.push(`vertex allocator capacity ${slotAllocator.capacity} != attribute count ${geometry.attributes.position.count}`);
  }
  if (indexSlotAllocator.capacity !== geometry.index.count) {
    violations.push(`index allocator capacity ${indexSlotAllocator.capacity} != index count ${geometry.index.count}`);
  }

  const usedVertSlots = renderBuffer.bufferIndexToVertexId.size;
  if (slotAllocator.usedCount !== usedVertSlots) {
    violations.push(`vertex usedCount ${slotAllocator.usedCount} != mapped slots ${usedVertSlots}`);
  }

  let freeVertTotal = 0;
  for (const b of slotAllocator.freeBlocks) freeVertTotal += b.count;
  if (freeVertTotal + slotAllocator.usedCount !== slotAllocator.capacity) {
    violations.push('vertex free blocks + used != capacity');
  }

  let usedIndexTotal = 0;
  for (const fId of renderBuffer.faceIdToBufferIndices.keys()) {
    usedIndexTotal += renderBuffer.faceTriangleCount.get(fId);
  }
  if (indexSlotAllocator.usedCount !== usedIndexTotal) {
    violations.push(`index usedCount ${indexSlotAllocator.usedCount} != summed face triangles ${usedIndexTotal}`);
  }

  let freeIndexTotal = 0;
  for (const b of indexSlotAllocator.freeBlocks) freeIndexTotal += b.count;
  if (freeIndexTotal + indexSlotAllocator.usedCount !== indexSlotAllocator.capacity) {
    violations.push('index free blocks + used != capacity');
  }

  return violations;
}

export function assertNoViolations(meshData, geometry, renderBuffer) {
  const mapping = findMappingViolations(meshData, renderBuffer);
  const allocator = findAllocatorViolations(geometry, renderBuffer);
  nodeAssert.deepEqual(mapping, [], `mapping violations: ${mapping.join('; ')}`);
  nodeAssert.deepEqual(allocator, [], `allocator violations: ${allocator.join('; ')}`);
}

export function approxEqualVec(a, b, eps = 1e-5) {
  return a.distanceTo(b) <= eps;
}
