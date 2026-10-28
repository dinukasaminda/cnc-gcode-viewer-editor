import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatcamHelper, type GcodeRewriteRequest } from '../components/FlatcamHelper';
import { NumberInput } from '../components/NumberInput';
import { Viewer3D } from '../components/Viewer3D';
import { formatMm, formatMmMin, formatNum, formatPct, roundMm } from '../core/format';
import { parseGCode } from '../core/gcodeParser';
import {
  downloadTextFile,
  rewriteGCodeCutZ,
  suggestedDownloadName,
} from '../core/gcodeRewrite';
import { concatTimeline } from '../core/materialRemoval';
import { applyMaterialRemoval } from '../core/materialRemoval';
import { stockFromBounds } from '../core/stock';
import type { HeightFieldStock } from '../core/stock';
import { guessToolFromMetadata, toolLabel, vbitEffectiveDiameter } from '../core/tools';
import { validateJobs } from '../core/validator';
import {
  COPPER_THICKNESS_PRESETS,
  DEFAULT_STOCK,
  DEFAULT_VBIT,
  JOB_COLORS,
  STANDARD_COPPER_THICKNESS_MM,
  type CameraMode,
  type JobFile,
  type Measurement,
  type SimulationState,
  type StockSettings,
  type Tool,
  type ViewMode,
} from '../core/types';
import type { WorkerRequest, WorkerResponse } from '../workers/simulate.worker';
import { stockFromWorkerResult } from '../core/stockFromBuffers';
import '../App.css';

const SAMPLE = '/samples/00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc';

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

const idleSim: SimulationState = {
  playing: false,
  speed: 1,
  segmentIndex: 0,
  progress: 0,
  x: 0,
  y: 0,
  z: 0,
  feedrate: 0,
  spindleOn: false,
  spindleRpm: 0,
  activeTool: '—',
  currentLine: '',
  lineNumber: 0,
};

export default function PcbGcodeViewer() {
  const [jobs, setJobs] = useState<JobFile[]>([]);
  const [stock, setStock] = useState<StockSettings>({ ...DEFAULT_STOCK });
  const [field, setField] = useState<HeightFieldStock | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('final');
  const [cameraMode, setCameraMode] = useState<CameraMode>('top');
  // Confirmed: G-code +X must be mirrored in the viewer so copper text/traces read correctly
  const [flipX, setFlipX] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [sim, setSim] = useState<SimulationState>(idleSim);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [grooveWidth, setGrooveWidth] = useState(0);
  const [status, setStatus] = useState('Load a FlatCAM .nc file to preview the final PCB.');
  const [resetViewKey, setResetViewKey] = useState(0);
  const [helperResetKey, setHelperResetKey] = useState(0);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<{ x: number; y: number; z: number }[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const simTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Clear prior job UI/session state when opening a new file. */
  const resetSessionForNewFile = useCallback(() => {
    if (simTimer.current) {
      window.clearInterval(simTimer.current);
      simTimer.current = null;
    }
    setField(null);
    setSim(idleSim);
    setBusy(false);
    setProgress(0);
    setGrooveWidth(0);
    setMeasureMode(false);
    setMeasurePoints([]);
    setMeasurements([]);
    setStock({ ...DEFAULT_STOCK });
    setViewMode('final');
    setCameraMode('top');
    setResetViewKey((k) => k + 1);
    setHelperResetKey((k) => k + 1);
  }, []);

  const warnings = useMemo(() => validateJobs(jobs, stock), [jobs, stock]);
  const timeline = useMemo(() => concatTimeline(jobs), [jobs]);
  const activeVbit = useMemo(() => {
    const j = jobs.find((x) => x.enabled && x.tool.type === 'vbit');
    if (!j || j.tool.type !== 'vbit') return null;
    return {
      job: j,
      tipWidthMm: roundMm(j.tool.tipDiameter),
      angleDeg: roundMm(j.tool.angle),
      cutDepthMm:
        j.parse?.metadata.zCut != null
          ? roundMm(Math.abs(j.parse.metadata.zCut))
          : undefined,
      gcodeToolDiaMm:
        j.parse?.metadata.toolDiameter != null
          ? roundMm(j.parse.metadata.toolDiameter)
          : undefined,
    };
  }, [jobs]);

  const runSimulation = useCallback(
    (jobList: JobFile[], stockCfg: StockSettings, upto?: number) => {
      setBusy(true);
      setProgress(0);
      setStatus('Simulating material removal…');

      // Prefer worker; fall back to main thread
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(
            new URL('../workers/simulate.worker.ts', import.meta.url),
            { type: 'module' }
          );
        }
        const worker = workerRef.current;
        const onMsg = (ev: MessageEvent<WorkerResponse>) => {
          const res = ev.data;
          if (res.type === 'progress') {
            setProgress(res.progress ?? 0);
            return;
          }
          worker.removeEventListener('message', onMsg);
          if (res.type === 'error') {
            setBusy(false);
            setStatus(`Simulation error: ${res.message}`);
            return;
          }
          try {
            const s = stockFromWorkerResult(res);
            setField(s);
            setGrooveWidth(res.effectiveGrooveWidthMm ?? 0);
            setBusy(false);
            setProgress(1);
            setStatus(
              `Done — ${res.appliedSegments ?? 0} cut segments` +
                (res.effectiveGrooveWidthMm
                  ? `, avg V-groove ≈ ${formatMm(res.effectiveGrooveWidthMm)}`
                  : '')
            );
          } catch (e) {
            setBusy(false);
            setStatus(String(e));
          }
        };
        worker.addEventListener('message', onMsg);
        const req: WorkerRequest = {
          type: 'simulate',
          jobs: jobList,
          stock: stockCfg,
          uptoGlobalIndex: upto,
        };
        worker.postMessage(req);
      } catch {
        // Main-thread fallback
        const result = applyMaterialRemoval(jobList, stockCfg, {
          uptoGlobalIndex: upto,
          onProgress: (p) => setProgress(p.progress),
        });
        setField(result.stock);
        setGrooveWidth(result.effectiveGrooveWidthMm);
        setBusy(false);
        setProgress(1);
        setStatus(
          `Done — ${result.appliedSegments} cut segments, avg V-groove ≈ ${formatMm(result.effectiveGrooveWidthMm)}`
        );
      }
    },
    []
  );

  const ingestText = useCallback(
    async (name: string, text: string) => {
      resetSessionForNewFile();
      const parse = parseGCode(text);
      // FlatCAM TOOL DIAMETER comment = effective Tool Dia at Cut Z, not V tip width
      const tool = guessToolFromMetadata(
        parse.metadata.toolDiameter,
        name,
        parse.metadata.zCut
      );
      const job: JobFile = {
        id: newId(),
        name,
        source: text,
        enabled: true,
        tool,
        parse,
        color: JOB_COLORS[0],
      };
      const nextJobs = [job];
      setJobs(nextJobs);

      const nextStock = stockFromBounds(parse.bounds, { ...DEFAULT_STOCK });
      setStock(nextStock);
      setStatus(`Loaded ${name}`);
      runSimulation(nextJobs, nextStock);
    },
    [resetSessionForNewFile, runSimulation]
  );

  const loadSample = useCallback(async () => {
    setStatus('Loading sample…');
    const res = await fetch(SAMPLE);
    const text = await res.text();
    await ingestText('00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc', text);
  }, [ingestText]);

  // Auto-load sample on first visit
  useEffect(() => {
    loadSample().catch((e) => setStatus(String(e)));
    return () => {
      workerRef.current?.terminate();
      if (simTimer.current) window.clearInterval(simTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    // Open replaces any existing job and resets session state
    resetSessionForNewFile();
    const file = fileList[0];
    const text = await file.text();
    const parse = parseGCode(text);
    const tool = guessToolFromMetadata(
      parse.metadata.toolDiameter,
      file.name,
      parse.metadata.zCut
    );
    const job: JobFile = {
      id: newId(),
      name: file.name,
      source: text,
      enabled: true,
      tool,
      parse,
      color: JOB_COLORS[0],
    };
    const nextJobs = [job];
    const nextStock = stockFromBounds(parse.bounds, { ...DEFAULT_STOCK });
    setJobs(nextJobs);
    setStock(nextStock);
    setStatus(`Loaded ${file.name}`);
    runSimulation(nextJobs, nextStock);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateJobTool = (id: string, tool: Tool) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, tool } : j)));
  };

  const applyRewriteToActiveJob = useCallback(
    (req: GcodeRewriteRequest, alsoDownload: boolean) => {
      const target = jobs.find((j) => j.enabled && j.tool.type === 'vbit') ?? jobs[0];
      if (!target) {
        setStatus('Load a V-bit / isolation .nc file first.');
        return;
      }
      const result = rewriteGCodeCutZ(target.source, {
        toolDiaMm: req.toolDiaMm,
        tipWidthMm: req.tipWidthMm,
        angleDeg: req.angleDeg,
        cutZMm: req.cutZMm,
      });
      const parse = parseGCode(result.text);
      const tool: Tool = {
        type: 'vbit',
        tipDiameter: req.tipWidthMm,
        angle: req.angleDeg,
        shankDiameter: 3.175,
      };
      const updated: JobFile = {
        ...target,
        source: result.text,
        tool,
        parse,
        name: target.name.replace(/\.nc$/i, '') + `_Z${formatNum(result.newCutZ)}.nc`,
      };
      const next = jobs.map((j) => (j.id === target.id ? updated : j));
      setJobs(next);
      setSim(idleSim);
      runSimulation(next, stock);
      setStatus(
        `Rewrote G-code: Tool Dia ${formatMm(result.toolDiaMm)} → Cut Z ${formatMm(result.newCutZ)}` +
          ` (${result.replacedZCount} Z words updated)`
      );
      if (alsoDownload) {
        downloadTextFile(
          suggestedDownloadName(target.name, result.toolDiaMm, result.newCutZ),
          result.text
        );
      }
    },
    [jobs, stock, runSimulation]
  );

  const toggleJob = (id: string) => {
    setJobs((prev) => {
      const next = prev.map((j) => (j.id === id ? { ...j, enabled: !j.enabled } : j));
      runSimulation(next, stock);
      return next;
    });
  };

  const removeJob = (id: string) => {
    setJobs((prev) => {
      const next = prev.filter((j) => j.id !== id);
      runSimulation(next, stock);
      return next;
    });
  };

  const autoDetectBounds = () => {
    const enabled = jobs.filter((j) => j.enabled && j.parse);
    if (!enabled.length) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const j of enabled) {
      const b = j.parse!.bounds;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const next = stockFromBounds({ minX, minY, maxX, maxY }, stock);
    setStock(next);
    runSimulation(jobs, next);
  };

  const applyStock = () => runSimulation(jobs, stock);

  // Playback
  useEffect(() => {
    if (!sim.playing) {
      if (simTimer.current) {
        window.clearInterval(simTimer.current);
        simTimer.current = null;
      }
      return;
    }
    simTimer.current = window.setInterval(() => {
      setSim((prev) => {
        const nextIdx = prev.segmentIndex + Math.max(1, Math.round(prev.speed * 2));
        if (nextIdx >= timeline.length) {
          return { ...prev, playing: false, progress: 1, segmentIndex: timeline.length };
        }
        const item = timeline[nextIdx];
        return {
          ...prev,
          segmentIndex: nextIdx,
          progress: nextIdx / Math.max(1, timeline.length),
          x: item.seg.x1,
          y: item.seg.y1,
          z: item.seg.z1,
          feedrate: item.seg.feedrate,
          spindleOn: item.seg.spindleOn,
          spindleRpm: item.seg.spindleRpm,
          activeTool: toolLabel(item.job.tool),
          currentLine: item.seg.raw,
          lineNumber: item.seg.lineNumber,
        };
      });
    }, 50);
    return () => {
      if (simTimer.current) window.clearInterval(simTimer.current);
    };
  }, [sim.playing, sim.speed, timeline]);

  const jumpFinal = () => {
    setSim((s) => ({ ...s, playing: false, segmentIndex: timeline.length, progress: 1 }));
    runSimulation(jobs, stock);
  };

  const stepSim = () => {
    setSim((prev) => {
      const nextIdx = Math.min(timeline.length - 1, prev.segmentIndex + 1);
      if (nextIdx < 0 || !timeline.length) return prev;
      const item = timeline[nextIdx];
      return {
        ...prev,
        playing: false,
        segmentIndex: nextIdx,
        progress: nextIdx / Math.max(1, timeline.length),
        x: item.seg.x1,
        y: item.seg.y1,
        z: item.seg.z1,
        feedrate: item.seg.feedrate,
        spindleOn: item.seg.spindleOn,
        spindleRpm: item.seg.spindleRpm,
        activeTool: toolLabel(item.job.tool),
        currentLine: item.seg.raw,
        lineNumber: item.seg.lineNumber,
      };
    });
  };

  const onMeasureClick = useCallback(
    (p: { x: number; y: number; z: number }) => {
      setMeasurePoints((prev) => {
        const next = [...prev, p];
        if (next.length >= 2) {
          const a = next[0];
          const b = next[1];
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const depthA = field?.sampleDepth(a.x, a.y) ?? 0;
          const depthB = field?.sampleDepth(b.x, b.y) ?? 0;
          setMeasurements((ms) => [
            ...ms,
            {
              id: newId(),
              kind: 'distance',
              label: `Distance ${formatMm(dist)} (depths ${formatMm(depthA)} / ${formatMm(depthB)})`,
              valueMm: dist,
              points: [a, b],
            },
          ]);
          return [];
        }
        return next;
      });
    },
    [field]
  );

  const expectedVbitWidth = useMemo(() => {
    const iso = jobs.find((j) => j.enabled && j.tool.type === 'vbit');
    if (!iso || iso.tool.type !== 'vbit') return null;
    const zCut = iso.parse?.metadata.zCut;
    const depth = zCut != null ? Math.abs(zCut) : 0.1;
    return vbitEffectiveDiameter(iso.tool.tipDiameter, iso.tool.angle, depth);
  }, [jobs]);

  const toolPos =
    sim.segmentIndex > 0 && timeline[Math.min(sim.segmentIndex, timeline.length - 1)]
      ? {
          x: sim.x,
          y: sim.y,
          z: sim.z,
        }
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">NC</span>
          <div>
            <h1>PCB CNC Simulator</h1>
            <p>Final board preview from FlatCAM G-code</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Open .nc
          </button>
          <button type="button" className="primary" onClick={loadSample} disabled={busy}>
            Load sample
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".nc,.gcode,.ngc,.txt"
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>
      </header>

      <div className="workspace">
        <aside className="panel left">
          <section>
            <h2>G-code files</h2>
            {jobs.length === 0 && <p className="muted">No files loaded</p>}
            <ul className="job-list">
              {jobs.map((j) => (
                <li key={j.id}>
                  <label className="job-head">
                    <input
                      type="checkbox"
                      checked={j.enabled}
                      onChange={() => toggleJob(j.id)}
                    />
                    <span className="swatch" style={{ background: j.color }} />
                    <span className="job-name" title={j.name}>
                      {j.name}
                    </span>
                    <button type="button" className="icon" onClick={() => removeJob(j.id)}>
                      ×
                    </button>
                  </label>
                  <div className="tool-edit">
                    <select
                      value={j.tool.type}
                      onChange={(e) => {
                        const t = e.target.value as Tool['type'];
                        if (t === 'vbit') updateJobTool(j.id, { ...DEFAULT_VBIT });
                        else if (t === 'drill')
                          updateJobTool(j.id, { type: 'drill', diameter: 1 });
                        else updateJobTool(j.id, { type: 'endmill', diameter: 1 });
                      }}
                    >
                      <option value="vbit">V-bit</option>
                      <option value="endmill">End mill</option>
                      <option value="drill">Drill</option>
                    </select>
                    {j.tool.type === 'vbit' && (
                      <>
                        <label title="Physical V-bit tip width — not FlatCAM Tool Dia">
                          V tip width (mm)
                          <NumberInput
                            step={0.001}
                            min={0}
                            value={j.tool.tipDiameter}
                            onChange={(v) =>
                              updateJobTool(j.id, {
                                ...j.tool,
                                tipDiameter: v,
                              } as Tool)
                            }
                          />
                        </label>
                        <label>
                          V angle (°)
                          <NumberInput
                            step={0.001}
                            min={0}
                            value={j.tool.angle}
                            onChange={(v) =>
                              updateJobTool(j.id, {
                                ...j.tool,
                                angle: v || 30,
                              } as Tool)
                            }
                          />
                        </label>
                        <p className="muted tiny tool-eff">
                          Effective @ |Cut Z|{' '}
                          {formatMm(Math.abs(j.parse?.metadata.zCut ?? 0.1))} →{' '}
                          <strong>
                            {formatMm(
                              vbitEffectiveDiameter(
                                j.tool.tipDiameter,
                                j.tool.angle,
                                Math.abs(j.parse?.metadata.zCut ?? 0.1)
                              )
                            )}
                          </strong>{' '}
                          (= FlatCAM Tool Dia)
                          {j.parse?.metadata.toolDiameter != null && (
                            <>
                              {' '}
                              · G-code said {formatMm(j.parse.metadata.toolDiameter)}
                            </>
                          )}
                        </p>
                      </>
                    )}
                    {(j.tool.type === 'drill' || j.tool.type === 'endmill') && (
                      <label>
                        Diameter (FlatCAM Tool Dia) (mm)
                        <NumberInput
                          step={0.001}
                          min={0}
                          value={j.tool.diameter}
                          onChange={(v) =>
                            updateJobTool(j.id, {
                              ...j.tool,
                              diameter: v,
                            } as Tool)
                          }
                        />
                      </label>
                    )}
                  </div>
                  <p className="muted tiny">
                    {j.parse?.segments.length ?? 0} moves · Z mode{' '}
                    {j.parse?.zConvention ?? '—'}
                  </p>
                </li>
              ))}
            </ul>
            <div className="row">
              <button
                type="button"
                disabled={busy}
                onClick={() => runSimulation(jobs, stock)}
              >
                Re-simulate tools
              </button>
              <button
                type="button"
                disabled={!jobs[0]}
                onClick={() => {
                  const j = jobs.find((x) => x.enabled) ?? jobs[0];
                  if (!j) return;
                  downloadTextFile(j.name, j.source);
                }}
              >
                Download current .nc
              </button>
            </div>
          </section>

          <FlatcamHelper
            key={activeVbit?.job.id ?? 'no-vbit'}
            tipWidthMm={activeVbit?.tipWidthMm}
            angleDeg={activeVbit?.angleDeg}
            cutDepthMm={activeVbit?.cutDepthMm}
            gcodeToolDiaMm={activeVbit?.gcodeToolDiaMm}
            copperThicknessMm={stock.copperThickness}
            hasActiveJob={Boolean(activeVbit || jobs[0])}
            resetKey={helperResetKey}
            onApplyToTool={(tool) => {
              if (!activeVbit) return;
              const next = jobs.map((j) =>
                j.id === activeVbit.job.id ? { ...j, tool } : j
              );
              setJobs(next);
              runSimulation(next, stock);
            }}
            onRewriteAndResimulate={(req) => applyRewriteToActiveJob(req, false)}
            onDownloadRewritten={(req) => applyRewriteToActiveJob(req, true)}
          />

          <section>
            <h2>Stock</h2>
            <div className="grid2">
              {(
                [
                  ['width', 'Width'],
                  ['height', 'Height'],
                  ['thickness', 'Board thickness'],
                  ['originX', 'Origin X'],
                  ['originY', 'Origin Y'],
                  ['surfaceZ', 'Surface Z'],
                  ['margin', 'Margin'],
                  ['resolution', 'Resolution'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <NumberInput
                    step={key === 'resolution' ? 0.001 : 0.1}
                    min={0}
                    value={stock[key]}
                    onChange={(v) => setStock({ ...stock, [key]: v })}
                  />
                </label>
              ))}
            </div>

            <div className="copper-height">
              <label>
                Copper layer height (mm)
                <NumberInput
                  step={0.001}
                  min={0.001}
                  value={stock.copperThickness}
                  onChange={(v) =>
                    setStock({
                      ...stock,
                      copperThickness: Math.max(0.001, v),
                    })
                  }
                />
              </label>
              <p className="muted tiny">
                Default / standard ={' '}
                <strong>{formatMm(STANDARD_COPPER_THICKNESS_MM)}</strong> (1 oz copper cladding)
                {Math.abs(stock.copperThickness - STANDARD_COPPER_THICKNESS_MM) > 1e-6 && (
                  <> · current differs from standard</>
                )}
              </p>
              <div className="row">
                {COPPER_THICKNESS_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={
                      Math.abs(stock.copperThickness - p.mm) < 1e-6 ? 'primary' : ''
                    }
                    onClick={() => setStock({ ...stock, copperThickness: p.mm })}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setStock({
                      ...stock,
                      copperThickness: STANDARD_COPPER_THICKNESS_MM,
                    })
                  }
                  disabled={
                    Math.abs(stock.copperThickness - STANDARD_COPPER_THICKNESS_MM) < 1e-6
                  }
                >
                  Reset to standard
                </button>
              </div>
            </div>

            <label>
              Z convention
              <select
                value={stock.zMode}
                onChange={(e) =>
                  setStock({
                    ...stock,
                    zMode: e.target.value as StockSettings['zMode'],
                  })
                }
              >
                <option value="auto">Auto</option>
                <option value="standard">Standard (Z− into stock)</option>
                <option value="positive-depth">Positive cut depth</option>
              </select>
            </label>
            <div className="row">
              <button type="button" onClick={autoDetectBounds}>
                Auto-detect bounds
              </button>
              <button type="button" className="primary" onClick={applyStock} disabled={busy}>
                Apply stock
              </button>
            </div>
          </section>

          <section>
            <h2>View</h2>
            <label>
              Display
              <select
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as ViewMode)}
              >
                <option value="final">Final PCB</option>
                <option value="toolpaths">Toolpaths</option>
                <option value="final+toolpaths">Final + toolpaths</option>
                <option value="copper-removal">Copper removal only</option>
                <option value="depth-heatmap">Depth heatmap</option>
              </select>
            </label>
            <label>
              Camera
              <select
                value={cameraMode}
                onChange={(e) => setCameraMode(e.target.value as CameraMode)}
              >
                <option value="perspective">Perspective 3D</option>
                <option value="top">Top view</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={showAxes}
                onChange={(e) => setShowAxes(e.target.checked)}
              />
              Show X / Y / Z axes
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={flipX}
                onChange={(e) => setFlipX(e.target.checked)}
              />
              Flip X direction (on = correct)
            </label>
            <p className="muted tiny">
              Default view: X left→right, Y bottom→up (top plan). Red = X+, Green =
              Y+, Blue = Z+ (out of board). Origin is G-code (0,0,0).
            </p>
            <button type="button" onClick={() => setResetViewKey((k) => k + 1)}>
              Reset view
            </button>
          </section>
        </aside>

        <main className="center">
          <Viewer3D
            stock={field}
            jobs={jobs}
            viewMode={viewMode}
            cameraMode={cameraMode}
            toolPos={toolPos}
            measureMode={measureMode}
            measurePoints={measurePoints}
            onMeasureClick={onMeasureClick}
            measurements={measurements}
            resetViewKey={resetViewKey}
            flipX={flipX}
            showAxes={showAxes}
          />
          {busy && (
            <div className="overlay">
              <div className="spinner" />
              <p>Simulating… {formatPct(progress)}</p>
            </div>
          )}
        </main>

        <aside className="panel right">
          <section>
            <h2>Simulation</h2>
            <dl className="stats">
              <div>
                <dt>X</dt>
                <dd>{formatMm(sim.x)}</dd>
              </div>
              <div>
                <dt>Y</dt>
                <dd>{formatMm(sim.y)}</dd>
              </div>
              <div>
                <dt>Z</dt>
                <dd>{formatMm(sim.z)}</dd>
              </div>
              <div>
                <dt>F</dt>
                <dd>{formatMmMin(sim.feedrate)}</dd>
              </div>
              <div>
                <dt>Spindle</dt>
                <dd>
                  {sim.spindleOn ? `ON ${formatNum(sim.spindleRpm)}` : 'OFF'}
                </dd>
              </div>
              <div>
                <dt>Tool</dt>
                <dd>{sim.activeTool}</dd>
              </div>
              <div>
                <dt>Line</dt>
                <dd>{sim.lineNumber || '—'}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{formatPct(sim.progress)}</dd>
              </div>
            </dl>
            {expectedVbitWidth != null && (
              <p className="callout">
                Effective groove (FlatCAM Tool Dia) ≈{' '}
                <strong>{formatMm(expectedVbitWidth)}</strong>
                {grooveWidth > 0 && (
                  <>
                    {' '}
                    · simulated avg <strong>{formatMm(grooveWidth)}</strong>
                  </>
                )}
                <br />
                <span className="muted tiny">
                  Distinct from V tip width — see FlatCAM helper.
                </span>
              </p>
            )}
            <p className="muted tiny status-line">{status}</p>
          </section>

          <section>
            <h2>Warnings</h2>
            {warnings.length === 0 ? (
              <p className="muted">No warnings</p>
            ) : (
              <ul className="warn-list">
                {warnings.map((w, i) => (
                  <li key={i} className={w.severity}>
                    {w.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Measure</h2>
            <div className="row">
              <button
                type="button"
                className={measureMode ? 'primary' : ''}
                onClick={() => {
                  setMeasureMode((m) => !m);
                  setMeasurePoints([]);
                }}
              >
                {measureMode ? 'Measuring…' : 'Measure distance'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMeasurements([]);
                  setMeasurePoints([]);
                }}
              >
                Clear
              </button>
            </div>
            <p className="muted tiny">Click two points on the PCB (mm).</p>
            <ul className="measure-list">
              {measurements.map((m) => (
                <li key={m.id}>{m.label}</li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      <footer className="timeline">
        <div className="transport">
          <button
            type="button"
            onClick={() => setSim((s) => ({ ...s, playing: true }))}
            disabled={!timeline.length || busy}
          >
            Play
          </button>
          <button
            type="button"
            onClick={() => setSim((s) => ({ ...s, playing: false }))}
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => setSim({ ...idleSim })}
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => {
              setSim(idleSim);
              runSimulation(jobs, stock);
            }}
          >
            Restart
          </button>
          <button type="button" onClick={stepSim} disabled={!timeline.length}>
            Step
          </button>
          <button type="button" onClick={jumpFinal} disabled={busy}>
            Jump to final
          </button>
          <label className="speed">
            Speed
            <input
              type="range"
              min={0.25}
              max={20}
              step={0.25}
              value={sim.speed}
              onChange={(e) =>
                setSim((s) => ({ ...s, speed: parseFloat(e.target.value) }))
              }
            />
            <span>{sim.speed}×</span>
          </label>
        </div>
        <div className="gcode-line" title={sim.currentLine}>
          {sim.currentLine || '—'}
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(0, timeline.length)}
          value={sim.segmentIndex}
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            if (!timeline.length) return;
            const clamped = Math.min(idx, timeline.length - 1);
            const item = timeline[Math.max(0, clamped)];
            setSim((s) => ({
              ...s,
              playing: false,
              segmentIndex: idx,
              progress: idx / Math.max(1, timeline.length),
              x: item.seg.x1,
              y: item.seg.y1,
              z: item.seg.z1,
              feedrate: item.seg.feedrate,
              spindleOn: item.seg.spindleOn,
              spindleRpm: item.seg.spindleRpm,
              activeTool: toolLabel(item.job.tool),
              currentLine: item.seg.raw,
              lineNumber: item.seg.lineNumber,
            }));
          }}
        />
      </footer>
    </div>
  );
}
