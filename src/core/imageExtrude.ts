import * as THREE from 'three';
import type { ImageRegion, SegmentedImage } from './imageRegions';
import { traceMaskOutlines, type OutlineOptions, type Pt } from './maskContour';

export interface PixelBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthPx: number;
  heightPx: number;
}

export interface ExtrudeSettings {
  /** Physical left-to-right size of the 3D solid (yellow ruler) in mm */
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

/** Tight pixel box of enabled, printable regions (the 3D solid, not image padding). */
export function foregroundPixelBox(seg: SegmentedImage): PixelBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of seg.regions) {
    if (!r.enabled || r.heightMm <= 0) continue;
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    widthPx: maxX - minX + 1,
    heightPx: maxY - minY + 1,
  };
}

export function pixelMmForModelWidth(seg: SegmentedImage, widthMm: number): number {
  const box = foregroundPixelBox(seg);
  const px = box && box.widthPx > 0 ? box.widthPx : Math.max(1, seg.width);
  return widthMm / px;
}

function makeBasePart(
  width: number,
  height: number,
  pixelMm: number,
  baseHeightMm: number,
  body: PixelBox | null
): ExtrudedPart {
  const bw = (body?.widthPx ?? width) * pixelMm;
  const bd = (body?.heightPx ?? height) * pixelMm;
  const geo = new THREE.BoxGeometry(bw, bd, baseHeightMm);
  const ox = -(width * pixelMm) / 2;
  const oy = -(height * pixelMm) / 2;
  let cx = 0;
  let cy = 0;
  if (body) {
    cx = ox + ((body.minX + body.maxX + 1) / 2) * pixelMm;
    const top = oy + (height - body.minY) * pixelMm;
    const bottom = oy + (height - 1 - body.maxY) * pixelMm;
    cy = (top + bottom) / 2;
  }
  geo.translate(cx, cy, baseHeightMm / 2);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return {
    id: 'base',
    name: 'Base',
    hex: '#f2f2f2',
    color: 0xf2f2f2,
    heightMm: baseHeightMm,
    geometry: geo,
    triangleCount: Math.floor((geo.getIndex()?.count ?? 0) / 3),
  };
}

function fitPartsToModelWidth(parts: ExtrudedPart[], widthMm: number) {
  const box = partsBoundingMm(parts);
  if (!box || box.widthMm < 1e-8) return;
  const s = widthMm / box.widthMm;
  if (Math.abs(s - 1) < 1e-5) return;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  for (const p of parts) {
    p.geometry.translate(-cx, -cy, 0);
    p.geometry.scale(s, s, 1);
    p.geometry.translate(cx, cy, 0);
    p.geometry.computeVertexNormals();
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
  }
}

export function extrudeOneRegion(
  r: ImageRegion,
  width: number,
  height: number,
  settings: ExtrudeSettings,
  pixelMm: number
): ExtrudedPart | null {
  if (!r.enabled || r.heightMm <= 0) return null;
  const z0 = settings.baseEnabled && settings.baseHeightMm > 0 ? settings.baseHeightMm : 0;
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
    return null;
  }
  const printHex = r.printHex || '#000000';
  return {
    id: r.id,
    name: r.name,
    hex: printHex,
    color: hexToNumber(printHex),
    heightMm: r.heightMm,
    geometry: geo,
    triangleCount: triangleCountOf(geo),
  };
}

export function buildExtrudedParts(
  segmented: SegmentedImage,
  settings: ExtrudeSettings
): ExtrudedPart[] {
  const { width, height, regions } = segmented;
  const body = foregroundPixelBox(segmented);
  const pixelMm = pixelMmForModelWidth(segmented, settings.widthMm);
  const parts: ExtrudedPart[] = [];

  if (settings.baseEnabled && settings.baseHeightMm > 0) {
    parts.push(makeBasePart(width, height, pixelMm, settings.baseHeightMm, body));
  }

  for (const r of regions) {
    const part = extrudeOneRegion(r, width, height, settings, pixelMm);
    if (part) parts.push(part);
  }

  fitPartsToModelWidth(parts, settings.widthMm);
  return parts;
}

/** Keep unchanged meshes; drop removed holes; rebuild only punched parts. */
export function syncExtrudedParts(
  prev: ExtrudedPart[],
  segmented: SegmentedImage,
  settings: ExtrudeSettings,
  removedIds: string[],
  changedIds: string[]
): ExtrudedPart[] {
  const drop = new Set([...removedIds, ...changedIds]);
  const keepBase = settings.baseEnabled && settings.baseHeightMm > 0;
  const alive = new Set(segmented.regions.filter((r) => r.enabled && r.heightMm > 0).map((r) => r.id));
  const next: ExtrudedPart[] = [];
  let hasBase = false;

  for (const p of prev) {
    if (p.id === 'base') {
      if (keepBase) {
        next.push(p);
        hasBase = true;
      } else {
        p.geometry.dispose();
      }
      continue;
    }
    if (drop.has(p.id) || !alive.has(p.id)) {
      p.geometry.dispose();
      continue;
    }
    next.push(p);
  }

  if (keepBase && !hasBase) {
    const pixelMm = pixelMmForModelWidth(segmented, settings.widthMm);
    next.push(
      makeBasePart(
        segmented.width,
        segmented.height,
        pixelMm,
        settings.baseHeightMm,
        foregroundPixelBox(segmented)
      )
    );
  }

  const have = new Set(next.map((p) => p.id));
  const pixelMm = pixelMmForModelWidth(segmented, settings.widthMm);
  for (const r of segmented.regions) {
    if (!alive.has(r.id) || have.has(r.id)) continue;
    const part = extrudeOneRegion(r, segmented.width, segmented.height, settings, pixelMm);
    if (part) next.push(part);
  }
  return next;
}

export function modelSizeMm(
  segmented: SegmentedImage,
  widthMm: number
): { widthMm: number; heightMm: number; depthMm: number; pixelMm: number } {
  const pixelMm = pixelMmForModelWidth(segmented, widthMm);
  const body = foregroundPixelBox(segmented);
  return {
    widthMm,
    heightMm: (body?.heightPx ?? segmented.height) * pixelMm,
    depthMm: pixelMm,
    pixelMm,
  };
}

/** Axis-aligned bounds of the extruded solids in mm (the 3D body, not the source image). */
export function partsBoundingMm(parts: ExtrudedPart[]): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of parts) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    const b = p.geometry.boundingBox;
    if (!b || b.isEmpty()) continue;
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    widthMm: maxX - minX,
    depthMm: maxY - minY,
    heightMm: maxZ - minZ,
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
