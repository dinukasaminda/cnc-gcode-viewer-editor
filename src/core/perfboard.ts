import * as THREE from 'three';
import type { ExtrudedPart } from './imageExtrude';

export const STANDARD_PITCH_MM = 2.54;
export const DEFAULT_HOLE_DIA_MM = 1;
export const DEFAULT_BOARD_THICK_MM = 1.6;
export const DEFAULT_PIN_DIA_MM = 0.64;
export const DEFAULT_PIN_HEIGHT_MM = 6;
export const DEFAULT_PAD_DIA_MM = 1.9;
export const MAX_DOTS = 48;
/** Reference stock square for “how many holes fit” (5 cm). */
export const REF_SQUARE_MM = 50;

export interface GridPt {
  c: number;
  r: number;
}

export interface PerfboardSpec {
  cols: number;
  rows: number;
  pitchMm: number;
  holeDiaMm: number;
  thicknessMm: number;
}

export type PerfFeature =
  | { id: string; kind: 'rect'; a: GridPt; b: GridPt; name?: string }
  | { id: string; kind: 'pin'; at: GridPt; name?: string }
  | { id: string; kind: 'pinHole'; at: GridPt; name?: string }
  | { id: string; kind: 'measure'; a: GridPt; b: GridPt; name?: string };

export type PerfDrawTool = 'off' | 'select' | 'rect' | 'pin' | 'pinHole' | 'measure';

export function ptInRect(pt: GridPt, a: GridPt, b: GridPt): boolean {
  const c0 = Math.min(a.c, b.c);
  const c1 = Math.max(a.c, b.c);
  const r0 = Math.min(a.r, b.r);
  const r1 = Math.max(a.r, b.r);
  return pt.c >= c0 && pt.c <= c1 && pt.r >= r0 && pt.r <= r1;
}

/** Pins / pads on the hole first, then measurement endpoints, then rectangles covering it. */
export function featuresAtHole(features: PerfFeature[], pt: GridPt): PerfFeature[] {
  const onDot = features.filter(
    (f) => (f.kind === 'pin' || f.kind === 'pinHole') && f.at.c === pt.c && f.at.r === pt.r
  );
  if (onDot.length) return onDot;
  const measures = features.filter(
    (f) =>
      f.kind === 'measure' &&
      ((f.a.c === pt.c && f.a.r === pt.r) || (f.b.c === pt.c && f.b.r === pt.r))
  );
  if (measures.length) return measures;
  return features.filter((f) => f.kind === 'rect' && ptInRect(pt, f.a, f.b));
}

export function isSolidFeature(f: PerfFeature): f is Exclude<PerfFeature, { kind: 'measure' }> {
  return f.kind !== 'measure';
}

export const DEFAULT_PERF_SPEC: PerfboardSpec = {
  cols: 10,
  rows: 10,
  pitchMm: STANDARD_PITCH_MM,
  holeDiaMm: DEFAULT_HOLE_DIA_MM,
  thicknessMm: DEFAULT_BOARD_THICK_MM,
};

function clampDots(n: number): number {
  return Math.max(2, Math.min(MAX_DOTS, Math.round(n)));
}

export function normalizeSpec(spec: PerfboardSpec): PerfboardSpec {
  return {
    cols: clampDots(spec.cols),
    rows: clampDots(spec.rows),
    pitchMm: Math.max(0.5, spec.pitchMm),
    holeDiaMm: Math.max(0.2, Math.min(spec.pitchMm * 0.7, spec.holeDiaMm)),
    thicknessMm: Math.max(0.4, spec.thicknessMm),
  };
}

/** Outer board size: half-pitch margin so the first/last holes are inset. */
export function boardSizeMm(spec: PerfboardSpec): { widthMm: number; heightMm: number } {
  const s = normalizeSpec(spec);
  return { widthMm: s.cols * s.pitchMm, heightMm: s.rows * s.pitchMm };
}

/** Span between first and last hole centres. */
export function holeSpanMm(spec: PerfboardSpec): { widthMm: number; heightMm: number } {
  const s = normalizeSpec(spec);
  return { widthMm: (s.cols - 1) * s.pitchMm, heightMm: (s.rows - 1) * s.pitchMm };
}

/** Hole count along one edge of a square: centres at 0, pitch, 2·pitch, … */
export function holesAlongMm(pitchMm: number, spaceMm: number): number {
  const pitch = Math.max(0.5, pitchMm);
  const space = Math.max(pitch, spaceMm);
  return Math.max(1, Math.floor(space / pitch) + 1);
}

/** How many holes of this board’s pitch fit in a square (default 5 cm × 5 cm). */
export function holesInSquare(spec: PerfboardSpec, spaceMm = REF_SQUARE_MM) {
  const s = normalizeSpec(spec);
  const colsFit = holesAlongMm(s.pitchMm, spaceMm);
  const rowsFit = holesAlongMm(s.pitchMm, spaceMm);
  const onBoardCols = Math.min(s.cols, colsFit);
  const onBoardRows = Math.min(s.rows, rowsFit);
  return {
    spaceMm,
    pitchMm: s.pitchMm,
    colsFit,
    rowsFit,
    totalFit: colsFit * rowsFit,
    onBoardCols,
    onBoardRows,
    onBoardTotal: onBoardCols * onBoardRows,
    boardCols: s.cols,
    boardRows: s.rows,
    boardTotal: s.cols * s.rows,
    spanMm: (colsFit - 1) * s.pitchMm,
    allFit: s.cols <= colsFit && s.rows <= rowsFit,
  };
}

/** Hole centre in model XY (Z-up), board centred on origin. */
export function holeXY(spec: PerfboardSpec, c: number, r: number): { x: number; y: number } {
  const s = normalizeSpec(spec);
  const { widthMm, heightMm } = boardSizeMm(s);
  return {
    x: -widthMm / 2 + (c + 0.5) * s.pitchMm,
    y: -heightMm / 2 + (r + 0.5) * s.pitchMm,
  };
}

/** Euclidean distance between two hole centres (pitch × grid steps). */
export function holeDistanceMm(spec: PerfboardSpec, a: GridPt, b: GridPt): number {
  const pa = holeXY(spec, a.c, a.r);
  const pb = holeXY(spec, b.c, b.r);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

export function inGrid(spec: PerfboardSpec, c: number, r: number): boolean {
  const s = normalizeSpec(spec);
  return c >= 0 && r >= 0 && c < s.cols && r < s.rows;
}

export function snapWorldToHole(
  spec: PerfboardSpec,
  x: number,
  y: number,
  maxDistMm?: number
): GridPt | null {
  const s = normalizeSpec(spec);
  const { widthMm, heightMm } = boardSizeMm(s);
  const c = Math.round((x + widthMm / 2) / s.pitchMm - 0.5);
  const r = Math.round((y + heightMm / 2) / s.pitchMm - 0.5);
  if (!inGrid(s, c, r)) return null;
  const p = holeXY(s, c, r);
  const lim = maxDistMm ?? s.pitchMm * 0.45;
  if (Math.hypot(p.x - x, p.y - y) > lim) return null;
  return { c, r };
}

function trisOf(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  return Math.floor((idx ? idx.count : (geo.getAttribute('position')?.count ?? 0)) / 3);
}

function finish(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function part(
  id: string,
  name: string,
  hex: string,
  heightMm: number,
  geometry: THREE.BufferGeometry
): ExtrudedPart {
  return {
    id,
    name,
    hex,
    color: parseInt(hex.replace('#', ''), 16),
    heightMm,
    geometry,
    triangleCount: trisOf(geometry),
  };
}

function circleHole(x: number, y: number, radius: number): THREE.Path {
  const path = new THREE.Path();
  path.absarc(x, y, radius, 0, Math.PI * 2, true);
  return path;
}

function buildBoardGeometry(spec: PerfboardSpec): THREE.BufferGeometry {
  const s = normalizeSpec(spec);
  const { widthMm, heightMm } = boardSizeMm(s);
  const hw = widthMm / 2;
  const hh = heightMm / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();
  const radius = s.holeDiaMm / 2;
  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      const p = holeXY(s, c, r);
      shape.holes.push(circleHole(p.x, p.y, radius));
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: s.thicknessMm,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 8,
  });
  return finish(geo);
}

function buildRectGeometry(spec: PerfboardSpec, a: GridPt, b: GridPt): THREE.BufferGeometry {
  const s = normalizeSpec(spec);
  const c0 = Math.min(a.c, b.c);
  const c1 = Math.max(a.c, b.c);
  const r0 = Math.min(a.r, b.r);
  const r1 = Math.max(a.r, b.r);
  const p0 = holeXY(s, c0, r0);
  const p1 = holeXY(s, c1, r1);
  const pad = s.pitchMm * 0.4;
  const minX = Math.min(p0.x, p1.x) - pad;
  const maxX = Math.max(p0.x, p1.x) + pad;
  const minY = Math.min(p0.y, p1.y) - pad;
  const maxY = Math.max(p0.y, p1.y) + pad;
  const shape = new THREE.Shape();
  shape.moveTo(minX, minY);
  shape.lineTo(maxX, minY);
  shape.lineTo(maxX, maxY);
  shape.lineTo(minX, maxY);
  shape.closePath();
  const radius = s.holeDiaMm / 2;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const p = holeXY(s, c, r);
      shape.holes.push(circleHole(p.x, p.y, radius));
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.2,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 8,
  });
  geo.translate(0, 0, s.thicknessMm);
  return finish(geo);
}

function buildPinGeometry(spec: PerfboardSpec, at: GridPt): THREE.BufferGeometry {
  const s = normalizeSpec(spec);
  const p = holeXY(s, at.c, at.r);
  const geo = new THREE.CylinderGeometry(DEFAULT_PIN_DIA_MM / 2, DEFAULT_PIN_DIA_MM / 2, DEFAULT_PIN_HEIGHT_MM, 12);
  geo.rotateX(Math.PI / 2);
  geo.translate(p.x, p.y, s.thicknessMm + DEFAULT_PIN_HEIGHT_MM / 2);
  return finish(geo);
}

function buildPadGeometry(spec: PerfboardSpec, at: GridPt): THREE.BufferGeometry {
  const s = normalizeSpec(spec);
  const p = holeXY(s, at.c, at.r);
  const outer = DEFAULT_PAD_DIA_MM / 2;
  const inner = Math.max(s.holeDiaMm / 2 + 0.05, outer * 0.45);
  const shape = new THREE.Shape();
  shape.absarc(p.x, p.y, outer, 0, Math.PI * 2, false);
  shape.holes.push(circleHole(p.x, p.y, inner));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });
  geo.translate(0, 0, s.thicknessMm);
  return finish(geo);
}

export function specCacheKey(spec: PerfboardSpec): string {
  const s = normalizeSpec(spec);
  return `${s.cols}x${s.rows}:${s.pitchMm}:${s.holeDiaMm}:${s.thicknessMm}`;
}

export function buildPerfBoardPart(spec: PerfboardSpec): ExtrudedPart {
  const s = normalizeSpec(spec);
  return part('pf-board', 'Perfboard', '#b08968', s.thicknessMm, buildBoardGeometry(s));
}

function namedPart(f: PerfFeature, fallback: string): string {
  return f.name?.trim() || fallback;
}

export function buildPerfFeaturePart(spec: PerfboardSpec, f: PerfFeature): ExtrudedPart {
  const s = normalizeSpec(spec);
  if (f.kind === 'rect') {
    return part(
      f.id,
      namedPart(f, `Rect ${f.a.c + 1},${f.a.r + 1}–${f.b.c + 1},${f.b.r + 1}`),
      '#c4a035',
      0.2,
      buildRectGeometry(s, f.a, f.b)
    );
  }
  if (f.kind === 'pin') {
    return part(
      f.id,
      namedPart(f, `Pin ${f.at.c + 1},${f.at.r + 1}`),
      '#d4a017',
      DEFAULT_PIN_HEIGHT_MM,
      buildPinGeometry(s, f.at)
    );
  }
  if (f.kind === 'pinHole') {
    return part(
      f.id,
      namedPart(f, `Pin hole ${f.at.c + 1},${f.at.r + 1}`),
      '#b87333',
      0.12,
      buildPadGeometry(s, f.at)
    );
  }
  throw new Error('measurements are overlay-only');
}

export function buildPerfboardParts(spec: PerfboardSpec, features: PerfFeature[]): ExtrudedPart[] {
  return [buildPerfBoardPart(spec), ...features.filter(isSolidFeature).map((f) => buildPerfFeaturePart(spec, f))];
}

export function featureKindLabel(f: PerfFeature): string {
  if (f.kind === 'rect') {
    return `Rectangle (${f.a.c + 1},${f.a.r + 1})–(${f.b.c + 1},${f.b.r + 1})`;
  }
  if (f.kind === 'pin') return `Pin (${f.at.c + 1},${f.at.r + 1})`;
  if (f.kind === 'pinHole') return `Pin hole (${f.at.c + 1},${f.at.r + 1})`;
  return `Measure (${f.a.c + 1},${f.a.r + 1})–(${f.b.c + 1},${f.b.r + 1})`;
}

export function featureLabel(f: PerfFeature): string {
  const auto = featureKindLabel(f);
  const n = f.name?.trim();
  return n ? `${n} · ${auto}` : auto;
}

export function newFeatureId(kind: PerfFeature['kind']): string {
  return `pf-${kind}-${Math.random().toString(36).slice(2, 9)}`;
}
