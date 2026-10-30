import * as THREE from 'three';
import type { ImageRegion, SegmentedImage } from './imageRegions';
import { traceMaskOutlines, type OutlineOptions, type Pt } from './maskContour';

export interface ExtrudeSettings {
  /** Physical width of the full working bitmap in mm */
  widthMm: number;
  /** Optional base plate height (0 = none). Uses lightest bg color. */
  baseHeightMm: number;
  /** Z of the bottom of features (base top). */
  baseEnabled: boolean;
  /** Traced smooth outlines (default). False = pixel blocks. */
  smoothEdges?: boolean;
  /** Outline cleanup tuning for smooth edges (defaults when omitted). */
  outline?: Partial<OutlineOptions>;
}

export interface ExtrudedPart {
  id: string;
  name: string;
  hex: string;
  color: number;
  heightMm: number;
  geometry: THREE.BufferGeometry;
  triangleCount: number;
}

function solid(
  mask: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  bbox?: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (bbox) {
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) return false;
    const mw = bbox.maxX - bbox.minX + 1;
    return mask[(y - bbox.minY) * mw + (x - bbox.minX)] === 1;
  }
  return mask[y * w + x] === 1;
}

/**
 * Greedy mesh extrusion of a binary mask.
 * Image lies on the XY plane (Z up): +X right, +Y up the image, +Z extrude height.
 */
export function extrudeMaskToGeometry(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelMm: number,
  heightMm: number,
  z0 = 0,
  bbox?: { minX: number; minY: number; maxX: number; maxY: number }
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  let vbase = 0;

  const pushQuad = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    vbase += 4;
  };

  const z1 = z0 + heightMm;
  // Center the plate on XY origin for nicer framing
  const ox = -(width * pixelMm) / 2;
  const oy = -(height * pixelMm) / 2;
  const y0b = bbox?.minY ?? 0;
  const y1b = bbox?.maxY ?? height - 1;
  const x0b = bbox?.minX ?? 0;
  const x1b = bbox?.maxX ?? width - 1;

  for (let y = y0b; y <= y1b; y++) {
    for (let x = x0b; x <= x1b; x++) {
      if (!solid(mask, width, height, x, y, bbox)) continue;

      // Image row 0 at top → +Y; Z is up
      const x0 = ox + x * pixelMm;
      const x1 = ox + (x + 1) * pixelMm;
      const y0 = oy + (height - 1 - y) * pixelMm;
      const y1 = oy + (height - y) * pixelMm;

      // Top (+Z)
      pushQuad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
      // Bottom (-Z)
      pushQuad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0);

      // -Y wall
      if (!solid(mask, width, height, x, y + 1, bbox)) {
        pushQuad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      }
      // +Y wall
      if (!solid(mask, width, height, x, y - 1, bbox)) {
        pushQuad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
      }
      // -X wall
      if (!solid(mask, width, height, x - 1, y, bbox)) {
        pushQuad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
      }
      // +X wall
      if (!solid(mask, width, height, x + 1, y, bbox)) {
        pushQuad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Smooth extrusion: traced outlines (straight edges, sharp corners, curves)
 * extruded to height. Same XY placement as the pixel extrusion.
 */
export function extrudeMaskSmooth(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  pixelMm: number,
  heightMm: number,
  z0 = 0,
  outline: Partial<OutlineOptions> = {}
): THREE.BufferGeometry | null {
  const mw = bbox.maxX - bbox.minX + 1;
  const mh = bbox.maxY - bbox.minY + 1;
  const local = mask.length === mw * mh;
  const outlines = local
    ? traceMaskOutlines(mask, mw, mh, { minX: 0, minY: 0, maxX: mw - 1, maxY: mh - 1 }, outline)
    : traceMaskOutlines(mask, width, height, bbox, outline);
  if (outlines.length === 0) return null;
  const ox = -(width * pixelMm) / 2;
  const oy = -(height * pixelMm) / 2;
  const dx = local ? bbox.minX : 0;
  const dy = local ? bbox.minY : 0;
  const toV = (p: Pt) =>
    new THREE.Vector2(ox + (p.x + dx) * pixelMm, oy + (height - (p.y + dy)) * pixelMm);

  const shapes: THREE.Shape[] = [];
  for (const o of outlines) {
    const outer = o.outer.map(toV);
    if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
    const shape = new THREE.Shape(outer);
    for (const h of o.holes) {
      const hole = h.map(toV);
      if (!THREE.ShapeUtils.isClockWise(hole)) hole.reverse();
      shape.holes.push(new THREE.Path(hole));
    }
    shapes.push(shape);
  }

  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: heightMm,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geo.deleteAttribute('uv');
  geo.translate(0, 0, z0);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const count = geo.getAttribute('position')?.count ?? 0;
  if (count < 3) {
    geo.dispose();
    return null;
  }
  return geo;
}

function triangleCountOf(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  return Math.floor((idx ? idx.count : (geo.getAttribute('position')?.count ?? 0)) / 3);
}

function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

export function buildExtrudedParts(
  segmented: SegmentedImage,
  settings: ExtrudeSettings
): ExtrudedPart[] {
  const { width, height, regions } = segmented;
  const pixelMm = settings.widthMm / width;
  const parts: ExtrudedPart[] = [];
  const z0 = settings.baseEnabled && settings.baseHeightMm > 0 ? settings.baseHeightMm : 0;

  if (settings.baseEnabled && settings.baseHeightMm > 0) {
    const geo = new THREE.BoxGeometry(
      width * pixelMm,
      height * pixelMm,
      settings.baseHeightMm
    );
    geo.translate(0, 0, settings.baseHeightMm / 2);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    parts.push({
      id: 'base',
      name: 'Base',
      hex: '#f2f2f2',
      color: 0xf2f2f2,
      heightMm: settings.baseHeightMm,
      geometry: geo,
      triangleCount: Math.floor((geo.getIndex()?.count ?? 0) / 3),
    });
  }

  for (const r of regions) {
    if (!r.enabled || r.heightMm <= 0) continue;

    let geo: THREE.BufferGeometry | null = null;
    if (settings.smoothEdges !== false) {
      try {
        geo = extrudeMaskSmooth(r.mask, width, height, r, pixelMm, r.heightMm, z0, settings.outline);
      } catch {
        geo = null;
      }
    }
    if (!geo) {
      const area = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
      if (area <= 400_000) {
        geo = extrudeMaskToGeometry(r.mask, width, height, pixelMm, r.heightMm, z0, r);
      }
    }
    if (!geo || triangleCountOf(geo) < 1) {
      geo?.dispose();
      continue;
    }
    const printHex = r.printHex || '#000000';
    parts.push({
      id: r.id,
      name: r.name,
      hex: printHex,
      color: hexToNumber(printHex),
      heightMm: r.heightMm,
      geometry: geo,
      triangleCount: triangleCountOf(geo),
    });
  }

  return parts;
}

export function modelSizeMm(
  segmented: SegmentedImage,
  widthMm: number
): { widthMm: number; heightMm: number; depthMm: number; pixelMm: number } {
  const pixelMm = widthMm / segmented.width;
  return {
    widthMm,
    heightMm: segmented.height * pixelMm,
    depthMm: pixelMm,
    pixelMm,
  };
}

export function disposeExtruded(parts: ExtrudedPart[]) {
  for (const p of parts) p.geometry.dispose();
}

export function updateRegion(
  regions: ImageRegion[],
  id: string,
  patch: Partial<Pick<ImageRegion, 'heightMm' | 'enabled' | 'name' | 'printHex' | 'printHexCustom'>>
): ImageRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, ...patch } : r));
}
