import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildAxisGizmo, type AxisGizmo } from '../core/axisGizmo';
import {
  buildBoardMesh,
  buildToolMarker,
  buildToolpathLines,
} from '../core/meshBuilder';
import type { HeightFieldStock } from '../core/stock';
import type { CameraMode, JobFile, Measurement, ViewMode } from '../core/types';

interface Props {
  stock: HeightFieldStock | null;
  jobs: JobFile[];
  viewMode: ViewMode;
  cameraMode: CameraMode;
  toolPos: { x: number; y: number; z: number } | null;
  measureMode: boolean;
  measurePoints: { x: number; y: number; z: number }[];
  onMeasureClick: (p: { x: number; y: number; z: number }) => void;
  measurements: Measurement[];
  resetViewKey: number;
  /** When true, mirror board so G-code +X points the opposite world way */
  flipX?: boolean;
  showAxes?: boolean;
}

type ViewerCtx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  boardDispose?: () => void;
  pathDispose?: () => void;
  axes: AxisGizmo;
  tool: THREE.Group;
  measureGroup: THREE.Group;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  boardMesh: THREE.Object3D | null;
  boardRoot: THREE.Group;
  anim: number;
  framed: boolean;
};

export function Viewer3D({
  stock,
  jobs,
  viewMode,
  cameraMode,
  toolPos,
  measureMode,
  measurePoints,
  onMeasureClick,
  measurements,
  resetViewKey,
  flipX = false,
  showAxes = true,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<ViewerCtx | null>(null);

  // Init Three.js once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f1419');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.01,
      5000
    );
    camera.position.set(40, 50, 55);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.screenSpacePanning = true;
    controls.target.set(20, 0, 10);

    const hemi = new THREE.HemisphereLight(0xddeeff, 0x223311, 1.0);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.25);
    dir.position.set(40, 80, 30);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88aacc, 0.45);
    fill.position.set(-30, 20, -40);
    scene.add(fill);

    const grid = new THREE.GridHelper(120, 120, 0x2a3540, 0x1a222c);
    grid.position.y = -0.02;
    scene.add(grid);

    // Board + toolpaths live under boardRoot so Flip X can mirror them together
    const boardRoot = new THREE.Group();
    boardRoot.name = 'board-root';
    scene.add(boardRoot);

    const axes = buildAxisGizmo(12, false);
    axes.setOrigin(0, 0, 0);
    scene.add(axes.group);

    const tool = buildToolMarker();
    tool.visible = false;
    boardRoot.add(tool);

    const measureGroup = new THREE.Group();
    boardRoot.add(measureGroup);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const ctx: ViewerCtx = {
      renderer,
      scene,
      camera,
      controls,
      axes,
      tool,
      measureGroup,
      raycaster,
      pointer,
      boardMesh: null,
      boardRoot,
      anim: 0,
      framed: false,
    };
    ctxRef.current = ctx;

    const onResize = () => {
      if (!mount || !ctxRef.current) return;
      const w = mount.clientWidth;
      const h = Math.max(1, mount.clientHeight);
      renderer.setSize(w, h);
      const cam = ctxRef.current.camera;
      if (cam instanceof THREE.PerspectiveCamera) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      } else if (cam instanceof THREE.OrthographicCamera) {
        const frustum = 40;
        const aspect = w / h;
        cam.left = (-frustum * aspect) / 2;
        cam.right = (frustum * aspect) / 2;
        cam.top = frustum / 2;
        cam.bottom = -frustum / 2;
        cam.updateProjectionMatrix();
      }
    };
    window.addEventListener('resize', onResize);

    const tick = () => {
      const c = ctxRef.current;
      if (!c) return;
      c.anim = requestAnimationFrame(tick);
      c.controls.update();
      c.renderer.render(c.scene, c.camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(ctx.anim);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      axes.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, []);

  const frameCamera = (s: HeightFieldStock, force = false) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.framed && !force) return;
    const cx = s.originX + s.widthMm / 2;
    const cz = s.originY + s.heightMm / 2;
    const span = Math.max(s.widthMm, s.heightMm);
    // Target in world space (boardRoot may flip X)
    const sx = flipX ? -1 : 1;
    ctx.controls.target.set(cx * sx, 0, cz);
    if (ctx.camera instanceof THREE.PerspectiveCamera) {
      const dist = Math.max(25, span * 1.1);
      ctx.camera.position.set(cx * sx + dist * 0.55 * sx, dist * 0.7, cz + dist * 0.55);
      ctx.camera.near = 0.01;
      ctx.camera.far = Math.max(5000, dist * 20);
      ctx.camera.updateProjectionMatrix();
    } else {
      ctx.camera.position.set(cx * sx, 80, cz);
    }
    ctx.controls.update();
    ctx.framed = true;
  };

  // Flip X / show axes
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.boardRoot.scale.x = flipX ? -1 : 1;
    // Rebuild axis gizmo so arrow label matches flip
    ctx.scene.remove(ctx.axes.group);
    ctx.axes.dispose();
    const len = stock
      ? Math.max(8, Math.min(20, Math.max(stock.widthMm, stock.heightMm) * 0.22))
      : 12;
    ctx.axes = buildAxisGizmo(len, flipX);
    // Keep gizmo at machine origin (0,0,0) so +X/+Y/+Z match G-code
    ctx.axes.setOrigin(0, 0, 0);
    ctx.axes.group.visible = showAxes;
    ctx.scene.add(ctx.axes.group);
    if (stock) {
      ctx.framed = false;
      frameCamera(stock, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, showAxes, stock?.widthMm, stock?.heightMm]);

  // Rebuild board / toolpaths when data changes
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    ctx.boardDispose?.();
    ctx.pathDispose?.();
    ctx.boardDispose = undefined;
    ctx.pathDispose = undefined;
    ctx.boardMesh = null;

    const toRemove = ctx.boardRoot.children.filter(
      (c) => c.name === 'pcb' || c.name === 'toolpaths'
    );
    for (const c of toRemove) ctx.boardRoot.remove(c);

    const showBoard = viewMode !== 'toolpaths';
    const showPaths = viewMode === 'toolpaths' || viewMode === 'final+toolpaths';

    if (showBoard && stock) {
      const board = buildBoardMesh(stock, viewMode);
      ctx.boardRoot.add(board.group);
      ctx.boardDispose = board.dispose;
      ctx.boardMesh = board.group;
      const len = Math.max(8, Math.min(20, Math.max(stock.widthMm, stock.heightMm) * 0.22));
      ctx.axes.setLength(len);
      ctx.axes.setOrigin(0, 0, 0);
      frameCamera(stock, false);
    }

    if (showPaths) {
      const paths = buildToolpathLines(jobs);
      ctx.boardRoot.add(paths.group);
      ctx.pathDispose = paths.dispose;
    }
  }, [stock, jobs, viewMode]);

  // Camera mode
  useEffect(() => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;
    const w = mount.clientWidth;
    const h = Math.max(1, mount.clientHeight);
    const target = ctx.controls.target.clone();

    ctx.controls.dispose();

    if (cameraMode === 'top') {
      const frustum = Math.max(30, (stock?.widthMm ?? 40) * 0.9);
      const aspect = w / h;
      const ortho = new THREE.OrthographicCamera(
        (-frustum * aspect) / 2,
        (frustum * aspect) / 2,
        frustum / 2,
        -frustum / 2,
        0.01,
        5000
      );
      ortho.position.set(target.x, 80, target.z);
      ortho.up.set(0, 0, -1);
      ortho.lookAt(target);
      ctx.camera = ortho;
      const controls = new OrbitControls(ortho, ctx.renderer.domElement);
      controls.enableDamping = true;
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
      controls.target.copy(target);
      ctx.controls = controls;
    } else {
      const persp = new THREE.PerspectiveCamera(45, w / h, 0.01, 5000);
      persp.position.set(target.x + 35, 45, target.z + 40);
      persp.lookAt(target);
      ctx.camera = persp;
      const controls = new OrbitControls(persp, ctx.renderer.domElement);
      controls.enableDamping = true;
      controls.enableRotate = true;
      controls.screenSpacePanning = true;
      controls.target.copy(target);
      ctx.controls = controls;
    }
    ctx.controls.update();
  }, [cameraMode]);

  // Explicit Reset View button
  useEffect(() => {
    if (!stock || resetViewKey === 0) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.framed = false;
    frameCamera(stock, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetViewKey]);

  // Tool marker
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (!toolPos) {
      ctx.tool.visible = false;
      return;
    }
    ctx.tool.visible = true;
    ctx.tool.position.set(toolPos.x, toolPos.z + 0.6, toolPos.y);
  }, [toolPos]);

  // Measurements visuals
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    while (ctx.measureGroup.children.length) {
      const c = ctx.measureGroup.children.pop()!;
      ctx.measureGroup.remove(c);
    }
    const addPoint = (p: { x: number; y: number; z: number }, color: number) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 12, 12),
        new THREE.MeshBasicMaterial({ color })
      );
      m.position.set(p.x, p.z + 0.05, p.y);
      ctx.measureGroup.add(m);
    };
    for (const p of measurePoints) addPoint(p, 0x38bdf8);
    for (const m of measurements) {
      for (const p of m.points) addPoint(p, 0xfbbf24);
      if (m.points.length === 2) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(m.points[0].x, m.points[0].z + 0.05, m.points[0].y),
          new THREE.Vector3(m.points[1].x, m.points[1].z + 0.05, m.points[1].y),
        ]);
        ctx.measureGroup.add(
          new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfbbf24 }))
        );
      }
    }
  }, [measurePoints, measurements]);

  // Click to measure (do not steal drag from OrbitControls)
  useEffect(() => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;

    let downX = 0;
    let downY = 0;
    const onDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    const onClick = (ev: MouseEvent) => {
      if (!measureMode || !ctx.boardMesh) return;
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) return;
      const rect = mount.getBoundingClientRect();
      ctx.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ctx.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      ctx.raycaster.setFromCamera(ctx.pointer, ctx.camera);
      const hits = ctx.raycaster.intersectObject(ctx.boardMesh, true);
      if (!hits.length) return;
      const pt = hits[0].point;
      onMeasureClick({ x: pt.x, y: pt.z, z: pt.y });
    };
    mount.addEventListener('pointerdown', onDown);
    mount.addEventListener('click', onClick);
    return () => {
      mount.removeEventListener('pointerdown', onDown);
      mount.removeEventListener('click', onClick);
    };
  }, [measureMode, onMeasureClick]);

  return (
    <div
      ref={mountRef}
      className={`viewer3d ${measureMode ? 'measure-cursor' : ''}`}
    />
  );
}
