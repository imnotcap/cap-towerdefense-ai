// GPU-independent CPU benchmark: simulation tick + instance-matrix upload prep.
// Usage: npm run bench:sim
import * as THREE from 'three/webgpu';
import { InstancedModel } from '../src/instancing';
import { buildMap } from '../src/map';
import { Sim } from '../src/sim';

const map = buildMap();
const box: THREE.BufferGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const model = [{ name: 'enemy', geometry: box, material: new THREE.MeshBasicMaterial(), movable: false }];
const TICKS = 600;

const rows = [];
for (const n of [250, 1000, 2500, 5000, 10000, 20000]) {
  const sim = new Sim(map, n);
  sim.setEnemyCount(n);
  const inst = new InstancedModel(model, n, { dynamic: true });
  for (let i = 0; i < 120; i++) sim.step(); // warm up the JIT

  let simTotal = 0;
  let syncTotal = 0;
  for (let i = 0; i < TICKS; i++) {
    const a = performance.now();
    sim.step();
    const b = performance.now();
    for (let e = 0; e < sim.n; e++) inst.set(e, sim.eX[e], 0.25, sim.eZ[e], sim.eYaw[e], 0.55);
    inst.commit(sim.n);
    syncTotal += performance.now() - b;
    simTotal += b - a;
  }
  rows.push({
    enemies: n,
    'sim ms/tick': +(simTotal / TICKS).toFixed(3),
    'matrix sync ms/frame': +(syncTotal / TICKS).toFixed(3),
    'kills/s': Math.round(sim.kills / (TICKS / 60)),
    'shots in flight': sim.pCount,
    'budget used @60fps': `${(((simTotal + syncTotal) / TICKS / 16.67) * 100).toFixed(1)}%`,
  });
}
console.table(rows);
