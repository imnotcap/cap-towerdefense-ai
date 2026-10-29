import { MAP_H, MAP_W, cellToWorld, samplePath, type GameMap } from './map';

/**
 * Fixed-step simulation, struct-of-arrays, zero allocations per tick.
 * Rendering only reads these arrays.
 */
export const TICK = 1 / 60;

export const ENEMY_TYPES = 4;
export const WEAPON_TYPES = ['weapon-cannon', 'weapon-ballista', 'weapon-turret'] as const;
export const AMMO_FOR_WEAPON = ['weapon-ammo-cannonball', 'weapon-ammo-arrow', 'weapon-ammo-bullet'] as const;

const WEAPON_STATS = [
  // range, cooldown(s), damage, projectile speed, splash radius
  { range: 3.2, cooldown: 1.1, damage: 40, speed: 7, splash: 0.9 },
  { range: 4.2, cooldown: 0.8, damage: 30, speed: 14, splash: 0 },
  { range: 2.6, cooldown: 0.18, damage: 8, speed: 18, splash: 0 },
];
const ENEMY_HP = [60, 90, 140, 220];
const ENEMY_SPEED = [1.6, 1.3, 1.0, 0.8];

const MAX_PROJECTILES = 4096;
export const MAX_PARTICLES = 8192;
const HASH_CELL = 1;

export class Sim {
  // Enemies
  n = 0;
  readonly eType: Uint8Array;
  readonly eDist: Float32Array;
  readonly eLane: Float32Array;
  readonly eHp: Float32Array;
  readonly eX: Float32Array;
  readonly eZ: Float32Array;
  readonly eYaw: Float32Array;
  /** Bumped on every respawn so projectiles can tell their target is gone. */
  readonly eGen: Uint32Array;

  // Towers
  readonly tX: Float32Array;
  readonly tZ: Float32Array;
  readonly tWeapon: Uint8Array;
  readonly tYaw: Float32Array;
  readonly tCool: Float32Array;
  readonly tRecoil: Float32Array;

  // Projectiles
  pCount = 0;
  readonly pX = new Float32Array(MAX_PROJECTILES);
  readonly pY = new Float32Array(MAX_PROJECTILES);
  readonly pZ = new Float32Array(MAX_PROJECTILES);
  readonly pYaw = new Float32Array(MAX_PROJECTILES);
  readonly pTarget = new Int32Array(MAX_PROJECTILES);
  readonly pGen = new Uint32Array(MAX_PROJECTILES);
  readonly pKind = new Uint8Array(MAX_PROJECTILES);

  // Particles (ring buffer)
  readonly qX = new Float32Array(MAX_PARTICLES);
  readonly qY = new Float32Array(MAX_PARTICLES);
  readonly qZ = new Float32Array(MAX_PARTICLES);
  readonly qVX = new Float32Array(MAX_PARTICLES);
  readonly qVY = new Float32Array(MAX_PARTICLES);
  readonly qVZ = new Float32Array(MAX_PARTICLES);
  readonly qLife = new Float32Array(MAX_PARTICLES);
  private qNext = 0;

  // Spatial hash (counting sort, rebuilt every tick)
  private readonly cellStart = new Int32Array(MAP_W * MAP_H + 1);
  private readonly cellItems: Int32Array;
  private readonly cellOf: Int32Array;

  kills = 0;
  private rng = 12345;
  private readonly tmp = { x: 0, z: 0, yaw: 0 };

  constructor(readonly map: GameMap, readonly capacity: number) {
    this.eType = new Uint8Array(capacity);
    this.eDist = new Float32Array(capacity);
    this.eLane = new Float32Array(capacity);
    this.eHp = new Float32Array(capacity);
    this.eX = new Float32Array(capacity);
    this.eZ = new Float32Array(capacity);
    this.eYaw = new Float32Array(capacity);
    this.eGen = new Uint32Array(capacity);
    this.cellItems = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);

    const pads = map.towerPads;
    this.tX = new Float32Array(pads.length);
    this.tZ = new Float32Array(pads.length);
    this.tWeapon = new Uint8Array(pads.length);
    this.tYaw = new Float32Array(pads.length);
    this.tCool = new Float32Array(pads.length);
    this.tRecoil = new Float32Array(pads.length);
    pads.forEach(([cx, cy], i) => {
      const [x, z] = cellToWorld(cx, cy);
      this.tX[i] = x;
      this.tZ[i] = z;
      this.tWeapon[i] = i % WEAPON_TYPES.length;
      this.tCool[i] = this.rand() * WEAPON_STATS[this.tWeapon[i]].cooldown;
    });
  }

  get towerCount(): number {
    return this.tX.length;
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

  /** Shrinking keeps the first n enemies; growing spreads new ones along the path. */
  setEnemyCount(n: number): void {
    n = Math.min(n, this.capacity);
    for (let i = this.n; i < n; i++) this.spawn(i, this.rand() * this.map.length);
    this.n = n;
  }

  private spawn(i: number, dist: number): void {
    const t = (this.rand() * ENEMY_TYPES) | 0;
    this.eType[i] = t;
    this.eDist[i] = dist;
    this.eLane[i] = (this.rand() - 0.5) * 0.6;
    this.eHp[i] = ENEMY_HP[t];
    this.eGen[i]++;
  }

  step(): void {
    this.moveEnemies();
    this.rebuildHash();
    this.updateTowers();
    this.updateProjectiles();
    this.updateParticles();
  }

  private moveEnemies(): void {
    const { map, tmp } = this;
    for (let i = 0; i < this.n; i++) {
      let d = this.eDist[i] + ENEMY_SPEED[this.eType[i]] * TICK;
      // Reaching the base just recycles the enemy at the spawn (stress test keeps N constant).
      if (d >= map.length) d -= map.length;
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
      // Enemies waiting to respawn (negative distance) are not targetable.
      const c = this.eDist[i] < 0 ? -1 : this.cellIndex(this.eX[i], this.eZ[i]);
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

  private best = -1;
  private bestDist = -1;
  private readonly pickFurthest = (i: number) => {
    if (this.eDist[i] > this.bestDist) {
      this.bestDist = this.eDist[i];
      this.best = i;
    }
  };

  private updateTowers(): void {
    for (let t = 0; t < this.towerCount; t++) {
      const w = WEAPON_STATS[this.tWeapon[t]];
      this.tRecoil[t] = Math.max(0, this.tRecoil[t] - TICK * 1.5);
      this.tCool[t] -= TICK;
      // "First" targeting: furthest-along enemy in range.
      this.best = -1;
      this.bestDist = -1;
      this.query(this.tX[t], this.tZ[t], w.range, this.pickFurthest);
      if (this.best < 0) continue;
      const target = this.best;
      const want = Math.atan2(this.eX[target] - this.tX[t], this.eZ[target] - this.tZ[t]);
      let diff = want - this.tYaw[t];
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const turn = 8 * TICK;
      this.tYaw[t] += Math.max(-turn, Math.min(turn, diff));
      if (this.tCool[t] <= 0 && Math.abs(diff) < 0.25 && this.pCount < MAX_PROJECTILES) {
        this.tCool[t] = w.cooldown;
        this.tRecoil[t] = 0.12;
        const p = this.pCount++;
        this.pX[p] = this.tX[t] + Math.sin(this.tYaw[t]) * 0.35;
        this.pY[p] = TOWER_WEAPON_Y + 0.35;
        this.pZ[p] = this.tZ[t] + Math.cos(this.tYaw[t]) * 0.35;
        this.pYaw[p] = this.tYaw[t];
        this.pTarget[p] = target;
        this.pGen[p] = this.eGen[target];
        this.pKind[p] = this.tWeapon[t];
      }
    }
  }

  private splashKind = 0;
  private readonly applySplash = (i: number) => this.damage(i, WEAPON_STATS[this.splashKind].damage * 0.5);

  private damage(i: number, amount: number): void {
    this.eHp[i] -= amount;
    if (this.eHp[i] <= 0) {
      this.kills++;
      this.burst(this.eX[i], 0.6, this.eZ[i], 14, 2.2);
      this.spawn(i, -this.rand() * 3);
    }
  }

  private updateProjectiles(): void {
    for (let p = 0; p < this.pCount; p++) {
      const w = WEAPON_STATS[this.pKind[p]];
      const t = this.pTarget[p];
      const alive = this.pGen[p] === this.eGen[t];
      const tx = this.eX[t], tz = this.eZ[t], ty = 0.45;
      const dx = tx - this.pX[p], dy = ty - this.pY[p], dz = tz - this.pZ[p];
      const dist = Math.hypot(dx, dy, dz);
      const stepLen = w.speed * TICK;
      if (!alive || dist <= stepLen + 0.1) {
        if (!alive) this.burst(this.pX[p], this.pY[p], this.pZ[p], 3, 0.8);
        else this.damage(t, w.damage);
        if (alive && w.splash > 0) {
          this.splashKind = this.pKind[p];
          this.query(tx, tz, w.splash, this.applySplash);
          this.burst(tx, 0.4, tz, 10, 1.6);
        }
        // Swap-remove.
        const last = --this.pCount;
        this.pX[p] = this.pX[last]; this.pY[p] = this.pY[last]; this.pZ[p] = this.pZ[last];
        this.pYaw[p] = this.pYaw[last]; this.pTarget[p] = this.pTarget[last]; this.pKind[p] = this.pKind[last];
        this.pGen[p] = this.pGen[last];
        p--;
        continue;
      }
      this.pX[p] += (dx / dist) * stepLen;
      this.pY[p] += (dy / dist) * stepLen;
      this.pZ[p] += (dz / dist) * stepLen;
      this.pYaw[p] = Math.atan2(dx, dz);
    }
  }

  private burst(x: number, y: number, z: number, count: number, speed: number): void {
    for (let k = 0; k < count; k++) {
      const q = this.qNext;
      this.qNext = (q + 1) % MAX_PARTICLES;
      const a = this.rand() * Math.PI * 2;
      const up = 0.5 + this.rand();
      const s = speed * (0.4 + this.rand() * 0.6);
      this.qX[q] = x; this.qY[q] = y; this.qZ[q] = z;
      this.qVX[q] = Math.cos(a) * s; this.qVY[q] = up * speed; this.qVZ[q] = Math.sin(a) * s;
      this.qLife[q] = 0.5 + this.rand() * 0.4;
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

/** Height of the weapon mount on the tower stack (tile + bottom + top). */
export const TOWER_WEAPON_Y = 0.2 + 0.6 + 0.5;
