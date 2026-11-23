import {
  CanvasView,
  RenderContext,
  ThreeScene,
  usePixiViewContext,
} from "@astralarium/pixi-three";
import { createFileRoute } from "@tanstack/react-router";
import { Point } from "pixi.js";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CirclePing } from "#components/circle-ping";
import { FadeIn } from "#components/fade-in";
import { pixiRed, threeBlue } from "#components/lib/colors";
import { PIXI_THREE_STAR } from "#components/lib/colors";
import { SpinnyCubeWithStars } from "#components/spinny-cube-with-stars";
import { SpinnyStar } from "#components/spinny-star";

import { Frame } from "./-frame";

export const Route = createFileRoute("/example/basic-scene")({
  component: BasicScene,
});

type MapClientToPixi = (
  client: Point | { clientX: number; clientY: number },
  out?: Point,
) => Point | null;

function BasicScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapClientToPixiRef = useRef<MapClientToPixi | null>(null);

  // ThreeScene miss ping
  const [threePing, setThreePing] = useState<Point | null>(null);
  // CanvasView miss ping
  const [canvasPing, setCanvasPing] = useState<Point | null>(null);

  function handleThreeSceneMissed(event: MouseEvent) {
    const mapClientToPixi = mapClientToPixiRef.current;
    if (!mapClientToPixi) return;

    const point = mapClientToPixi(event);
    if (point) {
      setThreePing(new Point(point.x, point.y));
      toast.info("ThreeScene missed!", {
        description: `Click at (${Math.round(point.x)}, ${Math.round(point.y)}) in viewport`,
      });
    }
  }

  function handleCanvasViewMissed(event: PointerEvent) {
    const mapClientToPixi = mapClientToPixiRef.current;
    if (!mapClientToPixi) return;

    const point = mapClientToPixi(event);
    if (point) {
      setCanvasPing(new Point(point.x, point.y));
      toast.error("CanvasView missed!", {
        description: `Click at (${Math.round(point.x)}, ${Math.round(point.y)}) in viewport`,
      });
    }
  }

  return (
    <Frame
      title="Basic Scene"
      subtitle="Pixi inside of Three&mdash;inside of Pixi!"
      sourceUrl="https://github.com/astralarium/pixi-three/blob/main/examples/routes/example/basic-scene.tsx"
      canvasRef={canvasRef}
    >
      <RenderContext>
        <CanvasView
          alpha
          canvasRef={canvasRef}
          onPointerMissed={handleCanvasViewMissed}
        >
          <FadeIn>
            <SpinnyStar
              alpha={0.1}
              speed={0.1}
              initialColors={PIXI_THREE_STAR}
            />
            <ThreeScene onPointerMissed={handleThreeSceneMissed}>
              <SpinnyCubeWithStars position={[-2, -2, 0]} />
              <SpinnyCubeWithStars position={[0, -2, 0]} />
              <SpinnyCubeWithStars position={[2, -2, 0]} />
              <SpinnyCubeWithStars position={[-2, 0, 0]} />
              <SpinnyCubeWithStars position={[0, 0, 0]} />
              <SpinnyCubeWithStars position={[2, 0, 0]} />
              <SpinnyCubeWithStars position={[-2, 2, 0]} />
              <SpinnyCubeWithStars position={[0, 2, 0]} />
              <SpinnyCubeWithStars position={[2, 2, 0]} />
            </ThreeScene>
          </FadeIn>
          <PingLayer
            canvasPing={canvasPing}
            threePing={threePing}
            onCanvasPingComplete={() => setCanvasPing(null)}
            onThreePingComplete={() => setThreePing(null)}
            mapClientToPixiRef={mapClientToPixiRef}
          />
        </CanvasView>
      </RenderContext>
    </Frame>
  );
}

interface PingLayerProps {
  canvasPing: Point | null;
  threePing: Point | null;
  onCanvasPingComplete: () => void;
  onThreePingComplete: () => void;
  mapClientToPixiRef: MutableRefObject<MapClientToPixi | null>;
}

function PingLayer({
  canvasPing,
  threePing,
  onCanvasPingComplete,
  onThreePingComplete,
  mapClientToPixiRef,
}: PingLayerProps) {
  const { mapClientToPixi } = usePixiViewContext();

  // Hand the in-canvas mapper to the parent
  useEffect(() => {
    mapClientToPixiRef.current = mapClientToPixi;
  }, [mapClientToPixiRef, mapClientToPixi]);

  return (
    <>
      {/* First renders behind */}
      {canvasPing && (
        <CirclePing
          position={canvasPing}
          color={pixiRed[500]}
          startRadius={10}
          endRadius={80}
          duration={700}
          strokeWidth={5}
          onComplete={onCanvasPingComplete}
        />
      )}
      {/* Last renders on top */}
      {threePing && (
        <CirclePing
          position={threePing}
          color={threeBlue[400]}
          startRadius={5}
          endRadius={60}
          duration={600}
          strokeWidth={4}
          onComplete={onThreePingComplete}
        />
      )}
    </>
  );
}
