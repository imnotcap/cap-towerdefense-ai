import * as THREE from 'three/webgpu';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { Screen } from '../engine/app';
import { type Model, modelHeight } from '../engine/assets';
import { InstancedModel } from '../engine/instancing';
import { StaticBatcher } from '../engine/static-batch';
import type { ThemeId } from '../engine/themes';
import { mulberry32, pathTile, tileGridCuller } from '../engine/tiles';
import type { Game } from '../game';
import { AREAS, DIFFICULTY, STAGES, stageReward, type AreaDef, type Difficulty, type StageDef } from '../meta/catalog';
import { button, crystal, formatNumber, h, modal, sfx, stars } from '../ui/dom';
import { openShop } from './shop';
import { WORLD_H, WORLD_W, buildWorldLayout, cellToWorld, type WorldLayout } from './layout';

const SKY = 0x9fd3f2;
const WATER_COLOR = 0x3a9bd8;

/** Scenery per theme: ground tiles that replace plain grass, and loose props scattered on top. */
const SCENERY: Record<ThemeId, { tiles: string[]; props: string[]; density: number }> = {
  grass: { tiles: ['tile-tree', 'tile-tree-double', 'tile-tree-quad', 'tile-rock', 'tile-hill'], props: ['detail-tree', 'detail-tree-large', 'detail-rocks'], density: 0.3 },
  desert: { tiles: ['tile-rock', 'tile-hill', 'tile-dirt'], props: ['detail-rocks', 'detail-rocks-large', 'detail-dirt', 'detail-dirt-large'], density: 0.22 },
  snow: { tiles: ['tile-tree', 'tile-tree-double', 'tile-rock', 'tile-hill', 'tile-crystal'], props: ['detail-tree', 'detail-tree-large', 'detail-rocks'], density: 0.3 },
  lava: { tiles: ['tile-rock', 'tile-hill', 'tile-crystal', 'tile-dirt'], props: ['detail-rocks-large', 'detail-crystal', 'detail-rocks'], density: 0.28 },
  dark: { tiles: ['tile-crystal', 'tile-tree-double', 'tile-rock'], props: ['detail-crystal-large', 'detail-crystal', 'detail-tree-large'], density: 0.3 },
  locked: { tiles: [], props: [], density: 0 },
};

export const WORLD_MODELS = [
  'tile', 'tile-tree', 'tile-tree-double', 'tile-tree-quad', 'tile-rock', 'tile-hill', 'tile-crystal', 'tile-dirt',
  'detail-tree', 'detail-tree-large', 'detail-rocks', 'detail-rocks-large', 'detail-dirt', 'detail-dirt-large',
  'detail-crystal', 'detail-crystal-large', 'tile-spawn', 'tile-end', 'tile-straight', 'tile-corner-square',
  'tower-square-bottom-b', 'tower-square-middle-b', 'tower-square-roof-b',
  'tower-round-bottom-c', 'tower-round-middle-c', 'tower-round-top-c', 'tower-round-crystals', 'selection-a',
  'enemy-ufo-c',
];

const FLAT = new Set(['tile', 'tile-spawn', 'tile-end', 'tile-straight', 'tile-corner-square', 'tile-dirt']);

interface Marker {
  stage: StageDef;
  pos: THREE.Vector3;
  el: HTMLElement;
}

interface Banner {
  area: AreaDef;
  pos: THREE.Vector3;
  el: HTMLElement;
}

/**
 * The campaign's main screen: a diorama island where each themed region holds
 * five stages along one road. Locked regions are grey and hidden under clouds.
 */
export class WorldScreen implements Screen {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.5, 300);
  private readonly layout: WorldLayout = buildWorldLayout();
  private readonly controls: MapControls;
  private terrain = new THREE.Group();
  private terrainKey = '';
  private readonly water: THREE.Mesh;
  private readonly waterBase: Float32Array;
  private readonly clouds: InstancedModel;
  private cloudPuffs: { x: number; y: number; z: number; s: number; phase: number; drift: number }[] = [];
  private readonly ufos: InstancedModel;
  private readonly frontierRing: THREE.Mesh;
  private readonly nodePos: THREE.Vector3[];
  private readonly areaCentre: THREE.Vector3[];
  private markers: Marker[] = [];
  private banners: Banner[] = [];
  private ui!: HTMLElement;
  private resources: { crystals?: HTMLElement; stars?: HTMLElement } = {};
  private unsubscribe: (() => void) | null = null;
  private difficulty: Difficulty = 'normal';
  private fly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; t: number } | null = null;
  private pendingFocus: StageDef | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly game: Game) {
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 60, 120);
    this.addLights();

    this.controls = new MapControls(this.camera, game.app.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 48;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.05;
    this.controls.zoomToCursor = true;
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => (this.fly = null));

    this.nodePos = this.layout.nodes.map(([x, y]) => new THREE.Vector3(...worldXZ(x, y, 0.2)));
    this.areaCentre = AREAS.map((_, a) => {
      const pts = this.nodePos.slice(a * 5, a * 5 + 5);
      return pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length);
    });

    // Water: a gently rolling grid around the island.
    const waterGeo = new THREE.PlaneGeometry(150, 120, 75, 60).rotateX(-Math.PI / 2);
    this.waterBase = (waterGeo.getAttribute('position').array as Float32Array).slice();
    this.water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 0.35, metalness: 0.05, flatShading: true }));
    // Below the road surface (y 0.1) even at the crest, so it never shows through the tiles.
    this.water.position.y = -0.04;
    this.water.receiveShadow = true;
    this.scene.add(this.water);

    const puff = new THREE.IcosahedronGeometry(1, 1).scale(1, 0.55, 1);
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, transparent: true, opacity: 0.94 });
    this.clouds = new InstancedModel([{ name: 'cloud', geometry: puff, material: cloudMat, movable: false }], 2048, { dynamic: true }).addTo(this.scene);

    this.ufos = new InstancedModel(game.models.get('enemy-ufo-c')!, 4, { dynamic: true }).addTo(this.scene);

    this.frontierRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.scene.add(this.frontierRing, this.terrain);
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xe4f2ff, 0x50603e, 1.35));
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.7);
    sun.position.set(-18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = -WORLD_W / 2 - 3; sc.right = WORLD_W / 2 + 3; sc.top = WORLD_H / 2 + 6; sc.bottom = -WORLD_H / 2 - 6;
    sc.near = 1; sc.far = 90;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
  }

  /** Called before `enter` to centre the camera on a stage (e.g. the one just played). */
  focusOn(stage: StageDef | null): void {
    this.pendingFocus = stage;
  }

  enter(ui: HTMLElement): void {
    this.ui = ui;
    this.controls.enabled = true;
    this.rebuildIfNeeded();
    this.buildUi();
    this.unsubscribe = this.game.profile.onChange(() => {
      // A progress reset can re-lock areas while the map is open.
      this.rebuildIfNeeded();
      this.refreshUi();
    });

    const focus = this.pendingFocus ?? this.game.profile.frontier;
    this.pendingFocus = null;
    this.jumpTo(this.nodePos[focus.order], 26);
  }

  exit(): void {
    this.controls.enabled = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // --- Scene building ---

  /** Terrain depends on which areas are unlocked; rebuild only when that changes. */
  private rebuildIfNeeded(): void {
    const unlocked = AREAS.map((a) => this.game.profile.isAreaUnlocked(a));
    const key = unlocked.join(',');
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    this.scene.remove(this.terrain);
    this.terrain.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.terrain = new THREE.Group();
    this.buildTerrain(unlocked);
    this.scene.add(this.terrain);
    this.buildClouds(unlocked);
  }

  private buildTerrain(unlocked: boolean[]): void {
    const { themes } = this.game;
    const { land, road, roadArea, roadDist, nodes } = this.layout;
    const themeOf = (area: number): ThemeId => (unlocked[area] ? AREAS[area].theme : 'locked');
    const rand = mulberry32(11);
    const batcher = new StaticBatcher(tileGridCuller(WORLD_W, WORLD_H, (x, y) =>
      x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H && land[y * WORLD_W + x] >= 0));
    const place = (name: string, theme: ThemeId, x: number, y: number, z: number, yaw: number, scale = 1) =>
      this.addScaled(batcher, themes.model(name, theme), x, y, z, yaw, scale, !FLAT.has(name));

    road.forEach((cell, i) => {
      const { model, yaw } = pathTile(road, i);
      place(model, themeOf(roadArea[i]), ...worldXZ(cell[0], cell[1], 0), yaw);
    });

    // Landmarks: a keep beside each area's last stage, and the spire at the end of the road.
    const reserved = new Set<number>();
    const landmarks: { cell: [number, number]; area: number }[] = [];
    AREAS.forEach((_, a) => {
      const [nx, ny] = nodes[a * 5 + 4];
      const spot = [[nx, ny - 1], [nx + 1, ny], [nx - 1, ny], [nx, ny + 1]].find(([x, y]) => {
        const i = y * WORLD_W + x;
        return land[i] >= 0 && roadDist[i] > 0;
      }) as [number, number] | undefined;
      if (spot) {
        landmarks.push({ cell: spot, area: a });
        reserved.add(spot[1] * WORLD_W + spot[0]);
      }
    });

    const plainByNode = new Set(nodes.map(([x, y]) => y * WORLD_W + x));
    for (let y = 0; y < WORLD_H; y++) {
      for (let x = 0; x < WORLD_W; x++) {
        const i = y * WORLD_W + x;
        const area = land[i];
        if (area < 0 || roadDist[i] === 0) continue;
        const theme = themeOf(area);
        const [wx, , wz] = worldXZ(x, y, 0);
        const yaw = Math.floor(rand() * 4) * (Math.PI / 2);
        const scenery = SCENERY[unlocked[area] ? AREAS[area].theme : 'grass'];
        const keepClear = reserved.has(i) || roadDist[i] === 1 || plainByNode.has(i);
        const r = rand();
        const tile = !keepClear && r < scenery.density * 0.9 ? scenery.tiles[Math.floor(rand() * scenery.tiles.length)] : 'tile';
        place(tile, theme, wx, 0, wz, yaw);
        if (tile === 'tile' && !keepClear && rand() < scenery.density * 0.8) {
          const prop = scenery.props[Math.floor(rand() * scenery.props.length)];
          place(prop, theme, wx + (rand() - 0.5) * 0.5, 0.2, wz + (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
        }
      }
    }

    for (const { cell, area } of landmarks) {
      const theme = themeOf(area);
      const [wx, , wz] = worldXZ(cell[0], cell[1], 0);
      const final = area === AREAS.length - 1;
      const stack = final
        ? ['tower-round-bottom-c', 'tower-round-middle-c', 'tower-round-middle-c', 'tower-round-top-c', 'tower-round-crystals']
        : ['tower-square-bottom-b', 'tower-square-middle-b', 'tower-square-roof-b'];
      const scale = final ? 1.25 : 0.9;
      let top = 0.2;
      for (const name of stack) {
        const model = themes.model(name, theme);
        place(name, theme, wx, top, wz, 0, scale);
        top += modelHeight(model) * scale;
      }
    }

    batcher.build(this.terrain);
  }

  private addScaled(b: StaticBatcher, model: Model, x: number, y: number, z: number, yaw: number, scale: number, cast: boolean): void {
    b.add(scale === 1 ? model : scaleModel(model, scale), x, y, z, yaw, cast);
  }

  /** Cloud banks over locked areas plus a few high clouds drifting over everything. */
  private buildClouds(unlocked: boolean[]): void {
    const rand = mulberry32(5);
    const { land } = this.layout;
    this.cloudPuffs = [];
    for (let y = 1; y < WORLD_H; y += 4) {
      for (let x = 1; x < WORLD_W; x += 4) {
        const area = land[y * WORLD_W + x];
        if (area < 0 || unlocked[area]) continue;
        const [wx, , wz] = worldXZ(x, y, 0);
        const n = 2 + Math.floor(rand() * 2);
        for (let k = 0; k < n; k++) {
          this.cloudPuffs.push({
            x: wx + (rand() - 0.5) * 3, y: 1.6 + rand() * 0.9, z: wz + (rand() - 0.5) * 3,
            s: 0.6 + rand() * 0.5, phase: rand() * Math.PI * 2, drift: 0.15,
          });
        }
      }
    }
    for (let c = 0; c < 7; c++) {
      const cx = (rand() - 0.5) * WORLD_W, cz = (rand() - 0.5) * WORLD_H;
      for (let k = 0; k < 5; k++) {
        this.cloudPuffs.push({
          x: cx + (rand() - 0.5) * 3, y: 7 + rand(), z: cz + (rand() - 0.5) * 1.6, s: 0.8 + rand() * 0.7,
          phase: rand() * Math.PI * 2, drift: 0.6,
        });
      }
    }
  }

  // --- UI ---

  private buildUi(): void {
    const { profile } = this.game;
    this.resources.crystals = h('span');
    this.resources.stars = h('span');
    this.ui.append(
      h('div', { class: 'world-title panel' }, h('h1', {}, 'Campaign'), h('p', {}, 'Drag to pan · scroll to zoom · right-drag to rotate')),
      h('div', { class: 'resources' },
        h('div', { class: 'panel' }, crystal(), this.resources.crystals),
        h('div', { class: 'panel' }, h('span', { class: 'star-icon' }), this.resources.stars)),
      h('div', { class: 'world-dock' },
        button('Play', () => this.openStage(profile.frontier), 'green big'),
        button(h('span', { style: 'display: contents' }, h('img', { src: 'models/kenney-td/Previews/weapon-ballista.png', alt: '' }), 'Shop'),
          () => openShop(this.ui, profile), 'yellow big')),
    );

    this.banners = AREAS.map((area, a) => {
      const el = h('div', { class: 'banner interactive', onclick: () => (sfx('tap-a'), this.flyTo(this.areaCentre[a], 20)) });
      this.ui.append(el);
      return { area, pos: this.areaCentre[a].clone().setY(2.6), el };
    });
    this.markers = STAGES.map((stage) => {
      const el = h('div', { class: 'marker' });
      this.ui.append(el);
      return { stage, pos: this.nodePos[stage.order].clone().setY(0.35), el };
    });
    this.refreshUi();
  }

  private refreshUi(): void {
    const { profile } = this.game;
    this.resources.crystals!.textContent = formatNumber(profile.crystals);
    this.resources.stars!.textContent = `${profile.totalStars} / ${STAGES.length * 3}`;
    const frontier = profile.frontier;

    for (const b of this.banners) {
      const unlocked = profile.isAreaUnlocked(b.area);
      b.el.classList.toggle('locked', !unlocked);
      b.el.replaceChildren(h('div', { class: 'panel' },
        h('div', { class: 'name' }, b.area.name),
        h('div', { class: 'meta' }, h('span', { class: 'star-icon' }), `${profile.areaStars(b.area)} / 15`, ' · ', '★'.repeat(b.area.difficulty))));
    }
    for (const m of this.markers) {
      const unlocked = profile.isUnlocked(m.stage);
      const got = profile.stars(m.stage.id);
      m.el.className = `marker${got > 0 ? ' cleared' : ''}${unlocked ? '' : ' locked'}${m.stage === frontier && got === 0 ? ' frontier' : ''}`;
      m.el.replaceChildren(
        button(String(m.stage.index + 1), () => this.openStage(m.stage), 'round interactive'),
        unlocked ? stars(got) : '',
      );
    }
    const f = this.nodePos[frontier.order];
    this.frontierRing.position.set(f.x, 0.14, f.z);
  }

  private openStage(stage: StageDef): void {
    const { profile } = this.game;
    this.flyTo(this.nodePos[stage.order], 13);
    if (!profile.isUnlocked(stage)) {
      const prev = STAGES[stage.order - 1];
      const close = modal(this.ui, h('div', { class: 'stage-card' },
        h('div', { class: 'area' }, stage.area.name),
        h('h2', {}, stage.name),
        h('p', { class: 'sub' }, `Locked. Clear “${prev.name}” to open this battle.`),
        h('div', { class: 'actions' }, button('OK', () => close(), 'grey'))));
      return;
    }

    const best = profile.stars(stage.id);
    const reward = h('dd');
    const segmented = h('div', { class: 'segmented' });
    const renderDifficulty = () => {
      segmented.replaceChildren(...(Object.keys(DIFFICULTY) as Difficulty[]).map((d) =>
        button(DIFFICULTY[d].label, () => ((this.difficulty = d), renderDifficulty()), `small${d === this.difficulty ? ' active' : ''}`)));
      const r = stageReward(stage, 3, this.difficulty, best === 0) * (1 + profile.modifiers().crystalBonus);
      reward.replaceChildren(`up to ${formatNumber(r)} `, crystal());
    };
    renderDifficulty();

    const mods = profile.modifiers();
    const close = modal(this.ui, h('div', { class: 'stage-card' },
      h('div', { class: 'area' }, `${stage.area.name} · Stage ${stage.index + 1}`),
      h('h2', {}, stage.name),
      h('p', { class: 'sub' }, stage.area.blurb),
      stars(best),
      h('dl', {},
        h('dt', {}, 'Waves'), h('dd', {}, String(stage.waves.waves)),
        h('dt', {}, 'Enemy toughness'), h('dd', {}, `×${stage.hpScale.toFixed(2)}`),
        h('dt', {}, 'Your lives'), h('dd', {}, String(mods.lives)),
        h('dt', {}, 'Starting gold'), h('dd', {}, formatNumber(stage.startGold + mods.bonusGold)),
        h('dt', {}, 'Reward'), reward),
      segmented,
      h('div', { class: 'actions' },
        button('Close', () => close(), 'grey'),
        button('Battle!', () => {
          close();
          this.game.goToStage(stage, this.difficulty);
        }, 'green big'))));
  }

  // --- Camera ---

  /** Portrait screens see less of the map sideways, so pull back further. */
  private viewScale(): number {
    return THREE.MathUtils.clamp(1.1 / this.camera.aspect, 1, 1.8);
  }

  private jumpTo(target: THREE.Vector3, dist: number): void {
    dist *= this.viewScale();
    this.fly = null;
    this.controls.target.copy(target).setY(0);
    this.camera.position.copy(this.controls.target).add(viewOffset(dist));
    this.controls.update();
  }

  private flyTo(target: THREE.Vector3, dist: number): void {
    this.fly = {
      from: this.controls.target.clone(),
      to: target.clone().setY(0),
      fromDist: this.camera.position.distanceTo(this.controls.target),
      toDist: dist * this.viewScale(),
      t: 0,
    };
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = 48 * this.viewScale();
  }

  update(dt: number, time: number): void {
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / 0.8);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      const target = this.tmp.lerpVectors(f.from, f.to, e);
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      const dist = f.fromDist + (f.toDist - f.fromDist) * e;
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, dist);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.clampTarget();
    this.animate(time);
    this.placeLabels();
  }

  /** Keeps the view over the island. */
  private clampTarget(): void {
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -WORLD_W / 2, WORLD_W / 2);
    const cz = THREE.MathUtils.clamp(t.z, -WORLD_H / 2, WORLD_H / 2);
    if (cx !== t.x || cz !== t.z) {
      this.camera.position.x += cx - t.x;
      this.camera.position.z += cz - t.z;
      t.x = cx;
      t.z = cz;
    }
  }

  private animate(time: number): void {
    // Water swell.
    const pos = this.water.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.waterBase;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i], z = base[i + 2];
      arr[i + 1] = Math.sin(x * 0.45 + time * 1.1) * 0.05 + Math.cos(z * 0.6 + time * 0.8) * 0.04;
    }
    pos.needsUpdate = true;
    this.water.geometry.computeVertexNormals();

    // Clouds bob; the high ones drift across the island and wrap around.
    this.cloudPuffs.forEach((c, i) => {
      let x = c.x;
      if (c.drift > 0.3) x = ((c.x + time * c.drift + WORLD_W * 0.75) % (WORLD_W * 1.5)) - WORLD_W * 0.75;
      this.clouds.set(i, x, c.y + Math.sin(time * 0.6 + c.phase) * 0.12, c.z, c.phase, c.s);
    });
    this.clouds.commit(this.cloudPuffs.length);

    // A UFO patrol circling the spire.
    const spire = this.nodePos[this.nodePos.length - 1];
    for (let k = 0; k < 4; k++) {
      const a = time * 0.4 + (k * Math.PI) / 2;
      const r = 3.2 + Math.sin(time * 0.7 + k) * 0.4;
      this.ufos.set(k, spire.x + Math.cos(a) * r, 3.6 + Math.sin(time * 2 + k) * 0.25, spire.z + Math.sin(a) * r, -a, 0.8);
    }
    this.ufos.commit(4);

    const pulse = 1 + Math.sin(time * 4) * 0.12;
    this.frontierRing.scale.setScalar(pulse);
  }

  /** Pins DOM markers and banners to their 3D positions. */
  private placeLabels(): void {
    const w = innerWidth, hgt = innerHeight;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const showMarkers = dist < 38 * this.viewScale();
    const place = (el: HTMLElement, pos: THREE.Vector3, visible: boolean) => {
      const p = this.tmp.copy(pos).project(this.camera);
      const on = visible && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      el.style.display = on ? '' : 'none';
      if (on) el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * hgt}px) translate(-50%, -100%)`;
    };
    for (const m of this.markers) place(m.el, m.pos, showMarkers);
    for (const b of this.banners) place(b.el, b.pos, true);
  }
}

function worldXZ(cx: number, cy: number, y: number): [number, number, number] {
  const [x, z] = cellToWorld(cx, cy);
  return [x, y, z];
}

const DEFAULT_VIEW = new THREE.Vector3(0, 1, 0.62).normalize();
function viewOffset(dist: number): THREE.Vector3 {
  return DEFAULT_VIEW.clone().multiplyScalar(dist);
}

const scaled = new Map<string, Model>();
function scaleModel(model: Model, s: number): Model {
  const key = `${model[0].geometry.uuid}:${model[0].material.uuid}:${s}`;
  let m = scaled.get(key);
  if (!m) {
    m = model.map((p) => ({ ...p, geometry: p.geometry.clone().scale(s, s, s) }));
    scaled.set(key, m);
  }
  return m;
}
