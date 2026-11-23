import { extend, useApplication, useTick } from "@pixi/react";
import {
  type AttachType,
  createPortal,
  type DomEvent,
  type RootState,
} from "@react-three/fiber";
import { FiberProvider } from "its-fine";
import {
  Container,
  EventBoundary,
  type GpuTextureSystem,
  Point,
  Rectangle,
  RenderTexture,
  TextureSource,
} from "pixi.js";
import {
  Fragment,
  type PropsWithChildren,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ExternalTexture,
  type Intersection,
  Mesh,
  Scene,
  Texture,
  Vector2,
  Vector3,
} from "three";
import { texture } from "three/tsl";
import { type Object3D, type TextureNode } from "three/webgpu";

import {
  mapPixiToUv as mapPixiToUvUtil,
  mapUvToPixi as mapUvToPixiUtil,
  traceUvToThree,
  traceUvToThreeLocal,
} from "./bijections";
import {
  CanvasTreeContext,
  useCanvasTree,
  useCanvasTreeSize,
} from "./canvas-tree-context";
import { useCanvasView } from "./canvas-view-context";
import { PixiTextureContext } from "./pixi-texture-context";
import { useRenderContext } from "./render-context-hooks";
import { computeParent, useAttachedObjects } from "./three-fiber";
import {
  type ThreeSceneContextValue,
  useThreeSceneContext,
} from "./three-scene-context";
import { useLazyRef } from "./use-lazy-ref";
import {
  PixiEventsContext,
  usePixiEventDispatch,
} from "./use-pixi-event-dispatch";
import { useRenderSchedule } from "./use-render-schedule";

extend({ Container });

/**
 * @internal
 */
export function PixiTextureRenderer() {
  const { pixiTextureTunnel, pixiEvents } = useRenderContext();
  return (
    <pixiContainer renderable={false}>
      <PixiEventsContext value={pixiEvents}>
        <pixiTextureTunnel.Out />
      </PixiEventsContext>
    </pixiContainer>
  );
}

/**
 * See {@link PixiTexture}.
 *
 * @category component
 * @expand
 */
export interface PixiTextureProps extends PropsWithChildren {
  /**
   * {@link https://threejs.org/docs/#TextureNode | TextureNode} Ref
   */
  ref?: Ref<TextureNode>;
  /**
   * Pixi {@link https://pixijs.download/release/docs/scene.Container.html | Container} Ref
   */
  containerRef?: Ref<Container>;
  /**
   * {@link https://threejs.org/docs/#Object3D | Object3D}s whose UVs map events onto this texture,
   * default nearest ancestor Object3D. Raycasts exactly these objects; null hits nothing.
   * An array shares the texture across meshes.
   */
  objectRef?: RefObject<Object3D | Object3D[] | null>;
  /**
   * TextureNode {@link https://r3f.docs.pmnd.rs/api/objects#attach | React Three Fiber attach}
   */
  attach?: AttachType;
  /** Texture width */
  width: number;
  /** Texture height */
  height: number;
  /** Frameloop, default "demand" */
  frameloop?: "always" | "demand";
  /** FPS limit */
  fpsLimit?: number;
  /** Event handling, default true */
  events?: boolean;
  /** Event priority, default 0 */
  eventPriority?: number;
  /** Event filter; false treats the pointer as off the texture */
  eventGuard?: PixiTextureEventGuard;
  /**
   * {@link https://r3f.docs.pmnd.rs/api/events | React Three Fiber}-style handler for pointer clicks that miss all interactive Pixi children
   */
  onPointerMissed?: (event: PointerEvent) => void;
}

/**
 * @category component
 * @inline
 */
export type PixiTextureEventGuard = (args: PixiTextureEventData) => boolean;

/** @category component */
export interface PixiTextureEventData {
  intersections: Intersection[];
}

/**
 * A {@link https://threejs.org/docs/#TextureNode | Three TextureNode}
 * rendering {@link https://react.pixijs.io/components/pixi-components | React Pixi} children.
 * Must be inside a {@link ThreeScene}.
 *
 * @category component
 * @example
 * ```tsx
 * <RenderContext>
 *   <CanvasView>
 *     <ThreeScene>
 *       <mesh>
 *         <boxGeometry />
 *         <meshBasicMaterial>
 *           <PixiTexture attach="map" width={512} height={512}>
 *             <SpinnyStar />
 *           </PixiTexture>
 *         </meshBasicMaterial>
 *       </mesh>
 *     </ThreeScene>
 *   </CanvasView>
 * </RenderContext>
 * ```
 */
export function PixiTexture({
  ref,
  containerRef,
  objectRef,
  attach,
  children,
  width,
  height,
  frameloop,
  fpsLimit,
  events,
  eventPriority,
  eventGuard,
  onPointerMissed,
}: PixiTextureProps) {
  const { pixiTextureTunnel } = useRenderContext();
  const parentThreeSceneContext = useThreeSceneContext();

  const getAttachedObjects = useAttachedObjects(objectRef);

  const [textureNode] = useState(() => texture(new Texture()));
  // Pixi side swaps `value` on this same node
  const textureRef = useRef(textureNode);

  useEffect(
    () => () => {
      textureNode.dispose();
    },
    [textureNode],
  );

  useImperativeHandle(ref, () => textureNode);

  return (
    <>
      <pixiTextureTunnel.In>
        <FiberProvider>
          <PixiTextureInternal
            parentThreeSceneContext={parentThreeSceneContext}
            getAttachedObjects={getAttachedObjects}
            textureRef={textureRef}
            containerRef={containerRef}
            width={width}
            height={height}
            frameloop={frameloop}
            fpsLimit={fpsLimit}
            events={events}
            eventPriority={eventPriority}
            eventGuard={eventGuard}
            onPointerMissed={onPointerMissed}
          >
            {children}
          </PixiTextureInternal>
        </FiberProvider>
      </pixiTextureTunnel.In>
      <primitive object={textureNode} attach={attach} />
    </>
  );
}

interface PixiTextureInternalProps extends Omit<
  PixiTextureProps,
  "ref" | "objectRef" | "attach"
> {
  parentThreeSceneContext: ThreeSceneContextValue;
  getAttachedObjects: () => Object3D[];
  textureRef: RefObject<TextureNode>;
}

function PixiTextureInternal({
  parentThreeSceneContext,
  getAttachedObjects,
  containerRef: containerRefProp,
  children,
  textureRef,
  width,
  height,
  frameloop,
  fpsLimit,
  events,
  eventPriority,
  eventGuard,
  onPointerMissed,
}: PixiTextureInternalProps) {
  const app = useApplication();
  const { canvasRef } = useCanvasView();

  const containerRef = useRef<Container>(null!);
  const pixiTextureRef = useLazyRef(() => new RenderTexture());

  const [eventScene] = useState(() => new Scene());
  const dispatchEvent = usePixiEventDispatch({
    containerRef,
    canvasRef,
  });

  const wasOverRef = useRef(false);
  const _point = new Point();

  function computeFn(event: DomEvent, _state: RootState, previous?: RootState) {
    if (!previous) return false;

    // Parent miss ends a hover in progress
    if (!computeParent(event, previous)) {
      if (wasOverRef.current) {
        dispatchEvent(event, null);
        wasOverRef.current = false;
      }
      return false;
    }

    const intersections = previous.raycaster.intersectObjects(
      getAttachedObjects(),
      false,
    );
    const testGuard = eventGuard?.({ intersections }) ?? true;
    const [intersection] = intersections;
    const uv = intersection?.uv;
    if (uv) {
      mapUvToPixi(uv, _point);
    }

    const isOver = !!(uv && testGuard);
    const point: Point | null = isOver ? _point : null;

    // null after a hover drives pointerout/pointerleave
    if (isOver || wasOverRef.current) {
      dispatchEvent(event, point, onPointerMissed);
    }

    wasOverRef.current = isOver;

    return false;
  }

  const { isFrameRequested, invalidate, signalFrame } = useRenderSchedule({
    fpsLimit,
  });

  function render() {
    app.app.renderer.render({
      container: containerRef.current,
      target: pixiTextureRef.current,
      label: "pixi-texture",
    });
  }

  useTick({
    callback: () => {
      if (frameloop === "always" || isFrameRequested()) {
        render();
        signalFrame();
      }
    },
  });

  const canvasTree = useCanvasTree(invalidate);
  useCanvasTreeSize(canvasTree, { width, height, resolution: 1 });

  useImperativeHandle(containerRefProp, () => containerRef.current);

  // r3f portals capture event compute closures beyond the render that
  // created them; route bounds through a ref so stale closures still map
  // coordinates with the current size
  const boundsRef = useRef({ width, height });
  useLayoutEffect(() => {
    boundsRef.current = { width, height };
  }, [width, height]);

  // Sole owner of the render texture and its external texture: each cleanup
  // releases exactly what its own setup created, so StrictMode/Activity
  // remounts destroy and recreate within one commit without double-destroying
  useLayoutEffect(() => {
    const renderTexture = new RenderTexture({
      source: new TextureSource({ width, height, autoGarbageCollect: false }),
    });
    const gpuTexture = (
      app.app.renderer.texture as GpuTextureSystem
    ).getGpuSource(renderTexture._source);
    const externalTexture = new ExternalTexture(gpuTexture);

    // Swap before releasing so no consumer sees a destroyed texture
    const staleRenderTexture = pixiTextureRef.current;
    const staleValue = textureRef.current.value;
    pixiTextureRef.current = renderTexture;
    textureRef.current.value = externalTexture;
    // Earlier generations are released by their own cleanups; only the
    // first-mount placeholders have no owner
    if (!(staleValue instanceof ExternalTexture)) {
      staleValue.dispose();
    }
    if (!staleRenderTexture.destroyed) {
      staleRenderTexture.destroy(true);
    }

    // Demand frameloop: fill the new texture on the next tick
    invalidate();

    return () => {
      externalTexture.dispose();
      renderTexture.destroy(true);
    };
  }, [
    app.app.renderer.texture,
    height,
    invalidate,
    pixiTextureRef,
    textureRef,
    width,
  ]);

  const localEventBoundaryRef = useLazyRef(() => new EventBoundary());
  function hitTest(x: number, y: number) {
    const boundary = localEventBoundaryRef.current;
    boundary.rootTarget = containerRef.current;
    return boundary.hitTest(x, y);
  }

  function mapUvToPixi(uv: Vector2, out?: Point) {
    return mapUvToPixiUtil(uv, boundsRef.current, out);
  }

  function mapPixiToParentUv(point: Point, out?: Vector2) {
    return mapPixiToUvUtil(point, boundsRef.current, out);
  }

  const _uv = new Vector2();

  function tracePixiToParentThreeLocal(point: Point) {
    mapPixiToParentUv(point, _uv);

    return getAttachedObjects().flatMap((object) =>
      object instanceof Mesh ? traceUvToThreeLocal(_uv, object) : [],
    );
  }

  function tracePixiToParentThree(point: Point) {
    mapPixiToParentUv(point, _uv);

    return getAttachedObjects().flatMap((object) =>
      object instanceof Mesh ? traceUvToThree(_uv, object) : [],
    );
  }

  const _threeParent = new Vector3();

  function projectTrace(
    point: Point,
    out: Point | undefined,
    project: (vec: Vector3, target: Point) => boolean,
  ) {
    const points: Point[] = [];
    for (const result of tracePixiToParentThree(point)) {
      // `out` receives the first successful projection
      const target = points.length === 0 && out ? out : new Point();
      _threeParent.copy(result.position);
      if (project(_threeParent, target)) {
        points.push(target);
      }
    }
    return points;
  }

  function mapPixiToParentPixi(point: Point, out?: Point) {
    return projectTrace(
      point,
      out,
      (vec, target) =>
        parentThreeSceneContext.mapThreeToParentPixi(vec, target) !== null,
    );
  }

  function mapPixiToViewport(localPoint: Point, out?: Point) {
    return projectTrace(
      localPoint,
      out,
      (vec, target) =>
        parentThreeSceneContext.mapThreeToViewport(vec, target).length > 0,
    );
  }

  function mapPixiToClient(localPoint: Point, out?: Point) {
    return projectTrace(
      localPoint,
      out,
      (vec, target) =>
        parentThreeSceneContext.mapThreeToClient(vec, target).length > 0,
    );
  }

  function mapClientToPixi(
    client: Point | { clientX: number; clientY: number },
    out?: Point,
  ) {
    const intersections = parentThreeSceneContext.raycastClient(
      client,
      getAttachedObjects(),
      false,
    );
    const uv = intersections[0]?.uv;
    if (uv) {
      const result = out ?? new Point();
      mapUvToPixi(uv, result);
      return result;
    }
    return null;
  }

  function mapViewportToPixi(viewport: Point, out?: Point) {
    const intersections = parentThreeSceneContext.raycastViewport(
      viewport,
      getAttachedObjects(),
      false,
    );
    const uv = intersections[0]?.uv;
    if (uv) {
      const result = out ?? new Point();
      mapUvToPixi(uv, result);
      return result;
    }
    return null;
  }

  const key = useId();

  return (
    <>
      {events !== false && (
        <parentThreeSceneContext.sceneTunnel.In>
          <Fragment key={key}>
            {/* eslint-disable-next-line react-hooks/refs -- computeFn accesses refs only when called during event handling */}
            {createPortal(<group onPointerOver={() => null} />, eventScene, {
              events: {
                compute: computeFn,
                priority: eventPriority ?? 0,
              },
            })}
          </Fragment>
        </parentThreeSceneContext.sceneTunnel.In>
      )}
      <CanvasTreeContext value={canvasTree}>
        <PixiTextureContext
          value={{
            width,
            height,
            containerRef,
            getAttachedObjects,
            hitTest,
            mapUvToPixi,
            mapPixiToParentUv,
            tracePixiToParentThreeLocal,
            tracePixiToParentThree,
            mapPixiToParentPixi,
            mapPixiToViewport,
            mapPixiToClient,
            mapClientToPixi,
            mapViewportToPixi,
          }}
        >
          <pixiContainer
            ref={containerRef}
            width={width}
            height={height}
            hitArea={new Rectangle(0, 0, width, height)}
          >
            {children}
          </pixiContainer>
        </PixiTextureContext>
      </CanvasTreeContext>
    </>
  );
}
