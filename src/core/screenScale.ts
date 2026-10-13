/**
 * CSS reference pixels per millimeter.
 * CSS defines 1in = 96px, 1in = 25.4mm → 96/25.4 px/mm.
 * On correctly configured displays this matches a physical ruler;
 * OS display scaling can skew it slightly.
 */
export function cssPixelsPerMm(): number {
  if (typeof document === 'undefined') return 96 / 25.4;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:1in;height:1in;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const pxPerInch = probe.offsetWidth || 96;
  document.body.removeChild(probe);
  return pxPerInch / 25.4;
}

/** World mm visible across a CSS-pixel span at zoom=1 (true scale). */
export function mmFromCssPixels(cssPx: number, pxPerMm = cssPixelsPerMm()): number {
  return cssPx / pxPerMm;
}

export function zoomPercentFromOrthoZoom(cameraZoom: number): number {
  if (!Number.isFinite(cameraZoom) || cameraZoom <= 0) return 100;
  return Math.round(cameraZoom * 1000) / 10; // one decimal, e.g. 100.0
}
