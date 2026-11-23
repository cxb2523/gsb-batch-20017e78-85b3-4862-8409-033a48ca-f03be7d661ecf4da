import type { FiberTunnel } from "fiber-tunnel";
import { type Container, type Point } from "pixi.js";
import { createContext, type RefObject, useContext } from "react";
import {
  type Intersection,
  type Object3D,
  type Plane,
  type Vector2,
  type Vector3,
} from "three";

import { type UvTrace } from "./bijections";

/**
 * Intersection result for Plane raycasts.
 * @category hook
 */
export interface PlaneIntersection {
  distance: number;
  point: Vector3;
  object: Plane;
}

/**
 * Intersection type for a raycast target.
 * @internal
 */
export type RaycastResult<T> = T extends Plane
  ? PlaneIntersection
  : T extends (infer U)[]
    ? U extends Object3D
      ? Intersection<U>
      : Intersection<Object3D>
    : T extends Object3D
      ? Intersection<T>
      : Intersection<Object3D>;

/**
 * Mappings from ThreeRenderTexture world coords to the parent Three scene.
 * Arrays hold one result per mesh position the projected UV hits.
 *
 * @category hook
 * @expand
 */
export interface ThreeViewParentThreeContextValue {
  /** Projects through the camera to render-texture UV */
  mapThreeToParentUv: (vec3: Vector3, out?: Vector2) => Vector2;
  /** Traces onto attached meshes; position/normal in each `mesh`'s local coords */
  traceThreeToParentThreeLocal: (vec3: Vector3) => UvTrace[];
  /** Traces onto attached meshes; position/normal in parent world coords */
  traceThreeToParentThree: (vec3: Vector3) => UvTrace[];
}

/**
 * Three view coordinate mappings for a ThreeScene or ThreeRenderTexture.
 * Three coords are world coords; Pixi coords are local to the scene sprite.
 * Methods return null or empty after the scene sprite is destroyed (teardown).
 *
 * @category hook
 * @expand
 */
export interface ThreeSceneContextValue {
  /** @internal */
  containerRef: RefObject<Container>;
  /** @internal */
  sceneTunnel: FiberTunnel;
  /** Maps Pixi coords to NDC (-1 to 1) */
  mapPixiToNdc: (point: Point, out?: Vector2) => Vector2 | null;
  /** Maps NDC (-1 to 1) to Pixi coords */
  mapNdcToPixi: (ndc: Vector2, out?: Point) => Point | null;
  /**
   * Maps to scene sprite local coords.
   * ThreeRenderTexture: maps through the first parent trace; null when off every attached surface.
   */
  mapThreeToParentPixiLocal: (vec3: Vector3, out?: Point) => Point | null;
  /**
   * Maps to global Pixi parent coords.
   * ThreeRenderTexture: maps through the first parent trace; null when off every attached surface.
   */
  mapThreeToParentPixi: (vec3: Vector3, out?: Point) => Point | null;
  /** Maps to CanvasView viewport coords; `out` receives the first result */
  mapThreeToViewport: (vec3: Vector3, out?: Point) => Point[];
  /** Maps to DOM client coords; `out` receives the first result */
  mapThreeToClient: (vec3: Vector3, out?: Point) => Point[];
  /** Maps DOM client coords to NDC; null on texture miss */
  mapClientToNdc: (
    client: Point | { clientX: number; clientY: number },
    out?: Vector2,
  ) => Vector2 | null;
  /** Maps viewport coords to NDC; null on texture miss */
  mapViewportToNdc: (viewport: Point, out?: Vector2) => Vector2 | null;
  /**
   * Raycasts from NDC through the camera.
   * @param target - Object(s) or plane to intersect. Default, scene children.
   * @param recursive - Traverse children. Default true.
   */
  raycastNdc: <T extends Object3D | Plane | Object3D[] = Object3D>(
    ndc: Vector2,
    target?: T,
    recursive?: boolean,
  ) => RaycastResult<T>[];
  /** Raycasts from DOM client coords; see `raycastNdc` */
  raycastClient: <T extends Object3D | Plane | Object3D[] = Object3D>(
    client: Point | { clientX: number; clientY: number },
    target?: T,
    recursive?: boolean,
  ) => RaycastResult<T>[];
  /** Raycasts from viewport coords; see `raycastNdc` */
  raycastViewport: <T extends Object3D | Plane | Object3D[] = Object3D>(
    viewport: Point,
    target?: T,
    recursive?: boolean,
  ) => RaycastResult<T>[];
  /** Present only inside a ThreeRenderTexture */
  parentThree?: ThreeViewParentThreeContextValue;
}

/** @internal */
export const ThreeSceneContext = createContext<ThreeSceneContextValue | null>(
  null,
);

/**
 * Coordinate mappings and raycasts for the nearest ThreeScene.
 *
 * @category hook
 * @throws Error if called outside of a ThreeScene
 */
export function useThreeSceneContext() {
  const context = useContext(ThreeSceneContext);
  if (context === null) {
    throw Error(
      "useThreeSceneContext() must be called within a <ThreeScene />",
    );
  }
  return context;
}

/** @internal */
export function useThreeSceneContextOptional() {
  return useContext(ThreeSceneContext);
}
