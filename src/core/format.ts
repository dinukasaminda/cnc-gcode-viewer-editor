/** Display precision for all linear / dimensional values (mm). */
export const MM_DECIMALS = 3;

/**
 * Round to 3 decimal places for storage/UI.
 * Tiny float noise (e.g. 6.8e-17) becomes 0.
 */
export function roundMm(value: number, decimals = MM_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  const rounded = Math.round((value + Number.EPSILON) * f) / f;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Round/format a number to 3 decimal places (no unit). */
export function formatNum(value: number, decimals = MM_DECIMALS): string {
  if (!Number.isFinite(value)) return '—';
  return roundMm(value, decimals).toFixed(decimals);
}

/** Format a length/position/depth in millimeters: `1.235 mm`. */
export function formatMm(value: number, decimals = MM_DECIMALS): string {
  if (!Number.isFinite(value)) return '— mm';
  return `${roundMm(value, decimals).toFixed(decimals)} mm`;
}

/** Format feedrate in mm/min with 3 decimals. */
export function formatMmMin(value: number, decimals = MM_DECIMALS): string {
  if (!Number.isFinite(value)) return '— mm/min';
  return `${roundMm(value, decimals).toFixed(decimals)} mm/min`;
}

/** Format an angle in degrees with 3 decimals. */
export function formatDeg(value: number, decimals = MM_DECIMALS): string {
  if (!Number.isFinite(value)) return '—°';
  return `${roundMm(value, decimals).toFixed(decimals)}°`;
}

/** Format percent with 3 decimals (not mm). */
export function formatPct(fraction0to1: number, decimals = MM_DECIMALS): string {
  if (!Number.isFinite(fraction0to1)) return '—%';
  return `${(fraction0to1 * 100).toFixed(decimals)}%`;
}
