import * as THREE from 'three/webgpu';
import { BOSS, type Sim } from './sim';

const WIDTH = [0.6, 0.6, 0.6, 0.7, 1.5];
const HEIGHT = [0.07, 0.07, 0.07, 0.08, 0.13];
const LIFT = [0.8, 0.8, 0.8, 0.85, 1.6];
const RED = new THREE.Color(0xe8483f), YELLOW = new THREE.Color(0xf2c33a), GREEN = new THREE.Color(0x5bd16b);

/**
 * Camera-facing health bars over damaged enemies (bosses always show one).
 * Two instanced quads per bar; matrices are written directly so each bar
 * faces the camera without per-object updates.
 */
export class HealthBars {
  private readonly back: THREE.InstancedMesh;
  private readonly fill: THREE.InstancedMesh;
  private readonly colors: Float32Array;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private readonly capacity: number, scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(1, 1);
    // Drawn last and without depth test so towers never hide a bar.
    const common = { transparent: true, depthTest: false, depthWrite: false };
    this.back = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ color: 0x1d2430, opacity: 0.7, ...common }), capacity);
    this.fill = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ color: 0xffffff, ...common }), capacity);
    this.colors = new Float32Array(capacity * 3);
    this.fill.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    for (const m of [this.back, this.fill]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 10;
      m.count = 0;
      scene.add(m);
    }
    this.fill.renderOrder = 11;
  }

  update(sim: Sim, camera: THREE.Camera, hoverY: (i: number) => number): void {
    camera.matrixWorld.extractBasis(this.right, this.up, this.fwd);
    const back = this.back.instanceMatrix.array as Float32Array;
    const fill = this.fill.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < sim.n && n < this.capacity; i++) {
      if (!sim.eActive[i] || sim.eDist[i] < 0) continue;
      const frac = sim.eHp[i] / sim.eMaxHp[i];
      const t = sim.eType[i];
      if (frac >= 1 && t !== BOSS) continue;
      const w = WIDTH[t], h = HEIGHT[t];
      const x = sim.eX[i], y = hoverY(i) + LIFT[t], z = sim.eZ[i];
      write(back, n, this.right, w, this.up, h, this.fwd, x, y, z);
      // Fill is left-anchored: shrink it and slide it towards the bar's left end.
      const shift = (-(1 - frac) * w) / 2;
      write(fill, n, this.right, Math.max(0.001, w * frac), this.up, h * 0.7,
        this.fwd, x + this.right.x * shift, y + this.right.y * shift, z + this.right.z * shift);
      this.c.copy(frac > 0.5 ? YELLOW : RED).lerp(frac > 0.5 ? GREEN : YELLOW, frac > 0.5 ? (frac - 0.5) * 2 : frac * 2);
      this.colors[n * 3] = this.c.r;
      this.colors[n * 3 + 1] = this.c.g;
      this.colors[n * 3 + 2] = this.c.b;
      n++;
    }
    for (const m of [this.back, this.fill]) {
      m.count = n;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
    }
    this.fill.instanceColor!.clearUpdateRanges();
    this.fill.instanceColor!.addUpdateRange(0, n * 3);
    this.fill.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.back.geometry.dispose();
    for (const m of [this.back, this.fill]) {
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}

function write(a: Float32Array, n: number, r: THREE.Vector3, sx: number, u: THREE.Vector3, sy: number, f: THREE.Vector3, x: number, y: number, z: number): void {
  const o = n * 16;
  a[o] = r.x * sx; a[o + 1] = r.y * sx; a[o + 2] = r.z * sx; a[o + 3] = 0;
  a[o + 4] = u.x * sy; a[o + 5] = u.y * sy; a[o + 6] = u.z * sy; a[o + 7] = 0;
  a[o + 8] = f.x; a[o + 9] = f.y; a[o + 10] = f.z; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}
