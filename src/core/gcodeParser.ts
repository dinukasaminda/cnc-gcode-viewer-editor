import type { MotionSegment, ParseResult, ParsedMetadata } from './types';

const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function stripComments(line: string): { code: string; comment: string } {
  let comment = '';
  let code = line;
  const paren = line.match(/\(([^)]*)\)/g);
  if (paren) {
    comment = paren.map((p) => p.slice(1, -1)).join(' ');
    code = line.replace(/\([^)]*\)/g, ' ');
  }
  const semi = code.indexOf(';');
  if (semi >= 0) {
    comment = (comment + ' ' + code.slice(semi + 1)).trim();
    code = code.slice(0, semi);
  }
  return { code: code.trim(), comment: comment.trim() };
}

function parseWords(code: string): Map<string, number> {
  const map = new Map<string, number>();
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(code)) !== null) {
    map.set(m[1].toUpperCase(), parseFloat(m[2]));
  }
  return map;
}

function parseMetadata(text: string): ParsedMetadata {
  const meta: ParsedMetadata = {};
  const nameMatch = text.match(/\(Name:\s*([^)]+)\)/i);
  if (nameMatch) meta.name = nameMatch[1].trim();

  const toolDia =
    text.match(/\(TOOL DIAMETER:\s*([-\d.]+)\s*mm\)/i) ||
    text.match(/\(Tool:\s*\d+\s*->\s*Dia:\s*([-\d.]+)\)/i);
  if (toolDia) meta.toolDiameter = parseFloat(toolDia[1]);

  const zCut =
    text.match(/\(Z_Cut:\s*([-\d.]+)\s*mm\)/i) ||
    text.match(/\(Tool:\s*\d+\s*->\s*Z_Cut:\s*([-\d.]+)\)/i);
  if (zCut) meta.zCut = parseFloat(zCut[1]);

  const zMove =
    text.match(/\(Z_Move:\s*([-\d.]+)\s*mm\)/i) ||
    text.match(/\(Tool:\s*\d+\s*->\s*Z_Move:\s*([-\d.]+)\)/i);
  if (zMove) meta.zMove = parseFloat(zMove[1]);

  const feedXY = text.match(/\(Feedrate_XY:\s*([-\d.]+)/i);
  if (feedXY) meta.feedXY = parseFloat(feedXY[1]);

  const feedZ = text.match(/\(Feedrate_Z:\s*([-\d.]+)/i);
  if (feedZ) meta.feedZ = parseFloat(feedZ[1]);

  const spindle = text.match(/\(Spindle Speed:\s*([-\d.]+)/i);
  if (spindle) meta.spindle = parseFloat(spindle[1]);

  const xRange = text.match(/\(X range:\s*([-\d.]+)\s*\.\.\.\s*([-\d.]+)/i);
  if (xRange) {
    meta.xMin = parseFloat(xRange[1]);
    meta.xMax = parseFloat(xRange[2]);
  }
  const yRange = text.match(/\(Y range:\s*([-\d.]+)\s*\.\.\.\s*([-\d.]+)/i);
  if (yRange) {
    meta.yMin = parseFloat(yRange[1]);
    meta.yMax = parseFloat(yRange[2]);
  }

  if (/\(Units:\s*MM\)/i.test(text) || /\bG21\b/.test(text)) meta.units = 'mm';
  if (/\(Units:\s*IN/i.test(text) || /\bG20\b/.test(text)) meta.units = 'inch';

  return meta;
}

function arcPoint(
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/** Expand G2/G3 into linear segments for simulation. */
function expandArc(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  i: number,
  j: number,
  clockwise: boolean,
  maxSegLen: number
): { x: number; y: number }[] {
  const cx = x0 + i;
  const cy = y0 + j;
  const r0 = Math.hypot(x0 - cx, y0 - cy);
  const r1 = Math.hypot(x1 - cx, y1 - cy);
  const radius = (r0 + r1) / 2;
  if (radius < 1e-9) return [{ x: x1, y: y1 }];

  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  let sweep = a1 - a0;
  if (clockwise) {
    if (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    if (sweep <= 0) sweep += 2 * Math.PI;
  }
  // Full circle when start==end
  if (Math.abs(x0 - x1) < 1e-9 && Math.abs(y0 - y1) < 1e-9) {
    sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
  }

  const arcLen = Math.abs(sweep) * radius;
  const n = Math.max(1, Math.ceil(arcLen / maxSegLen));
  const pts: { x: number; y: number }[] = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    pts.push(arcPoint(cx, cy, radius, a));
  }
  pts[pts.length - 1] = { x: x1, y: y1 };
  return pts;
}

function isCollinear(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  eps = 1e-5
): boolean {
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return Math.abs(cross) < eps;
}

export function parseGCode(text: string): ParseResult {
  const metadata = parseMetadata(text);
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  let units: 'mm' | 'inch' = metadata.units ?? 'mm';
  let absolute = true;
  let motion = 1; // G0=0, G1=1, G2=2, G3=3
  let x = 0;
  let y = 0;
  let z = 0;
  let feedrate = 0;
  let spindleOn = false;
  let spindleRpm = 0;
  let plane = 17; // G17
  let sawUnits = Boolean(metadata.units);
  let sawSpindleStart = false;

  const segments: MotionSegment[] = [];
  let segIndex = 0;

  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };

  const touchBounds = (px: number, py: number, pz: number) => {
    bounds.minX = Math.min(bounds.minX, px);
    bounds.minY = Math.min(bounds.minY, py);
    bounds.minZ = Math.min(bounds.minZ, pz);
    bounds.maxX = Math.max(bounds.maxX, px);
    bounds.maxY = Math.max(bounds.maxY, py);
    bounds.maxZ = Math.max(bounds.maxZ, pz);
  };
  touchBounds(0, 0, 0);

  const toMm = (v: number) => (units === 'inch' ? v * 25.4 : v);

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const { code } = stripComments(rawLine);
    if (!code) continue;

    const words = parseWords(code);
    if (words.size === 0) continue;

    // Modal / non-modal codes that may appear together
    if (words.has('G')) {
      // Handle multiple G words by scanning all letter groups from original
      WORD_RE.lastIndex = 0;
      let gm: RegExpExecArray | null;
      while ((gm = WORD_RE.exec(code)) !== null) {
        if (gm[1].toUpperCase() !== 'G') continue;
        const g = Math.round(parseFloat(gm[2]) * 10) / 10;
        switch (g) {
          case 0:
            motion = 0;
            break;
          case 1:
            motion = 1;
            break;
          case 2:
            motion = 2;
            break;
          case 3:
            motion = 3;
            break;
          case 17:
            plane = 17;
            break;
          case 18:
          case 19:
            warnings.push(`Unsupported plane G${g} at line ${li + 1}`);
            plane = g;
            break;
          case 20:
            units = 'inch';
            sawUnits = true;
            break;
          case 21:
            units = 'mm';
            sawUnits = true;
            break;
          case 90:
            absolute = true;
            break;
          case 91:
            absolute = false;
            break;
          case 54:
          case 55:
          case 56:
          case 57:
          case 58:
          case 59:
            break;
          case 94:
            break;
          default:
            if (![4, 28, 30, 92].includes(g)) {
              // ignore dwell etc.
            }
            break;
        }
      }
    }

    if (words.has('M')) {
      WORD_RE.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = WORD_RE.exec(code)) !== null) {
        if (mm[1].toUpperCase() !== 'M') continue;
        const m = Math.round(parseFloat(mm[2]));
        if (m === 3 || m === 4) {
          spindleOn = true;
          sawSpindleStart = true;
        } else if (m === 5) {
          spindleOn = false;
        }
      }
    }

    if (words.has('S')) spindleRpm = words.get('S')!;
    if (words.has('F')) feedrate = words.get('F')!;

    const hasAxis =
      words.has('X') || words.has('Y') || words.has('Z') || words.has('I') || words.has('J');

    if (!hasAxis) continue;

    const x0 = x;
    const y0 = y;
    const z0 = z;

    const readAxis = (letter: string, cur: number): number => {
      if (!words.has(letter)) return cur;
      const v = toMm(words.get(letter)!);
      return absolute ? v : cur + v;
    };

    x = readAxis('X', x);
    y = readAxis('Y', y);
    z = readAxis('Z', z);

    const i = words.has('I') ? toMm(words.get('I')!) : 0;
    const j = words.has('J') ? toMm(words.get('J')!) : 0;

    // Determine if this is actually a move
    const moved =
      Math.abs(x - x0) > 1e-9 ||
      Math.abs(y - y0) > 1e-9 ||
      Math.abs(z - z0) > 1e-9 ||
      motion === 2 ||
      motion === 3;

    if (!moved) continue;

    if (motion === 0) {
      segments.push({
        index: segIndex++,
        lineNumber: li + 1,
        type: 'rapid',
        x0,
        y0,
        z0,
        x1: x,
        y1: y,
        z1: z,
        feedrate,
        spindleOn,
        spindleRpm,
        raw: rawLine.trim(),
      });
      touchBounds(x, y, z);
    } else if (motion === 1) {
      segments.push({
        index: segIndex++,
        lineNumber: li + 1,
        type: 'cut',
        x0,
        y0,
        z0,
        x1: x,
        y1: y,
        z1: z,
        feedrate,
        spindleOn,
        spindleRpm,
        raw: rawLine.trim(),
      });
      touchBounds(x, y, z);
    } else if (motion === 2 || motion === 3) {
      if (plane !== 17) {
        warnings.push(`Arc in non-XY plane at line ${li + 1}`);
      }
      const clockwise = motion === 2;
      const pts = expandArc(x0, y0, x, y, i, j, clockwise, 0.1);
      let px = x0;
      let py = y0;
      for (const p of pts) {
        segments.push({
          index: segIndex++,
          lineNumber: li + 1,
          type: 'arc',
          x0: px,
          y0: py,
          z0,
          x1: p.x,
          y1: p.y,
          z1: z,
          feedrate,
          spindleOn,
          spindleRpm,
          i,
          j,
          clockwise,
          raw: rawLine.trim(),
        });
        touchBounds(p.x, p.y, z);
        px = p.x;
        py = p.y;
      }
    }
  }

  // Simplify collinear XY cuts at constant Z
  const simplified: MotionSegment[] = [];
  for (const seg of segments) {
    const prev = simplified[simplified.length - 1];
    if (
      prev &&
      seg.type === prev.type &&
      seg.type !== 'rapid' &&
      Math.abs(seg.z0 - prev.z0) < 1e-9 &&
      Math.abs(seg.z1 - prev.z1) < 1e-9 &&
      Math.abs(seg.z1 - seg.z0) < 1e-9 &&
      isCollinear(prev.x0, prev.y0, prev.x1, prev.y1, seg.x1, seg.y1)
    ) {
      prev.x1 = seg.x1;
      prev.y1 = seg.y1;
      prev.z1 = seg.z1;
      prev.lineNumber = seg.lineNumber;
      prev.raw = seg.raw;
      continue;
    }
    simplified.push({ ...seg, index: simplified.length });
  }

  // Detect Z convention
  let minCutZ = Infinity;
  let maxCutZ = -Infinity;
  let hasNegativeCut = false;
  for (const s of simplified) {
    if (s.type === 'rapid') continue;
    minCutZ = Math.min(minCutZ, s.z0, s.z1);
    maxCutZ = Math.max(maxCutZ, s.z0, s.z1);
    if (s.z0 < -1e-6 || s.z1 < -1e-6) hasNegativeCut = true;
  }

  const zConvention: 'standard' | 'positive-depth' = hasNegativeCut
    ? 'standard'
    : 'positive-depth';

  if (!sawUnits) warnings.push('Missing units (G20/G21)');
  if (!sawSpindleStart && simplified.some((s) => s.type !== 'rapid')) {
    warnings.push('Missing spindle-start command (M3/M4)');
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = bounds.minZ = 0;
    bounds.maxX = bounds.maxY = bounds.maxZ = 0;
  }

  return {
    segments: simplified,
    metadata,
    bounds,
    warnings,
    units,
    zConvention,
  };
}

/** Positive cut depth below stock surface for a Z value. */
export function cutDepthAtZ(
  z: number,
  surfaceZ: number,
  convention: 'standard' | 'positive-depth',
  clearanceZ?: number
): number {
  if (convention === 'standard') {
    return Math.max(0, surfaceZ - z);
  }
  // Positive-depth FlatCAM style: Z+ is up for rapids, but cut Z values are
  // small positives used as depth into the board (common PCB CAM quirk).
  // Only treat Z as depth when clearly below clearance / travel height.
  const clear = clearanceZ ?? 0.5;
  if (z >= clear) return 0;
  if (z > surfaceZ) return z - surfaceZ;
  return Math.max(0, surfaceZ - z);
}

export function resolveZConvention(
  mode: 'auto' | 'standard' | 'positive-depth',
  parsed: ParseResult
): 'standard' | 'positive-depth' {
  if (mode === 'auto') return parsed.zConvention;
  return mode;
}
