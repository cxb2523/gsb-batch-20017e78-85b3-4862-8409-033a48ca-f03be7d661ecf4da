import { type Bounds, Point, type Rectangle } from "pixi.js";
import {
  BufferGeometry,
  type Camera,
  Float32BufferAttribute,
  type Intersection,
  type Mesh,
  Plane,
  type Ray,
  Triangle,
  Vector2,
  Vector3,
} from "three";
import { MeshBVH } from "three-mesh-bvh";

/**
 * Coordinate mappings between UV (0-1), NDC (-1..1), Pixi pixels, DOM client, and three.js space.
 *
 * Functions taking `out` write into it and return it; otherwise they allocate.
 * `bounds.x`/`bounds.y` offsets default to 0.
 *
 * @module bijections
 */

/**
 * Maps UV (0-1) to Pixi pixels within `bounds`.
 *
 * @category bijection
 */
export function mapUvToPixi(
  uv: Vector2,
  bounds:
    | Rectangle
    | Bounds
    | { width: number; height: number; x?: number; y?: number },
  out?: Point,
): Point {
  const result = out ?? new Point();
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  result.x = uv.x * bounds.width + bx;
  result.y = uv.y * bounds.height + by;
  return result;
}

/**
 * Maps local Pixi pixels within `bounds` to UV (0-1).
 *
 * @category bijection
 */
export function mapPixiToUv(
  point: Point,
  bounds:
    | Rectangle
    | Bounds
    | { width: number; height: number; x?: number; y?: number },
  out?: Vector2,
): Vector2 {
  const result = out ?? new Vector2();
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  result.x = (point.x - bx) / bounds.width;
  result.y = (point.y - by) / bounds.height;
  return result;
}

/**
 * Maps local Pixi pixels within `bounds` to NDC (-1..1, y-up).
 *
 * @category bijection
 */
export function mapPixiToNdc(
  point: Point,
  bounds:
    | Rectangle
    | Bounds
    | { width: number; height: number; x?: number; y?: number },
  out?: Vector2,
): Vector2 {
  const result = out ?? new Vector2();
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  const normalizedX = (point.x - bx) / bounds.width;
  const normalizedY = (point.y - by) / bounds.height;
  result.x = normalizedX * 2 - 1;
  result.y = -(normalizedY * 2 - 1);
  return result;
}

/**
 * Maps NDC (-1..1, y-up) to Pixi pixels within `bounds`.
 *
 * @category bijection
 */
export function mapNdcToPixi(
  ndc: Vector2,
  bounds:
    | Rectangle
    | Bounds
    | { width: number; height: number; x?: number; y?: number },
  out?: Point,
): Point {
  const result = out ?? new Point();
  const bx = bounds.x ?? 0;
  const by = bounds.y ?? 0;
  const normalizedX = (ndc.x + 1) / 2;
  const normalizedY = (-ndc.y + 1) / 2;
  result.x = normalizedX * bounds.width + bx;
  result.y = normalizedY * bounds.height + by;
  return result;
}

/**
 * Maps UV (0-1) to NDC (-1..1); flips y.
 *
 * @category bijection
 */
export function mapUvToNdc(uv: Vector2, out?: Vector2): Vector2 {
  const result = out ?? new Vector2();
  result.x = uv.x * 2 - 1;
  result.y = -(uv.y * 2 - 1);
  return result;
}

/**
 * Maps NDC (-1..1) to UV (0-1); flips y.
 *
 * @category bijection
 */
export function mapNdcToUv(ndc: Vector2, out?: Vector2): Vector2 {
  const result = out ?? new Vector2();
  result.x = (ndc.x + 1) / 2;
  result.y = (-ndc.y + 1) / 2;
  return result;
}

/**
 * Maps DOM client coordinates over element `rect` to viewport pixels.
 *
 * @category bijection
 */
export function mapClientToViewport(
  client: Point | { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  out?: Point,
): Point {
  const result = out ?? new Point();
  const clientX = "clientX" in client ? client.clientX : client.x;
  const clientY = "clientY" in client ? client.clientY : client.y;
  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  result.x = normalizedX * viewport.width;
  result.y = normalizedY * viewport.height;
  return result;
}

/**
 * Maps viewport pixels to DOM client coordinates over element `rect`.
 *
 * @category bijection
 */
export function mapViewportToClient(
  viewportPoint: Point | { x: number; y: number },
  viewport: { width: number; height: number },
  rect: { left: number; top: number; width: number; height: number },
  out?: Point,
): Point {
  const result = out ?? new Point();
  const normalizedX = viewportPoint.x / viewport.width;
  const normalizedY = viewportPoint.y / viewport.height;
  result.x = normalizedX * rect.width + rect.left;
  result.y = normalizedY * rect.height + rect.top;
  return result;
}

declare module "three" {
  interface BufferGeometry {
    uvBoundsTree?: MeshBVH;
  }
}

/**
 * Cached UV-space BVH for `geometry`, built from UVs as positions at z=0.
 *
 * @category bijection
 * @throws If `geometry` lacks a `uv` attribute.
 */
export function getOrCreateUvBvh(geometry: BufferGeometry): MeshBVH {
  if (geometry.uvBoundsTree) {
    return geometry.uvBoundsTree;
  }

  const uvAttr = geometry.getAttribute("uv");
  if (!uvAttr) {
    throw new Error("Geometry must have UV coordinates");
  }

  const index = geometry.index;
  const vertexCount = uvAttr.count;

  const uvGeometry = new BufferGeometry();
  const positions = new Float32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = uvAttr.getX(i);
    positions[i * 3 + 1] = uvAttr.getY(i);
    positions[i * 3 + 2] = 0;
  }

  uvGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

  if (index) {
    uvGeometry.setIndex(index.clone());
  }

  const bvh = new MeshBVH(uvGeometry);
  geometry.uvBoundsTree = bvh;

  return bvh;
}

/**
 * Disposes the cached UV BVH; call after UVs change.
 *
 * @category bijection
 */
export function disposeUvBvh(geometry: BufferGeometry): void {
  if (geometry.uvBoundsTree) {
    geometry.uvBoundsTree.geometry.dispose();
    geometry.uvBoundsTree = undefined;
  }
}

/**
 * Cached position-space BVH for `geometry`, stored on `geometry.boundsTree`.
 *
 * @category bijection
 */
export function getOrCreateBvh(geometry: BufferGeometry): MeshBVH {
  if (geometry.boundsTree) {
    // three-mesh-bvh types this as GeometryBVH, but for mesh geometry it's MeshBVH
    return geometry.boundsTree as MeshBVH;
  }
  const bvh = new MeshBVH(geometry);
  geometry.boundsTree = bvh;
  return bvh;
}

/**
 * Clears the cached position-space BVH; call after positions change.
 *
 * @category bijection
 */
export function disposeBvh(geometry: BufferGeometry): void {
  // BVH shares `geometry` itself; disposing it would free the caller's buffers.
  geometry.boundsTree = undefined;
}

/**
 * Mesh surface point matching a UV coordinate.
 *
 * @category bijection
 */
export interface UvTrace {
  /** Mesh whose surface holds this trace */
  mesh: Mesh;
  /** Local or world space, per the producing function */
  position: Vector3;
  /** Interpolated vertex normal, or face normal when the geometry has none */
  normal: Vector3;
  faceIndex: number;
  /** Weights of the triangle's vertices */
  barycentric: Vector3;
}

const _queryPoint = new Vector3();
const _uvPoint = new Vector3();

/**
 * Maps UV (0-1) to every matching surface point on `mesh`, in local space.
 *
 * @category bijection
 * @param faceIndex - Restricts the search to this triangle
 * @returns One trace per triangle containing `uv`; empty when none do
 */
export function traceUvToThreeLocal(
  uv: Vector2,
  mesh: Mesh,
  faceIndex?: number,
): UvTrace[] {
  const results: UvTrace[] = [];

  if (faceIndex !== undefined) {
    const result = traceTriangle(faceIndex, uv, mesh);
    if (result) {
      results.push(result);
    }
    return results;
  }

  const bvh = getOrCreateUvBvh(mesh.geometry);

  _queryPoint.set(uv.x, uv.y, 0);
  bvh.shapecast({
    intersectsBounds: (box) => box.containsPoint(_queryPoint),
    intersectsTriangle: (_tri, triFaceIndex) => {
      const result = traceTriangle(triFaceIndex, uv, mesh);
      if (result) {
        results.push(result);
      }
      return false;
    },
  });

  return results;
}

/**
 * World-space {@link traceUvToThreeLocal}.
 *
 * @category bijection
 */
export function traceUvToThree(
  uv: Vector2,
  mesh: Mesh,
  faceIndex?: number,
): UvTrace[] {
  const localResults = traceUvToThreeLocal(uv, mesh, faceIndex);

  return localResults.map(({ position, normal, faceIndex, barycentric }) => {
    const worldPosition = position.clone();
    mesh.localToWorld(worldPosition);

    const worldNormal = normal.clone();
    worldNormal.transformDirection(mesh.matrixWorld);

    return {
      mesh,
      position: worldPosition,
      normal: worldNormal,
      faceIndex,
      barycentric,
    };
  });
}

const _uvTri = new Triangle();
const _posTri = new Triangle();
const _bary = new Vector3();
const _position = new Vector3();
const _normal = new Vector3();

function traceTriangle(
  faceIndex: number,
  uv: Vector2,
  mesh: Mesh,
): UvTrace | null {
  const geometry = mesh.geometry;
  const uvAttr = geometry.getAttribute("uv");
  const posAttr = geometry.getAttribute("position");
  const normAttr = geometry.getAttribute("normal");
  const index = geometry.index;

  const i0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
  const i1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
  const i2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

  _uvTri.a.set(uvAttr.getX(i0), uvAttr.getY(i0), 0);
  _uvTri.b.set(uvAttr.getX(i1), uvAttr.getY(i1), 0);
  _uvTri.c.set(uvAttr.getX(i2), uvAttr.getY(i2), 0);

  _uvPoint.set(uv.x, uv.y, 0);
  if (!_uvTri.containsPoint(_uvPoint)) {
    return null;
  }

  _uvTri.getBarycoord(_uvPoint, _bary);

  if (normAttr) {
    Triangle.getInterpolatedAttribute(normAttr, i0, i1, i2, _bary, _normal);
  } else {
    _posTri.setFromAttributeAndIndices(posAttr, i0, i1, i2);
    _posTri.getNormal(_normal);
  }
  const normal = _normal.clone();

  Triangle.getInterpolatedAttribute(posAttr, i0, i1, i2, _bary, _position);
  const position = _position.clone();
  const barycentric = _bary.clone();

  return {
    mesh,
    position,
    normal,
    faceIndex,
    barycentric,
  };
}

const _ndc = new Vector3();

/**
 * Projects a world position through `camera` to NDC (-1..1); drops depth.
 *
 * @category bijection
 */
export function mapThreeToNdc(
  vec3: Vector3,
  camera: Camera,
  out?: Vector2,
): Vector2 {
  const result = out ?? new Vector2();
  _ndc.copy(vec3);
  _ndc.project(camera);
  result.x = _ndc.x;
  result.y = _ndc.y;
  return result;
}

const _localPoint = new Vector3();
const _meshCenter = new Vector3();
const _closestPoint = new Vector3();
const _projTri = new Triangle();
const _projTriPlane = new Plane();
const _localRayOrigin = new Vector3();
const _localRayDir = new Vector3();
const _triPlaneIntersection = new Vector3();
const _projBary = new Vector3();
const _projUv = new Vector2();
const _projWorldPoint = new Vector3();

/**
 * Intersects a world-space ray with the plane of the `mesh` triangle nearest the ray; hits even when the ray misses the mesh.
 *
 * @category bijection
 * @returns World-space hit with interpolated UV; null when the geometry lacks positions or UVs
 */
export function projectRayToMeshPlaneIntersection(
  ray: Ray,
  mesh: Mesh,
): Intersection | null {
  const geometry = mesh.geometry;

  const posAttr = geometry.getAttribute("position");
  const index = geometry.index;
  if (!posAttr || posAttr.count < 3) {
    return null;
  }

  const uvAttr = geometry.getAttribute("uv");
  if (!uvAttr) {
    return null;
  }

  if (!geometry.boundingSphere) {
    geometry.computeBoundingSphere();
  }
  _meshCenter.copy(geometry.boundingSphere!.center);
  mesh.localToWorld(_meshCenter);

  // Query point = mesh center projected onto the ray; picks the triangle the
  // ray points at, over the one closest to the ray origin.
  const projT = ray.direction.dot(_meshCenter.sub(ray.origin));
  ray.at(Math.max(0, projT), _localPoint);
  mesh.worldToLocal(_localPoint);

  const bvh = getOrCreateBvh(geometry);
  const hitInfo = { point: _closestPoint, distance: 0, faceIndex: 0 };
  const closestResult = bvh.closestPointToPoint(_localPoint, hitInfo);

  if (!closestResult) {
    return null;
  }

  const faceIndex = hitInfo.faceIndex;

  const idx0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
  const idx1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
  const idx2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

  _projTri.a.set(posAttr.getX(idx0), posAttr.getY(idx0), posAttr.getZ(idx0));
  _projTri.b.set(posAttr.getX(idx1), posAttr.getY(idx1), posAttr.getZ(idx1));
  _projTri.c.set(posAttr.getX(idx2), posAttr.getY(idx2), posAttr.getZ(idx2));

  _projTri.getPlane(_projTriPlane);

  _localRayOrigin.copy(ray.origin);
  mesh.worldToLocal(_localRayOrigin);
  _localRayDir.copy(ray.direction);
  _localRayDir.transformDirection(mesh.matrixWorld.clone().invert());

  const t = _projTriPlane.distanceToPoint(_localRayOrigin);
  const denom = _projTriPlane.normal.dot(_localRayDir);
  if (Math.abs(denom) < 1e-10) {
    // Ray parallel to plane: fall back to closest point
    _triPlaneIntersection.copy(_closestPoint);
  } else {
    const rayT = -t / denom;
    _triPlaneIntersection
      .copy(_localRayDir)
      .multiplyScalar(rayT)
      .add(_localRayOrigin);
  }

  // Point may lie outside the triangle; UV extrapolates along its plane.
  _projTri.getBarycoord(_triPlaneIntersection, _projBary);
  Triangle.getInterpolatedAttribute(
    uvAttr,
    idx0,
    idx1,
    idx2,
    _projBary,
    _projUv,
  );
  _projWorldPoint.copy(_triPlaneIntersection);
  mesh.localToWorld(_projWorldPoint);

  const distance = ray.origin.distanceTo(_projWorldPoint);

  return {
    distance,
    point: _projWorldPoint.clone(),
    object: mesh,
    faceIndex,
    uv: _projUv.clone(),
  };
}
