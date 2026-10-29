import * as THREE from 'three/webgpu';
import type { Model } from './assets';

/**
 * Draws many copies of a multi-part model with one InstancedMesh per part.
 * Transforms are limited to translation + yaw + uniform scale, which covers
 * everything a top-down tower defense needs and lets us write the 4x4
 * matrices directly into the instance buffer without Matrix4 allocations.
 */
export class InstancedModel {
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly movable: boolean[] = [];
  private readonly arrays: Float32Array[] = [];
  count = 0;

  constructor(model: Model, readonly capacity: number, opts: { dynamic: boolean; castShadow?: boolean; receiveShadow?: boolean }) {
    for (const part of model) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      if (opts.dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? false;
      // Instances span the whole map; per-mesh culling against geometry bounds would be wrong.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.meshes.push(mesh);
      this.movable.push(part.movable);
      this.arrays.push(mesh.instanceMatrix.array as Float32Array);
    }
  }

  addTo(parent: THREE.Object3D): this {
    for (const m of this.meshes) parent.add(m);
    return this;
  }

  /** Writes instance `i`. `recoil` pushes movable parts (barrels) back along local -Z. */
  set(i: number, x: number, y: number, z: number, yaw: number, scale: number, recoil = 0): void {
    const c = Math.cos(yaw) * scale;
    const s = Math.sin(yaw) * scale;
    const o = i * 16;
    for (let p = 0; p < this.arrays.length; p++) {
      const a = this.arrays[p];
      let tx = x;
      let tz = z;
      if (recoil !== 0 && this.movable[p]) {
        // Local (0,0,-recoil) rotated by yaw.
        tx -= s * recoil;
        tz -= c * recoil;
      }
      // Column-major rotation about Y.
      a[o] = c; a[o + 1] = 0; a[o + 2] = -s; a[o + 3] = 0;
      a[o + 4] = 0; a[o + 5] = scale; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = s; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
      a[o + 12] = tx; a[o + 13] = y; a[o + 14] = tz; a[o + 15] = 1;
    }
  }

  /** Uploads instances [0, count). Call once per frame after all `set` calls. */
  commit(count: number): void {
    this.count = count;
    for (const m of this.meshes) {
      m.count = count;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, count * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  }
}
