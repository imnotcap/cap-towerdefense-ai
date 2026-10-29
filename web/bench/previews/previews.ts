// Renders card art from the game's own models: each tower kind (its level-1 stack
// with the weapon on top) and the ability icons. Driven by bench/previews/render.mjs,
// which screenshots the canvas with a transparent background after each `window.show(i)`.
import * as THREE from 'three/webgpu';
import { loadModels, modelHeight } from '../../src/engine/assets';
import { TOWER_KINDS, TOWER_STACKS } from '../../src/stage/towers';

const SIZE = 384;
const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true });
await renderer.init();
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);

/** Single-model icons: output name → model. */
const ICONS: Record<string, string> = { meteor: 'weapon-ammo-boulder', freeze: 'snow-detail-crystal-large' };
const names = [...new Set([...TOWER_STACKS.map((levels) => levels[0]).flat(), ...TOWER_KINDS.map((t) => t.weapon), ...Object.values(ICONS)])];
const models = await loadModels(names);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a6a50, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(3, 6, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);

const meshOf = (name: string, y: number) => {
  const group = new THREE.Group();
  for (const p of models.get(name)!) group.add(new THREE.Mesh(p.geometry, p.material));
  group.position.y = y;
  return group;
};

let current: THREE.Group | null = null;
const outputs = [...TOWER_KINDS.map((t) => t.key), ...Object.keys(ICONS)];

async function show(i: number): Promise<void> {
  if (current) scene.remove(current);
  const tower = new THREE.Group();
  if (i < TOWER_KINDS.length) {
    let y = 0;
    for (const name of TOWER_STACKS[i][0]) {
      tower.add(meshOf(name, y));
      y += modelHeight(models.get(name)!);
    }
    const weapon = meshOf(TOWER_KINDS[i].weapon, y);
    weapon.rotation.y = -Math.PI / 5; // turn the barrel towards the viewer
    tower.add(weapon);
  } else {
    tower.add(meshOf(ICONS[outputs[i]], 0));
  }
  scene.add(tower);
  current = tower;
  // Frame the bounding box from a three-quarter view, filling the canvas.
  const box = new THREE.Box3().setFromObject(tower);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
  camera.position.copy(centre).addScaledVector(dir, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.lookAt(centre);
  await renderer.renderAsync(scene, camera);
}

Object.assign(window, { show, kinds: outputs, ready: true });
