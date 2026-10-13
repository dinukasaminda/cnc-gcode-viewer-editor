import { readFileSync } from 'fs';

function cutDepthFromToolDia(toolDiaMm, tipWidthMm, angleDeg) {
  const half = ((angleDeg / 2) * Math.PI) / 180;
  return Math.max(0, (toolDiaMm - tipWidthMm) / (2 * Math.tan(half)));
}

function formatZ(z, decimals = 4) {
  return z.toFixed(decimals);
}

function rewriteGCodeCutZ(source, { toolDiaMm, tipWidthMm, angleDeg, cutZMm }) {
  const cutDepthMm = cutZMm != null ? Math.abs(cutZMm) : cutDepthFromToolDia(toolDiaMm, tipWidthMm, angleDeg);
  const newCutZ = cutZMm ?? -cutDepthMm;
  const meta = source.match(/\(Z_Cut:\s*([-\d.]+)/i);
  const oldCutZ = meta ? parseFloat(meta[1]) : null;
  let text = source;
  text = text.replace(/\(TOOL DIAMETER:\s*[-\d.]+\s*mm\)/i, `(TOOL DIAMETER: ${toolDiaMm.toFixed(4)} mm)`);
  text = text.replace(/\(Z_Cut:\s*[-\d.]+\s*mm\)/i, `(Z_Cut: ${formatZ(newCutZ)} mm)`);
  let replaced = 0;
  if (oldCutZ != null) {
    text = text.split(/\r?\n/).map((line) =>
      line.replace(/\bZ\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi, (full, num) => {
        if (Math.abs(parseFloat(num) - oldCutZ) <= 1e-3) {
          replaced++;
          return `Z${formatZ(newCutZ)}`;
        }
        return full;
      })
    ).join('\n');
  }
  return { text, oldCutZ, newCutZ, replaced };
}

const src = readFileSync(new URL('../samples/00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc', import.meta.url), 'utf8');

// Target Tool Dia 0.154 with tip 0.1 @ 30° → Cut Z ≈ -0.10
const tip = 0.1, angle = 30, toolDia = 0.154;
const depth = cutDepthFromToolDia(toolDia, tip, angle);
const cutZ = -depth;
console.log(`Tool Dia ${toolDia} tip ${tip} ${angle}° → Cut Z ${cutZ.toFixed(4)} (expect ~-0.10)`);

const { text, oldCutZ, newCutZ, replaced } = rewriteGCodeCutZ(src, {
  toolDiaMm: toolDia,
  tipWidthMm: tip,
  angleDeg: angle,
  cutZMm: cutZ,
});

console.log(`Old Cut Z ${oldCutZ}, new ${newCutZ}, replaced ${replaced} Z words`);
if (!text.includes('(Z_Cut: -0.')) throw new Error('Z_Cut comment not negative');
if (!text.includes('(TOOL DIAMETER: 0.1540 mm)')) throw new Error('Tool dia comment missing');
if (replaced < 10) throw new Error('Too few Z replacements');
if (Math.abs(cutZ + 0.1) > 0.005) throw new Error('Cut Z not ~-0.1');
// Rapids should remain positive
if (!text.includes('G00 Z1.0000') && !text.includes('G00 Z1')) throw new Error('Rapid Z lost');
console.log('OK: rewrite produces negative Cut Z and updates plunges');
