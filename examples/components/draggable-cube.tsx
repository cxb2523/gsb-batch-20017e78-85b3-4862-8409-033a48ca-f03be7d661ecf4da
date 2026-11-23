import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import { type Mesh, Plane, Raycaster, Vector2, Vector3 } from "three";

interface DraggableCubeProps {
  position?: [number, number, number];
  color?: string;
}

export function DraggableCube({
  position = [0, 0, 0],
  color = "#f04d5e",
}: DraggableCubeProps) {
  const meshRef = useRef<Mesh>(null!);
  const [isDragging, setIsDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const dragOffset = useRef(new Vector3());
  const dragPlane = useRef(new Plane(new Vector3(0, 0, 1), 0));
  const intersectPoint = useRef(new Vector3());
  const raycaster = useRef(new Raycaster());
  const pointer = useRef(new Vector2());

  useFrame((_, delta) => {
    if (!isDragging && meshRef.current) {
      meshRef.current.rotation.x += delta * 0.2;
      meshRef.current.rotation.y += delta * 0.3;
    }
  });

  function onPointerDown(event: ThreeEvent<PointerEvent>) {
    event.stopPropagation();
    // Events keep arriving after the pointer leaves the mesh
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setIsDragging(true);

    if (event.point) {
      dragOffset.current.copy(meshRef.current.position).sub(event.point);
      dragPlane.current.setFromNormalAndCoplanarPoint(
        new Vector3(0, 0, 1),
        meshRef.current.position,
      );
    }
  }

  function onPointerUp(event: ThreeEvent<PointerEvent>) {
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    setIsDragging(false);
  }

  function onPointerMove(event: ThreeEvent<PointerEvent>) {
    if (!isDragging) return;

    // event.pointer and event.camera belong to the scene receiving the event
    pointer.current.copy(event.pointer);
    raycaster.current.setFromCamera(pointer.current, event.camera);

    if (
      raycaster.current.ray.intersectPlane(
        dragPlane.current,
        intersectPoint.current,
      )
    ) {
      meshRef.current.position
        .copy(intersectPoint.current)
        .add(dragOffset.current);
    }
  }

  return (
    <mesh
      ref={meshRef}
      position={position}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={isDragging ? "#ffcc00" : hovered ? "#ffffff" : color}
      />
    </mesh>
  );
}
