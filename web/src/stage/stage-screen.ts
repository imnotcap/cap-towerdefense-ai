import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Screen } from '../engine/app';
import type { Model } from '../engine/assets';
import { InstancedModel } from '../engine/instancing';
import { StaticBatcher } from '../engine/static-batch';
import { THEME_SKY, type ThemeId } from '../engine/themes';
import { tileGridCuller } from '../engine/tiles';
import type { Game } from '../game';
import { DIFFICULTY, starsFor, stageReward, type Difficulty, type StageDef } from '../meta/catalog';
import type { Modifiers } from '../meta/profile';
import { button, crystal, formatNumber, h, modal, sfx, stars } from '../ui/dom';
import { MAP_H, MAP_W, PATH_LAYOUTS, buildMap, buildTerrain } from './map';
import { AMMO_FOR_WEAPON, BASE_WEAPON_STATS, ENEMY_TYPES, MAX_PARTICLES, Sim, TICK, TOWER_WEAPON_Y, WEAPON_TYPES } from './sim';

export const ENEMY_MODELS = ['enemy-ufo-a', 'enemy-ufo-b', 'enemy-ufo-c', 'enemy-ufo-d'];
export const TOWER_STACK = ['tower-round-bottom-a', 'tower-round-top-a'];
const MAX_ENEMIES = 10000;
const ENEMY_SHADOW_LIMIT = 2500;
const SPARK_COLORS = [0xffb040, 0xffe066, 0x9fe4ff];

export type StageMode =
  | { kind: 'campaign'; stage: StageDef; difficulty: Difficulty }
  | { kind: 'bench'; enemies: number };

/**
 * One battle: a themed map, towers firing at waves of UFOs, abilities, and a
 * results screen. In bench mode it becomes the endless stress test with a perf panel.
 */
export class StageScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);
  readonly sim: Sim;
  private readonly controls: OrbitControls;
  private readonly mods: Modifiers;
  private readonly theme: ThemeId;
  private readonly enemies: InstancedModel[];
  private readonly enemyMaterial: THREE.MeshStandardMaterial;
  private readonly weapons: InstancedModel[];
  private readonly ammo: InstancedModel[];
  private readonly sparks: InstancedModel[];
  private readonly meteorRock: InstancedModel;
  private readonly targetRing: THREE.Mesh;
  private readonly staticMeshes: THREE.Mesh[];
  private readonly enemyCounts = new Int32Array(ENEMY_TYPES);
  private readonly weaponCounts = new Int32Array(WEAPON_TYPES.length);
  private readonly ammoCounts = new Int32Array(AMMO_FOR_WEAPON.length);
  private readonly sparkCounts = new Int32Array(SPARK_COLORS.length);
  private readonly viewDir = new THREE.Vector3(0, 22, 13).normalize();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private ui!: HTMLElement;
  private acc = 0;
  private speed = 1;
  private paused = false;
  private finished = false;
  private armedMeteor = false;
  private cooldowns = { meteor: 0, freeze: 0 };
  private hud: { lives?: HTMLElement; wave?: HTMLElement; meteor?: HTMLElement; freeze?: HTMLElement; aim?: HTMLElement } = {};
  /** Exponential moving averages for the perf panel. */
  readonly perf = { simMs: 0, cpuMs: 0, staticTris: 0, staticTrisBefore: 0, staticMeshes: 0 };
  private onPointer = (e: PointerEvent) => this.handlePointer(e);

  constructor(private readonly game: Game, readonly mode: StageMode) {
    const campaign = mode.kind === 'campaign' ? mode : null;
    this.mods = mode.kind === 'bench'
      ? { weapons: [...BASE_WEAPON_STATS], lives: 1, crystalBonus: 0, critChance: 0, meteor: null, freeze: null }
      : game.profile.modifiers();
    this.theme = campaign?.stage.area.theme ?? 'grass';
    const map = buildMap(PATH_LAYOUTS[campaign?.stage.layout ?? 0]);
    this.sim = new Sim(map, MAX_ENEMIES, {
      weapons: this.mods.weapons,
      critChance: this.mods.critChance,
      hpScale: campaign ? campaign.stage.hpScale * DIFFICULTY[campaign.difficulty].hp : 1,
      speedScale: campaign?.stage.speedScale ?? 1,
      lives: this.mods.lives,
      waves: campaign?.stage.waves ?? null,
    });
    if (mode.kind === 'bench') this.sim.setEnemyCount(mode.enemies);

    const sky = THEME_SKY[this.theme];
    this.scene.background = new THREE.Color(sky);
    this.setupLights();
    this.controls = new OrbitControls(this.camera, game.app.canvas);
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.0;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;
    this.controls.screenSpacePanning = false;
    this.controls.enabled = false;

    // All static scenery (terrain, decor, tower stacks) is baked into a handful of meshes.
    const { themes, models } = game;
    const batcher = new StaticBatcher(tileGridCuller(MAP_W, MAP_H));
    buildTerrain(map, themes, this.theme, batcher, campaign?.stage.seed);
    TOWER_STACK.forEach((name, level) => {
      const model = themes.model(name, this.theme);
      for (let t = 0; t < this.sim.towerCount; t++) batcher.add(model, this.sim.tX[t], 0.2 + level * 0.6, this.sim.tZ[t], 0, true);
    });
    this.perf.staticTrisBefore = batcher.trianglesIn;
    this.perf.staticTris = batcher.trianglesOut;
    this.staticMeshes = batcher.build(this.scene);
    this.perf.staticMeshes = this.staticMeshes.length;

    // Enemies get their own material so freezing can tint them without touching the map.
    this.enemyMaterial = (models.get(ENEMY_MODELS[0])![0].material as THREE.MeshStandardMaterial).clone();
    const withMaterial = (m: Model, material: THREE.Material): Model => m.map((p) => ({ ...p, material }));
    this.enemies = ENEMY_MODELS.map((n) =>
      new InstancedModel(withMaterial(models.get(n)!, this.enemyMaterial), MAX_ENEMIES, { dynamic: true }).addTo(this.scene));
    const pads = this.sim.towerCount;
    this.weapons = WEAPON_TYPES.map((n) => new InstancedModel(models.get(n)!, pads, { dynamic: true }).addTo(this.scene));
    this.ammo = AMMO_FOR_WEAPON.map((n) => new InstancedModel(models.get(n)!, 4096, { dynamic: true, castShadow: false }).addTo(this.scene));
    const sparkGeometry = new THREE.IcosahedronGeometry(0.06, 0);
    this.sparks = SPARK_COLORS.map((color) => {
      const material = new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      return new InstancedModel([{ name: 'spark', geometry: sparkGeometry, material, movable: false }], MAX_PARTICLES, { dynamic: true, castShadow: false })
        .addTo(this.scene);
    });
    this.meteorRock = new InstancedModel(models.get('weapon-ammo-boulder')!, 1, { dynamic: true }).addTo(this.scene);
    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);
    this.setEnemyShadows();
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, this.theme === 'dark' || this.theme === 'lava' ? 1.0 : 1.4));
    const sun = new THREE.DirectionalLight(this.theme === 'lava' ? 0xffc4a0 : 0xfff1d6, 2.6);
    sun.position.set(-10, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -MAP_W / 2 - 1; sc.right = MAP_W / 2 + 1; sc.top = MAP_H / 2 + 3; sc.bottom = -MAP_H / 2 - 3;
    sc.near = 1; sc.far = 50;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  /** Each UFO is ~500 tris; drawing them again into the shadow map doubles that, so drop it for big hordes. */
  setEnemyShadows(): void {
    const cast = this.sim.n <= ENEMY_SHADOW_LIMIT;
    for (const m of this.enemies) for (const mesh of m.meshes) mesh.castShadow = cast;
  }

  enter(ui: HTMLElement): void {
    this.ui = ui;
    this.controls.enabled = true;
    this.game.app.canvas.addEventListener('pointerdown', this.onPointer);
    if (this.mode.kind === 'campaign') this.buildHud(this.mode.stage);
  }

  exit(): void {
    this.controls.enabled = false;
    this.controls.dispose();
    this.game.app.canvas.removeEventListener('pointerdown', this.onPointer);
    // Free per-battle GPU resources. Model geometries and the kit material are shared, so they stay.
    for (const m of this.staticMeshes) m.geometry.dispose();
    for (const im of [...this.enemies, ...this.weapons, ...this.ammo, ...this.sparks, this.meteorRock]) {
      for (const mesh of im.meshes) mesh.dispose();
    }
    this.sparks[0].meshes[0].geometry.dispose();
    for (const s of this.sparks) (s.meshes[0].material as THREE.Material).dispose();
    this.enemyMaterial.dispose();
    this.targetRing.geometry.dispose();
    (this.targetRing.material as THREE.Material).dispose();
  }

  private buildHud(stage: StageDef): void {
    this.hud.lives = h('span', {}, '');
    this.hud.wave = h('span', {}, '');
    const speedBtn = button('1×', () => {
      this.speed = this.speed === 1 ? 2 : 1;
      speedBtn.textContent = `${this.speed}×`;
      speedBtn.classList.toggle('yellow', this.speed === 2);
    }, 'small');
    this.ui.append(
      h('div', { class: 'stage-top' },
        h('div', { class: 'panel' }, h('span', { class: 'heart' }), this.hud.lives),
        h('div', { class: 'panel' }, h('span', { class: 'label' }, 'Wave'), this.hud.wave),
        h('div', { class: 'panel', style: 'flex-direction: column; align-items: flex-start; gap: 0' },
          h('span', { class: 'title', style: 'font-size: 14px' }, stage.name),
          h('span', { class: 'label' }, `${stage.area.name} · ${DIFFICULTY[(this.mode as { difficulty: Difficulty }).difficulty].label}`)),
      ),
      h('div', { class: 'resources' }, speedBtn, button('Retreat', () => this.confirmRetreat(), 'small red')),
    );

    const abilities = h('div', { class: 'abilities' });
    if (this.mods.meteor) {
      this.hud.meteor = h('span', { class: 'cd' });
      abilities.append(h('div', { class: 'ability' },
        button(abilityLabel('weapon-ammo-boulder', 'Meteor'), () => this.armMeteor(), 'yellow'), this.hud.meteor));
    }
    if (this.mods.freeze) {
      this.hud.freeze = h('span', { class: 'cd' });
      abilities.append(h('div', { class: 'ability' },
        button(abilityLabel('snow-detail-crystal', 'Freeze'), () => this.castFreeze(), ''), this.hud.freeze));
    }
    this.ui.append(abilities);
  }

  private armMeteor(): void {
    if (this.cooldowns.meteor > 0 || this.finished) return;
    this.armedMeteor = !this.armedMeteor;
    this.hud.meteor?.parentElement?.classList.toggle('armed', this.armedMeteor);
    this.hud.aim?.remove();
    if (this.armedMeteor) {
      this.hud.aim = h('div', { class: 'aim-hint panel white title', style: 'font-size: 13px' }, 'Tap the map to drop the meteor');
      this.ui.append(this.hud.aim);
    }
  }

  private castFreeze(): void {
    const f = this.mods.freeze;
    if (!f || this.cooldowns.freeze > 0 || this.finished) return;
    this.sim.castFreeze(f.seconds);
    this.cooldowns.freeze = f.cooldown;
    sfx('switch-b');
  }

  private handlePointer(e: PointerEvent): void {
    const m = this.mods.meteor;
    if (!this.armedMeteor || !m) return;
    const rect = this.game.app.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    if (!hit || Math.abs(hit.x) > MAP_W / 2 || Math.abs(hit.z) > MAP_H / 2) return;
    this.sim.castMeteor(hit.x, hit.z, m.radius, m.damage);
    this.targetRing.position.set(hit.x, 0.25, hit.z);
    this.targetRing.scale.setScalar(m.radius);
    this.targetRing.visible = true;
    this.cooldowns.meteor = m.cooldown;
    this.armMeteor();
    sfx('tap-a');
  }

  private confirmRetreat(): void {
    this.paused = true;
    const close = modal(this.ui, h('div', { class: 'results' },
      h('h2', {}, 'Retreat?'),
      h('p', { class: 'sub' }, 'You will lose this battle and earn nothing.'),
      h('div', { class: 'actions' },
        button('Keep fighting', () => close(), 'green'),
        button('Retreat', () => this.game.goToWorld((this.mode as { stage: StageDef }).stage), 'red'))),
    () => (this.paused = false));
  }

  private finish(): void {
    if (this.mode.kind !== 'campaign' || this.finished) return;
    this.finished = true;
    const { stage, difficulty } = this.mode;
    const won = this.sim.status === 'won';
    const earnedStars = won ? starsFor(this.sim.lives, this.mods.lives) : 0;
    const firstClear = won && this.game.profile.stars(stage.id) === 0;
    const base = won ? stageReward(stage, earnedStars, difficulty, firstClear) : Math.floor(this.sim.kills / 6);
    const reward = Math.round(base * (1 + this.mods.crystalBonus));
    this.game.profile.recordClear(stage, earnedStars, reward);
    sfx(won ? 'switch-a' : 'tap-b');

    const content = h('div', { class: 'results' },
      h('h2', {}, won ? 'Victory!' : 'Defeated'),
      h('p', { class: 'sub' }, `${stage.name} · ${DIFFICULTY[difficulty].label}`),
      stars(earnedStars),
      h('div', { class: 'reward' }, '+', formatNumber(reward), crystal()),
      won && firstClear ? h('p', { class: 'sub' }, 'First clear bonus included') : null,
      h('p', { class: 'sub' }, `${formatNumber(this.sim.kills)} saucers downed · ${this.sim.leaked} slipped through`),
      h('div', { class: 'actions' },
        button('Retry', () => this.game.goToStage(stage, difficulty), 'grey'),
        button('World Map', () => this.game.goToWorld(stage), 'green')),
    );
    setTimeout(() => modal(this.ui, content, undefined, false), 600);
  }

  resize(width: number, height: number): void {
    this.fitCamera(width, height);
  }

  /** Pulls the camera back until all four map corners are on screen, clear of the HUD. */
  private fitCamera(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.Vector3((sx * MAP_W) / 2, 0, (sz * MAP_H) / 2)));
    const ndc = new THREE.Vector3();
    const bottom = -1 + (2 * 90) / height;
    const top = 1 - (2 * 70) / height;
    const fits = (dist: number) => {
      this.camera.position.copy(this.viewDir).multiplyScalar(dist);
      this.camera.lookAt(0, 0, 0);
      this.camera.updateMatrixWorld();
      return corners.every((c) => {
        ndc.copy(c).project(this.camera);
        return Math.abs(ndc.x) <= 0.97 && ndc.y <= top && ndc.y >= bottom;
      });
    };
    let lo = 5, hi = 150;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
    const sky = THEME_SKY[this.theme];
    this.scene.fog = new THREE.Fog(sky, hi + 8, hi + 40);
  }

  update(dt: number, time: number): void {
    const s0 = performance.now();
    let steps = 0;
    if (!this.paused) {
      this.acc += dt * this.speed;
      const maxSteps = 5 * this.speed;
      while (this.acc >= TICK && steps < maxSteps) {
        this.sim.step();
        this.acc -= TICK;
        steps++;
      }
      if (steps === maxSteps) this.acc = 0; // Drop time instead of spiralling when the machine can't keep up.
      const simDt = steps * TICK;
      this.cooldowns.meteor = Math.max(0, this.cooldowns.meteor - simDt);
      this.cooldowns.freeze = Math.max(0, this.cooldowns.freeze - simDt);
    }
    const s1 = performance.now();

    this.syncInstances(time);
    this.controls.update();
    if (steps > 0) this.perf.simMs = this.perf.simMs * 0.9 + ((s1 - s0) / steps) * 0.1;
    this.perf.cpuMs = this.perf.cpuMs * 0.9 + (performance.now() - s0) * 0.1;

    if (this.mode.kind === 'campaign') {
      this.updateHud();
      if (this.sim.status !== 'running') this.finish();
    }
  }

  private updateHud(): void {
    const { hud, sim } = this;
    setText(hud.lives!, `${Math.max(0, sim.lives)}`);
    setText(hud.wave!, `${Math.min(sim.wave + 1, sim.totalWaves)} / ${sim.totalWaves}`);
    if (hud.meteor) setText(hud.meteor, this.cooldowns.meteor > 0 ? `${Math.ceil(this.cooldowns.meteor)}s` : '');
    if (hud.freeze) setText(hud.freeze, this.cooldowns.freeze > 0 ? `${Math.ceil(this.cooldowns.freeze)}s` : '');
  }

  private syncInstances(time: number): void {
    const { sim } = this;
    this.enemyCounts.fill(0);
    for (let i = 0; i < sim.n; i++) {
      if (!sim.eActive[i] || sim.eDist[i] < 0) continue;
      const t = sim.eType[i];
      // Hover bob + slow spin: procedural animation (the kit ships without skeletal clips).
      const spin = sim.freezeLeft > 0 ? 0.2 : 1.5;
      const bob = 0.25 + Math.sin(time * 3 + i * 1.7) * 0.06;
      this.enemies[t].set(this.enemyCounts[t]++, sim.eX[i], bob, sim.eZ[i], time * spin + i, 0.55);
    }
    this.enemies.forEach((m, t) => m.commit(this.enemyCounts[t]));
    this.enemyMaterial.color.setHex(sim.freezeLeft > 0 ? 0x9fdcff : 0xffffff);

    this.weaponCounts.fill(0);
    for (let t = 0; t < sim.towerCount; t++) {
      const w = sim.tWeapon[t];
      this.weapons[w].set(this.weaponCounts[w]++, sim.tX[t], TOWER_WEAPON_Y, sim.tZ[t], sim.tYaw[t], 1, sim.tRecoil[t]);
    }
    this.weapons.forEach((m, w) => m.commit(this.weaponCounts[w]));

    this.ammoCounts.fill(0);
    for (let p = 0; p < sim.pCount; p++) {
      const k = sim.pKind[p];
      this.ammo[k].set(this.ammoCounts[k]++, sim.pX[p], sim.pY[p], sim.pZ[p], sim.pYaw[p], 1);
    }
    this.ammo.forEach((m, k) => m.commit(this.ammoCounts[k]));

    this.sparkCounts.fill(0);
    for (let q = 0; q < MAX_PARTICLES; q++) {
      const life = sim.qLife[q];
      if (life <= 0) continue;
      const hue = sim.qHue[q];
      this.sparks[hue].set(this.sparkCounts[hue]++, sim.qX[q], sim.qY[q], sim.qZ[q], 0, Math.min(1, life * 2.5));
    }
    this.sparks.forEach((m, k) => m.commit(this.sparkCounts[k]));

    const m = sim.meteor;
    if (m.active) this.meteorRock.set(0, m.x, m.y, m.z, time * 4, 3.2);
    this.meteorRock.commit(m.active ? 1 : 0);
    if (!m.active) this.targetRing.visible = false;
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function abilityLabel(icon: string, text: string): HTMLElement {
  return h('span', { style: 'display: contents' }, h('img', { src: `models/kenney-td/Previews/${icon}.png`, alt: '' }), text);
}
