/**
 * Binary mask → smooth closed outlines (image pixel coordinates).
 * Marching squares on pixel centers, then straight runs are simplified,
 * sharp corners are kept, and gentle bends are smoothed into curves.
 */

export type Pt = { x: number; y: number };

export interface MaskOutline {
  outer: Pt[];
  holes: Pt[][];
}

export interface OutlineOptions {
  /** Max deviation (px) when straightening pixel staircases into lines. */
  simplifyPx: number;
  /** Turn angle (deg) at or above which a vertex is a hard corner. */
  cornerDeg: number;
  /** Corner-preserving Chaikin passes on curved runs. */
  smoothPasses: number;
  /** Max distance (px) a snapped corner may move from the pixel outline. 0 = no snapping. */
  snapCornerPx: number;
  /** Edges shorter than this (px) count as a pixel-corner run to snap. */
  snapRunPx: number;
  /** Max deviation (px) of removed run points from the snapped corner. */
  snapDeviationPx: number;
  /** A big bend next to an edge shorter than this (px) that keeps bending is a curve. */
  curveEdgePx: number;
  /** Vertex between two edges at least this long (px) stays sharp at any angle. */
  pinEdgePx: number;
  /** Edges within this angle (deg) of horizontal / vertical snap to the axis. */
  straightenDeg: number;
  /** Height (px) of 1 px antialias jogs flattened along flat sides. 0 = off. */
  jogBandPx: number;
  /** Minimum length (px) of a flat side before jogs on it are flattened. */
  jogMinSpanPx: number;
}

export const DEFAULT_OUTLINE_OPTIONS: OutlineOptions = {
  simplifyPx: 0.75,
  cornerDeg: 50,
  smoothPasses: 2,
  snapCornerPx: 2.6,
  snapRunPx: 6,
  snapDeviationPx: 1.1,
  curveEdgePx: 12,
  pinEdgePx: 15,
  straightenDeg: 4,
  jogBandPx: 1.3,
  jogMinSpanPx: 10,
};

export function traceMaskOutlines(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  options: Partial<OutlineOptions> = {}
): MaskOutline[] {
  const o: OutlineOptions = { ...DEFAULT_OUTLINE_OPTIONS, ...options };

  const loops = marchingSquares(mask, width, height, bbox);
  const cleaned: Pt[][] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    let pts = simplifyClosed(loop, o.simplifyPx);
    if (pts.length < 3) continue;
    pts = straightenAxes(pts, o);
    const snapped = new Set<Pt>();
    if (o.snapCornerPx > 0) pts = sharpenCorners(pts, o, snapped);
    if (pts.length < 3) continue;
    pts = smoothClosed(pts, o, snapped);
    if (pts.length < 3 || Math.abs(signedArea(pts)) < 0.5) continue;
    cleaned.push(pts);
  }
  return nestLoops(cleaned);
}

/** Loops around mask pixels (value at pixel centers, iso 0.5). */
function marchingSquares(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
): Pt[][] {
  // Cells span pixel centers; one extra ring so loops close outside the bbox.
  const x0 = bbox.minX - 1;
  const y0 = bbox.minY - 1;
  const x1 = bbox.maxX + 1;
  const y1 = bbox.maxY + 1;
  const cw = x1 - x0;
  const ch = y1 - y0;
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] ? 1 : 0;

  // Edge ids: horizontal edge (between (x,y) and (x+1,y)) and vertical edge.
  const hId = (cx: number, cy: number) => cy * (cw + 1) + cx;
  const vBase = (cw + 1) * (ch + 1);
  const vId = (cx: number, cy: number) => vBase + cy * (cw + 1) + cx;

  const pointOf = new Map<number, Pt>();
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };

  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const px = x0 + cx;
      const py = y0 + cy;
      const tl = at(px, py);
      const tr = at(px + 1, py);
      const br = at(px + 1, py + 1);
      const bl = at(px, py + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      // Edge midpoints in pixel-center space (+0.5 → image coordinates).
      const top = hId(cx, cy);
      const bottom = hId(cx, cy + 1);
      const left = vId(cx, cy);
      const right = vId(cx + 1, cy);
      if (!pointOf.has(top)) pointOf.set(top, { x: px + 1, y: py + 0.5 });
      if (!pointOf.has(bottom)) pointOf.set(bottom, { x: px + 1, y: py + 1.5 });
      if (!pointOf.has(left)) pointOf.set(left, { x: px + 0.5, y: py + 1 });
      if (!pointOf.has(right)) pointOf.set(right, { x: px + 1.5, y: py + 1 });

      switch (code) {
        case 1:
        case 14:
          link(left, bottom);
          break;
        case 2:
        case 13:
          link(bottom, right);
          break;
        case 3:
        case 12:
          link(left, right);
          break;
        case 4:
        case 11:
          link(top, right);
          break;
        case 6:
        case 9:
          link(top, bottom);
          break;
        case 7:
        case 8:
          link(left, top);
          break;
        case 5:
          // Diagonal pixels (tr, bl) — keep them separate (4-connected parts).
          link(top, right);
          link(left, bottom);
          break;
        case 10:
          link(left, top);
          link(bottom, right);
          break;
      }
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const loops: Pt[][] = [];
  for (const [start, nbs] of links) {
    for (const first of nbs) {
      if (used.has(edgeKey(start, first))) continue;
      const loop: Pt[] = [pointOf.get(start)!];
      used.add(edgeKey(start, first));
      let prev = start;
      let cur = first;
      let guard = 0;
      while (cur !== start && guard++ < 1e6) {
        loop.push(pointOf.get(cur)!);
        const next = (links.get(cur) ?? []).find(
          (n) => n !== prev && !used.has(edgeKey(cur, n))
        ) ?? (links.get(cur) ?? []).find((n) => !used.has(edgeKey(cur, n)));
        if (next === undefined) break;
        used.add(edgeKey(cur, next));
        prev = cur;
        cur = next;
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Straighten staircase runs. Splits the loop at its two farthest points. */
function simplifyClosed(loop: Pt[], eps: number): Pt[] {
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  const p0 = loop[0];
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i].x - p0.x) ** 2 + (loop[i].y - p0.y) ** 2;
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i].x - loop[i1].x) ** 2 + (loop[i].y - loop[i1].y) ** 2;
    if (d > best) {
      best = d;
      i0 = i;
    }
  }
  const n = loop.length;
  const rot = loop.slice(i0).concat(loop.slice(0, i0));
  const split = (i1 - i0 + n) % n;
  const a = rdp(rot.slice(0, split + 1), eps);
  const b = rdp(rot.slice(split).concat([rot[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * A run of vertices inside a thin horizontal / vertical band (1 px
 * antialias jogs along a flat side) becomes one straight edge.
 */
function flattenJogs(pts: Pt[], o: OutlineOptions): Pt[] {
  const BAND = o.jogBandPx;
  const MIN_SPAN = o.jogMinSpanPx;
  if (BAND <= 0) return pts;
  let cur = pts;
  for (const axis of ['y', 'x'] as const) {
    const along = axis === 'y' ? 'x' : 'y';
    const n = cur.length;
    if (n < 4) return cur;
    let start = 0;
    let bestTurn = -1;
    for (let i = 0; i < n; i++) {
      const t = turnDeg(cur[(i - 1 + n) % n], cur[i], cur[(i + 1) % n]);
      if (t > bestTurn) {
        bestTurn = t;
        start = i;
      }
    }
    const rot = cur.slice(start).concat(cur.slice(0, start));
    const out: Pt[] = [];
    let i = 0;
    while (i < n) {
      let lo = rot[i][axis];
      let hi = lo;
      let dir = 0;
      let j = i;
      while (j + 1 < n) {
        const q = rot[j + 1];
        const nlo = Math.min(lo, q[axis]);
        const nhi = Math.max(hi, q[axis]);
        const d = Math.sign(q[along] - rot[j][along]);
        if (nhi - nlo > BAND || (dir !== 0 && d !== 0 && d !== dir)) break;
        if (d !== 0) dir = d;
        lo = nlo;
        hi = nhi;
        j++;
      }
      const span = Math.abs(rot[j][along] - rot[i][along]);
      if (j - i >= 2 && span >= MIN_SPAN) {
        let sum = 0;
        let wsum = 0;
        for (let k = i; k < j; k++) {
          const w = Math.abs(rot[k + 1][along] - rot[k][along]);
          sum += ((rot[k][axis] + rot[k + 1][axis]) / 2) * w;
          wsum += w;
        }
        const v = wsum > 0 ? sum / wsum : (lo + hi) / 2;
        out.push({ ...rot[i], [axis]: v } as Pt, { ...rot[j], [axis]: v } as Pt);
        i = j + 1;
      } else {
        out.push(rot[i]);
        i++;
      }
    }
    cur = out;
  }
  return cur;
}

/** Nearly horizontal / vertical straight edges snap exactly to the axis. */
function straightenAxes(pts: Pt[], o: OutlineOptions): Pt[] {
  const MIN_LEN = 5;
  const MAX_SLOPE = Math.tan((o.straightenDeg * Math.PI) / 180);
  const out = flattenJogs(pts, o).map((p) => ({ x: p.x, y: p.y }));
  if (o.straightenDeg <= 0) return out;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const p = out[i];
    const q = out[(i + 1) % n];
    const dx = Math.abs(q.x - p.x);
    const dy = Math.abs(q.y - p.y);
    if (Math.hypot(dx, dy) < MIN_LEN) continue;
    if (dy <= dx * MAX_SLOPE) {
      const y = (p.y + q.y) / 2;
      p.y = y;
      q.y = y;
    } else if (dx <= dy * MAX_SLOPE) {
      const x = (p.x + q.x) / 2;
      p.x = x;
      q.x = x;
    }
  }
  return out;
}

function lineIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Pixel corners land as a few short segments between two long straight
 * edges. Replace that run with the true intersection of the two edges
 * (X tips, stroke ends, chevrons). Wide-radius rounds stay curves.
 */
function sharpenCorners(pts: Pt[], o: OutlineOptions, snapped: Set<Pt>): Pt[] {
  const cornerDeg = o.cornerDeg;
  const minTurnDeg = cornerDeg * 0.7;
  const LONG = o.snapRunPx;
  const MAX_RUN = 4;
  const MAX_DIST = o.snapCornerPx;
  const MAX_DEV = o.snapDeviationPx;
  let cur = pts;
  for (let iter = 0; iter < 4; iter++) {
    const n = cur.length;
    if (n < 4) return cur;
    const len = (i: number) => {
      const p = cur[i % n];
      const q = cur[(i + 1) % n];
      return Math.hypot(q.x - p.x, q.y - p.y);
    };
    const isLong = cur.map((_, i) => len(i) >= LONG);
    const longIdx = isLong.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
    if (longIdx.length < 2) return cur;

    const replace = new Map<number, { end: number; p: Pt }>();
    const removed = new Set<number>();
    for (let k = 0; k < longIdx.length; k++) {
      const e0 = longIdx[k];
      const e1 = longIdx[(k + 1) % longIdx.length];
      const gap = (e1 - e0 - 1 + n) % n;
      if (gap < 1 || gap > MAX_RUN) continue;
      const a = cur[e0];
      const b = cur[(e0 + 1) % n];
      const c = cur[e1];
      const d = cur[(e1 + 1) % n];
      if (angleBetween(b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y) < minTurnDeg) continue;
      // Curve continues past a shortish neighbour edge → tight round, keep it.
      const dir = Math.sign((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x));
      // (A short edge beyond that vertex means another pixel corner, not a curve.)
      const keepsBending = (p0: Pt, p1: Pt, p2: Pt, edgeLen: number, beyondLen: number) => {
        const t = signedTurnDeg(p0, p1, p2);
        return (
          edgeLen < o.curveEdgePx &&
          beyondLen >= LONG &&
          Math.sign(t) === dir &&
          Math.abs(t) >= 8 &&
          Math.abs(t) < cornerDeg
        );
      };
      if (
        keepsBending(cur[(e0 - 1 + n) % n], a, b, len(e0), len(e0 - 1 + n)) ||
        keepsBending(c, d, cur[(e1 + 2) % n], len(e1), len(e1 + 1))
      ) {
        continue;
      }
      const x = lineIntersect(a, b, c, d);
      if (!x) continue;
      // Run vertices b … c (indices e0+1 … e1) must all hug the new corner,
      // otherwise this is a real feature (A legs, small serifs).
      let near = Infinity;
      let far = 0;
      for (let j = 1; j <= gap + 1; j++) {
        const v = cur[(e0 + j) % n];
        near = Math.min(near, Math.hypot(v.x - x.x, v.y - x.y));
        far = Math.max(far, Math.min(distToSegment(v, b, x), distToSegment(v, x, c)));
      }
      if (near > MAX_DIST || far > MAX_DEV) continue;
      const start = (e0 + 1) % n;
      replace.set(start, { end: e1 % n, p: x });
      snapped.add(x);
      for (let j = 2; j <= gap + 1; j++) removed.add((e0 + j) % n);
    }
    if (replace.size === 0) return cur;
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      if (removed.has(i) && !replace.has(i)) continue;
      const r = replace.get(i);
      out.push(r ? r.p : cur[i]);
    }
    cur = out;
  }
  return cur;
}

function signedTurnDeg(prev: Pt, p: Pt, next: Pt): number {
  const cross = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
  return turnDeg(prev, p, next) * (cross < 0 ? -1 : 1);
}

function turnDeg(prev: Pt, p: Pt, next: Pt): number {
  const ax = p.x - prev.x;
  const ay = p.y - prev.y;
  const bx = next.x - p.x;
  const by = next.y - p.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Corner-preserving Chaikin: hard corners stay sharp, long straight edges
 * stay straight, short bent runs become smooth curves.
 */
function smoothClosed(pts: Pt[], o: OutlineOptions, snapped: Set<Pt> = new Set()): Pt[] {
  const cornerDeg = o.cornerDeg;
  const passes = Math.round(o.smoothPasses);
  // Where two long straight edges meet is a real corner at any angle.
  const fixed = new Set<Pt>();
  {
    const n = pts.length;
    const len = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
    const signed = pts.map((p, i) => signedTurnDeg(pts[(i - 1 + n) % n], p, pts[(i + 1) % n]));
    // A big turn whose short neighbour keeps bending the same way (but is
    // not a corner itself) is part of a tight curve, not a corner.
    const onCurve = (i: number) => {
      const s = signed[i];
      for (const j of [(i - 1 + n) % n, (i + 1) % n]) {
        const edge = len(pts[i], pts[j]);
        const t = signed[j];
        if (edge < o.curveEdgePx && Math.sign(t) === Math.sign(s) && Math.abs(t) >= 8 && Math.abs(t) < cornerDeg) return true;
      }
      return false;
    };
    pts.forEach((p, i) => {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      const turn = Math.abs(signed[i]);
      if (
        snapped.has(p) ||
        (turn >= cornerDeg && !onCurve(i)) ||
        (turn >= 12 && len(prev, p) >= o.pinEdgePx && len(p, next) >= o.pinEdgePx)
      ) {
        fixed.add(p);
      }
    });
  }
  let cur = pts;
  for (let pass = 0; pass < passes; pass++) {
    const n = cur.length;
    const corner = cur.map((p) => fixed.has(p));
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const p = cur[i];
      const q = cur[(i + 1) % n];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (corner[i]) out.push(p);
      // Long edges are true straight lines: keep their ends tight.
      const t = len > 6 ? Math.min(0.25, 1.5 / len) : 0.25;
      if (!corner[i]) out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      if (!corner[(i + 1) % n]) out.push({ x: p.x + (q.x - p.x) * (1 - t), y: p.y + (q.y - p.y) * (1 - t) });
    }
    cur = out;
  }
  return cur;
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Even nesting depth = solid outline, odd = hole of its nearest container. */
function nestLoops(loops: Pt[][]): MaskOutline[] {
  const areas = loops.map((l) => Math.abs(signedArea(l)));
  const order = loops.map((_, i) => i).sort((a, b) => areas[b] - areas[a]);
  const parent = new Array<number>(loops.length).fill(-1);
  const depth = new Array<number>(loops.length).fill(0);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const probe = loops[i][0];
    for (let m = k - 1; m >= 0; m--) {
      const j = order[m];
      if (pointInPoly(probe, loops[j])) {
        parent[i] = j;
        depth[i] = depth[j] + 1;
        break;
      }
    }
  }
  const outlines = new Map<number, MaskOutline>();
  for (const i of order) {
    if (depth[i] % 2 === 0) outlines.set(i, { outer: loops[i], holes: [] });
  }
  for (const i of order) {
    if (depth[i] % 2 === 1 && outlines.has(parent[i])) outlines.get(parent[i])!.holes.push(loops[i]);
  }
  return [...outlines.values()];
}
