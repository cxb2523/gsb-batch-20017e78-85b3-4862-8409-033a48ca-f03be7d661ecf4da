import { PixiTexture, useThreeSceneContext } from "@astralarium/pixi-three";
import { type ThreeElements, useThree } from "@react-three/fiber";
import { Color as PixiColor, type ColorSource, Point } from "pixi.js";
import { type RefObject, useRef } from "react";
import { Color, InstancedMesh, Object3D, Vector3 } from "three";

import { SpinnyCube, type SpinnyCubeProps } from "./spinny-cube";
import {
  SpinnyStar,
  type SpinnyStarColors,
  type StarTipData,
} from "./spinny-star";

// 10 star tips × 6 cube faces = 60 instances max
const MAX_INSTANCES = 60;

/** Lightness offset per cube face normal */
const FACE_SHADE_OFFSETS: Record<string, number> = {
  "+x": 0,
  "-x": 0.3,
  "+y": -0.25,
  "-y": 0.15,
  "+z": 0.4,
  "-z": -0.35,
};

function getNormalFaceKey(normal: Vector3): string {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  if (ax > ay && ax > az) {
    return normal.x > 0 ? "+x" : "-x";
  } else if (ay > ax && ay > az) {
    return normal.y > 0 ? "+y" : "-y";
  } else {
    return normal.z > 0 ? "+z" : "-z";
  }
}

function shadedColor(color: ColorSource, shadeOffset = 0): Color {
  const pixiColor = new PixiColor(color);
  const threeColor = new Color(pixiColor.toNumber());

  if (shadeOffset !== 0) {
    const hsl = { h: 0, s: 0, l: 0 };
    threeColor.getHSL(hsl);
    hsl.l = Math.max(0, Math.min(1, hsl.l + shadeOffset));
    threeColor.setHSL(hsl.h, hsl.s, hsl.l);
  }

  return threeColor;
}

export interface SpinnyCubeWithFollowersProps extends SpinnyCubeProps {
  initialColors?: SpinnyStarColors;
  /** Closest landmark, viewport coordinates */
  landmarkRef?: RefObject<Point | null>;
  /** Mouse position, viewport coordinates */
  mousePosRef?: RefObject<Point | null>;
}

export function SpinnyCubeWithFollowers({
  size = 1,
  speed,
  initialColors,
  landmarkRef,
  mousePosRef,
  ...props
}: Omit<ThreeElements["mesh"], "ref"> & SpinnyCubeWithFollowersProps) {
  const instancedMeshRef = useRef<InstancedMesh>(null);
  const { mapThreeToViewport } = useThreeSceneContext();

  // Instance colors at mount compile the shader with instanceColor
  const initializeColors = (mesh: InstancedMesh) => {
    instancedMeshRef.current = mesh;
    if (!mesh) return;
    const white = new Color(0xffffff);
    for (let i = 0; i < MAX_INSTANCES; i++) {
      mesh.setColorAt(i, white);
    }
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  };

  const camera = useThree((state) => state.camera);

  const _object = new Object3D();
  const _color = new Color();
  const _viewportPoint = new Point();
  const _cameraDir = new Vector3();

  const handleStarTipsUpdate = (tips: StarTipData[]) => {
    if (!instancedMeshRef.current) return;

    const instancedMesh = instancedMeshRef.current;
    const mousePos = mousePosRef?.current;

    // Pass 1: edge scales, max among visible tips
    const tipData: { edgeScale: number; isFacingCamera: boolean }[] = [];
    let maxVisibleEdgeScale = 0;

    if (mousePos) {
      camera.getWorldDirection(_cameraDir);
      _cameraDir.negate();
    }

    for (let i = 0; i < tips.length; i++) {
      const tip = tips[i];

      // Scale by UV distance from the face edge
      const u = tip.uv.x % 1;
      const v = tip.uv.y % 1;
      const distFromEdge = Math.min(u, 1 - u, v, 1 - v);
      const edgeScale = Math.min(1, distFromEdge * 2);

      const isFacingCamera = mousePos
        ? tip.normal.dot(_cameraDir) > 0.25
        : false;

      tipData.push({ edgeScale, isFacingCamera });

      if (isFacingCamera && edgeScale > maxVisibleEdgeScale) {
        maxVisibleEdgeScale = edgeScale;
      }
    }

    // Pass 2: instances, closest landmark
    let closestTip: { position: Vector3; dist: number } | null = null;

    for (let i = 0; i < tips.length; i++) {
      const tip = tips[i];
      const { edgeScale, isFacingCamera } = tipData[i];

      // Float above the surface along the normal
      _object.position.copy(tip.position);
      _object.position.addScaledVector(tip.normal, 0.15 * (size / 3));
      _object.scale.setScalar(edgeScale);
      _object.updateMatrix();
      instancedMesh.setMatrixAt(i, _object.matrix);

      // Face shading from the local normal
      const faceKey = getNormalFaceKey(tip.localNormal);
      const shadeOffset = FACE_SHADE_OFFSETS[faceKey] ?? 0;
      _color.copy(shadedColor(tip.color, shadeOffset));
      instancedMesh.setColorAt(i, _color);

      // Landmark candidates: visible tips near max edgeScale
      if (
        mousePos &&
        isFacingCamera &&
        edgeScale >= maxVisibleEdgeScale - 0.1
      ) {
        // Ball position, offset from the surface
        if (mapThreeToViewport(_object.position, _viewportPoint).length) {
          const dist = Math.hypot(
            _viewportPoint.x - mousePos.x,
            _viewportPoint.y - mousePos.y,
          );
          if (!closestTip || dist < closestTip.dist) {
            closestTip = { position: _object.position.clone(), dist };
          }
        }
      }
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) {
      instancedMesh.instanceColor.needsUpdate = true;
    }
    // Set count after marking buffers for update
    instancedMesh.count = tips.length;

    if (landmarkRef) {
      if (
        closestTip &&
        mapThreeToViewport(closestTip.position, _viewportPoint).length
      ) {
        landmarkRef.current = _viewportPoint.clone();
      } else {
        landmarkRef.current = null;
      }
    }
  };

  return (
    <>
      <SpinnyCube size={size} speed={speed} {...props}>
        <PixiTexture
          width={256}
          height={256}
          attach="colorNode"
          frameloop="always"
        >
          <SpinnyStar
            speed={speed}
            onStarTipsUpdate={handleStarTipsUpdate}
            initialColors={initialColors}
          />
        </PixiTexture>
      </SpinnyCube>
      <instancedMesh
        ref={initializeColors}
        args={[undefined, undefined, MAX_INSTANCES]}
      >
        <sphereGeometry args={[0.15 * (size / 3), 16, 16]} />
        <meshBasicMaterial />
      </instancedMesh>
    </>
  );
}
