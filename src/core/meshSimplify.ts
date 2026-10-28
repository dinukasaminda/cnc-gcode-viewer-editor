import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { meshStats } from './threemf';

export interface SimplifyOptions {
  /** Keep this fraction of triangles (0.01–1). */
  ratio: number;
  /** Relative target error for meshoptimizer (higher = more aggressive). */
  targetError?: number;
  /** Also prune tiny disconnected components (meshoptimizer prune). */
  prune?: boolean;
  /** Absolute size (AABB diagonal, model units) below which components are dropped. */
  minFeatureSize?: number;
}

export interface SimplifyResult {
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  vertexCount: number;
  removedTriangles: number;
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
  // compactMesh mutates indices in place and returns [vertexRemap, uniqueCount]
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

/**
 * Drop connected triangle components whose AABB diagonal is below minSize.
 */
export function removeSmallComponents(
  geometry: THREE.BufferGeometry,
  minSize: number
): SimplifyResult {
  const before = meshStats(geometry);
  if (minSize <= 0) {
    return { geometry: geometry.clone(), ...before, removedTriangles: 0 };
  }

  const { positions, indices } = toIndexedTriangles(geometry);
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) {
    return { geometry: geometry.clone(), ...before, removedTriangles: 0 };
  }

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
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    unite(a, b);
    unite(b, c);
  }

  // AABB per component root
  const minX = new Float32Array(vertCount).fill(Infinity);
  const minY = new Float32Array(vertCount).fill(Infinity);
  const minZ = new Float32Array(vertCount).fill(Infinity);
  const maxX = new Float32Array(vertCount).fill(-Infinity);
  const maxY = new Float32Array(vertCount).fill(-Infinity);
  const maxZ = new Float32Array(vertCount).fill(-Infinity);

  for (let v = 0; v < vertCount; v++) {
    const r = find(v);
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    if (x < minX[r]) minX[r] = x;
    if (y < minY[r]) minY[r] = y;
    if (z < minZ[r]) minZ[r] = z;
    if (x > maxX[r]) maxX[r] = x;
    if (y > maxY[r]) maxY[r] = y;
    if (z > maxZ[r]) maxZ[r] = z;
  }

  const keepRoot = new Uint8Array(vertCount);
  for (let r = 0; r < vertCount; r++) {
    if (parent[r] !== r) continue;
    if (!Number.isFinite(minX[r])) continue;
    const dx = maxX[r] - minX[r];
    const dy = maxY[r] - minY[r];
    const dz = maxZ[r] - minZ[r];
    const diag = Math.hypot(dx, dy, dz);
    if (diag >= minSize) keepRoot[r] = 1;
  }

  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const root = find(indices[i]);
    if (keepRoot[root]) {
      kept.push(indices[i], indices[i + 1], indices[i + 2]);
    }
  }

  if (kept.length === 0) {
    // Avoid empty mesh — keep original
    return { geometry: geometry.clone(), ...before, removedTriangles: 0 };
  }

  const out = geometryFromArrays(positions, Uint32Array.from(kept));
  const after = meshStats(out);
  return {
    geometry: out,
    ...after,
    removedTriangles: before.triangleCount - after.triangleCount,
  };
}

export async function simplifyMesh(
  geometry: THREE.BufferGeometry,
  options: SimplifyOptions
): Promise<SimplifyResult> {
  await MeshoptSimplifier.ready;

  const before = meshStats(geometry);
  let { positions, indices } = toIndexedTriangles(geometry);

  const ratio = Math.min(1, Math.max(0.01, options.ratio));
  const targetError = options.targetError ?? 0.01;
  const flags: Array<'LockBorder' | 'Prune'> = [];
  if (options.prune) flags.push('Prune');

  const targetCount = Math.max(3, Math.floor((indices.length / 3) * ratio) * 3);
  const [simplified] = MeshoptSimplifier.simplify(
    indices,
    positions,
    3,
    targetCount,
    targetError,
    flags.length ? flags : undefined
  );

  indices = simplified;

  if (options.prune) {
    indices = MeshoptSimplifier.simplifyPrune(indices, positions, 3, targetError);
  }

  let out = geometryFromArrays(positions, indices);

  if (options.minFeatureSize != null && options.minFeatureSize > 0) {
    const pruned = removeSmallComponents(out, options.minFeatureSize);
    out.dispose();
    out = pruned.geometry;
  }

  const after = meshStats(out);
  return {
    geometry: out,
    ...after,
    removedTriangles: before.triangleCount - after.triangleCount,
  };
}

export function cloneGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.clone();
  // Ensure buffers are detached copies for undo stack safety
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
  return g;
}
