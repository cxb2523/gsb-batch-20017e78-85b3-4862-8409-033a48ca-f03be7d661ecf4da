import {
  extend,
  type PixiReactElementProps,
  useApplication,
} from "@pixi/react";
import {
  type ComputeFunction,
  createPortal,
  type DomEvent,
  type RootState,
  useThree,
} from "@react-three/fiber";
import { type FiberTunnel, fiberTunnel } from "fiber-tunnel";
import { FiberProvider } from "its-fine";
import {
  type Application,
  Container,
  ExternalSource,
  type IHitArea,
  Point,
  type Renderer,
  Sprite,
  Texture,
} from "pixi.js";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Mesh,
  type Object3D,
  type Plane,
  Raycaster,
  type RenderTargetOptions,
  Scene,
  Vector2,
  Vector3,
} from "three";
import { type PostProcessing } from "three/webgpu";

import {
  mapNdcToPixi as mapNdcToPixiUtil,
  mapPixiToNdc as mapPixiToNdcUtil,
  mapThreeToNdc,
  projectRayToMeshPlaneIntersection,
} from "./bijections";
import { useViewport } from "./canvas-tree-context";
import {
  CanvasTreeContext,
  useCanvasTree,
  useCanvasTreeSize,
} from "./canvas-tree-context";
import { useCanvasView } from "./canvas-view-context";
import {
  type PixiTextureContextValue,
  usePixiTextureContextOptional,
  usePixiViewContext,
} from "./pixi-texture-context";
import { useRenderContext } from "./render-context-hooks";
import { computeParent } from "./three-fiber";
import { PortalContent } from "./three-portal-content";
import {
  type RaycastResult,
  ThreeSceneContext,
  useThreeSceneContextOptional,
} from "./three-scene-context";
import { useLazyRef } from "./use-lazy-ref";
import { useRenderSchedule } from "./use-render-schedule";

extend({ Container, Sprite });

function createSprite(renderer: Renderer) {
  const sprite = new Sprite({ eventMode: "static" });
  sprite.texture = new Texture({
    dynamic: true,
    source: new ExternalSource({
      renderer,
      label: "three-scene",
    }),
  });
  return sprite;
}

/** The sprite, or null when unmounted or destroyed */
function liveSprite(spriteRef: RefObject<Sprite | null>) {
  const sprite = spriteRef.current;
  return sprite && !sprite.destroyed ? sprite : null;
}

/** Whether any r3f object holds capture of this pointer */
function isPointerCaptured(state: RootState, pointerId: number) {
  return (state.internal.pointerMap.get(pointerId)?.captured.size ?? 0) > 0;
}

/** Maps sprite-local Pixi coords to the scene's NDC */
function spritePixiToNdc(
  spriteRef: RefObject<Sprite | null>,
  point: Point,
  out?: Vector2,
) {
  const sprite = liveSprite(spriteRef);
  if (!sprite) {
    return null;
  }
  return mapPixiToNdcUtil(point, sprite.getLocalBounds(), out);
}

/** Maps the scene's NDC to sprite-local Pixi coords */
function spriteNdcToPixi(
  spriteRef: RefObject<Sprite | null>,
  ndc: Vector2,
  out?: Point,
) {
  const sprite = liveSprite(spriteRef);
  if (!sprite) {
    return null;
  }
  return mapNdcToPixiUtil(ndc, sprite.getLocalBounds(), out);
}

/**
 * @internal
 */
export function ThreeSceneRenderer() {
  const { threeSceneTunnel } = useRenderContext();
  return <threeSceneTunnel.Out />;
}

/**
 * See {@link ThreeScene}.
 *
 * @category component
 * @expand
 */
export type ThreeSceneProps = PixiReactElementProps & ThreeSceneBaseProps;

/**
 * See {@link ThreeScene}.
 *
 * @category component
 * @expand
 */
export interface ThreeSceneBaseProps {
  /** Texture width; defaults to canvas parent bounds */
  width?: number;
  /** Texture height; defaults to canvas parent bounds */
  height?: number;
  /** Texture resolution; defaults to canvas parent resolution */
  resolution?: number;
  /** {@link https://threejs.org/docs/#WebGLRenderTarget | RenderTarget} options */
  renderTargetOptions?: RenderTargetOptions;
  /** Event priority; defaults to 0 */
  eventPriority?: number;
  /** Frameloop mode; defaults to "always" */
  frameloop?: "always" | "demand";
  /**
   * {@link https://r3f.docs.pmnd.rs/api/events | React Three Fiber Events} compute; replaces the built-in sprite mapping
   */
  eventCompute?: ComputeFunction;
  /**
   * {@link https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/display/PostProcessing.js | PostProcessing} factory
   */
  postProcessing?: (x: RootState) => PostProcessing;
  /** FPS limit */
  fpsLimit?: number;
  /**
   * {@link https://r3f.docs.pmnd.rs/api/events | React Three Fiber}-style handler for clicks that miss every Three.js object in this scene
   */
  onPointerMissed?: (event: MouseEvent) => void;
  /** Three.js content, portaled into this scene */
  children: ReactNode;
}

/**
 * A {@link https://pixijs.download/release/docs/scene.Sprite.html | Pixi Sprite} rendering a
 * {@link https://threejs.org/docs/#Scene | Three.js} scene of
 * {@link https://r3f.docs.pmnd.rs/getting-started/introduction | React Three Fiber} children.
 * Must be inside a {@link CanvasView}.
 *
 * @category component
 * @param props - Also accepts {@link https://github.com/pixijs/pixi-react/blob/main/src/typedefs/PixiReactNode.ts | PixiReactElementProps}
 * @expandType ThreeSceneBaseProps
 * @example
 * ```tsx
 * <RenderContext>
 *   <CanvasView>
 *     <ThreeScene>
 *       <SpinnyCube /> // Three.js Object
 *     </ThreeScene>
 *     <SpinnyStar /> // Pixi.js Graphic
 *   </CanvasView>
 * </RenderContext>
 * ```
 */
export function ThreeScene({
  ref,
  width,
  height,
  resolution,
  renderTargetOptions,
  eventPriority,
  frameloop,
  eventCompute,
  postProcessing,
  fpsLimit,
  onPointerMissed,
  children,
  ...props
}: ThreeSceneProps) {
  const containerRef = useRef<Container>(null!);

  useImperativeHandle(ref, () => containerRef.current);

  return (
    <pixiContainer {...props} ref={containerRef}>
      <ThreeSceneSprite
        containerRef={containerRef}
        width={width}
        height={height}
        resolution={resolution}
        renderTargetOptions={renderTargetOptions}
        eventPriority={eventPriority}
        frameloop={frameloop}
        eventCompute={eventCompute}
        postProcessing={postProcessing}
        fpsLimit={fpsLimit}
        onPointerMissed={onPointerMissed}
      >
        {children}
      </ThreeSceneSprite>
    </pixiContainer>
  );
}

interface ThreeSceneSpriteProps extends ThreeSceneBaseProps {
  /** Container that adopts the sprite */
  containerRef: RefObject<Container>;
}

function ThreeSceneSprite(props: ThreeSceneSpriteProps) {
  const { app } = useApplication();
  const { threeSceneTunnel } = useRenderContext();
  const pixiTextureContext = usePixiTextureContextOptional();
  const parentThreeSceneContext = useThreeSceneContextOptional();

  const sprite = (
    <FiberProvider>
      <ThreeSceneSpriteInternal
        app={app}
        pixiTextureContext={pixiTextureContext}
        {...props}
      />
    </FiberProvider>
  );
  return parentThreeSceneContext ? (
    <parentThreeSceneContext.sceneTunnel.In>
      {sprite}
    </parentThreeSceneContext.sceneTunnel.In>
  ) : (
    <threeSceneTunnel.In>{sprite}</threeSceneTunnel.In>
  );
}

interface ThreeSceneSpriteInternalProps extends ThreeSceneSpriteProps {
  app: Application<Renderer>;
  /** Enclosing PixiTexture; null when rendered directly to a CanvasView */
  pixiTextureContext: PixiTextureContextValue | null;
}

function ThreeSceneSpriteInternal({
  containerRef,
  app,
  pixiTextureContext,
  width: widthProp,
  height: heightProp,
  resolution: resolutionProp,
  renderTargetOptions,
  eventPriority = 0,
  frameloop = "always",
  eventCompute,
  postProcessing,
  fpsLimit,
  onPointerMissed,
  children,
}: ThreeSceneSpriteInternalProps) {
  const {
    canvasRef,
    canvas,
    containerRef: canvasContainerRef,
  } = useCanvasView();
  const size = useViewport();
  const [scene] = useState(() => new Scene());

  const width = widthProp ?? size.width;
  const height = heightProp ?? size.height;
  const resolution = resolutionProp ?? size.resolution;
  const { isFrameRequested, invalidate, signalFrame } = useRenderSchedule({
    fpsLimit,
  });
  const canvasTree = useCanvasTree(invalidate);
  useCanvasTreeSize(canvasTree, { width, height, resolution });

  const hitAreaRef = useRef<IHitArea | null>(null);
  const spriteRef = useRef<Sprite | null>(null);
  // Last attached mesh hit per live or captured pointer;
  // captured drags extend its plane
  const lastHitsRef = useLazyRef(() => new Map<number, Mesh>());

  // Sole sprite owner. StrictMode/Activity remounts destroy and recreate
  // within one commit; consumers only see a live sprite or null.
  useLayoutEffect(() => {
    const sprite = createSprite(app.renderer);
    sprite.setSize(width, height);
    sprite.hitArea = hitAreaRef.current;
    spriteRef.current = sprite;
    // ExternalSource starts at 1x1; frameloop="demand" schedules
    // no other frame after a remount
    invalidate();
    return () => {
      spriteRef.current = null;
      if (!sprite.destroyed) {
        sprite.destroy({ texture: true, textureSource: true });
      }
    };
    // onTextureUpdate re-applies size; width/height stay out of deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.renderer]);

  // Adopt the sprite into the (possibly remounted) container on every commit
  useLayoutEffect(() => {
    const sprite = spriteRef.current;
    const container = containerRef.current;
    if (sprite && container && sprite.parent !== container) {
      container.addChild(sprite);
    }
  });

  function onTextureUpdate(texture: GPUTexture) {
    const sprite = liveSprite(spriteRef);
    if (!sprite) {
      return;
    }
    (sprite.texture.source as ExternalSource).updateGPUTexture(texture);
    // texture.orig tracks render target pixel size; setSize no-ops when unchanged
    sprite.setSize(width, height);
  }

  const clientPos = new Point();
  const globalPos = new Point();
  const localPos = new Point();

  function computeFn(event: DomEvent, state: RootState, previous?: RootState) {
    const sprite = liveSprite(spriteRef);
    if (!sprite) {
      return false;
    }
    const pointerId = (event as PointerEvent).pointerId;
    const isCaptured =
      pointerId !== undefined && isPointerCaptured(state, pointerId);

    if (pixiTextureContext) {
      if (!previous) {
        return false;
      }
      // Parent miss leaves its ray stale; parent ThreeScenes stay hit while captured
      if (!computeParent(event, previous)) {
        return false;
      }
      const lastHits = lastHitsRef.current;
      for (const id of lastHits.keys()) {
        if (id !== pointerId && !isPointerCaptured(state, id)) {
          lastHits.delete(id);
        }
      }
      // Captured drags stay on the mesh where capture began
      const capturedMesh = isCaptured ? lastHits.get(pointerId) : undefined;
      const [intersection] = previous.raycaster.intersectObjects(
        capturedMesh ? [capturedMesh] : pixiTextureContext.getAttachedObjects(),
        false,
      );
      if (intersection?.uv) {
        if (pointerId !== undefined && intersection.object instanceof Mesh) {
          lastHits.set(pointerId, intersection.object);
        }
        pixiTextureContext.mapUvToPixi(intersection.uv, globalPos);
      } else if (capturedMesh) {
        const extendedIntersection = projectRayToMeshPlaneIntersection(
          previous.raycaster.ray,
          capturedMesh,
        );
        if (!extendedIntersection?.uv) {
          return false;
        }
        pixiTextureContext.mapUvToPixi(extendedIntersection.uv, globalPos);
      } else {
        return false;
      }
      if (
        !isCaptured &&
        sprite !== pixiTextureContext.hitTest(globalPos.x, globalPos.y)
      ) {
        return false;
      }
    } else {
      const rect = canvasRef.current.getBoundingClientRect();
      clientPos.x = event.clientX - rect.left;
      clientPos.y = event.clientY - rect.top;
      // eslint-disable-next-line react-hooks/immutability
      app.renderer.events.rootBoundary.rootTarget = canvasContainerRef.current;
      canvasContainerRef.current.toGlobal(clientPos, globalPos);
      if (
        !isCaptured &&
        sprite !==
          app.renderer.events.rootBoundary.hitTest(globalPos.x, globalPos.y)
      ) {
        return false;
      }
    }

    sprite.toLocal(globalPos, undefined, localPos);
    spritePixiToNdc(spriteRef, localPos, state.pointer);
    state.raycaster.setFromCamera(state.pointer, state.camera);
  }

  const [sceneTunnel] = useState(() => fiberTunnel());

  function setHitArea(
    hitArea: { contains(x: number, y: number): boolean } | null,
  ) {
    // Ref lets a recreated sprite restore it
    hitAreaRef.current = hitArea && {
      contains(x: number, y: number): boolean {
        // Local coords span the texture's pixel size (width * resolution)
        return hitArea.contains(
          x / width / resolution,
          y / height / resolution,
        );
      },
    };
    const sprite = liveSprite(spriteRef);
    if (sprite) {
      sprite.hitArea = hitAreaRef.current;
    }
  }

  return (
    <CanvasTreeContext value={canvasTree}>
      {createPortal(
        <PortalContent
          width={width}
          height={height}
          resolution={resolution}
          renderTargetOptions={renderTargetOptions}
          onTextureUpdate={onTextureUpdate}
          postProcessing={postProcessing}
          frameloop={frameloop}
          isFrameRequested={isFrameRequested}
          signalFrame={signalFrame}
        >
          <ThreeSceneContextProvider
            containerRef={containerRef}
            sceneTunnel={sceneTunnel}
            spriteRef={spriteRef}
          >
            <HitAreaSetup setHitArea={setHitArea} />
            {children}
            <sceneTunnel.Out />
          </ThreeSceneContextProvider>
          {/* r3f runs portal compute (and updates state.pointer) only via its interactive objects */}
          <group onPointerOver={() => null} />
        </PortalContent>,
        scene,
        // computeFn reads refs; r3f calls it on events only
        // eslint-disable-next-line react-hooks/refs
        {
          events: {
            compute: eventCompute ?? computeFn,
            priority: eventPriority,
            connected: canvas ?? undefined,
          },
          size: { top: 0, left: 0, width, height },
          onPointerMissed,
        },
      )}
    </CanvasTreeContext>
  );
}

interface ThreeSceneContextProviderProps {
  containerRef: RefObject<Container>;
  sceneTunnel: FiberTunnel;
  spriteRef: RefObject<Sprite | null>;
  children: ReactNode;
}

function ThreeSceneContextProvider({
  containerRef,
  sceneTunnel,
  spriteRef,
  children,
}: ThreeSceneContextProviderProps) {
  const { camera, scene } = useThree();

  function mapPixiToNdc(point: Point, out?: Vector2) {
    return spritePixiToNdc(spriteRef, point, out);
  }

  function mapNdcToPixi(ndc: Vector2, out?: Point) {
    return spriteNdcToPixi(spriteRef, ndc, out);
  }

  const pixiViewContext = usePixiViewContext();
  const [raycaster] = useState(() => new Raycaster());

  const _ndc = new Vector2();
  const _localPos = new Point();

  function mapThreeToParentPixiLocal(vec3: Vector3, out?: Point) {
    mapThreeToNdc(vec3, camera, _ndc);
    return mapNdcToPixi(_ndc, out);
  }

  function mapThreeToParentPixi(vec3: Vector3, out?: Point) {
    const sprite = liveSprite(spriteRef);
    if (!sprite || !mapThreeToParentPixiLocal(vec3, _localPos)) {
      return null;
    }
    const result = out ?? new Point();
    sprite.toGlobal(_localPos, result);
    return result;
  }

  function mapThreeToViewport(vec3: Vector3, out?: Point) {
    if (!mapThreeToParentPixi(vec3, _localPos)) {
      return [];
    }
    return pixiViewContext.mapPixiToViewport(_localPos, out);
  }

  function mapThreeToClient(vec3: Vector3, out?: Point) {
    if (!mapThreeToParentPixi(vec3, _localPos)) {
      return [];
    }
    return pixiViewContext.mapPixiToClient(_localPos, out);
  }

  function mapClientToNdc(
    client: Point | { clientX: number; clientY: number },
    out?: Vector2,
  ) {
    const pixiResult = pixiViewContext.mapClientToPixi(client, _localPos);
    const sprite = liveSprite(spriteRef);
    if (!pixiResult || !sprite) return null;
    sprite.toLocal(_localPos, undefined, _localPos);
    return mapPixiToNdc(_localPos, out);
  }

  function mapViewportToNdc(viewport: Point, out?: Vector2) {
    const pixiResult = pixiViewContext.mapViewportToPixi(viewport, _localPos);
    const sprite = liveSprite(spriteRef);
    if (!pixiResult || !sprite) return null;
    sprite.toLocal(_localPos, undefined, _localPos);
    return mapPixiToNdc(_localPos, out);
  }

  function raycastNdc<T extends Object3D | Plane | Object3D[] = Object3D>(
    ndc: Vector2,
    target?: T,
    recursive?: boolean,
  ): RaycastResult<T>[] {
    raycaster.setFromCamera(ndc, camera);
    if (target) {
      if (Array.isArray(target)) {
        return raycaster.intersectObjects(
          target,
          recursive,
        ) as RaycastResult<T>[];
      } else if ("isPlane" in target) {
        const point = new Vector3();
        const hit = raycaster.ray.intersectPlane(target as Plane, point);
        if (hit) {
          return [
            {
              distance: raycaster.ray.origin.distanceTo(point),
              point,
              object: target,
            } as RaycastResult<T>,
          ];
        }
        return [];
      } else {
        return raycaster.intersectObject(
          target,
          recursive,
        ) as RaycastResult<T>[];
      }
    }
    return raycaster.intersectObjects(
      scene.children,
      recursive,
    ) as RaycastResult<T>[];
  }

  function raycastClient<T extends Object3D | Plane | Object3D[] = Object3D>(
    client: Point | { clientX: number; clientY: number },
    target?: T,
    recursive?: boolean,
  ): RaycastResult<T>[] {
    if (!mapClientToNdc(client, _ndc)) {
      return [];
    }
    return raycastNdc(_ndc, target, recursive);
  }

  function raycastViewport<T extends Object3D | Plane | Object3D[] = Object3D>(
    viewport: Point,
    target?: T,
    recursive?: boolean,
  ): RaycastResult<T>[] {
    if (!mapViewportToNdc(viewport, _ndc)) {
      return [];
    }
    return raycastNdc(_ndc, target, recursive);
  }

  return (
    <ThreeSceneContext
      value={{
        containerRef,
        sceneTunnel,
        mapPixiToNdc,
        mapNdcToPixi,
        mapThreeToParentPixiLocal,
        mapThreeToParentPixi,
        mapThreeToViewport,
        mapThreeToClient,
        mapClientToNdc,
        mapViewportToNdc,
        raycastNdc,
        raycastClient,
        raycastViewport,
      }}
    >
      {children}
    </ThreeSceneContext>
  );
}

interface HitAreaSetupProps {
  setHitArea: (hitArea: IHitArea | null) => void;
}

function HitAreaSetup({ setHitArea }: HitAreaSetupProps) {
  const { camera, scene } = useThree();
  const [raycaster] = useState(() => new Raycaster());
  const [pointer] = useState(() => new Vector2());

  useEffect(() => {
    setHitArea({
      contains(x: number, y: number): boolean {
        pointer.set(x * 2 - 1, -(y * 2 - 1));
        raycaster.setFromCamera(pointer, camera);

        const intersects = raycaster.intersectObjects(scene.children, true);
        return intersects.length > 0;
      },
    });

    return () => {
      setHitArea(null);
    };
  }, [setHitArea, raycaster, pointer, camera, scene]);

  return null;
}
