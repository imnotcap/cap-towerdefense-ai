// Headless balance check: a simple bot plays campaign stages with a given shop loadout.
// Usage: npm run bench:balance
import { DIFFICULTY, STAGES, UPGRADES, type Difficulty } from '../src/meta/catalog';
import { Profile } from '../src/meta/profile';
import { PATH_LAYOUTS, buildMap, samplePath } from '../src/stage/map';
import { Sim, TICK } from '../src/stage/sim';
import type { TowerKind } from '../src/stage/towers';

// Node has no localStorage; the profile falls back to memory.
function loadout(fraction: number): Profile {
  const p = new Profile();
  for (const u of UPGRADES) for (let l = 0; l < Math.round(u.maxLevel * fraction); l++) p['data'].upgrades[u.id] = l + 1;
  return p;
}

/** Path cells within `r` of a pad: how much road a tower there would cover. */
function coverage(sim: Sim, pad: number, r: number): number {
  let n = 0;
  const pt = { x: 0, z: 0, yaw: 0 };
  for (let d = 0; d < sim.map.length; d += 0.5) {
    samplePath(sim.map, d, 0, pt);
    if (Math.hypot(pt.x - sim.tX[pad], pt.z - sim.tZ[pad]) <= r) n++;
  }
  return n;
}

/** Spends gold: new towers on the best-covered pads first (mixed kinds), then upgrades. */
function spend(sim: Sim, order: number[]): void {
  for (let guard = 0; guard < 50; guard++) {
    const empty = order.find((p) => sim.tKind[p] < 0);
    const built = order.filter((p) => sim.tKind[p] >= 0);
    const kind = (built.length % 3) as TowerKind;
    const cheapestUpgrade = built
      .map((p) => ({ p, c: sim.upgradeCost(p) }))
      .filter((x) => x.c !== null)
      .sort((a, b) => a.c! - b.c!)[0];
    // Prefer building until there are 8 towers, then alternate with upgrades.
    if (empty !== undefined && (built.length < 8 || !cheapestUpgrade || built.length % 2 === 0) && sim.build(empty, kind)) continue;
    if (cheapestUpgrade && sim.upgrade(cheapestUpgrade.p)) continue;
    if (empty !== undefined && sim.build(empty, kind)) continue;
    return;
  }
}

function play(stageIdx: number, difficulty: Difficulty, shop: number) {
  const stage = STAGES[stageIdx];
  const mods = loadout(shop).modifiers();
  const sim = new Sim(buildMap(PATH_LAYOUTS[stage.layout], stage.seed), 4000, {
    weapons: mods.weapons, critChance: mods.critChance, hpScale: stage.hpScale * DIFFICULTY[difficulty].hp,
    speedScale: stage.speedScale, lives: mods.lives, startGold: stage.startGold + mods.bonusGold, costScale: mods.costScale,
    sellRefund: mods.sellRefund, mountY: () => 1.3, waves: stage.waves,
  });
  const order = [...Array(sim.padCount).keys()].sort((a, b) => coverage(sim, b, 3) - coverage(sim, a, 3));
  spend(sim, order);
  sim.callWave();
  let ticks = 0;
  while (sim.status === 'running' && ticks < 60 * 60 * 20) {
    if (ticks % 30 === 0) spend(sim, order);
    sim.step();
    ticks++;
  }
  const towers = order.filter((p) => sim.tKind[p] >= 0);
  const levels = towers.map((p) => sim.tLevel[p]).join('');
  return { stage: `${stageIdx + 1} ${stage.name}`, diff: difficulty, shop: `${shop * 100}%`, result: sim.status,
    lives: `${sim.lives}/${mods.lives}`, towers: towers.length, levels, gold: Math.round(sim.gold), time: `${Math.round((ticks * TICK) / 60)}m` };
}

const rows = [];
// Shop fractions roughly match the crystals a player has earned by that point in the campaign.
for (const [idx, shop] of [[0, 0], [4, 0.2], [9, 0.2], [9, 0.4], [14, 0.4], [19, 0.6], [24, 0.6], [24, 0.8], [24, 1]] as const) {
  rows.push(play(idx, 'normal', shop));
}
rows.push(play(0, 'hard', 0), play(24, 'hard', 1));
console.table(rows);
