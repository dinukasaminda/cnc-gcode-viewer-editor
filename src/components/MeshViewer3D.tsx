import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createViewCube, type ViewCubeHandle } from './viewCube';

export interface ViewerPart {
  id: string;
  geometry: THREE.BufferGeometry;
  color: number;
}

export interface PartClickEvent {
  partId: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface SurfaceHitEvent {
  partId: string;
  point: { x: number; y: number; z: number };
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export type MeasureMode = 'off' | 'line' | 'radius';

export interface MeasurePoint {
  x: number;
  y: number;
  z: number;
}

export interface MeshViewer3DProps {
  parts: ViewerPart[];
  wireframe?: boolean;
  resetKey?: number;
  className?: string;
  pickEnabled?: boolean;
  measureMode?: MeasureMode;
  measurePoints?: MeasurePoint[];
  /** World up axis. Use `z` when the model XY plane is the floor (image / print bed). */
  upAxis?: 'y' | 'z';
  /** Solid bed plate under the model (viewer-only, not exported). */
  bedColor?: 'yellow' | 'white' | 'black' | 'none';
  onPartClick?: (ev: PartClickEvent) => void;
  onSurfaceHit?: (ev: SurfaceHitEvent) => void;
}

function makeMarker(color: number, radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  mesh.renderOrder = 20;
  return mesh;
}

export function MeshViewer3D({
  parts,
  wireframe = false,
  resetKey = 0,
  className,
  pickEnabled = true,
  measureMode = 'off',
  measurePoints = [],
  upAxis = 'y',
  bedColor = 'none',
  onPartClick,
  onSurfaceHit,
}: MeshViewer3DProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onPartClickRef = useRef(onPartClick);
  onPartClickRef.current = onPartClick;
  const onSurfaceHitRef = useRef(onSurfaceHit);
  onSurfaceHitRef.current = onSurfaceHit;
  const pickEnabledRef = useRef(pickEnabled);
  pickEnabledRef.current = pickEnabled;
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;

  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    root: THREE.Group;
    overlay: THREE.Group;
    bed: THREE.Mesh | null;
    grid: THREE.GridHelper;
    meshes: Map<string, THREE.Mesh>;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    modelRadius: number;
    upAxis: 'y' | 'z';
    viewCube: ViewCubeHandle;
  } | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    const shell = shellRef.current;
    const host = hostRef.current;
    if (!shell || !host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    const zUp = upAxis === 'z';
    if (zUp) {
      // Default TOP view (look down −Z onto XY plane)
      camera.up.set(0, 1, 0);
      camera.position.set(0, 0, 120);
    } else {
      camera.up.set(0, 1, 0);
      camera.position.set(80, 60, 100);
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.panSpeed = 1.2;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 1.1;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = {
      ONE: THREE.TOUCH.PAN,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };

    const onContextMenu = (e: Event) => e.preventDefault();
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';

    const onPointerCursorDown = () => {
      renderer.domElement.style.cursor =
        measureModeRef.current !== 'off' ? 'crosshair' : 'grabbing';
    };
    const onPointerCursorUp = () => {
      renderer.domElement.style.cursor =
        measureModeRef.current !== 'off' ? 'crosshair' : 'grab';
    };
    renderer.domElement.addEventListener('pointerdown', onPointerCursorDown);
    window.addEventListener('pointerup', onPointerCursorUp);

    const hemi = new THREE.HemisphereLight(0xddeeff, 0x223344, 1.1);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(zUp ? 2 : 2, zUp ? -3 : 4, zUp ? 5 : 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aacc, 0.45);
    fill.position.set(zUp ? -3 : -3, zUp ? 2 : 1, zUp ? 2 : -2);
    scene.add(fill);

    // Default GridHelper is XZ (Y-up). For Z-up, rotate so the grid lies on XY.
    const grid = new THREE.GridHelper(200, 20, 0x3a516a, 0x1c2836);
    if (zUp) grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const root = new THREE.Group();
    root.name = 'parts';
    scene.add(root);

    const overlay = new THREE.Group();
    overlay.name = 'measure-overlay';
    scene.add(overlay);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number; button: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!down || down.button !== 0) {
        down = null;
        return;
      }
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      down = null;
      if (!pickEnabledRef.current) return;
      if (dx * dx + dy * dy > 36) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(root.children, false);
      if (hits.length === 0) return;
      const hit = hits[0];
      const mesh = hit.object as THREE.Mesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;

      if (measureModeRef.current !== 'off' && onSurfaceHitRef.current) {
        onSurfaceHitRef.current({
          partId,
          point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        });
        return;
      }

      onPartClickRef.current?.({
        partId,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const viewCube = createViewCube({
      upAxis,
      onFaceSelect: (viewDir, up) => {
        const dist = Math.max(camera.position.distanceTo(controls.target), 1);
        camera.up.copy(up);
        camera.position.copy(controls.target).addScaledVector(viewDir, dist);
        camera.lookAt(controls.target);
        controls.update();
      },
    });
    shell.appendChild(viewCube.canvas);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
      viewCube.render(camera, controls.target);
    };
    tick();

    ctxRef.current = {
      renderer,
      scene,
      camera,
      controls,
      root,
      overlay,
      bed: null,
      grid,
      meshes: new Map(),
      raycaster,
      pointer,
      modelRadius: 50,
      upAxis,
      viewCube,
    };
    fitCamera();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerdown', onPointerCursorDown);
      window.removeEventListener('pointerup', onPointerCursorUp);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      viewCube.dispose();
      if (viewCube.canvas.parentElement === shell) shell.removeChild(viewCube.canvas);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [upAxis]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = host.querySelector('canvas');
    if (canvas) canvas.style.cursor = measureMode !== 'off' ? 'crosshair' : 'grab';
  }, [measureMode]);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const nextIds = new Set(parts.map((p) => p.id));
    for (const [id, mesh] of ctx.meshes) {
      if (!nextIds.has(id)) {
        ctx.root.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        ctx.meshes.delete(id);
      }
    }

    for (const part of parts) {
      let mesh = ctx.meshes.get(part.id);
      if (!mesh) {
        const mat = new THREE.MeshStandardMaterial({
          color: part.color,
          metalness: 0.05,
          roughness: 0.55,
          flatShading: false,
          side: THREE.DoubleSide,
          wireframe,
        });
        mesh = new THREE.Mesh(part.geometry, mat);
        mesh.userData.partId = part.id;
        ctx.root.add(mesh);
        ctx.meshes.set(part.id, mesh);
      } else {
        mesh.geometry = part.geometry;
        mesh.userData.partId = part.id;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.setHex(part.color);
        mat.wireframe = wireframe;
        mat.needsUpdate = true;
      }
    }
  }, [parts, wireframe]);

  const removeBed = (ctx: NonNullable<typeof ctxRef.current>) => {
    // Purge any leaked bed meshes (Strict Mode / effect re-runs)
    const stray: THREE.Object3D[] = [];
    ctx.scene.traverse((obj) => {
      if (obj.name === 'bed') stray.push(obj);
    });
    for (const obj of stray) {
      ctx.scene.remove(obj);
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material | undefined)?.dispose();
    }
    ctx.bed = null;
  };

  const syncBedTransform = (
    ctx: NonNullable<typeof ctxRef.current>,
    center: THREE.Vector3,
    size: THREE.Vector3,
    radius: number
  ) => {
    if (!ctx.bed) return;
    // One plate matching the model footprint (image size), slight margin — not a second huge bed
    const margin = 1.04;
    const bw = Math.max(size.x * margin, 1);
    const bh = Math.max((ctx.upAxis === 'z' ? size.y : size.z) * margin, 1);
    ctx.bed.geometry.dispose();
    ctx.bed.geometry = new THREE.PlaneGeometry(bw, bh);
    if (ctx.upAxis === 'z') {
      ctx.bed.rotation.set(0, 0, 0);
      ctx.bed.position.set(center.x, center.y, Math.min(0, center.z - size.z * 0.5) - 0.08);
    } else {
      ctx.bed.rotation.set(-Math.PI / 2, 0, 0);
      ctx.bed.position.set(center.x, Math.min(0, center.y - size.y * 0.5) - 0.08, center.z);
    }
    void radius;
  };

  // Solid bed under the model (viewer-only) — one instance; color changes only
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    removeBed(ctx);

    if (bedColor === 'none') {
      ctx.grid.visible = true;
      return;
    }

    const geo = new THREE.PlaneGeometry(80, 80);
    const bedHex =
      bedColor === 'yellow' ? 0xe8c84a : bedColor === 'white' ? 0xf4f6f8 : 0x1a1d22;
    const mat = new THREE.MeshStandardMaterial({
      color: bedHex,
      metalness: bedColor === 'yellow' ? 0.08 : 0.04,
      roughness: bedColor === 'yellow' ? 0.72 : 0.88,
      side: THREE.FrontSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const bed = new THREE.Mesh(geo, mat);
    bed.name = 'bed';
    bed.renderOrder = -2;
    if (ctx.upAxis === 'z') {
      bed.position.z = -0.05;
    } else {
      bed.rotation.x = -Math.PI / 2;
      bed.position.y = -0.05;
    }
    ctx.scene.add(bed);
    ctx.bed = bed;
    ctx.grid.visible = false;

    return () => {
      removeBed(ctx);
      ctx.grid.visible = true;
    };
  }, [bedColor, upAxis]);

  function fitCamera() {
    const ctx = ctxRef.current;
    const currentParts = partsRef.current;
    if (!ctx || currentParts.length === 0) return;

    const box = new THREE.Box3();
    for (const p of currentParts) {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
      if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
    }
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.length() * 0.5, 1e-3);
    ctx.modelRadius = r;
    ctx.controls.target.copy(center);
    if (ctx.upAxis === 'z') {
      // TOP: above the plate looking down
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.position.set(center.x, center.y, center.z + Math.max(r * 2.4, size.z + r * 1.2));
    } else {
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.position.copy(center).add(new THREE.Vector3(r * 1.8, r * 1.2, r * 2.2));
    }
    ctx.camera.lookAt(center);
    ctx.camera.near = Math.max(r / 200, 0.01);
    ctx.camera.far = Math.max(r * 40, 1000);
    ctx.camera.updateProjectionMatrix();
    ctx.controls.update();
    syncBedTransform(ctx, center, size, r);
  }

  useEffect(() => {
    fitCamera();
  }, [resetKey, upAxis]);

  // Measure overlay: points, line, radius circle
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    while (ctx.overlay.children.length) {
      const child = ctx.overlay.children[0];
      ctx.overlay.remove(child);
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      } else if ((child as THREE.Line).isLine) {
        const line = child as THREE.Line;
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
    }

    if (measurePoints.length === 0) return;
    const markerR = Math.max(ctx.modelRadius * 0.008, 0.4);

    for (const p of measurePoints) {
      const m = makeMarker(0xff3355, markerR);
      m.position.set(p.x, p.y, p.z);
      ctx.overlay.add(m);
    }

    if (measurePoints.length >= 2) {
      const a = measurePoints[0];
      const b = measurePoints[1];
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(b.x, b.y, b.z),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xff3355, depthTest: false })
      );
      line.renderOrder = 19;
      ctx.overlay.add(line);

      if (measureMode === 'radius') {
        const center = new THREE.Vector3(a.x, a.y, a.z);
        const rim = new THREE.Vector3(b.x, b.y, b.z);
        const radius = center.distanceTo(rim);
        if (radius > 1e-6) {
          const circle = new THREE.Mesh(
            new THREE.RingGeometry(radius * 0.98, radius, 64),
            new THREE.MeshBasicMaterial({
              color: 0xff3355,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.55,
              depthTest: false,
            })
          );
          // Orient ring to face camera-ish / use XY then lookAt offset
          const normal = new THREE.Vector3().subVectors(rim, center).normalize();
          // Prefer a plane roughly facing up if radial is horizontal
          const up = Math.abs(normal.y) > 0.85 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const quat = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            up.clone().cross(normal).cross(normal).normalize().lengthSq() < 1e-6
              ? up
              : new THREE.Vector3().crossVectors(normal, up).cross(normal).normalize()
          );
          // Simpler: put ring in plane perpendicular to (rim-center) using lookAt
          circle.position.copy(center);
          const zAxis = normal.clone();
          const xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis);
          if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0).cross(zAxis);
          xAxis.normalize();
          const yAxis = zAxis.clone().cross(xAxis).normalize();
          const m4 = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
          circle.quaternion.setFromRotationMatrix(m4);
          // RingGeometry is in XY; rotate so normal is Z of local → align Z to radial? 
          // Actually for radius display we want circle in plane whose normal is arbitrary facing camera.
          // Use plane perpendicular to camera view later — for now XY plane through center is wrong.
          // Rebuild: Ring in XY, rotate so local Z aligns with a stable axis from center to camera.
          void quat;
          circle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), zAxis);
          // That puts ring in plane ⊥ radius vector (wrong for sphere equator).
          // For sphere: radius from center to rim — circle should lie in plane ⊥ to some axis.
          // Best UX: circle in plane that contains center and is facing camera.
          const camDir = ctx.camera.position.clone().sub(center).normalize();
          circle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), camDir);
          circle.renderOrder = 18;
          ctx.overlay.add(circle);
        }
      }
    }
  }, [measurePoints, measureMode]);

  return (
    <div ref={shellRef} className={`${className ?? 'viewport'} viewport-root`}>
      <div ref={hostRef} className="viewport-host" />
    </div>
  );
}
