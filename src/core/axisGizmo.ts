import * as THREE from 'three';

/**
 * PCB coordinates → Three.js:
 *   pcbX → three.x
 *   pcbY → three.z
 *   pcbZ → three.y  (up from board)
 *
 * Axes show CNC/PCB machine directions with arrowheads + labels.
 */
function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.font = 'bold 72px IBM Plex Sans, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#0b0f14';
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 2.2, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function makeAxisArrow(
  dir: THREE.Vector3,
  length: number,
  color: number,
  label: string,
  labelColor: string
): THREE.Group {
  const g = new THREE.Group();
  const origin = new THREE.Vector3(0, 0, 0);
  const arrow = new THREE.ArrowHelper(
    dir.clone().normalize(),
    origin,
    length,
    color,
    length * 0.2,
    length * 0.12
  );
  g.add(arrow);

  const sprite = makeLabelSprite(label, labelColor);
  const tip = dir.clone().normalize().multiplyScalar(length + 1.6);
  sprite.position.copy(tip);
  g.add(sprite);

  return g;
}

export type AxisGizmo = {
  group: THREE.Group;
  setOrigin: (x: number, y: number, z: number) => void;
  setLength: (len: number) => void;
  dispose: () => void;
};

/**
 * Build PCB-space axis gizmo.
 * @param flipX - if true, +X arrow points toward −pcbX (mirrored board)
 */
export function buildAxisGizmo(length = 12, flipX = false): AxisGizmo {
  const group = new THREE.Group();
  group.name = 'pcb-axes';

  // PCB +X → Three.js ±X
  const xDir = new THREE.Vector3(flipX ? -1 : 1, 0, 0);
  // PCB +Y → Three.js +Z
  const yDir = new THREE.Vector3(0, 0, 1);
  // PCB +Z (up / above stock) → Three.js +Y
  const zDir = new THREE.Vector3(0, 1, 0);

  // Labels are always G-code +X/+Y/+Z; flipX only changes which world way +X points
  let xAxis = makeAxisArrow(xDir, length, 0xef4444, 'X+', '#fca5a5');
  let yAxis = makeAxisArrow(yDir, length, 0x22c55e, 'Y+', '#86efac');
  let zAxis = makeAxisArrow(zDir, length, 0x3b82f6, 'Z+', '#93c5fd');
  xAxis.name = 'axis-x';
  yAxis.name = 'axis-y';
  zAxis.name = 'axis-z';
  group.add(xAxis, yAxis, zAxis);

  // Origin marker
  const originDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  originDot.name = 'axis-origin';
  group.add(originDot);

  const originLabel = makeLabelSprite('0', '#e7eef7');
  originLabel.scale.set(1.6, 1.6, 1);
  originLabel.position.set(0, 1.2, 0);
  group.add(originLabel);

  // Legend plate (always readable)
  const legend = makeLabelSprite('PCB XYZ', '#94a3b8');
  legend.scale.set(4.5, 4.5, 1);
  legend.position.set(0, -2.2, 0);
  group.add(legend);

  const disposables: THREE.Object3D[] = [group];

  return {
    group,
    setOrigin(x, y, z) {
      // PCB (x,y,z) → Three (x, z, y)
      group.position.set(x, z, y);
    },
    setLength(len) {
      group.remove(xAxis, yAxis, zAxis);
      disposeObject(xAxis);
      disposeObject(yAxis);
      disposeObject(zAxis);
      xAxis = makeAxisArrow(xDir, len, 0xef4444, 'X+', '#fca5a5');
      yAxis = makeAxisArrow(yDir, len, 0x22c55e, 'Y+', '#86efac');
      zAxis = makeAxisArrow(zDir, len, 0x3b82f6, 'Z+', '#93c5fd');
      group.add(xAxis, yAxis, zAxis);
    },
    dispose() {
      for (const o of disposables) disposeObject(o);
    },
  };
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.Line || c instanceof THREE.Sprite) {
      c.geometry?.dispose?.();
      const mat = c.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) {
        if ('map' in mat && mat.map) (mat.map as THREE.Texture).dispose();
        mat.dispose();
      }
    }
  });
}
