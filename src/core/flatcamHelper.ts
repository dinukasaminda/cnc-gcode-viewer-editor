import { vbitEffectiveDiameter } from './tools';

/**
 * FlatCAM "Tool Dia" is NOT the V-bit tip width.
 * It is the effective cutting width at the chosen Cut Z depth.
 *
 *   FlatCAM Tool Dia  =  V tip width  +  2 × |Cut Z| × tan(V-angle / 2)
 *
 * These are two different values (see docs/req2.md, docs/req3.md).
 */

export interface FlatcamVBitInputs {
  /** Physical V-bit tip diameter / tip width (mm) */
  tipWidthMm: number;
  /** Included V angle in degrees (e.g. 30, 60) */
  angleDeg: number;
  /** Positive cut depth magnitude below stock surface (mm), |Cut Z| */
  cutDepthMm: number;
}

export interface FlatcamVBitResult {
  tipWidthMm: number;
  angleDeg: number;
  cutDepthMm: number;
  /** Value to enter as FlatCAM Tool Dia / Tool diameter */
  flatcamToolDiaMm: number;
  /** Half-angle contribution from the cone alone */
  flareMm: number;
}

export function calcFlatcamToolDia(inputs: FlatcamVBitInputs): FlatcamVBitResult {
  const tipWidthMm = Math.max(0, inputs.tipWidthMm);
  const angleDeg = Math.max(0, inputs.angleDeg);
  const cutDepthMm = Math.max(0, inputs.cutDepthMm);
  const flatcamToolDiaMm = vbitEffectiveDiameter(tipWidthMm, angleDeg, cutDepthMm);
  return {
    tipWidthMm,
    angleDeg,
    cutDepthMm,
    flatcamToolDiaMm,
    flareMm: Math.max(0, flatcamToolDiaMm - tipWidthMm),
  };
}

/**
 * Reverse: given FlatCAM Tool Dia + Cut Z + V angle, recover tip width.
 * tip = ToolDia − 2 × depth × tan(angle/2)
 */
export function tipWidthFromFlatcamToolDia(
  flatcamToolDiaMm: number,
  angleDeg: number,
  cutDepthMm: number
): number {
  const half = ((Math.max(0, angleDeg) / 2) * Math.PI) / 180;
  const flare = 2 * Math.max(0, cutDepthMm) * Math.tan(half);
  return Math.max(0, flatcamToolDiaMm - flare);
}

export const FLATCAM_HELPER_COPY = {
  title: 'FlatCAM Tool Dia helper',
  summary:
    'In FlatCAM, Tool Dia is the effective cutting width at your Cut Z — not the V-bit tip width and not the shank diameter.',
  rules: [
    'V tip width — physical tip of the conical bit (often 0.1 mm or less).',
    'Effective width / FlatCAM Tool Dia — how wide the groove is at Cut Z; used for isolation offsets and multi-pass spacing.',
    'Never enter the 3.175 mm shank as Tool Dia.',
    'Wrong Tool Dia → shorted traces or overly wide isolation gaps.',
  ],
  formula: 'Tool Dia = tip width + 2 × |Cut Z| × tan(angle / 2)',
} as const;
