export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ColorCluster {
  id: number;
  color: Rgba;
  hex: string;
  pixelCount: number;
  /** True if treated as background (not extruded). */
  isBackground: boolean;
}

export const DEFAULT_EMBOSS_HEX = '#000000';

export interface ImageRegion {
  id: string;
  clusterId: number;
  /** Source image cluster color (preview / segmentation). */
  color: Rgba;
  hex: string;
  /**
   * Color used for the 3D mesh. Starts as this part's image color so the
   * preview matches the source. Set when the user picks an override.
   */
  printHex: string;
  /** True after the user sets an emboss color. Otherwise printHex follows the image. */
  printHexCustom?: boolean;
  /**
   * Packed mask of the region bbox, row-major
   * `(y - minY) * (maxX - minX + 1) + (x - minX)`.
   */
  mask: Uint8Array;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Extrude height in mm (user editable). */
  heightMm: number;
  enabled: boolean;
  name: string;
}

export interface SegmentedImage {
  name: string;
  /** Working bitmap size — same as the upload, unless the long edge exceeds WORKING_MAX_EDGE */
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Scale from source px → working px (1 = original) */
  downsample: number;
  imageData: ImageData;
  /** cluster id per pixel, -1 transparent/empty */
  labelMap: Int16Array;
  /**
   * Fine background mask (1 = BG). Independent of color clusters — used for
   * soft edges / shadows / click-flood removal.
   */
  bgMask: Uint8Array;
  clusters: ColorCluster[];
  regions: ImageRegion[];
  /** Height for parts with no per-part edit. Same for every color. */
  defaultHeightMm?: number;
  /**
   * How foreground becomes parts. 'color' (default) splits by similar color;
   * 'solid' makes one part per enclosed foreground object (max solids).
   */
  partMode?: PartMode;
}

export type PartMode = 'color' | 'solid';

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function rgbaToHex(c: Rgba): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function colorDist(a: Rgba, b: Rgba): number {
  return colorDistRgb(a.r, a.g, a.b, b.r, b.g, b.b);
}

function colorDistRgb(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
  return img;
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await loadImageElement(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Source preview backing store (clicks map back to working pixels). */
export const PREVIEW_MAX_EDGE = 720;
/** Hard cap so a 50 MP photo cannot allocate a multi-gigabyte canvas. */
export const WORKING_MAX_EDGE = 8192;

export function regionMaskWidth(r: { minX: number; maxX: number }): number {
  return r.maxX - r.minX + 1;
}

export function regionHasPixel(
  r: { minX: number; minY: number; maxX: number; maxY: number; mask: Uint8Array },
  x: number,
  y: number
): boolean {
  if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) return false;
  return r.mask[(y - r.minY) * (r.maxX - r.minX + 1) + (x - r.minX)] === 1;
}

export function forEachRegionPixel(
  r: { minX: number; minY: number; maxX: number; maxY: number; mask: Uint8Array },
  imageWidth: number,
  fn: (i: number, x: number, y: number) => void
): void {
  const mw = r.maxX - r.minX + 1;
  for (let y = r.minY; y <= r.maxY; y++) {
    const row = (y - r.minY) * mw;
    for (let x = r.minX; x <= r.maxX; x++) {
      if (!r.mask[row + (x - r.minX)]) continue;
      fn(y * imageWidth + x, x, y);
    }
  }
}

/**
 * Draw the upload into a working canvas. Native size unless the long edge
 * is above WORKING_MAX_EDGE (then it is scaled down, never up).
 */
export function rasterizeImage(
  img: HTMLImageElement,
  maxEdge = WORKING_MAX_EDGE
): { canvas: HTMLCanvasElement; imageData: ImageData; downsample: number } {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const limit = maxEdge > 0 ? maxEdge : WORKING_MAX_EDGE;
  const scale = Math.min(1, limit / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Keep PNG alpha. Filling white first made white-on-transparent logos invisible.
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, imageData: ctx.getImageData(0, 0, w, h), downsample: scale };
}

/** Quantize by nearest of sampled palette + merge similar. */
function buildPalette(data: ImageData, maxColors: number, tolerance: number): Rgba[] {
  const { width, height } = data;
  const samples: Rgba[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 8000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data.data[i + 3];
      if (a < 20) continue;
      samples.push({
        r: data.data[i],
        g: data.data[i + 1],
        b: data.data[i + 2],
        a: 255,
      });
    }
  }

  const palette: Rgba[] = [];
  for (const s of samples) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const d = colorDist(s, palette[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= tolerance) {
      const p = palette[best];
      p.r = Math.round((p.r + s.r) / 2);
      p.g = Math.round((p.g + s.g) / 2);
      p.b = Math.round((p.b + s.b) / 2);
    } else if (palette.length < maxColors) {
      palette.push({ ...s });
    }
  }

  // Ensure white-ish and black-ish exist for logos
  if (!palette.some((p) => p.r > 240 && p.g > 240 && p.b > 240)) {
    palette.push({ r: 255, g: 255, b: 255, a: 255 });
  }
  return palette;
}

function assignCluster(c: Rgba, palette: Rgba[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDist(c, palette[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export const DEFAULT_PART_HEIGHT_MM = 1.6;

export interface SegmentOptions {
  maxEdge?: number;
  maxColors?: number;
  colorTolerance?: number;
  minRegionPixels?: number;
  partMode?: PartMode;
}

export function segmentImage(
  img: HTMLImageElement,
  name: string,
  options: SegmentOptions = {}
): SegmentedImage {
  const maxEdge = options.maxEdge ?? WORKING_MAX_EDGE;
  const maxColors = options.maxColors ?? 12;
  const tolerance = options.colorTolerance ?? 36;

  const { imageData, downsample } = rasterizeImage(img, maxEdge);
  const { width, height, data } = imageData;
  const minRegionPixels =
    options.minRegionPixels ??
    Math.max(12, Math.round((24 * Math.max(width, height)) / 420));
  const palette = buildPalette(imageData, maxColors, tolerance);

  const labelMap = new Int16Array(width * height);
  const counts = new Array(palette.length).fill(0);

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 20) {
      labelMap[i] = -1;
      continue;
    }
    const c = { r: data[o], g: data[o + 1], b: data[o + 2], a: 255 };
    const id = assignCluster(c, palette);
    labelMap[i] = id;
    counts[id]++;
  }

  // No automatic background — user marks BG colors / fine-paints manually.
  const clusters: ColorCluster[] = palette.map((color, id) => ({
    id,
    color,
    hex: rgbaToHex(color),
    pixelCount: counts[id],
    isBackground: false,
  }));

  const bgMask = new Uint8Array(width * height);
  // Transparent pixels start as background
  for (let i = 0; i < width * height; i++) {
    if (labelMap[i] < 0) bgMask[i] = 1;
  }

  const draft: SegmentedImage = {
    name,
    width,
    height,
    sourceWidth: img.naturalWidth || img.width,
    sourceHeight: img.naturalHeight || img.height,
    downsample,
    imageData,
    labelMap,
    bgMask,
    clusters,
    regions: [],
    partMode: options.partMode ?? 'color',
  };
  return { ...draft, regions: extractRegions(draft, minRegionPixels) };
}

function isPixelBackground(seg: SegmentedImage, i: number): boolean {
  if (seg.bgMask[i]) return true;
  const cid = seg.labelMap[i];
  if (cid < 0) return true;
  return !!seg.clusters[cid]?.isBackground;
}

/** How close a neighbor must be to stay in the same closed part. */
const REGION_COLOR_TOL = 46;
/** Neighboring parts whose average colors are this close merge into one. */
const SAME_PART_COLOR_TOL = 52;

interface FgComp {
  idx: number[];
  sr: number;
  sg: number;
  sb: number;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function forEachNeighbor(
  p: number,
  width: number,
  height: number,
  eight: boolean,
  fn: (nb: number, nx: number, ny: number) => void
): void {
  const x = p % width;
  const y = (p / width) | 0;
  const x0 = Math.max(0, x - 1);
  const x1 = Math.min(width - 1, x + 1);
  const y0 = Math.max(0, y - 1);
  const y1 = Math.min(height - 1, y + 1);
  for (let ny = y0; ny <= y1; ny++) {
    for (let nx = x0; nx <= x1; nx++) {
      if (nx === x && ny === y) continue;
      if (!eight && nx !== x && ny !== y) continue;
      fn(ny * width + nx, nx, ny);
    }
  }
}

/**
 * Closed foreground parts from pixels the wand kept (not BG).
 *
 * Color mode: similar colors join, so a glossy black stroke stays one shape
 * while a white hole or cyan mark inside it stays its own part.
 *
 * Solid mode: one part per enclosed foreground object. Color is ignored;
 * fills trapped inside a shape join it. Background holes stay holes.
 */
export function extractRegions(seg: SegmentedImage, minRegionPixels = 40): ImageRegion[] {
  const { width, height, imageData, labelMap, clusters } = seg;
  const data = imageData.data;
  const n = width * height;
  const owner = new Int32Array(n).fill(-1);
  const comps: FgComp[] = [];
  const solid = seg.partMode === 'solid';

  const colorAt = (i: number): Rgba => {
    const o = i * 4;
    return { r: data[o], g: data[o + 1], b: data[o + 2], a: 255 };
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (owner[start] >= 0 || isPixelBackground(seg, start)) continue;
      const seed = colorAt(start);
      const id = comps.length;
      const comp: FgComp = {
        idx: [],
        sr: 0,
        sg: 0,
        sb: 0,
        count: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
      };
      const stack = [start];
      owner[start] = id;
      while (stack.length) {
        const p = stack.pop()!;
        const c = colorAt(p);
        const px = p % width;
        const py = (p / width) | 0;
        comp.idx.push(p);
        comp.sr += c.r;
        comp.sg += c.g;
        comp.sb += c.b;
        comp.count++;
        if (px < comp.minX) comp.minX = px;
        if (px > comp.maxX) comp.maxX = px;
        if (py < comp.minY) comp.minY = py;
        if (py > comp.maxY) comp.maxY = py;
        forEachNeighbor(p, width, height, solid, (nb) => {
          if (owner[nb] >= 0) return;
          if (isPixelBackground(seg, nb)) return;
          if (!solid && colorDist(colorAt(nb), seed) > REGION_COLOR_TOL) return;
          owner[nb] = id;
          stack.push(nb);
        });
      }
      comps.push(comp);
    }
  }

  const alive = comps.map(() => true);

  const absorb = (ci: number, best: number) => {
    const dst = comps[best];
    for (const p of comps[ci].idx) owner[p] = best;
    for (const p of comps[ci].idx) dst.idx.push(p);
    dst.sr += comps[ci].sr;
    dst.sg += comps[ci].sg;
    dst.sb += comps[ci].sb;
    dst.count += comps[ci].count;
    if (comps[ci].minX < dst.minX) dst.minX = comps[ci].minX;
    if (comps[ci].minY < dst.minY) dst.minY = comps[ci].minY;
    if (comps[ci].maxX > dst.maxX) dst.maxX = comps[ci].maxX;
    if (comps[ci].maxY > dst.maxY) dst.maxY = comps[ci].maxY;
    alive[ci] = false;
  };

  if (solid) {
    // FG trapped in a hole of a larger object (letter fill, mark in a pocket)
    // joins that object. Outer-reachable islands stay separate.
    const order = comps
      .map((_, i) => i)
      .filter((i) => alive[i])
      .sort((a, b) => comps[b].count - comps[a].count);
    if (n < 1_500_000) {
      for (const outer of order) {
        if (!alive[outer]) continue;
        const reached = new Uint8Array(n);
        const stack: number[] = [];
        const tryPush = (i: number) => {
          if (i < 0 || i >= n || reached[i] || owner[i] === outer) return;
          reached[i] = 1;
          stack.push(i);
        };
        for (let x = 0; x < width; x++) {
          tryPush(x);
          tryPush((height - 1) * width + x);
        }
        for (let y = 0; y < height; y++) {
          tryPush(y * width);
          tryPush(y * width + width - 1);
        }
        while (stack.length) {
          const p = stack.pop()!;
          forEachNeighbor(p, width, height, true, (nb) => tryPush(nb));
        }
        for (let ci = 0; ci < comps.length; ci++) {
          if (!alive[ci] || ci === outer || comps[ci].count >= comps[outer].count) continue;
          if (comps[ci].idx.some((p) => reached[p])) continue;
          absorb(ci, outer);
        }
      }
    }

    // A mark sitting in a C-shaped pocket is not a topological hole, but it
    // is enclosed in the outer object's box — join it for max solids.
    const PAD = 2;
    const boxHas = (inner: FgComp, outer: FgComp) =>
      inner.minX >= outer.minX - PAD &&
      inner.maxX <= outer.maxX + PAD &&
      inner.minY >= outer.minY - PAD &&
      inner.maxY <= outer.maxY + PAD;
    for (const outer of order) {
      if (!alive[outer]) continue;
      for (let ci = 0; ci < comps.length; ci++) {
        if (!alive[ci] || ci === outer || comps[ci].count >= comps[outer].count) continue;
        if (!boxHas(comps[ci], comps[outer])) continue;
        absorb(ci, outer);
      }
    }
  }

  let changed = true;
  for (let pass = 0; pass < 6 && changed; pass++) {
    changed = false;
    for (let ci = 0; ci < comps.length; ci++) {
      if (!alive[ci]) continue;
      const touch = new Map<number, number>();
      let edge = 0;
      for (const p of comps[ci].idx) {
        let onEdge = false;
        forEachNeighbor(p, width, height, solid, (nb) => {
          const oid = owner[nb];
          if (oid !== ci) onEdge = true;
          if (oid < 0 || oid === ci || !alive[oid]) return;
          touch.set(oid, (touch.get(oid) ?? 0) + 1);
        });
        if (onEdge) edge++;
      }
      // Anti-aliased fringe: gray strips 1–2 px wide belong to the shape they outline.
      // Clean white holes (letter counters) and solid ink stay their own parts.
      const c = comps[ci];
      const lum = luminance(c.sr / c.count, c.sg / c.count, c.sb / c.count);
      const midtone = lum > 40 && lum < 245;
      const fringe = !solid && midtone && edge / c.count > 0.55;
      const pxScale = Math.max(width, height) / 420;
      const tinyLimit = Math.max(6, Math.round(6 * pxScale));
      const tiny =
        c.count <
        (solid ? minRegionPixels : midtone ? minRegionPixels : Math.min(minRegionPixels, tinyLimit));
      if (touch.size === 0) continue;
      const avgOf = (k: number): Rgba => ({
        r: comps[k].sr / comps[k].count,
        g: comps[k].sg / comps[k].count,
        b: comps[k].sb / comps[k].count,
        a: 255,
      });
      const mine = avgOf(ci);
      let best = -1;
      let bestN = -1;
      for (const [oid, hits] of touch) {
        // Color mode: shades of one ink join. Solid mode: any touching neighbor.
        if (!solid && !tiny && !fringe && colorDist(mine, avgOf(oid)) > SAME_PART_COLOR_TOL) continue;
        if (hits > bestN || (hits === bestN && comps[oid].count > comps[best].count)) {
          best = oid;
          bestN = hits;
        }
      }
      if (best < 0) continue;
      absorb(ci, best);
      changed = true;
    }
  }

  const regions: ImageRegion[] = [];
  const usedPrev = new Set<string>();
  let regionIndex = 0;
  for (let ci = 0; ci < comps.length; ci++) {
    if (!alive[ci] || comps[ci].count === 0) continue;
    const comp = comps[ci];
    const avg: Rgba = solid
      ? dominantColor(data, comp.idx)
      : {
          r: Math.round(comp.sr / comp.count),
          g: Math.round(comp.sg / comp.count),
          b: Math.round(comp.sb / comp.count),
          a: 255,
        };
    const hex = rgbaToHex(avg);
    const cx = (comp.minX + comp.maxX) / 2;
    const cy = (comp.minY + comp.maxY) / 2;
    // Same spot and size. Color mode also matches color so a letter and its
    // hole (same centre) stay distinct. Solid mode ignores color.
    const posTol = Math.max(6, Math.round(Math.max(width, height) / 80));
    const prev = seg.regions.find((r) => {
      if (usedPrev.has(r.id)) return false;
      const pcx = (r.minX + r.maxX) / 2;
      const pcy = (r.minY + r.maxY) / 2;
      if (Math.abs(pcx - cx) >= posTol || Math.abs(pcy - cy) >= posTol) return false;
      if (!solid && colorDist(r.color, avg) > 60) return false;
      const ratio = r.pixelCount / comp.count;
      return solid ? ratio > 0.2 && ratio < 5 : ratio > 0.5 && ratio < 2;
    });
    if (prev) usedPrev.add(prev.id);
    const clusterId = labelMap[comp.idx[0]] >= 0 ? labelMap[comp.idx[0]] : (clusters[0]?.id ?? 0);
    const mw = comp.maxX - comp.minX + 1;
    const mh = comp.maxY - comp.minY + 1;
    const mask = new Uint8Array(mw * mh);
    for (const p of comp.idx) {
      const x = p % width;
      const y = (p / width) | 0;
      mask[(y - comp.minY) * mw + (x - comp.minX)] = 1;
    }
    regionIndex++;
    regions.push({
      id: prev?.id ?? newId(),
      clusterId,
      color: avg,
      hex,
      printHex: prev?.printHexCustom ? prev.printHex : hex,
      printHexCustom: prev?.printHexCustom ?? false,
      mask,
      pixelCount: comp.count,
      minX: comp.minX,
      minY: comp.minY,
      maxX: comp.maxX,
      maxY: comp.maxY,
      heightMm: prev?.heightMm ?? seg.defaultHeightMm ?? DEFAULT_PART_HEIGHT_MM,
      enabled: prev?.enabled ?? true,
      name: prev?.name ?? `Part ${regionIndex}`,
    });
  }

  regions.sort((a, b) => b.pixelCount - a.pixelCount);
  return regions;
}

/** Most common color of a solid object (a mixed average would be muddy). */
function dominantColor(data: Uint8ClampedArray, idx: number[]): Rgba {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const p of idx) {
    const o = p * 4;
    const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    let bin = bins.get(key);
    if (!bin) {
      bin = { n: 0, r: 0, g: 0, b: 0 };
      bins.set(key, bin);
    }
    bin.n++;
    bin.r += data[o];
    bin.g += data[o + 1];
    bin.b += data[o + 2];
    if (!best || bin.n > best.n) best = bin;
  }
  if (!best) return { r: 0, g: 0, b: 0, a: 255 };
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
    a: 255,
  };
}

function withRebuiltRegions(seg: SegmentedImage, patch: Partial<SegmentedImage> = {}): SegmentedImage {
  const next = { ...seg, ...patch };
  next.regions = extractRegions(next);
  return next;
}

/** Re-split the current foreground into parts with another mode. */
export function setPartMode(seg: SegmentedImage, partMode: PartMode): SegmentedImage {
  return withRebuiltRegions(seg, { partMode });
}

/** Paint a display-sized overlay. Clicks map back to working pixels by ratio. */
export function renderRegionPreview(
  segmented: SegmentedImage,
  selectedIds: Set<string>,
  showBackground = true,
  wandBgParts: WandBgPart[] = [],
  activeWandId: string | null = null
): HTMLCanvasElement {
  const { width, height, imageData, regions, bgMask } = segmented;
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * scale));
  const ph = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(pw, ph);
  const src = imageData.data;
  const sx = width / pw;
  const sy = height / ph;
  const selected = regions.filter((r) => selectedIds.has(r.id));
  const showWand = wandBgParts.length > 0 && showBackground;
  const active = wandBgParts.find((p) => p.id === activeWandId);
  const activeFull = active && active.mask.length === width * height ? active.mask : null;

  for (let py = 0; py < ph; py++) {
    const y = Math.min(height - 1, (py * sy) | 0);
    for (let px = 0; px < pw; px++) {
      const x = Math.min(width - 1, (px * sx) | 0);
      const i = y * width + x;
      const o = (py * pw + px) * 4;
      const so = i * 4;
      if (showWand && bgMask[i]) {
        const hi = activeFull ? activeFull[i] === 1 : false;
        out.data[o] = 255;
        out.data[o + 1] = hi ? 105 : 140;
        out.data[o + 2] = hi ? 180 : 200;
        out.data[o + 3] = 255;
      } else {
        out.data[o] = src[so];
        out.data[o + 1] = src[so + 1];
        out.data[o + 2] = src[so + 2];
        out.data[o + 3] = src[so + 3];
        if (selected.some((r) => regionHasPixel(r, x, y))) {
          out.data[o] = 34;
          out.data[o + 1] = 197;
          out.data[o + 2] = 94;
          out.data[o + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

export function hitTestRegion(
  segmented: SegmentedImage,
  px: number,
  py: number
): ImageRegion | null {
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (x < 0 || y < 0 || x >= segmented.width || y >= segmented.height) return null;
  for (const r of segmented.regions) {
    if (regionHasPixel(r, x, y)) return r;
  }
  return null;
}

export function toggleClusterBackground(segmented: SegmentedImage, clusterId: number): SegmentedImage {
  const clusters = segmented.clusters.map((c) =>
    c.id === clusterId ? { ...c, isBackground: !c.isBackground } : c
  );
  return withRebuiltRegions(segmented, { clusters });
}

function dilateMask(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (src[i]) continue;
      if (
        (x > 0 && src[i - 1]) ||
        (x + 1 < width && src[i + 1]) ||
        (y > 0 && src[i - width]) ||
        (y + 1 < height && src[i + width])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

function erodeMask(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!src[i]) continue;
      if (
        x === 0 ||
        y === 0 ||
        x + 1 >= width ||
        y + 1 >= height ||
        !src[i - 1] ||
        !src[i + 1] ||
        !src[i - width] ||
        !src[i + width]
      ) {
        out[i] = 0;
      }
    }
  }
  return out;
}

/** One magic-wand BG pick — can restore to foreground later. */
export interface WandBgPart {
  id: string;
  name: string;
  hex: string;
  pixelCount: number;
  mask: Uint8Array;
  /** Working-image click. Used to re-flood when tolerance / smooth / grow change. */
  seedX: number;
  seedY: number;
  kind: 'click' | 'outer' | 'alpha';
}

const ALPHA_BG = 20;

function pixelIsTransparent(seg: SegmentedImage, i: number): boolean {
  if (seg.labelMap[i] < 0) return true;
  return seg.imageData.data[i * 4 + 3] < ALPHA_BG;
}

/** True when the upload has PNG / GIF alpha holes. */
export function imageHasTransparency(seg: SegmentedImage): boolean {
  for (let i = 0; i < seg.labelMap.length; i++) {
    if (pixelIsTransparent(seg, i)) return true;
  }
  return false;
}

/**
 * Mark every transparent pixel as a named BG part so 3D can build without
 * wand-clicking empty alpha (clicks there are already BG and do nothing).
 */
export function collectTransparentBackground(
  segmented: SegmentedImage
): { segmented: SegmentedImage; part: WandBgPart | null } {
  const n = segmented.width * segmented.height;
  const bgMask = new Uint8Array(segmented.bgMask);
  const partMask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!pixelIsTransparent(segmented, i)) continue;
    partMask[i] = 1;
    bgMask[i] = 1;
    count++;
  }
  if (count < 1) return { segmented, part: null };
  return {
    segmented: withRebuiltRegions(segmented, { bgMask }),
    part: {
      id: newId(),
      name: 'Transparent',
      hex: 'clear',
      pixelCount: count,
      mask: partMask,
      seedX: -1,
      seedY: -1,
      kind: 'alpha',
    },
  };
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Closed ink around the clicked color. A short close seals anti-aliased
 * gaps and glossy breaks in black strokes so a white flood cannot enter
 * holes inside letters and shapes. The clicked surface itself stays open.
 */
function sealedWall(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: Rgba,
  tolerance: number,
  seedIndex = -1
): Uint8Array {
  const wall = new Uint8Array(width * height);
  const seedLum = luminance(seed.r, seed.g, seed.b);
  const inkDist = Math.max(22, tolerance * 0.65);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const lum = luminance(r, g, b);
    if (seedLum - lum >= 42 && colorDistRgb(r, g, b, seed.r, seed.g, seed.b) > inkDist) wall[i] = 1;
  }
  let closed = wall;
  for (let i = 0; i < 2; i++) closed = new Uint8Array(dilateMask(closed, width, height));
  for (let i = 0; i < 2; i++) closed = new Uint8Array(erodeMask(closed, width, height));

  // A click inside a hole only a few px wide (e.g. the counters of a small "B"):
  // the close fills it, so reopen the clicked surface up to the real ink.
  if (seedIndex >= 0 && closed[seedIndex] && !wall[seedIndex]) {
    const stack = [seedIndex];
    closed[seedIndex] = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      const neighbors = [
        x > 0 ? i - 1 : -1,
        x + 1 < width ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y + 1 < height ? i + width : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0 || !closed[nb] || wall[nb]) continue;
        const o = nb * 4;
        if (colorDistRgb(data[o], data[o + 1], data[o + 2], seed.r, seed.g, seed.b) > tolerance) {
          continue;
        }
        closed[nb] = 0;
        stack.push(nb);
      }
    }
  }
  return closed;
}

/** Same close as sealedWall, but only inside a window (for small hole clicks). */
function sealedWallWindow(
  data: Uint8ClampedArray,
  width: number,
  _height: number,
  seed: Rgba,
  tolerance: number,
  seedIndex: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Uint8Array {
  const ww = x1 - x0 + 1;
  const hh = y1 - y0 + 1;
  const wall = new Uint8Array(ww * hh);
  const seedLum = luminance(seed.r, seed.g, seed.b);
  const inkDist = Math.max(22, tolerance * 0.65);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * width + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (seedLum - luminance(r, g, b) >= 42 && colorDistRgb(r, g, b, seed.r, seed.g, seed.b) > inkDist) {
        wall[(y - y0) * ww + (x - x0)] = 1;
      }
    }
  }
  let closed = wall;
  for (let i = 0; i < 2; i++) closed = new Uint8Array(dilateMask(closed, ww, hh));
  for (let i = 0; i < 2; i++) closed = new Uint8Array(erodeMask(closed, ww, hh));

  const sx = seedIndex % width;
  const sy = (seedIndex / width) | 0;
  if (seedIndex >= 0 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) {
    const li = (sy - y0) * ww + (sx - x0);
    if (closed[li] && !wall[li]) {
      const stack = [li];
      closed[li] = 0;
      while (stack.length) {
        const i = stack.pop()!;
        const lx = i % ww;
        const ly = (i / ww) | 0;
        const nbs = [
          lx > 0 ? i - 1 : -1,
          lx + 1 < ww ? i + 1 : -1,
          ly > 0 ? i - ww : -1,
          ly + 1 < hh ? i + ww : -1,
        ];
        for (const nb of nbs) {
          if (nb < 0 || !closed[nb] || wall[nb]) continue;
          const ix = x0 + (nb % ww);
          const iy = y0 + ((nb / ww) | 0);
          const o = (iy * width + ix) * 4;
          if (colorDistRgb(data[o], data[o + 1], data[o + 2], seed.r, seed.g, seed.b) > tolerance) {
            continue;
          }
          closed[nb] = 0;
          stack.push(nb);
        }
      }
    }
  }
  return closed;
}

function unionSealedWall(
  raw: SegmentedImage,
  picks: WandBgPart[],
  tolerance: number
): Uint8Array {
  const wall = new Uint8Array(raw.width * raw.height);
  const data = raw.imageData.data;
  const white: Rgba = { r: 255, g: 255, b: 255, a: 255 };
  for (const pick of picks) {
    if (pick.kind === 'alpha') continue;
    let seed = white;
    let seedIndex = -1;
    if (pick.kind === 'click') {
      const x = Math.max(0, Math.min(raw.width - 1, Math.floor(pick.seedX)));
      const y = Math.max(0, Math.min(raw.height - 1, Math.floor(pick.seedY)));
      seedIndex = y * raw.width + x;
      const o = seedIndex * 4;
      seed = { r: data[o], g: data[o + 1], b: data[o + 2], a: 255 };
    }
    const part = sealedWall(data, raw.width, raw.height, seed, tolerance, seedIndex);
    for (let i = 0; i < wall.length; i++) if (part[i]) wall[i] = 1;
  }
  return wall;
}

/** Drop BG pixels that cannot be reached from the clicks without crossing ink. */
function retainReachableBackground(
  bgMask: Uint8Array,
  wall: Uint8Array,
  width: number,
  height: number,
  seeds: Array<{ x: number; y: number }>
): Uint8Array {
  const out = new Uint8Array(bgMask.length);
  const visited = new Uint8Array(bgMask.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (i < 0 || i >= bgMask.length || visited[i] || wall[i] || !bgMask[i]) return;
    visited[i] = 1;
    stack.push(i);
  };
  for (const s of seeds) {
    if (s.x < 0 || s.y < 0) continue;
    const x = Math.max(0, Math.min(width - 1, Math.floor(s.x)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(s.y)));
    push(y * width + x);
  }
  while (stack.length) {
    const i = stack.pop()!;
    out[i] = 1;
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(i - 1);
    if (x + 1 < width) push(i + 1);
    if (y > 0) push(i - width);
    if (y + 1 < height) push(i + width);
  }
  return out;
}

export type WandPick = {
  mask: Uint8Array;
  seed: Rgba;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const SMALL_HOLE_PX = 80_000;
const SMALL_HOLE_EDGE = 640;

function wandPickFromRegion(segmented: SegmentedImage, region: ImageRegion): WandPick | null {
  const mask = new Uint8Array(segmented.width * segmented.height);
  let count = 0;
  forEachRegionPixel(region, segmented.width, (i) => {
    if (segmented.bgMask[i]) return;
    mask[i] = 1;
    count++;
  });
  if (count < 1) return null;
  return {
    mask,
    seed: region.color,
    count,
    minX: region.minX,
    minY: region.minY,
    maxX: region.maxX,
    maxY: region.maxY,
  };
}

function floodWandWindow(
  segmented: SegmentedImage,
  seed: Rgba,
  start: number,
  tolerance: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): {
  local: Uint8Array;
  count: number;
  hitBorder: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  const { width, height, imageData, bgMask } = segmented;
  const data = imageData.data;
  const ww = x1 - x0 + 1;
  const hh = y1 - y0 + 1;
  const wall = sealedWallWindow(data, width, height, seed, tolerance, start, x0, y0, x1, y1);
  const sx = start % width;
  const sy = (start / width) | 0;
  const ls = (sy - y0) * ww + (sx - x0);
  if (ls < 0 || ls >= wall.length || wall[ls]) return null;

  const local = new Uint8Array(ww * hh);
  const visited = new Uint8Array(ww * hh);
  const stack = [ls];
  visited[ls] = 1;
  let count = 0;
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  let hitBorder = false;

  while (stack.length) {
    const li = stack.pop()!;
    const lx = li % ww;
    const ly = (li / ww) | 0;
    const x = x0 + lx;
    const y = y0 + ly;
    const i = y * width + x;
    if (bgMask[i] || wall[li]) continue;
    const o = i * 4;
    if (colorDistRgb(data[o], data[o + 1], data[o + 2], seed.r, seed.g, seed.b) > tolerance) continue;
    local[li] = 1;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (
      (lx === 0 && x0 > 0) ||
      (lx === ww - 1 && x1 < width - 1) ||
      (ly === 0 && y0 > 0) ||
      (ly === hh - 1 && y1 < height - 1)
    ) {
      hitBorder = true;
    }
    const nbs = [
      lx > 0 ? li - 1 : -1,
      lx + 1 < ww ? li + 1 : -1,
      ly > 0 ? li - ww : -1,
      ly + 1 < hh ? li + ww : -1,
    ];
    for (const n of nbs) {
      if (n < 0 || visited[n] || wall[n]) continue;
      const nx = x0 + (n % ww);
      const ny = y0 + ((n / ww) | 0);
      const ni = ny * width + nx;
      if (bgMask[ni]) continue;
      const no = ni * 4;
      if (colorDistRgb(data[no], data[no + 1], data[no + 2], seed.r, seed.g, seed.b) > tolerance) {
        continue;
      }
      visited[n] = 1;
      stack.push(n);
    }
  }

  if (count < 1) return null;

  const edgeLum = luminance(seed.r, seed.g, seed.b) * 0.55;
  const gx0 = Math.max(0, minX - x0 - 1);
  const gy0 = Math.max(0, minY - y0 - 1);
  const gx1 = Math.min(ww - 1, maxX - x0 + 1);
  const gy1 = Math.min(hh - 1, maxY - y0 + 1);
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let ly = gy0; ly <= gy1; ly++) {
      for (let lx = gx0; lx <= gx1; lx++) {
        const li = ly * ww + lx;
        if (local[li]) continue;
        const x = x0 + lx;
        const y = y0 + ly;
        const i = y * width + x;
        if (bgMask[i]) continue;
        const touches =
          (lx > 0 && local[li - 1]) ||
          (lx + 1 < ww && local[li + 1]) ||
          (ly > 0 && local[li - ww]) ||
          (ly + 1 < hh && local[li + ww]);
        if (!touches) continue;
        const o = i * 4;
        if (luminance(data[o], data[o + 1], data[o + 2]) >= edgeLum) add.push(li);
      }
    }
    for (const li of add) {
      local[li] = 1;
      count++;
      const x = x0 + (li % ww);
      const y = y0 + ((li / ww) | 0);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return { local, count, hitBorder, minX, minY, maxX, maxY };
}

/**
 * Contiguous magic-wand flood. Stops at closed darker outlines, so clicking
 * white does not enter holes inside black shapes.
 *
 * Small closed parts (letter holes) use the existing region mask. Larger
 * floods run in an expanding window so a 5k image is not scanned on every click.
 */
export function pickWandRegion(
  segmented: SegmentedImage,
  px: number,
  py: number,
  tolerance: number
): WandPick | null {
  const { width, height, imageData, bgMask } = segmented;
  const sx = Math.max(0, Math.min(width - 1, Math.floor(px)));
  const sy = Math.max(0, Math.min(height - 1, Math.floor(py)));
  const start = sy * width + sx;
  if (bgMask[start]) return null;

  const hit = hitTestRegion(segmented, sx, sy);
  if (
    hit &&
    hit.pixelCount <= SMALL_HOLE_PX &&
    hit.maxX - hit.minX + 1 <= SMALL_HOLE_EDGE &&
    hit.maxY - hit.minY + 1 <= SMALL_HOLE_EDGE
  ) {
    const fromHit = wandPickFromRegion(segmented, hit);
    if (fromHit) return fromHit;
  }

  const data = imageData.data;
  const seedI = start * 4;
  const seed: Rgba = {
    r: data[seedI],
    g: data[seedI + 1],
    b: data[seedI + 2],
    a: 255,
  };

  let rad = 80;
  const maxRad = Math.max(width, height);
  for (;;) {
    const x0 = Math.max(0, sx - rad);
    const y0 = Math.max(0, sy - rad);
    const x1 = Math.min(width - 1, sx + rad);
    const y1 = Math.min(height - 1, sy + rad);
    const full = x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1;
    const got = floodWandWindow(segmented, seed, start, tolerance, x0, y0, x1, y1);
    if (!got) return null;
    if (!got.hitBorder || full) {
      const mask = new Uint8Array(width * height);
      const ww = x1 - x0 + 1;
      for (let y = got.minY; y <= got.maxY; y++) {
        for (let x = got.minX; x <= got.maxX; x++) {
          if (got.local[(y - y0) * ww + (x - x0)]) mask[y * width + x] = 1;
        }
      }
      return {
        mask,
        seed,
        count: got.count,
        minX: got.minX,
        minY: got.minY,
        maxX: got.maxX,
        maxY: got.maxY,
      };
    }
    if (full) return null;
    rad = Math.min(maxRad, rad * 2);
  }
}

/**
 * Photoshop-style Magic Wand (Contiguous on): add one closed region as BG.
 */
export function floodBackgroundAt(
  segmented: SegmentedImage,
  px: number,
  py: number,
  tolerance: number
): SegmentedImage {
  const picked = pickWandRegion(segmented, px, py, tolerance);
  if (!picked) return segmented;
  const bgMask = new Uint8Array(segmented.bgMask);
  for (let i = 0; i < picked.mask.length; i++) {
    if (picked.mask[i]) bgMask[i] = 1;
  }
  return withRebuiltRegions(segmented, { bgMask });
}

/** Wand-pick a closed region, apply as BG, and return a list entry (pink in UI). */
export function addWandBgPart(
  segmented: SegmentedImage,
  px: number,
  py: number,
  tolerance: number,
  index: number
): { segmented: SegmentedImage; part: WandBgPart } | null {
  const picked = pickWandRegion(segmented, px, py, tolerance);
  if (!picked) return null;
  const bgMask = new Uint8Array(segmented.bgMask);
  for (let i = 0; i < picked.mask.length; i++) {
    if (picked.mask[i]) bgMask[i] = 1;
  }
  const part: WandBgPart = {
    id: newId(),
    name: `BG ${index}`,
    hex: rgbaToHex(picked.seed),
    pixelCount: picked.count,
    mask: picked.mask,
    seedX: px,
    seedY: py,
    kind: 'click',
  };
  return { segmented: withRebuiltRegions(segmented, { bgMask }), part };
}

function applyLocalSmoothGrow(
  mask: Uint8Array,
  live: SegmentedImage,
  pick: WandPick,
  seedX: number,
  seedY: number,
  tolerance: number,
  smooth: number,
  grow: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (smooth <= 0 && grow <= 0) {
    return { minX: pick.minX, minY: pick.minY, maxX: pick.maxX, maxY: pick.maxY };
  }
  const pad = Math.max(2, Math.round(smooth) + Math.round(grow) + 2);
  const x0 = Math.max(0, pick.minX - pad);
  const y0 = Math.max(0, pick.minY - pad);
  const x1 = Math.min(live.width - 1, pick.maxX + pad);
  const y1 = Math.min(live.height - 1, pick.maxY + pad);
  const ww = x1 - x0 + 1;
  const hh = y1 - y0 + 1;
  const local = new Uint8Array(ww * hh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask[y * live.width + x]) local[(y - y0) * ww + (x - x0)] = 1;
    }
  }
  const sx = Math.max(0, Math.min(live.width - 1, Math.floor(seedX)));
  const sy = Math.max(0, Math.min(live.height - 1, Math.floor(seedY)));
  const seedIndex = sy * live.width + sx;
  const wall = sealedWallWindow(
    live.imageData.data,
    live.width,
    live.height,
    pick.seed,
    tolerance,
    seedIndex,
    x0,
    y0,
    x1,
    y1
  );
  const grown = smoothGrowMask(local, ww, hh, smooth, grow, wall);
  let minX = pick.minX;
  let minY = pick.minY;
  let maxX = pick.maxX;
  let maxY = pick.maxY;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!grown[(y - y0) * ww + (x - x0)]) continue;
      mask[y * live.width + x] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function punchRegionsByNewMask(
  seg: SegmentedImage,
  newMask: Uint8Array,
  box: { minX: number; minY: number; maxX: number; maxY: number }
): { regions: ImageRegion[]; removedIds: string[]; changedIds: string[] } {
  const pts: Array<{ x: number; y: number }> = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const i = y * seg.width + x;
      if (newMask[i] && !seg.bgMask[i]) pts.push({ x, y });
    }
  }
  const removedIds: string[] = [];
  const changedIds: string[] = [];
  const regions: ImageRegion[] = [];
  for (const r of seg.regions) {
    if (r.maxX < box.minX || r.minX > box.maxX || r.maxY < box.minY || r.minY > box.maxY) {
      regions.push(r);
      continue;
    }
    let lost = 0;
    for (const p of pts) {
      if (regionHasPixel(r, p.x, p.y)) lost++;
    }
    if (lost < 1) {
      regions.push(r);
      continue;
    }
    const keep = r.pixelCount - lost;
    if (keep < 1) {
      removedIds.push(r.id);
      continue;
    }
    const mw = r.maxX - r.minX + 1;
    let minX = r.maxX;
    let minY = r.maxY;
    let maxX = r.minX;
    let maxY = r.minY;
    for (let y = r.minY; y <= r.maxY; y++) {
      for (let x = r.minX; x <= r.maxX; x++) {
        if (!r.mask[(y - r.minY) * mw + (x - r.minX)]) continue;
        if (newMask[y * seg.width + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX) {
      removedIds.push(r.id);
      continue;
    }
    const nmw = maxX - minX + 1;
    const mask = new Uint8Array(nmw * (maxY - minY + 1));
    let count = 0;
    for (let y = r.minY; y <= r.maxY; y++) {
      for (let x = r.minX; x <= r.maxX; x++) {
        if (!r.mask[(y - r.minY) * mw + (x - r.minX)]) continue;
        if (newMask[y * seg.width + x]) continue;
        mask[(y - minY) * nmw + (x - minX)] = 1;
        count++;
      }
    }
    if (count < 1) {
      removedIds.push(r.id);
      continue;
    }
    changedIds.push(r.id);
    regions.push({ ...r, mask, pixelCount: count, minX, minY, maxX, maxY });
  }
  return { regions, removedIds, changedIds };
}

/**
 * Add one wand click as BG without re-flooding every previous pick or
 * re-segmenting the whole bitmap. Used for hole clicks on large images.
 */
export function appendWandClickPick(
  live: SegmentedImage,
  parts: WandBgPart[],
  seedX: number,
  seedY: number,
  tolerance: number,
  smooth: number,
  grow: number,
  id: string,
  name: string
): {
  segmented: SegmentedImage;
  parts: WandBgPart[];
  added: WandBgPart;
  removedRegionIds: string[];
  changedRegionIds: string[];
} | null {
  const picked = pickWandRegion(live, seedX, seedY, tolerance);
  if (!picked || picked.count < 1) return null;

  const mask = new Uint8Array(picked.mask);
  const box = applyLocalSmoothGrow(mask, live, picked, seedX, seedY, tolerance, smooth, grow);

  const bgMask = new Uint8Array(live.bgMask);
  let pixelCount = 0;
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const i = y * live.width + x;
      if (!mask[i]) continue;
      bgMask[i] = 1;
      pixelCount++;
    }
  }
  if (pixelCount < 1) return null;

  const punched = punchRegionsByNewMask(live, mask, box);
  const added: WandBgPart = {
    id,
    name,
    hex: rgbaToHex(picked.seed),
    pixelCount,
    mask,
    seedX,
    seedY,
    kind: 'click',
  };
  return {
    segmented: { ...live, bgMask, regions: punched.regions },
    parts: [...parts, added],
    added,
    removedRegionIds: punched.removedIds,
    changedRegionIds: punched.changedIds,
  };
}

/** Mark an existing FG region mask as a wand BG list entry. */
export function addRegionAsWandBgPart(
  segmented: SegmentedImage,
  regionId: string,
  index: number
): { segmented: SegmentedImage; part: WandBgPart } | null {
  const region = segmented.regions.find((r) => r.id === regionId);
  if (!region) return null;
  const bgMask = new Uint8Array(segmented.bgMask);
  const partMask = new Uint8Array(segmented.width * segmented.height);
  let count = 0;
  forEachRegionPixel(region, segmented.width, (i) => {
    if (bgMask[i]) return;
    bgMask[i] = 1;
    partMask[i] = 1;
    count++;
  });
  if (count < 4) return null;
  const part: WandBgPart = {
    id: newId(),
    name: region.name || `BG ${index}`,
    hex: region.hex,
    pixelCount: count,
    mask: partMask,
    seedX: (region.minX + region.maxX) / 2,
    seedY: (region.minY + region.maxY) / 2,
    kind: 'click',
  };
  return { segmented: withRebuiltRegions(segmented, { bgMask }), part };
}

/** Restore a wand BG part back to foreground. */
export function restoreWandBgPart(
  segmented: SegmentedImage,
  part: WandBgPart
): SegmentedImage {
  const bgMask = new Uint8Array(segmented.bgMask);
  for (let i = 0; i < part.mask.length; i++) {
    if (part.mask[i]) bgMask[i] = 0;
  }
  // Keep true transparent as BG
  for (let i = 0; i < bgMask.length; i++) {
    if (segmented.labelMap[i] < 0) bgMask[i] = 1;
  }
  return withRebuiltRegions(segmented, { bgMask });
}

export function applyWandBgMask(
  segmented: SegmentedImage,
  mask: Uint8Array,
  name: string,
  hex: string
): { segmented: SegmentedImage; part: WandBgPart } {
  const bgMask = new Uint8Array(segmented.bgMask);
  let count = 0;
  const partMask = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || bgMask[i]) continue;
    bgMask[i] = 1;
    partMask[i] = 1;
    count++;
  }
  const part: WandBgPart = {
    id: newId(),
    name,
    hex,
    pixelCount: count,
    mask: partMask,
    seedX: 0,
    seedY: 0,
    kind: 'click',
  };
  return { segmented: withRebuiltRegions(segmented, { bgMask }), part };
}

/**
 * Mark whole closed part(s) as background (exact region masks — not whole color class).
 */
export function markRegionsAsBackground(
  segmented: SegmentedImage,
  regionIds: string[]
): SegmentedImage {
  if (regionIds.length === 0) return segmented;
  const idSet = new Set(regionIds);
  const bgMask = new Uint8Array(segmented.bgMask);
  for (const r of segmented.regions) {
    if (!idSet.has(r.id)) continue;
    forEachRegionPixel(r, segmented.width, (i) => {
      bgMask[i] = 1;
    });
  }
  return withRebuiltRegions(segmented, { bgMask });
}

/**
 * Auto outer BG: magic-wand from every border pixel that matches near-white.
 * Only the connected outer plate — holes inside letters stay unless connected to the edge.
 */
export function floodOuterNearWhiteBackground(
  segmented: SegmentedImage,
  tolerance: number
): { segmented: SegmentedImage; part: WandBgPart | null } {
  const { width, height, imageData } = segmented;
  const data = imageData.data;
  const white: Rgba = { r: 255, g: 255, b: 255, a: 255 };
  const wall = sealedWall(data, width, height, white, tolerance);
  const bgMask = new Uint8Array(segmented.bgMask);
  const partMask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  let count = 0;

  const trySeed = (x: number, y: number) => {
    const i = y * width + x;
    if (visited[i] || wall[i]) return;
    const o = i * 4;
    const c: Rgba = { r: data[o], g: data[o + 1], b: data[o + 2], a: 255 };
    if (colorDist(c, white) > tolerance) return;
    visited[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < width; x++) {
    trySeed(x, 0);
    trySeed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    trySeed(0, y);
    trySeed(width - 1, y);
  }

  while (stack.length) {
    const i = stack.pop()!;
    if (!bgMask[i]) {
      partMask[i] = 1;
      count++;
    }
    bgMask[i] = 1;
    const x = i % width;
    const y = (i / width) | 0;
    const neighbors = [i - 1, i + 1, i - width, i + width];
    for (const n of neighbors) {
      if (n < 0 || n >= width * height) continue;
      const nx = n % width;
      const ny = (n / width) | 0;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if (visited[n] || wall[n]) continue;
      const no = n * 4;
      const nc: Rgba = { r: data[no], g: data[no + 1], b: data[no + 2], a: 255 };
      if (colorDist(nc, white) > tolerance) continue;
      visited[n] = 1;
      stack.push(n);
    }
  }

  const next = withRebuiltRegions(segmented, { bgMask });
  if (count < 4) return { segmented: next, part: null };
  return {
    segmented: next,
    part: {
      id: newId(),
      name: 'Outer white',
      hex: '#ffffff',
      pixelCount: count,
      mask: partMask,
      seedX: -1,
      seedY: -1,
      kind: 'outer',
    },
  };
}

export function markNearWhiteAsBackground(
  segmented: SegmentedImage,
  tolerance: number
): SegmentedImage {
  return floodOuterNearWhiteBackground(segmented, tolerance).segmented;
}

/**
 * Smooth FG/BG boundary: majority filter + optional BG grow (eats fringe).
 * `smoothPasses` = majority filter iterations; `grow` = BG dilate steps.
 */
function holdWall(mask: Uint8Array, wall: Uint8Array | null): Uint8Array {
  if (!wall) return mask;
  for (let i = 0; i < mask.length; i++) if (wall[i]) mask[i] = 0;
  return mask;
}

function smoothGrowMask(
  src: Uint8Array,
  width: number,
  height: number,
  smoothPasses: number,
  grow: number,
  wall: Uint8Array | null = null
): Uint8Array {
  let bgMask = holdWall(new Uint8Array(src), wall);
  const passes = Math.max(0, Math.min(12, Math.round(smoothPasses)));
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(bgMask);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (wall && wall[i]) {
          next[i] = 0;
          continue;
        }
        let bg = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (bgMask[(y + dy) * width + (x + dx)]) bg++;
          }
        }
        next[i] = bg >= 5 ? 1 : 0;
      }
    }
    bgMask = holdWall(next, wall);
  }

  const growN = Math.max(0, Math.min(10, Math.round(grow)));
  for (let g = 0; g < growN; g++) {
    bgMask = holdWall(new Uint8Array(dilateMask(bgMask, width, height)), wall);
  }
  if (passes > 0) {
    const before = bgMask;
    let closed = holdWall(new Uint8Array(dilateMask(bgMask, width, height)), wall);
    closed = holdWall(new Uint8Array(erodeMask(closed, width, height)), wall);
    for (let i = 0; i < closed.length; i++) if (before[i]) closed[i] = 1;
    bgMask = closed;
  }
  return bgMask;
}

export function refineBackground(
  segmented: SegmentedImage,
  smoothPasses: number,
  grow: number
): SegmentedImage {
  const bgMask = smoothGrowMask(
    segmented.bgMask,
    segmented.width,
    segmented.height,
    smoothPasses,
    grow
  );
  return withRebuiltRegions(segmented, { bgMask });
}

function freshBackground(raw: SegmentedImage): SegmentedImage {
  const bgMask = new Uint8Array(raw.width * raw.height);
  for (let i = 0; i < bgMask.length; i++) {
    if (raw.labelMap[i] < 0) bgMask[i] = 1;
  }
  return { ...raw, bgMask };
}

/**
 * Rebuild BG from the original image using the same click points (and outer-edge
 * picks) under a new tolerance / smooth / grow. List ids and order are kept.
 */
export function reapplyWandPicks(
  raw: SegmentedImage,
  picks: WandBgPart[],
  tolerance: number,
  smoothPasses: number,
  grow: number,
  /** Current parts — keeps per-part height / color edits across re-floods. */
  prevRegions?: ImageRegion[]
): { segmented: SegmentedImage; parts: WandBgPart[] } {
  let current = freshBackground(raw);
  const parts: WandBgPart[] = [];

  for (const pick of picks) {
    if (pick.kind === 'outer') {
      const flooded = floodOuterNearWhiteBackground(current, tolerance);
      current = flooded.segmented;
      const mask = flooded.part?.mask ?? new Uint8Array(raw.width * raw.height);
      let count = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
      parts.push({
        ...pick,
        hex: '#ffffff',
        mask,
        pixelCount: count,
      });
      continue;
    }
    if (pick.kind === 'alpha') {
      const flooded = collectTransparentBackground(current);
      current = flooded.segmented;
      const mask = flooded.part?.mask ?? new Uint8Array(raw.width * raw.height);
      let count = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
      parts.push({
        ...pick,
        hex: 'clear',
        mask,
        pixelCount: count,
      });
      continue;
    }

    const picked = pickWandRegion(current, pick.seedX, pick.seedY, tolerance);
    if (!picked) {
      parts.push({
        ...pick,
        mask: new Uint8Array(raw.width * raw.height),
        pixelCount: 0,
      });
      continue;
    }
    const bgMask = new Uint8Array(current.bgMask);
    for (let i = 0; i < picked.mask.length; i++) {
      if (picked.mask[i]) bgMask[i] = 1;
    }
    current = { ...current, bgMask };
    parts.push({
      ...pick,
      hex: rgbaToHex(picked.seed),
      mask: picked.mask,
      pixelCount: picked.count,
    });
  }

  const wall = unionSealedWall(raw, picks, tolerance);
  const picked = current.bgMask;
  for (let i = 0; i < wall.length; i++) if (picked[i]) wall[i] = 0;
  let bgMask = picked;
  if (smoothPasses > 0 || grow > 0) {
    bgMask = smoothGrowMask(bgMask, raw.width, raw.height, smoothPasses, grow, wall);
    // Smoothing must not erase small holes the user clicked.
    for (let i = 0; i < bgMask.length; i++) if (picked[i]) bgMask[i] = 1;
  }
  for (let i = 0; i < bgMask.length; i++) if (wall[i]) bgMask[i] = 0;

  const seeds: Array<{ x: number; y: number }> = [];
  for (const part of parts) {
    if (part.kind === 'click') {
      seeds.push({ x: part.seedX, y: part.seedY });
      continue;
    }
    if (part.kind !== 'outer') continue;
    for (let x = 0; x < raw.width; x++) {
      seeds.push({ x, y: 0 }, { x, y: raw.height - 1 });
    }
    for (let y = 0; y < raw.height; y++) {
      seeds.push({ x: 0, y }, { x: raw.width - 1, y });
    }
  }
  // Empty seeds (Transparent-only) would wipe the whole mask. Keep click/outer
  // floods reachable, then force PNG alpha back on so it stays a listed part.
  if (seeds.length > 0) {
    bgMask = retainReachableBackground(bgMask, wall, raw.width, raw.height, seeds);
  }
  for (let i = 0; i < bgMask.length; i++) {
    if (raw.labelMap[i] < 0) bgMask[i] = 1;
  }

  const owner = new Int16Array(bgMask.length).fill(-1);
  parts.forEach((part, pi) => {
    for (let i = 0; i < part.mask.length; i++) {
      if (part.mask[i] && bgMask[i] && owner[i] < 0) owner[i] = pi;
    }
  });
  const clicks = parts
    .map((part, pi) => ({ pi, x: part.seedX, y: part.seedY, kind: part.kind }))
    .filter((s) => s.kind === 'click');
  for (let i = 0; i < bgMask.length; i++) {
    if (!bgMask[i] || owner[i] >= 0) continue;
    if (raw.labelMap[i] < 0) {
      const alpha = parts.findIndex((p) => p.kind === 'alpha');
      if (alpha >= 0) {
        owner[i] = alpha;
        continue;
      }
    }
    if (clicks.length === 0) {
      const outer = parts.findIndex((p) => p.kind === 'outer');
      const alpha = parts.findIndex((p) => p.kind === 'alpha');
      if (outer >= 0) owner[i] = outer;
      else if (alpha >= 0) owner[i] = alpha;
      continue;
    }
    const x = i % raw.width;
    const y = (i / raw.width) | 0;
    let best = clicks[0].pi;
    let bestD = Infinity;
    for (const c of clicks) {
      const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c.pi;
      }
    }
    owner[i] = best;
  }
  for (let pi = 0; pi < parts.length; pi++) {
    const mask = new Uint8Array(bgMask.length);
    let count = 0;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] === pi) {
        mask[i] = 1;
        count++;
      }
    }
    parts[pi] = { ...parts[pi], mask, pixelCount: count };
  }

  const segmented = withRebuiltRegions(freshBackground(raw), {
    bgMask: new Uint8Array(bgMask),
    regions: prevRegions ?? raw.regions,
  });
  return { segmented, parts };
}

/** Clear fine-painted BG (keeps cluster BG flags). */
export function clearFineBackground(segmented: SegmentedImage): SegmentedImage {
  const bgMask = new Uint8Array(segmented.width * segmented.height);
  for (let i = 0; i < bgMask.length; i++) {
    if (segmented.labelMap[i] < 0) bgMask[i] = 1;
  }
  return withRebuiltRegions(segmented, { bgMask });
}

export function countFineBgPixels(segmented: SegmentedImage): number {
  let n = 0;
  for (let i = 0; i < segmented.bgMask.length; i++) if (segmented.bgMask[i]) n++;
  return n;
}
