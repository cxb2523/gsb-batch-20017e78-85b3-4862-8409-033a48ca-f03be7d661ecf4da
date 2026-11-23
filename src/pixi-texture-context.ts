import { type Container, Point } from "pixi.js";
import { createContext, type RefObject, useContext } from "react";
import { type Object3D, type Vector2 } from "three";

import {
  mapPixiToUv as mapPixiToUvUtil,
  mapUvToPixi as mapUvToPixiUtil,
  type UvTrace,
} from "./bijections";
import { useViewport } from "./canvas-tree-context";
import { useCanvasView } from "./canvas-view-context";

/**
 * PixiTexture size, container, and coordinate mappings.
 * @internal
 */
export interface PixiTextureContextValue {
  width: number;
  height: number;
  containerRef: RefObject<Container>;
  /** Objects displaying this texture */
  getAttachedObjects: () => Object3D[];
  /** Hit-tests texture coords against the container tree; null on miss */
  hitTest: (x: number, y: number) => Container | null;
  mapUvToPixi: (uv: Vector2, out?: Point) => Point;
  mapPixiToParentUv: (point: Point, out?: Vector2) => Vector2;
  tracePixiToParentThreeLocal: (point: Point) => UvTrace[];
  tracePixiToParentThree: (point: Point) => UvTrace[];
  mapPixiToParentPixi: (point: Point, out?: Point) => Point[];
  mapPixiToViewport: (localPoint: Point, out?: Point) => Point[];
  mapPixiToClient: (localPoint: Point, out?: Point) => Point[];
  mapClientToPixi: (
    client: Point | { clientX: number; clientY: number },
    out?: Point,
  ) => Point | null;
  mapViewportToPixi: (viewport: Point, out?: Point) => Point | null;
}

/** @internal */
export const PixiTextureContext = createContext<PixiTextureContextValue | null>(
  null,
);

/** @internal */
export function usePixiTextureContext() {
  const context = useContext(PixiTextureContext);
  if (context === null) {
    throw Error(
      "usePixiTextureContext() must be called within a <PixiTexture />",
    );
  }
  return context;
}

/** @internal */
export function usePixiTextureContextOptional() {
  return useContext(PixiTextureContext);
}

/**
 * Mappings from PixiTexture coords to the parent Three scene.
 * Arrays hold one result per mesh position the point's UV hits.
 *
 * @category hook
 * @expand
 */
export interface PixiViewParentThreeContextValue {
  /** Traces onto attached meshes; position/normal in each `mesh`'s local coords */
  tracePixiToParentThreeLocal: (point: Point) => UvTrace[];
  /** Traces onto attached meshes; position/normal in parent world coords */
  tracePixiToParentThree: (point: Point) => UvTrace[];
  /** Maps to global coords of the parent Pixi scene; `out` receives the first result */
  mapPixiToParentPixi: (point: Point, out?: Point) => Point[];
}

/**
 * Pixi view coordinate mappings for a PixiTexture or CanvasView.
 * Pixi coords are local to the view.
 *
 * @category hook
 * @expand
 */
export interface PixiViewContextValue {
  width: number;
  height: number;
  /** Maps UV (0-1) to Pixi coords */
  mapUvToPixi: (uv: Vector2, out?: Point) => Point;
  /** Maps Pixi coords to UV (0-1) */
  mapPixiToUv: (point: Point, out?: Vector2) => Vector2;
  /**
   * Maps Pixi coords to CanvasView viewport coords; `out` receives the first result.
   * PixiTexture: one point per mesh position the UV hits. CanvasView: one point.
   */
  mapPixiToViewport: (localPoint: Point, out?: Point) => Point[];
  /** Maps Pixi coords to DOM client coords; array as in `mapPixiToViewport` */
  mapPixiToClient: (localPoint: Point, out?: Point) => Point[];
  /** Maps DOM client coords to Pixi coords; null on miss */
  mapClientToPixi: (
    client: Point | { clientX: number; clientY: number },
    out?: Point,
  ) => Point | null;
  /** Maps viewport coords to Pixi coords; null on miss */
  mapViewportToPixi: (viewport: Point, out?: Point) => Point | null;
  /** Present only inside a PixiTexture */
  parentThree?: PixiViewParentThreeContextValue;
}

/**
 * Pixi coordinate mappings for the nearest PixiTexture, else the CanvasView viewport.
 *
 * @category hook
 * @throws Error if called outside of a CanvasView
 */
export function usePixiViewContext(): PixiViewContextValue {
  const textureContext = useContext(PixiTextureContext);
  const viewport = useViewport();
  const { containerRef, mapViewportToClient, mapClientToViewport } =
    useCanvasView();

  if (textureContext) {
    return {
      width: textureContext.width,
      height: textureContext.height,
      mapUvToPixi: textureContext.mapUvToPixi,
      mapPixiToUv: textureContext.mapPixiToParentUv,
      mapPixiToViewport: textureContext.mapPixiToViewport,
      mapPixiToClient: textureContext.mapPixiToClient,
      mapClientToPixi: textureContext.mapClientToPixi,
      mapViewportToPixi: textureContext.mapViewportToPixi,
      parentThree: {
        tracePixiToParentThreeLocal: textureContext.tracePixiToParentThreeLocal,
        tracePixiToParentThree: textureContext.tracePixiToParentThree,
        mapPixiToParentPixi: textureContext.mapPixiToParentPixi,
      },
    };
  }

  const _viewportPoint = new Point();
  const bounds = { width: viewport.width, height: viewport.height };
  return {
    width: viewport.width,
    height: viewport.height,
    mapUvToPixi: (uv: Vector2, out?: Point) => mapUvToPixiUtil(uv, bounds, out),
    mapPixiToUv: (point: Point, out?: Vector2) =>
      mapPixiToUvUtil(point, bounds, out),
    mapPixiToViewport: (localPoint: Point, out?: Point) => {
      const result = out ?? new Point();
      containerRef.current.toGlobal(localPoint, result);
      return [result];
    },
    mapPixiToClient: (localPoint: Point, out?: Point) => {
      containerRef.current.toGlobal(localPoint, _viewportPoint);
      return [mapViewportToClient(_viewportPoint, out)];
    },
    mapClientToPixi: (
      client: Point | { clientX: number; clientY: number },
      out?: Point,
    ) => {
      mapClientToViewport(client, _viewportPoint);
      const result = out ?? new Point();
      containerRef.current.toLocal(_viewportPoint, undefined, result);
      return result;
    },
    mapViewportToPixi: (viewportPoint: Point, out?: Point) => {
      const result = out ?? new Point();
      containerRef.current.toLocal(viewportPoint, undefined, result);
      return result;
    },
  };
}
