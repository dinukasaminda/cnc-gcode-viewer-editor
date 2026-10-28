import * as THREE from 'three';
import type { MeshPart } from './meshParts';

export const PRINT_CONFIG_URL = '/config/bambu-a1-mini-print.json';

export interface PrintConfig {
  printer: {
    name: string;
    buildVolumeMm: [number, number, number];
  };
  nozzle: {
    diameterMm: number;
    lineWidthMm: number;
    maxVolumetricFlowMm3PerSec: number;
  };
  layer: {
    layerHeightMm: number;
    initialLayerHeightMm: number;
    secPerLayerOverhead: number;
  };
  shell: {
    wallLoops: number;
    topShellLayers: number;
    bottomShellLayers: number;
  };
  infill: {
    densityPercent: number;
    pattern: string;
  };
  speedsMmPerSec: {
    outerWall: number;
    innerWall: number;
    sparseInfill: number;
    solidInfill: number;
    topSurface: number;
    firstLayer: number;
    travel: number;
  };
  timeModel: {
    avgPrintSpeedWeight: {
      outerWall: number;
      innerWall: number;
      sparseInfill: number;
      solidInfill: number;
    };
    overheadFactor: number;
    scaleFactor: number;
  };
  calibration: {
    referenceFile: string;
    referenceLabel: string;
    referenceDiameterMm: number;
    referenceMeshVolumeMm3: number;
    referencePrintHours: number;
    notes: string[];
  };
  gcode: {
    headerFlavor: string;
    filamentDiameterMm: number;
    includeLayerMarkers: boolean;
    maxLayerMarkers: number;
  };
}

export interface MeshMetrics {
  volumeMm3: number;
  surfaceAreaMm2: number;
  heightMm: number;
  bboxVolumeMm3: number;
}

export interface PrintEstimate {
  printerName: string;
  seconds: number;
  hours: number;
  label: string;
  volumeMm3: number;
  extrudedMm3: number;
  layers: number;
  filamentMeters: number;
  notes: string;
  configSummary: string;
  rawHoursBeforeScale: number;
  scaleFactor: number;
}

let cachedConfig: PrintConfig | null = null;

export async function loadPrintConfig(url = PRINT_CONFIG_URL): Promise<PrintConfig> {
  if (cachedConfig) return cachedConfig;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load print config (${res.status})`);
  cachedConfig = (await res.json()) as PrintConfig;
  return cachedConfig;
}

export function clearPrintConfigCache() {
  cachedConfig = null;
}

/**
 * Signed volume + surface area from triangle soup (divergence theorem).
 */
export function metricsFromGeometry(geometry: THREE.BufferGeometry): MeshMetrics {
  const pos = geometry.getAttribute('position');
  if (!pos) {
    return { volumeMm3: 0, surfaceAreaMm2: 0, heightMm: 0, bboxVolumeMm3: 0 };
  }

  let indices: ArrayLike<number>;
  if (geometry.index) {
    indices = geometry.index.array;
  } else {
    const arr = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) arr[i] = i;
    indices = arr;
  }

  let volume = 0;
  let area = 0;
  const triCount = Math.floor(indices.length / 3);
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    ax.fromBufferAttribute(pos, indices[i]);
    bx.fromBufferAttribute(pos, indices[i + 1]);
    cx.fromBufferAttribute(pos, indices[i + 2]);
    cross.crossVectors(bx, cx);
    volume += ax.dot(cross);
    ab.subVectors(bx, ax);
    ac.subVectors(cx, ax);
    cross.crossVectors(ab, ac);
    area += cross.length() * 0.5;
  }

  volume = Math.abs(volume) / 6;

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  let heightMm = 0;
  let bboxVolumeMm3 = 0;
  if (box) {
    const size = box.getSize(new THREE.Vector3());
    heightMm = Math.max(size.x, size.y, size.z);
    bboxVolumeMm3 = Math.max(0, size.x * size.y * size.z);
  }

  if (volume < 1e-3 && bboxVolumeMm3 > 0) {
    volume = bboxVolumeMm3 * 0.35;
  }

  return { volumeMm3: volume, surfaceAreaMm2: area, heightMm, bboxVolumeMm3 };
}

export function metricsFromParts(parts: MeshPart[]): MeshMetrics {
  let volumeMm3 = 0;
  let surfaceAreaMm2 = 0;
  let heightMm = 0;
  let bboxVolumeMm3 = 0;
  const union = new THREE.Box3();

  for (const p of parts) {
    const m = metricsFromGeometry(p.geometry);
    volumeMm3 += m.volumeMm3;
    surfaceAreaMm2 += m.surfaceAreaMm2;
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    if (p.geometry.boundingBox) union.union(p.geometry.boundingBox);
  }

  if (!union.isEmpty()) {
    const size = union.getSize(new THREE.Vector3());
    heightMm = Math.max(size.x, size.y, size.z);
    bboxVolumeMm3 = Math.max(0, size.x * size.y * size.z);
  }

  return { volumeMm3, surfaceAreaMm2, heightMm, bboxVolumeMm3 };
}

export function formatPrintDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h <= 0) return `${Math.max(1, m)}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function weightedAvgSpeed(cfg: PrintConfig): number {
  const w = cfg.timeModel.avgPrintSpeedWeight;
  const s = cfg.speedsMmPerSec;
  const sumW = w.outerWall + w.innerWall + w.sparseInfill + w.solidInfill;
  return (
    (s.outerWall * w.outerWall +
      s.innerWall * w.innerWall +
      s.sparseInfill * w.sparseInfill +
      s.solidInfill * w.solidInfill) /
    Math.max(sumW, 1e-6)
  );
}

/**
 * @param linearScale extra uniform scale on model units (e.g. pending size calibration).
 * Volumes scale ^3, areas ^2, lengths ^1.
 */
export function estimatePrintFromConfig(
  parts: MeshPart[],
  cfg: PrintConfig,
  linearScale = 1
): PrintEstimate {
  const s = Number.isFinite(linearScale) && linearScale > 0 ? linearScale : 1;
  const raw = metricsFromParts(parts);
  const metrics = {
    volumeMm3: raw.volumeMm3 * s * s * s,
    surfaceAreaMm2: raw.surfaceAreaMm2 * s * s,
    heightMm: raw.heightMm * s,
    bboxVolumeMm3: raw.bboxVolumeMm3 * s * s * s,
  };
  const lineW = cfg.nozzle.lineWidthMm;
  const layerH = cfg.layer.layerHeightMm;
  const walls = cfg.shell.wallLoops;
  const infill = Math.min(1, Math.max(0, cfg.infill.densityPercent / 100));
  const height = Math.max(metrics.heightMm, layerH);
  const layers = Math.max(1, Math.ceil(height / layerH));

  let shellVol = metrics.surfaceAreaMm2 * walls * lineW;
  shellVol = Math.min(shellVol, metrics.volumeMm3 * 0.92);
  const innerVol = Math.max(0, metrics.volumeMm3 - shellVol);
  const infillVol = innerVol * infill;
  const footprint = height > 1e-6 ? metrics.volumeMm3 / height : 0;
  const skinLayers = cfg.shell.topShellLayers + cfg.shell.bottomShellLayers;
  const skinVol = footprint * skinLayers * layerH * (1 - infill);
  const extrudedMm3 = Math.max(shellVol + infillVol + skinVol, metrics.volumeMm3 * Math.max(infill, 0.05));

  const avgSpeed = weightedAvgSpeed(cfg);
  const pathLengthMm = extrudedMm3 / (lineW * layerH);
  const flowLimitedSec = extrudedMm3 / Math.max(cfg.nozzle.maxVolumetricFlowMm3PerSec, 0.01);
  const speedLimitedSec = pathLengthMm / Math.max(avgSpeed, 1);
  const extrusionSec = Math.max(flowLimitedSec, speedLimitedSec);
  const layerOverheadSec = layers * cfg.layer.secPerLayerOverhead;

  const rawSeconds = (extrusionSec + layerOverheadSec) * cfg.timeModel.overheadFactor;
  const rawHours = rawSeconds / 3600;
  const scale = cfg.timeModel.scaleFactor > 0 ? cfg.timeModel.scaleFactor : 1;
  const seconds = rawSeconds * scale;
  const hours = seconds / 3600;

  const filamentArea = Math.PI * (cfg.gcode.filamentDiameterMm / 2) ** 2;
  const filamentMeters = extrudedMm3 / filamentArea / 1000;

  const configSummary = `${cfg.nozzle.diameterMm} nozzle · ${layerH} layer · ${walls} walls · ${cfg.infill.densityPercent}% infill`;

  return {
    printerName: cfg.printer.name,
    seconds,
    hours,
    label: formatPrintDuration(seconds),
    volumeMm3: metrics.volumeMm3,
    extrudedMm3,
    layers,
    filamentMeters,
    notes: configSummary,
    configSummary,
    rawHoursBeforeScale: rawHours,
    scaleFactor: scale,
  };
}

/** Build a Bambu-ish estimated G-code report (not machine-ready toolpaths). */
export function buildEstimateGcode(
  estimate: PrintEstimate,
  cfg: PrintConfig,
  modelName: string
): string {
  const hours = Math.floor(estimate.seconds / 3600);
  const minutes = Math.floor((estimate.seconds % 3600) / 60);
  const lines: string[] = [
    `; HEADER_BLOCK_START`,
    `; bulk estimate — NOT a full slicer toolpath`,
    `; printer = ${cfg.printer.name}`,
    `; model = ${modelName}`,
    `; nozzle = ${cfg.nozzle.diameterMm} mm`,
    `; layer_height = ${cfg.layer.layerHeightMm} mm`,
    `; wall_loops = ${cfg.shell.wallLoops}`,
    `; sparse_infill_density = ${cfg.infill.densityPercent}%`,
    `; estimated_print_time = ${hours}h ${minutes}m (${estimate.hours.toFixed(2)} h)`,
    `; estimated_print_seconds = ${Math.round(estimate.seconds)}`,
    `; total_layer_count = ${estimate.layers}`,
    `; filament_used_m = ${estimate.filamentMeters.toFixed(2)}`,
    `; filament_used_mm3 = ${estimate.extrudedMm3.toFixed(1)}`,
    `; mesh_volume_mm3 = ${estimate.volumeMm3.toFixed(1)}`,
    `; time_scale_factor = ${estimate.scaleFactor}`,
    `; raw_hours_before_scale = ${estimate.rawHoursBeforeScale.toFixed(2)}`,
    `; calibration_ref = ${cfg.calibration.referenceLabel} @ ${cfg.calibration.referencePrintHours} h`,
    `; HEADER_BLOCK_END`,
    ``,
    `M73 P0 R${Math.max(1, Math.round(estimate.seconds / 60))}`,
    `; estimated job start`,
  ];

  if (cfg.gcode.includeLayerMarkers) {
    const n = Math.min(cfg.gcode.maxLayerMarkers, estimate.layers);
    for (let i = 0; i < n; i++) {
      const layer = Math.round((i / Math.max(1, n - 1)) * (estimate.layers - 1));
      const z = (layer + 1) * cfg.layer.layerHeightMm;
      lines.push(`;LAYER_CHANGE`);
      lines.push(`;Z:${z.toFixed(3)}`);
      lines.push(`; layer ${layer + 1}/${estimate.layers} (marker only)`);
      lines.push(`G1 Z${z.toFixed(3)} F600`);
    }
  }

  lines.push(`; estimated job end`);
  lines.push(`M73 P100 R0`);
  lines.push(`M84`);
  lines.push(``);
  return lines.join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
