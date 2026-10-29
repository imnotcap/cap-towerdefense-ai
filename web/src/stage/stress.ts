import { MAP_W } from './map';
import type { Sim } from './sim';
import type { TowerKind } from './towers';

/** Stress-test layout: a tower on every third open tile beside the road, cycling through the kinds. Needs ample gold. */
export function buildStressTowers(sim: Sim): void {
  const { map } = sim;
  const road = (x: number, y: number) => x >= 0 && x < MAP_W && map.isPath[y * MAP_W + x] === 1;
  let roadside = 0;
  let built = 0;
  map.towerPads.forEach(([x, y], pad) => {
    if (!(road(x - 1, y) || road(x + 1, y) || road(x, y - 1) || road(x, y + 1))) return;
    if (roadside++ % 3 === 0) sim.build(pad, (built++ % 3) as TowerKind);
  });
  sim.events.length = 0;
}
