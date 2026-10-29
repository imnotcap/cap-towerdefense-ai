import { BASE_WEAPON_STATS, type WeaponStats } from '../stage/sim';
import {
  BASE_LIVES, FREEZE_COOLDOWN, METEOR_COOLDOWN, SELL_REFUND, STAGES, TOWER_DAMAGE_STEP, TOWER_RANGE_STEP,
  TOWER_RATE_STEP, WAR_CHEST_STEP,
  freezeSeconds, meteorDamage, type AreaDef, type StageDef, type UpgradeDef,
} from './catalog';

/** The player's persistent progress. Stored in localStorage; the game still runs if storage is unavailable. */
export interface ProfileData {
  version: 1;
  crystals: number;
  /** Best stars per stage id (0–3). */
  stars: Record<string, number>;
  /** Purchased level per upgrade id. */
  upgrades: Record<string, number>;
}

const KEY = 'cap-td/profile/v1';
const STARTING_CRYSTALS = 250;

function fresh(): ProfileData {
  return { version: 1, crystals: STARTING_CRYSTALS, stars: {}, upgrades: {} };
}

export class Profile {
  private data: ProfileData;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.data = fresh();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ProfileData;
        if (parsed.version === 1) this.data = { ...fresh(), ...parsed };
      }
    } catch {
      // Private mode / blocked storage: play with an in-memory profile.
    }
  }

  get crystals(): number {
    return this.data.crystals;
  }

  stars(stageId: string): number {
    return this.data.stars[stageId] ?? 0;
  }

  level(upgradeId: string): number {
    return this.data.upgrades[upgradeId] ?? 0;
  }

  /** A stage is playable once the stage before it (campaign order) has at least one star. */
  isUnlocked(stage: StageDef): boolean {
    return stage.order === 0 || this.stars(STAGES[stage.order - 1].id) > 0;
  }

  isAreaUnlocked(area: AreaDef): boolean {
    return this.isUnlocked(STAGES.find((s) => s.area === area)!);
  }

  areaStars(area: AreaDef): number {
    return STAGES.filter((s) => s.area === area).reduce((sum, s) => sum + this.stars(s.id), 0);
  }

  get totalStars(): number {
    return STAGES.reduce((sum, s) => sum + this.stars(s.id), 0);
  }

  /** The furthest playable stage, for focusing the world map. */
  get frontier(): StageDef {
    return [...STAGES].reverse().find((s) => this.isUnlocked(s))!;
  }

  nextCost(u: UpgradeDef): number | null {
    const level = this.level(u.id);
    return level >= u.maxLevel ? null : u.cost(level);
  }

  buy(u: UpgradeDef): boolean {
    const cost = this.nextCost(u);
    if (cost === null || cost > this.data.crystals) return false;
    this.data.crystals -= cost;
    this.data.upgrades[u.id] = this.level(u.id) + 1;
    this.commit();
    return true;
  }

  /** Records a finished stage; returns whether it was the first clear. */
  recordClear(stage: StageDef, stars: number, crystals: number): boolean {
    const firstClear = this.stars(stage.id) === 0;
    this.data.stars[stage.id] = Math.max(this.stars(stage.id), stars);
    this.data.crystals += crystals;
    this.commit();
    return firstClear;
  }

  reset(): void {
    this.data = fresh();
    this.commit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Ignore: progress just won't survive a reload.
    }
    for (const fn of this.listeners) fn();
  }

  /** Everything purchased, turned into numbers the stage can use. */
  modifiers(): Modifiers {
    const lv = (id: string) => this.level(id);
    const weapons = (['cannon', 'ballista', 'turret'] as const).map((key, i): WeaponStats => {
      const base = BASE_WEAPON_STATS[i];
      return {
        ...base,
        damage: base.damage * (1 + lv(`${key}-damage`) * TOWER_DAMAGE_STEP),
        range: base.range * (1 + lv(`${key}-range`) * TOWER_RANGE_STEP),
        cooldown: base.cooldown / (1 + lv(`${key}-rate`) * TOWER_RATE_STEP),
      };
    });
    const cooldownScale = 1 - lv('quick-hands') * 0.08;
    return {
      weapons,
      lives: BASE_LIVES + lv('fortified-base') * 2,
      bonusGold: lv('war-chest') * WAR_CHEST_STEP,
      costScale: 1 - lv('engineering') * 0.04,
      sellRefund: SELL_REFUND + lv('salvage') * 0.08,
      crystalBonus: lv('bounty-hunter') * 0.1,
      critChance: lv('sharpshooter') * 0.04,
      meteor: lv('meteor') > 0 ? { damage: meteorDamage(lv('meteor')), radius: 1.8, cooldown: METEOR_COOLDOWN * cooldownScale } : null,
      freeze: lv('freeze') > 0 ? { seconds: freezeSeconds(lv('freeze')), cooldown: FREEZE_COOLDOWN * cooldownScale } : null,
    };
  }
}

export interface Modifiers {
  weapons: WeaponStats[];
  lives: number;
  /** Extra starting gold on top of the stage's own. */
  bonusGold: number;
  costScale: number;
  sellRefund: number;
  crystalBonus: number;
  critChance: number;
  meteor: { damage: number; radius: number; cooldown: number } | null;
  freeze: { seconds: number; cooldown: number } | null;
}

