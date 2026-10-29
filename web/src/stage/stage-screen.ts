import * as THREE from 'three/webgpu';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { Screen } from '../engine/app';
import { type Model, modelHeight } from '../engine/assets';
import { InstancedModel } from '../engine/instancing';
import { StaticBatcher } from '../engine/static-batch';
import { THEME_SKY, type ThemeId } from '../engine/themes';
import { tileGridCuller } from '../engine/tiles';
import type { Game } from '../game';
import { DIFFICULTY, starsFor, stageReward, type Difficulty, type StageDef } from '../meta/catalog';
import type { Modifiers } from '../meta/profile';
import { button, crystal, formatNumber, h, modal, sfx, stars } from '../ui/dom';
import { BORDER, buildBorder } from './border';
import { MAP_H, MAP_W, PATH_LAYOUTS, buildMap, buildTerrain, cellToWorld } from './map';
import { AMMO_FOR_WEAPON, BASE_WEAPON_STATS, ENEMY_TYPES, MAX_PARTICLES, PARTICLE_DUST, Sim, TICK, WEAPON_TYPES } from './sim';
import { TowerPanel } from './tower-panel';
import { TOWER_KINDS, TOWER_MODELS, TOWER_STACKS, type TowerKind } from './towers';

export const ENEMY_MODELS = ['enemy-ufo-a', 'enemy-ufo-b', 'enemy-ufo-c', 'enemy-ufo-d'];
export const STAGE_EXTRA_MODELS = ['selection-a', 'weapon-ammo-boulder'];
const MAX_ENEMIES = 10000;
const ENEMY_SHADOW_LIMIT = 2500;
/** Ember, gold (crits/upgrades), ice, build dust. */
const SPARK_COLORS = [0xffb040, 0xffe066, 0x9fe4ff, 0xd9cbb0];
const BUILD_ANIM_SECONDS = 0.45;
const TILE_TOP = 0.2;

export type StageMode =
  | { kind: 'campaign'; stage: StageDef; difficulty: Difficulty }
  | { kind: 'bench'; enemies: number };

/**
 * One battle: a themed map with build pads, waves of UFOs, towers the player
 * builds/upgrades/sells, abilities and a results screen. In bench mode every
 * pad is pre-built and it becomes the endless stress test.
 */
export class StageScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);
  readonly sim: Sim;
  readonly mods: Modifiers;
  private readonly controls: MapControls;
  private readonly theme: ThemeId;
  private readonly enemies: InstancedModel[];
  private readonly enemyMaterial: THREE.MeshStandardMaterial;
  private readonly towerParts = new Map<string, InstancedModel>();
  private readonly partHeights = new Map<string, number>();
  private readonly towerPartCounts = new Map<string, number>();
  private readonly stackHeights: number[][];
  private readonly weapons: InstancedModel[];
  private readonly ammo: InstancedModel[];
  private readonly sparks: InstancedModel[];
  private readonly pads: InstancedModel;
  private readonly meteorRock: InstancedModel;
  private readonly targetRing: THREE.Mesh;
  private readonly rangeDisc: THREE.Mesh;
  private readonly rangeRing: THREE.Mesh;
  private readonly selectRing: THREE.Mesh;
  private readonly staticMeshes: THREE.Mesh[];
  private readonly border: THREE.Mesh;
  private readonly ghosts: THREE.Group[];
  private readonly ghostMaterial: THREE.MeshStandardMaterial;
  private readonly enemyCounts = new Int32Array(ENEMY_TYPES);
  private readonly weaponCounts = new Int32Array(WEAPON_TYPES.length);
  private readonly ammoCounts = new Int32Array(AMMO_FOR_WEAPON.length);
  private readonly sparkCounts = new Int32Array(SPARK_COLORS.length);
  /** Seconds since each pad was last built on / upgraded (drives the rise and pop animations). */
  private readonly towerAnim: Float32Array;
  private readonly towerAnimKind: Uint8Array; // 0 none, 1 built, 2 upgraded
  private towerVersionDrawn = -1;
  private readonly viewDir = new THREE.Vector3(0, 22, 13).normalize();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();

  private ui!: HTMLElement;
  private acc = 0;
  private speed = 1;
  private paused = false;
  private finished = false;
  private armedMeteor = false;
  private cooldowns = { meteor: 0, freeze: 0 };
  private hud: {
    lives?: HTMLElement; gold?: HTMLElement; wave?: HTMLElement; waveNote?: HTMLElement; call?: HTMLButtonElement;
    meteor?: HTMLElement; freeze?: HTMLElement; aim?: HTMLElement;
  } = {};
  private panel: TowerPanel | null = null;
  private hoveredPad = -1;
  /** Placing mode: the tower picked in the build bar, and the cell the ghost sits on. */
  private placing: TowerKind | null = null;
  private ghostCell: [number, number] | null = null;
  private buildButtons: HTMLButtonElement[] = [];
  /** Build option being hovered in the panel: its range is previewed on the map. */
  previewKind: TowerKind | null = null;
  /** Exponential moving averages for the perf panel. */
  readonly perf = { simMs: 0, cpuMs: 0, staticTris: 0, staticTrisBefore: 0, staticMeshes: 0 };
  private press: { x: number; y: number; t: number } | null = null;
  private readonly onDown = (e: PointerEvent) => (this.press = { x: e.clientX, y: e.clientY, t: performance.now() });
  private readonly onUp = (e: PointerEvent) => this.handleRelease(e);
  private readonly onMove = (e: PointerEvent) => this.handleHover(e);
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(private readonly game: Game, readonly mode: StageMode) {
    const campaign = mode.kind === 'campaign' ? mode : null;
    this.mods = mode.kind === 'bench'
      ? { weapons: [...BASE_WEAPON_STATS], lives: 1, bonusGold: 0, costScale: 1, sellRefund: 0.7, crystalBonus: 0, critChance: 0, meteor: null, freeze: null }
      : game.profile.modifiers();
    this.theme = campaign?.stage.area.theme ?? 'grass';
    const { themes, models } = game;

    const map = buildMap(PATH_LAYOUTS[campaign?.stage.layout ?? 0], campaign?.stage.seed ?? 7);
    const pads = map.towerPads.length;
    for (const name of TOWER_MODELS) {
      const model = themes.model(name, this.theme);
      this.partHeights.set(name, modelHeight(model));
      this.towerParts.set(name, new InstancedModel(model, pads, { dynamic: true, receiveShadow: true }).addTo(this.scene));
    }
    // Weapon mount = top of the stacked tower parts for each kind/level.
    this.stackHeights = TOWER_STACKS.map((levels) => levels.map((stack) =>
      stack.reduce((top, name) => top + this.partHeights.get(name)!, 0)));

    this.sim = new Sim(map, MAX_ENEMIES, {
      weapons: this.mods.weapons,
      critChance: this.mods.critChance,
      hpScale: campaign ? campaign.stage.hpScale * DIFFICULTY[campaign.difficulty].hp : 1,
      speedScale: campaign?.stage.speedScale ?? 1,
      lives: this.mods.lives,
      startGold: campaign ? campaign.stage.startGold + this.mods.bonusGold : 1e9,
      costScale: this.mods.costScale,
      sellRefund: this.mods.sellRefund,
      mountY: (kind, level) => TILE_TOP + this.stackHeights[kind][level - 1],
      waves: campaign?.stage.waves ?? null,
    });
    if (mode.kind === 'bench') {
      // Stress test: a tower on every third pad along the road, all three kinds.
      let k = 0;
      map.towerPads.forEach(([x, y], pad) => {
        const touches = map.isPath[y * MAP_W + x - 1] || map.isPath[y * MAP_W + x + 1] || map.isPath[(y - 1) * MAP_W + x] || map.isPath[(y + 1) * MAP_W + x];
        if (touches && k++ % 3 === 0) this.sim.build(pad, (k % 3) as TowerKind);
      });
      this.sim.events.length = 0;
      this.sim.setEnemyCount(mode.enemies);
    }
    this.towerAnim = new Float32Array(pads).fill(BUILD_ANIM_SECONDS);
    this.towerAnimKind = new Uint8Array(pads);

    this.scene.background = new THREE.Color(THEME_SKY[this.theme]);
    this.setupLights();
    // Drag/one finger pans, right-drag/two fingers rotate, wheel/pinch zooms.
    this.controls = new MapControls(this.camera, game.app.canvas);
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 0.95;
    this.controls.minDistance = 6;
    this.controls.screenSpacePanning = false;
    this.controls.enabled = false;

    // Terrain and decor are baked into a handful of meshes; towers are dynamic instances.
    const batcher = new StaticBatcher(tileGridCuller(MAP_W, MAP_H));
    buildTerrain(map, themes, this.theme, batcher);
    this.border = buildBorder(map, themes, this.theme, campaign?.stage.seed ?? 7, batcher);
    this.scene.add(this.border);
    this.perf.staticTrisBefore = batcher.trianglesIn;
    this.perf.staticTris = batcher.trianglesOut;
    this.staticMeshes = batcher.build(this.scene);
    this.perf.staticMeshes = this.staticMeshes.length;

    this.pads = new InstancedModel(themes.model('selection-a', this.theme), pads, { dynamic: true, castShadow: false }).addTo(this.scene);

    // Placement ghosts: a see-through level-1 tower per kind.
    this.ghostMaterial = (themes.model(TOWER_STACKS[0][0][0], this.theme)[0].material as THREE.MeshStandardMaterial).clone();
    Object.assign(this.ghostMaterial, { transparent: true, opacity: 0.6, depthWrite: false });
    this.ghosts = TOWER_STACKS.map((levels, kind) => {
      const group = new THREE.Group();
      let y = 0;
      for (const name of [...levels[0], TOWER_KINDS[kind].weapon]) {
        for (const part of name.startsWith('weapon') ? models.get(name)! : themes.model(name, this.theme)) {
          const mesh = new THREE.Mesh(part.geometry, this.ghostMaterial);
          mesh.position.y = y;
          mesh.renderOrder = 3;
          group.add(mesh);
        }
        y += this.partHeights.get(name) ?? 0;
      }
      group.visible = false;
      this.scene.add(group);
      return group;
    });

    // Enemies get their own material so freezing can tint them without touching the map.
    this.enemyMaterial = (models.get(ENEMY_MODELS[0])![0].material as THREE.MeshStandardMaterial).clone();
    const withMaterial = (m: Model, material: THREE.Material): Model => m.map((p) => ({ ...p, material }));
    this.enemies = ENEMY_MODELS.map((n) =>
      new InstancedModel(withMaterial(models.get(n)!, this.enemyMaterial), MAX_ENEMIES, { dynamic: true }).addTo(this.scene));
    this.weapons = WEAPON_TYPES.map((n) => new InstancedModel(models.get(n)!, pads, { dynamic: true }).addTo(this.scene));
    this.ammo = AMMO_FOR_WEAPON.map((n) => new InstancedModel(models.get(n)!, 4096, { dynamic: true, castShadow: false }).addTo(this.scene));
    const sparkGeometry = new THREE.IcosahedronGeometry(0.06, 0);
    this.sparks = SPARK_COLORS.map((color, i) => {
      const material = i === PARTICLE_DUST
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      return new InstancedModel([{ name: 'spark', geometry: sparkGeometry, material, movable: false }], MAX_PARTICLES, { dynamic: true, castShadow: false })
        .addTo(this.scene);
    });
    this.meteorRock = new InstancedModel(models.get('weapon-ammo-boulder')!, 1, { dynamic: true }).addTo(this.scene);

    const flatRing = (inner: number, color: number, opacity: number) => new THREE.Mesh(
      new THREE.RingGeometry(inner, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    this.targetRing = flatRing(0.85, 0xffd040, 0.85);
    this.rangeRing = flatRing(0.97, 0xffffff, 0.9);
    this.selectRing = flatRing(0.78, 0xffd040, 0.95);
    this.rangeDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    for (const m of [this.targetRing, this.rangeRing, this.selectRing, this.rangeDisc]) {
      m.visible = false;
      m.renderOrder = 2;
      this.scene.add(m);
    }
    this.setEnemyShadows();
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, this.theme === 'dark' || this.theme === 'lava' ? 1.25 : 1.4));
    const sun = new THREE.DirectionalLight(this.theme === 'lava' ? 0xffc4a0 : 0xfff1d6, 2.6);
    sun.position.set(-10, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -MAP_W / 2 - 6; sc.right = MAP_W / 2 + 6; sc.top = MAP_H / 2 + 8; sc.bottom = -MAP_H / 2 - 8;
    sc.near = 1; sc.far = 70;
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
    const canvas = this.game.app.canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointermove', this.onMove);
    addEventListener('keydown', this.onKey);
    if (this.mode.kind === 'campaign') this.buildHud(this.mode.stage);
  }

  exit(): void {
    this.controls.enabled = false;
    this.controls.dispose();
    const canvas = this.game.app.canvas;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.style.cursor = '';
    removeEventListener('keydown', this.onKey);
    // Free per-battle GPU resources. Model geometries and the kit material are shared, so they stay.
    for (const m of this.staticMeshes) m.geometry.dispose();
    const instanced = [...this.enemies, ...this.weapons, ...this.ammo, ...this.sparks, this.meteorRock, this.pads, ...this.towerParts.values()];
    for (const im of instanced) for (const mesh of im.meshes) mesh.dispose();
    this.sparks[0].meshes[0].geometry.dispose();
    for (const s of this.sparks) (s.meshes[0].material as THREE.Material).dispose();
    this.enemyMaterial.dispose();
    this.ghostMaterial.dispose();
    this.border.geometry.dispose();
    (this.border.material as THREE.Material).dispose();
    for (const m of [this.targetRing, this.rangeRing, this.selectRing, this.rangeDisc]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }

  // --- HUD ---

  private buildHud(stage: StageDef): void {
    this.hud.lives = h('span');
    this.hud.gold = h('span');
    this.hud.wave = h('span');
    this.hud.waveNote = h('span', { class: 'label' });
    const speedBtn = button('1×', () => {
      this.speed = this.speed === 1 ? 2 : 1;
      speedBtn.textContent = `${this.speed}×`;
      speedBtn.classList.toggle('yellow', this.speed === 2);
    }, 'small');
    this.ui.append(
      h('div', { class: 'stage-top' },
        h('div', { class: 'panel', title: 'Lives' }, h('span', { class: 'heart' }), this.hud.lives),
        h('div', { class: 'panel', title: 'Gold' }, h('span', { class: 'coin' }), this.hud.gold),
        h('div', { class: 'panel wave-panel' }, h('span', { class: 'label' }, 'Wave'), this.hud.wave, this.hud.waveNote),
        h('div', { class: 'panel stage-name' },
          h('span', { class: 'title' }, stage.name),
          h('span', { class: 'label' }, `${stage.area.name} · ${DIFFICULTY[(this.mode as { difficulty: Difficulty }).difficulty].label}`)),
      ),
      h('div', { class: 'resources' }, speedBtn, button('Retreat', () => this.confirmRetreat(), 'small red')),
    );

    const abilities = h('div', { class: 'abilities' });
    if (this.mods.meteor) {
      this.hud.meteor = h('span', { class: 'cd' });
      abilities.append(h('div', { class: 'ability' },
        button(iconLabel('weapon-ammo-boulder', 'Meteor'), () => this.armMeteor(), 'yellow'), this.hud.meteor));
    }
    if (this.mods.freeze) {
      this.hud.freeze = h('span', { class: 'cd' });
      abilities.append(h('div', { class: 'ability' },
        button(iconLabel('snow-detail-crystal', 'Freeze'), () => this.castFreeze(), ''), this.hud.freeze));
    }
    this.hud.call = button('Start wave', () => this.callWave(), 'green big');
    this.buildButtons = TOWER_KINDS.map((t, i) => {
      const b = button(h('span', { style: 'display: contents' },
        h('img', { src: `models/kenney-td/Previews/${t.weapon}.png`, alt: '' }),
        h('span', { class: 'bb-name' }, t.name, h('kbd', {}, String(i + 1))),
        h('span', { class: 'bb-cost' }, h('span', { class: 'coin' }), String(this.sim.buildCost(i as TowerKind)))),
      () => this.setPlacing(i as TowerKind), 'build-btn');
      b.title = t.blurb;
      return b;
    });
    this.ui.append(abilities, h('div', { class: 'build-bar' }, ...this.buildButtons), h('div', { class: 'stage-dock' }, this.hud.call));
    this.ui.append(h('div', { class: 'build-hint panel white' }, 'Pick a tower below and place it on open ground, then start the wave'));
  }

  private callWave(): void {
    const bonus = this.sim.earlyCallBonus;
    if (!this.sim.callWave()) return;
    sfx('switch-a');
    if (bonus > 0) this.floatText(`+${bonus} gold`, this.hud.call!);
  }

  private floatText(text: string, near: HTMLElement): void {
    const r = near.getBoundingClientRect();
    const el = h('div', { class: 'float-text', style: `left: ${r.left + r.width / 2}px; top: ${r.top}px` }, text);
    this.ui.append(el);
    setTimeout(() => el.remove(), 1200);
  }

  private updateHud(): void {
    const { hud, sim } = this;
    setText(hud.lives!, `${Math.max(0, sim.lives)}`);
    setText(hud.gold!, formatNumber(sim.gold));
    setText(hud.wave!, sim.waitingForStart ? `0 / ${sim.totalWaves}` : `${sim.wave + 1} / ${sim.totalWaves}`);
    const pausing = !sim.waitingForStart && sim.canCallWave;
    setText(hud.waveNote!, pausing ? `in ${Math.ceil(Math.max(0, sim.pauseTimer))}s` : '');
    if (!sim.waitingForStart) this.ui.querySelector('.build-hint')?.remove();
    const call = hud.call!;
    call.style.visibility = sim.canCallWave ? '' : 'hidden';
    if (sim.canCallWave) setText(call, sim.waitingForStart ? 'Start wave' : `Call wave +${sim.earlyCallBonus}`);
    this.buildButtons.forEach((b, i) => (b.disabled = sim.gold < sim.buildCost(i as TowerKind) && this.placing !== i));
    if (this.placing !== null && sim.gold < sim.buildCost(this.placing)) this.setPlacing(null);
    if (hud.meteor) setText(hud.meteor, this.cooldowns.meteor > 0 ? `${Math.ceil(this.cooldowns.meteor)}s` : '');
    if (hud.freeze) setText(hud.freeze, this.cooldowns.freeze > 0 ? `${Math.ceil(this.cooldowns.freeze)}s` : '');
    this.panel?.refresh();
  }

  // --- Abilities ---

  private armMeteor(): void {
    if (this.cooldowns.meteor > 0 || this.finished) return;
    this.armedMeteor = !this.armedMeteor;
    this.closePanel();
    this.setPlacing(null);
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

  // --- Picking & input ---

  private rayFrom(e: PointerEvent): THREE.Ray {
    const rect = this.game.app.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Grid cell under the pointer (on the tile tops), or null off the map. */
  private pickCell(ray: THREE.Ray): [number, number] | null {
    this.ground.constant = -TILE_TOP;
    const hit = ray.intersectPlane(this.ground, this.hit);
    this.ground.constant = 0;
    if (!hit) return null;
    const cx = Math.floor(hit.x + MAP_W / 2), cy = Math.floor(hit.z + MAP_H / 2);
    return cx >= 0 && cy >= 0 && cx < MAP_W && cy < MAP_H ? [cx, cy] : null;
  }

  /** Pad under the pointer: built towers are tested as boxes (tall ones are easy to hit), then the ground cell. */
  private pickPad(ray: THREE.Ray): number {
    const { sim } = this;
    let best = -1, bestD = Infinity;
    for (let p = 0; p < sim.padCount; p++) {
      if (sim.tKind[p] < 0) continue;
      this.box.min.set(sim.tX[p] - 0.5, 0, sim.tZ[p] - 0.5);
      this.box.max.set(sim.tX[p] + 0.5, sim.tMountY[p] + 0.5, sim.tZ[p] + 0.5);
      const hit = ray.intersectBox(this.box, this.hit);
      if (hit) {
        const d = hit.distanceToSquared(ray.origin);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    if (best >= 0) return best;
    const cell = this.pickCell(ray);
    return cell ? sim.map.padAt[cell[1] * MAP_W + cell[0]] : -1;
  }

  // --- Placing mode ---

  /** Picks a tower from the build bar; picking it again (or Esc) cancels. */
  private setPlacing(kind: TowerKind | null): void {
    if (kind !== null && (this.placing === kind || this.sim.gold < this.sim.buildCost(kind))) kind = null;
    this.placing = kind;
    this.ghostCell = null;
    this.towerVersionDrawn = -1; // show/hide the open-ground markers
    if (kind !== null) {
      this.closePanel();
      this.armedMeteor = false;
      this.hud.meteor?.parentElement?.classList.remove('armed');
    }
    this.buildButtons.forEach((b, i) => b.classList.toggle('active', i === kind));
    this.hud.aim?.remove();
    this.ui.querySelector<HTMLElement>('.build-hint')?.style.setProperty('visibility', kind !== null ? 'hidden' : 'visible');
    if (kind !== null) {
      const touch = matchMedia('(pointer: coarse)').matches;
      this.hud.aim = h('div', { class: 'aim-hint panel white title' },
        touch ? `Tap open ground to place the ${TOWER_KINDS[kind].name}, tap again to confirm` : `Click open ground to place the ${TOWER_KINDS[kind].name} · Shift keeps placing · Esc cancels`);
      this.ui.append(this.hud.aim);
    }
  }

  private padAtCell(cell: [number, number] | null): number {
    return cell ? this.sim.map.padAt[cell[1] * MAP_W + cell[0]] : -1;
  }

  private canPlace(cell: [number, number] | null): boolean {
    const pad = this.padAtCell(cell);
    return this.placing !== null && pad >= 0 && this.sim.tKind[pad] < 0 && this.sim.gold >= this.sim.buildCost(this.placing);
  }

  /** Builds at `cell`; returns false (with a buzz) when the spot is blocked or gold is short. */
  private placeAt(cell: [number, number], keepPlacing: boolean): void {
    const kind = this.placing!;
    if (!this.canPlace(cell)) {
      sfx('tap-b', 0.4);
      return;
    }
    this.sim.build(this.padAtCell(cell), kind);
    this.towerChanged('built');
    if (!keepPlacing || this.sim.gold < this.sim.buildCost(kind)) this.setPlacing(null);
  }

  private handleHover(e: PointerEvent): void {
    if (this.mode.kind !== 'campaign' || e.pointerType === 'touch' || this.finished) return;
    const ray = this.rayFrom(e);
    if (this.placing !== null) {
      this.ghostCell = this.pickCell(ray);
      this.hoveredPad = -1;
    } else {
      this.hoveredPad = this.armedMeteor ? -1 : this.pickPad(ray);
    }
    this.game.app.canvas.style.cursor = this.hoveredPad >= 0 || this.armedMeteor || this.placing !== null ? 'pointer' : '';
  }

  /** A click is a press and release without dragging the camera. */
  private handleRelease(e: PointerEvent): void {
    const press = this.press;
    this.press = null;
    if (!press || this.mode.kind !== 'campaign' || this.finished) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 || performance.now() - press.t > 500) return;
    const ray = this.rayFrom(e);

    if (this.placing !== null) {
      const cell = this.pickCell(ray);
      if (!cell) return;
      // Touch has no hover: the first tap shows the ghost and range, a second tap on the same cell builds.
      const same = this.ghostCell && this.ghostCell[0] === cell[0] && this.ghostCell[1] === cell[1];
      if (e.pointerType === 'touch' && !same) {
        this.ghostCell = cell;
        return;
      }
      this.ghostCell = cell;
      this.placeAt(cell, e.shiftKey);
      return;
    }

    if (this.armedMeteor) {
      const m = this.mods.meteor!;
      const hit = ray.intersectPlane(this.ground, new THREE.Vector3());
      if (!hit || Math.abs(hit.x) > MAP_W / 2 || Math.abs(hit.z) > MAP_H / 2) return;
      this.sim.castMeteor(hit.x, hit.z, m.radius, m.damage);
      this.targetRing.position.set(hit.x, 0.25, hit.z);
      this.targetRing.scale.setScalar(m.radius);
      this.targetRing.visible = true;
      this.cooldowns.meteor = m.cooldown;
      this.armMeteor();
      sfx('tap-a');
      return;
    }

    const pad = this.pickPad(ray);
    if (pad < 0 || pad === this.panel?.pad) this.closePanel();
    else this.openPanel(pad);
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.mode.kind !== 'campaign' || this.finished) return;
    if (e.key === 'Escape') {
      if (this.armedMeteor) this.armMeteor();
      this.setPlacing(null);
      this.closePanel();
    } else if (e.key === ' ' && this.sim.canCallWave) {
      e.preventDefault();
      this.callWave();
    } else if (this.panel) {
      this.panel.handleKey(e.key);
    } else if (['1', '2', '3'].includes(e.key)) {
      this.setPlacing((Number(e.key) - 1) as TowerKind);
    }
  }

  openPanel(pad: number): void {
    this.closePanel();
    sfx('tap-a', 0.35);
    this.panel = new TowerPanel(this, pad, () => this.closePanel());
    this.ui.append(this.panel.el);
    this.panel.place();
  }

  closePanel(): void {
    this.panel?.el.remove();
    this.panel = null;
    this.previewKind = null;
  }

  /** Called by the tower panel after a successful build/upgrade/sell. */
  towerChanged(kind: 'built' | 'upgraded' | 'sold'): void {
    sfx(kind === 'sold' ? 'tap-b' : 'switch-a');
  }

  // --- Flow ---

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
    this.closePanel();
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

  /**
   * Frames the play area: the whole map on wide screens, closer on phones
   * (pan to see the rest). Mountains fill whatever lies beyond the map.
   */
  private fitCamera(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.Vector3((sx * MAP_W) / 2, 0, (sz * MAP_H) / 2)));
    const ndc = new THREE.Vector3();
    const bottom = -1 + (2 * 100) / height;
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
    // Portrait phones would show the whole map tiny; start about 60% of its width across instead.
    const dist = this.camera.aspect < 0.8 ? hi * 0.58 : hi;
    fits(dist);
    this.controls.maxDistance = hi * 1.15;
    const sky = THEME_SKY[this.theme];
    // Distant peaks fade into the sky rather than ending at a hard edge.
    this.scene.fog = new THREE.Fog(sky, hi + BORDER * 1.4, hi + BORDER * 4);
  }

  /** Screen position of a world point (for pinning DOM to the map). */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const p = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, visible: p.z < 1 };
  }

  /** Height of the tower stack on a pad (0 when empty). */
  towerTop(pad: number): number {
    const kind = this.sim.tKind[pad];
    return kind < 0 ? TILE_TOP : TILE_TOP + this.stackHeights[kind][this.sim.tLevel[pad] - 1];
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

    for (const ev of this.sim.events) {
      this.towerAnim[ev.pad] = 0;
      this.towerAnimKind[ev.pad] = ev.type === 'built' ? 1 : ev.type === 'upgraded' ? 2 : 0;
    }
    this.sim.events.length = 0;
    // Animations run on wall-clock time so they stay smooth at 2× speed.
    for (let p = 0; p < this.towerAnim.length; p++) if (this.towerAnim[p] < BUILD_ANIM_SECONDS) this.towerAnim[p] += dt;

    this.syncInstances(time);
    this.syncSelection(time);
    this.controls.update();
    this.clampTarget();
    if (steps > 0) this.perf.simMs = this.perf.simMs * 0.9 + ((s1 - s0) / steps) * 0.1;
    this.perf.cpuMs = this.perf.cpuMs * 0.9 + (performance.now() - s0) * 0.1;

    if (this.mode.kind === 'campaign') {
      this.updateHud();
      this.panel?.place();
      if (this.sim.status !== 'running') this.finish();
    }
  }

  /** Keeps the camera looking at the play area while panning. */
  private clampTarget(): void {
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -MAP_W / 2, MAP_W / 2);
    const cz = THREE.MathUtils.clamp(t.z, -MAP_H / 2, MAP_H / 2);
    if (cx !== t.x || cz !== t.z) {
      this.camera.position.x += cx - t.x;
      this.camera.position.z += cz - t.z;
      t.set(cx, t.y, cz);
    }
  }

  /** Rise-out-of-the-ground on build, a small pop on upgrade. */
  private animOffset(p: number): { y: number; scale: number } {
    const t = Math.min(1, this.towerAnim[p] / BUILD_ANIM_SECONDS);
    if (t >= 1 || this.towerAnimKind[p] === 0) return { y: 0, scale: 1 };
    const e = 1 - (1 - t) ** 3;
    if (this.towerAnimKind[p] === 1) return { y: -(1 - e) * (this.towerTop(p) - TILE_TOP), scale: 1 };
    return { y: 0, scale: 1 + Math.sin(t * Math.PI) * 0.12 };
  }

  private syncTowers(): void {
    const { sim } = this;
    this.towerPartCounts.clear();
    let emptyPads = 0;
    for (let p = 0; p < sim.padCount; p++) {
      const kind = sim.tKind[p];
      if (kind < 0) {
        // Open-ground markers only while placing; otherwise the whole map would be brackets.
        if (this.placing !== null) this.pads.set(emptyPads++, sim.tX[p], TILE_TOP, sim.tZ[p], 0, 0.72);
        continue;
      }
      const { y: dy, scale } = this.animOffset(p);
      let y = TILE_TOP + dy;
      for (const name of TOWER_STACKS[kind][sim.tLevel[p] - 1]) {
        const i = this.towerPartCounts.get(name) ?? 0;
        this.towerPartCounts.set(name, i + 1);
        this.towerParts.get(name)!.set(i, sim.tX[p], y, sim.tZ[p], 0, scale);
        y += this.partHeights.get(name)! * scale;
      }
    }
    for (const [name, inst] of this.towerParts) inst.commit(this.towerPartCounts.get(name) ?? 0);
    this.pads.commit(emptyPads);
  }

  private syncInstances(time: number): void {
    const { sim } = this;
    let animating = false;
    for (let p = 0; p < this.towerAnim.length; p++) {
      if (this.towerAnimKind[p] !== 0 && this.towerAnim[p] < BUILD_ANIM_SECONDS) animating = true;
    }
    if (animating || sim.towerVersion !== this.towerVersionDrawn) {
      this.syncTowers();
      this.towerVersionDrawn = animating ? -1 : sim.towerVersion;
    }

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
    for (let p = 0; p < sim.padCount; p++) {
      const w = sim.tKind[p];
      if (w < 0) continue;
      const { y: dy, scale } = this.animOffset(p);
      const y = TILE_TOP + (this.towerTop(p) - TILE_TOP) * scale + dy;
      this.weapons[w].set(this.weaponCounts[w]++, sim.tX[p], y, sim.tZ[p], sim.tYaw[p], scale, sim.tRecoil[p]);
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
      const size = hue === PARTICLE_DUST ? 2.2 : 1;
      this.sparks[hue].set(this.sparkCounts[hue]++, sim.qX[q], sim.qY[q], sim.qZ[q], 0, Math.min(1, life * 2.5) * size);
    }
    this.sparks.forEach((m, k) => m.commit(this.sparkCounts[k]));

    const m = sim.meteor;
    if (m.active) this.meteorRock.set(0, m.x, m.y, m.z, time * 4, 3.2);
    this.meteorRock.commit(m.active ? 1 : 0);
    if (!m.active) this.targetRing.visible = false;
  }

  /** Selection ring on the open (or hovered) pad, plus a range preview for its tower or the build option hovered. */
  private syncSelection(time: number): void {
    const { sim } = this;
    const discMat = this.rangeDisc.material as THREE.MeshBasicMaterial;
    const ringMat = this.rangeRing.material as THREE.MeshBasicMaterial;
    this.ghosts.forEach((g, k) => (g.visible = this.placing === k && this.ghostCell !== null));

    if (this.placing !== null) {
      // Placing: ghost tower + its range, green where it can go and red where it can't.
      this.selectRing.visible = false;
      const cell = this.ghostCell;
      this.rangeDisc.visible = this.rangeRing.visible = cell !== null;
      if (!cell) return;
      const ok = this.canPlace(cell);
      const [x, z] = cellToWorld(cell[0], cell[1]);
      this.ghosts[this.placing].position.set(x, TILE_TOP + Math.sin(time * 6) * 0.03, z);
      this.ghostMaterial.color.setHex(ok ? 0xffffff : 0xff6a6a);
      discMat.color.setHex(ok ? 0x8dffb0 : 0xff6a6a);
      ringMat.color.setHex(ok ? 0xffffff : 0xff6a6a);
      const range = sim.statsFor(this.placing, 1).range;
      for (const m of [this.rangeDisc, this.rangeRing]) {
        m.position.set(x, TILE_TOP + 0.04, z);
        m.scale.setScalar(range);
      }
      return;
    }
    discMat.color.setHex(0xffffff);
    ringMat.color.setHex(0xffffff);

    const pad = this.panel?.pad ?? this.hoveredPad;
    const selected = this.panel !== null;
    this.selectRing.visible = pad >= 0;
    if (pad < 0) {
      this.rangeDisc.visible = this.rangeRing.visible = false;
      return;
    }
    this.selectRing.position.set(sim.tX[pad], TILE_TOP + 0.03, sim.tZ[pad]);
    this.selectRing.scale.setScalar(0.62 + (selected ? Math.sin(time * 5) * 0.04 : 0));
    (this.selectRing.material as THREE.MeshBasicMaterial).opacity = selected ? 0.95 : 0.5;

    const kind = sim.tKind[pad];
    const range = this.previewKind !== null
      ? sim.statsFor(this.previewKind, kind >= 0 ? Math.min(3, sim.tLevel[pad] + 1) : 1).range
      : kind >= 0 ? sim.tRange[pad] : 0;
    this.rangeDisc.visible = this.rangeRing.visible = range > 0;
    if (range > 0) {
      for (const m of [this.rangeDisc, this.rangeRing]) {
        m.position.set(sim.tX[pad], TILE_TOP + 0.04, sim.tZ[pad]);
        m.scale.setScalar(range);
      }
    }
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function iconLabel(icon: string, text: string): HTMLElement {
  return h('span', { style: 'display: contents' }, h('img', { src: `models/kenney-td/Previews/${icon}.png`, alt: '' }), text);
}
