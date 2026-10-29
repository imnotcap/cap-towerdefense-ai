import type { ThemeId } from '../engine/themes';
import type { WaveConfig } from '../stage/sim';

/** Static game content: areas, stages and the shop. */

export interface AreaDef {
  id: string;
  name: string;
  theme: ThemeId;
  blurb: string;
  /** 1–5 */
  difficulty: number;
}

export interface StageDef {
  id: string;
  area: AreaDef;
  /** 0-based within the area. */
  index: number;
  /** 0-based across the whole campaign; a stage unlocks when the previous one is cleared. */
  order: number;
  name: string;
  layout: number;
  seed: number;
  waves: WaveConfig;
  /** Gold at the start of the battle, before the War Chest perk. */
  startGold: number;
  hpScale: number;
  speedScale: number;
}

export const AREAS: readonly AreaDef[] = [
  { id: 'greenhollow', name: 'Greenhollow', theme: 'grass', difficulty: 1, blurb: 'Rolling farmland where the first saucers landed.' },
  { id: 'sunscar', name: 'Sunscar Dunes', theme: 'desert', difficulty: 2, blurb: 'Scorched ruins under a merciless sun.' },
  { id: 'frostpeak', name: 'Frostpeak', theme: 'snow', difficulty: 3, blurb: 'Frozen passes where every shot counts.' },
  { id: 'emberforge', name: 'Emberforge', theme: 'lava', difficulty: 4, blurb: 'Basalt fields lit by rivers of magma.' },
  { id: 'umbral', name: 'Umbral Spire', theme: 'dark', difficulty: 5, blurb: 'The invaders’ shadowed stronghold.' },
];

const STAGE_NAMES: Record<string, string[]> = {
  greenhollow: ['Meadow Gate', 'Old Mill Road', 'Bramble Pass', 'Hollow Creek', 'Thornwood Keep'],
  sunscar: ['Dune Approach', 'Sunken Ruins', 'Scorpion Ridge', 'Mirage Wells', 'Sun Temple'],
  frostpeak: ['Frozen Ford', 'Icefall Steps', 'Glacier Run', 'Rime Hollow', 'Peak Bastion'],
  emberforge: ['Ashen Fields', 'Cinder Bridge', 'Magma Falls', 'Forge Gates', 'Heart of Ember'],
  umbral: ['Twilight Gate', 'Shade Market', 'Hollow Spires', 'Void Causeway', 'Umbral Throne'],
};

export const STAGES_PER_AREA = 5;

export const STAGES: readonly StageDef[] = AREAS.flatMap((area, a) =>
  STAGE_NAMES[area.id].map((name, index): StageDef => {
    const order = a * STAGES_PER_AREA + index;
    return {
      id: `${area.id}-${index + 1}`,
      area,
      index,
      order,
      name,
      layout: (order * 3 + a) % 5,
      seed: 101 + order * 17,
      waves: { waves: 5 + a + (index >> 1), firstWave: Math.round(8 + order * 0.8), spawnInterval: Math.max(0.25, 0.7 - order * 0.018), wavePause: 12 },
      startGold: 200 + order * 50,
      hpScale: 1 + order * 0.22 + order * order * 0.008,
      speedScale: 1 + a * 0.06,
    };
  }),
);

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY: Record<Difficulty, { label: string; hp: number; reward: number }> = {
  easy: { label: 'Easy', hp: 0.75, reward: 0.7 },
  normal: { label: 'Normal', hp: 1, reward: 1 },
  hard: { label: 'Hard', hp: 1.4, reward: 1.6 },
};

export const BASE_LIVES = 20;
export const WAR_CHEST_STEP = 30;
export const SELL_REFUND = 0.7;

/** Stars from lives left: all lives → 3, at least half → 2, otherwise 1. */
export function starsFor(livesLeft: number, maxLives: number): number {
  if (livesLeft <= 0) return 0;
  if (livesLeft >= maxLives) return 3;
  return livesLeft >= maxLives / 2 ? 2 : 1;
}

/** Crystals paid for clearing a stage (before the Bounty Hunter bonus). */
export function stageReward(stage: StageDef, stars: number, difficulty: Difficulty, firstClear: boolean): number {
  const base = 50 + stage.order * 10 + stars * 22;
  return Math.round(base * DIFFICULTY[difficulty].reward * (firstClear ? 1.5 : 1));
}

// --- Shop ---

export type ShopTab = 'towers' | 'commander' | 'abilities';

export interface UpgradeDef {
  id: string;
  tab: ShopTab;
  /** Cards with the same group render together under one heading. */
  group: string;
  name: string;
  icon: string;
  maxLevel: number;
  /** Effect text at a given level (1-based; level 0 means not bought). */
  effect: (level: number) => string;
  cost: (level: number) => number;
}

const PREVIEW = 'models/kenney-td/Previews/';
const growth = (base: number, factor: number) => (level: number) => Math.round((base * factor ** level) / 5) * 5;
const pct = (v: number) => `${Math.round(v * 100)}%`;

const TOWERS = [
  { key: 'cannon', name: 'Cannon', icon: 'weapon-cannon' },
  { key: 'ballista', name: 'Ballista', icon: 'weapon-ballista' },
  { key: 'turret', name: 'Turret', icon: 'weapon-turret' },
] as const;

export const TOWER_DAMAGE_STEP = 0.12;
export const TOWER_RANGE_STEP = 0.06;
export const TOWER_RATE_STEP = 0.07;

export const UPGRADES: readonly UpgradeDef[] = [
  ...TOWERS.flatMap((t): UpgradeDef[] => [
    {
      id: `${t.key}-damage`, tab: 'towers', group: t.name, name: 'Damage', icon: PREVIEW + `${t.icon}.png`, maxLevel: 5,
      effect: (l) => `+${pct(l * TOWER_DAMAGE_STEP)} damage`, cost: growth(40, 1.55),
    },
    {
      id: `${t.key}-range`, tab: 'towers', group: t.name, name: 'Range', icon: PREVIEW + `${t.icon}.png`, maxLevel: 5,
      effect: (l) => `+${pct(l * TOWER_RANGE_STEP)} range`, cost: growth(35, 1.5),
    },
    {
      id: `${t.key}-rate`, tab: 'towers', group: t.name, name: 'Fire rate', icon: PREVIEW + `${t.icon}.png`, maxLevel: 5,
      effect: (l) => `+${pct(l * TOWER_RATE_STEP)} fire rate`, cost: growth(45, 1.6),
    },
  ]),
  {
    id: 'fortified-base', tab: 'commander', group: 'Commander', name: 'Fortified Base', icon: PREVIEW + 'tower-square-bottom-a.png',
    maxLevel: 5, effect: (l) => `+${l * 2} lives`, cost: growth(50, 1.6),
  },
  {
    id: 'bounty-hunter', tab: 'commander', group: 'Commander', name: 'Bounty Hunter', icon: PREVIEW + 'detail-crystal-large.png',
    maxLevel: 5, effect: (l) => `+${l * 10}% crystals from stages`, cost: growth(60, 1.65),
  },
  {
    id: 'sharpshooter', tab: 'commander', group: 'Commander', name: 'Sharpshooter', icon: PREVIEW + 'weapon-ammo-arrow.png',
    maxLevel: 5, effect: (l) => `${l * 4}% chance of double damage`, cost: growth(55, 1.6),
  },
  {
    id: 'war-chest', tab: 'commander', group: 'Commander', name: 'War Chest', icon: PREVIEW + 'detail-crystal.png',
    maxLevel: 5, effect: (l) => `+${l * WAR_CHEST_STEP} starting gold`, cost: growth(45, 1.6),
  },
  {
    id: 'engineering', tab: 'commander', group: 'Commander', name: 'Engineering', icon: PREVIEW + 'wood-structure.png',
    maxLevel: 5, effect: (l) => `\u2212${l * 4}% build & upgrade cost`, cost: growth(70, 1.65),
  },
  {
    id: 'salvage', tab: 'commander', group: 'Commander', name: 'Salvage Crew', icon: PREVIEW + 'wood-structure-part.png',
    maxLevel: 3, effect: (l) => `Sell for ${Math.round((SELL_REFUND + l * 0.08) * 100)}% of cost`, cost: growth(40, 1.7),
  },
  {
    id: 'quick-hands', tab: 'commander', group: 'Commander', name: 'Quick Hands', icon: PREVIEW + 'tower-round-crystals.png',
    maxLevel: 5, effect: (l) => `−${l * 8}% ability cooldown`, cost: growth(50, 1.6),
  },
  {
    id: 'meteor', tab: 'abilities', group: 'Meteor Strike', name: 'Meteor Strike', icon: PREVIEW + 'weapon-ammo-boulder.png',
    maxLevel: 4, effect: (l) => (l === 1 ? 'Unlocks: tap the map to crush a crowd' : `${meteorDamage(l)} impact damage`),
    cost: (l) => (l === 0 ? 120 : growth(90, 1.7)(l)),
  },
  {
    id: 'freeze', tab: 'abilities', group: 'Deep Freeze', name: 'Deep Freeze', icon: PREVIEW + 'snow-detail-crystal-large.png',
    maxLevel: 4, effect: (l) => (l === 1 ? 'Unlocks: slows every enemy' : `${freezeSeconds(l)}s slow`),
    cost: (l) => (l === 0 ? 100 : growth(80, 1.7)(l)),
  },
];

export const SHOP_TABS: { id: ShopTab; label: string }[] = [
  { id: 'towers', label: 'Towers' },
  { id: 'commander', label: 'Commander' },
  { id: 'abilities', label: 'Abilities' },
];

export const meteorDamage = (level: number) => 150 + (level - 1) * 90;
export const freezeSeconds = (level: number) => 3 + (level - 1);
export const METEOR_COOLDOWN = 25;
export const FREEZE_COOLDOWN = 30;
