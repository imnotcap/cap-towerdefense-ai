import type { ThemeId, Themes } from '../engine/themes';
import type { StaticBatcher } from '../engine/static-batch';
import { type Cell, PATH_TILES, mulberry32, pathTile, rasterizePath } from '../engine/tiles';

export const MAP_W = 22;
export const MAP_H = 16;

/** Hand-authored path layouts (grid corners, spawn → base). Stages pick one. */
export const PATH_LAYOUTS: readonly (readonly Cell[])[] = [
  [[0, 3], [5, 3], [5, 11], [10, 11], [10, 4], [16, 4], [16, 12], [21, 12]],
  [[0, 8], [6, 8], [6, 2], [15, 2], [15, 13], [21, 13]],
  [[0, 2], [17, 2], [17, 7], [4, 7], [4, 12], [21, 12]],
  [[0, 13], [4, 13], [4, 3], [9, 3], [9, 13], [14, 13], [14, 3], [18, 3], [18, 9], [21, 9]],
  [[0, 5], [8, 5], [8, 11], [13, 11], [13, 5], [19, 5], [19, 10], [21, 10]],
];

export interface GameMap {
  /** Ordered path cells from spawn to base. */
  pathCells: Cell[];
  /** World-space waypoints (path corners) with cumulative distances. */
  waypoints: Float32Array; // x,z pairs
  cumulative: Float32Array;
  length: number;
  towerPads: Cell[];
  isPath: Uint8Array;
}

/** Grid cell (cx, cy) → world centre. Map is centred on the origin. */
export function cellToWorld(cx: number, cy: number): [number, number] {
  return [cx - MAP_W / 2 + 0.5, cy - MAP_H / 2 + 0.5];
}

export function buildMap(corners: readonly Cell[] = PATH_LAYOUTS[0]): GameMap {
  const pathCells = rasterizePath(corners);
  const isPath = new Uint8Array(MAP_W * MAP_H);
  for (const [x, y] of pathCells) isPath[y * MAP_W + x] = 1;

  const waypoints = new Float32Array(corners.length * 2);
  const cumulative = new Float32Array(corners.length);
  corners.forEach(([x, y], i) => {
    const [wx, wz] = cellToWorld(x, y);
    waypoints[i * 2] = wx;
    waypoints[i * 2 + 1] = wz;
    if (i > 0) {
      cumulative[i] = cumulative[i - 1] + Math.hypot(wx - waypoints[i * 2 - 2], wz - waypoints[i * 2 - 1]);
    }
  });

  // Tower pads: every third free cell that touches the path orthogonally.
  const towerPads: Cell[] = [];
  let k = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (isPath[y * MAP_W + x]) continue;
      const touches =
        isPath[y * MAP_W + x - 1] || isPath[y * MAP_W + x + 1] ||
        (y > 0 && isPath[(y - 1) * MAP_W + x]) || (y < MAP_H - 1 && isPath[(y + 1) * MAP_W + x]);
      if (touches && k++ % 3 === 0) towerPads.push([x, y]);
    }
  }

  return { pathCells, waypoints, cumulative, length: cumulative[cumulative.length - 1], towerPads, isPath };
}

export const GROUND_TILES = ['tile', 'tile-tree', 'tile-tree-double', 'tile-rock', 'tile-hill', 'tile-crystal'] as const;
export const DECOR = ['detail-tree', 'detail-tree-large', 'detail-rocks', 'detail-crystal'] as const;
export { PATH_TILES };

/** Tiles whose top is flat: they only receive shadows, so they stay out of the shadow pass. */
const FLAT_TILES = new Set<string>(['tile', ...PATH_TILES]);

/** Adds all terrain tiles and decoration to the batcher, dressed in `theme`. */
export function buildTerrain(map: GameMap, themes: Themes, theme: ThemeId, batcher: StaticBatcher, seed = 7): void {
  const rand = mulberry32(seed);
  const place = (name: string, x: number, z: number, yaw: number) =>
    batcher.add(themes.model(name, theme), x, 0, z, yaw, !FLAT_TILES.has(name));

  map.pathCells.forEach((cell, i) => {
    const { model, yaw } = pathTile(map.pathCells, i);
    place(model, ...cellToWorld(...cell), yaw);
  });

  const padSet = new Set(map.towerPads.map(([x, y]) => y * MAP_W + x));
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const idx = y * MAP_W + x;
      if (map.isPath[idx]) continue;
      const [wx, wz] = cellToWorld(x, y);
      const yaw = Math.floor(rand() * 4) * (Math.PI / 2);
      if (padSet.has(idx)) {
        place('tile', wx, wz, 0);
        continue;
      }
      const r = rand();
      const nearPath = map.isPath[idx - 1] || map.isPath[idx + 1] || map.isPath[idx - MAP_W] || map.isPath[idx + MAP_W];
      const model = nearPath || r < 0.72 ? 'tile' : GROUND_TILES[1 + Math.floor(rand() * (GROUND_TILES.length - 1))];
      place(model, wx, wz, yaw);
      if (model === 'tile' && !nearPath && rand() < 0.25) {
        const d = DECOR[Math.floor(rand() * DECOR.length)];
        place(d, wx + (rand() - 0.5) * 0.5, wz + (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
      }
    }
  }
}

/** Samples a point `d` along the path, offset sideways by `lane`. Returns heading yaw. */
export function samplePath(map: GameMap, d: number, lane: number, out: { x: number; z: number; yaw: number }): void {
  const cum = map.cumulative;
  const wp = map.waypoints;
  let seg = 0;
  while (seg < cum.length - 2 && d > cum[seg + 1]) seg++;
  const ax = wp[seg * 2], az = wp[seg * 2 + 1];
  const bx = wp[seg * 2 + 2], bz = wp[seg * 2 + 3];
  const len = cum[seg + 1] - cum[seg];
  const t = Math.min(1, Math.max(0, (d - cum[seg]) / len));
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  out.x = ax + (bx - ax) * t - dz * lane;
  out.z = az + (bz - az) * t + dx * lane;
  out.yaw = Math.atan2(dx, dz);
}
