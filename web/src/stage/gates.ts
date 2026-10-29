import * as THREE from 'three/webgpu';
import { modelHeight } from '../engine/assets';
import type { ThemeId, Themes } from '../engine/themes';
import { type GameMap, cellToWorld } from './map';

const KEEP = ['tower-square-bottom-c', 'tower-square-middle-c', 'tower-square-roof-c'];
export const GATE_MODELS = [...KEEP, 'spawn-round'];

/**
 * The two ends of the road: a swirling portal where the saucers arrive, and
 * the keep you are defending, which shakes when they get through.
 */
export class Gates {
  readonly keep = new THREE.Group();
  readonly portal = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly keepHome = new THREE.Vector3();
  private shake = 0;

  constructor(map: GameMap, themes: Themes, theme: ThemeId, scene: THREE.Scene) {
    const outward = (end: number, inner: number) => {
      const a = map.pathCells[end], b = map.pathCells[inner];
      const [x, z] = cellToWorld(...a);
      const dx = a[0] - b[0], dz = a[1] - b[1];
      return { x, z, dx, dz, yaw: Math.atan2(-dx, -dz) };
    };

    const exit = outward(map.pathCells.length - 1, map.pathCells.length - 2);
    let y = 0;
    for (const name of KEEP) {
      for (const part of themes.model(name, theme)) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.position.y = y;
        mesh.castShadow = mesh.receiveShadow = true;
        this.keep.add(mesh);
      }
      y += modelHeight(themes.model(name, theme));
    }
    this.keep.scale.setScalar(1.6);
    this.keepHome.set(exit.x + exit.dx * 1.9, 0.2, exit.z + exit.dz * 1.9);
    this.keep.position.copy(this.keepHome);
    this.keep.rotation.y = exit.yaw;
    scene.add(this.keep);

    const entry = outward(0, 1);
    for (const part of themes.model('spawn-round', theme)) {
      const pad = new THREE.Mesh(part.geometry, part.material);
      pad.scale.setScalar(1.5);
      pad.receiveShadow = true;
      this.portal.add(pad);
    }
    const additive = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.07, 10, 40), additive(0xb06cff, 0.95));
    this.glow = new THREE.Mesh(new THREE.CircleGeometry(0.58, 40), additive(0x7a3cff, 0.45));
    // The ring stands upright, facing along the road.
    for (const m of [this.ring, this.glow]) {
      m.position.y = 0.75;
      this.portal.add(m);
    }
    this.portal.position.set(entry.x + entry.dx * 1.2, 0.2, entry.z + entry.dz * 1.2);
    this.portal.rotation.y = entry.yaw;
    scene.add(this.portal);
  }

  /** Call when saucers reach the keep. */
  hit(strength: number): void {
    this.shake = Math.min(0.6, this.shake + 0.25 * strength);
  }

  update(dt: number, time: number): void {
    this.ring.rotation.z = time * 1.5;
    const pulse = 1 + Math.sin(time * 4) * 0.06;
    this.ring.scale.setScalar(pulse);
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(time * 3) * 0.12;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.25;
      this.keep.position.set(this.keepHome.x + Math.sin(time * 70) * a, this.keepHome.y, this.keepHome.z + Math.cos(time * 63) * a);
    } else {
      this.keep.position.copy(this.keepHome);
    }
  }

  dispose(): void {
    for (const m of [this.ring, this.glow]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
