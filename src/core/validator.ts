import { cutDepthAtZ, resolveZConvention } from './gcodeParser';
import type { JobFile, StockSettings, ValidationWarning } from './types';

export function validateJobs(jobs: JobFile[], stock: StockSettings): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const machineMaxX = stock.originX + stock.width + 50;
  const machineMaxY = stock.originY + stock.height + 50;

  for (const job of jobs) {
    if (!job.enabled || !job.parse) continue;
    const p = job.parse;
    const convention = resolveZConvention(stock.zMode, p);

    for (const w of p.warnings) {
      warnings.push({ severity: 'warning', code: 'parse', message: `${job.name}: ${w}` });
    }

    if (!p.segments.some((s) => s.spindleOn) && p.segments.some((s) => s.type !== 'rapid')) {
      warnings.push({
        severity: 'warning',
        code: 'missing-spindle',
        message: `${job.name}: cutting moves without spindle-on observed`,
      });
    }

    let maxDepth = 0;
    let maxFeedZ = 0;

    for (const seg of p.segments) {
      const xs = [seg.x0, seg.x1];
      const ys = [seg.y0, seg.y1];

      for (let k = 0; k < 2; k++) {
        const x = xs[k];
        const y = ys[k];
        if (x < stock.originX - 0.01 || x > stock.originX + stock.width + 0.01 ||
            y < stock.originY - 0.01 || y > stock.originY + stock.height + 0.01) {
          if (seg.type !== 'rapid') {
            warnings.push({
              severity: 'warning',
              code: 'outside-stock',
              message: `${job.name}: cutting outside stock near X${x.toFixed(3)} Y${y.toFixed(3)}`,
              lineNumber: seg.lineNumber,
            });
            break;
          }
        }
        if (x < -0.5 || y < -0.5) {
          warnings.push({
            severity: 'info',
            code: 'negative-xy',
            message: `${job.name}: unexpected negative X/Y (X${x.toFixed(3)}, Y${y.toFixed(3)})`,
            lineNumber: seg.lineNumber,
          });
        }
        if (x > machineMaxX || y > machineMaxY) {
          warnings.push({
            severity: 'warning',
            code: 'machine-limits',
            message: `${job.name}: toolpath may exceed machine limits`,
            lineNumber: seg.lineNumber,
          });
        }
      }

      if (seg.type === 'rapid') {
        // Only flag if the rapid destination is into the stock (start may leave a cut).
        const d1 = cutDepthAtZ(seg.z1, stock.surfaceZ, convention, 0.5);
        if (d1 > 0.01) {
          warnings.push({
            severity: 'error',
            code: 'rapid-below-surface',
            message: `${job.name}: rapid G0 below PCB surface at line ${seg.lineNumber}`,
            lineNumber: seg.lineNumber,
          });
        }
      } else {
        const depth = Math.max(
          cutDepthAtZ(seg.z0, stock.surfaceZ, convention, 0.5),
          cutDepthAtZ(seg.z1, stock.surfaceZ, convention, 0.5)
        );
        maxDepth = Math.max(maxDepth, depth);
        const xy = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
        const zd = Math.abs(seg.z1 - seg.z0);
        if (zd > xy * 0.5 && seg.feedrate > 200) {
          maxFeedZ = Math.max(maxFeedZ, seg.feedrate);
        }
      }
    }

    if (maxDepth > stock.thickness + 0.2) {
      warnings.push({
        severity: 'warning',
        code: 'too-deep',
        message: `${job.name}: cut depth ${maxDepth.toFixed(3)} mm exceeds board thickness ${stock.thickness} mm`,
      });
    }

    if (maxFeedZ > 400) {
      warnings.push({
        severity: 'warning',
        code: 'plunge-feed',
        message: `${job.name}: plunge feed appears excessive (${maxFeedZ.toFixed(0)} mm/min)`,
      });
    }

    if (job.tool.type === 'vbit' && job.tool.tipDiameter > 0.5) {
      warnings.push({
        severity: 'info',
        code: 'large-vbit',
        message: `${job.name}: V-bit tip ${job.tool.tipDiameter} mm may be large for fine isolation`,
      });
    }
  }

  // Dedupe similar messages (keep first N of each code)
  const seen = new Map<string, number>();
  const filtered: ValidationWarning[] = [];
  for (const w of warnings) {
    const key = w.code + w.message.slice(0, 40);
    const n = seen.get(key) ?? 0;
    if (n >= 3) continue;
    seen.set(key, n + 1);
    filtered.push(w);
  }
  return filtered;
}
