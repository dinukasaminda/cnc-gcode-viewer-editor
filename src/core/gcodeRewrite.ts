/**
 * Rewrite FlatCAM isolation G-code with a new Tool Dia / Cut Z.
 * Cut Z is written as a **negative** value (standard CNC: Z=0 surface, cut below).
 */

import {
  cutDepthFromToolDia,
  negativeCutZFromToolDia,
} from './flatcamHelper';
import { MM_DECIMALS, formatMm, formatNum } from './format';

export interface RewriteParams {
  /** Desired FlatCAM Tool Dia (effective width at cut depth), mm */
  toolDiaMm: number;
  /** Physical V tip width, mm */
  tipWidthMm: number;
  /** V included angle, degrees */
  angleDeg: number;
  /**
   * Optional override for signed Cut Z (e.g. -0.12).
   * If omitted, computed from Tool Dia / tip / angle as negative.
   */
  cutZMm?: number;
  /** Keep original Z convention (positive cut) instead of forcing negative */
  keepOriginalSign?: boolean;
}

export interface RewriteResult {
  text: string;
  oldCutZ: number | null;
  newCutZ: number;
  toolDiaMm: number;
  tipWidthMm: number;
  angleDeg: number;
  cutDepthMm: number;
  replacedZCount: number;
}

export { cutDepthFromToolDia, negativeCutZFromToolDia };

function formatZ(z: number, decimals = MM_DECIMALS): string {
  return z.toFixed(decimals);
}

function parseCommentZCut(text: string): number | null {
  const m =
    text.match(/\(Z_Cut:\s*([-\d.]+)\s*mm\)/i) ||
    text.match(/\(Tool:\s*\d+\s*->\s*Z_Cut:\s*([-\d.]+)\)/i);
  return m ? parseFloat(m[1]) : null;
}

function parseCommentToolDia(text: string): number | null {
  const m =
    text.match(/\(TOOL DIAMETER:\s*([-\d.]+)\s*mm\)/i) ||
    text.match(/\(Tool:\s*\d+\s*->\s*Dia:\s*([-\d.]+)\)/i);
  return m ? parseFloat(m[1]) : null;
}

/** Detect the most common G1 cut Z (excluding clear travel heights). */
function detectCutZFromMoves(text: string, metaZ: number | null): number | null {
  if (metaZ != null && Number.isFinite(metaZ)) return metaZ;
  const zVals: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const code = line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
    if (!/\bG0?1\b/i.test(code) && !/^G01\b/i.test(code.trim()) && !/^G1\b/i.test(code.trim())) {
      // also modal: lines with Z but no G that are after G1 — handled loosely below
    }
    const zm = code.match(/\bZ\s*([-+]?(?:\d+\.?\d*|\.\d+))/i);
    if (!zm) continue;
    // Prefer lines that look like plunges (G01/G1 with Z, little/no XY) or any G1 Z
    if (/\bG0*1\b/i.test(code) || /^\s*G0*1/i.test(code)) {
      zVals.push(parseFloat(zm[1]));
    }
  }
  if (!zVals.length) return null;
  // Histogram of rounded Z
  const counts = new Map<string, { z: number; n: number }>();
  for (const z of zVals) {
    const key = z.toFixed(MM_DECIMALS);
    const e = counts.get(key) ?? { z, n: 0 };
    e.n++;
    counts.set(key, e);
  }
  // Exclude large travel-like Z (> 0.4 abs typically travel for PCB)
  const candidates = [...counts.values()].filter((c) => Math.abs(c.z) < 0.5);
  const pool = candidates.length ? candidates : [...counts.values()];
  pool.sort((a, b) => b.n - a.n);
  return pool[0]?.z ?? null;
}

/**
 * Rewrite G-code: update Tool Dia comment, Z_Cut comment, and all cut-Z words.
 */
export function rewriteGCodeCutZ(source: string, params: RewriteParams): RewriteResult {
  const tipWidthMm = Math.max(0, params.tipWidthMm);
  const angleDeg = Math.max(0, params.angleDeg);
  const toolDiaMm = Math.max(tipWidthMm, params.toolDiaMm);
  const cutDepthMm =
    params.cutZMm != null
      ? Math.abs(params.cutZMm)
      : cutDepthFromToolDia(toolDiaMm, tipWidthMm, angleDeg);

  const oldCutZ = detectCutZFromMoves(source, parseCommentZCut(source));
  const oldWasNegative = oldCutZ != null ? oldCutZ < 0 : true;

  let newCutZ: number;
  if (params.cutZMm != null) {
    newCutZ = params.cutZMm;
  } else if (params.keepOriginalSign && oldCutZ != null) {
    newCutZ = oldWasNegative ? -cutDepthMm : cutDepthMm;
  } else {
    newCutZ = negativeCutZFromToolDia(toolDiaMm, tipWidthMm, angleDeg);
  }

  const newZStr = formatZ(newCutZ);
  const oldTol = 1e-3;
  let replacedZCount = 0;

  let text = source;

  // Update header comments
  if (/\(TOOL DIAMETER:\s*[-\d.]+\s*mm\)/i.test(text)) {
    text = text.replace(
      /\(TOOL DIAMETER:\s*[-\d.]+\s*mm\)/i,
      `(TOOL DIAMETER: ${formatMm(toolDiaMm)})`
    );
  } else {
    text = `(TOOL DIAMETER: ${formatMm(toolDiaMm)})\n` + text;
  }

  if (/\(Z_Cut:\s*[-\d.]+\s*mm\)/i.test(text)) {
    text = text.replace(/\(Z_Cut:\s*[-\d.]+\s*mm\)/i, `(Z_Cut: ${newZStr} mm)`);
  } else {
    text = text.replace(
      /(\(TOOL DIAMETER:[^\n]*\n)/i,
      `$1(Z_Cut: ${newZStr} mm)\n`
    );
  }

  // Annotate rewrite
  const stamp = `(Rewritten: Tool Dia ${formatMm(toolDiaMm)}, tip ${formatMm(tipWidthMm)}, ${formatNum(angleDeg)}°, Cut Z ${formatMm(newCutZ)})`;
  if (!text.includes('(Rewritten:')) {
    text = stamp + '\n' + text;
  } else {
    text = text.replace(/\(Rewritten:[^\n]*\)/, stamp);
  }

  // Replace Z words that match old cut depth (on any line — typically G01 plunges)
  if (oldCutZ != null) {
    text = text
      .split(/\r?\n/)
      .map((line) => {
        // Skip pure comments
        const stripped = line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
        if (!/\bZ\s*[-+]?(?:\d+\.?\d*|\.\d+)/i.test(stripped)) return line;

        return line.replace(/\bZ\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi, (full, num: string) => {
          const z = parseFloat(num);
          if (Math.abs(z - oldCutZ) <= oldTol) {
            replacedZCount++;
            // Preserve spacing style: Z0.0933 vs Z-0.1000
            return `Z${newZStr}`;
          }
          return full;
        });
      })
      .join('\n');
  }

  return {
    text,
    oldCutZ,
    newCutZ,
    toolDiaMm,
    tipWidthMm,
    angleDeg,
    cutDepthMm,
    replacedZCount,
  };
}

export function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function suggestedDownloadName(originalName: string, toolDia: number, cutZ: number): string {
  const base = originalName.replace(/\.(nc|gcode|ngc)$/i, '');
  const dia = formatNum(toolDia).replace(/\./g, 'p');
  const z = formatNum(cutZ).replace(/-/g, 'm').replace(/\./g, 'p');
  return `${base}_dia${dia}_Z${z}.nc`;
}

export { parseCommentToolDia, parseCommentZCut };
