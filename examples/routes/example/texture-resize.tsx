import {
  CanvasView,
  PixiTexture,
  RenderContext,
  ThreeScene,
} from "@astralarium/pixi-three";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { DraggableCube } from "#components/draggable-cube";
import { FadeIn } from "#components/fade-in";
import { HoverBox } from "#components/hover-box";
import { Button } from "#components/ui/button";

import { Frame } from "./-frame";

export const Route = createFileRoute("/example/texture-resize")({
  component: TextureResizeExample,
});

const SIZES = [
  { width: 200, height: 200 },
  { width: 400, height: 260 },
  { width: 300, height: 480 },
] as const;

function TextureResizeExample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizeIndex, setSizeIndex] = useState(0);
  const [mounted, setMounted] = useState(true);
  const { width, height } = SIZES[sizeIndex];

  return (
    <Frame
      title="Texture Resize"
      subtitle="Resize and unmount a PixiTexture at runtime; the red boxes and the green cube stay clickable"
      sourceUrl="https://github.com/astralarium/pixi-three/blob/main/examples/routes/example/texture-resize.tsx"
      canvasRef={canvasRef}
    >
      <div className="flex items-center gap-2 px-4 pb-2">
        <Button
          size="sm"
          onClick={() => setSizeIndex((index) => (index + 1) % SIZES.length)}
        >
          Resize ({width}×{height})
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setMounted((value) => !value)}
        >
          {mounted ? "Unmount" : "Remount"}
        </Button>
      </div>
      <RenderContext>
        <CanvasView alpha frameloop="demand" canvasRef={canvasRef}>
          <FadeIn>
            <ThreeScene frameloop="demand">
              {mounted && (
                <mesh>
                  <boxGeometry args={[2, 2, 2]} />
                  <meshBasicNodeMaterial>
                    <PixiTexture
                      attach="colorNode"
                      width={width}
                      height={height}
                      frameloop="demand"
                    >
                      {/* Fixed and size-tracking hit targets */}
                      <HoverBox x={20} y={20} />
                      <HoverBox x={width - 120} y={height - 120} />
                      {/* Nested scene: its event mapping follows the size */}
                      <ThreeScene>
                        <ambientLight intensity={1.5} />
                        <directionalLight position={[5, 5, 5]} intensity={2} />
                        <DraggableCube color="#22c55e" />
                      </ThreeScene>
                    </PixiTexture>
                  </meshBasicNodeMaterial>
                </mesh>
              )}
            </ThreeScene>
          </FadeIn>
        </CanvasView>
      </RenderContext>
    </Frame>
  );
}
