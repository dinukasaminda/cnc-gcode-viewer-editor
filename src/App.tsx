import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatcamHelper } from './components/FlatcamHelper';
import { Viewer3D } from './components/Viewer3D';
import { parseGCode } from './core/gcodeParser';
import { concatTimeline } from './core/materialRemoval';
import { applyMaterialRemoval } from './core/materialRemoval';
import { stockFromBounds } from './core/stock';
import type { HeightFieldStock } from './core/stock';
import { guessToolFromMetadata, toolLabel, vbitEffectiveDiameter } from './core/tools';
import { validateJobs } from './core/validator';
import {
  DEFAULT_STOCK,
  DEFAULT_VBIT,
  JOB_COLORS,
  type CameraMode,
  type JobFile,
  type Measurement,
  type SimulationState,
  type StockSettings,
  type Tool,
  type ViewMode,
} from './core/types';
import type { WorkerRequest, WorkerResponse } from './workers/simulate.worker';
import { stockFromWorkerResult } from './core/stockFromBuffers';
import './App.css';

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

export default function App() {
  const [jobs, setJobs] = useState<JobFile[]>([]);
  const [stock, setStock] = useState<StockSettings>({ ...DEFAULT_STOCK });
  const [field, setField] = useState<HeightFieldStock | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('final');
  const [cameraMode, setCameraMode] = useState<CameraMode>('perspective');
  const [flipX, setFlipX] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  const [sim, setSim] = useState<SimulationState>(idleSim);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [grooveWidth, setGrooveWidth] = useState(0);
  const [status, setStatus] = useState('Load a FlatCAM .nc file to preview the final PCB.');
  const [resetViewKey, setResetViewKey] = useState(0);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<{ x: number; y: number; z: number }[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const simTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const warnings = useMemo(() => validateJobs(jobs, stock), [jobs, stock]);
  const timeline = useMemo(() => concatTimeline(jobs), [jobs]);
  const activeVbit = useMemo(() => {
    const j = jobs.find((x) => x.enabled && x.tool.type === 'vbit');
    if (!j || j.tool.type !== 'vbit') return null;
    return {
      job: j,
      tipWidthMm: j.tool.tipDiameter,
      angleDeg: j.tool.angle,
      cutDepthMm:
        j.parse?.metadata.zCut != null ? Math.abs(j.parse.metadata.zCut) : undefined,
      gcodeToolDiaMm: j.parse?.metadata.toolDiameter,
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
            new URL('./workers/simulate.worker.ts', import.meta.url),
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
                  ? `, avg V-groove ≈ ${res.effectiveGrooveWidthMm.toFixed(3)} mm`
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
          `Done — ${result.appliedSegments} cut segments, avg V-groove ≈ ${result.effectiveGrooveWidthMm.toFixed(3)} mm`
        );
      }
    },
    []
  );

  const ingestText = useCallback(
    async (name: string, text: string, replace = false) => {
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
        color: JOB_COLORS[(replace ? 0 : jobs.length) % JOB_COLORS.length],
      };
      const nextJobs = replace ? [job] : [...jobs, job];
      setJobs(nextJobs);

      let nextStock = stock;
      if (parse.metadata.xMin != null && parse.metadata.xMax != null) {
        nextStock = stockFromBounds(
          {
            minX: parse.bounds.minX,
            minY: parse.bounds.minY,
            maxX: parse.bounds.maxX,
            maxY: parse.bounds.maxY,
          },
          stock
        );
        setStock(nextStock);
      } else {
        nextStock = stockFromBounds(parse.bounds, stock);
        setStock(nextStock);
      }

      setSim(idleSim);
      runSimulation(nextJobs, nextStock);
    },
    [jobs, stock, runSimulation]
  );

  const loadSample = useCallback(async () => {
    setStatus('Loading sample…');
    const res = await fetch(SAMPLE);
    const text = await res.text();
    await ingestText('00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc', text, true);
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
    let next = [...jobs];
    let nextStock = stock;
    for (const file of Array.from(fileList)) {
      const text = await file.text();
      const parse = parseGCode(text);
      const tool = guessToolFromMetadata(
        parse.metadata.toolDiameter,
        file.name,
        parse.metadata.zCut
      );
      next.push({
        id: newId(),
        name: file.name,
        source: text,
        enabled: true,
        tool,
        parse,
        color: JOB_COLORS[next.length % JOB_COLORS.length],
      });
      nextStock = stockFromBounds(parse.bounds, nextStock);
    }
    setJobs(next);
    setStock(nextStock);
    setSim(idleSim);
    runSimulation(next, nextStock);
  };

  const updateJobTool = (id: string, tool: Tool) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, tool } : j)));
  };

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
              label: `Distance ${dist.toFixed(3)} mm (depths ${depthA.toFixed(3)} / ${depthB.toFixed(3)})`,
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
            multiple
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
                          V tip width
                          <input
                            type="number"
                            step="0.01"
                            value={j.tool.tipDiameter}
                            onChange={(e) =>
                              updateJobTool(j.id, {
                                ...j.tool,
                                tipDiameter: parseFloat(e.target.value) || 0,
                              } as Tool)
                            }
                          />
                        </label>
                        <label>
                          V angle
                          <input
                            type="number"
                            step="1"
                            value={j.tool.angle}
                            onChange={(e) =>
                              updateJobTool(j.id, {
                                ...j.tool,
                                angle: parseFloat(e.target.value) || 30,
                              } as Tool)
                            }
                          />
                        </label>
                        <p className="muted tiny tool-eff">
                          Effective @ |Cut Z|{' '}
                          {Math.abs(j.parse?.metadata.zCut ?? 0.1).toFixed(3)} mm →{' '}
                          <strong>
                            {vbitEffectiveDiameter(
                              j.tool.tipDiameter,
                              j.tool.angle,
                              Math.abs(j.parse?.metadata.zCut ?? 0.1)
                            ).toFixed(3)}{' '}
                            mm
                          </strong>{' '}
                          (= FlatCAM Tool Dia)
                          {j.parse?.metadata.toolDiameter != null && (
                            <>
                              {' '}
                              · G-code said {j.parse.metadata.toolDiameter.toFixed(3)} mm
                            </>
                          )}
                        </p>
                      </>
                    )}
                    {(j.tool.type === 'drill' || j.tool.type === 'endmill') && (
                      <label>
                        Diameter (FlatCAM Tool Dia)
                        <input
                          type="number"
                          step="0.05"
                          value={j.tool.diameter}
                          onChange={(e) =>
                            updateJobTool(j.id, {
                              ...j.tool,
                              diameter: parseFloat(e.target.value) || 0,
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
            <button
              type="button"
              disabled={busy}
              onClick={() => runSimulation(jobs, stock)}
            >
              Re-simulate tools
            </button>
          </section>

          <FlatcamHelper
            key={activeVbit?.job.id ?? 'no-vbit'}
            tipWidthMm={activeVbit?.tipWidthMm}
            angleDeg={activeVbit?.angleDeg}
            cutDepthMm={activeVbit?.cutDepthMm}
            gcodeToolDiaMm={activeVbit?.gcodeToolDiaMm}
            onApplyToTool={(tool) => {
              if (!activeVbit) return;
              const next = jobs.map((j) =>
                j.id === activeVbit.job.id ? { ...j, tool } : j
              );
              setJobs(next);
              runSimulation(next, stock);
            }}
          />

          <section>
            <h2>Stock</h2>
            <div className="grid2">
              {(
                [
                  ['width', 'Width'],
                  ['height', 'Height'],
                  ['thickness', 'Thickness'],
                  ['copperThickness', 'Copper'],
                  ['originX', 'Origin X'],
                  ['originY', 'Origin Y'],
                  ['surfaceZ', 'Surface Z'],
                  ['margin', 'Margin'],
                  ['resolution', 'Resolution'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    step={key === 'resolution' ? 0.005 : 0.1}
                    value={stock[key]}
                    onChange={(e) =>
                      setStock({ ...stock, [key]: parseFloat(e.target.value) || 0 })
                    }
                  />
                </label>
              ))}
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
              Flip X direction
            </label>
            <p className="muted tiny">
              Red = X+, Green = Y+, Blue = Z+ (up). Origin is G-code (0,0,0). Use Flip X
              if text/traces look mirrored.
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
              <p>Simulating… {(progress * 100).toFixed(0)}%</p>
            </div>
          )}
        </main>

        <aside className="panel right">
          <section>
            <h2>Simulation</h2>
            <dl className="stats">
              <div>
                <dt>X</dt>
                <dd>{sim.x.toFixed(3)}</dd>
              </div>
              <div>
                <dt>Y</dt>
                <dd>{sim.y.toFixed(3)}</dd>
              </div>
              <div>
                <dt>Z</dt>
                <dd>{sim.z.toFixed(3)}</dd>
              </div>
              <div>
                <dt>F</dt>
                <dd>{sim.feedrate.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Spindle</dt>
                <dd>
                  {sim.spindleOn ? `ON ${sim.spindleRpm}` : 'OFF'}
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
                <dd>{(sim.progress * 100).toFixed(1)}%</dd>
              </div>
            </dl>
            {expectedVbitWidth != null && (
              <p className="callout">
                Effective groove (FlatCAM Tool Dia) ≈{' '}
                <strong>{expectedVbitWidth.toFixed(3)} mm</strong>
                {grooveWidth > 0 && (
                  <>
                    {' '}
                    · simulated avg <strong>{grooveWidth.toFixed(3)} mm</strong>
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
