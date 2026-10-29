import { MAP_H, MAP_W, cellToWorld, samplePath, type GameMap } from './map';
import {
  LEVEL_DAMAGE, LEVEL_RANGE, LEVEL_RATE, MAX_TOWER_LEVEL, TOWER_KINDS, buildCost, upgradeCost, type Targeting, type TowerKind,
} from './towers';

/**
 * Fixed-step simulation, struct-of-arrays, zero allocations per tick.
 * Rendering only reads these arrays.
 */
export const TICK = 1 / 60;

/** Four saucer sizes plus the boss (type 4). */
export const ENEMY_TYPES = 5;
export const BOSS = 4;
export const WEAPON_TYPES = TOWER_KINDS.map((k) => k.weapon);
export const AMMO_FOR_WEAPON = TOWER_KINDS.map((k) => k.ammo);

export interface WeaponStats {
  range: number;
  /** Seconds between shots. */
  cooldown: number;
  damage: number;
  /** Projectile speed. */
  speed: number;
  splash: number;
}

export const BASE_WEAPON_STATS: readonly WeaponStats[] = [
  { range: 3.2, cooldown: 1.1, damage: 40, speed: 7, splash: 0.9 },
  { range: 4.2, cooldown: 0.8, damage: 30, speed: 14, splash: 0 },
  { range: 2.6, cooldown: 0.18, damage: 8, speed: 18, splash: 0 },
];
const ENEMY_HP = [60, 90, 140, 220, 2600];
const ENEMY_SPEED = [1.6, 1.3, 1.0, 0.8, 0.5];
/** Gold per kill by enemy type. */
export const ENEMY_BOUNTY = [4, 6, 9, 14, 150];
/** Lives lost when one gets through. */
export const ENEMY_LIFE_COST = [1, 1, 1, 1, 5];

export interface WaveConfig {
  waves: number;
  /** Enemies in the first wave; later waves grow from this. */
  firstWave: number;
  /** Seconds between spawns within a wave. */
  spawnInterval: number;
  /** Seconds of calm between waves before the next one starts on its own. */
  wavePause: number;
  /** Bosses that close out the final wave. */
  bosses: number;
}

export interface SimConfig {
  /** Per tower kind, after shop upgrades and before in-battle levels. */
  weapons: readonly WeaponStats[];
  critChance: number;
  hpScale: number;
  speedScale: number;
  lives: number;
  startGold: number;
  /** Multiplier on build and upgrade prices. */
  costScale: number;
  /** Fraction of spent gold returned when selling. */
  sellRefund: number;
  /** Height of the weapon mount for a tower kind/level (visual, used as the projectile origin). */
  mountY: (kind: TowerKind, level: number) => number;
  /** Null runs the endless stress test: a fixed population that recycles at the base. */
  waves: WaveConfig | null;
}

export type SimStatus = 'running' | 'won' | 'lost';

/** Something the renderer may want to react to (build dust, sounds). */
export type SimEvent = { type: 'built' | 'upgraded' | 'sold'; pad: number } | { type: 'leaked'; lives: number };

const MAX_PROJECTILES = 4096;
export const MAX_PARTICLES = 8192;
const HASH_CELL = 1;
const METEOR_FALL_TIME = 0.7;
const METEOR_HEIGHT = 9;
const FREEZE_SLOW = 0.35;
/** Each wave's enemies are this much tougher than the previous wave's. */
const WAVE_HP_GROWTH = 0.1;
/** Gold per second of pause skipped by calling the next wave early. */
const EARLY_CALL_GOLD = 2;

export const PARTICLE_EMBER = 0;
export const PARTICLE_GOLD = 1;
export const PARTICLE_ICE = 2;
export const PARTICLE_DUST = 3;

export class Sim {
  // Enemies. Slots [0, n) may be inactive; inactive slots sit on a free list in wave mode.
  n = 0;
  readonly eActive: Uint8Array;
  readonly eType: Uint8Array;
  readonly eDist: Float32Array;
  readonly eLane: Float32Array;
  readonly eHp: Float32Array;
  readonly eMaxHp: Float32Array;
  readonly eX: Float32Array;
  readonly eZ: Float32Array;
  readonly eYaw: Float32Array;
  /** Bumped on every respawn so projectiles can tell their target is gone. */
  readonly eGen: Uint32Array;
  private readonly free: Int32Array;
  private freeCount = 0;
  activeEnemies = 0;

  // Towers: one slot per build pad. tKind -1 = empty pad.
  readonly tX: Float32Array;
  readonly tZ: Float32Array;
  readonly tKind: Int8Array;
  readonly tLevel: Uint8Array;
  readonly tTargeting: Uint8Array;
  readonly tSpent: Float32Array;
  readonly tYaw: Float32Array;
  readonly tCool: Float32Array;
  readonly tRecoil: Float32Array;
  // Effective stats, cached on build/upgrade.
  readonly tRange: Float32Array;
  readonly tDamage: Float32Array;
  readonly tCooldown: Float32Array;
  readonly tMountY: Float32Array;
  /** Bumped whenever any tower is built, upgraded or sold. */
  towerVersion = 0;
  readonly events: SimEvent[] = [];

  // Projectiles
  pCount = 0;
  readonly pX = new Float32Array(MAX_PROJECTILES);
  readonly pY = new Float32Array(MAX_PROJECTILES);
  readonly pZ = new Float32Array(MAX_PROJECTILES);
  readonly pYaw = new Float32Array(MAX_PROJECTILES);
  readonly pTarget = new Int32Array(MAX_PROJECTILES);
  readonly pGen = new Uint32Array(MAX_PROJECTILES);
  readonly pKind = new Uint8Array(MAX_PROJECTILES);
  readonly pDamage = new Float32Array(MAX_PROJECTILES);

  // Particles (ring buffer); qHue picks the colour (PARTICLE_*).
  readonly qX = new Float32Array(MAX_PARTICLES);
  readonly qY = new Float32Array(MAX_PARTICLES);
  readonly qZ = new Float32Array(MAX_PARTICLES);
  readonly qVX = new Float32Array(MAX_PARTICLES);
  readonly qVY = new Float32Array(MAX_PARTICLES);
  readonly qVZ = new Float32Array(MAX_PARTICLES);
  readonly qLife = new Float32Array(MAX_PARTICLES);
  readonly qHue = new Uint8Array(MAX_PARTICLES);
  private qNext = 0;

  // Abilities
  meteor = { active: false, x: 0, y: 0, z: 0, t: 0, radius: 0, damage: 0 };
  freezeLeft = 0;

  // Spatial hash (counting sort, rebuilt every tick)
  private readonly cellStart = new Int32Array(MAP_W * MAP_H + 1);
  private readonly cellItems: Int32Array;
  private readonly cellOf: Int32Array;

  // Waves
  wave = 0;
  /** Wave mode starts paused so the player can build; `callWave` begins the first wave. */
  waitingForStart: boolean;
  private toSpawn = 0;
  private bossesToSpawn = 0;
  private spawnTimer = 0;
  pauseTimer = 0;

  status: SimStatus = 'running';
  lives: number;
  gold: number;
  kills = 0;
  leaked = 0;
  private rng = 12345;
  private readonly tmp = { x: 0, z: 0, yaw: 0 };

  constructor(readonly map: GameMap, readonly capacity: number, readonly config: SimConfig) {
    this.eActive = new Uint8Array(capacity);
    this.eType = new Uint8Array(capacity);
    this.eDist = new Float32Array(capacity);
    this.eLane = new Float32Array(capacity);
    this.eHp = new Float32Array(capacity);
    this.eMaxHp = new Float32Array(capacity);
    this.eX = new Float32Array(capacity);
    this.eZ = new Float32Array(capacity);
    this.eYaw = new Float32Array(capacity);
    this.eGen = new Uint32Array(capacity);
    this.free = new Int32Array(capacity);
    this.cellItems = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.lives = config.lives;
    this.gold = config.startGold;

    const pads = map.towerPads.length;
    this.tX = new Float32Array(pads);
    this.tZ = new Float32Array(pads);
    this.tKind = new Int8Array(pads).fill(-1);
    this.tLevel = new Uint8Array(pads);
    this.tTargeting = new Uint8Array(pads);
    this.tSpent = new Float32Array(pads);
    this.tYaw = new Float32Array(pads);
    this.tCool = new Float32Array(pads);
    this.tRecoil = new Float32Array(pads);
    this.tRange = new Float32Array(pads);
    this.tDamage = new Float32Array(pads);
    this.tCooldown = new Float32Array(pads);
    this.tMountY = new Float32Array(pads);
    map.towerPads.forEach(([cx, cy], i) => {
      const [x, z] = cellToWorld(cx, cy);
      this.tX[i] = x;
      this.tZ[i] = z;
      this.tYaw[i] = this.rand() * Math.PI * 2;
    });
    this.waitingForStart = config.waves !== null;
  }

  get padCount(): number {
    return this.tX.length;
  }

  get totalWaves(): number {
    return this.config.waves?.waves ?? 0;
  }

  private rand(): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }

  // --- Towers ---

  buildCost(kind: TowerKind): number {
    return buildCost(kind, this.config.costScale);
  }

  /** Gold to upgrade the tower on `pad`, or null at max level / empty pad. */
  upgradeCost(pad: number): number | null {
    const kind = this.tKind[pad];
    if (kind < 0 || this.tLevel[pad] >= MAX_TOWER_LEVEL) return null;
    return upgradeCost(kind as TowerKind, this.tLevel[pad], this.config.costScale);
  }

  sellValue(pad: number): number {
    return Math.floor(this.tSpent[pad] * this.config.sellRefund);
  }

  /** Effective stats a tower would have at `level`. */
  statsFor(kind: TowerKind, level: number): { damage: number; range: number; cooldown: number; splash: number } {
    const w = this.config.weapons[kind];
    return {
      damage: w.damage * LEVEL_DAMAGE[level - 1],
      range: w.range * LEVEL_RANGE[level - 1],
      cooldown: w.cooldown / LEVEL_RATE[level - 1],
      splash: w.splash,
    };
  }

  build(pad: number, kind: TowerKind): boolean {
    const cost = this.buildCost(kind);
    if (this.tKind[pad] >= 0 || cost > this.gold || this.status !== 'running') return false;
    this.gold -= cost;
    this.place(pad, kind);
    this.tSpent[pad] = cost;
    return true;
  }

  private place(pad: number, kind: TowerKind): void {
    this.tKind[pad] = kind;
    this.tLevel[pad] = 1;
    this.tTargeting[pad] = 0;
    this.tCool[pad] = 0.3;
    this.applyStats(pad);
    this.burst(this.tX[pad], 0.3, this.tZ[pad], 18, 1.6, PARTICLE_DUST);
    this.events.push({ type: 'built', pad });
  }

  upgrade(pad: number): boolean {
    const cost = this.upgradeCost(pad);
    if (cost === null || cost > this.gold || this.status !== 'running') return false;
    this.gold -= cost;
    this.tSpent[pad] += cost;
    this.tLevel[pad]++;
    this.applyStats(pad);
    this.burst(this.tX[pad], this.tMountY[pad], this.tZ[pad], 24, 2, PARTICLE_GOLD);
    this.events.push({ type: 'upgraded', pad });
    return true;
  }

  sell(pad: number): boolean {
    if (this.tKind[pad] < 0 || this.status !== 'running') return false;
    this.gold += this.sellValue(pad);
    this.tKind[pad] = -1;
    this.tLevel[pad] = 0;
    this.tSpent[pad] = 0;
    this.burst(this.tX[pad], 0.4, this.tZ[pad], 22, 1.8, PARTICLE_DUST);
    this.towerVersion++;
    this.events.push({ type: 'sold', pad });
    return true;
  }

  setTargeting(pad: number, mode: Targeting): void {
    this.tTargeting[pad] = mode;
  }

  private applyStats(pad: number): void {
    const kind = this.tKind[pad] as TowerKind;
    const s = this.statsFor(kind, this.tLevel[pad]);
    this.tRange[pad] = s.range;
    this.tDamage[pad] = s.damage;
    this.tCooldown[pad] = s.cooldown;
    this.tMountY[pad] = this.config.mountY(kind, this.tLevel[pad]);
    this.towerVersion++;
  }

  // --- Enemies & waves ---

  /** Endless mode only: shrinking keeps the first n enemies; growing spreads new ones along the path. */
  setEnemyCount(n: number): void {
    n = Math.min(n, this.capacity);
    for (let i = this.n; i < n; i++) this.spawn(i, this.rand() * this.map.length, (this.rand() * BOSS) | 0);
    for (let i = n; i < this.n; i++) this.eActive[i] = 0;
    this.n = n;
    this.activeEnemies = n;
  }

  private spawn(i: number, dist: number, type: number): void {
    this.eActive[i] = 1;
    this.eType[i] = type;
    this.eDist[i] = dist;
    this.eLane[i] = (this.rand() - 0.5) * 0.6;
    this.eHp[i] = this.eMaxHp[i] = ENEMY_HP[type] * this.config.hpScale * (1 + this.wave * WAVE_HP_GROWTH);
    this.eGen[i]++;
  }

  /** Takes a free slot (wave mode). */
  private allocate(): number {
    if (this.freeCount > 0) return this.free[--this.freeCount];
    return this.n < this.capacity ? this.n++ : -1;
  }

  private release(i: number): void {
    this.eActive[i] = 0;
    this.eGen[i]++;
    this.free[this.freeCount++] = i;
    this.activeEnemies--;
  }

  /** What wave `w` will bring (for the HUD preview). */
  wavePlan(w: number): { count: number; toughest: number; bosses: number } {
    const cfg = this.config.waves!;
    return {
      count: Math.round(cfg.firstWave * (1 + w * 0.35)),
      toughest: Math.min(BOSS - 1, Math.floor(w / 2)),
      bosses: w === cfg.waves - 1 ? cfg.bosses : 0,
    };
  }

  private startWave(w: number): void {
    const plan = this.wavePlan(w);
    this.wave = w;
    this.toSpawn = plan.count + plan.bosses;
    this.bossesToSpawn = plan.bosses;
    this.spawnTimer = 0;
  }

  /** True while the next wave can be called (before the first, or during a pause). */
  get canCallWave(): boolean {
    if (!this.config.waves || this.status !== 'running') return false;
    return this.waitingForStart || (this.toSpawn === 0 && this.wave < this.totalWaves - 1);
  }

  /** Gold for calling the next wave now instead of waiting out the pause. */
  get earlyCallBonus(): number {
    return this.waitingForStart ? 0 : Math.ceil(Math.max(0, this.pauseTimer) * EARLY_CALL_GOLD);
  }

  /** Starts the first wave, or the next one early for bonus gold. */
  callWave(): boolean {
    if (!this.canCallWave) return false;
    if (this.waitingForStart) {
      this.waitingForStart = false;
      this.startWave(0);
    } else {
      this.gold += this.earlyCallBonus;
      this.startWave(this.wave + 1);
    }
    return true;
  }

  step(): void {
    if (this.status !== 'running') {
      this.updateParticles();
      return;
    }
    if (this.config.waves && !this.waitingForStart) this.updateWaves();
    this.moveEnemies();
    this.rebuildHash();
    this.updateTowers();
    this.updateProjectiles();
    this.updateMeteor();
    this.updateParticles();
    if (this.freezeLeft > 0) this.freezeLeft -= TICK;
    if (this.config.waves) {
      if (this.lives <= 0) this.status = 'lost';
      else if (!this.waitingForStart && this.wave >= this.totalWaves - 1 && this.toSpawn === 0 && this.activeEnemies === 0) {
        this.status = 'won';
      }
    }
  }

  private updateWaves(): void {
    const cfg = this.config.waves!;
    if (this.toSpawn > 0) {
      this.spawnTimer -= TICK;
      if (this.spawnTimer <= 0) {
        const slot = this.allocate();
        // Bosses close out the wave, after the regular saucers.
        const boss = this.toSpawn <= this.bossesToSpawn;
        if (slot >= 0) {
          // Later waves mix in tougher enemy types.
          const toughest = this.wavePlan(this.wave).toughest;
          this.spawn(slot, 0, boss ? BOSS : Math.floor(this.rand() * (toughest + 1)));
          this.activeEnemies++;
        }
        this.toSpawn--;
        this.spawnTimer = boss ? cfg.spawnInterval * 4 : cfg.spawnInterval;
        if (this.toSpawn === 0) {
          this.pauseTimer = cfg.wavePause;
          this.gold += 15 + this.wave * 5; // end-of-wave bonus once the last enemy has spawned
        }
      }
    } else if (this.wave < cfg.waves - 1) {
      this.pauseTimer -= TICK;
      if (this.pauseTimer <= 0) this.startWave(this.wave + 1);
    }
  }

  private moveEnemies(): void {
    const { map, tmp } = this;
    const speedScale = this.config.speedScale * (this.freezeLeft > 0 ? FREEZE_SLOW : 1);
    for (let i = 0; i < this.n; i++) {
      if (!this.eActive[i]) continue;
      let d = this.eDist[i] + ENEMY_SPEED[this.eType[i]] * speedScale * TICK;
      if (d >= map.length) {
        if (!this.config.waves) {
          // Stress test keeps N constant by recycling at the spawn.
          d -= map.length;
        } else {
          const cost = ENEMY_LIFE_COST[this.eType[i]];
          this.leaked++;
          this.lives -= cost;
          this.events.push({ type: 'leaked', lives: cost });
          this.release(i);
          continue;
        }
      }
      this.eDist[i] = d;
      samplePath(map, Math.max(0, d), this.eLane[i], tmp);
      this.eX[i] = tmp.x;
      this.eZ[i] = tmp.z;
      this.eYaw[i] = tmp.yaw;
    }
  }

  private cellIndex(x: number, z: number): number {
    const cx = Math.min(MAP_W - 1, Math.max(0, Math.floor((x + MAP_W / 2) / HASH_CELL)));
    const cz = Math.min(MAP_H - 1, Math.max(0, Math.floor((z + MAP_H / 2) / HASH_CELL)));
    return cz * MAP_W + cx;
  }

  private rebuildHash(): void {
    const start = this.cellStart;
    start.fill(0);
    for (let i = 0; i < this.n; i++) {
      // Inactive enemies and those waiting to respawn (negative distance) are not targetable.
      const c = !this.eActive[i] || this.eDist[i] < 0 ? -1 : this.cellIndex(this.eX[i], this.eZ[i]);
      this.cellOf[i] = c;
      if (c >= 0) start[c + 1]++;
    }
    for (let c = 0; c < MAP_W * MAP_H; c++) start[c + 1] += start[c];
    // Fill using a running cursor; cellStart[c] is restored afterwards.
    for (let i = 0; i < this.n; i++) if (this.cellOf[i] >= 0) this.cellItems[start[this.cellOf[i]]++] = i;
    for (let c = MAP_W * MAP_H; c > 0; c--) start[c] = start[c - 1];
    start[0] = 0;
  }

  /** Visits enemies in cells overlapping the circle; callback gets index and squared distance. */
  private query(x: number, z: number, r: number, visit: (i: number, d2: number) => void): void {
    const x0 = Math.max(0, Math.floor(x - r + MAP_W / 2));
    const x1 = Math.min(MAP_W - 1, Math.floor(x + r + MAP_W / 2));
    const z0 = Math.max(0, Math.floor(z - r + MAP_H / 2));
    const z1 = Math.min(MAP_H - 1, Math.floor(z + r + MAP_H / 2));
    const r2 = r * r;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * MAP_W + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          const dx = this.eX[i] - x, dz = this.eZ[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2) visit(i, d2);
        }
      }
    }
  }

  // Target selection: the visitor keeps the best-scoring enemy (higher score wins).
  private best = -1;
  private bestScore = -Infinity;
  private targetMode = 0;
  private readonly pickTarget = (i: number, d2: number) => {
    const score =
      this.targetMode === 0 ? this.eDist[i] // first: furthest along the path
      : this.targetMode === 1 ? -this.eDist[i] // last
      : this.targetMode === 2 ? this.eHp[i] // strong
      : -d2; // close
    if (score > this.bestScore) {
      this.bestScore = score;
      this.best = i;
    }
  };

  private updateTowers(): void {
    for (let t = 0; t < this.padCount; t++) {
      const kind = this.tKind[t];
      if (kind < 0) continue;
      this.tRecoil[t] = Math.max(0, this.tRecoil[t] - TICK * 1.5);
      this.tCool[t] -= TICK;
      this.best = -1;
      this.bestScore = -Infinity;
      this.targetMode = this.tTargeting[t];
      this.query(this.tX[t], this.tZ[t], this.tRange[t], this.pickTarget);
      if (this.best < 0) continue;
      const target = this.best;
      const want = Math.atan2(this.eX[target] - this.tX[t], this.eZ[target] - this.tZ[t]);
      let diff = want - this.tYaw[t];
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const turn = 8 * TICK;
      this.tYaw[t] += Math.max(-turn, Math.min(turn, diff));
      if (this.tCool[t] <= 0 && Math.abs(diff) < 0.25 && this.pCount < MAX_PROJECTILES) {
        this.tCool[t] = this.tCooldown[t];
        this.tRecoil[t] = 0.12;
        const p = this.pCount++;
        this.pX[p] = this.tX[t] + Math.sin(this.tYaw[t]) * 0.35;
        this.pY[p] = this.tMountY[t] + 0.35;
        this.pZ[p] = this.tZ[t] + Math.cos(this.tYaw[t]) * 0.35;
        this.pYaw[p] = this.tYaw[t];
        this.pTarget[p] = target;
        this.pGen[p] = this.eGen[target];
        this.pKind[p] = kind;
        this.pDamage[p] = this.tDamage[t];
      }
    }
  }

  private splashDamage = 0;
  private readonly applySplash = (i: number) => this.damage(i, this.splashDamage);

  private damage(i: number, amount: number): void {
    if (!this.eActive[i] || this.eDist[i] < 0) return;
    this.eHp[i] -= amount;
    if (this.eHp[i] <= 0) {
      this.kills++;
      const boss = this.eType[i] === BOSS;
      this.burst(this.eX[i], 0.6, this.eZ[i], boss ? 90 : 14, boss ? 4 : 2.2, PARTICLE_EMBER);
      if (boss) this.burst(this.eX[i], 0.8, this.eZ[i], 40, 3, PARTICLE_GOLD);
      if (this.config.waves) {
        this.gold += ENEMY_BOUNTY[this.eType[i]];
        this.release(i);
      } else {
        this.spawn(i, -this.rand() * 3, (this.rand() * BOSS) | 0);
      }
    }
  }

  private updateProjectiles(): void {
    for (let p = 0; p < this.pCount; p++) {
      const w = this.config.weapons[this.pKind[p]];
      const t = this.pTarget[p];
      const alive = this.pGen[p] === this.eGen[t];
      const tx = this.eX[t], tz = this.eZ[t], ty = 0.45;
      const dx = tx - this.pX[p], dy = ty - this.pY[p], dz = tz - this.pZ[p];
      const dist = Math.hypot(dx, dy, dz);
      const stepLen = w.speed * TICK;
      if (!alive || dist <= stepLen + 0.1) {
        if (!alive) {
          this.burst(this.pX[p], this.pY[p], this.pZ[p], 3, 0.8, PARTICLE_EMBER);
        } else {
          const crit = this.rand() < this.config.critChance;
          if (crit) this.burst(tx, 0.7, tz, 6, 1.4, PARTICLE_GOLD);
          const dmg = this.pDamage[p] * (crit ? 2 : 1);
          this.damage(t, dmg);
          if (w.splash > 0) {
            this.splashDamage = dmg * 0.5;
            this.query(tx, tz, w.splash, this.applySplash);
            this.burst(tx, 0.4, tz, 10, 1.6, PARTICLE_EMBER);
          }
        }
        // Swap-remove.
        const last = --this.pCount;
        this.pX[p] = this.pX[last]; this.pY[p] = this.pY[last]; this.pZ[p] = this.pZ[last];
        this.pYaw[p] = this.pYaw[last]; this.pTarget[p] = this.pTarget[last]; this.pKind[p] = this.pKind[last];
        this.pGen[p] = this.pGen[last]; this.pDamage[p] = this.pDamage[last];
        p--;
        continue;
      }
      this.pX[p] += (dx / dist) * stepLen;
      this.pY[p] += (dy / dist) * stepLen;
      this.pZ[p] += (dz / dist) * stepLen;
      this.pYaw[p] = Math.atan2(dx, dz);
    }
  }

  // --- Abilities ---

  /** Drops a meteor on (x, z); it lands after a short fall. */
  castMeteor(x: number, z: number, radius: number, damage: number): void {
    Object.assign(this.meteor, { active: true, x, z, y: METEOR_HEIGHT, t: 0, radius, damage });
  }

  castFreeze(seconds: number): void {
    this.freezeLeft = seconds;
    for (let i = 0; i < this.n; i++) {
      if (this.eActive[i] && this.eDist[i] >= 0 && this.rand() < 0.3) this.burst(this.eX[i], 0.7, this.eZ[i], 2, 0.8, PARTICLE_ICE);
    }
  }

  private readonly applyMeteor = (i: number) => this.damage(i, this.meteor.damage);

  private updateMeteor(): void {
    const m = this.meteor;
    if (!m.active) return;
    m.t += TICK;
    m.y = METEOR_HEIGHT * Math.max(0, 1 - (m.t / METEOR_FALL_TIME) ** 2);
    if (m.t >= METEOR_FALL_TIME) {
      m.active = false;
      this.query(m.x, m.z, m.radius, this.applyMeteor);
      this.burst(m.x, 0.3, m.z, 120, 5, PARTICLE_EMBER);
      this.burst(m.x, 0.3, m.z, 40, 3, PARTICLE_GOLD);
    }
  }

  private burst(x: number, y: number, z: number, count: number, speed: number, hue: number): void {
    for (let k = 0; k < count; k++) {
      const q = this.qNext;
      this.qNext = (q + 1) % MAX_PARTICLES;
      const a = this.rand() * Math.PI * 2;
      const up = 0.5 + this.rand();
      const s = speed * (0.4 + this.rand() * 0.6);
      this.qX[q] = x; this.qY[q] = y; this.qZ[q] = z;
      this.qVX[q] = Math.cos(a) * s; this.qVY[q] = up * speed; this.qVZ[q] = Math.sin(a) * s;
      this.qLife[q] = 0.5 + this.rand() * 0.4;
      this.qHue[q] = hue;
    }
  }

  private updateParticles(): void {
    for (let q = 0; q < MAX_PARTICLES; q++) {
      if (this.qLife[q] <= 0) continue;
      this.qLife[q] -= TICK;
      this.qVY[q] -= 9 * TICK;
      this.qX[q] += this.qVX[q] * TICK;
      this.qY[q] = Math.max(0.2, this.qY[q] + this.qVY[q] * TICK);
      this.qZ[q] += this.qVZ[q] * TICK;
    }
  }
}
