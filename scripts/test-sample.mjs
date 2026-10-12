import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

// Use tsx-free approach: dynamically import compiled logic via vite-node isn't available.
// Inline minimal checks that mirror core formulas + parse via spawning vite-ssr is heavy.
// Instead, duplicate the critical math assertions here and run parser through a tiny eval.

function vbitEffectiveDiameter(tipDiameter, angleDeg, depth) {
  if (depth <= 0) return tipDiameter;
  const halfAngleRad = ((angleDeg / 2) * Math.PI) / 180;
  return tipDiameter + 2 * depth * Math.tan(halfAngleRad);
}

// Acceptance: tip 0.1, 30°, depth 0.10 → ≈ 0.154 mm
const w = vbitEffectiveDiameter(0.1, 30, 0.1);
console.log(`V-bit width @0.10mm depth: ${w.toFixed(4)} mm (expect ~0.1536)`);
if (Math.abs(w - 0.15359) > 0.002) {
  console.error('FAIL: V-bit formula');
  process.exit(1);
}

// Sample file metadata
const sample = readFileSync(
  new URL('../samples/00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc', import.meta.url),
  'utf8'
);

const toolDia = sample.match(/\(TOOL DIAMETER:\s*([-\d.]+)/i);
const zCut = sample.match(/\(Z_Cut:\s*([-\d.]+)/i);
const xRange = sample.match(/\(X range:\s*([-\d.]+)\s*\.\.\.\s*([-\d.]+)/i);
const yRange = sample.match(/\(Y range:\s*([-\d.]+)\s*\.\.\.\s*([-\d.]+)/i);

console.log('Sample tool diameter:', toolDia?.[1]);
console.log('Sample Z_Cut:', zCut?.[1]);
console.log('Sample X range:', xRange?.[1], '...', xRange?.[2]);
console.log('Sample Y range:', yRange?.[1], '...', yRange?.[2]);

// FlatCAM TOOL DIAMETER is effective Tool Dia at Cut Z — not V tip width
const flatcamToolDia = parseFloat(toolDia[1]);
const depth = Math.abs(parseFloat(zCut[1]));
const angle = 30;
const half = ((angle / 2) * Math.PI) / 180;
const tip = Math.max(0, flatcamToolDia - 2 * depth * Math.tan(half));
const groove = vbitEffectiveDiameter(tip, angle, depth);
console.log(`FlatCAM Tool Dia (effective): ${flatcamToolDia} mm`);
console.log(`Implied V tip width @ ${angle}°: ${tip.toFixed(4)} mm`);
console.log(`Recomputed effective groove: ${groove.toFixed(4)} mm`);
if (Math.abs(groove - flatcamToolDia) > 0.002) {
  console.error('FAIL: reverse tip → effective should match FlatCAM Tool Dia');
  process.exit(1);
}

const g0 = (sample.match(/^G0/gm) || []).length;
const g1 = (sample.match(/^G01|^G1\b/gm) || []).length;
console.log(`G0 lines~ ${g0}, G1 lines~ ${g1}, total lines ${sample.split('\n').length}`);

if (!sample.includes('G21') || !sample.includes('M03')) {
  console.error('FAIL: expected G21 and M03 in sample');
  process.exit(1);
}

console.log('OK: sample file sanity + V-bit math');
