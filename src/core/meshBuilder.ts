import * as THREE from 'three';
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
