import { useEffect, useRef, type MutableRefObject } from 'react';
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

export interface MeasureOverlayLine {
  a: MeasurePoint;
  b: MeasurePoint;
  color?: number;
  /** Drawn floating above the midpoint of the line. */
  label?: string;
}

export interface MeshViewer3DProps {
  parts: ViewerPart[];
  wireframe?: boolean;
  resetKey?: number;
  className?: string;
  pickEnabled?: boolean;
  measureMode?: MeasureMode;
  measurePoints?: MeasurePoint[];
  /** Extra saved measure lines (drawn even when measureMode is off). */
  measureOverlays?: MeasureOverlayLine[];
  /** World up axis. Use `z` when the model XY plane is the floor (image / print bed). */
  upAxis?: 'y' | 'z';
  /** Solid bed plate under the model (viewer-only, not exported). */
  bedColor?: 'yellow' | 'white' | 'black' | 'none';
  onPartClick?: (ev: PartClickEvent) => void;
  onSurfaceHit?: (ev: SurfaceHitEvent) => void;
  onSurfaceMove?: (ev: SurfaceHitEvent | null) => void;
  /** Filled with a function that captures an orthographic TOP PNG (data URL). */
  captureTopViewRef?: MutableRefObject<(() => string | null) | null>;
}

const EMPTY_OVERLAYS: MeasureOverlayLine[] = [];

function makeMarker(color: number, radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  mesh.renderOrder = 20;
  return mesh;
}

function colorCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function disposeOverlayChild(child: THREE.Object3D) {
  if ((child as THREE.Mesh).isMesh) {
    const mesh = child as THREE.Mesh;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    return;
  }
  if ((child as THREE.Line).isLine) {
    const line = child as THREE.Line;
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
    return;
  }
  if ((child as THREE.Sprite).isSprite) {
    const sprite = child as THREE.Sprite;
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
}

function makeMeasureLabel(text: string, color: number, worldH: number): THREE.Sprite {
  const padX = 16;
  const padY = 8;
  const fontPx = 32;
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const textW = Math.ceil(ctx2d.measureText(text).width);
  const w = textW + padX * 2;
  const h = fontPx + padY * 2;
  canvas.width = w;
  canvas.height = h;
  ctx2d.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  const r = 12;
  ctx2d.beginPath();
  ctx2d.moveTo(r, 8);
  ctx2d.arcTo(w - 8, 8, w - 8, h - 8, r);
  ctx2d.arcTo(w - 8, h - 8, 8, h - 8, r);
  ctx2d.arcTo(8, h - 8, 8, 8, r);
  ctx2d.arcTo(8, 8, w - 8, 8, r);
  ctx2d.closePath();
  ctx2d.fillStyle = 'rgba(8, 16, 28, 0.88)';
  ctx2d.fill();
  ctx2d.strokeStyle = colorCss(color);
  ctx2d.lineWidth = 2;
  ctx2d.stroke();
  ctx2d.fillStyle = colorCss(color);
  ctx2d.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(worldH * (w / h), worldH, 1);
  sprite.renderOrder = 22;
  return sprite;
}

function labelPosition(
  a: MeasurePoint,
  b: MeasurePoint,
  upAxis: 'y' | 'z',
  lift: number
): THREE.Vector3 {
  const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // Keep the tag on the board plane, just above the stroke (screen-up in TOP).
  if (len > 1e-6) {
    let px = -dy / len;
    let py = dx / len;
    if (py < -1e-6 || (Math.abs(py) < 1e-6 && px < 0)) {
      px = -px;
      py = -py;
    }
    const side = Math.min(2.2, Math.max(0.9, len * 0.08));
    mid.x += px * side;
    mid.y += py * side;
  }
  if (upAxis === 'z') mid.z += lift;
  else mid.y += lift;
  return mid;
}

export function MeshViewer3D({
  parts,
  wireframe = false,
  resetKey = 0,
  className,
  pickEnabled = true,
  measureMode = 'off',
  measurePoints = [],
  measureOverlays = EMPTY_OVERLAYS,
  upAxis = 'y',
  bedColor = 'none',
  onPartClick,
  onSurfaceHit,
  onSurfaceMove,
  captureTopViewRef,
}: MeshViewer3DProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onPartClickRef = useRef(onPartClick);
  onPartClickRef.current = onPartClick;
  const onSurfaceHitRef = useRef(onSurfaceHit);
  onSurfaceHitRef.current = onSurfaceHit;
  const onSurfaceMoveRef = useRef(onSurfaceMove);
  onSurfaceMoveRef.current = onSurfaceMove;
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

    const pickFromEvent = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const pickList: THREE.Object3D[] = [...root.children];
      const bed = scene.getObjectByName('bed');
      if (bed) pickList.push(bed);
      const hits = raycaster.intersectObjects(pickList, true);
      if (hits.length === 0) return null;
      const hit = hits[0];
      const mesh = hit.object as THREE.Mesh;
      const partId = (mesh.userData.partId as string | undefined) ?? (mesh.name === 'bed' ? 'bed' : undefined);
      if (!partId) return null;
      return { partId, point: hit.point };
    };

    const onPointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (measureModeRef.current === 'off' || !onSurfaceMoveRef.current) return;
      const picked = pickFromEvent(e);
      if (!picked) {
        onSurfaceMoveRef.current(null);
        return;
      }
      onSurfaceMoveRef.current({
        partId: picked.partId,
        point: { x: picked.point.x, y: picked.point.y, z: picked.point.z },
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    };

    const onPointerLeave = () => {
      if (measureModeRef.current === 'off') return;
      onSurfaceMoveRef.current?.(null);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!down || down.button !== 0) {
        down = null;
        return;
      }
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      down = null;
      const measuring = measureModeRef.current !== 'off';
      if (!pickEnabledRef.current && !measuring) return;
      if (dx * dx + dy * dy > 36) return;

      const picked = pickFromEvent(e);
      if (!picked) return;
      const { partId } = picked;

      if (measureModeRef.current !== 'off' && onSurfaceHitRef.current) {
        onSurfaceHitRef.current({
          partId,
          point: { x: picked.point.x, y: picked.point.y, z: picked.point.z },
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        });
        return;
      }
      if (partId === 'bed') return;

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
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

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
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
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
    const ctx = ctxRef.current;
    if (!host) return;
    const canvas = host.querySelector('canvas');
    if (canvas) canvas.style.cursor = measureMode !== 'off' ? 'crosshair' : 'grab';
    if (!ctx) return;
    // LMB is a pick while measuring — don't start a pan on the same click.
    ctx.controls.mouseButtons.LEFT =
      measureMode !== 'off' ? (-1 as THREE.MOUSE) : THREE.MOUSE.PAN;
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

  useEffect(() => {
    if (!captureTopViewRef) return;
    captureTopViewRef.current = () => {
      const ctx = ctxRef.current;
      const host = hostRef.current;
      const currentParts = partsRef.current;
      if (!ctx || !host || currentParts.length === 0) return null;

      const box = new THREE.Box3();
      for (const p of currentParts) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
        if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
      }
      if (box.isEmpty()) return null;

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const margin = 1.08;
      const widthMm = Math.max(size.x * margin, 1);
      const heightMm = Math.max((ctx.upAxis === 'z' ? size.y : size.z) * margin, 1);
      const aspect = widthMm / heightMm;
      const maxPx = 2048;
      const pxW = aspect >= 1 ? maxPx : Math.max(64, Math.round(maxPx * aspect));
      const pxH = aspect >= 1 ? Math.max(64, Math.round(maxPx / aspect)) : maxPx;

      const near = 0.1;
      const far = Math.max(size.length() * 8, 200);
      const ortho = new THREE.OrthographicCamera(
        -widthMm / 2,
        widthMm / 2,
        heightMm / 2,
        -heightMm / 2,
        near,
        far
      );
      if (ctx.upAxis === 'z') {
        ortho.up.set(0, 1, 0);
        ortho.position.set(center.x, center.y, center.z + Math.max(size.z, 1) + far * 0.25);
      } else {
        ortho.up.set(0, 0, -1);
        ortho.position.set(center.x, center.y + Math.max(size.y, 1) + far * 0.25, center.z);
      }
      ortho.lookAt(center);
      ortho.updateProjectionMatrix();

      const gridWas = ctx.grid.visible;
      ctx.grid.visible = false;
      const prevPR = ctx.renderer.getPixelRatio();
      ctx.renderer.setPixelRatio(1);
      ctx.renderer.setSize(pxW, pxH, false);
      ctx.renderer.render(ctx.scene, ortho);
      const dataUrl = ctx.renderer.domElement.toDataURL('image/png');
      ctx.renderer.setPixelRatio(prevPR);
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      ctx.renderer.setSize(w, h, false);
      ctx.camera.aspect = w / h;
      ctx.camera.updateProjectionMatrix();
      ctx.grid.visible = gridWas;
      ctx.renderer.render(ctx.scene, ctx.camera);
      return dataUrl;
    };
    return () => {
      captureTopViewRef.current = null;
    };
  }, [captureTopViewRef]);

  // Measure overlay: points, line, radius circle
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    while (ctx.overlay.children.length) {
      const child = ctx.overlay.children[0];
      ctx.overlay.remove(child);
      disposeOverlayChild(child);
    }

    const markerR = Math.max(ctx.modelRadius * 0.006, 0.28);
    const labelH = Math.max(0.95, Math.min(1.65, ctx.modelRadius * 0.038));
    const labelLift = Math.max(0.85, ctx.modelRadius * 0.032);
    const addLine = (a: MeasurePoint, b: MeasurePoint, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(b.x, b.y, b.z),
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 19;
      ctx.overlay.add(line);
    };
    const addMark = (p: MeasurePoint, color: number) => {
      const m = makeMarker(color, markerR);
      m.position.set(p.x, p.y, p.z);
      ctx.overlay.add(m);
    };
    const addLabel = (a: MeasurePoint, b: MeasurePoint, color: number, text: string) => {
      if (!text.trim()) return;
      const same =
        Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
      if (same) return;
      const sprite = makeMeasureLabel(text, color, labelH);
      sprite.position.copy(labelPosition(a, b, ctx.upAxis, labelLift));
      ctx.overlay.add(sprite);
    };

    for (const line of measureOverlays) {
      const color = line.color ?? 0x38bdf8;
      addMark(line.a, color);
      addMark(line.b, color);
      addLine(line.a, line.b, color);
      if (line.label) addLabel(line.a, line.b, color, line.label);
    }

    if (measurePoints.length === 0) return;

    for (const p of measurePoints) {
      addMark(p, 0xff3355);
    }

    if (measurePoints.length >= 2) {
      const a = measurePoints[0];
      const b = measurePoints[1];
      addLine(a, b, 0xff3355);

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
  }, [measurePoints, measureMode, measureOverlays, upAxis]);

  return (
    <div ref={shellRef} className={`${className ?? 'viewport'} viewport-root`}>
      <div ref={hostRef} className="viewport-host" />
    </div>
  );
}
