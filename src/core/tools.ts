import type { Tool } from './types';
import { tipWidthFromFlatcamToolDia } from './flatcamHelper';
import { formatDeg, formatMm, roundMm } from './format';

/**
 * V-bit effective cutting diameter at a given depth below the stock surface.
 * This equals FlatCAM "Tool Dia" when depth = |Cut Z|.
 *
 * effectiveDiameter = tipDiameter + 2 × depth × tan(angle / 2)
 *
 * tipDiameter (V tip width) and effectiveDiameter are different values.
 */
export function vbitEffectiveDiameter(
  tipDiameter: number,
  angleDeg: number,
  depth: number
): number {
  if (depth <= 0) return tipDiameter;
  const halfAngleRad = ((angleDeg / 2) * Math.PI) / 180;
  return tipDiameter + 2 * depth * Math.tan(halfAngleRad);
}

/** Cutting radius at a given depth for any tool type. */
export function toolRadiusAtDepth(tool: Tool, depth: number): number {
  if (depth <= 0) {
    if (tool.type === 'vbit') return tool.tipDiameter / 2;
    return tool.diameter / 2;
  }
  switch (tool.type) {
    case 'vbit':
      return vbitEffectiveDiameter(tool.tipDiameter, tool.angle, depth) / 2;
    case 'endmill':
    case 'drill':
      return tool.diameter / 2;
  }
}

export function toolLabel(tool: Tool): string {
  switch (tool.type) {
    case 'vbit':
      return `V-bit ${formatDeg(tool.angle)} tip ${formatMm(tool.tipDiameter)}`;
    case 'endmill':
      return `End mill Ø${formatMm(tool.diameter)}`;
    case 'drill':
      return `Drill Ø${formatMm(tool.diameter)}`;
  }
}

/**
 * Guess tool from FlatCAM metadata.
 *
 * FlatCAM "(TOOL DIAMETER: …)" is the effective Tool Dia at Cut Z,
 * NOT the V-tip width. For V-bits we reverse tip from Tool Dia + |Z_Cut| + angle.
 */
export function guessToolFromMetadata(
  toolDiameter?: number,
  jobName?: string,
  zCut?: number,
  defaultAngle = 30
): Tool {
  const name = (jobName ?? '').toLowerCase();
  if (name.includes('drill') || name.includes('pth') || name.includes('excellon')) {
    return { type: 'drill', diameter: toolDiameter ?? 1.0 };
  }
  if (name.includes('cutout') || name.includes('profile') || name.includes('outline')) {
    return { type: 'endmill', diameter: toolDiameter ?? 1.0 };
  }

  const flatcamToolDia = toolDiameter;
  const depth = zCut != null ? Math.abs(zCut) : undefined;

  let tipDiameter = 0.1;
  if (flatcamToolDia != null && depth != null && depth > 0) {
    tipDiameter = tipWidthFromFlatcamToolDia(flatcamToolDia, defaultAngle, depth);
  } else if (flatcamToolDia != null && (depth == null || depth === 0)) {
    // No depth documented — treat Tool Dia as tip only as a weak fallback
    tipDiameter = flatcamToolDia;
  }

  return {
    type: 'vbit',
    tipDiameter: roundMm(tipDiameter),
    angle: roundMm(defaultAngle),
    shankDiameter: 3.175,
  };
}
