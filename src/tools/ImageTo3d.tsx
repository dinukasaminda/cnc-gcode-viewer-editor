import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MeshViewer3D,
  type MeasureMode,
  type MeasurePoint,
  type SurfaceHitEvent,
} from '../components/MeshViewer3D';
import { NumberInput } from '../components/NumberInput';
import {
  buildExtrudedParts,
  disposeExtruded,
  modelSizeMm,
  updateRegion,
  type ExtrudedPart,
  type ExtrudeSettings,
} from '../core/imageExtrude';
import { formatNum } from '../core/format';
import {
  DEFAULT_LOGO_SAMPLE,
  clearFineBackground,
  countFineBgPixels,
  DEFAULT_PART_HEIGHT_MM,
  hitTestRegion,
  loadImageElement,
  pickWandRegion,
  reapplyWandPicks,
  renderRegionPreview,
  segmentImage,
  setPartMode,
  type PartMode,
  type SegmentedImage,
  type WandBgPart,
} from '../core/imageRegions';
import { DEFAULT_OUTLINE_OPTIONS, type OutlineOptions } from '../core/maskContour';
import { download3mf, exportGeometriesTo3mf } from '../core/threemf';
import '../App.css';

const OUTLINE_SLIDERS: {
  key: keyof OutlineOptions;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}[] = [
  { key: 'simplifyPx', label: 'Line straightening', hint: 'Max wobble flattened into a straight line', min: 0.2, max: 2.5, step: 0.05, unit: 'px' },
  { key: 'cornerDeg', label: 'Hard corner angle', hint: 'Bends at or above this stay sharp', min: 15, max: 120, step: 1, unit: '°' },
  { key: 'smoothPasses', label: 'Curve smoothing passes', hint: '0 = polygon, higher = rounder curves', min: 0, max: 5, step: 1, unit: '' },
  { key: 'snapCornerPx', label: 'Corner snap reach', hint: 'How far a pixel corner may move to become sharp (0 = off)', min: 0, max: 6, step: 0.1, unit: 'px' },
  { key: 'snapRunPx', label: 'Corner snap run', hint: 'Edges shorter than this are merged into a sharp corner', min: 2, max: 14, step: 0.5, unit: 'px' },
  { key: 'snapDeviationPx', label: 'Corner snap tolerance', hint: 'Max shape change when snapping (protects small letters)', min: 0.2, max: 3, step: 0.05, unit: 'px' },
  { key: 'curveEdgePx', label: 'Tight curve edge', hint: 'Bends next to shorter edges that keep bending are curves', min: 0, max: 30, step: 0.5, unit: 'px' },
  { key: 'pinEdgePx', label: 'Long edge corner', hint: 'Where two edges this long meet stays sharp at any angle', min: 4, max: 50, step: 0.5, unit: 'px' },
  { key: 'straightenDeg', label: 'Axis snap angle', hint: 'Edges this close to horizontal / vertical become exact (0 = off)', min: 0, max: 12, step: 0.5, unit: '°' },
  { key: 'jogBandPx', label: 'Flat side jog', hint: 'Small steps along flat sides are flattened (0 = off)', min: 0, max: 3, step: 0.05, unit: 'px' },
  { key: 'jogMinSpanPx', label: 'Flat side min length', hint: 'Only sides at least this long are flattened', min: 3, max: 40, step: 0.5, unit: 'px' },
];

const PART_COLOR_PRESETS = [
  { label: 'Yellow', hex: '#f5c518' },
  { label: 'White', hex: '#ffffff' },
  { label: 'Black', hex: '#000000' },
  { label: 'Green', hex: '#22a845' },
  { label: 'Red', hex: '#d62828' },
];

function formatStep(v: number, step: number): string {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return v.toFixed(decimals);
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

export default function ImageTo3d() {
  const [segmented, setSegmented] = useState<SegmentedImage | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [widthMm, setWidthMm] = useState(80);
  const [baseEnabled, setBaseEnabled] = useState(false);
  const [baseHeightMm, setBaseHeightMm] = useState(1);
  const [smoothEdges, setSmoothEdges] = useState(true);
  const [rightTab, setRightTab] = useState<'parts' | 'advanced'>('parts');
  const [partMode, setPartModeState] = useState<PartMode>('color');
  const partModeRef = useRef<PartMode>('color');
  const [outlineDraft, setOutlineDraft] = useState<OutlineOptions>(DEFAULT_OUTLINE_OPTIONS);
  const [outlineOpts, setOutlineOpts] = useState<OutlineOptions>(DEFAULT_OUTLINE_OPTIONS);
  /** Exclusive tools — wand (BG) and part select must not race. */
  const [activeTool, setActiveTool] = useState<'wand' | 'hand' | 'part'>('wand');
  const [imgZoom, setImgZoom] = useState(1);
  const [imgPan, setImgPan] = useState({ x: 0, y: 0 });
  const [bgTolerance, setBgTolerance] = useState(28);
  const [bgSmooth, setBgSmooth] = useState(2);
  const [bgGrow, setBgGrow] = useState(1);
  const [partHeightMm, setPartHeightMm] = useState(DEFAULT_PART_HEIGHT_MM);
  const [partColor, setPartColor] = useState('#000000');
  const [wandBgParts, setWandBgParts] = useState<WandBgPart[]>([]);
  const [activeWandId, setActiveWandId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Load a logo / flat image to extrude by color regions.');
  const [resetKey, setResetKey] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [bedColor, setBedColor] = useState<'yellow' | 'white' | 'black'>('yellow');
  const [leftWidth, setLeftWidth] = useState(360);
  const resizeDrag = useRef<{ x: number; w: number } | null>(null);
  const [measureMode, setMeasureMode] = useState<MeasureMode>('off');
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [extruded, setExtruded] = useState<ExtrudedPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const imgViewRef = useRef({ zoom: 1, x: 0, y: 0 });
  const panDrag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const needsViewReset = useRef(true);
  imgViewRef.current = { zoom: imgZoom, x: imgPan.x, y: imgPan.y };
  const autoLoaded = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const segmentedRef = useRef<SegmentedImage | null>(null);
  const rawRef = useRef<SegmentedImage | null>(null);
  const wandBgPartsRef = useRef<WandBgPart[]>([]);
  const ingestGenRef = useRef(0);

  // Sync refs after commit only — never overwrite mid-click during render
  useEffect(() => {
    segmentedRef.current = segmented;
  }, [segmented]);
  useEffect(() => {
    wandBgPartsRef.current = wandBgParts;
  }, [wandBgParts]);

  const size = useMemo(
    () => (segmented ? modelSizeMm(segmented, widthMm) : null),
    [segmented, widthMm]
  );

  const measuredMm = useMemo(() => {
    if (measurePoints.length < 2) return 0;
    const a = measurePoints[0];
    const b = measurePoints[1];
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }, [measurePoints]);

  const settings: ExtrudeSettings = useMemo(
    () => ({
      widthMm,
      baseHeightMm,
      baseEnabled,
      smoothEdges,
      outline: outlineOpts,
    }),
    [widthMm, baseHeightMm, baseEnabled, smoothEdges, outlineOpts]
  );

  // Rebuild once the slider settles, not on every drag tick.
  useEffect(() => {
    if (outlineDraft === outlineOpts) return;
    const t = window.setTimeout(() => setOutlineOpts(outlineDraft), 220);
    return () => window.clearTimeout(t);
  }, [outlineDraft, outlineOpts]);

  const outlineIsDefault = OUTLINE_SLIDERS.every(
    (s) => outlineDraft[s.key] === DEFAULT_OUTLINE_OPTIONS[s.key]
  );

  const rebuildPreview = useCallback(
    (
      seg: SegmentedImage,
      selected: string[],
      wandParts: WandBgPart[] = [],
      activeId: string | null = null
    ) => {
      const canvas = renderRegionPreview(seg, new Set(selected), true, wandParts, activeId);
      const paint = (host: HTMLCanvasElement | null) => {
        if (!host) return;
        const ctx = host.getContext('2d')!;
        host.width = canvas.width;
        host.height = canvas.height;
        ctx.clearRect(0, 0, host.width, host.height);
        ctx.drawImage(canvas, 0, 0);
      };
      paint(previewRef.current);
      fitSourceImage();
      if (needsViewReset.current) {
        needsViewReset.current = false;
        resetSourceView();
      }
    },
    []
  );

  const fitSourceImage = () => {
    const wrap = previewWrapRef.current;
    const canvas = previewRef.current;
    if (!wrap || !canvas || !canvas.width || !canvas.height) return;
    const fit = Math.min(wrap.clientWidth / canvas.width, wrap.clientHeight / canvas.height);
    if (!Number.isFinite(fit) || fit <= 0) return;
    canvas.style.width = `${canvas.width * fit}px`;
    canvas.style.height = `${canvas.height * fit}px`;
  };

  const resetSourceView = () => {
    const wrap = previewWrapRef.current;
    const canvas = previewRef.current;
    fitSourceImage();
    if (!wrap || !canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const next = { x: (wrap.clientWidth - w) / 2, y: (wrap.clientHeight - h) / 2 };
    imgViewRef.current = { zoom: 1, ...next };
    setImgZoom(1);
    setImgPan(next);
  };

  useEffect(() => {
    const wrap = previewWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (activeTool !== 'hand') return;
      e.preventDefault();
      const prev = imgViewRef.current.zoom;
      const next = Math.min(16, Math.max(0.25, prev * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const bounds = wrap.getBoundingClientRect();
      const cx = e.clientX - bounds.left;
      const cy = e.clientY - bounds.top;
      const localX = (cx - imgViewRef.current.x) / prev;
      const localY = (cy - imgViewRef.current.y) / prev;
      const pan = { x: cx - localX * next, y: cy - localY * next };
      imgViewRef.current = { zoom: next, ...pan };
      setImgZoom(next);
      setImgPan(pan);
    };
    const ro = new ResizeObserver(() => fitSourceImage());
    ro.observe(wrap);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      wrap.removeEventListener('wheel', onWheel);
    };
  }, [activeTool]);

  const rebuildMesh = useCallback(
    (seg: SegmentedImage, extrude: ExtrudeSettings) => {
      setExtruded((prev) => {
        disposeExtruded(prev);
        return buildExtrudedParts(seg, extrude);
      });
      setResetKey((k) => k + 1);
    },
    []
  );

  const ingestImage = useCallback(
    async (img: HTMLImageElement, name: string) => {
      const gen = ++ingestGenRef.current;
      setBusy(true);
      setStatus(`Segmenting ${name}…`);
      try {
        await new Promise((r) => setTimeout(r, 20));
        if (gen !== ingestGenRef.current) return;
        const seg = segmentImage(img, name, {
          colorTolerance: 36,
          maxColors: 14,
          partMode: partModeRef.current,
        });
        // No automatic white BG — user marks closed regions with the wand.
        if (gen !== ingestGenRef.current) return;
        wandBgPartsRef.current = [];
        needsViewReset.current = true;
        rawRef.current = seg;
        segmentedRef.current = seg;
        setWandBgParts([]);
        setActiveWandId(null);
        setActiveTool('wand');
        setSegmented(seg);
        setSelectedIds([]);
        rebuildPreview(seg, [], [], null);
        setExtruded((prev) => {
          disposeExtruded(prev);
          return [];
        });
        const native = seg.downsample >= 0.999;
        setStatus(
          `Tool: Wand on · ${seg.sourceWidth}×${seg.sourceHeight}${
            native ? ' original' : ` → working ${seg.width}×${seg.height}`
          } · ${seg.regions.length} closed parts · click the image to mark BG`
        );
      } catch (err) {
        if (gen !== ingestGenRef.current) return;
        setStatus(`Segment error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (gen === ingestGenRef.current) setBusy(false);
      }
    },
    [bgTolerance, widthMm, baseEnabled, baseHeightMm, rebuildPreview, rebuildMesh]
  );

  const loadDefault = useCallback(async () => {
    setBusy(true);
    setStatus('Loading logo-clear.png…');
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      const img = await loadImageElement(DEFAULT_LOGO_SAMPLE);
      await ingestImage(img, 'logo-clear.png');
    } catch (err) {
      setStatus(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }, [ingestImage]);

  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    void loadDefault();
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [loadDefault]);

  useEffect(() => {
    if (!segmented) return;
    rebuildPreview(segmented, selectedIds, wandBgParts, activeWandId);
  }, [segmented, selectedIds, wandBgParts, activeWandId, activeTool, rebuildPreview]);

  // Build 3D only after the user has wand-marked at least one BG region.
  useEffect(() => {
    if (!segmented) return;
    if (wandBgParts.length === 0) {
      setExtruded((prev) => {
        if (prev.length === 0) return prev;
        disposeExtruded(prev);
        return [];
      });
      return;
    }
    const t = window.setTimeout(() => {
      rebuildMesh(segmented, settings);
      setMeasurePoints([]);
    }, 120);
    return () => window.clearTimeout(t);
  }, [segmented, settings, wandBgParts.length, rebuildMesh]);

  // Re-flood the same click points when wand tolerance / smooth / grow change.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const raw = rawRef.current;
      const picks = wandBgPartsRef.current;
      if (!raw || picks.length === 0) return;
      const applied = reapplyWandPicks(raw, picks, bgTolerance, bgSmooth, bgGrow, segmentedRef.current?.regions);
      wandBgPartsRef.current = applied.parts;
      segmentedRef.current = applied.segmented;
      setWandBgParts(applied.parts);
      setSegmented(applied.segmented);
      setStatus(
        `Wand rebuilt from ${applied.parts.length} click(s) · tol ${bgTolerance} · smooth ${bgSmooth} · grow ${bgGrow}`
      );
    }, 90);
    return () => window.clearTimeout(t);
  }, [bgTolerance, bgSmooth, bgGrow]);

  const startMeasure = () => {
    setMeasureMode('line');
    setMeasurePoints([]);
    setStatus('Measure: click two points on the model (distance in mm).');
  };

  const clearMeasure = () => {
    setMeasurePoints([]);
    setMeasureMode('off');
    setStatus('Measure cleared.');
  };

  const onSurfaceHit = useCallback(
    (ev: SurfaceHitEvent) => {
      if (busy || measureMode === 'off') return;
      setMeasurePoints((prev) => {
        const next = [...prev, ev.point];
        if (next.length > 2) return [ev.point];
        if (next.length === 2) {
          const a = next[0];
          const b = next[1];
          const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          setStatus(`Measured ${formatNum(d)} mm (model units). Click again to remeasure.`);
        }
        return next;
      });
    },
    [busy, measureMode]
  );

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      const img = await loadImageElement(url);
      await ingestImage(img, file.name);
    } catch (err) {
      setStatus(`Load error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onPreviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const seg = segmentedRef.current;
    if (!seg || busy) return;
    if (activeTool === 'hand') return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * seg.width;
    const y = ((e.clientY - rect.top) / rect.height) * seg.height;

    if (activeTool === 'wand') {
      const raw = rawRef.current;
      if (!raw) return;
      if (!pickWandRegion(seg, x, y, bgTolerance)) {
        setStatus('Wand: nothing new here (already BG or too small).');
        return;
      }
      const id = `bg-${Date.now().toString(36)}-${wandBgPartsRef.current.length}`;
      const seed: WandBgPart = {
        id,
        name: `BG ${wandBgPartsRef.current.length + 1}`,
        hex: '#ffffff',
        pixelCount: 0,
        mask: new Uint8Array(0),
        seedX: x,
        seedY: y,
        kind: 'click',
      };
      const applied = reapplyWandPicks(
        raw,
        [...wandBgPartsRef.current, seed],
        bgTolerance,
        bgSmooth,
        bgGrow,
        segmentedRef.current?.regions
      );
      const added = applied.parts.find((p) => p.id === id);
      if (!added || added.pixelCount < 1) {
        setStatus('Wand: nothing new here (already BG or too small).');
        return;
      }
      wandBgPartsRef.current = applied.parts;
      segmentedRef.current = applied.segmented;
      setWandBgParts(applied.parts);
      setActiveWandId(id);
      setSegmented(applied.segmented);
      setSelectedIds([]);
      setStatus(
        `Wand BG +1 · ${added.name} · ${formatCount(added.pixelCount)} px · list ${applied.parts.length}`
      );
      return;
    }

    // Part-select tool (preview)
    const hit = hitTestRegion(seg, x, y);
    if (!hit) {
      setSelectedIds([]);
      return;
    }
    togglePartSelection(hit.id, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  const useWandTool = () => {
    setActiveTool('wand');
    setStatus('Tool: Wand — click the source image to mark BG regions (pink).');
  };

  const useHandTool = () => {
    setActiveTool('hand');
    setStatus('Tool: Hand — drag to pan the source image, scroll to zoom.');
  };

  const usePartTool = () => {
    setActiveTool('part');
    setStatus('Tool: Select parts — click list / preview / 3D (green).');
  };

  const togglePartSelection = (partId: string, multi: boolean) => {
    if (multi) {
      setSelectedIds((prev) =>
        prev.includes(partId) ? prev.filter((id) => id !== partId) : [...prev, partId]
      );
      return;
    }
    setSelectedIds((prev) => (prev.length === 1 && prev[0] === partId ? [] : [partId]));
  };

  const applyOuterWhiteBg = () => {
    const raw = rawRef.current;
    if (!raw) return;
    const seed: WandBgPart = {
      id: `outer-${Date.now().toString(36)}`,
      name: 'Outer white',
      hex: '#ffffff',
      pixelCount: 0,
      mask: new Uint8Array(0),
      seedX: -1,
      seedY: -1,
      kind: 'outer',
    };
    const applied = reapplyWandPicks(
      raw,
      [...wandBgPartsRef.current, seed],
      bgTolerance,
      bgSmooth,
      bgGrow,
      segmentedRef.current?.regions
    );
    const added = applied.parts.find((p) => p.id === seed.id);
    if (!added || added.pixelCount < 1) {
      setStatus('Outer white: nothing new at the edges.');
      return;
    }
    wandBgPartsRef.current = applied.parts;
    segmentedRef.current = applied.segmented;
    setWandBgParts(applied.parts);
    setActiveWandId(seed.id);
    setSegmented(applied.segmented);
    setSelectedIds([]);
    setStatus(`Outer white added · ${applied.segmented.regions.length} FG parts`);
  };

  const restoreBgPart = (partId: string) => {
    const raw = rawRef.current;
    if (!raw) return;
    const part = wandBgPartsRef.current.find((p) => p.id === partId);
    if (!part) return;
    const picks = wandBgPartsRef.current.filter((p) => p.id !== partId);
    if (picks.length === 0) {
      const next = clearFineBackground(raw);
      wandBgPartsRef.current = [];
      segmentedRef.current = next;
      setWandBgParts([]);
      setActiveWandId(null);
      setSegmented(next);
      setStatus(`Restored ${part.name} as foreground`);
      return;
    }
    const applied = reapplyWandPicks(raw, picks, bgTolerance, bgSmooth, bgGrow, segmentedRef.current?.regions);
    wandBgPartsRef.current = applied.parts;
    segmentedRef.current = applied.segmented;
    setWandBgParts(applied.parts);
    setActiveWandId(applied.parts[0]?.id ?? null);
    setSegmented(applied.segmented);
    setStatus(`Restored ${part.name} as foreground · ${applied.segmented.regions.length} FG parts`);
  };

  const resetFineBg = () => {
    const raw = rawRef.current;
    if (!raw) return;
    const next = clearFineBackground(raw);
    wandBgPartsRef.current = [];
    segmentedRef.current = next;
    setSegmented(next);
    setWandBgParts([]);
    setActiveWandId(null);
    setSelectedIds([]);
    setStatus('Cleared all wand BG parts — restored as foreground.');
  };

  const selectedRegion =
    segmented && selectedIds.length === 1
      ? segmented.regions.find((r) => r.id === selectedIds[0]) ?? null
      : null;

  const patchSelectedHeight = (heightMm: number) => {
    if (!segmented || selectedIds.length === 0) return;
    let regions = segmented.regions;
    for (const id of selectedIds) {
      regions = updateRegion(regions, id, { heightMm });
    }
    const next = { ...segmented, regions };
    setSegmented(next);
  };

  const applyHeightToAll = () => {
    if (!segmented) return;
    const h = partHeightMm;
    const raw = rawRef.current;
    if (raw) {
      rawRef.current = {
        ...raw,
        defaultHeightMm: h,
        regions: raw.regions.map((r) => ({ ...r, heightMm: h })),
      };
    }
    const next = {
      ...segmented,
      defaultHeightMm: h,
      regions: segmented.regions.map((r) => ({ ...r, heightMm: h })),
    };
    segmentedRef.current = next;
    setSegmented(next);
    setStatus(`Height ${formatNum(h)} mm → all ${next.regions.length} parts`);
  };

  const changePartMode = (mode: PartMode) => {
    if (mode === partModeRef.current) return;
    partModeRef.current = mode;
    setPartModeState(mode);
    const raw = rawRef.current;
    if (raw) rawRef.current = { ...raw, partMode: mode };
    const seg = segmentedRef.current;
    if (!seg) return;
    const next = setPartMode(seg, mode);
    segmentedRef.current = next;
    setSelectedIds([]);
    setSegmented(next);
    setStatus(
      `${mode === 'solid' ? 'Max solids' : 'Color parts'} · ${next.regions.length} part(s) from foreground`
    );
  };

  const applyColorToAll = () => {
    if (!segmented) return;
    const hex = partColor.toLowerCase();
    const next = {
      ...segmented,
      regions: segmented.regions.map((r) => ({ ...r, printHex: hex, printHexCustom: true })),
    };
    segmentedRef.current = next;
    setSegmented(next);
    setStatus(`Color ${hex} → all ${next.regions.length} parts`);
  };

  const applyColorToSelected = () => {
    if (selectedIds.length === 0) return;
    patchSelectedPrintColor(partColor);
    setStatus(`Color ${partColor.toLowerCase()} → ${selectedIds.length} selected part(s)`);
  };

  const applyHeightToSelected = () => {
    if (selectedIds.length === 0) return;
    patchSelectedHeight(partHeightMm);
    setStatus(`Height ${formatNum(partHeightMm)} mm → ${selectedIds.length} selected part(s)`);
  };

  const patchSelectedPrintColor = (printHex: string) => {
    if (!segmented || selectedIds.length === 0) return;
    const hex = printHex.startsWith('#') ? printHex : `#${printHex}`;
    let regions = segmented.regions;
    for (const id of selectedIds) {
      regions = updateRegion(regions, id, { printHex: hex.toLowerCase(), printHexCustom: true });
    }
    setSegmented({ ...segmented, regions });
    setStatus(`3D color ${hex} → ${selectedIds.length} part(s)`);
  };

  const toggleSelectedEnabled = () => {
    if (!segmented || selectedIds.length === 0) return;
    let regions = segmented.regions;
    for (const id of selectedIds) {
      const r = regions.find((x) => x.id === id);
      if (r) regions = updateRegion(regions, id, { enabled: !r.enabled });
    }
    setSegmented({ ...segmented, regions });
  };

  const export3mf = () => {
    if (extruded.length === 0) return;
    try {
      const data = exportGeometriesTo3mf(
        extruded.map((p) => ({ name: p.name, geometry: p.geometry })),
        segmented?.name.replace(/\.[^.]+$/, '') || 'logo'
      );
      const base = segmented?.name.replace(/\.[^.]+$/, '') || 'logo';
      download3mf(data, `${base}_image3d.3mf`);
      setStatus(`Exported ${extruded.length} parts → ${base}_image3d.3mf`);
    } catch (err) {
      setStatus(`Export error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const viewerParts = useMemo(
    () =>
      extruded.map((p) => ({
        id: p.id,
        geometry: p.geometry,
        color: selectedIds.includes(p.id) ? 0x22c55e : p.color,
      })),
    [extruded, selectedIds]
  );

  const totalTris = extruded.reduce((s, p) => s + p.triangleCount, 0);

  return (
    <div className="app tool-image3d">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">2→3</span>
          <div>
            <h1>Image → 3D</h1>
            <p>Color regions → heights → multi-part 3MF</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            Open image
          </button>
          <button type="button" className="primary" onClick={() => void loadDefault()} disabled={busy}>
            Load logo-clear
          </button>
          <button type="button" onClick={export3mf} disabled={busy || extruded.length === 0}>
            Export .3mf
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
      </header>

      <div
        className="workspace workspace-image3d"
        style={{ gridTemplateColumns: `${leftWidth}px 6px 1fr minmax(240px, 16vw)` }}
      >
        <aside className="panel left">
          <section>
            <h2>Wand</h2>
            <div className="row-actions">
              <button
                type="button"
                className={activeTool === 'wand' ? 'primary tool-active' : 'tool-toggle'}
                aria-pressed={activeTool === 'wand'}
                disabled={!segmented}
                onClick={useWandTool}
              >
                {activeTool === 'wand' ? 'Wand on' : 'Use wand'}
              </button>
              <button
                type="button"
                className={activeTool === 'hand' ? 'primary tool-active' : 'tool-toggle'}
                aria-pressed={activeTool === 'hand'}
                disabled={!segmented}
                onClick={useHandTool}
              >
                {activeTool === 'hand' ? 'Hand on' : 'Hand'}
              </button>
              <button type="button" disabled={!segmented || busy} onClick={applyOuterWhiteBg}>
                Outer white
              </button>
            </div>
            <label>
              Wand tolerance
              <NumberInput
                step={1}
                min={2}
                max={180}
                value={bgTolerance}
                onChange={setBgTolerance}
              />
            </label>
            <label>
              Smooth passes
              <NumberInput step={1} min={0} max={12} value={bgSmooth} onChange={setBgSmooth} />
            </label>
            <label>
              Grow BG (fringe)
              <NumberInput step={1} min={0} max={10} value={bgGrow} onChange={setBgGrow} />
            </label>
            <div className="row-actions">
              <button type="button" disabled={!segmented || busy || wandBgParts.length === 0} onClick={resetFineBg}>
                Clear all BG
              </button>
            </div>
            <p className="muted tiny" style={{ margin: '0.5rem 0 0.2rem' }}>
              Foreground → parts
            </p>
            <div className="row-actions" role="radiogroup" aria-label="Part split mode">
              <button
                type="button"
                role="radio"
                aria-checked={partMode === 'color'}
                className={partMode === 'color' ? 'primary' : ''}
                disabled={busy}
                onClick={() => changePartMode('color')}
              >
                By color
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={partMode === 'solid'}
                className={partMode === 'solid' ? 'primary' : ''}
                disabled={busy}
                onClick={() => changePartMode('solid')}
              >
                Max solids
              </button>
            </div>
            <p className="muted tiny">
              {partMode === 'solid'
                ? 'Largest enclosed foreground objects — fills trapped inside join the outer shape. BG holes stay holes.'
                : 'Each color region is its own part (letter counters, marks, inks).'}
            </p>
          </section>

          <section>
            <h2>Source</h2>
            <div
              ref={previewWrapRef}
              className={activeTool === 'hand' ? 'image-preview-wrap hand-view' : 'image-preview-wrap'}
              onPointerDown={(e) => {
                if (activeTool !== 'hand') return;
                panDrag.current = {
                  px: e.clientX,
                  py: e.clientY,
                  x: imgViewRef.current.x,
                  y: imgViewRef.current.y,
                };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!panDrag.current || activeTool !== 'hand') return;
                const next = {
                  x: panDrag.current.x + (e.clientX - panDrag.current.px),
                  y: panDrag.current.y + (e.clientY - panDrag.current.py),
                };
                imgViewRef.current = { ...imgViewRef.current, ...next };
                setImgPan(next);
              }}
              onPointerUp={() => {
                panDrag.current = null;
              }}
              onDoubleClick={() => {
                if (activeTool === 'hand') resetSourceView();
              }}
            >
              <canvas
                ref={previewRef}
                className={
                  activeTool === 'wand'
                    ? 'image-preview bg-pick'
                    : activeTool === 'hand'
                      ? 'image-preview hand-tool'
                      : 'image-preview'
                }
                style={{
                  transform: `translate(${imgPan.x}px, ${imgPan.y}px) scale(${imgZoom})`,
                }}
                onClick={onPreviewClick}
                title={
                  activeTool === 'hand'
                    ? 'Hand: drag to pan, scroll to zoom, double-click to reset'
                    : activeTool === 'wand'
                      ? 'Wand tool: click a closed region to mark BG'
                      : 'Part tool: click a closed part to select'
                }
              />
            </div>
            <p className="muted tiny">
              {activeTool === 'hand'
                ? 'Hand — drag to pan, scroll to zoom, double-click to fit.'
                : activeTool === 'wand'
                  ? 'Click closed areas (pink). 3D preview appears after the first BG pick.'
                  : 'Select parts is on — use the right list / 3D (green).'}
            </p>
            <h3 className="subhead">BG parts ({wandBgParts.length})</h3>
            {wandBgParts.length === 0 ? (
              <p className="muted tiny">No wand picks yet — click the source image.</p>
            ) : (
              <ul className="color-list wand-bg-list">
                {[...wandBgParts].reverse().map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={
                        activeWandId === p.id ? 'color-item wand-bg active' : 'color-item wand-bg'
                      }
                      onClick={() => setActiveWandId(p.id)}
                      title="Highlight this BG part"
                    >
                      <span className="part-swatch pink-swatch" style={{ background: '#ff69b4' }} />
                      <span className="part-info">
                        <span className="part-name">{p.name}</span>
                        <span className="muted tiny mono">
                          {p.hex} · {formatCount(p.pixelCount)} px
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="wand-restore"
                      disabled={busy}
                      onClick={() => restoreBgPart(p.id)}
                      title="Make foreground again"
                    >
                      → FG
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {segmented && (
              <p className="muted tiny mono">
                BG px {formatCount(countFineBgPixels(segmented))} · FG parts{' '}
                {segmented.regions.length}
              </p>
            )}
          </section>

          <section>
            <h2>Dimensions</h2>
            <label>
              Model width (mm)
              <NumberInput step={1} min={5} max={500} value={widthMm} onChange={setWidthMm} />
            </label>
            {size && segmented && (
              <p className="muted tiny mono">
                Plate {formatNum(size.widthMm)} × {formatNum(size.heightMm)} mm · px{' '}
                {formatNum(size.pixelMm, 3)} mm · {segmented.sourceWidth}×{segmented.sourceHeight}
                {segmented.downsample < 0.999 ? ` → ${segmented.width}×${segmented.height}` : ' original'}
              </p>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={smoothEdges}
                onChange={(e) => setSmoothEdges(e.target.checked)}
              />
              Smooth edges (straight lines, corners, curves)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={baseEnabled}
                onChange={(e) => setBaseEnabled(e.target.checked)}
              />
              Add base plate
            </label>
            {baseEnabled && (
              <label>
                Base height (mm)
                <NumberInput
                  step={0.1}
                  min={0.2}
                  max={20}
                  value={baseHeightMm}
                  onChange={setBaseHeightMm}
                />
              </label>
            )}
            <div className="row-actions" style={{ marginTop: '0.55rem' }}>
              <button
                type="button"
                className={measureMode === 'line' ? 'primary' : ''}
                disabled={!extruded.length || busy}
                onClick={startMeasure}
              >
                Measure distance
              </button>
              <button
                type="button"
                disabled={measureMode === 'off' && measurePoints.length === 0}
                onClick={clearMeasure}
              >
                Clear
              </button>
            </div>
            <p className="muted tiny mono" style={{ marginTop: '0.35rem' }}>
              Distance:{' '}
              {measuredMm > 0 ? `${formatNum(measuredMm)} mm` : measureMode === 'line' ? `${measurePoints.length}/2` : '—'}
            </p>
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
            {wandBgParts.length === 0 ? (
              <div className="stage-photo-wrap">
                <p className="muted">
                  3D preview waits for a background pick.
                  <br />
                  Use the wand on the source image (left).
                </p>
              </div>
            ) : (
              <MeshViewer3D
                parts={viewerParts}
                wireframe={wireframe}
                resetKey={resetKey}
                pickEnabled={!busy && activeTool === 'part'}
                measureMode={measureMode}
                measurePoints={measurePoints}
                upAxis="z"
                bedColor={bedColor}
                onSurfaceHit={onSurfaceHit}
                onPartClick={(ev) => {
                  if (measureMode !== 'off' || activeTool !== 'part') return;
                  togglePartSelection(
                    ev.partId,
                    ev.shiftKey || ev.metaKey || ev.ctrlKey
                  );
                }}
              />
            )}
            {activeTool === 'part' && measureMode === 'off' && wandBgParts.length > 0 && (
              <div className="measure-banner tool-banner-part">
                Select parts active — click list / 3D (green) · Wand is off
              </div>
            )}
            {measureMode !== 'off' && (
              <div className="measure-banner">
                Measure distance — click model ({measurePoints.length}/2)
                {measuredMm > 0 ? ` · ${formatNum(measuredMm)} mm` : ''} · RMB orbit · LMB drag pan
              </div>
            )}
            {busy && <div className="viewport-busy">Working…</div>}
          </div>
        </main>

        <aside className="panel right">
          <div className="panel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'parts'}
              className={rightTab === 'parts' ? 'active' : ''}
              onClick={() => setRightTab('parts')}
            >
              Parts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'advanced'}
              className={rightTab === 'advanced' ? 'active' : ''}
              onClick={() => setRightTab('advanced')}
            >
              Advanced
            </button>
          </div>

          {rightTab === 'advanced' ? (
            <section>
              <h2>Edge smoothing</h2>
              <label className="check">
                <input
                  type="checkbox"
                  checked={smoothEdges}
                  onChange={(e) => setSmoothEdges(e.target.checked)}
                />
                Smooth edges (off = pixel blocks)
              </label>
              {OUTLINE_SLIDERS.map((s) => {
                const v = outlineDraft[s.key];
                const changed = v !== DEFAULT_OUTLINE_OPTIONS[s.key];
                return (
                  <label key={s.key} className="slider-field" title={s.hint}>
                    <span className="slider-head">
                      <span>{s.label}</span>
                      <span className={changed ? 'mono slider-value changed' : 'mono slider-value'}>
                        {formatStep(v, s.step)}
                        {s.unit}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={s.min}
                      max={s.max}
                      step={s.step}
                      value={v}
                      disabled={!smoothEdges}
                      onChange={(e) =>
                        setOutlineDraft((d) => ({ ...d, [s.key]: Number(e.target.value) }))
                      }
                      onDoubleClick={() =>
                        setOutlineDraft((d) => ({ ...d, [s.key]: DEFAULT_OUTLINE_OPTIONS[s.key] }))
                      }
                    />
                    <span className="muted tiny">
                      {s.hint} · default {formatStep(DEFAULT_OUTLINE_OPTIONS[s.key], s.step)}
                      {s.unit}
                    </span>
                  </label>
                );
              })}
              <button
                type="button"
                className="wide"
                disabled={outlineIsDefault}
                onClick={() => setOutlineDraft(DEFAULT_OUTLINE_OPTIONS)}
              >
                Reset to defaults
              </button>
              <p className="muted tiny">
                1 px ≈ {segmented ? formatNum(widthMm / segmented.width, 2) : '–'} mm. Double-click a slider to reset it.
              </p>
            </section>
          ) : (
          <>
          <section>
            <h2>Split foreground</h2>
            <div className="row-actions" role="radiogroup" aria-label="Part split mode">
              <button
                type="button"
                role="radio"
                aria-checked={partMode === 'color'}
                className={partMode === 'color' ? 'primary' : ''}
                disabled={busy}
                onClick={() => changePartMode('color')}
              >
                By color
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={partMode === 'solid'}
                className={partMode === 'solid' ? 'primary' : ''}
                disabled={busy}
                onClick={() => changePartMode('solid')}
              >
                Max solids
              </button>
            </div>
            <p className="muted tiny">
              {partMode === 'solid'
                ? 'One mesh per enclosed FG object. Inner fills merge in; wand BG holes stay empty.'
                : 'Split the remaining image by color (default).'}
            </p>
          </section>

          <section>
            <h2>Part height</h2>
            <label>
              Height (mm)
              <NumberInput step={0.1} min={0.1} max={40} value={partHeightMm} onChange={setPartHeightMm} />
            </label>
            <div className="row-actions">
              <button type="button" disabled={!segmented?.regions.length} onClick={applyHeightToAll}>
                Change height · all parts
              </button>
              <button type="button" disabled={selectedIds.length === 0} onClick={applyHeightToSelected}>
                Selected parts ({selectedIds.length})
              </button>
            </div>
          </section>

          <section>
            <h2>Part color</h2>
            <div className="row-actions color-swatches">
              {PART_COLOR_PRESETS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  className={partColor.toLowerCase() === c.hex ? 'swatch-btn tool-active' : 'swatch-btn'}
                  aria-pressed={partColor.toLowerCase() === c.hex}
                  onClick={() => setPartColor(c.hex)}
                >
                  <span className="swatch" style={{ background: c.hex }} />
                  {c.label}
                </button>
              ))}
            </div>
            <label>
              Color
              <span className="color-field">
                <input type="color" value={partColor} onChange={(e) => setPartColor(e.target.value)} />
                <input
                  type="text"
                  className="mono"
                  value={partColor}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (/^#?[0-9a-fA-F]{6}$/.test(v)) setPartColor(v.startsWith('#') ? v : `#${v}`);
                  }}
                />
              </span>
            </label>
            <div className="row-actions">
              <button type="button" disabled={!segmented?.regions.length} onClick={applyColorToAll}>
                Change color · all parts
              </button>
              <button type="button" disabled={selectedIds.length === 0} onClick={applyColorToSelected}>
                Selected parts ({selectedIds.length})
              </button>
            </div>
          </section>

          <section>
            <h2>Parts</h2>
            <div className="row-actions">
              <button
                type="button"
                className={activeTool === 'part' ? 'primary tool-active' : 'tool-toggle'}
                aria-pressed={activeTool === 'part'}
                disabled={!segmented}
                onClick={usePartTool}
              >
                {activeTool === 'part' ? 'Select parts on' : 'Select parts'}
              </button>
              <button
                type="button"
                disabled={selectedIds.length === 0 || activeTool !== 'part'}
                onClick={() => setSelectedIds([])}
              >
                Deselect
              </button>
            </div>
            <p className="muted tiny">
              {activeTool === 'part'
                ? 'Select parts is active (green). Shift multi · click again to deselect.'
                : 'Wand is the active tool — click Select parts here to switch.'}
            </p>
            {segmented?.regions.length ? (
              <ul className="part-list tall">
                {segmented.regions.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={
                        selectedIds.includes(r.id)
                          ? 'part-item selected'
                          : r.enabled
                            ? 'part-item'
                            : 'part-item muted-part'
                      }
                      disabled={activeTool !== 'part'}
                      onClick={(e) => {
                        if (activeTool !== 'part') return;
                        togglePartSelection(
                          r.id,
                          e.shiftKey || e.metaKey || e.ctrlKey
                        );
                      }}
                    >
                      <span
                        className="part-swatch"
                        style={{ background: r.printHex || '#000000' }}
                        title={`3D ${r.printHex || '#000000'} (image ${r.hex})`}
                      />
                      <span className="part-info">
                        <span className="part-name">{r.name}</span>
                        <span className="muted tiny">
                          h {formatNum(r.heightMm)} mm · 3D {r.printHex || '#000'}
                          {!r.enabled ? ' · off' : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No parts yet</p>
            )}
          </section>

          <section>
            <h2>Selected part</h2>
            {selectedIds.length === 0 ? (
              <p className="muted tiny">Select one or more closed parts</p>
            ) : (
              <>
                <p className="muted tiny">
                  {selectedIds.length} selected
                  {selectedRegion ? ` · ${selectedRegion.name}` : ''}
                </p>
                <label>
                  Height (mm)
                  <NumberInput
                    step={0.1}
                    min={0}
                    max={40}
                    value={selectedRegion?.heightMm ?? 1.6}
                    onChange={patchSelectedHeight}
                  />
                </label>
                <label>
                  3D emboss color
                  <span className="color-field">
                    <input
                      type="color"
                      value={selectedRegion?.printHex || '#000000'}
                      onChange={(e) => patchSelectedPrintColor(e.target.value)}
                      title="Color for 3D mesh (not from image)"
                    />
                    <input
                      type="text"
                      className="mono"
                      value={selectedRegion?.printHex || '#000000'}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        if (/^#?[0-9a-fA-F]{6}$/.test(v)) patchSelectedPrintColor(v);
                      }}
                    />
                  </span>
                </label>
                <p className="muted tiny">Preview uses the image color. Pick a color to override this part.</p>
                <div className="row-actions">
                  <button type="button" onClick={() => patchSelectedPrintColor('#000000')}>
                    Black
                  </button>
                  <button type="button" onClick={() => patchSelectedPrintColor('#00b4e4')}>
                    Cyan
                  </button>
                  <button type="button" onClick={() => patchSelectedPrintColor('#ffffff')}>
                    White
                  </button>
                  <button type="button" onClick={() => patchSelectedPrintColor('#c45c26')}>
                    Copper
                  </button>
                </div>
                <button type="button" className="wide" onClick={toggleSelectedEnabled}>
                  Toggle enabled
                </button>
                <div className="row-actions">
                  <button type="button" onClick={() => patchSelectedHeight(1)}>
                    1 mm
                  </button>
                  <button type="button" onClick={() => patchSelectedHeight(1.6)}>
                    1.6 mm
                  </button>
                  <button type="button" onClick={() => patchSelectedHeight(2.4)}>
                    2.4 mm
                  </button>
                  <button type="button" onClick={() => patchSelectedHeight(3.2)}>
                    3.2 mm
                  </button>
                </div>
              </>
            )}
          </section>

          <section>
            <h2>View / export</h2>
            <p className="muted tiny" style={{ marginBottom: '0.35rem' }}>
              Bed (mat) color
            </p>
            <div className="row-actions">
              <button
                type="button"
                className={bedColor === 'yellow' ? 'primary' : ''}
                onClick={() => setBedColor('yellow')}
              >
                Yellow
              </button>
              <button
                type="button"
                className={bedColor === 'white' ? 'primary' : ''}
                onClick={() => setBedColor('white')}
              >
                White
              </button>
              <button
                type="button"
                className={bedColor === 'black' ? 'primary' : ''}
                onClick={() => setBedColor('black')}
              >
                Black
              </button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
              Wireframe
            </label>
            <button type="button" className="wide" onClick={() => setResetKey((k) => k + 1)}>
              Reset camera
            </button>
            <button
              type="button"
              className="primary wide"
              disabled={extruded.length === 0 || busy}
              onClick={export3mf}
            >
              Export multi-part 3MF
            </button>
            <p className="muted tiny">
              {extruded.length} mesh object(s) · {formatCount(totalTris)} tris
            </p>
          </section>
          </>
          )}

          <section>
            <h2>Status</h2>
            <p className="status-text">{status}</p>
          </section>
        </aside>
      </div>

      <footer className="statusbar">
        <span>{status}</span>
        <span className="muted">
          {segmented
            ? `${segmented.regions.length} parts · ${formatNum(widthMm)} mm wide · ${extruded.length} solids${
                measuredMm > 0 ? ` · measured ${formatNum(measuredMm)} mm` : ''
              }`
            : 'No image'}
        </span>
      </footer>
    </div>
  );
}
