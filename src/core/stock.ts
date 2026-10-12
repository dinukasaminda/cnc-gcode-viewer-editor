import type { StockSettings } from './types';

/**
 * High-resolution 2.5D height field + copper mask for PCB stock.
 * depth[i] = how far below the copper top surface material was removed (mm).
 * copper[i] = 1 if copper remains, 0 if milled away / hole / cutout.
 * voidMask[i] = 1 if cell is fully cut away (through-board).
 */
export class HeightFieldStock {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly originX: number;
  readonly originY: number;
  readonly resolution: number;
  readonly cols: number;
  readonly rows: number;
  readonly thickness: number;
  readonly copperThickness: number;
  readonly depth: Float32Array;
  readonly copper: Uint8Array;
  readonly voidMask: Uint8Array;

  constructor(settings: StockSettings) {
    this.widthMm = settings.width;
    this.heightMm = settings.height;
    this.originX = settings.originX;
    this.originY = settings.originY;
    this.resolution = settings.resolution;
    this.thickness = settings.thickness;
    this.copperThickness = settings.copperThickness;
    this.cols = Math.max(2, Math.ceil(settings.width / settings.resolution) + 1);
    this.rows = Math.max(2, Math.ceil(settings.height / settings.resolution) + 1);
    const n = this.cols * this.rows;
    this.depth = new Float32Array(n);
    this.copper = new Uint8Array(n).fill(1);
    this.voidMask = new Uint8Array(n);
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }

  worldToGrid(x: number, y: number): { c: number; r: number } {
    const c = (x - this.originX) / this.resolution;
    const r = (y - this.originY) / this.resolution;
    return { c, r };
  }

  gridToWorld(c: number, r: number): { x: number; y: number } {
    return {
      x: this.originX + c * this.resolution,
      y: this.originY + r * this.resolution,
    };
  }

  /**
   * Hit radius including half-cell so tools thinner than the grid still mark cells.
   * (e.g. Ø0.05 mm groove on a 0.05 mm grid → radius 0.025 would otherwise miss centers)
   */
  private hitRadius(radius: number): number {
    return Math.max(radius, 1e-6) + this.resolution * 0.5;
  }

  private applyCut(i: number, cutDepth: number): void {
    if (cutDepth > this.depth[i]) this.depth[i] = cutDepth;
    // Any cut that reaches into copper clears it (expose FR4)
    if (cutDepth >= this.copperThickness * 0.25) this.copper[i] = 0;
    if (cutDepth >= this.thickness - 1e-6) {
      this.voidMask[i] = 1;
      this.copper[i] = 0;
    }
  }

  stampCircle(cx: number, cy: number, radius: number, cutDepth: number): void {
    if (cutDepth <= 0) return;
    const hitR = this.hitRadius(radius);
    const { c: fc, r: fr } = this.worldToGrid(cx, cy);
    const radCells = hitR / this.resolution + 1;
    const c0 = Math.max(0, Math.floor(fc - radCells));
    const c1 = Math.min(this.cols - 1, Math.ceil(fc + radCells));
    const r0 = Math.max(0, Math.floor(fr - radCells));
    const r1 = Math.min(this.rows - 1, Math.ceil(fr + radCells));
    const r2 = hitR * hitR;

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const { x, y } = this.gridToWorld(col, row);
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r2) continue;
        this.applyCut(this.index(col, row), cutDepth);
      }
    }
  }

  stampSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    cutDepth: number
  ): void {
    if (cutDepth <= 0) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      this.stampCircle(x0, y0, radius, cutDepth);
      return;
    }
    const hitR = this.hitRadius(radius);
    const invLen = 1 / len;
    const ux = dx * invLen;
    const uy = dy * invLen;
    const { c: fc0, r: fr0 } = this.worldToGrid(x0, y0);
    const { c: fc1, r: fr1 } = this.worldToGrid(x1, y1);
    const radCells = hitR / this.resolution + 1;
    const c0 = Math.max(0, Math.floor(Math.min(fc0, fc1) - radCells));
    const c1 = Math.min(this.cols - 1, Math.ceil(Math.max(fc0, fc1) + radCells));
    const r0 = Math.max(0, Math.floor(Math.min(fr0, fr1) - radCells));
    const r1 = Math.min(this.rows - 1, Math.ceil(Math.max(fr0, fr1) + radCells));
    const r2 = hitR * hitR;

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const { x, y } = this.gridToWorld(col, row);
        const px = x - x0;
        const py = y - y0;
        const t = Math.max(0, Math.min(len, px * ux + py * uy));
        const qx = x0 + ux * t;
        const qy = y0 + uy * t;
        const d2 = (x - qx) * (x - qx) + (y - qy) * (y - qy);
        if (d2 > r2) continue;
        this.applyCut(this.index(col, row), cutDepth);
      }
    }
  }

  sampleDepth(x: number, y: number): number {
    const { c, r } = this.worldToGrid(x, y);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 >= this.cols - 1 || r0 >= this.rows - 1) return 0;
    const tx = c - c0;
    const ty = r - r0;
    const d00 = this.depth[this.index(c0, r0)];
    const d10 = this.depth[this.index(c0 + 1, r0)];
    const d01 = this.depth[this.index(c0, r0 + 1)];
    const d11 = this.depth[this.index(c0 + 1, r0 + 1)];
    return d00 * (1 - tx) * (1 - ty) + d10 * tx * (1 - ty) + d01 * (1 - tx) * ty + d11 * tx * ty;
  }

  hasCopper(x: number, y: number): boolean {
    const { c, r } = this.worldToGrid(x, y);
    const col = Math.round(c);
    const row = Math.round(r);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false;
    return this.copper[this.index(col, row)] === 1 && this.voidMask[this.index(col, row)] === 0;
  }

  isVoid(x: number, y: number): boolean {
    const { c, r } = this.worldToGrid(x, y);
    const col = Math.round(c);
    const row = Math.round(r);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return true;
    return this.voidMask[this.index(col, row)] === 1;
  }

  maxDepth(): number {
    let m = 0;
    for (let i = 0; i < this.depth.length; i++) if (this.depth[i] > m) m = this.depth[i];
    return m;
  }

  removedCopperFraction(): number {
    let removed = 0;
    let total = 0;
    for (let i = 0; i < this.copper.length; i++) {
      if (this.voidMask[i]) continue;
      total++;
      if (!this.copper[i]) removed++;
    }
    return total ? removed / total : 0;
  }
}

export function stockFromBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  base: StockSettings
): StockSettings {
  const margin = base.margin;
  const minX = bounds.minX - margin;
  const minY = bounds.minY - margin;
  const maxX = bounds.maxX + margin;
  const maxY = bounds.maxY + margin;
  return {
    ...base,
    originX: minX,
    originY: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}
