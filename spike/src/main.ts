import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModels } from './assets';
import { InstancedModel } from './instancing';
import { DECOR, GROUND_TILES, MAP_H, MAP_W, PATH_TILES, buildMap, buildTerrain, cullHiddenTerrainFaces } from './map';
import { StaticBatcher } from './static-batch';
import { AMMO_FOR_WEAPON, ENEMY_TYPES, MAX_PARTICLES, Sim, TICK, TOWER_WEAPON_Y, WEAPON_TYPES } from './sim';
import { StatsPanel, buttonRow, hideLoading, setLoadingMessage, setLoadingProgress, type Tone } from './ui';

const params = new URLSearchParams(location.search);
const MAX_ENEMIES = 10000;
const ENEMY_MODELS = ['enemy-ufo-a', 'enemy-ufo-b', 'enemy-ufo-c', 'enemy-ufo-d'];
const TOWER_STACK = ['tower-round-bottom-a', 'tower-round-top-a'];
const PRESETS = [250, 1000, 2500, 5000, 10000];
const ENEMY_SHADOW_LIMIT = 2500;

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = !params.has('noshadow');
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc6e6);

  // Top-down camera, tilted ~60° so models read as 3D.
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.0;
  controls.minDistance = 6;
  controls.maxDistance = 90;
  controls.screenSpacePanning = false;
  const viewDir = new THREE.Vector3(0, 22, 13).normalize();

  /** Pulls the camera back until all four map corners are on screen, clear of the bottom controls bar. */
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.Vector3((sx * MAP_W) / 2, 0, (sz * MAP_H) / 2)));
  const ndc = new THREE.Vector3();
  function fitCamera() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    const bottom = -1 + (2 * 110) / innerHeight;
    const fits = (dist: number) => {
      camera.position.copy(viewDir).multiplyScalar(dist);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      return corners.every((c) => {
        ndc.copy(c).project(camera);
        return Math.abs(ndc.x) <= 0.97 && ndc.y <= 0.97 && ndc.y >= bottom;
      });
    };
    let lo = 5, hi = 150;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
    scene.fog = new THREE.Fog(0x9fc6e6, hi + 8, hi + 40);
  }
  fitCamera();

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
  sun.position.set(-10, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -MAP_W / 2 - 1; sc.right = MAP_W / 2 + 1; sc.top = MAP_H / 2 + 3; sc.bottom = -MAP_H / 2 - 3;
  sc.near = 1; sc.far = 50;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const t0 = performance.now();
  const models = await loadModels(
    [...GROUND_TILES, ...PATH_TILES, ...DECOR, ...ENEMY_MODELS, ...TOWER_STACK, ...WEAPON_TYPES, ...AMMO_FOR_WEAPON],
    setLoadingProgress,
  );
  const loadMs = performance.now() - t0;
  setLoadingMessage('Building map…');

  const map = buildMap();
  const sim = new Sim(map, MAX_ENEMIES);

  // All static scenery (terrain, decor, tower stacks) is baked into a handful of meshes.
  const batcher = new StaticBatcher(cullHiddenTerrainFaces);
  buildTerrain(map, models, batcher);
  const pads = map.towerPads.length;
  TOWER_STACK.forEach((name, level) => {
    for (let t = 0; t < pads; t++) batcher.add(models.get(name)!, sim.tX[t], 0.2 + level * 0.6, sim.tZ[t], 0, true);
  });
  const staticTris = { before: batcher.trianglesIn, after: batcher.trianglesOut };
  const staticMeshes = batcher.build(scene);

  const enemies = ENEMY_MODELS.map((n) => new InstancedModel(models.get(n)!, MAX_ENEMIES, { dynamic: true }).addTo(scene));
  const weapons = WEAPON_TYPES.map((n) => new InstancedModel(models.get(n)!, pads, { dynamic: true }).addTo(scene));
  const ammo = AMMO_FOR_WEAPON.map((n) => new InstancedModel(models.get(n)!, 4096, { dynamic: true, castShadow: false }).addTo(scene));

  // Spark particles: one instanced low-poly mesh, additive.
  const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffb040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const sparks = new InstancedModel(
    [{ name: 'spark', geometry: new THREE.IcosahedronGeometry(0.06, 0), material: sparkMat, movable: false }],
    MAX_PARTICLES,
    { dynamic: true, castShadow: false },
  ).addTo(scene);

  const enemyCounts = new Int32Array(ENEMY_TYPES);
  const weaponCounts = new Int32Array(WEAPON_TYPES.length);
  const ammoCounts = new Int32Array(AMMO_FOR_WEAPON.length);

  function syncInstances(time: number) {
    enemyCounts.fill(0);
    for (let i = 0; i < sim.n; i++) {
      if (sim.eDist[i] < 0) continue;
      const t = sim.eType[i];
      // Hover bob + slow spin: procedural animation (the kit ships without skeletal clips).
      const bob = 0.25 + Math.sin(time * 3 + i * 1.7) * 0.06;
      enemies[t].set(enemyCounts[t]++, sim.eX[i], bob, sim.eZ[i], time * 1.5 + i, 0.55);
    }
    enemies.forEach((m, t) => m.commit(enemyCounts[t]));

    weaponCounts.fill(0);
    for (let t = 0; t < sim.towerCount; t++) {
      const w = sim.tWeapon[t];
      weapons[w].set(weaponCounts[w]++, sim.tX[t], TOWER_WEAPON_Y, sim.tZ[t], sim.tYaw[t], 1, sim.tRecoil[t]);
    }
    weapons.forEach((m, w) => m.commit(weaponCounts[w]));

    ammoCounts.fill(0);
    for (let p = 0; p < sim.pCount; p++) {
      const k = sim.pKind[p];
      ammo[k].set(ammoCounts[k]++, sim.pX[p], sim.pY[p], sim.pZ[p], sim.pYaw[p], 1);
    }
    ammo.forEach((m, k) => m.commit(ammoCounts[k]));

    let live = 0;
    for (let q = 0; q < MAX_PARTICLES; q++) {
      const life = sim.qLife[q];
      if (life <= 0) continue;
      sparks.set(live++, sim.qX[q], sim.qY[q], sim.qZ[q], 0, Math.min(1, life * 2.5));
    }
    sparks.commit(live);
  }

  // --- HUD & controls ---
  const stats = new StatsPanel(document.getElementById('hud')!, 'Phase 0 · Perf', [
    'Backend', 'FPS', 'CPU / frame', 'Sim / tick', 'Enemies', 'Towers', 'Shots', 'Draw calls', 'Triangles', 'Static tris', 'Load',
  ]);
  stats.set('Backend', backend, backend === 'WebGPU' ? 'good' : 'warn');
  stats.set('Towers', String(sim.towerCount));
  stats.set('Static tris', `${(staticTris.after / 1000).toFixed(1)}k (−${Math.round((1 - staticTris.after / staticTris.before) * 100)}%) in ${staticMeshes.length} meshes`);
  stats.set('Load', `${loadMs.toFixed(0)} ms`);
  const score = document.querySelector<HTMLElement>('#score span')!;

  const initial = Number(params.get('n') ?? 1000);
  const counts = buttonRow(
    document.getElementById('controls')!,
    'Enemies',
    PRESETS.map((n) => ({ value: n, text: n.toLocaleString() })),
    setCount,
  );
  function setCount(n: number) {
    sim.setEnemyCount(n);
    // Each UFO is ~500 tris; drawing them again into the shadow map doubles that, so drop it for big hordes.
    for (const m of enemies) for (const mesh of m.meshes) mesh.castShadow = n <= ENEMY_SHADOW_LIMIT;
    counts.select(n);
  }
  setCount(initial);
  hideLoading();

  addEventListener('resize', () => {
    fitCamera();
    renderer.setSize(innerWidth, innerHeight);
  });

  // --- Frame loop: fixed-step sim, variable-rate render ---
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  let simMs = 0;
  let cpuMs = 0;
  const frameTimes: number[] = [];

  const bench = params.has('bench');
  const benchWarmup = 2000;
  const benchDuration = Number(params.get('dur') ?? 5000);

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const rawMs = now - last;
    const dt = Math.min(0.25, rawMs / 1000);
    last = now;
    acc += dt;

    const s0 = performance.now();
    let steps = 0;
    while (acc >= TICK && steps < 5) {
      sim.step();
      acc -= TICK;
      steps++;
    }
    if (steps === 5) acc = 0; // Drop time instead of spiralling when the machine can't keep up.
    const s1 = performance.now();

    syncInstances(now / 1000);
    controls.update();
    renderer.render(scene, camera);
    const s2 = performance.now();

    if (steps > 0) simMs = simMs * 0.9 + ((s1 - s0) / steps) * 0.1;
    cpuMs = cpuMs * 0.9 + (s2 - s0) * 0.1;
    frames++;
    if (bench && now - t0 > loadMs + benchWarmup) frameTimes.push(rawMs);
    if (now - fpsTime > 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const info = renderer.info.render;
      const tone = (v: number, good: number, ok: number): Tone => (v <= good ? 'good' : v <= ok ? 'warn' : 'bad');
      stats.set('FPS', fps.toFixed(0), tone(-fps, -55, -30));
      stats.set('CPU / frame', `${cpuMs.toFixed(2)} ms`, tone(cpuMs, 8, 16));
      stats.set('Sim / tick', `${simMs.toFixed(2)} ms`, tone(simMs, 2, 5));
      stats.set('Enemies', sim.n.toLocaleString());
      stats.set('Shots', String(sim.pCount));
      stats.set('Draw calls', String(info.drawCalls));
      stats.set('Triangles', `${(info.triangles / 1e6).toFixed(2)}M`);
      score.textContent = sim.kills.toLocaleString();
    }

    if (bench && frameTimes.length > 0 && now - t0 > loadMs + benchWarmup + benchDuration) {
      renderer.setAnimationLoop(null);
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      (window as unknown as { __bench: unknown }).__bench = {
        backend,
        enemies: sim.n,
        frames: frameTimes.length,
        avgFrameMs: avg,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        fps: 1000 / avg,
        cpuMs,
        simMs,
        drawCalls: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
        loadMs,
      };
    }
  });
}

main().catch((err) => {
  setLoadingMessage(`Failed to start: ${err}`);
  console.error(err);
});
