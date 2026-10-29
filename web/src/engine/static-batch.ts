import * as THREE from 'three/webgpu';
import type { Model } from './assets';

/** Decides whether a world-space triangle can be dropped. */
export type FaceCull = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3) => boolean;

interface Bucket {
  material: THREE.Material;
  castShadow: boolean;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/**
 * Bakes static scenery into one mesh per (material, shadow mode). The whole
 * map then costs a couple of draw calls instead of one per tile type, and
 * hidden faces are removed at build time.
 */
export class StaticBatcher {
  private readonly buckets = new Map<string, Bucket>();
  private readonly m = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();
  private readonly v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly n = new THREE.Vector3();
  private readonly e1 = new THREE.Vector3();
  private readonly e2 = new THREE.Vector3();
  trianglesIn = 0;
  trianglesOut = 0;

  constructor(private readonly cull: FaceCull = () => false) {}

  add(model: Model, x: number, y: number, z: number, yaw: number, castShadow: boolean): void {
    this.m.makeRotationY(yaw).setPosition(x, y, z);
    this.nm.getNormalMatrix(this.m);
    for (const part of model) {
      const key = `${part.material.uuid}:${castShadow}`;
      let b = this.buckets.get(key);
      if (!b) {
        b = { material: part.material, castShadow, positions: [], normals: [], uvs: [], indices: [] };
        this.buckets.set(key, b);
      }
      this.append(b, part.geometry);
    }
  }

  private append(b: Bucket, g: THREE.BufferGeometry): void {
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const base = b.positions.length / 3;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(this.m);
      b.positions.push(p.x, p.y, p.z);
      p.fromBufferAttribute(nor, i).applyMatrix3(this.nm).normalize();
      b.normals.push(p.x, p.y, p.z);
      b.uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const index = g.getIndex();
    const triCount = (index ? index.count : pos.count) / 3;
    const [va, vb, vc] = this.v;
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      this.trianglesIn++;
      va.fromArray(b.positions, (base + i0) * 3);
      vb.fromArray(b.positions, (base + i1) * 3);
      vc.fromArray(b.positions, (base + i2) * 3);
      this.n.crossVectors(this.e1.subVectors(vb, va), this.e2.subVectors(vc, va)).normalize();
      if (this.cull(va, vb, vc, this.n)) continue;
      this.trianglesOut++;
      b.indices.push(base + i0, base + i1, base + i2);
    }
  }

  build(parent: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const b of this.buckets.values()) {
      if (b.indices.length === 0) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setIndex(b.indices);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, b.material);
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.buckets.clear();
    return meshes;
  }
}
