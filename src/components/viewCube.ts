import * as THREE from 'three';

export type ViewCubeHandle = {
  canvas: HTMLCanvasElement;
  render: (mainCamera: THREE.Camera, target: THREE.Vector3) => void;
  dispose: () => void;
};

type FaceId = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

const FACE_ORDER: FaceId[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

function labelForFace(id: FaceId, upAxis: 'y' | 'z'): string {
  if (upAxis === 'z') {
    switch (id) {
      case 'pz':
        return 'TOP';
      case 'nz':
        return 'BOT';
      case 'ny':
        return 'FRONT';
      case 'py':
        return 'BACK';
      case 'px':
        return 'RIGHT';
      case 'nx':
        return 'LEFT';
    }
  }
  switch (id) {
    case 'py':
      return 'TOP';
    case 'ny':
      return 'BOT';
    case 'pz':
      return 'FRONT';
    case 'nz':
      return 'BACK';
    case 'px':
      return 'RIGHT';
    case 'nx':
      return 'LEFT';
  }
}

function directionForFace(id: FaceId): THREE.Vector3 {
  switch (id) {
    case 'px':
      return new THREE.Vector3(1, 0, 0);
    case 'nx':
      return new THREE.Vector3(-1, 0, 0);
    case 'py':
      return new THREE.Vector3(0, 1, 0);
    case 'ny':
      return new THREE.Vector3(0, -1, 0);
    case 'pz':
      return new THREE.Vector3(0, 0, 1);
    case 'nz':
      return new THREE.Vector3(0, 0, -1);
  }
}

function makeFaceTexture(label: string, color: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#1a222c';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.fillStyle = '#e8eef5';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function upForView(viewDir: THREE.Vector3, worldUp: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(viewDir.dot(worldUp)) > 0.92) {
    // Top / bottom: keep a stable secondary axis
    if (Math.abs(worldUp.z) > 0.5) return new THREE.Vector3(0, 1, 0);
    return new THREE.Vector3(0, 0, -1);
  }
  return worldUp.clone();
}

/**
 * Mini orientation cube. Click a face to snap the main camera to that plane.
 */
export function createViewCube(opts: {
  upAxis: 'y' | 'z';
  onFaceSelect: (viewDir: THREE.Vector3, up: THREE.Vector3) => void;
}): ViewCubeHandle {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.className = 'view-cube';
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.title = 'Click a face to snap the camera';

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
  camera.position.set(0, 0, 3.2);

  const light = new THREE.AmbientLight(0xffffff, 1.15);
  scene.add(light);
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(2, 3, 4);
  scene.add(key);

  const faceColors: Record<FaceId, string> = {
    px: '#3d6a8a',
    nx: '#3d6a8a',
    py: '#4a7a55',
    ny: '#4a7a55',
    pz: '#8a6a3d',
    nz: '#8a6a3d',
  };

  const materials = FACE_ORDER.map((id) => {
    const tex = makeFaceTexture(labelForFace(id, opts.upAxis), faceColors[id]);
    return new THREE.MeshBasicMaterial({ map: tex });
  });

  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.15, 1.15), materials);
  cube.name = 'view-cube';
  scene.add(cube);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.16, 1.16, 1.16)),
    new THREE.LineBasicMaterial({ color: 0xd8e2ec })
  );
  scene.add(edges);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const worldUp = opts.upAxis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);

  const onPointerUp = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(cube, false);
    if (!hits.length || hits[0].faceIndex == null) return;
    // BoxGeometry: 2 triangles per face, 6 faces in FACE_ORDER
    const faceId = FACE_ORDER[Math.floor(hits[0].faceIndex / 2)];
    if (!faceId) return;
    const viewDir = directionForFace(faceId);
    opts.onFaceSelect(viewDir, upForView(viewDir, worldUp));
  };

  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const tmp = new THREE.Vector3();

  return {
    canvas,
    render: (mainCamera, target) => {
      tmp.copy(mainCamera.position).sub(target);
      if (tmp.lengthSq() < 1e-8) tmp.set(0, -1, 0.5);
      tmp.normalize().multiplyScalar(3.2);
      camera.position.copy(tmp);
      camera.up.copy(mainCamera.up);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
    dispose: () => {
      canvas.removeEventListener('pointerup', onPointerUp);
      for (const mat of materials) {
        mat.map?.dispose();
        mat.dispose();
      }
      cube.geometry.dispose();
      edges.geometry.dispose();
      (edges.material as THREE.Material).dispose();
      renderer.dispose();
    },
  };
}
