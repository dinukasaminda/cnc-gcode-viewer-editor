import { useEffect, useRef } from 'react';
import { formatNum } from '../core/format';
import {
  REF_SQUARE_MM,
  boardSizeMm,
  holeDistanceMm,
  holeXY,
  holesInSquare,
  inGrid,
  normalizeSpec,
  type GridPt,
  type PerfDrawTool,
  type PerfFeature,
  type PerfboardSpec,
} from '../core/perfboard';

interface PerfboardMapProps {
  spec: PerfboardSpec;
  features: PerfFeature[];
  tool: PerfDrawTool;
  pending: GridPt | null;
  measure: GridPt[];
  hover: GridPt | null;
  onHover: (pt: GridPt | null) => void;
  onHole: (pt: GridPt, additive?: boolean) => void;
  mapHeight?: number;
  selectedIds?: string[];
}

function holeAt(spec: PerfboardSpec, canvas: HTMLCanvasElement, clientX: number, clientY: number): GridPt | null {
  const s = normalizeSpec(spec);
  const rect = canvas.getBoundingClientRect();
  const { widthMm, heightMm } = boardSizeMm(s);
  const pad = 10;
  const scale = Math.min((rect.width - pad * 2) / widthMm, (rect.height - pad * 2) / heightMm);
  const ox = (rect.width - widthMm * scale) / 2;
  const oy = (rect.height - heightMm * scale) / 2;
  const x = (clientX - rect.left - ox) / scale - widthMm / 2;
  const y = heightMm / 2 - (clientY - rect.top - oy) / scale;
  const p = {
    c: Math.round((x + widthMm / 2) / s.pitchMm - 0.5),
    r: Math.round((y + heightMm / 2) / s.pitchMm - 0.5),
  };
  return inGrid(s, p.c, p.r) ? p : null;
}

function toCanvas(spec: PerfboardSpec, canvas: HTMLCanvasElement, xMm: number, yMm: number): { x: number; y: number } {
  const s = normalizeSpec(spec);
  const { widthMm, heightMm } = boardSizeMm(s);
  const pad = 10;
  const scale = Math.min((canvas.width - pad * 2) / widthMm, (canvas.height - pad * 2) / heightMm);
  const ox = (canvas.width - widthMm * scale) / 2;
  const oy = (canvas.height - heightMm * scale) / 2;
  return {
    x: ox + (xMm + widthMm / 2) * scale,
    y: oy + (heightMm / 2 - yMm) * scale,
  };
}

export function PerfboardMap({
  spec,
  features,
  tool,
  pending,
  measure,
  hover,
  onHover,
  onHole,
  mapHeight = 220,
  selectedIds = [],
}: PerfboardMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const resize = () => {
      const w = parent?.clientWidth || 260;
      canvas.width = Math.max(160, Math.round(w));
      canvas.height = mapHeight;
      paint();
    };
    const paint = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const s = normalizeSpec(spec);
      ctx.fillStyle = '#1a1410';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const { widthMm, heightMm } = boardSizeMm(s);
      const pad = 10;
      const scale = Math.min((canvas.width - pad * 2) / widthMm, (canvas.height - pad * 2) / heightMm);
      const ox = (canvas.width - widthMm * scale) / 2;
      const oy = (canvas.height - heightMm * scale) / 2;
      ctx.fillStyle = '#b08968';
      ctx.fillRect(ox, oy, widthMm * scale, heightMm * scale);

      const sqInfo = holesInSquare(s, REF_SQUARE_MM);
      const blx = -widthMm / 2;
      const bly = -heightMm / 2;
      const sq0 = toCanvas(s, canvas, blx, bly + REF_SQUARE_MM);
      const sq1 = toCanvas(s, canvas, blx + REF_SQUARE_MM, bly);
      const sq = {
        x: sq0.x,
        y: sq0.y,
        w: sq1.x - sq0.x,
        h: sq1.y - sq0.y,
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, widthMm * scale, heightMm * scale);
      ctx.clip();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fillRect(sq.x, sq.y, sq.w, sq.h);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(sq.x + 0.5, sq.y + 0.5, sq.w, sq.h);
      ctx.setLineDash([]);
      ctx.restore();

      const cell = (a: GridPt, b: GridPt) => {
        const p0 = holeXY(s, Math.min(a.c, b.c), Math.min(a.r, b.r));
        const p1 = holeXY(s, Math.max(a.c, b.c), Math.max(a.r, b.r));
        const m = s.pitchMm * 0.4;
        const a0 = toCanvas(s, canvas, p0.x - m, p1.y + m);
        const a1 = toCanvas(s, canvas, p1.x + m, p0.y - m);
        return { x: a0.x, y: a0.y, w: a1.x - a0.x, h: a1.y - a0.y };
      };

      const selected = new Set(selectedIds);
      for (const f of features) {
        if (f.kind !== 'rect') continue;
        const box = cell(f.a, f.b);
        const on = selected.has(f.id);
        ctx.fillStyle = on ? 'rgba(34,197,94,0.4)' : 'rgba(196,160,53,0.55)';
        ctx.strokeStyle = on ? '#22c55e' : '#e8c547';
        ctx.lineWidth = on ? 2 : 1;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }

      for (let r = 0; r < s.rows; r++) {
        for (let c = 0; c < s.cols; c++) {
          const p = holeXY(s, c, r);
          const q = toCanvas(s, canvas, p.x, p.y);
          ctx.beginPath();
          ctx.arc(q.x, q.y, Math.max(1.6, (s.holeDiaMm / 2) * scale), 0, Math.PI * 2);
          ctx.fillStyle = '#1a1410';
          ctx.fill();
        }
      }

      for (const f of features) {
        if (f.kind !== 'pin' && f.kind !== 'pinHole') continue;
        const p = holeXY(s, f.at.c, f.at.r);
        const q = toCanvas(s, canvas, p.x, p.y);
        const on = selected.has(f.id);
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(3, 0.95 * scale), 0, Math.PI * 2);
        if (f.kind === 'pin') {
          ctx.fillStyle = on ? '#22c55e' : '#d4a017';
          ctx.fill();
        } else {
          ctx.strokeStyle = on ? '#22c55e' : '#d97706';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (on) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, Math.max(5, 1.25 * scale), 0, Math.PI * 2);
          ctx.strokeStyle = '#86efac';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      const mark = (pt: GridPt, color: string) => {
        const p = holeXY(s, pt.c, pt.r);
        const q = toCanvas(s, canvas, p.x, p.y);
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(4.5, 1.1 * scale), 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      const drawSeg = (a: GridPt, b: GridPt, color: string, width: number, dash?: number[], label?: string) => {
        const pa = toCanvas(s, canvas, holeXY(s, a.c, a.r).x, holeXY(s, a.c, a.r).y);
        const pb = toCanvas(s, canvas, holeXY(s, b.c, b.r).x, holeXY(s, b.c, b.r).y);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        if (dash) ctx.setLineDash(dash);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!label || (a.c === b.c && a.r === b.r)) return;
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.hypot(dx, dy) || 1;
        let ox = -dy / len;
        let oy = dx / len;
        if (oy < 0 || (Math.abs(oy) < 1e-6 && ox < 0)) {
          ox = -ox;
          oy = -oy;
        }
        ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(8, 16, 28, 0.82)';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(mx + ox * 12 - tw / 2 - 4, my + oy * 12 - 8, tw + 8, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, mx + ox * 12, my + oy * 12);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      };
      for (const f of features) {
        if (f.kind !== 'measure') continue;
        const on = selected.has(f.id);
        drawSeg(
          f.a,
          f.b,
          on ? '#22c55e' : '#38bdf8',
          on ? 2.5 : 1.5,
          undefined,
          `${formatNum(holeDistanceMm(s, f.a, f.b))} mm`
        );
        mark(f.a, on ? '#22c55e' : '#38bdf8');
        mark(f.b, on ? '#22c55e' : '#38bdf8');
      }
      if (tool === 'rect' && pending) {
        const other = hover ?? pending;
        const box = cell(pending, other);
        ctx.fillStyle = 'rgba(125, 211, 252, 0.32)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeStyle = '#7dd3fc';
        ctx.lineWidth = 2.25;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.setLineDash([]);
        const cols = Math.abs(other.c - pending.c) + 1;
        const rows = Math.abs(other.r - pending.r) + 1;
        ctx.fillStyle = '#e0f2fe';
        ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${cols}×${rows}`, box.x + box.w / 2, box.y + box.h / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
      if (hover) mark(hover, '#7dd3fc');
      measure.forEach((pt) => mark(pt, '#f43f5e'));
      if (pending) mark(pending, '#f472b6');
      if (tool === 'rect' && pending) {
        mark(pending, '#f472b6');
        if (hover && (hover.c !== pending.c || hover.r !== pending.r)) mark(hover, '#38bdf8');
      }
      if (tool === 'measure' && pending && hover) {
        drawSeg(
          pending,
          hover,
          '#f43f5e',
          1.5,
          [4, 3],
          `${formatNum(holeDistanceMm(s, pending, hover))} mm`
        );
      }
      if (measure.length === 2) {
        drawSeg(
          measure[0],
          measure[1],
          '#f43f5e',
          1.5,
          undefined,
          `${formatNum(holeDistanceMm(s, measure[0], measure[1]))} mm`
        );
      }

      ctx.fillStyle = '#9aa8b5';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(
        `${s.cols}×${s.rows} · 5 cm: ${sqInfo.colsFit}×${sqInfo.rowsFit} (${sqInfo.totalFit})`,
        8,
        canvas.height - 8
      );
    };
    resize();
    const ro = parent ? new ResizeObserver(resize) : null;
    if (parent && ro) ro.observe(parent);
    return () => ro?.disconnect();
  }, [spec, features, tool, pending, measure, hover, mapHeight, selectedIds]);

  return (
    <canvas
      ref={ref}
      className={`perf-map-canvas${tool === 'select' || tool === 'off' ? ' is-select' : ''}`}
      style={{ height: mapHeight }}
      title="Click a hole on the map"
      onMouseLeave={() => onHover(null)}
      onMouseMove={(e) => {
        const canvas = ref.current;
        if (!canvas) return;
        onHover(holeAt(spec, canvas, e.clientX, e.clientY));
      }}
      onClick={(e) => {
        const canvas = ref.current;
        if (!canvas) return;
        const pt = holeAt(spec, canvas, e.clientX, e.clientY);
        if (pt) onHole(pt, e.shiftKey || e.metaKey || e.ctrlKey);
      }}
    />
  );
}
