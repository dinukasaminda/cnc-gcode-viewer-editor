import { zipSync, strToU8 } from 'fflate';
import * as THREE from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const DEFAULT_3MF_SAMPLE = '/samples/MoonLamp+v2.2.3mf';

export interface Loaded3mf {
  name: string;
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  vertexCount: number;
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) meshes.push(mesh);
    }
  });
  return meshes;
}

function geometryFromMeshes(meshes: THREE.Mesh[]): THREE.BufferGeometry {
  if (meshes.length === 0) {
    throw new Error('3MF contains no mesh geometry');
  }

  const parts: THREE.BufferGeometry[] = [];
  for (const mesh of meshes) {
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    if (!geo.getAttribute('position')) continue;
    // Drop non-position attrs so merge stays simple / exportable
    for (const key of Object.keys(geo.attributes)) {
      if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
    }
    if (!geo.index) {
      const pos = geo.getAttribute('position');
      const idx = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) idx[i] = i;
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    parts.push(geo);
  }

  if (parts.length === 0) throw new Error('3MF meshes have no positions');

  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error('Failed to merge 3MF meshes');

  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function meshStats(geometry: THREE.BufferGeometry): {
  triangleCount: number;
  vertexCount: number;
} {
  const pos = geometry.getAttribute('position');
  const vertexCount = pos?.count ?? 0;
  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3);
  return { triangleCount, vertexCount };
}

export async function load3mfFromUrl(url: string, name?: string): Promise<Loaded3mf> {
  const loader = new ThreeMFLoader();
  const group = await loader.loadAsync(url);
  const geometry = geometryFromMeshes(collectMeshes(group));
  const stats = meshStats(geometry);
  const fileName = name ?? url.split('/').pop() ?? 'model.3mf';
  return { name: fileName, geometry, ...stats };
}

export async function load3mfFromArrayBuffer(
  buffer: ArrayBuffer,
  name: string
): Promise<Loaded3mf> {
  const loader = new ThreeMFLoader();
  const group = loader.parse(buffer);
  const geometry = geometryFromMeshes(collectMeshes(group));
  const stats = meshStats(geometry);
  return { name, geometry, ...stats };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Trim noisy floats for smaller XML
  return (Math.round(n * 1e5) / 1e5).toString();
}

/** Weld split vertices (flat-shaded extrusions) so slicers get a closed, shared-vertex mesh. */
function weldPositions(geo: THREE.BufferGeometry): { positions: number[]; indices: Uint32Array } {
  const pos = geo.getAttribute('position');
  const src = geo.index ? geo.index.array : null;
  const triVerts = src ? src.length : pos.count;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      map.set(key, id);
    }
    remap[i] = id;
  }
  const out: number[] = [];
  for (let t = 0; t + 2 < triVerts; t += 3) {
    const a = remap[src ? src[t] : t];
    const b = remap[src ? src[t + 1] : t + 1];
    const c = remap[src ? src[t + 2] : t + 2];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return { positions, indices: new Uint32Array(out) };
}

function geometryToMeshXml(geometry: THREE.BufferGeometry, objectId: number, objectName: string): string {
  if (!geometry.getAttribute('position')) throw new Error('Geometry has no positions');
  const { positions, indices } = weldPositions(geometry);
  const vertCount = positions.length / 3;

  const vertexLines: string[] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    vertexLines[i] = `<vertex x="${fmt(positions[i * 3])}" y="${fmt(positions[i * 3 + 1])}" z="${fmt(positions[i * 3 + 2])}" />`;
  }

  const triCount = Math.floor(indices.length / 3);
  const triangleLines: string[] = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    triangleLines[t] = `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" />`;
  }

  return `    <object id="${objectId}" name="${escapeXml(objectName)}" type="model">
      <mesh>
        <vertices>
${vertexLines.join('\n')}
        </vertices>
        <triangles>
${triangleLines.join('\n')}
        </triangles>
      </mesh>
    </object>`;
}

export interface ThreemfObject {
  name: string;
  geometry: THREE.BufferGeometry;
}

/** Build a 3MF (ZIP) with one or more mesh objects (separate printable parts). */
export function exportGeometriesTo3mf(
  objects: ThreemfObject[],
  title = 'Model'
): Uint8Array {
  if (objects.length === 0) throw new Error('No objects to export');

  const resourceXml = objects
    .map((o, i) => geometryToMeshXml(o.geometry, i + 1, o.name || `Part ${i + 1}`))
    .join('\n');
  const buildXml = objects.map((_, i) => `    <item objectid="${i + 1}" />`).join('\n');

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">SKL Tools Image→3D</metadata>
  <metadata name="Title">${escapeXml(title)}</metadata>
  <resources>
${resourceXml}
  </resources>
  <build>
${buildXml}
  </build>
</model>
`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`;

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(modelXml),
    },
    { level: 6 }
  );
}

/** Build a minimal single-object 3MF (ZIP) from a BufferGeometry. */
export function exportGeometryTo3mf(geometry: THREE.BufferGeometry, objectName = 'Model'): Uint8Array {
  return exportGeometriesTo3mf([{ name: objectName, geometry }], objectName);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function download3mf(data: Uint8Array, filename: string) {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type: 'model/3mf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.3mf') ? filename : `${filename}.3mf`;
  a.click();
  URL.revokeObjectURL(url);
}

export function suggested3mfName(original: string, tag = 'simplified'): string {
  const base = original.replace(/\.3mf$/i, '') || 'model';
  return `${base}_${tag}.3mf`;
}
