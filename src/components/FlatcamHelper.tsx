import { useEffect, useMemo, useState } from 'react';
import {
  FLATCAM_HELPER_COPY,
  calcFlatcamToolDia,
  cutDepthFromToolDia,
  negativeCutZFromToolDia,
  tipWidthFromFlatcamToolDia,
} from '../core/flatcamHelper';
import { formatDeg, formatMm, roundMm } from '../core/format';
import { vbitEffectiveDiameter } from '../core/tools';
import type { Tool } from '../core/types';
import { NumberInput } from './NumberInput';

export interface GcodeRewriteRequest {
  toolDiaMm: number;
  tipWidthMm: number;
  angleDeg: number;
  /** Signed Cut Z (negative for standard CNC) */
  cutZMm: number;
}

interface Props {
  tipWidthMm?: number;
  angleDeg?: number;
  cutDepthMm?: number;
  gcodeToolDiaMm?: number;
  /** Stock copper cladding height (mm) */
  copperThicknessMm?: number;
  hasActiveJob?: boolean;
  /** Bump when a new file is opened so local edits discard and fields re-sync */
  resetKey?: number;
  onApplyToTool?: (tool: Extract<Tool, { type: 'vbit' }>, cutDepthMm: number) => void;
  /** Rewrite active job G-code, resimulate, keep in memory */
  onRewriteAndResimulate?: (req: GcodeRewriteRequest) => void;
  /** Rewrite and trigger file download */
  onDownloadRewritten?: (req: GcodeRewriteRequest) => void;
}

type Mode = 'tool-to-z' | 'forward' | 'reverse';

export function FlatcamHelper({
  tipWidthMm: tipProp,
  angleDeg: angleProp,
  cutDepthMm: depthProp,
  gcodeToolDiaMm,
  copperThicknessMm = 0.035,
  hasActiveJob = false,
  resetKey = 0,
  onApplyToTool,
  onRewriteAndResimulate,
  onDownloadRewritten,
}: Props) {
  const [tipWidthMm, setTipWidthMm] = useState(() => roundMm(tipProp ?? 0.1));
  const [angleDeg, setAngleDeg] = useState(() => roundMm(angleProp ?? 30));
  const [cutDepthMm, setCutDepthMm] = useState(() => roundMm(depthProp ?? 0.1));
  const [mode, setMode] = useState<Mode>('tool-to-z');
  const [knownToolDia, setKnownToolDia] = useState(() => roundMm(gcodeToolDiaMm ?? 0.15));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDirty(false);
    setMode('tool-to-z');
    setTipWidthMm(roundMm(tipProp ?? 0.1));
    setAngleDeg(roundMm(angleProp ?? 30));
    setCutDepthMm(roundMm(depthProp ?? 0.1));
    setKnownToolDia(roundMm(gcodeToolDiaMm ?? 0.15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (dirty) return;
    if (tipProp != null) setTipWidthMm(roundMm(tipProp));
    if (angleProp != null) setAngleDeg(roundMm(angleProp));
    if (depthProp != null) setCutDepthMm(roundMm(depthProp));
    if (gcodeToolDiaMm != null) setKnownToolDia(roundMm(gcodeToolDiaMm));
  }, [tipProp, angleProp, depthProp, gcodeToolDiaMm, dirty]);

  const forward = useMemo(
    () => calcFlatcamToolDia({ tipWidthMm, angleDeg, cutDepthMm }),
    [tipWidthMm, angleDeg, cutDepthMm]
  );

  const reversedTip = useMemo(
    () => tipWidthFromFlatcamToolDia(knownToolDia, angleDeg, cutDepthMm),
    [knownToolDia, angleDeg, cutDepthMm]
  );

  const depthFromDia = useMemo(
    () => cutDepthFromToolDia(knownToolDia, tipWidthMm, angleDeg),
    [knownToolDia, tipWidthMm, angleDeg]
  );
  const signedCutZ = useMemo(
    () => negativeCutZFromToolDia(knownToolDia, tipWidthMm, angleDeg),
    [knownToolDia, tipWidthMm, angleDeg]
  );

  const canRewrite =
    hasActiveJob && knownToolDia > tipWidthMm && depthFromDia > 0 && Number.isFinite(signedCutZ);

  /** |Cut Z| used by the active helper mode */
  const activeCutDepthMm = mode === 'tool-to-z' ? depthFromDia : cutDepthMm;

  const copperRemain = useMemo(() => {
    const copper = Math.max(0, copperThicknessMm);
    const depth = Math.max(0, activeCutDepthMm);
    if (!(copper > 0) || !(depth >= 0)) return null;
    if (depth + 1e-9 >= copper) return null;
    return roundMm(copper - depth);
  }, [copperThicknessMm, activeCutDepthMm]);

  const rewriteReq = (): GcodeRewriteRequest => ({
    toolDiaMm: knownToolDia,
    tipWidthMm,
    angleDeg,
    cutZMm: signedCutZ,
  });

  const mark = () => setDirty(true);

  const copperWarning = copperRemain != null && (
    <p className="copper-remain-warn" role="alert">
      Cut Z ({formatMm(activeCutDepthMm)}) is less than copper height (
      {formatMm(copperThicknessMm)}). Remaining copper:{' '}
      <strong>{formatMm(copperRemain)}</strong>
    </p>
  );

  return (
    <section className="flatcam-helper">
      <h2>{FLATCAM_HELPER_COPY.title}</h2>
      <p className="helper-summary">{FLATCAM_HELPER_COPY.summary}</p>

      <p className="formula mono">{FLATCAM_HELPER_COPY.formula}</p>
      <p className="formula mono">
        |Cut Z| = (Tool Dia − tip) / (2 × tan(angle/2)) → Cut Z = −|Cut Z|
      </p>

      <div className="row">
        <button
          type="button"
          className={mode === 'tool-to-z' ? 'primary' : ''}
          onClick={() => setMode('tool-to-z')}
        >
          Tool Dia → Cut Z
        </button>
        <button
          type="button"
          className={mode === 'forward' ? 'primary' : ''}
          onClick={() => setMode('forward')}
        >
          Tip → Tool Dia
        </button>
        <button
          type="button"
          className={mode === 'reverse' ? 'primary' : ''}
          onClick={() => setMode('reverse')}
        >
          Tool Dia → Tip
        </button>
      </div>

      {mode === 'tool-to-z' && (
        <div className="grid2 helper-inputs">
          <label>
            FlatCAM Tool Dia (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={knownToolDia}
              onChange={(v) => {
                mark();
                setKnownToolDia(v);
              }}
            />
          </label>
          <label>
            V tip width (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={tipWidthMm}
              onChange={(v) => {
                mark();
                setTipWidthMm(v);
              }}
            />
          </label>
          <label>
            V angle (°)
            <NumberInput
              step={0.001}
              min={1}
              value={angleDeg}
              onChange={(v) => {
                mark();
                setAngleDeg(v || 30);
              }}
            />
          </label>
          <div className="helper-result">
            <span className="muted tiny">Calculated Cut Z (CNC)</span>
            <strong className="mono cut-z-neg">{formatMm(signedCutZ)}</strong>
            <span className="muted tiny">|depth| = {formatMm(depthFromDia)}</span>
          </div>
          {copperWarning}
        </div>
      )}

      {mode === 'forward' && (
        <div className="grid2 helper-inputs">
          <label>
            V tip width (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={tipWidthMm}
              onChange={(v) => {
                mark();
                setTipWidthMm(v);
              }}
            />
          </label>
          <label>
            V angle (°)
            <NumberInput
              step={0.001}
              min={1}
              value={angleDeg}
              onChange={(v) => {
                mark();
                setAngleDeg(v || 30);
              }}
            />
          </label>
          <label>
            |Cut Z| depth (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={cutDepthMm}
              onChange={(v) => {
                mark();
                setCutDepthMm(v);
              }}
            />
          </label>
          <div className="helper-result">
            <span className="muted tiny">FlatCAM Tool Dia</span>
            <strong className="mono">{formatMm(forward.flatcamToolDiaMm)}</strong>
            <span className="muted tiny">
              tip {formatMm(forward.tipWidthMm)} + flare {formatMm(forward.flareMm)}
            </span>
          </div>
          {copperWarning}
        </div>
      )}

      {mode === 'reverse' && (
        <div className="grid2 helper-inputs">
          <label>
            FlatCAM Tool Dia (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={knownToolDia}
              onChange={(v) => {
                mark();
                setKnownToolDia(v);
              }}
            />
          </label>
          <label>
            V angle (°)
            <NumberInput
              step={0.001}
              min={1}
              value={angleDeg}
              onChange={(v) => {
                mark();
                setAngleDeg(v || 30);
              }}
            />
          </label>
          <label>
            |Cut Z| depth (mm)
            <NumberInput
              step={0.001}
              min={0}
              value={cutDepthMm}
              onChange={(v) => {
                mark();
                setCutDepthMm(v);
              }}
            />
          </label>
          <div className="helper-result">
            <span className="muted tiny">Implied V tip width</span>
            <strong className="mono">{formatMm(reversedTip)}</strong>
            <span className="muted tiny">
              check: effective{' '}
              {formatMm(vbitEffectiveDiameter(reversedTip, angleDeg, cutDepthMm))}
            </span>
          </div>
          {copperWarning}
        </div>
      )}

      {gcodeToolDiaMm != null && (
        <p className="callout tiny">
          Loaded G-code Tool Dia = <strong>{formatMm(gcodeToolDiaMm)}</strong>
        </p>
      )}

      {mode === 'tool-to-z' && (
        <div className="rewrite-actions">
          <p className="muted tiny">
            Updates plunge Z to <strong className="mono">{formatMm(signedCutZ)}</strong>, sets
            Tool Dia comment, then resimulates. Download saves the rewritten .nc.
          </p>
          {!canRewrite && (
            <p className="warn-inline">
              Tool Dia must be greater than tip width (and a V-bit job must be loaded).
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!canRewrite || !onRewriteAndResimulate}
              onClick={() => onRewriteAndResimulate?.(rewriteReq())}
            >
              Apply Cut Z &amp; resimulate
            </button>
            <button
              type="button"
              disabled={!canRewrite || !onDownloadRewritten}
              onClick={() => onDownloadRewritten?.(rewriteReq())}
            >
              Download updated .nc
            </button>
          </div>
        </div>
      )}

      {onApplyToTool && mode !== 'tool-to-z' && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            const tip = mode === 'forward' ? tipWidthMm : reversedTip;
            const depth = mode === 'forward' ? cutDepthMm : cutDepthMm;
            onApplyToTool(
              {
                type: 'vbit',
                tipDiameter: tip,
                angle: angleDeg,
                shankDiameter: 3.175,
              },
              depth
            );
          }}
        >
          Apply tip/angle to job only
        </button>
      )}

      <p className="muted tiny examples">
        Example: Tool Dia {formatMm(0.154)} · tip {formatMm(0.1)} · {formatDeg(30)} →
        Cut Z ≈ {formatMm(negativeCutZFromToolDia(0.154, 0.1, 30))}
      </p>
    </section>
  );
}
