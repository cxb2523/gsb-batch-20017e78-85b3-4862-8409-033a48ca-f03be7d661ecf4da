/**
 * Deform keys after a mesh changed shape: they follow their vertex and, on weighted meshes, their bone; when the layout
 * cannot be carried over (bind / unbind, a key of the wrong size, a map that does not fit) they are dropped instead of left
 * to misalign the vertices. Undo / redo reproduce the same document.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { deformLength, identityVertexMap, remapDeformValues, removeMeshVertices } from '../src/core/mesh';
import type { Influence, MeshAttachment } from '../src/core/model';
import { docStore } from '../src/store/doc';
import * as M from '../src/store/meshActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;
const skinId = () => doc().skins[0].id;
const hasBone = (id: string) => doc().bones.some((b) => b.id === id);
const meshOf = (slotId: string, name: string) => M.getMesh(slotId, name)!;
const keysOf = (slotId: string, name: string) => doc().animations[0].deform[skinId()]?.[slotId]?.[name];

let armSlot = '';
let headSlot = '';
let bodySlot = '';
let armUpper = '';
let armLower = '';

beforeEach(() => {
  const f = buildFixture();
  const d = f.project.skeleton;
  armSlot = d.slots.find((s) => s.name === 'arm')!.id;
  headSlot = d.slots.find((s) => s.name === 'head')!.id;
  bodySlot = d.slots.find((s) => s.name === 'body')!.id;
  armUpper = d.bones.find((b) => b.name === 'armUpper')!.id;
  armLower = d.bones.find((b) => b.name === 'armLower')!.id;
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', tool: 'mesh', selection: { ...emptySelection, slot: armSlot, attachment: 'arm' } });
});

/** A quad with two interior vertices, so an interior vertex can be deleted. */
function installQuadWithInterior() {
  docStore.update('mesh', (dd) => {
    (dd.skeleton.skins[0].attachments[bodySlot] as Record<string, unknown>).body = {
      type: 'mesh',
      name: 'body',
      path: 'body',
      color: [1, 1, 1, 1],
      width: 80,
      height: 60,
      uvs: [0, 1, 0, 0, 1, 0, 1, 1],
      triangles: [0, 1, 2, 2, 3, 0],
      hull: 4,
      edges: [],
      vertices: [-40, -30, -40, 30, 40, 30, 40, -30],
      weights: null,
    } satisfies MeshAttachment;
  });
  M.addMeshVertex(bodySlot, 'body', 0, 0);
  M.addMeshVertex(bodySlot, 'body', 10, 10);
}

function setKey(slotId: string, name: string, value: number[]) {
  docStore.update('key', (d) => {
    ((d.skeleton.animations[0].deform[skinId()] ??= {})[slotId] ??= {})[name] = [{ time: 0, value: value.slice() }];
  });
}

describe('removeMeshVertices produces a vertex map', () => {
  it('fills the map with the old index of every surviving vertex', () => {
    const mesh: MeshAttachment = {
      type: 'mesh',
      name: 'q',
      path: 'q',
      color: [1, 1, 1, 1],
      width: 10,
      height: 10,
      uvs: new Array(12).fill(0),
      triangles: [],
      hull: 4,
      edges: [0, 1, 4, 5],
      vertices: new Array(12).fill(0),
      weights: null,
    };
    const map: number[] = [];
    const out = removeMeshVertices(mesh, new Set([1, 4]), mesh.uvs, map);
    expect(map).toEqual([0, 2, 3, 5]);
    expect(out.uvs.length / 2).toBe(4);
    expect(out.edges).toEqual([]); // edges that lost a vertex go too
  });

  it('leaves the map untouched when the outline would lose too many vertices', () => {
    const mesh: MeshAttachment = {
      type: 'mesh',
      name: 'q',
      path: 'q',
      color: [1, 1, 1, 1],
      width: 10,
      height: 10,
      uvs: new Array(8).fill(0),
      triangles: [],
      hull: 4,
      edges: [],
      vertices: new Array(8).fill(0),
      weights: null,
    };
    const map: number[] = [7];
    expect(removeMeshVertices(mesh, new Set([0, 1]), mesh.uvs, map)).toBe(mesh);
    expect(map).toEqual([7]);
  });

  it('identityVertexMap keeps the layout', () => {
    expect(identityVertexMap(3)).toEqual([0, 1, 2]);
  });
});

describe('remapDeformValues refuses what it cannot carry safely', () => {
  const weighted = (weights: Influence[][]): MeshAttachment => ({
    type: 'mesh',
    name: 'm',
    path: 'm',
    color: [1, 1, 1, 1],
    width: 10,
    height: 10,
    uvs: new Array(weights.length * 2).fill(0),
    triangles: [],
    hull: Math.min(3, weights.length),
    edges: [],
    vertices: [],
    weights,
  });
  const all = () => true;

  it('returns null on a bind / unbind switch', () => {
    const before = weighted([[['a', 1, 1, 1]]]);
    const after: MeshAttachment = { ...before, weights: null, vertices: [0, 0] };
    expect(remapDeformValues(before, after, null, all, new Array(deformLength(before, all)).fill(0))).toBeNull();
  });

  it('returns null when the key is not deformLength(before) long', () => {
    const before = weighted([[['a', 1, 1, 1]]]);
    expect(remapDeformValues(before, before, null, all, [1, 2, 3])).toBeNull();
  });

  it('returns null when a map is needed but missing, short, or points out of range', () => {
    const before = weighted([[['a', 1, 1, 1]], [['a', 1, 1, 1]]]);
    const after = weighted([[['a', 1, 1, 1]]]);
    const values = new Array(deformLength(before, all)).fill(0);
    expect(remapDeformValues(before, after, null, all, values)).toBeNull(); // needs a map
    expect(remapDeformValues(before, after, [], all, values)).toBeNull(); // too short for the new mesh
    expect(remapDeformValues(before, after, [9], all, values)).toBeNull(); // points past the old mesh
  });

  it('carries a value to its own bone when the influence order changed', () => {
    const before = weighted([
      [
        ['a', 1, 1, 0.5],
        ['b', 2, 2, 0.5],
      ],
    ]);
    const after = weighted([
      [
        ['b', 2, 2, 0.5],
        ['a', 1, 1, 0.5],
      ],
    ]);
    expect(remapDeformValues(before, after, null, all, [10, 11, 20, 21])).toEqual([20, 21, 10, 11]);
  });
});

describe('A1: an unweighted mesh keeps the values of the surviving vertices', () => {
  it('deleting an interior vertex migrates by vertex, a new vertex starts at zero', () => {
    installQuadWithInterior();
    const mesh = meshOf(bodySlot, 'body');
    const n = mesh.uvs.length / 2;
    expect(n).toBe(6);
    const value = Array.from({ length: n }, (_, i) => [i * 10 + 1, -(i * 10 + 1)]).flat();
    setKey(bodySlot, 'body', value);
    M.deleteMeshVertices(bodySlot, 'body', [4]);
    const after = meshOf(bodySlot, 'body');
    expect(after.uvs.length / 2).toBe(5);
    const key = keysOf(bodySlot, 'body')[0].value;
    expect(key.length).toBe(deformLength(after, hasBone));
    const keep = [0, 1, 2, 3, 5];
    expect(key).toEqual(keep.flatMap((i) => [value[i * 2], value[i * 2 + 1]]));
  });

  it('adding a vertex appends zeros and keeps the old values', () => {
    installQuadWithInterior();
    const mesh = meshOf(bodySlot, 'body');
    const n = mesh.uvs.length / 2;
    const value = Array.from({ length: n }, (_, i) => i + 1).flatMap((v) => [v, -v]);
    setKey(bodySlot, 'body', value);
    const idx = M.addMeshVertex(bodySlot, 'body', 20, 20)!;
    const after = meshOf(bodySlot, 'body');
    const key = keysOf(bodySlot, 'body')[0].value;
    expect(key.length).toBe(deformLength(after, hasBone));
    const expected: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === idx) expected.push(0, 0);
      expected.push(value[i * 2], value[i * 2 + 1]);
    }
    if (idx === n) expected.push(0, 0);
    expect(key).toEqual(expected);
  });
});

describe('A2: a weighted mesh aligns values by bone identity, not by influence index', () => {
  it('keeps every (vertex, bone) value on its own bone after a delete', () => {
    // reverse the influence order of every vertex, so a naive index alignment would swap the bones
    docStore.update('reverse', (d) => {
      const m = d.skeleton.skins[0].attachments[armSlot].arm as MeshAttachment;
      m.weights = m.weights!.map((list) => [...list].reverse());
    });
    const before = meshOf(armSlot, 'arm');
    const offsets: number[] = [];
    let off = 0;
    before.weights!.forEach((list) => {
      offsets.push(off);
      off += list.length;
    });
    const value: number[] = [];
    before.weights!.forEach((list, vi) =>
      list.forEach((inf) => value.push((vi + 1) * 100 + (inf[0] === armUpper ? 1 : 2), -((vi + 1) * 100 + (inf[0] === armUpper ? 1 : 2)))),
    );
    setKey(armSlot, 'arm', value);
    expect(value.length).toBe(deformLength(before, hasBone));

    M.deleteMeshVertices(armSlot, 'arm', [1]);
    const after = meshOf(armSlot, 'arm');
    const key = keysOf(armSlot, 'arm')[0].value;
    expect(key.length).toBe(deformLength(after, hasBone));
    const keep = [0, 2, 3, 4, 5];
    const expected: number[] = [];
    keep.forEach((oldV, newV) => {
      for (const inf of after.weights![newV]) {
        const k = before.weights![oldV].findIndex((x) => x[0] === inf[0]);
        expected.push(value[(offsets[oldV] + k) * 2], value[(offsets[oldV] + k) * 2 + 1]);
      }
    });
    expect(key).toEqual(expected);
  });

  it('a re-triangulation and a triangle reorder keep the values on the same vertices', () => {
    const before = meshOf(armSlot, 'arm');
    const value = new Array(deformLength(before, hasBone)).fill(0).map((_, i) => i + 1);
    setKey(armSlot, 'arm', value);
    M.retriangulateMesh(armSlot, 'arm');
    M.moveMeshTriangle(armSlot, 'arm', 0, 'last');
    M.toggleMeshEdge(armSlot, 'arm', 0, 2);
    expect(keysOf(armSlot, 'arm')[0].value).toEqual(value);
  });
});

describe('A3: switching between weighted and unweighted drops the keys', () => {
  it('unbinding a weighted mesh drops its keys; undo restores them; redo drops them again', () => {
    expect(keysOf(armSlot, 'arm')).toBeDefined();
    M.unbindMeshesFromBones();
    expect(meshOf(armSlot, 'arm').weights).toBeNull();
    expect(keysOf(armSlot, 'arm')).toBeUndefined();
    docStore.undo();
    expect(meshOf(armSlot, 'arm').weights).not.toBeNull();
    expect(keysOf(armSlot, 'arm')).toBeDefined();
    docStore.redo();
    expect(meshOf(armSlot, 'arm').weights).toBeNull();
    expect(keysOf(armSlot, 'arm')).toBeUndefined();
  });

  it('binding an unweighted mesh drops its keys', () => {
    expect(keysOf(headSlot, 'head')).toBeDefined();
    M.bindMeshToBones(headSlot, 'head', [armUpper, armLower]);
    expect(meshOf(headSlot, 'head').weights).not.toBeNull();
    expect(keysOf(headSlot, 'head')).toBeUndefined();
  });
});

describe('A4: a key whose length does not match deformLength is dropped, not misaligned', () => {
  it('an edit after a malformed key drops the timeline', () => {
    setKey(armSlot, 'arm', [1, 2, 3]);
    M.deleteMeshVertices(armSlot, 'arm', [2]);
    expect(keysOf(armSlot, 'arm')).toBeUndefined();
  });

  it('a re-triangulation after a malformed key drops the timeline', () => {
    setKey(headSlot, 'head', [1, 2, 3, 4]);
    M.retriangulateMesh(headSlot, 'head');
    expect(keysOf(headSlot, 'head')).toBeUndefined();
  });
});

describe('A5: undo / redo reproduce the mesh and its keys', () => {
  it('a delete can be undone and redone exactly', () => {
    const beforeMesh = JSON.stringify(meshOf(armSlot, 'arm'));
    const beforeKeys = JSON.stringify(keysOf(armSlot, 'arm'));
    M.deleteMeshVertices(armSlot, 'arm', [2]);
    const afterMesh = JSON.stringify(meshOf(armSlot, 'arm'));
    const afterKeys = JSON.stringify(keysOf(armSlot, 'arm'));
    expect(afterKeys).not.toBe(beforeKeys);
    for (const k of keysOf(armSlot, 'arm')) expect(k.value.length).toBe(deformLength(meshOf(armSlot, 'arm'), hasBone));
    docStore.undo();
    expect(JSON.stringify(meshOf(armSlot, 'arm'))).toBe(beforeMesh);
    expect(JSON.stringify(keysOf(armSlot, 'arm'))).toBe(beforeKeys);
    docStore.redo();
    expect(JSON.stringify(meshOf(armSlot, 'arm'))).toBe(afterMesh);
    expect(JSON.stringify(keysOf(armSlot, 'arm'))).toBe(afterKeys);
  });
});
