# Render-buffer slot reuse & normal update tests

Local Node verification for `js/geometry/MeshRendererAdapter.js` covering the
edit-mode chain: **delete face → add face / add vertex (slot reuse) → change
auto normal angle / sharp edge set**.

## Run

```bash
cd tests
npm install        # three@0.176.0 + earcut@3.0.2, matching the browser import map
npm test
```

`helpers/import-map-loader.js` is a small Node ESM loader that resolves the
bare `three` / `earcut` specifiers (normally resolved by the browser import
map in `index.html`) to the locally installed packages. No production source
file is modified for testing.

## What is covered

`mesh-render-buffer.test.js` builds a two-quad grid with a shared edge (and a
three-quad strip for the indirect-connection case) and asserts:

1. **Slot release & reuse**
   - `deleteFace` frees contiguous vertex/index slots, degenerates the old
     triangles, and removes every `faceIdToBufferIndices` /
     `faceTriangleOffset` / `faceTriangleCount` entry plus the corresponding
     `bufferIndexToVertexId` / `vertexIdToBufferIndex` entries.
   - A later `addFace` / `addVertex` gets the freed slots back (first-fit
     allocator) and writes fresh **position, UV and normal** data — no values
     from the previous occupant survive.
   - No mapping entry references a deleted face or vertex; both maps stay
     exact inverses of each other.
2. **Buffer growth**
   - Exhausting vertex or index capacity grows the GPU attributes, updates
     `SlotAllocator.capacity` / `freeBlocks`, and registers the new slots in
     the same maps; `usedCount + free == capacity` always holds.
3. **Normals (smooth / auto / flat)**
   - Deleting/adding a face recomputes corner normals at all affected
     vertices, including vertices reached only through a shared edge, per the
     current `normalMode` / `normalAngle` and sharp-edge set.
   - `flat` mode writes the face normal directly to new-face corners.
   - `updateNormalAngle` re-splits smoothing groups on the *existing*
     geometry (no full rebuild) and matches a from-scratch build.
   - `updateSharpEdges` splits at a marked edge, restores merged normals when
     the mark is cleared, and leaves unmarked shared edges smooth.
4. **End-to-end sequence** on one mesh: delete → standalone addVertex into a
   freed slot → replacement face reusing the freed vertex/index blocks →
   angle change → sharp change, with mapping invariants and normal
   correctness asserted after every step.

The tests use the same call order as `VertexEditor` (render-buffer update
first, then `meshData.deleteFace`); see `editorDeleteFace` in
`helpers/meshTestUtils.js`.
