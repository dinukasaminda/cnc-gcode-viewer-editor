import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MeshViewer3D,
  type MeasureOverlayLine,
  type PartClickEvent,
  type SurfaceHitEvent,
} from '../components/MeshViewer3D';
import { NumberInput } from '../components/NumberInput';
import { PerfboardMap } from '../components/PerfboardMap';
import { disposeExtruded, type ExtrudedPart } from '../core/imageExtrude';
import { formatNum } from '../core/format';
import {
  DEFAULT_PERF_SPEC,
  MAX_DOTS,
  REF_SQUARE_MM,
  boardSizeMm,
  buildPerfBoardPart,
  buildPerfFeaturePart,
  featureKindLabel,
  featuresAtHole,
  isSolidFeature,
  holeDistanceMm,
  holeSpanMm,
  holeXY,
  holesInSquare,
  newFeatureId,
  snapWorldToHole,
  specCacheKey,
  type GridPt,
  type PerfDrawTool,
  type PerfFeature,
  type PerfboardSpec,
} from '../core/perfboard';
import { download3mf, exportGeometriesTo3mf } from '../core/threemf';
import '../App.css';

function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export default function Perfboard() {
  const [spec, setSpec] = useState<PerfboardSpec>(DEFAULT_PERF_SPEC);
  const [features, setFeatures] = useState<PerfFeature[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<PerfDrawTool>('select');
  const [pending, setPending] = useState<GridPt | null>(null);
  const [measure, setMeasure] = useState<GridPt[]>([]);
  const [hover, setHover] = useState<GridPt | null>(null);
  const [parts, setParts] = useState<ExtrudedPart[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [bedColor, setBedColor] = useState<'yellow' | 'white' | 'black'>('yellow');
  const [leftWidth, setLeftWidth] = useState(340);
  const [status, setStatus] = useState(
    `Select: click a pin, pad, rectangle, or measurement in the list, map, or 3D (Shift to add)`
  );
  const resizeDrag = useRef<{ x: number; w: number } | null>(null);
  const captureTopViewRef = useRef<(() => string | null) | null>(null);
  const camKey = useRef({ cols: 0, rows: 0, pitch: 0 });
  const boardPartRef = useRef<ExtrudedPart | null>(null);
  const boardKeyRef = useRef('');
  const featurePartsRef = useRef<ExtrudedPart[]>([]);

  const span = useMemo(() => holeSpanMm(spec), [spec]);
  const board = useMemo(() => boardSizeMm(spec), [spec]);
  const in5cm = useMemo(() => holesInSquare(spec, REF_SQUARE_MM), [spec]);
  const solids = useMemo(() => features.filter(isSolidFeature), [features]);
  const measures = useMemo(
    () => features.filter((f): f is Extract<PerfFeature, { kind: 'measure' }> => f.kind === 'measure'),
    [features]
  );
  const holeDist = useMemo(() => {
    if (tool === 'measure' && pending) {
      return holeDistanceMm(spec, pending, hover ?? pending);
    }
    if (measure.length >= 2) return holeDistanceMm(spec, measure[0], measure[1]);
    const selected = measures.filter((f) => selectedIds.includes(f.id));
    if (selected.length === 1) return holeDistanceMm(spec, selected[0].a, selected[0].b);
    return 0;
  }, [spec, tool, pending, hover, measure, measures, selectedIds]);

  const autoFeatureLabel = useCallback(
    (f: PerfFeature) => {
      if (f.kind !== 'measure') return featureKindLabel(f);
      const d = holeDistanceMm(spec, f.a, f.b);
      return `${featureKindLabel(f)} · ${formatNum(d)} mm`;
    },
    [spec]
  );
  const describeFeature = useCallback(
    (f: PerfFeature) => {
      const n = f.name?.trim();
      const auto = autoFeatureLabel(f);
      return n ? `${n} · ${auto}` : auto;
    },
    [autoFeatureLabel]
  );
  const selectedOne = selectedIds.length === 1 ? (features.find((f) => f.id === selectedIds[0]) ?? null) : null;

  const setFeatureName = (id: string, name: string) => {
    setFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  };

  useEffect(() => {
    const key = specCacheKey(spec);
    if (!boardPartRef.current || boardKeyRef.current !== key) {
      if (boardPartRef.current) disposeExtruded([boardPartRef.current]);
      boardPartRef.current = buildPerfBoardPart(spec);
      boardKeyRef.current = key;
    }
    disposeExtruded(featurePartsRef.current);
    const featureParts = solids.map((f) => buildPerfFeaturePart(spec, f));
    featurePartsRef.current = featureParts;
    setParts([boardPartRef.current, ...featureParts]);
    const cam = camKey.current;
    if (cam.cols !== spec.cols || cam.rows !== spec.rows || cam.pitch !== spec.pitchMm) {
      cam.cols = spec.cols;
      cam.rows = spec.rows;
      cam.pitch = spec.pitchMm;
      setResetKey((k) => k + 1);
    }
  }, [spec, solids]);

  useEffect(() => {
    return () => {
      disposeExtruded(boardPartRef.current ? [boardPartRef.current] : []);
      disposeExtruded(featurePartsRef.current);
      boardPartRef.current = null;
      featurePartsRef.current = [];
    };
  }, []);

  const setHoverHole = useCallback((pt: GridPt | null) => {
    setHover((prev) => {
      if (!pt && !prev) return prev;
      if (pt && prev && pt.c === prev.c && pt.r === prev.r) return prev;
      return pt;
    });
  }, []);

  const toggleSelect = useCallback((id: string, additive: boolean) => {
    if (id === 'pf-board' || id === 'bed') return;
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      }
      return prev.length === 1 && prev[0] === id ? [] : [id];
    });
  }, []);

  const onHole = useCallback(
    (pt: GridPt, additive = false) => {
      if (tool === 'select' || tool === 'off') {
        const hits = featuresAtHole(features, pt);
        if (hits.length) {
          const last = hits[hits.length - 1];
          toggleSelect(last.id, additive);
          setStatus(`Selected ${describeFeature(last)}`);
          return;
        }
        if (!additive) setSelectedIds([]);
        const p = holeXY(spec, pt.c, pt.r);
        setStatus(`Hole ${pt.c + 1},${pt.r + 1} · x ${formatNum(p.x)} mm · y ${formatNum(p.y)} mm`);
        return;
      }
      if (tool === 'pin') {
        const i = features.findIndex((f) => f.kind === 'pin' && f.at.c === pt.c && f.at.r === pt.r);
        if (i >= 0) {
          const gone = features[i].id;
          setFeatures((prev) => prev.filter((f) => f.id !== gone));
          setSelectedIds((ids) => ids.filter((id) => id !== gone));
          setStatus(`Removed pin at ${pt.c + 1},${pt.r + 1}`);
          return;
        }
        const next = { id: newFeatureId('pin'), kind: 'pin' as const, at: pt };
        setFeatures((prev) => [...prev, next]);
        setSelectedIds([next.id]);
        setStatus(`Pin at ${pt.c + 1},${pt.r + 1}`);
        return;
      }
      if (tool === 'pinHole') {
        const i = features.findIndex((f) => f.kind === 'pinHole' && f.at.c === pt.c && f.at.r === pt.r);
        if (i >= 0) {
          const gone = features[i].id;
          setFeatures((prev) => prev.filter((f) => f.id !== gone));
          setSelectedIds((ids) => ids.filter((id) => id !== gone));
          setStatus(`Removed pin hole at ${pt.c + 1},${pt.r + 1}`);
          return;
        }
        const next = { id: newFeatureId('pinHole'), kind: 'pinHole' as const, at: pt };
        setFeatures((prev) => [...prev, next]);
        setSelectedIds([next.id]);
        setStatus(`Pin hole at ${pt.c + 1},${pt.r + 1}`);
        return;
      }
      if (tool === 'rect') {
        if (!pending) {
          setPending(pt);
          setHoverHole(pt);
          setStatus(`Rectangle started at ${pt.c + 1},${pt.r + 1} — hover and click the opposite corner`);
          return;
        }
        const next = { id: newFeatureId('rect'), kind: 'rect' as const, a: pending, b: pt };
        setFeatures((prev) => [...prev, next]);
        setSelectedIds([next.id]);
        setPending(null);
        setStatus(`Rectangle (${pending.c + 1},${pending.r + 1})–(${pt.c + 1},${pt.r + 1})`);
        return;
      }
      if (tool === 'measure') {
        if (!pending) {
          setPending(pt);
          setMeasure([pt]);
          setHoverHole(pt);
          setStatus(
            `Measure started at hole centre ${pt.c + 1},${pt.r + 1} — hover and click the second hole`
          );
          return;
        }
        const next = { id: newFeatureId('measure'), kind: 'measure' as const, a: pending, b: pt };
        setFeatures((prev) => [...prev, next]);
        setSelectedIds([next.id]);
        setMeasure([]);
        setPending(null);
        setStatus(`Added ${describeFeature(next)}`);
      }
    },
    [tool, pending, spec, features, toggleSelect, describeFeature, setHoverHole]
  );

  const onSurfaceHit = useCallback(
    (ev: SurfaceHitEvent) => {
      if (tool === 'select' || tool === 'off') return;
      const hole = snapWorldToHole(spec, ev.point.x, ev.point.y);
      if (hole) onHole(hole);
    },
    [tool, spec, onHole]
  );

  const onSurfaceMove = useCallback(
    (ev: SurfaceHitEvent | null) => {
      if (tool === 'select' || tool === 'off') return;
      if (!ev) {
        setHoverHole(null);
        return;
      }
      setHoverHole(snapWorldToHole(spec, ev.point.x, ev.point.y, spec.pitchMm * 0.7));
    },
    [tool, spec, setHoverHole]
  );

  const onPartClick = useCallback(
    (ev: PartClickEvent) => {
      if (tool !== 'select' && tool !== 'off') return;
      if (ev.partId === 'pf-board' || ev.partId === 'bed') {
        if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) setSelectedIds([]);
        return;
      }
      toggleSelect(ev.partId, ev.shiftKey || ev.metaKey || ev.ctrlKey);
      const f = features.find((x) => x.id === ev.partId);
      setStatus(f ? `Selected ${describeFeature(f)}` : `Selected ${ev.partId}`);
    },
    [tool, features, toggleSelect, describeFeature]
  );

  const setDrawTool = (next: PerfDrawTool) => {
    setPending(null);
    if (next !== 'measure') setMeasure([]);
    setTool((prev) => (prev === next ? 'select' : next));
    const labels: Record<PerfDrawTool, string> = {
      off: 'Click a hole to read coordinates',
      select: 'Select: click a pin, pad, rectangle, or measurement in the list, map, or 3D (Shift to add)',
      rect: 'Draw rectangle: click first corner, then hover to the opposite hole',
      pin: 'Add pin: click a hole (again to remove)',
      pinHole: 'Add pin hole pad: click a hole (again to remove)',
      measure: 'Measure: click two hole centres — distance is centre-to-centre',
    };
    setStatus(labels[next === tool ? 'select' : next]);
  };

  const clearSelected = () => {
    if (selectedIds.length === 0) return;
    const gone = new Set(selectedIds);
    setFeatures((prev) => prev.filter((f) => !gone.has(f.id)));
    setSelectedIds([]);
    setStatus(`Cleared ${gone.size} selected item(s)`);
  };

  const clearAll = () => {
    const n = features.length;
    setFeatures([]);
    setSelectedIds([]);
    setPending(null);
    setMeasure([]);
    setStatus(n ? `Cleared all ${n} item(s)` : 'Nothing to clear');
  };

  const selectAll = () => {
    const ids = features.map((f) => f.id);
    setSelectedIds(ids);
    setStatus(ids.length ? `Selected all ${ids.length} item(s)` : 'No items to select');
  };

  const resetBoard = () => {
    setSpec(DEFAULT_PERF_SPEC);
    setFeatures([]);
    setSelectedIds([]);
    setPending(null);
    setMeasure([]);
    setTool('select');
    setStatus(
      `Reset ${DEFAULT_PERF_SPEC.cols}×${DEFAULT_PERF_SPEC.rows} · pitch ${formatNum(DEFAULT_PERF_SPEC.pitchMm)} mm`
    );
  };

  const export3mf = () => {
    if (parts.length === 0) return;
    try {
      const data = exportGeometriesTo3mf(
        parts.map((p) => ({ name: p.name, geometry: p.geometry })),
        'perfboard'
      );
      download3mf(data, `perfboard_${spec.cols}x${spec.rows}.3mf`);
      setStatus(`Exported ${parts.length} parts → perfboard_${spec.cols}x${spec.rows}.3mf`);
    } catch (err) {
      setStatus(`Export error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveFootprint = () => {
    try {
      const dataUrl = captureTopViewRef.current?.();
      if (!dataUrl) {
        setStatus('Footprint: 3D view is not ready yet');
        return;
      }
      const name = `perfboard_${spec.cols}x${spec.rows}_footprint.png`;
      downloadDataUrl(dataUrl, name);
      setStatus(`Saved top view footprint → ${name}`);
    } catch (err) {
      setStatus(`Footprint error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const viewerParts = useMemo(
    () =>
      parts.map((p) => ({
        id: p.id,
        geometry: p.geometry,
        color: selectedIds.includes(p.id) && p.id !== 'pf-board' ? 0x22c55e : p.color,
      })),
    [parts, selectedIds]
  );
  const measureOverlays = useMemo(() => {
    const z = spec.thicknessMm + 0.35;
    const holeLine = (a: GridPt, b: GridPt, color: number, withLabel: boolean) => {
      const pa = holeXY(spec, a.c, a.r);
      const pb = holeXY(spec, b.c, b.r);
      return {
        a: { x: pa.x, y: pa.y, z },
        b: { x: pb.x, y: pb.y, z },
        color,
        label: withLabel ? `${formatNum(holeDistanceMm(spec, a, b))} mm` : undefined,
      };
    };
    const lines: MeasureOverlayLine[] = measures.map((f) =>
      holeLine(f.a, f.b, selectedIds.includes(f.id) ? 0x22c55e : 0x38bdf8, true)
    );
    if (tool === 'measure' && pending) {
      const other = hover ?? pending;
      if (other.c !== pending.c || other.r !== pending.r) {
        lines.push(holeLine(pending, other, 0xf43f5e, true));
      }
    }
    if (tool === 'rect' && pending) {
      const other = hover ?? pending;
      const c0 = Math.min(pending.c, other.c);
      const c1 = Math.max(pending.c, other.c);
      const r0 = Math.min(pending.r, other.r);
      const r1 = Math.max(pending.r, other.r);
      const p0 = holeXY(spec, c0, r0);
      const p1 = holeXY(spec, c1, r1);
      const m = spec.pitchMm * 0.4;
      const minX = Math.min(p0.x, p1.x) - m;
      const maxX = Math.max(p0.x, p1.x) + m;
      const minY = Math.min(p0.y, p1.y) - m;
      const maxY = Math.max(p0.y, p1.y) + m;
      const zTop = z + 0.25;
      const bl = { x: minX, y: minY, z: zTop };
      const br = { x: maxX, y: minY, z: zTop };
      const tr = { x: maxX, y: maxY, z: zTop };
      const tl = { x: minX, y: maxY, z: zTop };
      const color = 0x7dd3fc;
      lines.push({ a: bl, b: br, color }, { a: br, b: tr, color }, { a: tr, b: tl, color }, { a: tl, b: bl, color });
    }
    return lines;
  }, [measures, spec, selectedIds, tool, pending, hover]);
  const rectDraft =
    tool === 'rect' && pending
      ? {
          cols: Math.abs((hover ?? pending).c - pending.c) + 1,
          rows: Math.abs((hover ?? pending).r - pending.r) + 1,
          end: hover ?? pending,
        }
      : null;
  const totalTris = parts.reduce((s, p) => s + p.triangleCount, 0);

  return (
    <div className="app tool-perfboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PB</span>
          <div>
            <h1>Perfboard</h1>
            <p>2.54 mm dot map · measure · pins · 3MF</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => setResetKey((k) => k + 1)}>
            Reset camera
          </button>
          <button type="button" onClick={saveFootprint} disabled={parts.length === 0} title="Download an orthographic top-view PNG">
            Save footprint
          </button>
          <button type="button" className="primary" onClick={export3mf} disabled={parts.length === 0}>
            Export .3mf
          </button>
        </div>
      </header>

      <div
        className="workspace workspace-perfboard"
        style={{ gridTemplateColumns: `${leftWidth}px 6px 1fr minmax(220px, 15vw)` }}
      >
        <aside className="panel left">
          <section>
            <h2>Grid</h2>
            <p className="muted tiny">Standard 2.54 mm (0.1″) pitch. Count the holes on the physical board.</p>
            <div className="perf-dot-row">
              <label>
                Dots X
                <NumberInput
                  step={1}
                  min={2}
                  max={MAX_DOTS}
                  value={spec.cols}
                  onChange={(n) => setSpec((s) => ({ ...s, cols: n }))}
                />
              </label>
              <label>
                Dots Y
                <NumberInput
                  step={1}
                  min={2}
                  max={MAX_DOTS}
                  value={spec.rows}
                  onChange={(n) => setSpec((s) => ({ ...s, rows: n }))}
                />
              </label>
            </div>
            <label>
              Pitch (mm)
              <NumberInput
                step={0.01}
                min={0.5}
                max={10}
                value={spec.pitchMm}
                onChange={(n) => setSpec((s) => ({ ...s, pitchMm: n }))}
              />
            </label>
            <div className="perf-dot-row">
              <label>
                Hole Ø (mm)
                <NumberInput
                  step={0.05}
                  min={0.2}
                  max={3}
                  value={spec.holeDiaMm}
                  onChange={(n) => setSpec((s) => ({ ...s, holeDiaMm: n }))}
                />
              </label>
              <label>
                Thickness (mm)
                <NumberInput
                  step={0.1}
                  min={0.4}
                  max={4}
                  value={spec.thicknessMm}
                  onChange={(n) => setSpec((s) => ({ ...s, thicknessMm: n }))}
                />
              </label>
            </div>
            <p className="muted tiny mono">
              Span {formatNum(span.widthMm)} × {formatNum(span.heightMm)} mm · board {formatNum(board.widthMm)} ×{' '}
              {formatNum(board.heightMm)} mm
            </p>
            <p className="muted tiny mono perf-5cm-readout">
              {`5 cm × 5 cm (${REF_SQUARE_MM} mm): ${in5cm.colsFit} × ${in5cm.rowsFit} holes (${in5cm.totalFit.toLocaleString()}) · span ${formatNum(in5cm.spanMm)} mm`}
              {in5cm.allFit
                ? ` · this board ${in5cm.boardCols} × ${in5cm.boardRows} — all ${in5cm.boardTotal} fit`
                : ` · this board ${in5cm.boardCols} × ${in5cm.boardRows} — ${in5cm.onBoardCols} × ${in5cm.onBoardRows} (${in5cm.onBoardTotal.toLocaleString()}) in 5 cm`}
            </p>
            <div className="row-actions">
              <button type="button" onClick={resetBoard}>
                Reset board
              </button>
            </div>
          </section>

          <section>
            <h2>Draw / measure</h2>
            <div className="row-actions" role="toolbar" aria-label="Perfboard draw tools">
              {(
                [
                  ['select', 'Select'],
                  ['measure', 'Measure dots'],
                  ['rect', 'Rectangle'],
                  ['pin', 'Pin'],
                  ['pinHole', 'Pin hole'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={tool === id ? 'primary' : ''}
                  onClick={() => setDrawTool(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="row-actions" role="toolbar" aria-label="Selection">
              <button type="button" disabled={features.length === 0} onClick={selectAll}>
                Select all
              </button>
              <button type="button" disabled={selectedIds.length === 0} onClick={clearSelected}>
                Clear selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
              </button>
              <button type="button" disabled={features.length === 0} onClick={clearAll}>
                Clear all
              </button>
            </div>
            <label className="perf-name-field">
              Name (optional)
              <input
                type="text"
                value={selectedOne?.name ?? ''}
                disabled={!selectedOne}
                maxLength={48}
                placeholder={selectedOne ? 'e.g. VCC, GND, USB' : 'Select an item to name'}
                onChange={(e) => selectedOne && setFeatureName(selectedOne.id, e.target.value)}
              />
            </label>
            <PerfboardMap
              spec={spec}
              features={features}
              tool={tool}
              pending={pending}
              measure={measure}
              hover={hover}
              onHover={setHoverHole}
              onHole={onHole}
              mapHeight={280}
              selectedIds={selectedIds}
            />
            <p className="muted tiny mono">
              {hover
                ? `Hole ${hover.c + 1},${hover.r + 1} · x ${formatNum(holeXY(spec, hover.c, hover.r).x)} · y ${formatNum(holeXY(spec, hover.c, hover.r).y)} mm`
                : 'Hover or click a hole'}
              {rectDraft && pending
                ? ` · rect ${pending.c + 1},${pending.r + 1} → ${rectDraft.end.c + 1},${rectDraft.end.r + 1} · ${rectDraft.cols}×${rectDraft.rows} holes`
                : ''}
              {holeDist > 0 ? ` · ${formatNum(holeDist)} mm` : ''}
            </p>
            {(
              [
                ['Items', solids],
                ['Measurements', [...measures].reverse()],
              ] as const
            ).map(([heading, items]) =>
              items.length === 0 ? null : (
                <div key={heading}>
                  <p className="muted tiny perf-list-heading">
                    {heading} ({items.length})
                  </p>
                  <ul className="perf-feature-list">
                    {items.map((f) => (
                      <li
                        key={f.id}
                        className={selectedIds.includes(f.id) ? 'selected' : ''}
                        onClick={(e) => {
                          toggleSelect(f.id, e.shiftKey || e.metaKey || e.ctrlKey);
                          setStatus(`Selected ${describeFeature(f)}`);
                        }}
                      >
                        <span className="perf-feature-copy">
                          {f.name?.trim() ? <span className="perf-feature-name">{f.name.trim()}</span> : null}
                          <span className={f.name?.trim() ? 'muted' : ''}>{autoFeatureLabel(f)}</span>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${describeFeature(f)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFeatures((prev) => prev.filter((x) => x.id !== f.id));
                            setSelectedIds((ids) => ids.filter((id) => id !== f.id));
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </section>
        </aside>

        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left panel"
          onPointerDown={(e) => {
            resizeDrag.current = { x: e.clientX, w: leftWidth };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!resizeDrag.current) return;
            const next = resizeDrag.current.w + (e.clientX - resizeDrag.current.x);
            setLeftWidth(Math.min(720, Math.max(280, next)));
          }}
          onPointerUp={() => {
            resizeDrag.current = null;
          }}
        />

        <main className="viewport-wrap">
          <div className="viewport-stage">
            <MeshViewer3D
              parts={viewerParts}
              wireframe={wireframe}
              resetKey={resetKey}
              pickEnabled
              measureMode={tool === 'select' || tool === 'off' ? 'off' : 'line'}
              measurePoints={
                tool === 'rect' && pending
                  ? [pending, hover ?? pending].map((h) => {
                      const p = holeXY(spec, h.c, h.r);
                      return { x: p.x, y: p.y, z: spec.thicknessMm + 0.25 };
                    })
                  : tool === 'measure' && pending
                    ? (() => {
                        const p = holeXY(spec, pending.c, pending.r);
                        return [{ x: p.x, y: p.y, z: spec.thicknessMm + 0.35 }];
                      })()
                    : []
              }
              measureOverlays={measureOverlays}
              upAxis="z"
              bedColor={bedColor}
              onSurfaceHit={onSurfaceHit}
              onSurfaceMove={onSurfaceMove}
              onPartClick={onPartClick}
              captureTopViewRef={captureTopViewRef}
            />
            <div className="measure-banner">
              {tool === 'select' || tool === 'off'
                ? `Select — click list, map, or 3D${selectedIds.length ? ` · ${selectedIds.length} selected` : ''}`
                : tool === 'measure'
                  ? pending
                    ? `Measure started (${pending.c + 1},${pending.r + 1})${
                        hover && (hover.c !== pending.c || hover.r !== pending.r)
                          ? ` → (${hover.c + 1},${hover.r + 1})`
                          : ''
                      } — click second hole centre`
                    : `Measure — click two hole centres (${measures.length ? `${measures.length} saved` : 'each pair is saved'})`
                  : tool === 'rect'
                    ? pending
                      ? `Rectangle started (${pending.c + 1},${pending.r + 1})${
                          rectDraft
                            ? ` → (${rectDraft.end.c + 1},${rectDraft.end.r + 1}) · ${rectDraft.cols}×${rectDraft.rows} holes`
                            : ''
                        } — click opposite corner`
                      : 'Rectangle — click first corner, then hover to the opposite hole'
                    : tool === 'pin'
                      ? 'Pin — click a hole'
                      : 'Pin hole — click a hole'}
              {holeDist > 0 ? ` · ${formatNum(holeDist)} mm` : ''}
            </div>
          </div>
        </main>

        <aside className="panel right">
          <section>
            <h2>View / export</h2>
            <p className="muted tiny">Bed (mat) color</p>
            <div className="row-actions">
              <button type="button" className={bedColor === 'yellow' ? 'primary' : ''} onClick={() => setBedColor('yellow')}>
                Yellow
              </button>
              <button type="button" className={bedColor === 'white' ? 'primary' : ''} onClick={() => setBedColor('white')}>
                White
              </button>
              <button type="button" className={bedColor === 'black' ? 'primary' : ''} onClick={() => setBedColor('black')}>
                Black
              </button>
            </div>
            <label className="check">
              <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
              Wireframe
            </label>
            <button type="button" className="wide" onClick={() => setResetKey((k) => k + 1)}>
              Reset camera
            </button>
            <button
              type="button"
              className="wide"
              disabled={parts.length === 0}
              onClick={saveFootprint}
              title="Download an orthographic top-view PNG"
            >
              Save top view as footprint
            </button>
            <button type="button" className="primary wide" disabled={parts.length === 0} onClick={export3mf}>
              Export multi-part 3MF
            </button>
            <p className="muted tiny">
              {parts.length} mesh object(s) · {formatCount(totalTris)} tris
            </p>
          </section>
          <section>
            <h2>Status</h2>
            <p className="status-text">{status}</p>
          </section>
        </aside>
      </div>

      <footer className="statusbar">
        <span>{status}</span>
        <span className="muted">
          {spec.cols}×{spec.rows} · 5 cm: {in5cm.colsFit}×{in5cm.rowsFit} holes ({in5cm.totalFit}) · hole Ø{' '}
          {formatNum(spec.holeDiaMm)} mm
        </span>
      </footer>
    </div>
  );
}
