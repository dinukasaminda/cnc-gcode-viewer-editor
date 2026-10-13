import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildAxisGizmo, type AxisGizmo } from '../core/axisGizmo';
import {
  buildBoardMesh,
  buildComparisonRuler,
  buildToolMarker,
  buildToolpathLines,
} from '../core/meshBuilder';
import { formatNum } from '../core/format';
import {
  cssPixelsPerMm,
  zoomPercentFromOrthoZoom,
} from '../core/screenScale';
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
  rulerDispose?: () => void;
  axes: AxisGizmo;
  tool: THREE.Group;
  measureGroup: THREE.Group;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  boardMesh: THREE.Object3D | null;
  boardRoot: THREE.Group;
  anim: number;
  framed: boolean;
  planView: boolean;
  flipX: boolean;
  pxPerMm: number;
};

function applyTrueScaleOrtho(
  cam: THREE.OrthographicCamera,
  cssW: number,
  cssH: number,
  pxPerMm: number
) {
  const halfW = cssW / pxPerMm / 2;
  const halfH = cssH / pxPerMm / 2;
  cam.left = -halfW;
  cam.right = halfW;
  cam.top = halfH;
  cam.bottom = -halfH;
  cam.updateProjectionMatrix();
}

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
  flipX = true,
  showAxes = true,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<ViewerCtx | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [scaleBarPx, setScaleBarPx] = useState(0);

  const syncZoomHud = useCallback(() => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;
    if (ctx.camera instanceof THREE.OrthographicCamera) {
      setZoomPct(zoomPercentFromOrthoZoom(ctx.camera.zoom));
      // 10 mm scale bar at current zoom (CSS px)
      setScaleBarPx(10 * ctx.pxPerMm * ctx.camera.zoom);
    } else {
      // Perspective: approximate vs a reference distance
      const dist = ctx.camera.position.distanceTo(ctx.controls.target);
      const ref = 80;
      setZoomPct(Math.round((ref / Math.max(dist, 0.01)) * 1000) / 10);
      setScaleBarPx(0);
    }
  }, []);

  const goActualSize = useCallback(() => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;
    if (!(ctx.camera instanceof THREE.OrthographicCamera)) return;
    applyTrueScaleOrtho(
      ctx.camera,
      mount.clientWidth,
      Math.max(1, mount.clientHeight),
      ctx.pxPerMm
    );
    ctx.camera.zoom = 1;
    ctx.camera.updateProjectionMatrix();
    ctx.controls.update();
    syncZoomHud();
  }, [syncZoomHud]);

  // Init Three.js once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const pxPerMm = cssPixelsPerMm();
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
      planView: true,
      flipX: true,
      pxPerMm,
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
        applyTrueScaleOrtho(cam, w, h, ctxRef.current.pxPerMm);
      }
      syncZoomHud();
    };
    window.addEventListener('resize', onResize);

    const onControlsChange = () => syncZoomHud();
    controls.addEventListener('change', onControlsChange);

    const tick = () => {
      const c = ctxRef.current;
      if (!c) return;
      c.anim = requestAnimationFrame(tick);
      c.controls.update();
      if (c.planView) {
        const t = c.controls.target;
        const height = Math.max(10, c.camera.position.y);
        c.camera.position.set(t.x, height, t.z);
        c.camera.up.set(0, 0, 1);
        const right = new THREE.Vector3(c.flipX ? -1 : 1, 0, 0);
        const up = new THREE.Vector3(0, 0, 1);
        const back = new THREE.Vector3(0, 1, 0);
        c.camera.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(right, up, back)
        );
      }
      c.renderer.render(c.scene, c.camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(ctx.anim);
      window.removeEventListener('resize', onResize);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      axes.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [syncZoomHud]);

  const applyXyPlanOrientation = (
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    tx: number,
    tz: number,
    height: number
  ) => {
    camera.position.set(tx, height, tz);
    camera.up.set(0, 0, 1);
    const right = new THREE.Vector3(flipX ? -1 : 1, 0, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const back = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4().makeBasis(right, up, back);
    camera.quaternion.setFromRotationMatrix(m);
    camera.updateMatrix();
  };

  const frameCamera = (s: HeightFieldStock, force = false, actualSize = false) => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;
    if (ctx.framed && !force) return;
    const cx = s.originX + s.widthMm / 2;
    const cz = s.originY + s.heightMm / 2;
    const span = Math.max(s.widthMm, s.heightMm);
    const sx = flipX ? -1 : 1;
    const tx = cx * sx;
    const tz = cz;
    ctx.controls.target.set(tx, 0, tz);
    const height = Math.max(40, span * 1.5);

    if (ctx.camera instanceof THREE.PerspectiveCamera) {
      applyXyPlanOrientation(ctx.camera, tx, tz - span * 0.02, height);
      ctx.camera.near = 0.01;
      ctx.camera.far = Math.max(5000, height * 20);
      ctx.camera.updateProjectionMatrix();
    } else {
      applyXyPlanOrientation(ctx.camera, tx, tz, height);
      applyTrueScaleOrtho(
        ctx.camera,
        mount.clientWidth,
        Math.max(1, mount.clientHeight),
        ctx.pxPerMm
      );
      if (actualSize) {
        ctx.camera.zoom = 1;
      } else {
        // Fit board + 2 cm comparison ruler (above +Y edge) while keeping true-scale frustum
        const viewW = mount.clientWidth / ctx.pxPerMm;
        const viewH = Math.max(1, mount.clientHeight) / ctx.pxPerMm;
        // Padding for 2 cm ruler (top) + W/H dimension lines (bottom/left)
        const fitW = s.widthMm + 14;
        const fitH = s.heightMm + 16;
        const fit = Math.min(viewW / Math.max(fitW, 0.01), viewH / Math.max(fitH, 0.01));
        ctx.camera.zoom = Math.max(0.05, fit * 0.88);
      }
      ctx.camera.updateProjectionMatrix();
    }
    ctx.controls.update();
    ctx.framed = true;
    syncZoomHud();
  };

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.flipX = flipX;
    ctx.boardRoot.scale.x = flipX ? -1 : 1;
    ctx.scene.remove(ctx.axes.group);
    ctx.axes.dispose();
    const len = stock
      ? Math.max(8, Math.min(20, Math.max(stock.widthMm, stock.heightMm) * 0.22))
      : 12;
    ctx.axes = buildAxisGizmo(len, flipX);
    ctx.axes.setOrigin(0, 0, 0);
    ctx.axes.group.visible = showAxes;
    ctx.scene.add(ctx.axes.group);
    if (stock) {
      ctx.framed = false;
      frameCamera(stock, true, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, showAxes, stock?.widthMm, stock?.heightMm]);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    ctx.boardDispose?.();
    ctx.pathDispose?.();
    ctx.rulerDispose?.();
    ctx.boardDispose = undefined;
    ctx.pathDispose = undefined;
    ctx.rulerDispose = undefined;
    ctx.boardMesh = null;

    const toRemove = ctx.boardRoot.children.filter(
      (c) => c.name === 'pcb' || c.name === 'toolpaths' || c.name === 'comparison-ruler'
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
      frameCamera(stock, false, false);
    }

    if (stock) {
      const ruler = buildComparisonRuler(stock);
      ctx.boardRoot.add(ruler.group);
      ctx.rulerDispose = ruler.dispose;
    }

    if (showPaths) {
      const paths = buildToolpathLines(jobs);
      ctx.boardRoot.add(paths.group);
      ctx.pathDispose = paths.dispose;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, jobs, viewMode]);

  useEffect(() => {
    const ctx = ctxRef.current;
    const mount = mountRef.current;
    if (!ctx || !mount) return;
    const w = mount.clientWidth;
    const h = Math.max(1, mount.clientHeight);
    const target = ctx.controls.target.clone();

    ctx.controls.dispose();

    if (cameraMode === 'top') {
      const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
      applyTrueScaleOrtho(ortho, w, h, ctx.pxPerMm);
      ortho.zoom = 1;
      applyXyPlanOrientation(ortho, target.x, target.z, 100);
      ctx.camera = ortho;
      const controls = new OrbitControls(ortho, ctx.renderer.domElement);
      controls.enableDamping = true;
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
      controls.target.set(target.x, 0, target.z);
      controls.addEventListener('change', syncZoomHud);
      ctx.controls = controls;
      ctx.planView = true;
    } else {
      const persp = new THREE.PerspectiveCamera(45, w / h, 0.01, 5000);
      applyXyPlanOrientation(
        persp,
        target.x,
        target.z - 2,
        Math.max(50, (stock?.widthMm ?? 40) * 1.2)
      );
      ctx.camera = persp;
      const controls = new OrbitControls(persp, ctx.renderer.domElement);
      controls.enableDamping = true;
      controls.enableRotate = true;
      controls.screenSpacePanning = true;
      controls.target.set(target.x, 0, target.z);
      controls.addEventListener('change', syncZoomHud);
      ctx.controls = controls;
      ctx.planView = false;
    }
    ctx.flipX = flipX;
    ctx.controls.update();
    if (stock) {
      ctx.framed = false;
      frameCamera(stock, true, false);
    } else {
      syncZoomHud();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraMode, flipX, stock]);

  useEffect(() => {
    if (!stock || resetViewKey === 0) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.framed = false;
    frameCamera(stock, true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetViewKey]);

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

  const isTop = cameraMode === 'top';

  return (
    <div
      ref={mountRef}
      className={`viewer3d ${measureMode ? 'measure-cursor' : ''}`}
    >
      <div className="zoom-hud">
        <div className="zoom-hud-main">
          <span className="zoom-pct">Zoom {formatNum(zoomPct, 1)}%</span>
          {isTop && Math.abs(zoomPct - 100) < 0.15 ? (
            <span className="zoom-actual">1:1 actual size</span>
          ) : isTop ? (
            <span className="zoom-hint">Top view · scroll to zoom</span>
          ) : (
            <span className="zoom-hint">1:1 only in Top view</span>
          )}
        </div>
        {isTop && (
          <button type="button" className="zoom-actual-btn" onClick={goActualSize}>
            100% actual size
          </button>
        )}
        {isTop && scaleBarPx > 8 && (
          <div className="scale-bar" title="10 mm at current zoom (CSS 96dpi)">
            <div className="scale-bar-line" style={{ width: `${Math.min(scaleBarPx, 240)}px` }} />
            <span>10 mm</span>
          </div>
        )}
      </div>
    </div>
  );
}
