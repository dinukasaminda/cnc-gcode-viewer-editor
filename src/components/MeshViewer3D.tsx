import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

export interface MeshViewer3DProps {
  parts: ViewerPart[];
  wireframe?: boolean;
  resetKey?: number;
  className?: string;
  /** When true, pointer picks parts (click without drag). */
  pickEnabled?: boolean;
  onPartClick?: (ev: PartClickEvent) => void;
}

export function MeshViewer3D({
  parts,
  wireframe = false,
  resetKey = 0,
  className,
  pickEnabled = true,
  onPartClick,
}: MeshViewer3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onPartClickRef = useRef(onPartClick);
  onPartClickRef.current = onPartClick;
  const pickEnabledRef = useRef(pickEnabled);
  pickEnabledRef.current = pickEnabled;

  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    root: THREE.Group;
    meshes: Map<string, THREE.Mesh>;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    down: { x: number; y: number; button: number } | null;
  } | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    camera.position.set(80, 60, 100);

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
    // Hand/pan on left or middle drag; orbit on right or Shift+left; wheel zoom.
    // Click (no drag) still selects parts via our pointer-up handler.
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
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onPointerCursorUp = () => {
      renderer.domElement.style.cursor = 'grab';
    };
    renderer.domElement.addEventListener('pointerdown', onPointerCursorDown);
    window.addEventListener('pointerup', onPointerCursorUp);

    const hemi = new THREE.HemisphereLight(0xddeeff, 0x223344, 1.1);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(2, 4, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aacc, 0.45);
    fill.position.set(-3, 1, -2);
    scene.add(fill);

    const grid = new THREE.GridHelper(200, 20, 0x3a516a, 0x1c2836);
    scene.add(grid);

    const root = new THREE.Group();
    root.name = 'parts';
    scene.add(root);

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
      if (!pickEnabledRef.current || !onPartClickRef.current) return;
      if (dx * dx + dy * dy > 36) return; // dragged → orbit, not pick

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(root.children, false);
      if (hits.length === 0) return;
      const mesh = hits[0].object as THREE.Mesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;
      onPartClickRef.current({
        partId,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    ctxRef.current = {
      renderer,
      scene,
      camera,
      controls,
      root,
      meshes: new Map(),
      raycaster,
      pointer,
      down: null,
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerdown', onPointerCursorDown);
      window.removeEventListener('pointerup', onPointerCursorUp);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, []);

  // Sync part meshes / materials
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

  // Frame camera only on explicit reset / load — keep orientation when scrubbing history
  useEffect(() => {
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
    ctx.controls.target.copy(center);
    ctx.camera.position.copy(center).add(new THREE.Vector3(r * 1.8, r * 1.2, r * 2.2));
    ctx.camera.near = Math.max(r / 200, 0.01);
    ctx.camera.far = Math.max(r * 40, 1000);
    ctx.camera.updateProjectionMatrix();
    ctx.controls.update();
  }, [resetKey]);

  return <div ref={hostRef} className={className ?? 'viewport'} />;
}
