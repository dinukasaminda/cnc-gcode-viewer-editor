import { useEffect, useMemo, useState } from 'react';
import {
  FLATCAM_HELPER_COPY,
  calcFlatcamToolDia,
  tipWidthFromFlatcamToolDia,
} from '../core/flatcamHelper';
import { vbitEffectiveDiameter } from '../core/tools';
import type { Tool } from '../core/types';

interface Props {
  /** Prefill from active V-bit job when available */
  tipWidthMm?: number;
  angleDeg?: number;
  cutDepthMm?: number;
  /** FlatCAM Tool Dia found in loaded G-code comments */
  gcodeToolDiaMm?: number;
  onApplyToTool?: (tool: Extract<Tool, { type: 'vbit' }>, cutDepthMm: number) => void;
}

export function FlatcamHelper({
  tipWidthMm: tipProp,
  angleDeg: angleProp,
  cutDepthMm: depthProp,
  gcodeToolDiaMm,
  onApplyToTool,
}: Props) {
  const [tipWidthMm, setTipWidthMm] = useState(() => tipProp ?? 0.1);
  const [angleDeg, setAngleDeg] = useState(() => angleProp ?? 30);
  const [cutDepthMm, setCutDepthMm] = useState(() => depthProp ?? 0.1);
  const [mode, setMode] = useState<'forward' | 'reverse'>('forward');
  const [knownToolDia, setKnownToolDia] = useState(() => gcodeToolDiaMm ?? 0.15);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    if (tipProp != null) setTipWidthMm(tipProp);
    if (angleProp != null) setAngleDeg(angleProp);
    if (depthProp != null) setCutDepthMm(depthProp);
    if (gcodeToolDiaMm != null) setKnownToolDia(gcodeToolDiaMm);
  }, [tipProp, angleProp, depthProp, gcodeToolDiaMm, dirty]);

  const forward = useMemo(
    () => calcFlatcamToolDia({ tipWidthMm, angleDeg, cutDepthMm }),
    [tipWidthMm, angleDeg, cutDepthMm]
  );

  const reversedTip = useMemo(
    () => tipWidthFromFlatcamToolDia(knownToolDia, angleDeg, cutDepthMm),
    [knownToolDia, angleDeg, cutDepthMm]
  );

  const mismatch =
    gcodeToolDiaMm != null
      ? Math.abs(forward.flatcamToolDiaMm - gcodeToolDiaMm)
      : null;

  return (
    <section className="flatcam-helper">
      <h2>{FLATCAM_HELPER_COPY.title}</h2>
      <p className="helper-summary">{FLATCAM_HELPER_COPY.summary}</p>

      <div className="helper-diagram" aria-hidden>
        <svg viewBox="0 0 220 90" width="100%" height="90">
          <rect x="10" y="18" width="200" height="8" fill="#b87333" />
          <rect x="10" y="26" width="200" height="40" fill="#2d5a27" />
          {/* V groove */}
          <polygon points="90,18 110,18 100,48" fill="#1a3a16" />
          <line x1="90" y1="18" x2="110" y2="18" stroke="#f0b429" strokeWidth="1.5" />
          <text x="100" y="12" textAnchor="middle" fill="#f0b429" fontSize="8">
            effective = FlatCAM Tool Dia
          </text>
          <line x1="98" y1="48" x2="102" y2="48" stroke="#3d9cf0" strokeWidth="2" />
          <text x="115" y="52" fill="#3d9cf0" fontSize="8">
            V tip width
          </text>
          <text x="100" y="78" textAnchor="middle" fill="#8b9bb0" fontSize="8">
            Cut Z depth ↓
          </text>
        </svg>
      </div>

      <ul className="helper-rules">
        {FLATCAM_HELPER_COPY.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <p className="formula mono">{FLATCAM_HELPER_COPY.formula}</p>

      <div className="row">
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

      {mode === 'forward' ? (
        <div className="grid2 helper-inputs">
          <label>
            V tip width (mm)
            <input
              type="number"
              step="0.01"
              min="0"
              value={tipWidthMm}
              onChange={(e) => {
                setDirty(true);
                setTipWidthMm(parseFloat(e.target.value) || 0);
              }}
            />
          </label>
          <label>
            V angle (°)
            <input
              type="number"
              step="1"
              min="1"
              value={angleDeg}
              onChange={(e) => {
                setDirty(true);
                setAngleDeg(parseFloat(e.target.value) || 30);
              }}
            />
          </label>
          <label>
            |Cut Z| depth (mm)
            <input
              type="number"
              step="0.01"
              min="0"
              value={cutDepthMm}
              onChange={(e) => {
                setDirty(true);
                setCutDepthMm(parseFloat(e.target.value) || 0);
              }}
            />
          </label>
          <div className="helper-result">
            <span className="muted tiny">Enter in FlatCAM as Tool Dia</span>
            <strong className="mono">{forward.flatcamToolDiaMm.toFixed(4)} mm</strong>
            <span className="muted tiny">
              tip {forward.tipWidthMm.toFixed(3)} + flare {forward.flareMm.toFixed(3)}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid2 helper-inputs">
          <label>
            FlatCAM Tool Dia (mm)
            <input
              type="number"
              step="0.01"
              min="0"
              value={knownToolDia}
              onChange={(e) => {
                setDirty(true);
                setKnownToolDia(parseFloat(e.target.value) || 0);
              }}
            />
          </label>
          <label>
            V angle (°)
            <input
              type="number"
              step="1"
              min="1"
              value={angleDeg}
              onChange={(e) => {
                setDirty(true);
                setAngleDeg(parseFloat(e.target.value) || 30);
              }}
            />
          </label>
          <label>
            |Cut Z| depth (mm)
            <input
              type="number"
              step="0.01"
              min="0"
              value={cutDepthMm}
              onChange={(e) => {
                setDirty(true);
                setCutDepthMm(parseFloat(e.target.value) || 0);
              }}
            />
          </label>
          <div className="helper-result">
            <span className="muted tiny">Implied V tip width</span>
            <strong className="mono">{reversedTip.toFixed(4)} mm</strong>
            <span className="muted tiny">
              check: effective{' '}
              {vbitEffectiveDiameter(reversedTip, angleDeg, cutDepthMm).toFixed(4)} mm
            </span>
          </div>
        </div>
      )}

      {gcodeToolDiaMm != null && (
        <p className="callout tiny">
          G-code comment Tool Dia = <strong>{gcodeToolDiaMm.toFixed(4)} mm</strong>
          {mismatch != null && mismatch > 0.005 && mode === 'forward' && (
            <>
              {' '}
              · your calc differs by {mismatch.toFixed(3)} mm — adjust tip/angle/depth to match,
              or FlatCAM used a different bit.
            </>
          )}
          {mismatch != null && mismatch <= 0.005 && mode === 'forward' && (
            <> · matches your tip/angle/depth ✓</>
          )}
        </p>
      )}

      {onApplyToTool && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            const tip = mode === 'forward' ? tipWidthMm : reversedTip;
            onApplyToTool(
              {
                type: 'vbit',
                tipDiameter: tip,
                angle: angleDeg,
                shankDiameter: 3.175,
              },
              cutDepthMm
            );
          }}
        >
          Apply to active V-bit job
        </button>
      )}

      <p className="muted tiny examples">
        Example: tip 0.1 mm · 30° · Cut Z 0.10 mm → Tool Dia ≈{' '}
        {vbitEffectiveDiameter(0.1, 30, 0.1).toFixed(3)} mm
      </p>
    </section>
  );
}
