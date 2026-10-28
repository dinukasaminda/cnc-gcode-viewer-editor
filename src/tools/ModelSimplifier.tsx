import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MeshViewer3D,
  type MeasureMode,
  type MeasurePoint,
  type PartClickEvent,
  type SurfaceHitEvent,
} from '../components/MeshViewer3D';
import { NumberInput } from '../components/NumberInput';
import { removeSmallComponents, simplifyMesh } from '../core/meshSimplify';
import { formatNum } from '../core/format';
import {
  cloneGroups,
  colorToCss,
  makePart,
  mergePartGeometries,
  modelDiagonal,
  nextPaletteColor,
  remapGroupsAfterReplace,
  resolvePartColor,
  scalePartsUniform,
  scrubGroups,
  splitConnectedComponents,
  totalStats,
  type MeshPart,
  type PartGroup,
} from '../core/meshParts';
import {
  DEFAULT_3MF_SAMPLE,
  download3mf,
  exportGeometryTo3mf,
  load3mfFromArrayBuffer,
  load3mfFromUrl,
  suggested3mfName,
} from '../core/threemf';
import {
  PRINT_CONFIG_URL,
  buildEstimateGcode,
  downloadText,
  estimatePrintFromConfig,
  loadPrintConfig,
  type PrintConfig,
  type PrintEstimate,
} from '../core/printEstimate';
import '../App.css';

const MAX_HISTORY = 16;

function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

function formatPrintDelta(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  at: number;
  name: string;
  parts: MeshPart[];
  groups: PartGroup[];
  triangleCount: number;
  vertexCount: number;
  /** Present only after "Slice → G-code estimate" on this step. */
  printEstimate?: PrintEstimate | null;
  gcodeEstimate?: string | null;
}

function geometriesIn(entries: HistoryEntry[]): Set<import('three').BufferGeometry> {
  const used = new Set<import('three').BufferGeometry>();
  for (const e of entries) {
    for (const p of e.parts) used.add(p.geometry);
  }
  return used;
}

/** Dispose part geometries that are not referenced by any kept history entry. */
function disposeEntryUnused(
  entry: HistoryEntry | null | undefined,
  stillUsed: Set<import('three').BufferGeometry>
) {
  if (!entry) return;
  for (const p of entry.parts) {
    if (!stillUsed.has(p.geometry)) p.geometry.dispose();
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function entryFromParts(
  partial: Omit<
    HistoryEntry,
    'triangleCount' | 'vertexCount' | 'parts' | 'groups' | 'printEstimate' | 'gcodeEstimate'
  > & {
    parts: MeshPart[];
    groups: PartGroup[];
  }
): HistoryEntry {
  const stats = totalStats(partial.parts);
  return { ...partial, ...stats, printEstimate: null, gcodeEstimate: null };
}

export default function ModelSimplifier() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Load a .3mf model to simplify.');
  const [ratio, setRatio] = useState(0.35);
  const [targetError, setTargetError] = useState(0.02);
  const [minFeatureSize, setMinFeatureSize] = useState(2);
  const [prune, setPrune] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [confirmDeleteLatest, setConfirmDeleteLatest] = useState(false);
  const [printConfig, setPrintConfig] = useState<PrintConfig | null>(null);
  const [dockTab, setDockTab] = useState<'estimate' | 'size' | 'params'>('estimate');
  const [measureMode, setMeasureMode] = useState<MeasureMode>('off');
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [knownSizeMm, setKnownSizeMm] = useState(350);
  const [paramNozzle, setParamNozzle] = useState(0.2);
  const [paramLayer, setParamLayer] = useState(0.1);
  const [paramWalls, setParamWalls] = useState(4);
  const [paramInfill, setParamInfill] = useState(15);
  const [paramTimeScale, setParamTimeScale] = useState(0.4951);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoLoaded = useRef(false);
  const timelineRef = useRef<HTMLUListElement>(null);

  const model = historyIndex >= 0 ? history[historyIndex] ?? null : null;
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

  const parts = model?.parts ?? [];
  const groups = model?.groups ?? [];
  const bboxDiag = useMemo(() => (model ? modelDiagonal(model.parts) : 0), [model]);

  const viewerParts = useMemo(
    () =>
      parts.map((p) => ({
        id: p.id,
        geometry: p.geometry,
        color: resolvePartColor(p.id, selectedIds, groups),
      })),
    [parts, selectedIds, groups]
  );

  const selectedParts = useMemo(
    () => parts.filter((p) => selectedIds.includes(p.id)),
    [parts, selectedIds]
  );

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  const resetToEntry = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const keepUsed = geometriesIn([entry]);
      prev.forEach((e) => disposeEntryUnused(e, keepUsed));
      return [entry];
    });
    setHistoryIndex(0);
    setSelectedIds([]);
    setActiveGroupId(null);
    setResetKey((k) => k + 1);
  }, []);

  const commitEntry = useCallback(
    (entry: HistoryEntry, clearSelection = false) => {
      setHistory((prev) => {
        const keep = prev.slice(0, historyIndex + 1);
        const next = [...keep, entry];
        while (next.length > MAX_HISTORY) next.shift();
        const used = geometriesIn(next);
        // Drop redo-branch + overflow entries' unique geometries
        for (const e of prev) {
          if (!next.includes(e)) disposeEntryUnused(e, used);
        }
        setHistoryIndex(next.length - 1);
        return next;
      });
      if (clearSelection) {
        setSelectedIds([]);
        setActiveGroupId(null);
      }
    },
    [historyIndex]
  );

  const goToHistory = useCallback(
    (index: number) => {
      if (busy) return;
      if (index < 0 || index >= history.length || index === historyIndex) return;
      const entry = history[index];
      setHistoryIndex(index);
      setSelectedIds([]);
      setActiveGroupId(null);
      setDockTab('estimate');
      setStatus(
        `Restored “${entry.label}” · ${formatCount(entry.triangleCount)} tris` +
          (entry.printEstimate ? ` · sliced ${entry.printEstimate.label}` : '')
      );
    },
    [busy, history, historyIndex]
  );

  const undo = () => goToHistory(historyIndex - 1);
  const redo = () => goToHistory(historyIndex + 1);

  const latestIndex = history.length - 1;
  const canDeleteLatest = !busy && history.length > 1;

  const deleteLatestHistory = () => {
    if (!canDeleteLatest || history.length <= 1) return;
    const prev = history;
    const next = prev.slice(0, -1);
    const used = geometriesIn(next);
    disposeEntryUnused(prev[prev.length - 1], used);
    const newIndex = Math.min(historyIndex, next.length - 1);
    const entry = next[newIndex];
    setHistory(next);
    setHistoryIndex(newIndex);
    setSelectedIds([]);
    setActiveGroupId(null);
    setConfirmDeleteLatest(false);
    setStatus(`Deleted latest step · now “${entry.label}” · ${formatCount(entry.triangleCount)} tris`);
  };

  useEffect(() => {
    const el = timelineRef.current?.querySelector('.history-item.active');
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [historyIndex]);

  const ingestLoaded = useCallback(
    async (name: string, geometry: import('three').BufferGeometry, label: string, detail: string) => {
      setStatus(`Detecting closed parts in ${name}…`);
      const partsSplit = await splitConnectedComponents(geometry);
      geometry.dispose();
      if (partsSplit.length === 0) throw new Error('No mesh parts found');
      resetToEntry(
        entryFromParts({
          id: newId(),
          label,
          detail: `${detail} · ${partsSplit.length} part${partsSplit.length === 1 ? '' : 's'}`,
          at: Date.now(),
          name,
          parts: partsSplit,
          groups: [],
        })
      );
      const stats = totalStats(partsSplit);
      setStatus(
        `Loaded ${name} · ${formatCount(stats.triangleCount)} tris · ${partsSplit.length} closed part${partsSplit.length === 1 ? '' : 's'}`
      );
    },
    [resetToEntry]
  );

  const loadDefault = useCallback(async () => {
    setBusy(true);
    setStatus('Loading MoonLamp sample (large file)…');
    try {
      const loaded = await load3mfFromUrl(DEFAULT_3MF_SAMPLE, 'MoonLamp+v2.2.3mf');
      await ingestLoaded(loaded.name, loaded.geometry, 'Loaded MoonLamp', 'Sample model');
    } catch (err) {
      setStatus(`Failed to load sample: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [ingestLoaded]);

  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    void loadDefault();
  }, [loadDefault]);

  useEffect(() => {
    loadPrintConfig()
      .then((cfg) => {
        setPrintConfig(cfg);
        setParamNozzle(cfg.nozzle.diameterMm);
        setParamLayer(cfg.layer.layerHeightMm);
        setParamWalls(cfg.shell.wallLoops);
        setParamInfill(cfg.infill.densityPercent);
        setParamTimeScale(cfg.timeModel.scaleFactor);
        if (cfg.calibration?.referenceDiameterMm) {
          setKnownSizeMm(cfg.calibration.referenceDiameterMm);
        }
      })
      .catch((err) =>
        setStatus(`Print config load failed: ${err instanceof Error ? err.message : String(err)}`)
      );
  }, []);

  const measuredLength = useMemo(() => {
    if (measurePoints.length < 2) return 0;
    const a = measurePoints[0];
    const b = measurePoints[1];
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }, [measurePoints]);

  /** For radius mode, measured value is radius (center→rim). Line mode = full length. */
  const measuredFeatureMm = useMemo(() => {
    if (measuredLength <= 0) return 0;
    return measureMode === 'radius' ? measuredLength : measuredLength;
  }, [measuredLength, measureMode]);

  const pendingSizeScale = useMemo(() => {
    if (measuredFeatureMm <= 1e-9 || knownSizeMm <= 0) return 1;
    // radius mode: knownSize is diameter or radius? UI labels diameter for moon → if radius mode, known is radius
    return knownSizeMm / measuredFeatureMm;
  }, [measuredFeatureMm, knownSizeMm]);

  const activePrintConfig = useMemo((): PrintConfig | null => {
    if (!printConfig) return null;
    return {
      ...printConfig,
      nozzle: {
        ...printConfig.nozzle,
        diameterMm: paramNozzle,
        lineWidthMm: Math.max(paramNozzle * 1.1, 0.01),
      },
      layer: { ...printConfig.layer, layerHeightMm: paramLayer },
      shell: { ...printConfig.shell, wallLoops: paramWalls },
      infill: { ...printConfig.infill, densityPercent: paramInfill },
      timeModel: { ...printConfig.timeModel, scaleFactor: paramTimeScale },
    };
  }, [printConfig, paramNozzle, paramLayer, paramWalls, paramInfill, paramTimeScale]);

  const liveEstimate = useMemo(() => {
    if (!model || !activePrintConfig) return null;
    const scale =
      measurePoints.length >= 2 && Math.abs(pendingSizeScale - 1) > 1e-9 ? pendingSizeScale : 1;
    return estimatePrintFromConfig(model.parts, activePrintConfig, scale);
  }, [model, activePrintConfig, measurePoints.length, pendingSizeScale]);

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setStatus(`Loading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const loaded = await load3mfFromArrayBuffer(buf, file.name);
      await ingestLoaded(loaded.name, loaded.geometry, 'Loaded file', loaded.name);
    } catch (err) {
      setStatus(`Load error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onPartClick = useCallback((ev: PartClickEvent) => {
    if (busy || measureMode !== 'off') return;
    setActiveGroupId(null);
    setSelectedIds((prev) => {
      const multi = ev.shiftKey || ev.metaKey || ev.ctrlKey;
      if (ev.altKey) return [ev.partId];
      if (multi) {
        return prev.includes(ev.partId)
          ? prev.filter((id) => id !== ev.partId)
          : [...prev, ev.partId];
      }
      if (prev.length === 1 && prev[0] === ev.partId) return [];
      if (prev.includes(ev.partId)) return prev.filter((id) => id !== ev.partId);
      return [...prev, ev.partId];
    });
  }, [busy, measureMode]);

  const onSurfaceHit = useCallback(
    (ev: SurfaceHitEvent) => {
      if (busy || measureMode === 'off') return;
      setMeasurePoints((prev) => {
        const next = [...prev, ev.point];
        if (next.length > 2) return [ev.point];
        return next;
      });
      setDockTab('size');
    },
    [busy, measureMode]
  );

  const clearMeasure = () => setMeasurePoints([]);

  const startMeasure = (mode: 'line' | 'radius') => {
    setMeasureMode(mode);
    setMeasurePoints([]);
    setDockTab('size');
    setStatus(
      mode === 'line'
        ? 'Size: click two points for a straight reference on the model.'
        : 'Size: click center, then a rim point for radius.'
    );
  };

  const applyMeasuredSize = () => {
    if (!model || measurePoints.length < 2 || measuredFeatureMm <= 1e-9) return;
    const scale = knownSizeMm / measuredFeatureMm;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const scaled = scalePartsUniform(model.parts, scale);
    commitEntry(
      entryFromParts({
        id: newId(),
        label: `Set size · ${formatNum(knownSizeMm)} mm`,
        detail:
          measureMode === 'radius'
            ? `Radius ${formatNum(measuredFeatureMm)} → ${formatNum(knownSizeMm)} mm (×${formatNum(scale)})`
            : `Length ${formatNum(measuredFeatureMm)} → ${formatNum(knownSizeMm)} mm (×${formatNum(scale)})`,
        at: Date.now(),
        name: model.name,
        parts: scaled,
        groups: cloneGroups(model.groups),
      })
    );
    setMeasureMode('off');
    setMeasurePoints([]);
    setStatus(
      `Applied size scale ×${formatNum(scale)} · reference now ${formatNum(knownSizeMm)} mm`
    );
  };

  const selectPartFromList = (partId: string, additive: boolean) => {
    setActiveGroupId(null);
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(partId) ? prev.filter((id) => id !== partId) : [...prev, partId];
      }
      return prev.length === 1 && prev[0] === partId ? [] : [partId];
    });
  };

  const selectGroup = (groupId: string) => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    setActiveGroupId(groupId);
    setSelectedIds([...g.partIds]);
  };

  const clearSelection = () => {
    setSelectedIds([]);
    setActiveGroupId(null);
  };

  const createGroupFromSelection = () => {
    if (!model || selectedIds.length === 0) return;
    const usedColors = model.groups.map((g) => g.color);
    const color = nextPaletteColor(usedColors);
    const group: PartGroup = {
      id: newId(),
      name: `Group ${model.groups.length + 1}`,
      color,
      partIds: [...selectedIds],
    };
    // Remove selected parts from other groups — share part geometry refs (no clone)
    const removed = new Set(selectedIds);
    const otherGroups = scrubGroups(model.groups, removed);
    commitEntry(
      entryFromParts({
        id: newId(),
        label: `Grouped ${selectedIds.length} part${selectedIds.length === 1 ? '' : 's'}`,
        detail: group.name,
        at: Date.now(),
        name: model.name,
        parts: model.parts,
        groups: [...otherGroups, group],
      })
    );
    setActiveGroupId(group.id);
    setStatus(`Created ${group.name} with ${selectedIds.length} part(s)`);
  };

  const ungroupActive = () => {
    if (!model || !activeGroup) return;
    const nextGroups = model.groups.filter((g) => g.id !== activeGroup.id);
    commitEntry(
      entryFromParts({
        id: newId(),
        label: `Ungrouped ${activeGroup.name}`,
        detail: `${activeGroup.partIds.length} parts released`,
        at: Date.now(),
        name: model.name,
        parts: model.parts,
        groups: cloneGroups(nextGroups),
      })
    );
    setActiveGroupId(null);
    setStatus(`Ungrouped ${activeGroup.name}`);
  };

  const targetPartIds = (): string[] => {
    if (activeGroup) return [...activeGroup.partIds];
    if (selectedIds.length > 0) return [...selectedIds];
    return parts.map((p) => p.id); // whole model
  };

  const targetLabel = (): string => {
    if (activeGroup) return activeGroup.name;
    if (selectedIds.length === 1) return '1 selected part';
    if (selectedIds.length > 1) return `${selectedIds.length} selected parts`;
    return 'entire model';
  };

  const replacePartsWithResult = (
    targetIds: string[],
    newGeometry: import('three').BufferGeometry,
    label: string,
    detail: string,
    keepGroupId?: string | null
  ) => {
    if (!model) {
      newGeometry.dispose();
      return;
    }
    const removed = new Set(targetIds);
    // Share unchanged part refs with previous history entry
    const kept = model.parts.filter((p) => !removed.has(p.id));
    const newPart = makePart(newGeometry);
    const nextParts = [...kept, newPart].sort((a, b) => b.triangleCount - a.triangleCount);
    const nextGroups = remapGroupsAfterReplace(
      cloneGroups(model.groups),
      removed,
      newPart.id,
      keepGroupId ?? undefined
    );
    commitEntry(
      entryFromParts({
        id: newId(),
        label,
        detail,
        at: Date.now(),
        name: model.name,
        parts: nextParts,
        groups: nextGroups,
      })
    );
    setSelectedIds([newPart.id]);
    if (keepGroupId && nextGroups.some((g) => g.id === keepGroupId)) {
      setActiveGroupId(keepGroupId);
    } else {
      setActiveGroupId(null);
    }
  };

  const runSimplify = async () => {
    if (!model || busy) return;
    const ids = targetPartIds();
    if (ids.length === 0) return;
    setBusy(true);
    setStatus(`Simplifying ${targetLabel()}…`);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const targets = model.parts.filter((p) => ids.includes(p.id));
      const merged = mergePartGeometries(targets);
      const beforeTris = totalStats(targets).triangleCount;
      const result = await simplifyMesh(merged, {
        ratio,
        targetError,
        prune,
        minFeatureSize: 0,
      });
      merged.dispose();
      const pct = Math.round(ratio * 100);
      replacePartsWithResult(
        ids,
        result.geometry,
        `Simplified ${targetLabel()} · keep ${pct}%`,
        `${formatCount(beforeTris)} → ${formatCount(result.triangleCount)} tris`,
        activeGroup?.id
      );
      setStatus(
        `Simplified ${targetLabel()} → ${formatCount(result.triangleCount)} tris (−${formatCount(result.removedTriangles)})`
      );
    } catch (err) {
      setStatus(`Simplify error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runRemoveDetails = () => {
    if (!model || busy) return;
    const ids = targetPartIds();
    if (ids.length === 0) return;
    setBusy(true);
    setStatus(`Removing small details in ${targetLabel()}…`);
    try {
      const targets = model.parts.filter((p) => ids.includes(p.id));
      const merged = mergePartGeometries(targets);
      const beforeTris = totalStats(targets).triangleCount;
      const result = removeSmallComponents(merged, minFeatureSize);
      merged.dispose();
      if (result.removedTriangles <= 0) {
        result.geometry.dispose();
        setStatus('No components smaller than the threshold were found in the target.');
        return;
      }
      replacePartsWithResult(
        ids,
        result.geometry,
        `Removed details in ${targetLabel()}`,
        `${formatCount(beforeTris)} → ${formatCount(result.triangleCount)} tris (< ${formatNum(minFeatureSize)})`,
        activeGroup?.id
      );
      setStatus(
        `Removed small details → ${formatCount(result.triangleCount)} tris (−${formatCount(result.removedTriangles)})`
      );
    } catch (err) {
      setStatus(`Remove error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Re-split a target into closed parts (useful after merges). */
  const resplitTarget = async () => {
    if (!model || busy) return;
    const ids = targetPartIds();
    if (ids.length === 0) return;
    setBusy(true);
    setStatus(`Re-detecting closed parts in ${targetLabel()}…`);
    try {
      const targets = model.parts.filter((p) => ids.includes(p.id));
      const merged = mergePartGeometries(targets);
      const split = await splitConnectedComponents(merged);
      merged.dispose();
      const removed = new Set(ids);
      const kept = model.parts.filter((p) => !removed.has(p.id));
      const nextParts = [...kept, ...split].sort((a, b) => b.triangleCount - a.triangleCount);
      const nextGroups = scrubGroups(cloneGroups(model.groups), removed);
      commitEntry(
        entryFromParts({
          id: newId(),
          label: `Re-split ${targetLabel()}`,
          detail: `${ids.length} → ${split.length} parts`,
          at: Date.now(),
          name: model.name,
          parts: nextParts,
          groups: nextGroups,
        }),
        true
      );
      setStatus(`Re-split into ${split.length} closed part(s)`);
    } catch (err) {
      setStatus(`Split error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const export3mf = () => {
    if (!model) return;
    try {
      setStatus('Exporting 3MF…');
      const merged = mergePartGeometries(model.parts);
      const data = exportGeometryTo3mf(merged, model.name.replace(/\.3mf$/i, ''));
      merged.dispose();
      download3mf(data, suggested3mfName(model.name));
      setStatus(`Exported ${suggested3mfName(model.name)} · ${formatCount(model.triangleCount)} tris`);
    } catch (err) {
      setStatus(`Export error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 3MF ≠ printable — synthesize estimated G-code + time from config JSON. */
  const sliceToGcodeEstimate = async (alsoDownload: boolean) => {
    if (!model || busy) return;
    setBusy(true);
    setStatus('Slicing estimate → G-code (config profile)…');
    try {
      await new Promise((r) => setTimeout(r, 30));
      const cfg = activePrintConfig ?? printConfig ?? (await loadPrintConfig());
      if (!printConfig) setPrintConfig(cfg);
      const pending =
        measurePoints.length >= 2 && Math.abs(pendingSizeScale - 1) > 1e-9 ? pendingSizeScale : 1;
      const estimate = estimatePrintFromConfig(model.parts, cfg, pending);
      const gcode = buildEstimateGcode(estimate, cfg, model.name);
      setHistory((prev) => {
        if (historyIndex < 0 || historyIndex >= prev.length) return prev;
        const next = [...prev];
        next[historyIndex] = {
          ...next[historyIndex],
          printEstimate: estimate,
          gcodeEstimate: gcode,
        };
        return next;
      });
      if (alsoDownload) {
        const base = model.name.replace(/\.3mf$/i, '') || 'model';
        downloadText(`${base}_a1mini_estimate.gcode`, gcode, 'text/x-gcode');
      }
      setDockTab('estimate');
      setStatus(
        `A1 Mini estimate ${estimate.label} (${estimate.hours.toFixed(2)} h) · scale×${estimate.scaleFactor}` +
          (alsoDownload ? ' · G-code downloaded' : '')
      );
    } catch (err) {
      setStatus(`Estimate error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const scopeHint =
    activeGroup
      ? `Scope: ${activeGroup.name} (${activeGroup.partIds.length} parts)`
      : selectedIds.length > 0
        ? `Scope: ${selectedIds.length} selected part${selectedIds.length === 1 ? '' : 's'}`
        : 'Scope: entire model';

  return (
    <div className="app tool-simplify">
      <header className="topbar tool-topbar">
        <div className="brand">
          <span className="brand-mark">3M</span>
          <div>
            <h1>3MF Model Simplifier</h1>
            <p>Select parts · group · simplify separately</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            Open .3mf
          </button>
          <button type="button" className="primary" onClick={() => void loadDefault()} disabled={busy}>
            Load MoonLamp
          </button>
          <button type="button" onClick={undo} disabled={busy || !canUndo}>
            Undo
          </button>
          <button type="button" onClick={redo} disabled={busy || !canRedo}>
            Redo
          </button>
          <button type="button" onClick={export3mf} disabled={busy || !model}>
            Export .3mf
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".3mf,model/3mf,application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
            hidden
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
      </header>

      <div className="workspace workspace-simplify">
        <aside className="panel left">
          <section>
            <h2>Model</h2>
            {model ? (
              <dl className="kv">
                <dt>File</dt>
                <dd className="mono truncate" title={model.name}>
                  {model.name}
                </dd>
                <dt>Triangles</dt>
                <dd className="mono">{formatCount(model.triangleCount)}</dd>
                <dt>Parts</dt>
                <dd className="mono">{parts.length}</dd>
                <dt>Groups</dt>
                <dd className="mono">{groups.length}</dd>
                <dt>BBox diagonal</dt>
                <dd className="mono">{formatNum(bboxDiag)} mm</dd>
              </dl>
            ) : (
              <p className="muted">No model loaded</p>
            )}
            <p className="muted tiny scope-hint">{scopeHint}</p>
          </section>

          <section>
            <h2>Print / size</h2>
            <p className="muted tiny">
              Use the <strong>bottom window</strong> under the 3D view: Estimate · Size · Parameters.
              Measure a line/radius to set real size, then slice to G-code.
            </p>
            <button type="button" className="wide" onClick={() => setDockTab('estimate')}>
              Focus estimate window
            </button>
            <button type="button" className="wide" onClick={() => startMeasure('radius')}>
              Measure radius (set size)
            </button>
          </section>

          <section>
            <h2>Selection</h2>
            <p className="muted tiny">
              Click parts in the 3D view to multi-select (colors differ). Shift/⌘-click also
              toggles. Alt-click = only that part.
            </p>
            <div className="row-actions">
              <button type="button" onClick={clearSelection} disabled={selectedIds.length === 0}>
                Clear
              </button>
              <button
                type="button"
                className="primary"
                onClick={createGroupFromSelection}
                disabled={!model || selectedIds.length === 0 || busy}
              >
                Group selection
              </button>
            </div>
            {selectedParts.length > 0 && (
              <p className="muted tiny">
                Selected {selectedParts.length}: {formatCount(totalStats(selectedParts).triangleCount)}{' '}
                tris
              </p>
            )}
            <ul className="part-list">
              {parts.slice(0, 80).map((p, i) => {
                const selected = selectedIds.includes(p.id);
                const group = groups.find((g) => g.partIds.includes(p.id));
                const color = resolvePartColor(p.id, selectedIds, groups);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={selected ? 'part-item selected' : 'part-item'}
                      onClick={(e) => selectPartFromList(p.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                      disabled={busy}
                    >
                      <span className="part-swatch" style={{ background: colorToCss(color) }} />
                      <span className="part-info">
                        <span className="part-name">
                          Part {i + 1}
                          {group ? ` · ${group.name}` : ''}
                        </span>
                        <span className="muted tiny">
                          {formatCount(p.triangleCount)} tris · size {formatNum(p.size)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {parts.length > 80 && (
              <p className="muted tiny">Showing 80 of {parts.length} parts — pick in 3D view too.</p>
            )}
          </section>

          <section>
            <h2>Groups</h2>
            {groups.length === 0 ? (
              <p className="muted tiny">No groups — select parts and click Group selection.</p>
            ) : (
              <ul className="group-list">
                {groups.map((g) => {
                  const gParts = parts.filter((p) => g.partIds.includes(p.id));
                  const active = activeGroupId === g.id;
                  return (
                    <li key={g.id}>
                      <button
                        type="button"
                        className={active ? 'group-item active' : 'group-item'}
                        onClick={() => selectGroup(g.id)}
                        disabled={busy}
                      >
                        <span className="part-swatch" style={{ background: colorToCss(g.color) }} />
                        <span className="part-info">
                          <span className="part-name">{g.name}</span>
                          <span className="muted tiny">
                            {g.partIds.length} parts · {formatCount(totalStats(gParts).triangleCount)}{' '}
                            tris
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="wide"
              onClick={ungroupActive}
              disabled={!activeGroup || busy}
            >
              Ungroup active
            </button>
          </section>

          <section>
            <h2>Decimate</h2>
            <p className="muted tiny">
              Runs on the active group, else the selection, else the whole model.
            </p>
            <label>
              Keep ratio
              <NumberInput step={0.01} min={0.01} max={1} value={ratio} onChange={setRatio} />
            </label>
            <label>
              Target error
              <NumberInput
                step={0.001}
                min={0.0001}
                max={1}
                value={targetError}
                onChange={setTargetError}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={prune}
                onChange={(e) => setPrune(e.target.checked)}
              />
              Prune tiny surfaces while decimating
            </label>
            <button
              type="button"
              className="primary wide"
              onClick={() => void runSimplify()}
              disabled={!model || busy}
            >
              Simplify {activeGroup ? 'group' : selectedIds.length ? 'selection' : 'model'}
            </button>
          </section>

          <section>
            <h2>Small details</h2>
            <label>
              Min feature size
              <NumberInput
                step={0.1}
                min={0}
                value={minFeatureSize}
                onChange={setMinFeatureSize}
              />
            </label>
            <button
              type="button"
              className="primary wide"
              onClick={runRemoveDetails}
              disabled={!model || busy || minFeatureSize <= 0}
            >
              Remove small details
            </button>
            <button
              type="button"
              className="wide"
              onClick={() => void resplitTarget()}
              disabled={!model || busy}
            >
              Re-detect closed parts
            </button>
          </section>

          <section>
            <h2>View</h2>
            <p className="muted tiny nav-hint">
              <strong>LMB / MMB drag</strong> pan (hand) · <strong>RMB</strong> or{' '}
              <strong>Shift+LMB</strong> orbit · <strong>scroll</strong> zoom ·{' '}
              <strong>click</strong> select part · trackpad: one-finger pan, two-finger orbit/zoom.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
              Wireframe
            </label>
            <button
              type="button"
              className="wide"
              onClick={() => setResetKey((k) => k + 1)}
              disabled={!model}
            >
              Reset camera
            </button>
          </section>
        </aside>

        <main className="viewport-wrap">
          <div className="viewport-stage">
            <MeshViewer3D
              parts={viewerParts}
              wireframe={wireframe}
              resetKey={resetKey}
              pickEnabled={!busy}
              measureMode={measureMode}
              measurePoints={measurePoints}
              onPartClick={onPartClick}
              onSurfaceHit={onSurfaceHit}
            />
            {busy && <div className="viewport-busy">Working…</div>}
            {measureMode !== 'off' && (
              <div className="measure-banner">
                Measuring {measureMode === 'line' ? 'line' : 'radius'} — click model (
                {measurePoints.length}/2) · RMB orbit · LMB drag pan
              </div>
            )}
          </div>

          <div className="estimate-dock">
            <div className="estimate-dock-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={dockTab === 'estimate' ? 'active' : ''}
                onClick={() => setDockTab('estimate')}
              >
                Estimate
              </button>
              <button
                type="button"
                role="tab"
                className={dockTab === 'size' ? 'active' : ''}
                onClick={() => setDockTab('size')}
              >
                Size
              </button>
              <button
                type="button"
                role="tab"
                className={dockTab === 'params' ? 'active' : ''}
                onClick={() => setDockTab('params')}
              >
                Parameters
              </button>
            </div>

            <div className="estimate-dock-body">
              {dockTab === 'estimate' && (
                <div className="dock-pane dock-estimate">
                  <div className="dock-estimate-main">
                    <div className="dock-time mono">
                      {liveEstimate?.label ?? model?.printEstimate?.label ?? '—'}
                    </div>
                    <div className="muted tiny">
                      {liveEstimate
                        ? `${liveEstimate.printerName} · ${liveEstimate.hours.toFixed(2)} h · ${formatCount(liveEstimate.layers)} layers`
                        : 'Load a model / set size to see live time'}
                    </div>
                    {measurePoints.length >= 2 && Math.abs(pendingSizeScale - 1) > 1e-6 && (
                      <div className="muted tiny">
                        Includes pending size ×{formatNum(pendingSizeScale)} (apply on Size tab)
                      </div>
                    )}
                  </div>
                  <div className="dock-estimate-meta">
                    <dl className="kv compact">
                      <dt>History</dt>
                      <dd className="mono">
                        {historyIndex + 1}/{history.length}
                      </dd>
                      <dt>Mesh vol</dt>
                      <dd className="mono">
                        {liveEstimate ? `${formatNum(liveEstimate.volumeMm3)} mm³` : '—'}
                      </dd>
                      <dt>Filament</dt>
                      <dd className="mono">
                        {liveEstimate ? `${formatNum(liveEstimate.filamentMeters)} m` : '—'}
                      </dd>
                      <dt>Sliced</dt>
                      <dd className="mono">{model?.printEstimate?.label ?? 'not sliced'}</dd>
                    </dl>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={!model || busy}
                        onClick={() => void sliceToGcodeEstimate(false)}
                      >
                        Slice → G-code
                      </button>
                      <button
                        type="button"
                        disabled={!model || busy}
                        onClick={() => void sliceToGcodeEstimate(true)}
                      >
                        Download .gcode
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {dockTab === 'size' && (
                <div className="dock-pane dock-size">
                  <p className="muted tiny">
                    Pick a straight edge or radius on the model, then enter the real size. MoonLamp:
                    measure diameter as a <strong>line</strong> → 350 mm, or <strong>radius</strong> →
                    175 mm.
                  </p>
                  <div className="row-actions">
                    <button
                      type="button"
                      className={measureMode === 'line' ? 'primary' : ''}
                      disabled={!model || busy}
                      onClick={() => startMeasure('line')}
                    >
                      Measure line
                    </button>
                    <button
                      type="button"
                      className={measureMode === 'radius' ? 'primary' : ''}
                      disabled={!model || busy}
                      onClick={() => startMeasure('radius')}
                    >
                      Measure radius
                    </button>
                    <button
                      type="button"
                      disabled={measurePoints.length === 0 && measureMode === 'off'}
                      onClick={() => {
                        setMeasureMode('off');
                        clearMeasure();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="dock-size-grid">
                    <label>
                      Measured ({measureMode === 'radius' ? 'radius' : 'length'})
                      <input
                        type="text"
                        className="mono"
                        readOnly
                        value={
                          measuredFeatureMm > 0 ? `${formatNum(measuredFeatureMm)} model-mm` : '—'
                        }
                      />
                    </label>
                    <label>
                      {measureMode === 'radius' ? 'Real radius (mm)' : 'Real length (mm)'}
                      <NumberInput
                        step={0.1}
                        min={0.01}
                        value={knownSizeMm}
                        onChange={setKnownSizeMm}
                      />
                    </label>
                    <label>
                      Scale factor
                      <input
                        type="text"
                        className="mono"
                        readOnly
                        value={
                          measurePoints.length >= 2 ? `×${formatNum(pendingSizeScale)}` : '—'
                        }
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={!model || busy || measurePoints.length < 2}
                    onClick={applyMeasuredSize}
                  >
                    Apply size to model
                  </button>
                </div>
              )}

              {dockTab === 'params' && (
                <div className="dock-pane dock-params">
                  <p className="muted tiny">
                    Live overrides for this session (base file{' '}
                    <a className="config-link" href={PRINT_CONFIG_URL} target="_blank" rel="noreferrer">
                      bambu-a1-mini-print.json
                    </a>
                    ).
                  </p>
                  <div className="dock-params-grid">
                    <label>
                      Nozzle (mm)
                      <NumberInput step={0.05} min={0.1} max={1} value={paramNozzle} onChange={setParamNozzle} />
                    </label>
                    <label>
                      Layer (mm)
                      <NumberInput step={0.01} min={0.04} max={0.4} value={paramLayer} onChange={setParamLayer} />
                    </label>
                    <label>
                      Walls
                      <NumberInput step={1} min={1} max={12} value={paramWalls} onChange={setParamWalls} />
                    </label>
                    <label>
                      Infill %
                      <NumberInput step={1} min={0} max={100} value={paramInfill} onChange={setParamInfill} />
                    </label>
                    <label>
                      Time scale
                      <NumberInput
                        step={0.001}
                        min={0.01}
                        max={5}
                        value={paramTimeScale}
                        onChange={setParamTimeScale}
                      />
                    </label>
                  </div>
                  <p className="muted tiny">
                    Default scale 0.4951 calibrates full MoonLamp (~35 cm) to 39.9 h.
                  </p>
                </div>
              )}
            </div>
          </div>
        </main>

        <aside className="panel right">
          <section className="history-section">
            <div className="history-head">
              <h2>History</h2>
              <div className="history-nav">
                <button type="button" onClick={undo} disabled={busy || !canUndo}>
                  ←
                </button>
                <button type="button" onClick={redo} disabled={busy || !canRedo}>
                  →
                </button>
              </div>
            </div>
            <p className="muted tiny">Newest on top. Click a step to restore. Delete removes the latest.</p>
            {history.length === 0 ? (
              <p className="muted">No history yet</p>
            ) : (
              <ul className="history-timeline" ref={timelineRef}>
                {[...history].map((entry, i) => ({ entry, i })).reverse().map(({ entry, i }) => {
                  const active = i === historyIndex;
                  const future = i > historyIndex;
                  const isLatest = i === latestIndex;
                  const delta =
                    i === 0 ? null : entry.triangleCount - history[i - 1].triangleCount;
                  const prevEst = i > 0 ? history[i - 1].printEstimate : null;
                  const printDeltaSec =
                    entry.printEstimate && prevEst
                      ? entry.printEstimate.seconds - prevEst.seconds
                      : null;
                  return (
                    <li key={entry.id} className={isLatest ? 'history-row latest' : 'history-row'}>
                      <button
                        type="button"
                        className={
                          active
                            ? 'history-item active'
                            : future
                              ? 'history-item future'
                              : 'history-item'
                        }
                        disabled={busy || active}
                        onClick={() => goToHistory(i)}
                      >
                        <span className="history-dot" aria-hidden />
                        <span className="history-body">
                          <span className="history-label">
                            <span className="history-step mono">#{i + 1}</span>
                            {entry.label}
                            {isLatest && <span className="history-latest-tag">latest</span>}
                          </span>
                          <span className="history-print mono">
                            {entry.printEstimate
                              ? <>A1 Mini ≈ {entry.printEstimate.label}
                                {printDeltaSec != null && Math.abs(printDeltaSec) >= 30 && (
                                  <span className="muted">
                                    {' '}
                                    (
                                    {printDeltaSec < 0
                                      ? `−${formatPrintDelta(-printDeltaSec)}`
                                      : `+${formatPrintDelta(printDeltaSec)}`}
                                    )
                                  </span>
                                )}
                              </>
                              : <span className="muted">not sliced</span>}
                          </span>
                          <span className="history-meta muted tiny">
                            {formatTime(entry.at)} · {formatCount(entry.triangleCount)} tris ·{' '}
                            {entry.parts.length} parts
                            {delta != null && (
                              <>
                                {' '}
                                (
                                {delta === 0
                                  ? '±0'
                                  : delta < 0
                                    ? `−${formatCount(-delta)}`
                                    : `+${formatCount(delta)}`}
                                )
                              </>
                            )}
                          </span>
                          {entry.detail && (
                            <span className="history-detail muted tiny">{entry.detail}</span>
                          )}
                        </span>
                      </button>
                      {isLatest && history.length > 1 && (
                        <button
                          type="button"
                          className="history-delete"
                          title="Delete latest step"
                          disabled={!canDeleteLatest}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteLatest(true);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {history.length > 1 && (
              <button
                type="button"
                className="wide"
                disabled={busy || historyIndex === 0}
                onClick={() => goToHistory(0)}
              >
                Jump to original
              </button>
            )}
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
          {model
            ? `${formatCount(model.triangleCount)} tris · ${
                model.printEstimate
                  ? `A1 Mini ≈ ${model.printEstimate.label}`
                  : 'not sliced'
              } · hist ${historyIndex + 1}/${history.length}`
            : 'No model'}
        </span>
      </footer>

      {confirmDeleteLatest && history.length > 1 && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => setConfirmDeleteLatest(false)}
        >
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-history-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-history-title">Delete latest history step?</h3>
            <p>
              Remove <strong>{history[latestIndex]?.label}</strong> and reverse to the previous
              state
              {history[latestIndex - 1]
                ? ` (“${history[latestIndex - 1].label}”)`
                : ''}
              . This cannot be redone.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirmDeleteLatest(false)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={deleteLatestHistory}>
                Delete & reverse
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
