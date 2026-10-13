import * as THREE from 'three';
import { formatMm } from './format';
import type { HeightFieldStock } from './stock';
import type { JobFile, ViewMode } from './types';

const COPPER = new THREE.Color('#c9853a');
const FR4 = new THREE.Color('#3d8f2e');
const FR4_DEEP = new THREE.Color('#1f5c18');
const FR4_EDGE = new THREE.Color('#24501c');
const HEAT_LOW = new THREE.Color('#1e3a5f');
const HEAT_HIGH = new THREE.Color('#f59e0b');

export interface BoardMeshes {
  group: THREE.Group;
  dispose: () => void;
}

/**
 * Build a PCB mesh from the height field:
 * - Top surface vertices displaced by -depth (into board)
 * - Vertex colors: copper vs FR4
 * - Void cells create holes (degenerate / skipped quads)
 */
export function buildBoardMesh(
  stock: HeightFieldStock,
  viewMode: ViewMode
): BoardMeshes {
  const group = new THREE.Group();
  group.name = 'pcb';

  const cols = stock.cols;
  const rows = stock.rows;
  const disposables: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // Top milled surface
  {
    const positions: number[] = [];
    const colors: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const maxD = Math.max(stock.maxDepth(), 1e-6);

    const vertIndex = new Int32Array(cols * rows).fill(-1);
    let vi = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = stock.index(c, r);
        if (stock.voidMask[i]) continue;
        const { x, y } = stock.gridToWorld(c, r);
        const d = stock.depth[i];
        // Exaggerate cut depth visually so isolation grooves read clearly
        // (logical depth stays correct in the height field / measurements)
        const visualDepthScale = 12;
        const z = -d * visualDepthScale;
        positions.push(x, z, y); // Three.js Y-up: map PCB Y -> Z
        vertIndex[i] = vi++;

        if (viewMode === 'depth-heatmap') {
          const t = Math.min(1, d / maxD);
          const col = HEAT_LOW.clone().lerp(HEAT_HIGH, t);
          colors.push(col.r, col.g, col.b);
        } else if (viewMode === 'copper-removal') {
          // Highlight removed copper in copper color; keep remaining dark
          if (stock.copper[i] && d < stock.copperThickness * 0.25) {
            colors.push(0.12, 0.13, 0.15);
          } else {
            colors.push(COPPER.r, COPPER.g, COPPER.b);
          }
        } else {
          // Final PCB: copper remains vs exposed FR4 where milled
          const milled = !stock.copper[i] || d >= stock.copperThickness * 0.25;
          if (!milled) {
            colors.push(COPPER.r, COPPER.g, COPPER.b);
          } else {
            const t = Math.min(1, d / Math.max(stock.copperThickness, 0.05));
            const col = FR4.clone().lerp(FR4_DEEP, t);
            colors.push(col.r, col.g, col.b);
          }
        }
        normals.push(0, 1, 0);
      }
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i00 = stock.index(c, r);
        const i10 = stock.index(c + 1, r);
        const i01 = stock.index(c, r + 1);
        const i11 = stock.index(c + 1, r + 1);
        if (stock.voidMask[i00] || stock.voidMask[i10] || stock.voidMask[i01] || stock.voidMask[i11]) {
          continue;
        }
        const a = vertIndex[i00];
        const b = vertIndex[i10];
        const d = vertIndex[i01];
        const e = vertIndex[i11];
        if (a < 0 || b < 0 || d < 0 || e < 0) continue;
        indices.push(a, d, b);
        indices.push(b, d, e);
      }
    }

    // Recompute rough normals from depth gradient
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = stock.index(c, r);
        const vi0 = vertIndex[i];
        if (vi0 < 0) continue;
        const dzdx =
          (stock.depth[stock.index(c + 1, r)] - stock.depth[stock.index(c - 1, r)]) /
          (2 * stock.resolution);
        const dzdy =
          (stock.depth[stock.index(c, r + 1)] - stock.depth[stock.index(c, r - 1)]) /
          (2 * stock.resolution);
        // Normal of surface z = -depth(x,y): (-dzdx, 1, -dzdy) in our mapped coords
        // position is (x, -depth, y) so n ~ (d(depth)/dx, 1, d(depth)/dy) wait:
        // p = (x, -d, y), dp/dx = (1, -dd/dx, 0), dp/dy = (0, -dd/dy, 1)
        // n = dp/dx × dp/dy = ( (-dd/dx)*1 - 0, 0-1, 1*(-dd/dy)-0 ) ... 
        // Actually: i(1,-ddx,0) × j(0,-ddy,1) = ( -ddx*1 - 0, 0-1, 1*(-ddy)-0) = (-ddx, -1, -ddy)
        // Flip to point up: (ddx, 1, ddy)
        const nx = dzdx;
        const ny = 1;
        const nz = dzdy;
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[vi0 * 3] = nx / len;
        normals[vi0 * 3 + 1] = ny / len;
        normals[vi0 * 3 + 2] = nz / len;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    disposables.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // Keep metalness low so FR4 green stays readable vs copper
      metalness: 0.15,
      roughness: 0.65,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'top';
    group.add(mesh);
  }

  // FR4 substrate slab — top face BELOW copper layer to avoid Z-fighting with the top mesh
  {
    const t = stock.thickness;
    const copperLift = Math.max(stock.copperThickness, 0.04);
    const geo = new THREE.BoxGeometry(stock.widthMm, t, stock.heightMm);
    disposables.push(geo);
    const mat = new THREE.MeshStandardMaterial({
      color: FR4_EDGE,
      metalness: 0.05,
      roughness: 0.9,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    // Box centered so its top is at y = -copperLift (clear of surface at y=0)
    mesh.position.set(
      stock.originX + stock.widthMm / 2,
      -copperLift - t / 2,
      stock.originY + stock.heightMm / 2
    );
    mesh.name = 'substrate';
    if (viewMode !== 'toolpaths') group.add(mesh);
  }

  // Side walls for through-holes / cutouts: simple cylinder placeholders are expensive;
  // void in top mesh already shows holes against substrate.

  return {
    group,
    dispose: () => {
      for (const g of disposables) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

export function buildToolpathLines(jobs: JobFile[]): BoardMeshes {
  const group = new THREE.Group();
  group.name = 'toolpaths';
  const disposables: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  for (const job of jobs) {
    if (!job.enabled || !job.parse) continue;
    const cutPts: number[] = [];
    const rapidPts: number[] = [];

    for (const seg of job.parse.segments) {
      const arr = seg.type === 'rapid' ? rapidPts : cutPts;
      arr.push(seg.x0, seg.z0, seg.y0, seg.x1, seg.z1, seg.y1);
    }

    if (cutPts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(cutPts, 3));
      disposables.push(geo);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(job.color),
        linewidth: 1,
        transparent: true,
        opacity: 0.85,
      });
      materials.push(mat);
      group.add(new THREE.LineSegments(geo, mat));
    }
    if (rapidPts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(rapidPts, 3));
      disposables.push(geo);
      const mat = new THREE.LineBasicMaterial({
        color: 0x64748b,
        transparent: true,
        opacity: 0.35,
      });
      materials.push(mat);
      group.add(new THREE.LineSegments(geo, mat));
    }
  }

  return {
    group,
    dispose: () => {
      for (const g of disposables) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

export function buildToolMarker(): THREE.Group {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 1.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.6, roughness: 0.3 })
  );
  cone.rotation.x = Math.PI;
  cone.position.y = 0.6;
  g.add(cone);
  return g;
}

type AnnotBag = {
  pts: number[];
  disposables: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  group: THREE.Group;
};

function pushSeg(
  pts: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
) {
  pts.push(ax, ay, az, bx, by, bz);
}

function addLabelSprite(
  bag: AnnotBag,
  text: string,
  x: number,
  y: number,
  z: number,
  worldW = 14,
  worldH = 3.2
) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 72;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.fillStyle = 'rgba(15, 23, 42, 0.75)';
  ctx2d.fillRect(6, 8, 308, 56);
  ctx2d.fillStyle = '#f8fafc';
  ctx2d.font = 'bold 26px ui-sans-serif, system-ui, sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(text, 160, 36);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  bag.textures.push(tex);
  const spriteMat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  bag.materials.push(spriteMat);
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(worldW, worldH, 1);
  sprite.position.set(x, y, z);
  bag.group.add(sprite);
}

function addEndCap(
  bag: AnnotBag,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color = 0xfbbf24
) {
  const mat = new THREE.MeshBasicMaterial({ color });
  bag.materials.push(mat);
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  bag.disposables.push(geo);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  bag.group.add(mesh);
}

/**
 * World-space plot annotations:
 * - 20 mm (2 cm) comparison ruler at top-center (actual-size check)
 * - PCB width dimension along bottom edge
 * - PCB height dimension along left edge
 */
export function buildComparisonRuler(stock: HeightFieldStock): BoardMeshes {
  const group = new THREE.Group();
  group.name = 'comparison-ruler';

  const bag: AnnotBag = {
    pts: [],
    disposables: [],
    materials: [],
    textures: [],
    group,
  };

  const yLift = 0.12;
  const gap = 3.5;
  const tickOut = 2.6;
  const xMin = stock.originX;
  const xMax = stock.originX + stock.widthMm;
  const zMin = stock.originY;
  const zMax = stock.originY + stock.heightMm;
  const cx = (xMin + xMax) / 2;
  const cz = (zMin + zMax) / 2;
  const w = stock.widthMm;
  const h = stock.heightMm;

  // —— 2 cm comparison ruler (top center, outside PCB) ——
  {
    const LENGTH_MM = 20;
    const zBase = zMax + gap;
    const x0 = cx - LENGTH_MM / 2;
    const x1 = cx + LENGTH_MM / 2;
    pushSeg(bag.pts, x0, yLift, zBase, x1, yLift, zBase);
    for (let i = 0; i <= LENGTH_MM; i++) {
      const x = x0 + i;
      let tick = 1.0;
      if (i % 10 === 0) tick = 2.8;
      else if (i % 5 === 0) tick = 1.9;
      pushSeg(bag.pts, x, yLift, zBase, x, yLift, zBase + tick);
    }
    addEndCap(bag, x0, yLift, zBase + 1.4, 0.18, 0.12, 3.0);
    addEndCap(bag, x1, yLift, zBase + 1.4, 0.18, 0.12, 3.0);
    addLabelSprite(bag, '2 cm  ·  20 mm', cx, yLift + 0.5, zBase + 5.2, 12, 3);
  }

  // —— PCB width (along bottom / −Y edge) ——
  {
    const zDim = zMin - gap;
    pushSeg(bag.pts, xMin, yLift, zDim, xMax, yLift, zDim);
    // Extension ticks toward board
    pushSeg(bag.pts, xMin, yLift, zDim, xMin, yLift, zDim + tickOut);
    pushSeg(bag.pts, xMax, yLift, zDim, xMax, yLift, zDim + tickOut);
    // Outer end caps
    addEndCap(bag, xMin, yLift, zDim - 0.2, 0.2, 0.12, 2.4, 0x38bdf8);
    addEndCap(bag, xMax, yLift, zDim - 0.2, 0.2, 0.12, 2.4, 0x38bdf8);
    addLabelSprite(
      bag,
      `W  ${formatMm(w)}`,
      cx,
      yLift + 0.5,
      zDim - 4.2,
      Math.min(22, Math.max(12, w * 0.35)),
      3.2
    );
  }

  // —— PCB height (along left / −X edge) ——
  {
    const xDim = xMin - gap;
    pushSeg(bag.pts, xDim, yLift, zMin, xDim, yLift, zMax);
    pushSeg(bag.pts, xDim, yLift, zMin, xDim + tickOut, yLift, zMin);
    pushSeg(bag.pts, xDim, yLift, zMax, xDim + tickOut, yLift, zMax);
    addEndCap(bag, xDim - 0.2, yLift, zMin, 2.4, 0.12, 0.2, 0x38bdf8);
    addEndCap(bag, xDim - 0.2, yLift, zMax, 2.4, 0.12, 0.2, 0x38bdf8);
    addLabelSprite(
      bag,
      `H  ${formatMm(h)}`,
      xDim - 5.5,
      yLift + 0.5,
      cz,
      Math.min(22, Math.max(12, h * 0.35)),
      3.2
    );
  }

  const lineMat = new THREE.LineBasicMaterial({
    color: 0xf8fafc,
    depthTest: true,
    transparent: true,
    opacity: 0.95,
  });
  bag.materials.push(lineMat);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(bag.pts, 3));
  bag.disposables.push(geo);
  group.add(new THREE.LineSegments(geo, lineMat));

  return {
    group,
    dispose: () => {
      for (const g of bag.disposables) g.dispose();
      for (const m of bag.materials) m.dispose();
      for (const t of bag.textures) t.dispose();
    },
  };
}
