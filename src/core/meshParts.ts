import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { meshStats } from './threemf';

export const DEFAULT_PART_COLOR = 0x9aa8b8;

/** Distinct colors for selected parts / groups. */
export const PART_PALETTE: number[] = [
  0x3d9cf0,
  0xf0b429,
  0x7fd962,
  0xf07178,
  0xc792ea,
  0x89ddff,
  0xff9e64,
  0x82aaff,
  0xc3e88d,
  0xff5370,
  0xbb80b3,
  0xffcb6b,
];

export interface MeshPart {
  id: string;
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  vertexCount: number;
  /** AABB diagonal in model units. */
  size: number;
}

export interface PartGroup {
  id: string;
  name: string;
  color: number;
  partIds: string[];
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function toIndexedTriangles(geometry: THREE.BufferGeometry): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const geo = geometry.index ? geometry : geometry.toNonIndexed();
  const posAttr = geo.getAttribute('position');
  if (!posAttr) throw new Error('Geometry has no positions');

  const positions = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    positions[i * 3] = posAttr.getX(i);
    positions[i * 3 + 1] = posAttr.getY(i);
    positions[i * 3 + 2] = posAttr.getZ(i);
  }

  let indices: Uint32Array;
  if (geo.index) {
    const src = geo.index.array;
    indices = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) indices[i] = src[i];
  } else {
    indices = new Uint32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) indices[i] = i;
  }
  return { positions, indices };
}

function geometryFromArrays(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
  const idx = new Uint32Array(indices);
  const [remap, unique] = MeshoptSimplifier.compactMesh(idx);
  const compacted = new Float32Array(unique * 3);
  const missing = 0xffffffff;
  for (let i = 0; i < remap.length; i++) {
    const neu = remap[i];
    if (neu === missing) continue;
    compacted[neu * 3] = positions[i * 3];
    compacted[neu * 3 + 1] = positions[i * 3 + 1];
    compacted[neu * 3 + 2] = positions[i * 3 + 2];
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(compacted, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function bboxDiagonal(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return 0;
  return box.min.distanceTo(box.max);
}

export function makePart(geometry: THREE.BufferGeometry, id = newId()): MeshPart {
  const stats = meshStats(geometry);
  return {
    id,
    geometry,
    triangleCount: stats.triangleCount,
    vertexCount: stats.vertexCount,
    size: bboxDiagonal(geometry),
  };
}

export function clonePart(part: MeshPart): MeshPart {
  const g = part.geometry.clone();
  const pos = g.getAttribute('position');
  if (pos) {
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(pos.array as ArrayLike<number>), pos.itemSize)
    );
  }
  const index = g.getIndex();
  if (index) {
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(index.array as ArrayLike<number>), 1));
  }
  return {
    id: part.id,
    geometry: g,
    triangleCount: part.triangleCount,
    vertexCount: part.vertexCount,
    size: part.size,
  };
}

export function disposePart(part: MeshPart) {
  part.geometry.dispose();
}

export function disposeParts(parts: MeshPart[]) {
  parts.forEach(disposePart);
}

export function totalStats(parts: MeshPart[]): { triangleCount: number; vertexCount: number } {
  let triangleCount = 0;
  let vertexCount = 0;
  for (const p of parts) {
    triangleCount += p.triangleCount;
    vertexCount += p.vertexCount;
  }
  return { triangleCount, vertexCount };
}

export function modelDiagonal(parts: MeshPart[]): number {
  const box = new THREE.Box3();
  for (const p of parts) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
  }
  if (box.isEmpty()) return 0;
  return box.min.distanceTo(box.max);
}

/**
 * Split a mesh into closed (vertex-connected) components, largest first.
 */
export async function splitConnectedComponents(
  geometry: THREE.BufferGeometry
): Promise<MeshPart[]> {
  await MeshoptSimplifier.ready;
  const { positions, indices } = toIndexedTriangles(geometry);
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return [];

  const vertCount = positions.length / 3;
  const parent = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) parent[i] = i;

  const find = (a: number): number => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    unite(indices[i], indices[i + 1]);
    unite(indices[i + 1], indices[i + 2]);
  }

  const buckets = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const root = find(indices[i]);
    let list = buckets.get(root);
    if (!list) {
      list = [];
      buckets.set(root, list);
    }
    list.push(indices[i], indices[i + 1], indices[i + 2]);
  }

  const parts: MeshPart[] = [];
  for (const tris of buckets.values()) {
    if (tris.length < 3) continue;
    const geo = geometryFromArrays(positions, Uint32Array.from(tris));
    parts.push(makePart(geo));
  }

  parts.sort((a, b) => b.triangleCount - a.triangleCount);
  return parts;
}

export function mergePartGeometries(parts: MeshPart[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error('No parts to merge');
  if (parts.length === 1) return parts[0].geometry.clone();
  const geos = parts.map((p) => {
    const g = p.geometry.clone();
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
    }
    return g;
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) throw new Error('Failed to merge parts');
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function nextPaletteColor(used: number[]): number {
  for (const c of PART_PALETTE) {
    if (!used.includes(c)) return c;
  }
  return PART_PALETTE[used.length % PART_PALETTE.length];
}

export function lightenColor(hex: number, amount = 0.25): number {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const lr = Math.min(1, r + (1 - r) * amount);
  const lg = Math.min(1, g + (1 - g) * amount);
  const lb = Math.min(1, b + (1 - b) * amount);
  return (Math.round(lr * 255) << 16) | (Math.round(lg * 255) << 8) | Math.round(lb * 255);
}

export function colorToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/**
 * Resolve display color for a part given selection + groups.
 * Selected ungrouped parts each get a distinct palette color by selection order.
 */
export function resolvePartColor(
  partId: string,
  selectedIds: string[],
  groups: PartGroup[]
): number {
  const group = groups.find((g) => g.partIds.includes(partId));
  const selected = selectedIds.includes(partId);
  if (group) {
    return selected ? lightenColor(group.color, 0.35) : group.color;
  }
  if (selected) {
    const idx = selectedIds.indexOf(partId);
    return PART_PALETTE[((idx % PART_PALETTE.length) + PART_PALETTE.length) % PART_PALETTE.length];
  }
  return DEFAULT_PART_COLOR;
}

/** Drop part ids from groups; remove empty groups. */
export function scrubGroups(groups: PartGroup[], removedPartIds: Set<string>): PartGroup[] {
  return groups
    .map((g) => ({
      ...g,
      partIds: g.partIds.filter((id) => !removedPartIds.has(id)),
    }))
    .filter((g) => g.partIds.length > 0);
}

/** After replacing old part ids with a new part, retarget groups. */
export function remapGroupsAfterReplace(
  groups: PartGroup[],
  removedPartIds: Set<string>,
  newPartId: string,
  keepGroupId?: string
): PartGroup[] {
  return groups
    .map((g) => {
      const hit = g.partIds.some((id) => removedPartIds.has(id));
      if (!hit) return g;
      if (keepGroupId && g.id === keepGroupId) {
        return { ...g, partIds: [newPartId] };
      }
      // Parts taken out of other groups
      return {
        ...g,
        partIds: g.partIds.filter((id) => !removedPartIds.has(id)),
      };
    })
    .filter((g) => g.partIds.length > 0);
}

export function cloneGroups(groups: PartGroup[]): PartGroup[] {
  return groups.map((g) => ({ ...g, partIds: [...g.partIds] }));
}
