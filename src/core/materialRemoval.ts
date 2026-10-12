import { cutDepthAtZ, resolveZConvention } from './gcodeParser';
import { toolRadiusAtDepth } from './tools';
import { HeightFieldStock } from './stock';
import type { JobFile, MotionSegment, StockSettings } from './types';

export interface RemovalProgress {
  jobId: string;
  segmentIndex: number;
  totalSegments: number;
  progress: number;
}

export interface RemovalResult {
  stock: HeightFieldStock;
  appliedSegments: number;
  effectiveGrooveWidthMm: number;
}

function segmentDepths(
  seg: MotionSegment,
  surfaceZ: number,
  convention: 'standard' | 'positive-depth',
  clearanceZ: number
): { d0: number; d1: number } {
  return {
    d0: cutDepthAtZ(seg.z0, surfaceZ, convention, clearanceZ),
    d1: cutDepthAtZ(seg.z1, surfaceZ, convention, clearanceZ),
  };
}

function estimateClearance(segments: MotionSegment[]): number {
  let maxZ = 0;
  for (const s of segments) {
    if (s.type === 'rapid') maxZ = Math.max(maxZ, s.z0, s.z1);
  }
  // Midpoint between surface and typical travel; cut Z is well below this.
  return Math.max(0.4, maxZ * 0.35);
}

/**
 * Apply cutting segments from enabled jobs onto a shared height-field stock.
 * Optionally stop after `uptoSegment` across concatenated timeline.
 */
export function applyMaterialRemoval(
  jobs: JobFile[],
  settings: StockSettings,
  options?: {
    uptoGlobalIndex?: number;
    onProgress?: (p: RemovalProgress) => void;
  }
): RemovalResult {
  const stock = new HeightFieldStock(settings);
  let globalIndex = 0;
  let applied = 0;
  let sampleWidth = 0;
  let sampleCount = 0;

  const enabled = jobs.filter((j) => j.enabled && j.parse);

  for (const job of enabled) {
    const parse = job.parse!;
    const convention = resolveZConvention(settings.zMode, parse);
    const clearance = estimateClearance(parse.segments);
    const total = parse.segments.length;

    for (let i = 0; i < parse.segments.length; i++) {
      if (options?.uptoGlobalIndex !== undefined && globalIndex > options.uptoGlobalIndex) {
        return {
          stock,
          appliedSegments: applied,
          effectiveGrooveWidthMm: sampleCount ? sampleWidth / sampleCount : 0,
        };
      }

      const seg = parse.segments[i];
      globalIndex++;

      if (seg.type === 'rapid') {
        options?.onProgress?.({
          jobId: job.id,
          segmentIndex: i,
          totalSegments: total,
          progress: i / Math.max(1, total),
        });
        continue;
      }

      const { d0, d1 } = segmentDepths(seg, settings.surfaceZ, convention, clearance);
      const depth = Math.max(d0, d1);
      if (depth <= 0) continue;

      // For plunges (mostly Z change), stamp endpoint; for XY cuts use segment.
      const r0 = toolRadiusAtDepth(job.tool, d0 || depth);
      const r1 = toolRadiusAtDepth(job.tool, d1 || depth);
      const radius = Math.max(r0, r1);

      const xyLen = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
      const zLen = Math.abs(seg.z1 - seg.z0);

      if (xyLen < 1e-6) {
        // Plunge / retract at fixed XY
        stock.stampCircle(seg.x1, seg.y1, radius, depth);
      } else if (Math.abs(d1 - d0) < 1e-6) {
        stock.stampSegment(seg.x0, seg.y0, seg.x1, seg.y1, radius, depth);
      } else {
        // Varying depth: subsample
        const n = Math.max(1, Math.ceil(Math.max(xyLen, zLen) / (settings.resolution * 0.75)));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const x = seg.x0 + (seg.x1 - seg.x0) * t;
          const y = seg.y0 + (seg.y1 - seg.y0) * t;
          const d = d0 + (d1 - d0) * t;
          if (d <= 0) continue;
          const r = toolRadiusAtDepth(job.tool, d);
          stock.stampCircle(x, y, r, d);
        }
      }

      if (job.tool.type === 'vbit' && depth > 0) {
        sampleWidth += radius * 2;
        sampleCount++;
      }
      applied++;

      if (i % 200 === 0) {
        options?.onProgress?.({
          jobId: job.id,
          segmentIndex: i,
          totalSegments: total,
          progress: i / Math.max(1, total),
        });
      }
    }
  }

  return {
    stock,
    appliedSegments: applied,
    effectiveGrooveWidthMm: sampleCount ? sampleWidth / sampleCount : 0,
  };
}

export function concatTimeline(jobs: JobFile[]): { job: JobFile; seg: MotionSegment; globalIndex: number }[] {
  const out: { job: JobFile; seg: MotionSegment; globalIndex: number }[] = [];
  let gi = 0;
  for (const job of jobs.filter((j) => j.enabled && j.parse)) {
    for (const seg of job.parse!.segments) {
      out.push({ job, seg, globalIndex: gi++ });
    }
  }
  return out;
}
