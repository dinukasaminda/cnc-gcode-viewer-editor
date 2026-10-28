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

/** Build a minimal single-object 3MF (ZIP) from a BufferGeometry. */
export function exportGeometryTo3mf(geometry: THREE.BufferGeometry, objectName = 'Model'): Uint8Array {
  const geo = geometry.index ? geometry : geometry.toNonIndexed();
  const pos = geo.getAttribute('position');
  if (!pos) throw new Error('Geometry has no positions');

  let indices: ArrayLike<number>;
  if (geo.index) {
    indices = geo.index.array;
  } else {
    const arr = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) arr[i] = i;
    indices = arr;
  }

  const vertexLines: string[] = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    vertexLines[i] = `<vertex x="${fmt(pos.getX(i))}" y="${fmt(pos.getY(i))}" z="${fmt(pos.getZ(i))}" />`;
  }

  const triCount = Math.floor(indices.length / 3);
  const triangleLines: string[] = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    triangleLines[t] = `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" />`;
  }

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">cnc-gcode-viewer 3MF Simplifier</metadata>
  <metadata name="Title">${escapeXml(objectName)}</metadata>
  <resources>
    <object id="1" name="${escapeXml(objectName)}" type="model">
      <mesh>
        <vertices>
${vertexLines.join('\n')}
        </vertices>
        <triangles>
${triangleLines.join('\n')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
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
