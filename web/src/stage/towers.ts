/** In-battle tower rules: what can be built, what it costs, and how levels scale it. */

export const TOWER_KINDS = [
  { key: 'cannon', name: 'Cannon', weapon: 'weapon-cannon', ammo: 'weapon-ammo-cannonball', cost: 100, blurb: 'Slow, heavy shells that splash.' },
  { key: 'ballista', name: 'Ballista', weapon: 'weapon-ballista', ammo: 'weapon-ammo-arrow', cost: 80, blurb: 'Long range, piercing bolts.' },
  { key: 'turret', name: 'Turret', weapon: 'weapon-turret', ammo: 'weapon-ammo-bullet', cost: 65, blurb: 'Short range, rapid fire.' },
] as const;

export type TowerKind = 0 | 1 | 2;
export const MAX_TOWER_LEVEL = 3;

/** Multipliers on the (shop-upgraded) base stats for in-battle levels 1–3. */
export const LEVEL_DAMAGE = [1, 1.7, 2.8];
export const LEVEL_RANGE = [1, 1.12, 1.25];
export const LEVEL_RATE = [1, 1.15, 1.35];

/** Gold to go from `level` (1-based) to level + 1. */
export function upgradeCost(kind: TowerKind, level: number, costScale: number): number {
  return Math.round((TOWER_KINDS[kind].cost * (level === 1 ? 0.9 : 1.6) * costScale) / 5) * 5;
}

export function buildCost(kind: TowerKind, costScale: number): number {
  return Math.round((TOWER_KINDS[kind].cost * costScale) / 5) * 5;
}

export const TARGETING = [
  { key: 'first', label: 'First', hint: 'Closest to the base' },
  { key: 'last', label: 'Last', hint: 'Furthest from the base' },
  { key: 'strong', label: 'Strong', hint: 'Most health' },
  { key: 'close', label: 'Close', hint: 'Nearest to the tower' },
] as const;
export type Targeting = 0 | 1 | 2 | 3;

/** Model stack per kind and level, bottom to top; the weapon sits on top. */
export const TOWER_STACKS: readonly (readonly (readonly string[])[])[] = [
  [
    ['tower-round-bottom-a', 'tower-round-top-a'],
    ['tower-round-bottom-a', 'tower-round-middle-a', 'tower-round-top-b'],
    ['tower-round-bottom-c', 'tower-round-middle-b', 'tower-round-middle-c', 'tower-round-top-c'],
  ],
  [
    ['tower-square-bottom-a', 'tower-square-top-a'],
    ['tower-square-bottom-a', 'tower-square-middle-a', 'tower-square-top-b'],
    ['tower-square-bottom-c', 'tower-square-middle-b', 'tower-square-middle-c', 'tower-square-top-c'],
  ],
  [
    ['tower-round-bottom-b', 'tower-round-top-a'],
    ['tower-round-bottom-b', 'tower-round-middle-a', 'tower-round-top-a'],
    ['tower-round-bottom-b', 'tower-round-middle-c', 'tower-round-middle-a', 'tower-round-top-c'],
  ],
];

export const TOWER_MODELS = [...new Set(TOWER_STACKS.flat(2))];
