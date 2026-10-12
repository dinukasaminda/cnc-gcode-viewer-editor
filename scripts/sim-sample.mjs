/**
 * Headless simulation of the sample isolation file using the same algorithms
 * (duplicated lightly so we can run without a TS loader).
 */
import { readFileSync } from 'fs';

function vbitEffectiveDiameter(tipDiameter, angleDeg, depth) {
  if (depth <= 0) return tipDiameter;
  const half = ((angleDeg / 2) * Math.PI) / 180;
  return tipDiameter + 2 * depth * Math.tan(half);
}

function toolRadiusAtDepth(tool, depth) {
  if (tool.type === 'vbit') return vbitEffectiveDiameter(tool.tipDiameter, tool.angle, depth) / 2;
  return tool.diameter / 2;
}

function parseGCode(text) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let absolute = true;
  let motion = 1;
  let x = 0, y = 0, z = 0, feedrate = 0, spindleOn = false;
  const wordRe = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let hasNeg = false;

  for (let li = 0; li < lines.length; li++) {
    let code = lines[li].replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim();
    if (!code) continue;
    const words = new Map();
    wordRe.lastIndex = 0;
    let m;
    while ((m = wordRe.exec(code))) words.set(m[1].toUpperCase(), parseFloat(m[2]));
    if (!words.size) continue;

    wordRe.lastIndex = 0;
    while ((m = wordRe.exec(code))) {
      if (m[1].toUpperCase() === 'G') {
        const g = Math.round(parseFloat(m[2]) * 10) / 10;
        if (g === 0) motion = 0;
        if (g === 1) motion = 1;
        if (g === 90) absolute = true;
        if (g === 91) absolute = false;
      }
      if (m[1].toUpperCase() === 'M') {
        const mv = Math.round(parseFloat(m[2]));
        if (mv === 3 || mv === 4) spindleOn = true;
        if (mv === 5) spindleOn = false;
      }
    }
    if (words.has('F')) feedrate = words.get('F');
    const hasAxis = words.has('X') || words.has('Y') || words.has('Z');
    if (!hasAxis) continue;
    const x0 = x, y0 = y, z0 = z;
    const read = (L, cur) => (words.has(L) ? (absolute ? words.get(L) : cur + words.get(L)) : cur);
    x = read('X', x); y = read('Y', y); z = read('Z', z);
    if (z < -1e-6) hasNeg = true;
    if (Math.abs(x - x0) < 1e-12 && Math.abs(y - y0) < 1e-12 && Math.abs(z - z0) < 1e-12) continue;
    segments.push({
      type: motion === 0 ? 'rapid' : 'cut',
      x0, y0, z0, x1: x, y1: y, z1: z, feedrate, spindleOn,
    });
  }
  return { segments, zConvention: hasNeg ? 'standard' : 'positive-depth' };
}

class HeightField {
  constructor(w, h, ox, oy, res, thick, cu) {
    this.originX = ox; this.originY = oy; this.resolution = res;
    this.thickness = thick; this.copperThickness = cu;
    this.cols = Math.ceil(w / res) + 1;
    this.rows = Math.ceil(h / res) + 1;
    const n = this.cols * this.rows;
    this.depth = new Float32Array(n);
    this.copper = new Uint8Array(n).fill(1);
  }
  idx(c, r) { return r * this.cols + c; }
  stampSegment(x0, y0, x1, y1, radius, cutDepth) {
    if (cutDepth <= 0) return;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1e-9) return this.stampCircle(x0, y0, radius, cutDepth);
    const hitR = Math.max(radius, 1e-6) + this.resolution * 0.5;
    const ux = dx / len, uy = dy / len;
    const radCells = hitR / this.resolution + 1;
    const toG = (x, y) => [(x - this.originX) / this.resolution, (y - this.originY) / this.resolution];
    const [fc0, fr0] = toG(x0, y0), [fc1, fr1] = toG(x1, y1);
    const c0 = Math.max(0, Math.floor(Math.min(fc0, fc1) - radCells));
    const c1 = Math.min(this.cols - 1, Math.ceil(Math.max(fc0, fc1) + radCells));
    const r0 = Math.max(0, Math.floor(Math.min(fr0, fr1) - radCells));
    const r1 = Math.min(this.rows - 1, Math.ceil(Math.max(fr0, fr1) + radCells));
    const r2 = hitR * hitR;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const x = this.originX + col * this.resolution;
        const y = this.originY + row * this.resolution;
        const t = Math.max(0, Math.min(len, (x - x0) * ux + (y - y0) * uy));
        const qx = x0 + ux * t, qy = y0 + uy * t;
        if ((x - qx) ** 2 + (y - qy) ** 2 > r2) continue;
        const i = this.idx(col, row);
        if (cutDepth > this.depth[i]) this.depth[i] = cutDepth;
        if (cutDepth >= this.copperThickness * 0.25) this.copper[i] = 0;
      }
    }
  }
  stampCircle(cx, cy, radius, cutDepth) {
    if (cutDepth <= 0) return;
    const hitR = Math.max(radius, 1e-6) + this.resolution * 0.5;
    const radCells = hitR / this.resolution + 1;
    const fc = (cx - this.originX) / this.resolution;
    const fr = (cy - this.originY) / this.resolution;
    const c0 = Math.max(0, Math.floor(fc - radCells));
    const c1 = Math.min(this.cols - 1, Math.ceil(fc + radCells));
    const r0 = Math.max(0, Math.floor(fr - radCells));
    const r1 = Math.min(this.rows - 1, Math.ceil(fr + radCells));
    const r2 = hitR * hitR;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const x = this.originX + col * this.resolution;
        const y = this.originY + row * this.resolution;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
        const i = this.idx(col, row);
        if (cutDepth > this.depth[i]) this.depth[i] = cutDepth;
        if (cutDepth >= this.copperThickness * 0.25) this.copper[i] = 0;
      }
    }
  }
}

const text = readFileSync(new URL('../samples/00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc', import.meta.url), 'utf8');
const { segments, zConvention } = parseGCode(text);
console.log(`Parsed ${segments.length} segments, Z convention: ${zConvention}`);

// FlatCAM Tool Dia 0.05 mm @ Z 0.0933 / 30° ⇒ tip ≈ 0 (effective ≠ tip)
const flatcamToolDia = 0.05;
const depthMeta = 0.0933;
const angle = 30;
const tip = Math.max(
  0,
  flatcamToolDia - 2 * depthMeta * Math.tan(((angle / 2) * Math.PI) / 180)
);
const tool = { type: 'vbit', tipDiameter: tip, angle };
console.log(`Using tip ${tip.toFixed(4)} mm (from FlatCAM Tool Dia ${flatcamToolDia})`);
const clearance = 0.7;
const depthOf = (z) => (z >= clearance ? 0 : Math.max(0, z));

const stock = new HeightField(48, 24, -1, -1, 0.05, 1.6, 0.035);
const t0 = Date.now();
let cuts = 0;
let widthSum = 0;
for (const seg of segments) {
  if (seg.type === 'rapid') continue;
  const d = Math.max(depthOf(seg.z0), depthOf(seg.z1));
  if (d <= 0) continue;
  const r = toolRadiusAtDepth(tool, d);
  const xy = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
  if (xy < 1e-6) stock.stampCircle(seg.x1, seg.y1, r, d);
  else stock.stampSegment(seg.x0, seg.y0, seg.x1, seg.y1, r, d);
  widthSum += r * 2;
  cuts++;
}
const ms = Date.now() - t0;
let removed = 0, total = 0, maxD = 0;
for (let i = 0; i < stock.copper.length; i++) {
  total++;
  if (!stock.copper[i]) removed++;
  if (stock.depth[i] > maxD) maxD = stock.depth[i];
}
const avgW = widthSum / Math.max(1, cuts);
const expect = vbitEffectiveDiameter(tip, angle, 0.0933);

console.log(`Applied ${cuts} cut stamps in ${ms} ms`);
console.log(`Grid ${stock.cols}x${stock.rows}, copper removed ${(100 * removed / total).toFixed(2)}%`);
console.log(`Max depth ${maxD.toFixed(4)} mm`);
console.log(`Avg groove width ${avgW.toFixed(4)} mm (formula expect ${expect.toFixed(4)} mm)`);

if (cuts < 100) { console.error('FAIL: too few cuts'); process.exit(1); }
if (removed < 100) { console.error('FAIL: no copper removed'); process.exit(1); }
if (Math.abs(avgW - expect) > 0.01) { console.error('FAIL: groove width mismatch'); process.exit(1); }
console.log('OK: sample isolation simulation');
